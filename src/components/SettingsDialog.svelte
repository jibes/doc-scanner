<script lang="ts">
  import { isConfigured, savePaperlessConfig, type PaperlessConfig } from '../lib/paperless';
  import { showToast } from '../lib/ui.svelte';

  interface Props {
    config: PaperlessConfig;
    onSave: (config: PaperlessConfig) => void;
  }

  let { config, onSave }: Props = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let baseUrl = $state('');
  let token = $state('');
  let tags = $state('');

  export function open() {
    baseUrl = config.baseUrl;
    token = config.token;
    tags = config.tagIds.join(', ');
    dialog?.showModal();
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
  </div>

  <div class="dialog-actions">
    <button onclick={close}>Cancel</button>
    <button class="btn-primary" onclick={save}>Save</button>
  </div>
</dialog>
