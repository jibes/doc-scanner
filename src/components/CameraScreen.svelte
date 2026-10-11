<script lang="ts">
  import { onMount } from 'svelte';
  import { captureStill, openCamera, setTorch, stopStream } from '../lib/camera/camera';
  import type { Detection } from '../lib/detect/heatmap';
  import { MODEL_INPUT } from '../lib/detect/model';
  import type { FilterId } from '../lib/imaging/filters';
  import type { Point, Quad } from '../lib/imaging/image';
  import { haptic } from '../lib/haptics';
  import { addPhoto as addToDocument, importNote, importPhotos } from '../lib/importPhotos';
  import { detector } from '../lib/services';
  import { session } from '../lib/store/session.svelte';
  import { dock, errorMessage, toast } from '../lib/ui.svelte';
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
  /** A page covering less of the frame than this is too far away to read well. */
  const SMALL_AREA = 0.18;
  /** Mean frame brightness (0..1) below which the scene is too dark. */
  const DARK_LUMA = 0.16;

  let stage = $state<HTMLDivElement | null>(null);
  let video = $state<HTMLVideoElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let stageSize = $state({ width: 0, height: 0 });
  let videoSize = $state({ width: 0, height: 0 });

  let cameraError = $state('');
  let cameraReady = $state(false);
  let torchAvailable = $state(false);
  let torchOn = $state(false);
  let detectorState = $state<'loading' | 'ready' | 'failed'>('loading');
  /**
   * The detector in use. One that dies is replaced when the camera is opened
   * or comes back to the foreground, not in a loop while it keeps failing.
   */
  let pageDetector = detector();

  function connectDetector() {
    const client = detector();
    pageDetector = client;
    detectorState = 'loading';
    client.ready
      .then(() => {
        if (pageDetector === client) detectorState = 'ready';
      })
      .catch(() => {
        if (pageDetector === client) detectorState = 'failed';
      });
  }
  let quad = $state.raw<Quad | null>(null);
  let steady = $state(0);
  let capturing = $state(false);
  let flash = $state(false);
  /** The still is being taken: the phone must not move yet. */
  let exposing = $state(false);
  /** Brief "Page N added" confirmation. */
  let added = $state<number | null>(null);
  let addedTimer: ReturnType<typeof setTimeout> | undefined;
  let dark = $state(false);
  /** The outline as drawn: eases towards `quad` every animation frame. */
  let shown = $state.raw<Quad | null>(null);

  let track: MediaStreamTrack | null = null;
  let stream: MediaStream | null = null;
  let running = true;
  /** The app is in the background: the camera is closed until it returns. */
  let hidden = false;
  let openToken = 0;
  let lastRestart = 0;
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

  /** Close the camera, and cancel an open in progress. */
  function closeCamera() {
    openToken++;
    stopStream(stream);
    stream = null;
    track = null;
    cameraReady = false;
    // What was seen before is stale: auto-capture must start over.
    resetTracking();
  }

  async function startCamera() {
    closeCamera();
    const token = openToken;
    cameraError = '';
    try {
      const camera = await openCamera(deviceId);
      if (token !== openToken) {
        stopStream(camera.stream);
        return;
      }
      stream = camera.stream;
      track = camera.track;
      watchTrack(camera.track);
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

  /**
   * The browser ends the track when another app takes the camera, and some
   * stop delivering frames (muted) during an interruption such as a call.
   * Either way the last frame stays on screen and must not be captured.
   */
  function watchTrack(watched: MediaStreamTrack) {
    watched.addEventListener('ended', () => {
      if (watched !== track || !running || hidden) return;
      // A camera that ends again straight away is not coming back by itself.
      if (performance.now() - lastRestart < 3000) {
        closeCamera();
        cameraError = 'The camera stopped. It may be in use by another app.';
        return;
      }
      lastRestart = performance.now();
      void startCamera();
    });
    watched.addEventListener('mute', () => {
      if (watched === track) resetTracking();
    });
  }

  function visibilityChanged() {
    if (document.visibilityState === 'hidden') {
      // Leave the camera to other apps, and stop detecting on a frozen frame.
      hidden = true;
      closeCamera();
    } else if (hidden) {
      hidden = false;
      void startCamera();
      if (pageDetector.dead) connectDetector();
    }
  }

  onMount(() => {
    hidden = document.visibilityState === 'hidden';
    if (!hidden) void startCamera();
    document.addEventListener('visibilitychange', visibilityChanged);
    connectDetector();
    void detectLoop();
    let frame = requestAnimationFrame(function animate(time) {
      animateOutline(time);
      frame = requestAnimationFrame(animate);
    });

    const observer = new ResizeObserver(([entry]) => {
      stageSize = { width: entry.contentRect.width, height: entry.contentRect.height };
    });
    if (stage) observer.observe(stage);

    return () => {
      running = false;
      openToken++;
      document.removeEventListener('visibilitychange', visibilityChanged);
      cancelAnimationFrame(frame);
      clearTimeout(addedTimer);
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

  function resetTracking() {
    raw = null;
    quad = null;
    steady = 0;
    misses = 0;
  }

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
    quad = next;

    if (!armed && lastCaptured && maxMove(lastCaptured, next) > REARM_MOVE) armed = true;
    steady = armed ? Math.min(1, (now - steadySince) / STEADY_MS) : 0;
    if (autoCapture && armed && steady >= 1 && !capturing) void capture(true);
  }

  /** Signed-area magnitude of a quad in normalised frame coordinates. */
  function area(q: Quad): number {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = q[i];
      const [x1, y1] = q[(i + 1) % 4];
      sum += x0 * y1 - x1 * y0;
    }
    return Math.abs(sum) / 2;
  }

  const tooFar = $derived(quad !== null && area(quad) < SMALL_AREA);

  /** Mean brightness of the video frame, from a tiny copy. */
  function measureLight(probe: CanvasRenderingContext2D, source: HTMLVideoElement) {
    probe.drawImage(source, 0, 0, 16, 16);
    const { data } = probe.getImageData(0, 0, 16, 16);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    const mean = sum / (data.length / 4) / 255;
    // Hysteresis, so the hint does not flicker around the limit.
    dark = dark ? mean < DARK_LUMA * 1.25 : mean < DARK_LUMA;
  }

  let lastTime = 0;

  function animateOutline(time: number) {
    const dt = Math.min(100, time - (lastTime || time));
    lastTime = time;
    if (!quad) {
      shown = null;
      return;
    }
    if (!shown) {
      shown = quad;
      return;
    }
    // Exponential ease: ~90% of the way in 120 ms, independent of frame rate.
    const t = 1 - Math.exp(-dt / 52);
    if (maxMove(shown, quad) > 0.0005) shown = blend(shown, quad, t);
  }

  async function detectLoop() {
    await pageDetector.ready.catch(() => undefined);
    const canvas = document.createElement('canvas');
    canvas.width = MODEL_INPUT;
    canvas.height = MODEL_INPUT;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = 16;
    probeCanvas.height = 16;
    const probe = probeCanvas.getContext('2d', { willReadFrequently: true });
    let frames = 0;
    while (running) {
      if (
        detectorState !== 'ready' ||
        !cameraReady ||
        hidden ||
        track?.muted ||
        capturing ||
        !video ||
        video.readyState < 2
      ) {
        await new Promise((r) => setTimeout(r, 120));
        continue;
      }
      const started = performance.now();
      try {
        if (probe && frames++ % 8 === 0) measureLight(probe, video);
        ctx?.drawImage(video, 0, 0, MODEL_INPUT, MODEL_INPUT);
        const bitmap = await createImageBitmap(canvas);
        const { detection } = await pageDetector.frame(bitmap);
        // The camera may have been closed or paused while the frame was in flight.
        if (running && !capturing && cameraReady && !track?.muted) onDetection(detection);
      } catch {
        if (pageDetector.dead) {
          detectorState = 'failed';
          raw = null;
          quad = null;
          steady = 0;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      // Leave the main thread some air on slow phones.
      const elapsed = performance.now() - started;
      await new Promise((r) => setTimeout(r, Math.max(16, 70 - elapsed)));
    }
  }

  /* ----------------------------------------------------------- capture ---- */

  /** The detector died during a still: say so instead of failing silently. */
  function checkDetector() {
    if (pageDetector.dead) detectorState = 'failed';
  }

  async function addPhoto(source: Blob) {
    try {
      return await addToDocument(pageDetector, source, { filter: defaultFilter, retakeId });
    } finally {
      checkDetector();
    }
  }

  async function capture(auto = false) {
    if (capturing || !track || !video) return;
    capturing = true;
    exposing = true;
    lastCaptured = raw;
    armed = false;
    steady = 0;
    try {
      const still = await captureStill(track, video);
      // The flash and buzz mean "done, you can move": only once the photo is
      // actually taken, which on Android (full-sensor still) takes a moment.
      exposing = false;
      flash = true;
      setTimeout(() => (flash = false), 180);
      haptic('capture');
      const { id, found, blurred, offFrame } = await addPhoto(still);
      // The page is kept, but a camera screen that has closed meanwhile must
      // not navigate anywhere.
      if (!running) return;
      if (!retakeId) {
        added = session.pages.length;
        clearTimeout(addedTimer);
        addedTimer = setTimeout(() => (added = null), 1400);
      }
      if (blurred)
        toast('That page came out blurred. Hold still until the flash and retake it.', 'err');
      else if (offFrame)
        toast('The page runs off the photo; only the part in view was kept.', 'info');
      if (retakeId) onRetaken(id);
      else if (!found && !auto) {
        toast('No page edges found. Drag the corners into place.', 'info');
        onCrop(id);
      }
    } catch (error) {
      if (running && !hidden) toast(`Capture failed: ${errorMessage(error)}`, 'err');
    } finally {
      exposing = false;
      capturing = false;
    }
  }

  async function importFiles(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = '';
    if (!files.length) return;
    capturing = true;
    // Photos that cannot be read are skipped and counted, never thrown.
    const summary = await importPhotos(pageDetector, files, { filter: defaultFilter, retakeId });
    checkDetector();
    capturing = false;
    if (!running) return;
    const note = importNote(summary);
    if (note) toast(note.message, note.kind);
    if (retakeId) onRetaken(retakeId);
    else onClose();
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
    shown && mapping
      ? shown.map(([x, y]) => `${mapping.x + x * mapping.w},${mapping.y + y * mapping.h}`).join(' ')
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
        <div class="notice-actions">
          <button class="primary" onclick={() => void startCamera()}>Try again</button>
          <button onclick={() => fileInput?.click()}>Choose photos instead</button>
        </div>
      </div>
    {:else if !cameraReady}
      <div class="notice"><div class="spinner"></div></div>
    {/if}

    <div class="status" role="status" aria-live="polite">
      {#if detectorState === 'loading'}
        <span class="pill">Loading page detector…</span>
      {:else if detectorState === 'failed'}
        <span class="pill warn">Auto-detect unavailable — crop by hand</span>
      {:else if capturing}
        <span class="pill" class:hold={exposing}>{exposing ? 'Hold still…' : 'Processing…'}</span>
      {:else if added !== null}
        <span class="pill good"><Icon name="check" size={18} /> Page {added} added</span>
      {:else if dark && cameraReady}
        <span class="pill warn">
          {torchAvailable && !torchOn
            ? 'Too dark — turn on the flash'
            : 'Too dark — find more light'}
        </span>
      {:else if tooFar}
        <span class="pill">Move closer</span>
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
            <span class="dot" aria-hidden="true"></span>Auto
          </button>
        {/if}
      </div>
    </div>
  </div>

  <div class="controls" use:dock>
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

    <div class="end">
      {#if !retakeId && lastPage}
        {@const count = session.pages.length}
        <button class="done" onclick={onClose} aria-label="Done, review {count} pages">
          <span class="thumb">
            <PageCanvas
              page={lastPage}
              longEdge={520}
              channel="camera-thumb"
              class="thumb-canvas"
            />
          </span>
          <span class="done-text">
            <strong>Done</strong>
            {#key count}
              <span class="pop">{count} {count === 1 ? 'page' : 'pages'}</span>
            {/key}
          </span>
        </button>
      {/if}
    </div>
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
    border-radius: 0 0 var(--r-xl) var(--r-xl);
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
    fill: rgb(91 140 255 / 14%);
    stroke: #5b8cff;
    stroke-width: 2.5;
    stroke-linejoin: round;
    transition:
      fill var(--dur-2) var(--ease),
      stroke var(--dur-2) var(--ease);
  }

  .overlay polygon.steady {
    fill: rgb(116 201 149 / 18%);
    stroke: var(--good);
  }

  .flash {
    position: absolute;
    inset: 0;
    background: #fff;
    opacity: 0.7;
    pointer-events: none;
  }

  .notice {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--s-5);
    padding: var(--s-8);
    text-align: center;
    color: var(--text-2);
  }

  .notice p {
    margin: 0;
    max-width: 32ch;
    font-size: var(--fs-body);
    line-height: 1.5;
    color: var(--text);
  }

  .notice-actions {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    width: min(280px, 100%);
  }

  .top {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: calc(var(--s-3) + var(--safe-top)) var(--s-4) var(--s-6);
    background: linear-gradient(rgb(0 0 0 / 45%), transparent);
  }

  .top-right {
    display: flex;
    gap: var(--s-2);
    margin-left: auto;
  }

  /* Controls over the picture: dark glass discs, legible over any image. */
  .round {
    border-radius: var(--r-full);
    background: rgb(0 0 0 / 38%);
    color: #fff;
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
  }

  @media (hover: hover) {
    .round:hover:not(:disabled) {
      background: rgb(0 0 0 / 55%);
    }
  }

  @media (hover: hover) {
    .round.on,
    .round.on:hover:not(:disabled) {
      background: #fff;
      color: #000;
    }
  }

  .auto {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    padding: 0 var(--s-4) 0 14px;
    font-size: var(--fs-caption);
    font-weight: 650;
    letter-spacing: 0.02em;
  }

  .auto .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1.5px solid currentColor;
    transition: background-color var(--dur-1) var(--ease);
  }

  .auto.on .dot {
    background: var(--good);
    border-color: var(--good);
  }

  .status {
    position: absolute;
    left: var(--s-4);
    right: var(--s-4);
    bottom: var(--s-5);
    display: flex;
    justify-content: center;
    pointer-events: none;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    padding: var(--s-2) var(--s-4);
    border-radius: var(--r-full);
    background: rgb(0 0 0 / 58%);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    color: #fff;
    font-size: var(--fs-body);
    font-weight: 500;
    text-align: center;
    animation: pill-in var(--dur-2) var(--ease);
  }

  @keyframes pill-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }

  /* The moment that matters: keep still. */
  .pill.hold {
    background: #fff;
    color: #000;
    font-weight: 650;
  }

  .pill.warn {
    color: #ffd58a;
  }

  .pill.good {
    background: #fff;
    color: #000;
    font-weight: 600;
  }

  .pill.good :global(svg) {
    color: #1f7a45;
    stroke-width: 2.25;
  }

  .pop {
    display: inline-block;
    animation: pop 0.3s var(--ease);
  }

  @keyframes pop {
    40% {
      transform: scale(1.25);
    }
  }

  .controls {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-5) var(--s-4) calc(var(--s-6) + var(--safe-bottom));
    background: #000;
  }

  .controls > .round {
    width: 52px;
    height: 52px;
    justify-self: start;
    background: rgb(255 255 255 / 12%);
  }

  @media (hover: hover) {
    .controls > .round:hover:not(:disabled) {
      background: rgb(255 255 255 / 20%);
    }
  }

  /* White disc in a ring; the ring fills while the page is held steady. */
  .shutter {
    width: 80px;
    height: 80px;
    min-height: 0;
    border-radius: 50%;
    padding: 0;
    background:
      radial-gradient(circle closest-side, #fff 0 79%, #000 80% 87%, transparent 88%),
      conic-gradient(var(--good) calc(var(--steady) * 1turn), #fff 0);
    transition: transform var(--dur-1) var(--ease);
  }

  @media (hover: hover) {
    .shutter:hover:not(:disabled) {
      background:
        radial-gradient(circle closest-side, #fff 0 79%, #000 80% 87%, transparent 88%),
        conic-gradient(var(--good) calc(var(--steady) * 1turn), #fff 0);
    }
  }

  .shutter:active:not(:disabled) {
    transform: scale(0.92);
  }

  .shutter:disabled {
    opacity: 0.5;
  }

  .end {
    justify-self: end;
    min-width: 0;
  }

  /* Prominent once there are pages: the way out of the camera. */
  .done {
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 100%;
    min-height: 56px;
    padding: 6px var(--s-4) 6px 6px;
    border-radius: var(--r-l);
    background: var(--accent);
    color: #fff;
    text-align: left;
  }

  @media (hover: hover) {
    .done:hover:not(:disabled) {
      background: var(--accent-strong, #2f5bc9);
    }
  }

  .thumb {
    flex: 0 0 auto;
    width: 34px;
    height: 44px;
    border-radius: var(--r-xs);
    overflow: hidden;
    background: #fff;
    box-shadow: 0 1px 4px rgb(0 0 0 / 30%);
  }

  .thumb :global(.thumb-canvas) {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .done-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.2;
    white-space: nowrap;
  }

  .done-text strong {
    font-size: var(--fs-body);
    font-weight: 650;
  }

  .done-text span {
    font-size: 12px;
    opacity: 0.85;
    font-variant-numeric: tabular-nums;
  }

  /* Small phones: the words matter more than the picture. */
  @media (max-width: 359px) {
    .thumb {
      display: none;
    }

    .done {
      padding: 6px var(--s-4);
    }
  }
</style>
