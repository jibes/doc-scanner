<script lang="ts">
  import { fade, fly } from 'svelte/transition';
  import { dismissToast, ui } from '../lib/ui.svelte';
  import { applyUpdate, dismissUpdate, update } from '../lib/update.svelte';
</script>

{#if ui.busy}
  <div class="busy" role="status" aria-live="polite" transition:fade={{ duration: 150 }}>
    <div class="spinner"></div>
    <div class="label">{ui.busy.label}</div>
    {#if ui.busy.progress !== null}
      <div class="bar"><div style="width: {Math.round(ui.busy.progress * 100)}%"></div></div>
    {/if}
    {#if ui.busy.action}
      {@const action = ui.busy.action}
      <button class="action" onclick={() => action.run()}>{action.label}</button>
    {/if}
  </div>
{/if}

{#if (update.ready || update.applied) && !ui.busy}
  <div class="update" role="status" aria-live="polite" transition:fly={{ y: -12, duration: 180 }}>
    <span
      >{update.applied ? 'Updated in another window' : 'New version ready'}</span
    >
    <button class="update-reload" onclick={() => void applyUpdate()}>Reload</button>
    <button class="update-later" onclick={dismissUpdate} aria-label="Later">×</button>
  </div>
{/if}

{#if ui.toast}
  <div class="toast-slot">
    {#key ui.toast.key}
      <div
        class="toast {ui.toast.kind}"
        role="status"
        aria-live="polite"
        in:fly={{ y: 12, duration: 180 }}
        out:fade={{ duration: 120 }}
      >
        <span>{ui.toast.message}</span>
        {#if ui.toast.action}
          {@const action = ui.toast.action}
          <button
            class="toast-action"
            onclick={() => {
              action.run();
              dismissToast();
            }}
          >
            {action.label}
          </button>
        {/if}
      </div>
    {/key}
  </div>
{/if}

<style>
  .update {
    position: fixed;
    /* Below the screens' top bars, so it never covers their buttons. */
    top: calc(68px + env(safe-area-inset-top, 0px));
    left: 12px;
    right: 12px;
    margin: 0 auto;
    width: fit-content;
    max-width: calc(100% - 24px);
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 10px;
    white-space: nowrap;
    padding: 8px 8px 8px 16px;
    border-radius: 999px;
    background: var(--panel-3);
    color: var(--text);
    box-shadow: 0 6px 24px rgb(0 0 0 / 35%);
    font-size: 14px;
  }

  .update-reload {
    padding: 6px 14px;
    border-radius: 999px;
    border: none;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  .update-later {
    padding: 4px 10px;
    border: none;
    background: transparent;
    color: var(--muted);
    font-size: 18px;
  }

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
    color: #fff;
  }

  .label {
    font-size: 14px;
    text-align: center;
    max-width: 30ch;
  }

  .bar {
    width: 220px;
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

  .action {
    margin-top: 6px;
    background: rgb(255 255 255 / 12%);
    border-color: rgb(255 255 255 / 25%);
    color: #fff;
    font-size: 13px;
  }

  .toast-slot {
    position: fixed;
    left: 0;
    right: 0;
    bottom: calc(96px + var(--safe-bottom));
    z-index: 60;
    display: flex;
    justify-content: center;
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 12px;
    width: max-content;
    max-width: min(92vw, 480px);
    padding: 10px 10px 10px 16px;
    border-radius: 12px;
    background: var(--panel-3);
    color: var(--text);
    border: 1px solid var(--border);
    box-shadow: 0 8px 30px rgb(0 0 0 / 35%);
    font-size: 14px;
  }

  .toast.good {
    border-color: rgb(34 197 94 / 50%);
  }

  .toast.err {
    border-color: rgb(239 68 68 / 60%);
  }

  .toast-action {
    flex: 0 0 auto;
    padding: 6px 12px;
    font-weight: 600;
    color: var(--accent);
    background: transparent;
    border-color: transparent;
  }
</style>
