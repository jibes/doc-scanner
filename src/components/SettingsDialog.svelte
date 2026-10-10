<script lang="ts">
  import { listCameras, type CameraDeviceInfo } from '../lib/camera';
  import { loadCameraPreference, saveCameraPreference } from '../lib/cameraPrefs';
  import { isConfigured, savePaperlessConfig, type PaperlessConfig } from '../lib/paperless';
  import { showToast } from '../lib/ui.svelte';

  interface Props {
    config: PaperlessConfig;
    onSave: (config: PaperlessConfig) => void;
    /** Fired when the camera preference changes, so the preview can reopen. */
    onCameraChange?: () => void;
  }

  let { config, onSave, onCameraChange }: Props = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let baseUrl = $state('');
  let token = $state('');
  let tags = $state('');
  let cameras = $state<CameraDeviceInfo[]>([]);
  let cameraId = $state('');

  export async function open() {
    baseUrl = config.baseUrl;
    token = config.token;
    tags = config.tagIds.join(', ');
    cameraId = loadCameraPreference() ?? '';
    dialog?.showModal();

    // Labels are only populated once camera permission has been granted, so an
    // empty list here just means the user has not opened the camera yet.
    const devices = (await listCameras()).filter((device) => device.label.trim() !== '');
    if (cameraId && !devices.some((device) => device.deviceId === cameraId)) {
      devices.unshift({ deviceId: cameraId, label: 'Saved camera' });
    }
    cameras = devices;
  }

  function close() {
    dialog?.close();
  }

  function save() {
    const tagIds = tags
      .split(',')
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((value) => Number.isInteger(value) && value > 0);

    const next: PaperlessConfig = { baseUrl: baseUrl.trim(), token: token.trim(), tagIds };
    savePaperlessConfig(next);
    onSave(next);

    const previous = loadCameraPreference() ?? '';
    if (cameraId !== previous) {
      saveCameraPreference(cameraId || null);
      onCameraChange?.();
    }

    close();
    showToast(
      isConfigured(next) ? 'Paperless settings saved.' : 'Saved. Add a URL and token to upload.',
      isConfigured(next) ? 'good' : '',
    );
  }
</script>

<dialog bind:this={dialog} aria-label="Paperless settings">
  <div class="dialog-body">
    <h2>Paperless-ngx</h2>
    <p class="help">
      Point this at your own Paperless server and paste a REST API token from
      <em>Settings &rarr; API Tokens</em>. Both values stay in this browser's local storage and are
      only ever sent to the server you name here.
    </p>
    <p class="help">
      The server has to allow this origin: add it to <code>PAPERLESS_CORS_ALLOWED_HOSTS</code> and restart
      Paperless.
    </p>

    <label class="field">
      <span>Base URL</span>
      <input
        type="url"
        bind:value={baseUrl}
        placeholder="https://paperless.example.com"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
    </label>

    <label class="field">
      <span>API token</span>
      <input
        type="password"
        bind:value={token}
        placeholder="40-character token"
        autocomplete="off"
      />
    </label>

    <label class="field">
      <span>Default tag IDs (comma separated, optional)</span>
      <input type="text" bind:value={tags} placeholder="1, 4" autocomplete="off" />
    </label>

    <h2 class="section">Camera</h2>
    <p class="help">
      Phones expose every physical lens as a separate camera, and the browser is free to pick any of
      them. The scanner scores the labels and prefers the standard 1x lens, then pins zoom to 1x and
      continuous autofocus. Override it here if the automatic choice is wrong.
    </p>

    <label class="field">
      <span>Lens</span>
      <select bind:value={cameraId}>
        <option value="">Automatic (standard rear lens)</option>
        {#each cameras as device (device.deviceId)}
          <option value={device.deviceId}>{device.label}</option>
        {/each}
      </select>
    </label>
  </div>

  <div class="dialog-actions">
    <button onclick={close}>Cancel</button>
    <button class="btn-primary" onclick={save}>Save</button>
  </div>
</dialog>
