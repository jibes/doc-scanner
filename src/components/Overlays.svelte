<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { fade, fly } from 'svelte/transition';
  import { dismissInstall, install, promptInstall } from '../lib/onboarding.svelte';
  import { dismissToast, ui } from '../lib/ui.svelte';
  import { applyUpdate, dismissUpdate, update } from '../lib/update.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    /** The screen on show: the install offer belongs to the document. */
    screen: string;
  }

  let { screen }: Props = $props();

  const showUpdate = $derived((update.ready || update.applied) && !ui.busy);
  // One notice at a time: the update wins.
  const showInstall = $derived(
    screen === 'document' && install.offer !== null && !ui.busy && !showUpdate,
  );

  const enter = { y: 8, duration: 200, easing: cubicOut };
  const leave = { duration: 150 };
</script>

{#if ui.busy}
  <div class="busy" role="status" aria-live="polite" transition:fade={{ duration: 150 }}>
    <div class="busy-card">
      <div class="spinner"></div>
      <div class="busy-label">{ui.busy.label}</div>
      {#if ui.busy.progress !== null}
        <div class="line"><div style:width="{Math.round(ui.busy.progress * 100)}%"></div></div>
      {/if}
      {#if ui.busy.action}
        {@const action = ui.busy.action}
        <button class="ghost" onclick={() => action.run()}>{action.label}</button>
      {/if}
    </div>
  </div>
{/if}

<!--
  Every notification in one stack, just above the current screen's bottom
  controls: notices on top, then the latest message, then running work.
-->
<div class="stack" style:--dock="{ui.dock}px">
  {#if showUpdate}
    <div class="note" role="status" aria-live="polite" in:fly={enter} out:fade={leave}>
      <span class="message"
        >{update.applied ? 'Updated in another window' : 'New version ready'}</span
      >
      <button class="act" onclick={() => void applyUpdate()}>Reload</button>
      <button class="close" onclick={dismissUpdate} aria-label="Later">
        <Icon name="close" size={18} />
      </button>
    </div>
  {:else if showInstall}
    <div class="note" role="status" in:fly={enter} out:fade={leave}>
      {#if install.offer === 'prompt'}
        <span class="message">Install the app to use it offline</span>
        <button class="act" onclick={() => void promptInstall()}>Install</button>
      {:else}
        <span class="message">Install: tap <b>Share</b>, then <b>Add to Home Screen</b></span>
      {/if}
      <button class="close" onclick={dismissInstall} aria-label="Not now">
        <Icon name="close" size={18} />
      </button>
    </div>
  {/if}

  {#if ui.toast}
    {#key ui.toast.key}
      <div
        class="note {ui.toast.kind}"
        role={ui.toast.kind === 'err' ? 'alert' : 'status'}
        aria-live={ui.toast.kind === 'err' ? 'assertive' : 'polite'}
        in:fly={enter}
        out:fade={leave}
      >
        {#if ui.toast.kind !== 'info'}
          <span class="mark" aria-hidden="true">
            <Icon name={ui.toast.kind === 'good' ? 'check' : 'alert'} size={18} />
          </span>
        {/if}
        <span class="message">{ui.toast.message}</span>
        {#if ui.toast.action}
          {@const action = ui.toast.action}
          <button
            class="act"
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
  {/if}

  {#if ui.task}
    {@const task = ui.task}
    <!-- An export or upload in progress: compact, so the app stays usable. -->
    <div class="note task" role="status" aria-live="polite" in:fly={enter} out:fade={leave}>
      <span class="message">{task.label}</span>
      {#if task.action}
        {@const action = task.action}
        <button class="act" onclick={() => action.run()}>{action.label}</button>
      {/if}
      {#if task.cancel}
        {@const cancel = task.cancel}
        <button class="act quiet" onclick={() => cancel()}>Cancel</button>
      {/if}
      <div
        class="track"
        class:indeterminate={task.progress === null}
        role="progressbar"
        aria-label={task.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={task.progress === null ? undefined : Math.round(task.progress * 100)}
      >
        <div
          style:width={task.progress === null ? '30%' : `${Math.round(task.progress * 100)}%`}
        ></div>
      </div>
    </div>
  {/if}
</div>

<style>
  .stack {
    position: fixed;
    left: 0;
    right: 0;
    bottom: calc(max(var(--dock), var(--safe-bottom)) + var(--s-3));
    z-index: 60;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-2);
    padding: 0 var(--s-4);
    pointer-events: none;
    transition: bottom var(--dur-2) var(--ease);
  }

  .note {
    pointer-events: auto;
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--s-1);
    width: 100%;
    max-width: 440px;
    min-height: 48px;
    padding: var(--s-1) var(--s-1) var(--s-1) var(--s-4);
    border-radius: var(--r-l);
    background: var(--toast-bg);
    color: var(--toast-fg);
    box-shadow: var(--shadow-2);
    font-size: var(--fs-caption);
    line-height: 1.35;
    overflow: hidden;
  }

  .message {
    flex: 1;
    min-width: 0;
    padding: var(--s-2) var(--s-2) var(--s-2) 0;
  }

  .mark {
    display: flex;
    margin-right: var(--s-2);
  }

  .good .mark {
    color: var(--toast-good);
  }

  .err .mark {
    color: var(--toast-err);
  }

  .act {
    flex: 0 0 auto;
    min-height: 40px;
    padding: 0 var(--s-3);
    border-radius: var(--r-m);
    background: transparent;
    color: var(--toast-accent);
    font-size: var(--fs-caption);
    font-weight: 650;
  }

  .act.quiet {
    color: var(--toast-fg-2);
  }

  @media (hover: hover) {
    .act:hover:not(:disabled),
    .close:hover:not(:disabled) {
      background: color-mix(in srgb, var(--toast-fg) 10%, transparent);
    }
  }

  .close {
    flex: 0 0 auto;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--r-m);
    background: transparent;
    color: var(--toast-fg-2);
  }

  /* Progress: a hairline along the card's bottom edge. */
  .track {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: color-mix(in srgb, var(--toast-fg) 12%, transparent);
  }

  .track > div {
    height: 100%;
    background: var(--toast-accent);
    transition: width var(--dur-3) var(--ease);
  }

  .track.indeterminate > div {
    animation: slide 1.2s var(--ease) infinite;
  }

  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }

  .busy {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--s-6);
    background: var(--scrim);
  }

  .busy-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-3);
    width: min(320px, 100%);
    padding: var(--s-6);
    border-radius: var(--r-xl);
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-3);
  }

  .busy-card .spinner {
    color: var(--accent-text);
  }

  .busy-label {
    font-size: var(--fs-body);
    text-align: center;
  }

  .line {
    width: 100%;
    height: 2px;
    border-radius: 1px;
    background: var(--fill);
    overflow: hidden;
  }

  .line > div {
    height: 100%;
    background: var(--accent);
    transition: width var(--dur-3) var(--ease);
  }
</style>
