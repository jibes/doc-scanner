<script lang="ts">
  import { listCameras, type CameraDevice } from '../lib/camera/camera';
  import { FILTERS } from '../lib/filters';
  import { isConfigured } from '../lib/paperless';
  import type { AppSettings, Resolution } from '../lib/settings';
  import { toast } from '../lib/ui.svelte';

  interface Props {
    settings: AppSettings;
    onSave: (next: AppSettings) => void;
  }

  let { settings, onSave }: Props = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let draft = $state<AppSettings | null>(null);
  let tags = $state('');
  let cameras = $state<CameraDevice[]>([]);

  export async function open() {
    draft = structuredClone($state.snapshot(settings));
    tags = draft.paperless.tagIds.join(', ');
    dialog?.showModal();
    // Labels exist only after camera permission was granted once.
    const devices = (await listCameras()).filter((d) => d.label.trim());
    if (draft.cameraDeviceId && !devices.some((d) => d.deviceId === draft!.cameraDeviceId)) {
      devices.unshift({ deviceId: draft.cameraDeviceId, label: 'Saved camera' });
    }
    cameras = devices;
  }

  function save() {
    if (!draft) return;
    const next: AppSettings = {
      ...draft,
      paperless: {
        baseUrl: draft.paperless.baseUrl.trim(),
        token: draft.paperless.token.trim(),
        tagIds: tags
          .split(',')
          .map((t) => Number.parseInt(t.trim(), 10))
          .filter((n) => Number.isInteger(n) && n > 0),
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
          browser and are sent only to this server. The server must allow this app's origin in
          <code>PAPERLESS_CORS_ALLOWED_HOSTS</code>.
        </p>
        <label class="field">
          <span>Server URL</span>
          <input
            type="url"
            bind:value={draft.paperless.baseUrl}
            placeholder="https://paperless.example.com"
            autocapitalize="off"
            spellcheck="false"
          />
        </label>
        <label class="field">
          <span>API token</span>
          <input type="password" bind:value={draft.paperless.token} autocomplete="off" />
        </label>
        <label class="field">
          <span>Tag IDs for new documents (optional, comma separated)</span>
          <input type="text" bind:value={tags} placeholder="1, 4" inputmode="numeric" />
        </label>

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
