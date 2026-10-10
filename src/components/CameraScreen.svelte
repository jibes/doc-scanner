<script lang="ts">
  import { onMount } from 'svelte';
  import { captureStill, openCamera, setTorch, stopStream } from '../lib/camera/camera';
  import type { Detection } from '../lib/detect/heatmap';
  import { MODEL_INPUT } from '../lib/detect/model';
  import type { FilterId } from '../lib/imaging/filters';
  import type { Point, Quad } from '../lib/imaging/image';
  import { insetQuad } from '../lib/imaging/quad';
  import { defaultSpec } from '../lib/pipeline';
  import { detector } from '../lib/services';
  import { session } from '../lib/store/session.svelte';
  import { errorMessage, toast } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';
  import PageCanvas from './PageCanvas.svelte';

  interface Props {
    deviceId: string | null;
    autoCapture: boolean;
    defaultFilter: FilterId;
    /** When set, the capture replaces this page's photo instead of adding a page. */
    retakeId: string | null;
    onAutoCaptureChange: (on: boolean) => void;
    onClose: () => void;
    onCrop: (pageId: string) => void;
    onRetaken: (pageId: string) => void;
  }

  let {
    deviceId,
    autoCapture,
    defaultFilter,
    retakeId,
    onAutoCaptureChange,
    onClose,
    onCrop,
    onRetaken,
  }: Props = $props();

  /** Hold still this long before auto-capture fires. */
  const STEADY_MS = 1100;
  /** Max per-frame corner movement (fraction of the frame) that still counts as steady. */
  const STEADY_MOVE = 0.012;
  /** After an auto-capture, the page must move this much (or leave) before the next one. */
  const REARM_MOVE = 0.08;
  const MIN_CONFIDENCE = 0.45;

  let stage = $state<HTMLDivElement | null>(null);
  let video = $state<HTMLVideoElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let stageSize = $state({ width: 0, height: 0 });
  let videoSize = $state({ width: 0, height: 0 });

  let cameraError = $state('');
  let cameraReady = $state(false);
  let lensLabel = $state('');
  let torchAvailable = $state(false);
  let torchOn = $state(false);
  let detectorState = $state<'loading' | 'ready' | 'failed'>('loading');
  let quad = $state.raw<Quad | null>(null);
  let steady = $state(0);
  let capturing = $state(false);
  let flash = $state(false);

  let track: MediaStreamTrack | null = null;
  let stream: MediaStream | null = null;
  let running = true;
  let openToken = 0;
  let armed = true;
  let lastCaptured: Quad | null = null;

  const lastPage = $derived(session.pages.at(-1) ?? null);

  function describeCameraError(error: unknown): string {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Camera access is blocked. Allow it in your browser’s site settings, or import photos instead.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'No camera was found on this device.';
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      return 'The camera is busy, probably in use by another app. Close it and try again.';
    }
    return errorMessage(error);
  }

  async function startCamera() {
    const token = ++openToken;
    stopStream(stream);
    stream = null;
    track = null;
    cameraReady = false;
    cameraError = '';
    try {
      const camera = await openCamera(deviceId);
      if (token !== openToken) {
        stopStream(camera.stream);
        return;
      }
      stream = camera.stream;
      track = camera.track;
      lensLabel = camera.label;
      torchAvailable = camera.torch;
      torchOn = false;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      if (token === openToken) cameraReady = true;
    } catch (error) {
      if (token === openToken) cameraError = describeCameraError(error);
    }
  }

  onMount(() => {
    void startCamera();
    detector()
      .ready.then(() => (detectorState = 'ready'))
      .catch(() => (detectorState = 'failed'));
    void detectLoop();

    const observer = new ResizeObserver(([entry]) => {
      stageSize = { width: entry.contentRect.width, height: entry.contentRect.height };
    });
    if (stage) observer.observe(stage);

    return () => {
      running = false;
      openToken++;
      observer.disconnect();
      stopStream(stream);
      stream = null;
    };
  });

  /* --------------------------------------------------------- detection ---- */

  function maxMove(a: Quad, b: Quad): number {
    let m = 0;
    for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
    return m;
  }

  function blend(prev: Quad, next: Quad, t: number): Quad {
    return prev.map(
      (p, i) => [p[0] + (next[i][0] - p[0]) * t, p[1] + (next[i][1] - p[1]) * t] as Point,
    ) as unknown as Quad;
  }

  let raw: Quad | null = null;
  let misses = 0;
  let steadySince = 0;

  function onDetection(detection: Detection | null) {
    const now = performance.now();
    if (!detection || detection.confidence < MIN_CONFIDENCE) {
      if (++misses > 3) {
        raw = null;
        quad = null;
        steady = 0;
        // The page left the frame: the next one may be auto-captured.
        armed = true;
      }
      return;
    }
    misses = 0;
    const next = detection.quad;
    if (!raw || maxMove(raw, next) > STEADY_MOVE) steadySince = now;
    raw = next;
    quad = quad ? blend(quad, next, 0.55) : next;

    if (!armed && lastCaptured && maxMove(lastCaptured, next) > REARM_MOVE) armed = true;
    steady = armed ? Math.min(1, (now - steadySince) / STEADY_MS) : 0;
    if (autoCapture && armed && steady >= 1 && !capturing) void capture(true);
  }

  async function detectLoop() {
    await detector().ready.catch(() => undefined);
    const canvas = document.createElement('canvas');
    canvas.width = MODEL_INPUT;
    canvas.height = MODEL_INPUT;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    while (running) {
      if (
        detectorState !== 'ready' ||
        !cameraReady ||
        capturing ||
        !video ||
        video.readyState < 2
      ) {
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      const started = performance.now();
      try {
        ctx?.drawImage(video, 0, 0, MODEL_INPUT, MODEL_INPUT);
        const bitmap = await createImageBitmap(canvas);
        const { detection } = await detector().frame(bitmap);
        if (running && !capturing) onDetection(detection);
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
      // Leave the main thread some air on slow phones.
      const elapsed = performance.now() - started;
      await new Promise((r) => setTimeout(r, Math.max(16, 70 - elapsed)));
    }
  }

  /* ----------------------------------------------------------- capture ---- */

  async function addPhoto(source: Blob): Promise<{ id: string; found: boolean }> {
    let result: { quad: Quad | null; width: number; height: number };
    try {
      result = await detector().still(source);
    } catch {
      const bitmap = await createImageBitmap(source);
      result = { quad: null, width: bitmap.width, height: bitmap.height };
      bitmap.close();
    }
    const pageQuad = result.quad ?? insetQuad(result.width, result.height, 0.04);
    const photo = { source, width: result.width, height: result.height, detected: result.quad };
    if (retakeId && session.get(retakeId)) {
      session.replaceSource(retakeId, { ...photo, quad: pageQuad });
      return { id: retakeId, found: result.quad !== null };
    }
    const page = session.add({ ...photo, spec: defaultSpec(pageQuad, defaultFilter) });
    return { id: page.id, found: result.quad !== null };
  }

  async function capture(auto = false) {
    if (capturing || !track || !video) return;
    capturing = true;
    flash = true;
    setTimeout(() => (flash = false), 180);
    lastCaptured = raw;
    armed = false;
    steady = 0;
    try {
      const still = await captureStill(track, video);
      const { id, found } = await addPhoto(still);
      if (navigator.vibrate) navigator.vibrate(30);
      if (retakeId) onRetaken(id);
      else if (!found && !auto) {
        toast('No page edges found. Drag the corners into place.', 'info');
        onCrop(id);
      }
    } catch (error) {
      toast(`Capture failed: ${errorMessage(error)}`, 'err');
    } finally {
      capturing = false;
    }
  }

  async function importFiles(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    capturing = true;
    let missing = 0;
    try {
      for (const file of files) {
        const { found } = await addPhoto(file);
        if (!found) missing++;
        if (retakeId) break;
      }
    } catch (error) {
      toast(`Could not import: ${errorMessage(error)}`, 'err');
    } finally {
      capturing = false;
    }
    if (retakeId) onRetaken(retakeId);
    else {
      if (missing) toast(`${missing} page(s) had no detectable edges; check their crop.`, 'info');
      onClose();
    }
  }

  async function toggleTorch() {
    if (!track) return;
    try {
      await setTorch(track, !torchOn);
      torchOn = !torchOn;
    } catch {
      toast('The flash could not be switched.', 'err');
    }
  }

  /* ----------------------------------------------------------- overlay ---- */

  /** Map a normalised frame point to stage pixels under `object-fit: cover`. */
  const mapping = $derived.by(() => {
    const { width: vw, height: vh } = videoSize;
    const { width: cw, height: ch } = stageSize;
    if (!vw || !vh || !cw || !ch) return null;
    const scale = Math.max(cw / vw, ch / vh);
    return { w: vw * scale, h: vh * scale, x: (cw - vw * scale) / 2, y: (ch - vh * scale) / 2 };
  });

  const polygon = $derived(
    quad && mapping
      ? quad.map(([x, y]) => `${mapping.x + x * mapping.w},${mapping.y + y * mapping.h}`).join(' ')
      : '',
  );
</script>

<section class="screen camera">
  <div class="stage" bind:this={stage}>
    <video
      bind:this={video}
      playsinline
      muted
      autoplay
      onloadedmetadata={() =>
        video && (videoSize = { width: video.videoWidth, height: video.videoHeight })}
      onresize={() => video && (videoSize = { width: video.videoWidth, height: video.videoHeight })}
    ></video>

    <svg class="overlay" viewBox="0 0 {stageSize.width} {stageSize.height}" aria-hidden="true">
      {#if polygon}
        <polygon points={polygon} class:steady={steady > 0.05} />
      {/if}
    </svg>

    {#if flash}<div class="flash"></div>{/if}

    {#if cameraError}
      <div class="notice">
        <p>{cameraError}</p>
        <button onclick={() => void startCamera()}>Try again</button>
        <button onclick={() => fileInput?.click()}>Choose photos instead</button>
      </div>
    {:else if !cameraReady}
      <div class="notice"><div class="spinner"></div></div>
    {/if}

    <div class="status">
      {#if detectorState === 'loading'}
        <span class="pill">Loading page detector…</span>
      {:else if detectorState === 'failed'}
        <span class="pill warn">Auto-detect unavailable — crop by hand</span>
      {:else if capturing}
        <span class="pill">Capturing…</span>
      {:else if quad && autoCapture && steady > 0}
        <span class="pill">Hold steady…</span>
      {:else if !quad && cameraReady}
        <span class="pill">Point at a page</span>
      {/if}
    </div>

    <div class="top">
      <button class="icon round" onclick={onClose} aria-label="Close camera">
        <Icon name="close" />
      </button>
      <span class="lens">{lensLabel}</span>
      <div class="top-right">
        {#if torchAvailable}
          <button
            class="icon round"
            class:on={torchOn}
            onclick={() => void toggleTorch()}
            aria-label="Flash"
          >
            <Icon name={torchOn ? 'flash' : 'flashOff'} />
          </button>
        {/if}
        {#if !retakeId}
          <button
            class="round auto"
            class:on={autoCapture}
            onclick={() => onAutoCaptureChange(!autoCapture)}
            aria-pressed={autoCapture}
          >
            Auto
          </button>
        {/if}
      </div>
    </div>
  </div>

  <div class="controls">
    <button class="icon round" onclick={() => fileInput?.click()} aria-label="Import photos">
      <Icon name="gallery" />
    </button>

    <button
      class="shutter"
      onclick={() => void capture(false)}
      disabled={!cameraReady || capturing}
      aria-label="Capture page"
      style="--steady: {steady}"
    ></button>

    {#if retakeId}
      <div class="thumb-slot"></div>
    {:else if lastPage}
      <button class="thumb" onclick={onClose} aria-label="Review {session.pages.length} pages">
        <PageCanvas page={lastPage} longEdge={200} channel="camera-thumb" class="thumb-canvas" />
        <span class="count">{session.pages.length}</span>
      </button>
    {:else}
      <div class="thumb-slot"></div>
    {/if}
  </div>

  <input
    bind:this={fileInput}
    type="file"
    accept="image/*"
    multiple={!retakeId}
    hidden
    onchange={(e) => void importFiles(e)}
  />
</section>

<style>
  .camera {
    background: #000;
  }

  .stage {
    position: relative;
    flex: 1;
    overflow: hidden;
  }

  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .overlay polygon {
    fill: rgb(79 140 255 / 18%);
    stroke: var(--accent);
    stroke-width: 3;
    stroke-linejoin: round;
    transition: fill 0.2s ease;
  }

  .overlay polygon.steady {
    fill: rgb(34 197 94 / 22%);
    stroke: var(--good);
  }

  .flash {
    position: absolute;
    inset: 0;
    background: #fff;
    opacity: 0.75;
    pointer-events: none;
  }

  .notice {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 32px;
    text-align: center;
    color: var(--muted);
  }

  .notice p {
    margin: 0;
    max-width: 36ch;
  }

  .top {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: calc(10px + var(--safe-top)) 12px 10px;
    background: linear-gradient(rgb(0 0 0 / 55%), transparent);
  }

  .top-right {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }

  .lens {
    font-size: 11px;
    color: rgb(255 255 255 / 60%);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .round {
    border-radius: 999px;
    background: rgb(0 0 0 / 40%);
    border: 1px solid rgb(255 255 255 / 15%);
    color: #fff;
    backdrop-filter: blur(10px);
  }

  .round.on {
    background: #fff;
    color: #000;
  }

  .auto {
    padding: 9px 14px;
    font-size: 13px;
    font-weight: 600;
  }

  .status {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 16px;
    display: flex;
    justify-content: center;
    pointer-events: none;
  }

  .pill {
    background: rgb(0 0 0 / 60%);
    backdrop-filter: blur(10px);
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 13px;
  }

  .pill.warn {
    color: var(--warn);
  }

  .controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 28px calc(22px + var(--safe-bottom));
    background: #000;
  }

  .controls > .round,
  .thumb,
  .thumb-slot {
    width: 56px;
    height: 56px;
  }

  .shutter {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    padding: 0;
    border: 4px solid #fff;
    background:
      radial-gradient(circle, #fff 0 60%, transparent 61%),
      conic-gradient(var(--good) calc(var(--steady) * 360deg), transparent 0);
  }

  .thumb {
    position: relative;
    padding: 0;
    border-radius: 10px;
    overflow: hidden;
    border: 2px solid #fff;
    background: #fff;
  }

  .thumb :global(.thumb-canvas) {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .count {
    position: absolute;
    top: -2px;
    right: -2px;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
