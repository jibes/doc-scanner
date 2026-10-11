<script lang="ts">
  import { onMount } from 'svelte';
  import CameraScreen from './components/CameraScreen.svelte';
  import CropScreen from './components/CropScreen.svelte';
  import DocumentScreen from './components/DocumentScreen.svelte';
  import HistoryScreen from './components/HistoryScreen.svelte';
  import Onboarding from './components/Onboarding.svelte';
  import Overlays from './components/Overlays.svelte';
  import PageScreen from './components/PageScreen.svelte';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import { forgetExport, pausePrefetch, prefetchExports, resumePrefetch } from './lib/exportCache';
  import { dropRenders } from './lib/renderCache';
  import { detector, forgetPage } from './lib/services';
  import { loadSettings, saveSettings, type AppSettings } from './lib/settings';
  import { clearShareFlag, importShared, sharedFiles } from './lib/shareTarget';
  import { session } from './lib/store/session.svelte';

  type Screen =
    | { name: 'camera'; retakeId: string | null }
    | { name: 'document' }
    | { name: 'history' }
    | { name: 'page'; id: string }
    | { name: 'crop'; id: string; back: Screen };

  let settings = $state<AppSettings>(loadSettings());
  let screen = $state<Screen>({ name: 'document' });
  let settingsDialog = $state<{ open: () => Promise<void> } | null>(null);

  onMount(() => {
    // Start loading the model straight away; it is needed on the first frame.
    detector();
    // Photos shared from another app (Android share sheet) become pages.
    clearShareFlag();
    const shared = sharedFiles().catch(() => null);
    void session.restore().then(async () => {
      const share = await shared;
      if (share?.files.length) void importShared(share, settings.defaultFilter);
      else if (session.pages.length === 0) screen = { name: 'camera', retakeId: null };
    });
  });

  function updateSettings(next: AppSettings) {
    settings = next;
    saveSettings(next);
  }

  // Prepare export renders in the background whenever the document changes,
  // except while the camera is open: detection needs the CPU then.
  $effect(() => {
    const pages = session.pages;
    const current = $state.snapshot(settings);
    if (screen.name === 'camera' || !session.loaded) {
      pausePrefetch();
      return;
    }
    resumePrefetch();
    const timer = setTimeout(() => prefetchExports(pages, current), 800);
    return () => clearTimeout(timer);
  });

  // Free what the workers and the render cache keep for photos that are gone:
  // pages deleted, retaken or discarded with the document.
  let photos = new Map<string, Blob>();
  $effect(() => {
    const next = new Map(session.pages.map((p) => [p.id, p.source]));
    for (const [id, source] of photos) {
      if (next.get(id) === source) continue;
      forgetPage(id);
      forgetExport(id);
      dropRenders(source);
    }
    photos = next;
  });

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
      onHistory={() => (screen = { name: 'history' })}
    />
  {:else if screen.name === 'history'}
    <HistoryScreen {settings} onBack={() => (screen = { name: 'document' })} />
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
  <Onboarding screen={session.loaded ? screen.name : 'boot'} />
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
