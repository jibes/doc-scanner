<script lang="ts">
  import { onMount } from 'svelte';
  import CameraScreen from './components/CameraScreen.svelte';
  import CropScreen from './components/CropScreen.svelte';
  import DocumentScreen from './components/DocumentScreen.svelte';
  import Overlays from './components/Overlays.svelte';
  import PageScreen from './components/PageScreen.svelte';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import { detector } from './lib/services';
  import { loadSettings, saveSettings, type AppSettings } from './lib/settings';
  import { session } from './lib/store/session.svelte';

  type Screen =
    | { name: 'camera'; retakeId: string | null }
    | { name: 'document' }
    | { name: 'page'; id: string }
    | { name: 'crop'; id: string; back: Screen };

  let settings = $state<AppSettings>(loadSettings());
  let screen = $state<Screen>({ name: 'document' });
  let settingsDialog = $state<{ open: () => Promise<void> } | null>(null);

  onMount(() => {
    // Start loading the model straight away; it is needed on the first frame.
    detector();
    void session.restore().then(() => {
      if (session.pages.length === 0) screen = { name: 'camera', retakeId: null };
    });
  });

  function updateSettings(next: AppSettings) {
    settings = next;
    saveSettings(next);
  }

  // A page can disappear underneath a screen (deleted, document discarded).
  const currentPage = $derived(
    screen.name === 'page' || screen.name === 'crop' ? session.get(screen.id) : undefined,
  );
  $effect(() => {
    if ((screen.name === 'page' || screen.name === 'crop') && session.loaded && !currentPage) {
      screen = { name: 'document' };
    }
  });
</script>

<main>
  {#if !session.loaded}
    <div class="boot"><div class="spinner"></div></div>
  {:else if screen.name === 'camera'}
    {@const retakeId = screen.retakeId}
    {#key settings.cameraDeviceId}
      <CameraScreen
        deviceId={settings.cameraDeviceId}
        autoCapture={settings.autoCapture}
        defaultFilter={settings.defaultFilter}
        {retakeId}
        onAutoCaptureChange={(on) => updateSettings({ ...settings, autoCapture: on })}
        onClose={() => (screen = { name: 'document' })}
        onCrop={(id) => (screen = { name: 'crop', id, back: { name: 'camera', retakeId: null } })}
        onRetaken={(id) => (screen = { name: 'page', id })}
      />
    {/key}
  {:else if screen.name === 'document'}
    <DocumentScreen
      {settings}
      onCamera={() => (screen = { name: 'camera', retakeId: null })}
      onOpen={(id) => (screen = { name: 'page', id })}
      onSettings={() => void settingsDialog?.open()}
    />
  {:else if screen.name === 'page' && currentPage}
    {@const id = screen.id}
    <PageScreen
      page={currentPage}
      onBack={() => (screen = { name: 'document' })}
      onCrop={() => (screen = { name: 'crop', id, back: { name: 'page', id } })}
      onRetake={() => (screen = { name: 'camera', retakeId: id })}
      onOpen={(next) => (screen = { name: 'page', id: next })}
    />
  {:else if screen.name === 'crop' && currentPage}
    {@const back = screen.back}
    <CropScreen page={currentPage} onDone={() => (screen = back)} />
  {/if}

  <SettingsDialog bind:this={settingsDialog} {settings} onSave={updateSettings} />
  <Overlays />
</main>

<style>
  main {
    position: relative;
    height: 100dvh;
    overflow: hidden;
  }

  .boot {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
