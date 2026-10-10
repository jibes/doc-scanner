<script lang="ts">
  import {
    captureFrame,
    imageFromBlob,
    openCamera,
    stopStream,
    type CameraSelection,
    type Facing,
  } from '../lib/camera';
  import type { RGBAImage } from '../lib/imaging/types';
  import { showToast } from '../lib/ui.svelte';

  interface Props {
    onCapture: (image: RGBAImage) => void;
    /** Bumped by the settings dialog when the camera preference changes. */
    revision?: number;
    preferredDeviceId?: string | null;
  }

  let { onCapture, revision = 0, preferredDeviceId = null }: Props = $props();

  let video = $state<HTMLVideoElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let facing = $state<Facing>('environment');
  let ready = $state(false);
  let error = $state('');
  let selection = $state<CameraSelection | null>(null);

  // Deliberately not $state: the effect below writes it, and making it
  // reactive would retrigger the effect on every open.
  let stream: MediaStream | null = null;

  async function open() {
    stopStream(stream);
    stream = null;
    ready = false;
    error = '';
    selection = null;
    try {
      const result = await openCamera({ facing, preferredDeviceId });
      stream = result.stream;
      selection = result.selection;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
      }
      ready = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  $effect(() => {
    // Re-open whenever the facing or the saved camera preference changes.
    void revision;
    void preferredDeviceId;
    void facing;
    void open();
    return () => stopStream(stream);
  });

  function flip() {
    facing = facing === 'environment' ? 'user' : 'environment';
  }

  function shoot() {
    if (!video) return;
    const frame = captureFrame(video);
    if (!frame) {
      showToast('The camera has not produced a frame yet.', 'err');
      return;
    }
    onCapture(frame);
  }

  async function pick(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      onCapture(await imageFromBlob(file));
    } catch {
      showToast('Could not read that image.', 'err');
    }
  }
</script>

<section class="camera">
  <video bind:this={video} playsinline autoplay muted></video>

  {#if error}
    <div class="notice">
      <p>{error}</p>
      <button onclick={() => void open()}>Retry</button>
    </div>
  {:else if !ready}
    <div class="notice"><p>Starting camera…</p></div>
  {:else}
    <div class="hint">Fill the frame with the page</div>
    {#if selection}
      <div class="lens">
        {selection.label}{selection.zoom !== null ? ` · ${selection.zoom}x` : ''}
      </div>
    {/if}
  {/if}

  <div class="controls">
    <button class="round" onclick={() => fileInput?.click()} aria-label="Choose an image file">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    </button>

    <button class="shutter" onclick={shoot} disabled={!ready} aria-label="Capture page"></button>

    <button class="round" onclick={flip} aria-label="Switch camera">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.36-2.64" />
        <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.36 2.64" />
        <path d="M21 3v6h-6" />
        <path d="M3 21v-6h6" />
      </svg>
    </button>
  </div>

  <input
    bind:this={fileInput}
    type="file"
    accept="image/*"
    hidden
    onchange={pick}
    aria-hidden="true"
    tabindex="-1"
  />
</section>

<style>
  .camera {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: #000;
  }

  video {
    flex: 1 1 auto;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
  }

  .hint {
    position: absolute;
    top: 14px;
    left: 50%;
    transform: translateX(-50%);
    background: rgb(0 0 0 / 60%);
    backdrop-filter: blur(8px);
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 12px;
    color: rgb(255 255 255 / 85%);
    pointer-events: none;
  }

  .lens {
    position: absolute;
    top: 14px;
    left: 14px;
    max-width: 42%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: rgb(0 0 0 / 60%);
    backdrop-filter: blur(8px);
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 11px;
    color: rgb(255 255 255 / 70%);
    pointer-events: none;
  }

  .notice {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 32px;
    text-align: center;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.5;
  }

  .notice p {
    margin: 0;
    max-width: 34ch;
  }

  .controls {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    justify-content: space-around;
    align-items: center;
    gap: 24px;
    padding: 20px 24px calc(24px + var(--safe-bottom));
    background: linear-gradient(to top, rgb(0 0 0 / 85%), rgb(0 0 0 / 0%));
  }

  .shutter {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    background: #fff;
    border: 4px solid rgb(255 255 255 / 40%);
    padding: 0;
  }

  .shutter:active:not(:disabled) {
    transform: scale(0.92);
  }

  .round {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: rgb(255 255 255 / 15%);
    backdrop-filter: blur(8px);
    border: none;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .round svg {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
