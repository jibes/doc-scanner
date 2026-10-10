<script lang="ts">
  import { ui } from '../lib/ui.svelte';
</script>

<div
  class="toast {ui.toastKind} {ui.toastVisible ? 'visible' : ''}"
  role="status"
  aria-live="polite"
>
  {ui.toastMessage}
</div>
