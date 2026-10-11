<script lang="ts">
  import { onMount } from 'svelte';
  import { DragFilter } from '../lib/dragFilter';
  import type { Point, Quad } from '../lib/imaging/image';
  import { fullQuad, isConvex } from '../lib/imaging/quad';
  import { session, type Page } from '../lib/store/session.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    page: Page;
    onDone: () => void;
  }

  let { page, onDone }: Props = $props();

  const DISPLAY_EDGE = 2048;
  const LOUPE = 128;
  const ZOOM = 3;
  const HIT = 40;

  let stage = $state<HTMLDivElement | null>(null);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let loupe = $state<HTMLCanvasElement | null>(null);
  let bitmap = $state.raw<ImageBitmap | null>(null);
  let size = $state({ width: 0, height: 0 });
  // svelte-ignore state_referenced_locally
  let quad = $state.raw<Quad>(page.spec.quad);
  let dragging = $state<{ kind: 'corner' | 'edge'; index: number } | null>(null);
  let focus = $state<Point | null>(null);

  const valid = $derived(isConvex(quad));

  onMount(() => {
    let cancelled = false;
    void (async () => {
      const probe = await createImageBitmap(page.source, { imageOrientation: 'from-image' });
      const scale = Math.min(1, DISPLAY_EDGE / Math.max(probe.width, probe.height));
      let display = probe;
      if (scale < 1) {
        display = await createImageBitmap(page.source, {
          imageOrientation: 'from-image',
          resizeWidth: Math.round(probe.width * scale),
          resizeHeight: Math.round(probe.height * scale),
          resizeQuality: 'high',
        });
        probe.close();
      }
      if (cancelled) display.close();
      else bitmap = display;
    })();

    const observer = new ResizeObserver(([entry]) => {
      size = { width: entry.contentRect.width, height: entry.contentRect.height };
    });
    if (stage) observer.observe(stage);
    return () => {
      cancelled = true;
      observer.disconnect();
      bitmap?.close();
    };
  });

  /** Where the source image sits in the stage (object-fit: contain, with a margin for handles). */
  const layout = $derived.by(() => {
    const margin = 22;
    const cw = size.width - margin * 2;
    const ch = size.height - margin * 2;
    if (cw <= 0 || ch <= 0) return null;
    const scale = Math.min(cw / page.width, ch / page.height);
    const w = page.width * scale;
    const h = page.height * scale;
    return { scale, x: margin + (cw - w) / 2, y: margin + (ch - h) / 2, w, h };
  });

  $effect(() => {
    if (!canvas || !bitmap || !layout) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, layout.x, layout.y, layout.w, layout.h);
  });

  const toScreen = (p: Point): Point =>
    layout ? [layout.x + p[0] * layout.scale, layout.y + p[1] * layout.scale] : [0, 0];

  const screenQuad = $derived(quad.map(toScreen));
  const midpoints = $derived(
    screenQuad.map((p, i) => {
      const q = screenQuad[(i + 1) % 4];
      return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as Point;
    }),
  );

  function local(event: PointerEvent): Point {
    const rect = stage!.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  function toImage(p: Point): Point {
    if (!layout) return [0, 0];
    return [
      Math.min(page.width, Math.max(0, (p[0] - layout.x) / layout.scale)),
      Math.min(page.height, Math.max(0, (p[1] - layout.y) / layout.scale)),
    ];
  }

  /** Filters the finger: relative, finer after a rest, steady on lift. */
  const filter = new DragFilter();
  /** The filtered pointer and the quad when the drag began. */
  let grab: { pointer: Point; quad: Quad } | null = null;
  /** Fine movement is on: the loupe shows it. */
  let fine = $state(false);

  function clamp(p: Point): Point {
    return [Math.min(page.width, Math.max(0, p[0])), Math.min(page.height, Math.max(0, p[1]))];
  }

  function down(event: PointerEvent) {
    const p = local(event);
    let best: { kind: 'corner' | 'edge'; index: number; d: number } | null = null;
    screenQuad.forEach((c, i) => {
      const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
      if (d < HIT && (!best || d < best.d)) best = { kind: 'corner', index: i, d };
    });
    if (!best) {
      midpoints.forEach((m, i) => {
        const d = Math.hypot(m[0] - p[0], m[1] - p[1]);
        if (d < HIT && (!best || d < best.d)) best = { kind: 'edge', index: i, d };
      });
    }
    if (!best) return;
    const hit: { kind: 'corner' | 'edge'; index: number } = best;
    event.preventDefault();
    stage!.setPointerCapture(event.pointerId);
    dragging = { kind: hit.kind, index: hit.index };
    // The handle moves with the finger from where it is: it never jumps to it.
    grab = { pointer: filter.start(p, event.timeStamp), quad };
    fine = false;
    focus = hit.kind === 'corner' ? quad[hit.index] : toImage(midpoints[hit.index]);
  }

  /** Move the dragged handle by the filtered pointer's travel since touch-down. */
  function place(pointer: Point) {
    if (!dragging || !grab || !layout) return;
    const dx = (pointer[0] - grab.pointer[0]) / layout.scale;
    const dy = (pointer[1] - grab.pointer[1]) / layout.scale;
    const next = [...grab.quad] as Point[];
    const i = dragging.index;
    if (dragging.kind === 'corner') {
      next[i] = clamp([grab.quad[i][0] + dx, grab.quad[i][1] + dy]);
      focus = next[i];
    } else {
      // Move the edge along its normal, keeping its direction.
      const j = (i + 1) % 4;
      const a = grab.quad[i];
      const b = grab.quad[j];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / len;
      const ny = (b[0] - a[0]) / len;
      const d = dx * nx + dy * ny;
      next[i] = clamp([a[0] + nx * d, a[1] + ny * d]);
      next[j] = clamp([b[0] + nx * d, b[1] + ny * d]);
      focus = [(next[i][0] + next[j][0]) / 2, (next[i][1] + next[j][1]) / 2];
    }
    quad = next as unknown as Quad;
  }

  function move(event: PointerEvent) {
    if (!dragging) return;
    // Every sample the browser merged into this event, for an exact history.
    const merged = event.getCoalescedEvents?.() ?? [];
    let pointer: Point | null = null;
    for (const e of merged.length ? merged : [event]) {
      pointer = filter.move(local(e), e.timeStamp);
    }
    if (pointer) place(pointer);
    fine = filter.fine;
  }

  function up(event: PointerEvent) {
    // Lifting the finger nudges the point; the filter takes that back.
    if (dragging && event.type === 'pointerup') place(filter.end(local(event), event.timeStamp));
    dragging = null;
    grab = null;
    focus = null;
    fine = false;
  }

  /** The loupe sits in the top corner away from the finger. */
  const loupeLeft = $derived(focus && layout ? toScreen(focus)[0] > size.width / 2 : false);

  $effect(() => {
    if (!loupe || !focus || !bitmap) return;
    const ctx = loupe.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    loupe.width = LOUPE * dpr;
    loupe.height = LOUPE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Source pixels covered by the loupe.
    const scaleToBitmap = bitmap.width / page.width;
    const span = LOUPE / ZOOM / (layout?.scale ?? 1);
    const sx = (focus[0] - span / 2) * scaleToBitmap;
    const sy = (focus[1] - span / 2) * scaleToBitmap;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, LOUPE, LOUPE);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, span * scaleToBitmap, span * scaleToBitmap, 0, 0, LOUPE, LOUPE);
    ctx.strokeStyle = '#4f8cff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(LOUPE / 2, LOUPE / 2 - 14);
    ctx.lineTo(LOUPE / 2, LOUPE / 2 + 14);
    ctx.moveTo(LOUPE / 2 - 14, LOUPE / 2);
    ctx.lineTo(LOUPE / 2 + 14, LOUPE / 2);
    ctx.stroke();
  });

  function apply() {
    if (!valid) return;
    session.update(page.id, { quad });
    onDone();
  }
</script>

<section class="screen crop">
  <header class="topbar">
    <button class="icon ghost" onclick={onDone} aria-label="Cancel"><Icon name="close" /></button>
    <div class="title">Adjust crop</div>
    <button class="primary" onclick={apply} disabled={!valid}>Done</button>
  </header>

  <div
    class="stage"
    bind:this={stage}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onlostpointercapture={up}
    role="application"
    aria-label="Drag the corners or edges onto the page"
  >
    <canvas bind:this={canvas}></canvas>
    <svg class="overlay" viewBox="0 0 {size.width} {size.height}" aria-hidden="true">
      <defs>
        <mask id="outside">
          <rect width="100%" height="100%" fill="white" />
          <polygon points={screenQuad.map((p) => p.join(',')).join(' ')} fill="black" />
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="rgb(0 0 0 / 50%)" mask="url(#outside)" />
      <polygon
        class="edge"
        class:invalid={!valid}
        points={screenQuad.map((p) => p.join(',')).join(' ')}
      />
      {#each midpoints as m, i (i)}
        <rect
          class="mid"
          x={m[0] - 14}
          y={m[1] - 4}
          width="28"
          height="8"
          rx="4"
          transform="rotate({(Math.atan2(
            screenQuad[(i + 1) % 4][1] - screenQuad[i][1],
            screenQuad[(i + 1) % 4][0] - screenQuad[i][0],
          ) *
            180) /
            Math.PI} {m[0]} {m[1]})"
        />
      {/each}
      {#each screenQuad as c, i (i)}
        <circle class="corner" cx={c[0]} cy={c[1]} r="11" />
      {/each}
    </svg>
    {#if focus}
      <canvas class="loupe" class:left={loupeLeft} class:fine bind:this={loupe}></canvas>
    {/if}
  </div>

  <div class="bottombar">
    <button
      class="icon"
      onclick={() => page.detected && (quad = page.detected)}
      disabled={!page.detected}
    >
      <Icon name="magic" /> Detected
    </button>
    <button class="icon" onclick={() => (quad = fullQuad(page.width, page.height))}>
      <Icon name="expand" /> Full photo
    </button>
    {#if !valid}<span class="warn">Corners cross over</span>{/if}
  </div>
</section>

<style>
  .stage {
    position: relative;
    flex: 1;
    overflow: hidden;
    touch-action: none;
    background: #000;
  }

  .stage > canvas:first-child {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  .overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .edge {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
  }

  .edge.invalid {
    stroke: var(--err);
  }

  .corner {
    fill: rgb(79 140 255 / 25%);
    stroke: #fff;
    stroke-width: 2.5;
  }

  .mid {
    fill: #fff;
    stroke: rgb(0 0 0 / 40%);
  }

  .loupe {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 128px;
    height: 128px;
    border-radius: 50%;
    border: 3px solid #fff;
    box-shadow: 0 4px 18px rgb(0 0 0 / 50%);
    pointer-events: none;
  }

  .loupe.left {
    right: auto;
    left: 12px;
  }

  /* Fine movement: the finger rested, the corner now moves at half speed. */
  .loupe.fine {
    border-color: var(--accent);
  }

  .warn {
    align-self: center;
    color: var(--err);
    font-size: 13px;
  }
</style>
