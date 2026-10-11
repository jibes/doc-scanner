<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';
  import { dismissTips, install } from '../lib/onboarding.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    /** The screen on show: the tips belong to the camera. */
    screen: string;
  }

  let { screen }: Props = $props();

  const showTips = $derived(screen === 'camera' && !install.tipsSeen);
</script>

{#if showTips}
  <aside
    class="tips"
    aria-labelledby="tips-title"
    transition:fly={{ y: 8, duration: 200, easing: cubicOut }}
  >
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

<style>
  .tips {
    position: fixed;
    /* Below the camera's top buttons, above the shutter. */
    top: calc(72px + var(--safe-top));
    left: var(--s-4);
    right: var(--s-4);
    margin: 0 auto;
    max-width: 360px;
    z-index: 30;
    padding: var(--s-5);
    border-radius: var(--r-xl);
    background: rgb(28 28 27 / 88%);
    color: #f4f3ef;
    backdrop-filter: blur(20px) saturate(1.4);
    -webkit-backdrop-filter: blur(20px) saturate(1.4);
    box-shadow:
      0 24px 60px rgb(0 0 0 / 45%),
      0 0 0 1px rgb(255 255 255 / 8%);
  }

  h2 {
    margin: 0 0 var(--s-4);
    font-size: var(--fs-large);
    font-weight: 650;
  }

  ul {
    list-style: none;
    margin: 0 0 var(--s-5);
    padding: 0;
    display: grid;
    gap: var(--s-3);
  }

  li {
    display: flex;
    gap: var(--s-3);
    align-items: flex-start;
    font-size: var(--fs-body);
    line-height: 1.4;
    color: #d9d8d3;
  }

  li b {
    color: #fff;
    font-weight: 600;
  }

  li :global(svg) {
    margin-top: -1px;
    color: #8eb1ff;
  }

  .tips .primary {
    width: 100%;
    min-height: 48px;
  }
</style>
