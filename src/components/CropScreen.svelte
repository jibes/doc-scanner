<script lang="ts">
  import { drawImageToCanvas } from '../lib/canvas';
  import { clamp, containRect, isConvexQuad } from '../lib/geometry';
  import type { Point, Quad, RGBAImage } from '../lib/imaging/types';

  interface Props {
    image: RGBAImage;
    corners: Quad;
    onCornersChange: (corners: Quad) => void;
    onCancel: () => void;
    onConfirm: () => void;
  }

  let { image, corners, onCornersChange, onCancel, onConfirm }: Props = $props();

  let stage = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let size = $state({ width: 0, height: 0 });

  $effect(() => {
    if (!canvas) return;
    drawImageToCanvas(canvas, image);
  });

  $effect(() => {
    const element = stage;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      size = { width: rect.width, height: rect.height };
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  const layout = $derived(containRect(size.width, size.height, image.width, image.height));

  const handles = $derived(
    corners.map(([x, y]) => ({
      x: layout.x + (x / image.width) * layout.width,
      y: layout.y + (y / image.height) * layout.height,
    })),
  );

  const valid = $derived(isConvexQuad(corners));

  const polygon = $derived(handles.map((point) => `${point.x},${point.y}`).join(' '));

  function toImage(clientX: number, clientY: number): Point {
    const element = stage;
    if (!element) return [0, 0];
    const rect = element.getBoundingClientRect();
    const x = ((clientX - rect.left - layout.x) / layout.width) * image.width;
    const y = ((clientY - rect.top - layout.y) / layout.height) * image.height;
    return [clamp(x, 0, image.width - 1), clamp(y, 0, image.height - 1)];
  }

  function startDrag(index: number, event: PointerEvent) {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      const next: [Point, Point, Point, Point] = [corners[0], corners[1], corners[2], corners[3]];
      next[index] = toImage(moveEvent.clientX, moveEvent.clientY);
      onCornersChange(next);
    };

    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };

    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }
</script>

<section class="crop">
  <div class="stage" bind:this={stage}>
    <canvas bind:this={canvas}></canvas>
    <svg
      class="overlay"
      class:invalid={!valid}
      viewBox="0 0 {size.width} {size.height}"
      aria-hidden="true"
    >
      <polygon points={polygon} />
    </svg>
    {#each handles as handle, index (index)}
      <button
        type="button"
        class="handle"
        style="left: {handle.x}px; top: {handle.y}px"
        aria-label="Corner {index + 1} of 4"
        onpointerdown={(event) => startDrag(index, event)}
      ></button>
    {/each}
  </div>

  <p class="tip" class:warn={!valid}>
    {valid
      ? 'Drag the corners onto the page edges.'
      : 'The corners cross over. Move them back into a four-sided shape.'}
  </p>

  <div class="screen-actions">
    <button onclick={onCancel}>Cancel</button>
    <button class="btn-primary" onclick={onConfirm} disabled={!valid}>Process</button>
  </div>
</section>

<style>
  .crop {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: #111;
  }

  .stage {
    position: relative;
    flex: 1 1 auto;
    overflow: hidden;
    touch-action: none;
  }

  canvas {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  .overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .overlay polygon {
    fill: rgb(59 130 246 / 8%);
    stroke: var(--accent);
    stroke-width: 2;
  }

  .overlay.invalid polygon {
    fill: rgb(239 68 68 / 10%);
    stroke: var(--err);
  }

  .handle {
    position: absolute;
    width: 34px;
    height: 34px;
    margin: -17px 0 0 -17px;
    padding: 0;
    border-radius: 50%;
    background: rgb(59 130 246 / 25%);
    border: 2px solid var(--accent);
    box-shadow: 0 0 0 6px rgb(59 130 246 / 12%);
    touch-action: none;
    z-index: 5;
  }

  .handle::after {
    content: '';
    position: absolute;
    inset: 11px;
    background: var(--accent);
    border-radius: 50%;
  }

  .tip {
    margin: 0;
    padding: 10px 16px 0;
    font-size: 12px;
    color: var(--muted);
    text-align: center;
    background: var(--panel);
  }

  .tip.warn {
    color: var(--err);
  }
</style>
