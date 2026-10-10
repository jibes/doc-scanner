<script lang="ts">
  import { onMount } from 'svelte';
  import BusyOverlay from './components/BusyOverlay.svelte';
  import CameraScreen from './components/CameraScreen.svelte';
  import CropScreen from './components/CropScreen.svelte';
  import ResultScreen from './components/ResultScreen.svelte';
  import SettingsDialog from './components/SettingsDialog.svelte';
  import Toast from './components/Toast.svelte';
  import { downscaleImage, imageToPngBlob } from './lib/canvas';
  import { loadCameraPreference } from './lib/cameraPrefs';
  import { scaleSettings, type ScanSettings } from './lib/imaging/pipeline';
  import { estimateDpi } from './lib/imaging/paper';
  import { addPngDpi } from './lib/imaging/png';
  import type { Quad, RGBAImage } from './lib/imaging/types';
  import {
    isConfigured,
    loadPaperlessConfig,
    uploadDocument,
    waitForTask,
    type PaperlessConfig,
  } from './lib/paperless';
  import { matchPreset, presetById, type PresetId } from './lib/presets';
  import { loadSettings, saveSettings } from './lib/settings';
  import { setBusy, showToast, ui } from './lib/ui.svelte';
  import { ProcessorClient, SupersededError } from './lib/worker/client';

  type Screen = 'camera' | 'crop' | 'result';

  /** Long edge of the image the interactive preview runs on. */
  const PREVIEW_MAX_EDGE = 900;
  const PREVIEW_DEBOUNCE_MS = 80;

  let screen = $state<Screen>('camera');
  let raw = $state.raw<RGBAImage | null>(null);
  let corners = $state.raw<Quad | null>(null);
  let warpedFull = $state.raw<RGBAImage | null>(null);
  // The long-edge cap warpedFull was rendered with, so a changed setting re-warps.
  let warpedFullEdge = 0;
  let warpedPreview = $state.raw<RGBAImage | null>(null);
  let preview = $state.raw<RGBAImage | null>(null);
  const initialSettings = loadSettings();
  let settings = $state<ScanSettings>(initialSettings);
  let paperless = $state<PaperlessConfig>(loadPaperlessConfig());
  let presetId = $state<PresetId | null>(matchPreset(initialSettings));
  let processing = $state(false);
  let preferredDeviceId = $state<string | null>(loadCameraPreference());
  // Bumped when the camera preference changes so the preview reopens the stream.
  let cameraRevision = $state(0);

  let processor: ProcessorClient | null = null;
  let settingsDialog = $state<{ open: () => void } | null>(null);
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  let previewSeq = 0;

  onMount(() => {
    processor = new ProcessorClient();
    return () => {
      processor?.dispose();
      processor = null;
    };
  });

  function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function longEdge(image: RGBAImage): number {
    return Math.max(image.width, image.height);
  }

  function defaultCorners(width: number, height: number): Quad {
    const inset = 0.06;
    const x0 = width * inset;
    const y0 = height * inset;
    const x1 = width * (1 - inset);
    const y1 = height * (1 - inset);
    return [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
  }

  function handleCapture(image: RGBAImage) {
    raw = image;
    corners = defaultCorners(image.width, image.height);
    warpedFull = null;
    warpedPreview = null;
    preview = null;
    screen = 'crop';
  }

  async function handleConfirmCrop() {
    const client = processor;
    const source = raw;
    const quad = corners;
    if (!client || !source || !quad) return;

    const maxLongEdge = settings.output.maxLongEdge;
    setBusy(true, 'Rectifying…');
    try {
      const warped = await client.warp(source, quad, maxLongEdge);
      // The user may have started over while the warp was running.
      if (screen !== 'crop' || raw !== source || corners !== quad) return;
      warpedFull = warped;
      warpedFullEdge = maxLongEdge;
      warpedPreview = downscaleImage(warped, PREVIEW_MAX_EDGE);
      preview = null;
      screen = 'result';
      await renderPreview();
    } catch (error) {
      showToast(`Could not rectify the page: ${message(error)}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function renderPreview() {
    const client = processor;
    const source = warpedPreview;
    if (!client || !source) return;

    const seq = ++previewSeq;
    processing = true;
    try {
      const result = await client.process(source, $state.snapshot(settings));
      if (seq === previewSeq) preview = result;
    } catch (error) {
      if (!(error instanceof SupersededError)) {
        showToast(`Processing failed: ${message(error)}`, 'err');
      }
    } finally {
      if (seq === previewSeq) processing = false;
    }
  }

  function flushPreview() {
    clearTimeout(previewTimer);
    previewTimer = undefined;
    // Persist here rather than on every input event: dragging a slider fires
    // dozens of them and localStorage writes are synchronous.
    saveSettings($state.snapshot(settings));
    void renderPreview();
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(flushPreview, PREVIEW_DEBOUNCE_MS);
  }

  function handleSettingsChange() {
    presetId = null;
    schedulePreview();
  }

  function handlePreset(id: PresetId) {
    // Presets describe the cleanup, not the export: keep the user's DPI and size.
    settings = {
      ...structuredClone(presetById(id).settings),
      output: $state.snapshot(settings.output),
    };
    presetId = id;
    schedulePreview();
  }

  async function renderFullPage(): Promise<Blob | null> {
    const client = processor;
    if (!client || !raw || !corners || !warpedPreview) return null;

    // The worker runs one request at a time and a new one supersedes the old.
    // Take any pending or in-flight preview out of the way so it cannot cancel
    // the full render, and redo it afterwards so the preview is not left stale.
    const previewInterrupted = previewTimer !== undefined || processing;
    clearTimeout(previewTimer);
    previewTimer = undefined;

    try {
      const maxLongEdge = settings.output.maxLongEdge;
      if (!warpedFull || warpedFullEdge !== maxLongEdge) {
        warpedFull = await client.warp(raw, corners, maxLongEdge);
        warpedFullEdge = maxLongEdge;
      }
      const source = warpedFull;

      // Pixel-unit settings are tuned on the preview; scale them to this size.
      const scale = longEdge(source) / longEdge(warpedPreview);
      const processed = await client.process(
        source,
        scaleSettings($state.snapshot(settings), scale),
      );
      const png = await imageToPngBlob(processed);
      const dpi = estimateDpi(processed.width, processed.height, settings.output.targetDpi);
      return addPngDpi(png, dpi);
    } finally {
      if (previewInterrupted) flushPreview();
    }
  }

  function filename(): string {
    return `scan-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  }

  async function handleSave() {
    setBusy(true, 'Rendering full resolution…');
    try {
      const blob = await renderFullPage();
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename();
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast('Saved PNG.', 'good');
    } catch (error) {
      showToast(`Could not save: ${message(error)}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload() {
    if (!isConfigured(paperless)) {
      settingsDialog?.open();
      showToast('Add your Paperless URL and API token first.', 'err');
      return;
    }

    setBusy(true, 'Rendering full resolution…');
    try {
      const blob = await renderFullPage();
      if (!blob) return;

      setBusy(true, 'Uploading to Paperless…');
      const taskId = await uploadDocument(
        paperless,
        blob,
        filename(),
        `Scan ${new Date().toLocaleString()}`,
      );

      setBusy(true, 'Waiting for OCR…');
      const status = await waitForTask(paperless, taskId);
      if (status?.status === 'SUCCESS') showToast('Indexed in Paperless.', 'good');
      else if (status?.status === 'FAILURE')
        showToast('Paperless could not process the document.', 'err');
      else showToast('Queued in Paperless.', 'good');
    } catch (error) {
      showToast(`Upload failed: ${message(error)}`, 'err');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    raw = null;
    corners = null;
    warpedFull = null;
    warpedFullEdge = 0;
    warpedPreview = null;
    preview = null;
    screen = 'camera';
  }
</script>

<div class="app">
  <header>
    <div class="brand">Doc Scanner</div>
    <div class="header-actions">
      {#if screen !== 'camera'}
        <button class="btn-icon" onclick={reset} disabled={ui.busy}>New</button>
      {/if}
      <button
        class="btn-icon"
        onclick={() => settingsDialog?.open()}
        disabled={ui.busy}
        aria-label="Settings"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
          />
        </svg>
      </button>
    </div>
  </header>

  <main>
    {#if screen === 'camera'}
      <CameraScreen onCapture={handleCapture} revision={cameraRevision} {preferredDeviceId} />
    {:else if screen === 'crop' && raw && corners}
      <CropScreen
        image={raw}
        {corners}
        onCornersChange={(next) => (corners = next)}
        onCancel={reset}
        onConfirm={() => void handleConfirmCrop()}
      />
    {:else if screen === 'result'}
      <ResultScreen
        {preview}
        original={warpedPreview}
        {settings}
        {presetId}
        {processing}
        onSettingsChange={handleSettingsChange}
        onPreset={handlePreset}
        onRecrop={() => (screen = 'crop')}
        onSave={() => void handleSave()}
        onUpload={() => void handleUpload()}
      />
    {/if}

    <BusyOverlay />
  </main>

  <SettingsDialog
    bind:this={settingsDialog}
    config={paperless}
    onSave={(next) => (paperless = next)}
    onCameraChange={() => {
      preferredDeviceId = loadCameraPreference();
      cameraRevision++;
    }}
  />
  <Toast />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100dvh;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: calc(10px + var(--safe-top)) 14px 10px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }

  .brand {
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .btn-icon svg {
    width: 20px;
    height: 20px;
    display: block;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  main {
    position: relative;
    flex: 1 1 auto;
    overflow: hidden;
  }
</style>
