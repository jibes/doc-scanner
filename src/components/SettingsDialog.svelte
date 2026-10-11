<script lang="ts">
  import { listCameras, type CameraDevice } from '../lib/camera/camera';
  import { FILTERS } from '../lib/filters';
  import { isConfigured, testConnection, type ConnectionReport } from '../lib/paperless';
  import { ListsState } from '../lib/paperlessLists.svelte';
  import { defaultSelection, readCachedLists, type UploadSelection } from '../lib/paperlessMeta';
  import {
    normalizeServerUrl,
    type AppSettings,
    type PaperlessSettings,
    type Resolution,
  } from '../lib/settings';
  import { toast } from '../lib/ui.svelte';
  import MetaFields from './MetaFields.svelte';

  interface Props {
    settings: AppSettings;
    onSave: (next: AppSettings) => void;
  }

  let { settings, onSave }: Props = $props();

  const DEFAULT_PAPERLESS: PaperlessSettings = { baseUrl: '', token: '', tagIds: [] };

  let dialog = $state<HTMLDialogElement | null>(null);
  let draft = $state<AppSettings | null>(null);
  let defaults = $state<UploadSelection>(defaultSelection(DEFAULT_PAPERLESS));
  const lists = new ListsState();
  let report = $state<ConnectionReport | null>(null);
  let testing = $state(false);
  /** Bumped on every open, so the pickers start with an empty search. */
  let opened = $state(0);
  let cameras = $state<CameraDevice[]>([]);
  let urlError = $state<string | null>(null);

  export async function open() {
    draft = structuredClone($state.snapshot(settings));
    defaults = defaultSelection(draft.paperless, readCachedLists(draft.paperless));
    urlError = null;
    report = null;
    opened++;
    void reloadLists(false);
    dialog?.showModal();
    // Labels exist only after camera permission was granted once.
    const devices = (await listCameras()).filter((d) => d.label.trim());
    if (draft.cameraDeviceId && !devices.some((d) => d.deviceId === draft!.cameraDeviceId)) {
      devices.unshift({ deviceId: draft.cameraDeviceId, label: 'Saved camera' });
    }
    cameras = devices;
  }

  /** The draft's server and token, or null when the address is not valid. */
  function draftConfig(): PaperlessSettings | null {
    if (!draft) return null;
    const checked = normalizeServerUrl(draft.paperless.baseUrl);
    if (!checked.ok) return null;
    return { ...draft.paperless, baseUrl: checked.url, token: draft.paperless.token.trim() };
  }

  async function reloadLists(force: boolean) {
    const config = draftConfig();
    if (!config) return;
    await lists.load(config, force);
    // Tag ids from older settings get their names once the lists know them.
    if (lists.lists && defaults.tagIds.length > 0) {
      defaults = defaultSelection(
        { ...config, tags: defaults.tags, tagIds: defaults.tagIds },
        lists.lists,
      );
    }
  }

  async function test() {
    if (!draft || testing) return;
    testing = true;
    report = null;
    try {
      report = await testConnection(draft.paperless);
    } finally {
      testing = false;
    }
    if (report.ok) void reloadLists(true);
  }

  function connectionEdited() {
    urlError = null;
    report = null;
  }

  const MARK: Record<ConnectionReport['checks'][number]['status'], string> = {
    ok: '✓',
    warn: '!',
    fail: '✕',
    skip: '–',
  };

  function save() {
    if (!draft) return;
    const checked = normalizeServerUrl(draft.paperless.baseUrl);
    if (!checked.ok) {
      urlError = checked.error;
      return;
    }
    urlError = null;
    const next: AppSettings = {
      ...draft,
      paperless: {
        baseUrl: checked.url,
        token: draft.paperless.token.trim(),
        tagIds: defaults.tagIds,
        tags: defaults.tags,
        documentType: defaults.documentType,
        correspondent: defaults.correspondent,
      },
    };
    onSave(next);
    dialog?.close();
    toast(
      isConfigured(next.paperless) ? 'Settings saved.' : 'Saved. Add a URL and token to upload.',
      'good',
    );
  }

  const RESOLUTIONS: { id: Resolution; label: string }[] = [
    { id: 'standard', label: 'Standard (~200 dpi)' },
    { id: 'high', label: 'High (~300 dpi)' },
    { id: 'max', label: 'Maximum (~375 dpi)' },
  ];
</script>

<dialog bind:this={dialog} class="dialog settings" aria-label="Settings">
  {#if draft}
    <form method="dialog" onsubmit={(e) => (e.preventDefault(), save())}>
      <header class="head">
        <h1>Settings</h1>
      </header>
      <div class="body">
        <h2>Paperless-ngx</h2>
        <p class="help">
          Paste a REST API token from <em>Profile → API Auth Token</em>. Both values stay in this
          browser and are sent only to this server. The server must use https and allow this app's
          origin in <code>PAPERLESS_CORS_ALLOWED_HOSTS</code>.
        </p>
        <label class="field">
          <span>Server URL</span>
          <input
            type="url"
            bind:value={draft.paperless.baseUrl}
            placeholder="https://paperless.example.com"
            autocapitalize="off"
            spellcheck="false"
            aria-invalid={urlError ? 'true' : undefined}
            aria-describedby={urlError ? 'server-url-error' : undefined}
            oninput={connectionEdited}
          />
        </label>
        {#if urlError}
          <p class="help error" id="server-url-error" role="alert">{urlError}</p>
        {/if}
        <label class="field">
          <span>API token</span>
          <input
            type="password"
            bind:value={draft.paperless.token}
            autocomplete="off"
            oninput={connectionEdited}
          />
        </label>
        <div class="row">
          <button type="button" class="test" onclick={() => void test()} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {#if report}
            <span class="verdict" class:bad={!report.ok}>
              {report.ok ? 'Ready to upload' : 'Not ready'}
            </span>
          {/if}
        </div>
        <div aria-live="polite">
          {#if report}
            <ul class="checks" aria-label="Connection test results">
              {#each report.checks as check (check.id)}
                <li class={check.status}>
                  <span class="mark" aria-hidden="true">{MARK[check.status]}</span>
                  <span class="check-text">
                    <span class="what">{check.label}</span>
                    <span class="sr-only"
                      >: {check.status === 'ok'
                        ? 'passed'
                        : check.status === 'warn'
                          ? 'warning'
                          : check.status === 'fail'
                            ? 'failed'
                            : 'not checked'}.</span
                    >
                    <span class="detail">{check.detail}</span>
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div class="row spread">
          <h3>Defaults for new documents</h3>
          <button
            type="button"
            class="text small"
            onclick={() => void reloadLists(true)}
            disabled={lists.loading || !draftConfig() || !isConfigured(draftConfig()!)}
          >
            {lists.loading ? 'Loading…' : 'Reload'}
          </button>
        </div>
        <p class="help">
          Picked for every upload; you can change them before each one. Tags, types and
          correspondents come from Paperless and are kept for offline use.
        </p>
        {#if lists.note}<p class="help warn" role="status">{lists.note}</p>{/if}
        {#key opened}
          <MetaFields lists={lists.lists} bind:selection={defaults} />
        {/key}

        <h2>Scanning</h2>
        <label class="field">
          <span>Default filter</span>
          <select bind:value={draft.defaultFilter}>
            {#each FILTERS as f (f.id)}<option value={f.id}>{f.label} — {f.hint}</option>{/each}
          </select>
        </label>
        <label class="toggle">
          <span>Auto-capture when the page is steady</span>
          <input type="checkbox" bind:checked={draft.autoCapture} />
        </label>
        <label class="field">
          <span>Camera</span>
          <select bind:value={draft.cameraDeviceId}>
            <option value={null}>Automatic (standard rear lens)</option>
            {#each cameras as c (c.deviceId)}<option value={c.deviceId}>{c.label}</option>{/each}
          </select>
        </label>

        <h2>PDF</h2>
        <label class="field">
          <span>Resolution</span>
          <select bind:value={draft.resolution}>
            {#each RESOLUTIONS as r (r.id)}<option value={r.id}>{r.label}</option>{/each}
          </select>
        </label>
        <label class="slider">
          <span>Colour quality</span>
          <input type="range" min="0.6" max="0.98" step="0.02" bind:value={draft.jpegQuality} />
          <output>{Math.round(draft.jpegQuality * 100)}</output>
        </label>
        <p class="help">
          Black-and-white and grey pages are stored losslessly; colour pages use JPEG at this
          quality.
        </p>
        <label class="toggle">
          <span>Make saved PDFs searchable</span>
          <input type="checkbox" bind:checked={draft.ocr} />
        </label>
        <p class="help">
          Reads the text on this device (about 13 MB of models, downloaded once) and adds an
          invisible text layer so you can search and copy. Uploads to Paperless skip this, as
          Paperless reads the text itself.
        </p>
      </div>
      <div class="actions">
        <button type="button" class="ghost" onclick={() => dialog?.close()}>Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  dialog {
    width: min(520px, calc(100vw - 24px));
  }

  form {
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 48px);
  }

  .head {
    padding: var(--s-6) var(--s-6) var(--s-2);
  }

  h1 {
    margin: 0;
    font-size: var(--fs-heading);
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    padding: var(--s-2) var(--s-6) var(--s-6);
    overflow-y: auto;
  }

  /* Sections: a quiet heading with a hairline above, no boxes. */
  h2 {
    margin: var(--s-4) 0 0;
    padding-top: var(--s-5);
    border-top: 1px solid var(--line);
    font-size: var(--fs-large);
    font-weight: 650;
  }

  h2:first-child {
    margin-top: 0;
    padding-top: var(--s-2);
    border-top: none;
  }

  .help.error {
    color: var(--err);
  }

  .help.warn {
    color: var(--warn);
  }

  h3 {
    margin: 0;
    font-size: var(--fs-body);
    font-weight: 600;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
  }

  .row.spread {
    justify-content: space-between;
    margin-top: var(--s-1);
  }

  .small {
    min-height: 36px;
    font-size: var(--fs-caption);
    margin-right: calc(-1 * var(--s-3));
  }

  .verdict {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-caption);
    font-weight: 600;
    color: var(--good);
  }

  .verdict::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
  }

  .verdict.bad {
    color: var(--err);
  }

  .checks {
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    margin: 0;
    padding: var(--s-4);
    list-style: none;
    background: var(--bg);
    border-radius: var(--r-l);
    -webkit-user-select: text;
    user-select: text;
  }

  .checks li {
    display: flex;
    gap: var(--s-3);
    font-size: var(--fs-caption);
  }

  .mark {
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    border-radius: 50%;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
    color: var(--text-2);
    box-shadow: inset 0 0 0 1.5px currentColor;
  }

  .ok .mark {
    color: var(--good);
  }

  .warn .mark {
    color: var(--warn);
  }

  .fail .mark {
    color: var(--err);
  }

  .skip {
    opacity: 0.6;
  }

  .check-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .what {
    font-weight: 600;
  }

  .detail {
    color: var(--text-2);
    line-height: 1.45;
  }

  code {
    font-size: 12px;
    padding: 1px 4px;
    border-radius: 4px;
    background: var(--fill);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-6) var(--s-4);
    border-top: 1px solid var(--line);
  }

  .actions .primary {
    min-width: 96px;
  }
</style>
