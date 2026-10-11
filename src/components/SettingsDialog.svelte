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

<dialog bind:this={dialog} aria-label="Settings">
  {#if draft}
    <form method="dialog" onsubmit={(e) => (e.preventDefault(), save())}>
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
          <button type="button" onclick={() => void test()} disabled={testing}>
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
                  <span class="text">
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
            class="ghost small"
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
        <button type="button" onclick={() => dialog?.close()}>Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  dialog {
    width: min(520px, calc(100vw - 24px));
    max-height: calc(100dvh - 48px);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--panel);
    color: var(--text);
  }

  dialog::backdrop {
    background: rgb(0 0 0 / 65%);
    backdrop-filter: blur(4px);
  }

  form {
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 48px);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 20px;
    overflow-y: auto;
  }

  h2 {
    margin: 8px 0 0;
    font-size: 15px;
  }

  h2:first-child {
    margin-top: 0;
  }

  .help {
    margin: 0;
    font-size: 12.5px;
    color: var(--muted);
    line-height: 1.5;
  }

  .help.error {
    color: var(--err);
  }

  .help.warn {
    color: var(--warn);
  }

  h3 {
    margin: 0;
    font-size: 13.5px;
    font-weight: 600;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .row.spread {
    justify-content: space-between;
    margin-top: 4px;
  }

  .small {
    padding: 6px 10px;
    font-size: 13px;
  }

  .verdict {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--good);
  }

  .verdict.bad {
    color: var(--err);
  }

  .checks {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 12px;
    list-style: none;
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    -webkit-user-select: text;
    user-select: text;
  }

  .checks li {
    display: flex;
    gap: 10px;
    font-size: 13px;
  }

  .mark {
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    font-size: 12px;
    font-weight: 700;
    color: #fff;
    background: var(--muted);
  }

  .ok .mark {
    background: var(--good);
  }

  .warn .mark {
    background: var(--warn);
  }

  .fail .mark {
    background: var(--err);
  }

  .skip {
    opacity: 0.65;
  }

  .text {
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
    color: var(--muted);
    line-height: 1.45;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  code {
    font-size: 12px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 20px;
    border-top: 1px solid var(--border);
  }
</style>
