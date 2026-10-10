<script lang="ts">
  import { ui } from '../lib/ui.svelte';
</script>

{#if ui.busy}
  <div class="busy">
    <div class="spinner"></div>
    <div class="label">{ui.busyLabel}</div>
  </div>
{/if}
