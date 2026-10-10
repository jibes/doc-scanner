<script lang="ts">
  import { ui } from '../lib/ui.svelte';
</script>

{#if ui.busy}
  <div class="busy" role="status" aria-live="polite">
    <div class="spinner"></div>
    <div class="label">{ui.busy.label}</div>
    {#if ui.busy.progress !== null}
      <div class="bar"><div style="width: {Math.round(ui.busy.progress * 100)}%"></div></div>
    {/if}
  </div>
{/if}

{#if ui.toast}
  {#key ui.toast.key}
    <div class="toast {ui.toast.kind}" role="status" aria-live="polite">{ui.toast.message}</div>
  {/key}
{/if}

<style>
  .busy {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    background: rgb(0 0 0 / 70%);
    backdrop-filter: blur(6px);
  }

  .label {
    font-size: 14px;
  }

  .bar {
    width: 200px;
    height: 4px;
    border-radius: 2px;
    background: rgb(255 255 255 / 15%);
    overflow: hidden;
  }

  .bar > div {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(96px + var(--safe-bottom));
    transform: translateX(-50%);
    z-index: 60;
    max-width: min(92vw, 460px);
    padding: 11px 16px;
    border-radius: 12px;
    background: var(--panel-3);
    border: 1px solid var(--border);
    box-shadow: 0 8px 30px rgb(0 0 0 / 45%);
    font-size: 14px;
    animation: rise 0.18s ease-out;
  }

  .toast.good {
    border-color: rgb(34 197 94 / 50%);
  }

  .toast.err {
    border-color: rgb(239 68 68 / 60%);
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translate(-50%, 8px);
    }
  }
</style>
