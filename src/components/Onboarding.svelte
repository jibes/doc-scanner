<script lang="ts">
  import { fly } from 'svelte/transition';
  import { dismissInstall, dismissTips, install, promptInstall } from '../lib/onboarding.svelte';
  import { ui } from '../lib/ui.svelte';
  import { update } from '../lib/update.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    /** The screen on show: tips belong to the camera, the install offer to the document. */
    screen: string;
  }

  let { screen }: Props = $props();

  const showTips = $derived(screen === 'camera' && !install.tipsSeen);
  // One banner at a time: the update notice wins.
  const showInstall = $derived(
    screen === 'document' && install.offer !== null && !ui.busy && !update.ready && !update.applied,
  );
</script>

{#if showTips}
  <aside class="tips" aria-labelledby="tips-title" transition:fly={{ y: -12, duration: 180 }}>
    <h2 id="tips-title">Quick tips</h2>
    <ul>
      <li>
        <Icon name="scan" />
        <span
          >Hold the phone steady over a page. With <b>Auto</b> on, it takes the photo itself.</span
        >
      </li>
      <li>
        <Icon name="gallery" />
        <span>In the document, press and hold a page to move it.</span>
      </li>
      <li>
        <Icon name="eye" />
        <span>Pinch a page to zoom in; hold the eye to compare with the photo.</span>
      </li>
    </ul>
    <button class="primary" onclick={dismissTips}>Got it</button>
  </aside>
{/if}

{#if showInstall}
  <div class="install" role="status" transition:fly={{ y: 12, duration: 180 }}>
    {#if install.offer === 'prompt'}
      <span>Use it like an app, offline too</span>
      <button class="install-go" onclick={() => void promptInstall()}>
        <Icon name="download" /> Install
      </button>
    {:else}
      <span>Install: tap <b>Share</b>, then <b>Add to Home Screen</b></span>
    {/if}
    <button class="install-later" onclick={dismissInstall} aria-label="Not now">
      <Icon name="close" />
    </button>
  </div>
{/if}

<style>
  .tips {
    position: fixed;
    /* Below the camera's top buttons, above the shutter. */
    top: calc(68px + var(--safe-top));
    left: 16px;
    right: 16px;
    margin: 0 auto;
    max-width: 360px;
    z-index: 30;
    padding: 16px 16px 14px;
    border-radius: var(--radius);
    background: rgb(21 21 23 / 92%);
    border: 1px solid rgb(255 255 255 / 12%);
    color: #f1f1f3;
    backdrop-filter: blur(12px);
    box-shadow: 0 8px 28px rgb(0 0 0 / 45%);
  }

  .tips :global(svg),
  .install :global(svg) {
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  h2 {
    margin: 0 0 10px;
    font-size: 15px;
  }

  ul {
    list-style: none;
    margin: 0 0 14px;
    padding: 0;
    display: grid;
    gap: 10px;
  }

  li {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    font-size: 14px;
    line-height: 1.35;
  }

  li :global(svg) {
    width: 20px;
    height: 20px;
    margin-top: 1px;
    color: #4f8cff;
  }

  .tips .primary {
    width: 100%;
  }

  .install {
    position: fixed;
    /* Just above the document's bottom bar (12 + 50 + 12 px), clear of the
       filter chips and of the update notice at the top. */
    bottom: calc(86px + var(--safe-bottom));
    left: 12px;
    right: 12px;
    margin: 0 auto;
    width: fit-content;
    max-width: calc(100% - 24px);
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 6px 6px 16px;
    border-radius: 999px;
    background: var(--panel-3);
    color: var(--text);
    box-shadow: 0 6px 24px rgb(0 0 0 / 35%);
    font-size: 14px;
  }

  .install span {
    min-width: 0;
  }

  .install-go {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 999px;
    border: none;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }

  .install-go :global(svg),
  .install-later :global(svg) {
    width: 18px;
    height: 18px;
  }

  .install-later {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border-radius: 999px;
    border: none;
    background: transparent;
    color: var(--muted);
  }
</style>
