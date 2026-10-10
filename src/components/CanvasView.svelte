<script lang="ts">
  import { drawImageToCanvas } from '../lib/canvas';
  import type { RGBAImage } from '../lib/imaging/types';

  interface Props {
    image: RGBAImage | null;
    class?: string;
  }

  let { image, class: className = '' }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);

  $effect(() => {
    if (!canvas || !image) return;
    drawImageToCanvas(canvas, image);
  });
</script>

<canvas bind:this={canvas} class={className}></canvas>
