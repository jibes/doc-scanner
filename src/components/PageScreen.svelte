<script lang="ts">
  import { DEFAULT_ADJUSTMENTS, type Adjustments, type FilterId } from '../lib/imaging/filters';
  import { isBlurred } from '../lib/imaging/sharpness';
  import { session, type Page } from '../lib/store/session.svelte';
  import { FILTERS } from '../lib/filters';
  import Icon from './Icon.svelte';
  import PageCanvas from './PageCanvas.svelte';

  interface Props {
    page: Page;
    onBack: () => void;
    onCrop: () => void;
    onRetake: () => void;
    onOpen: (id: string) => void;
  }

  let { page, onBack, onCrop, onRetake, onOpen }: Props = $props();

  const PREVIEW_EDGE = 1600;

  let comparing = $state(false);
  let rendering = $state(false);
  let showAdjust = $state(false);

  const index = $derived(session.pages.findIndex((p) => p.id === page.id));
  const filter = $derived(page.spec.filter);
  const adj = $derived(page.spec.adjustments);
  const usesThreshold = $derived(filter === 'document' || filter === 'bw');

  function setFilter(id: FilterId) {
    session.update(page.id, { filter: id });
  }

  function setAdjustment(key: keyof Adjustments, value: number) {
    session.update(page.id, { adjustments: { ...adj, [key]: value } });
  }

  function rotate() {
    session.update(page.id, { rotation: (page.spec.rotation + 1) % 4 });
  }

  function remove() {
    if (!confirm('Delete this page?')) return;
    const neighbour = session.pages[index + 1] ?? session.pages[index - 1];
    session.remove(page.id);
    if (neighbour) onOpen(neighbour.id);
    else onBack();
  }

  const SLIDERS: { key: keyof Adjustments; label: string; min: number; max: number }[] = [
    { key: 'brightness', label: 'Whiteness', min: -1, max: 1 },
    { key: 'contrast', label: 'Ink depth', min: -1, max: 1 },
    { key: 'threshold', label: 'Text weight', min: -1, max: 1 },
    { key: 'sharpen', label: 'Sharpen', min: 0, max: 1 },
  ];
</script>

<section class="screen page">
  <header class="topbar">
    <button class="icon ghost" onclick={onBack} aria-label="Back to document"
      ><Icon name="back" /></button
    >
    <div class="title">Page {index + 1} of {session.pages.length}</div>
    <button
      class="icon ghost"
      onclick={() => onOpen(session.pages[index - 1].id)}
      disabled={index <= 0}
      aria-label="Previous page"
    >
      <Icon name="left" />
    </button>
    <button
      class="icon ghost"
      onclick={() => onOpen(session.pages[index + 1].id)}
      disabled={index >= session.pages.length - 1}
      aria-label="Next page"
    >
      <Icon name="right" />
    </button>
  </header>

  {#if isBlurred(page)}
    <div class="blur-banner" role="status">
      <span>This photo is blurred; text may come out broken.</span>
      <button onclick={onRetake}>Retake</button>
    </div>
  {/if}

  <div class="viewport">
    {#key page.id}
      <PageCanvas
        {page}
        longEdge={PREVIEW_EDGE}
        channel="page-preview"
        class="preview {comparing ? 'hidden' : ''}"
        onrendering={(r) => (rendering = r)}
      />
      {#if comparing}
        <PageCanvas
          {page}
          longEdge={PREVIEW_EDGE}
          channel="page-original"
          unfiltered
          class="preview"
        />
      {/if}
    {/key}
    {#if rendering}<div class="working"><div class="spinner"></div></div>{/if}
    <button
      class="compare"
      onpointerdown={() => (comparing = true)}
      onpointerup={() => (comparing = false)}
      onpointerleave={() => (comparing = false)}
      onpointercancel={() => (comparing = false)}
      aria-label="Hold to show the unfiltered page"
    >
      <Icon name="eye" />
    </button>
  </div>

  <div class="panel">
    <div class="chips" role="radiogroup" aria-label="Filter">
      {#each FILTERS as f (f.id)}
        <button
          class="chip"
          class:active={filter === f.id}
          role="radio"
          aria-checked={filter === f.id}
          onclick={() => setFilter(f.id)}
          title={f.hint}
        >
          {f.label}
        </button>
      {/each}
    </div>

    {#if showAdjust}
      <div class="sliders">
        {#each SLIDERS as s (s.key)}
          {#if s.key !== 'threshold' || usesThreshold}
            <label class="slider">
              <span>{s.label}</span>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step="0.05"
                value={adj[s.key]}
                oninput={(e) => setAdjustment(s.key, Number(e.currentTarget.value))}
              />
              <output>{adj[s.key] > 0 && s.min < 0 ? '+' : ''}{Math.round(adj[s.key] * 100)}</output
              >
            </label>
          {/if}
        {/each}
        <button
          class="reset"
          onclick={() => session.update(page.id, { adjustments: { ...DEFAULT_ADJUSTMENTS } })}
        >
          Reset adjustments
        </button>
      </div>
    {/if}

    <div class="tools">
      <button class="icon" onclick={() => (showAdjust = !showAdjust)} aria-pressed={showAdjust}>
        <Icon name="sliders" /><span>Adjust</span>
      </button>
      <button class="icon" onclick={onCrop}><Icon name="crop" /><span>Crop</span></button>
      <button class="icon" onclick={rotate}><Icon name="rotate" /><span>Rotate</span></button>
      <button class="icon" onclick={onRetake}><Icon name="retake" /><span>Retake</span></button>
      <button
        class="icon"
        onclick={() => session.move(page.id, -1)}
        disabled={index <= 0}
        aria-label="Move page earlier"
      >
        <Icon name="left" />
      </button>
      <button
        class="icon"
        onclick={() => session.move(page.id, 1)}
        disabled={index >= session.pages.length - 1}
        aria-label="Move page later"
      >
        <Icon name="right" />
      </button>
      <button class="icon danger" onclick={remove} aria-label="Delete page"
        ><Icon name="trash" /></button
      >
    </div>
  </div>
</section>

<style>
  .blur-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    background: rgb(245 158 11 / 15%);
    border-bottom: 1px solid rgb(245 158 11 / 40%);
    color: var(--warn);
    font-size: 13px;
  }

  .blur-banner button {
    padding: 6px 12px;
    font-size: 13px;
  }

  .viewport {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 14px;
    background: #050506;
  }

  .viewport :global(.preview) {
    max-width: 100%;
    max-height: 100%;
    box-shadow: 0 6px 30px rgb(0 0 0 / 60%);
  }

  .viewport :global(.preview.hidden) {
    display: none;
  }

  .working {
    position: absolute;
    top: 18px;
    left: 18px;
  }

  .working .spinner {
    width: 22px;
    height: 22px;
    border-width: 2.5px;
  }

  .compare {
    position: absolute;
    right: 16px;
    bottom: 16px;
    border-radius: 999px;
    padding: 10px;
    background: rgb(0 0 0 / 55%);
    backdrop-filter: blur(8px);
    touch-action: none;
  }

  .compare :global(svg) {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.9;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 12px calc(12px + var(--safe-bottom));
    background: var(--panel);
    border-top: 1px solid var(--border);
  }

  .sliders {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 4px 4px 0;
  }

  .reset {
    align-self: flex-end;
    font-size: 13px;
    padding: 6px 12px;
  }

  .tools {
    display: flex;
    justify-content: space-between;
    gap: 4px;
  }

  .tools .icon {
    flex-direction: column;
    gap: 2px;
    font-size: 11px;
    padding: 6px 4px;
    min-width: 0;
    flex: 1;
    background: transparent;
    border-color: transparent;
  }

  .tools .icon[aria-pressed='true'] {
    color: var(--accent);
  }

  .danger {
    color: var(--err);
  }
</style>
