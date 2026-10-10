<script lang="ts">
  import { getRender, putRender, renderKey } from '../lib/renderCache';
  import { processor, renderJob } from '../lib/services';
  import type { Page } from '../lib/store/session.svelte';
  import { AbortedError } from '../lib/worker/clients';

  interface Props {
    page: Page;
    /** Long edge of the render, in pixels. */
    longEdge: number;
    /** Coalescing channel: renders on the same channel replace each other. */
    channel: string;
    /** Show the rectified page without the filter. */
    unfiltered?: boolean;
    class?: string;
    onrendering?: (rendering: boolean) => void;
  }

  let {
    page,
    longEdge,
    channel,
    unfiltered = false,
    class: className = '',
    onrendering,
  }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let failed = $state(false);
  let drawn = $state(false);

  function draw(target: HTMLCanvasElement, bitmap: ImageBitmap) {
    target.width = bitmap.width;
    target.height = bitmap.height;
    target.getContext('2d')?.drawImage(bitmap, 0, 0);
    drawn = true;
    failed = false;
  }

  $effect(() => {
    const target = canvas;
    if (!target) return;
    const snapshot: Page = { ...page, spec: $state.snapshot(page.spec) };
    const key = renderKey(snapshot, longEdge, unfiltered);
    const cached = getRender(key);
    if (cached) {
      draw(target, cached);
      onrendering?.(false);
      return;
    }

    const job = renderJob(snapshot, longEdge);
    const raw = unfiltered;
    const controller = new AbortController();
    let stale = false;
    onrendering?.(true);
    processor()
      .latest(channel, () =>
        raw
          ? processor().rectified(job, controller.signal)
          : processor().render(job, controller.signal),
      )
      .then((bitmap) => {
        if (!bitmap) return;
        putRender(key, bitmap);
        if (stale) return;
        draw(target, bitmap);
        onrendering?.(false);
      })
      .catch((error) => {
        if (stale || error instanceof AbortedError) return;
        failed = true;
        onrendering?.(false);
      });
    return () => {
      stale = true;
      // A render nobody will see should not hold up the ones that will.
      controller.abort();
    };
  });
</script>

<canvas bind:this={canvas} class={className} class:failed class:pending={!drawn && !failed}
></canvas>

<style>
  canvas {
    display: block;
    background: #fff;
  }

  canvas.pending {
    visibility: hidden;
  }

  canvas.failed {
    background: repeating-linear-gradient(45deg, #2a1515, #2a1515 8px, #1d1010 8px, #1d1010 16px);
  }
</style>
