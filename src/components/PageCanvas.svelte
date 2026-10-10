<script lang="ts">
  import { processor } from '../lib/services';
  import type { Page } from '../lib/store/session.svelte';

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

  $effect(() => {
    const target = canvas;
    if (!target) return;
    const job = {
      pageId: page.id,
      source: page.source,
      spec: $state.snapshot(page.spec),
      longEdge,
    };
    const raw = unfiltered;
    let stale = false;
    onrendering?.(true);
    processor()
      .latest(channel, () => (raw ? processor().rectified(job) : processor().render(job)))
      .then((bitmap) => {
        if (!bitmap) return;
        if (stale) {
          bitmap.close();
          return;
        }
        target.width = bitmap.width;
        target.height = bitmap.height;
        target.getContext('2d')?.drawImage(bitmap, 0, 0);
        bitmap.close();
        drawn = true;
        failed = false;
        onrendering?.(false);
      })
      .catch(() => {
        if (stale) return;
        failed = true;
        onrendering?.(false);
      });
    return () => {
      stale = true;
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
