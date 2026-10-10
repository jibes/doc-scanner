<script lang="ts">
  import { DEFAULT_ADJUSTMENTS, type Adjustments, type FilterId } from '../lib/imaging/filters';
  import { isBlurred } from '../lib/imaging/sharpness';
  import { session, type Page } from '../lib/store/session.svelte';
  import { FILTERS } from '../lib/filters';
  import { haptic } from '../lib/haptics';
  import { toast } from '../lib/ui.svelte';
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
    const neighbour = session.pages[index + 1] ?? session.pages[index - 1];
    const undo = session.remove(page.id);
    haptic('tick');
    toast('Page deleted.', 'info', { label: 'Undo', run: undo });
    if (neighbour) onOpen(neighbour.id);
    else onBack();
  }

  // Other pages that would change if this page's look were applied to all.
  const differing = $derived(
    session.pages.filter(
      (p) =>
        p.spec.filter !== filter ||
        (Object.keys(adj) as (keyof Adjustments)[]).some((k) => p.spec.adjustments[k] !== adj[k]),
    ).length,
  );

  function applyToAll() {
    session.applyToAll({ filter, adjustments: adj });
    haptic('tick');
    toast(`Applied to all ${session.pages.length} pages.`, 'good');
  }

  /* Swipe between pages. */
  let swipe = $state<{ id: number; x: number; y: number } | null>(null);
  let dragX = $state(0);

  function swipeStart(event: PointerEvent) {
    if (swipe || (event.target as Element).closest('button')) return;
    swipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function swipeMove(event: PointerEvent) {
    if (swipe?.id !== event.pointerId) return;
    const dx = event.clientX - swipe.x;
    const dy = event.clientY - swipe.y;
    // Resist at the ends of the document.
    const blocked = (dx > 0 && index <= 0) || (dx < 0 && index >= session.pages.length - 1);
    dragX = Math.abs(dx) > Math.abs(dy) ? (blocked ? dx * 0.2 : dx) : 0;
  }

  function swipeEnd(event: PointerEvent) {
    if (swipe?.id !== event.pointerId) return;
    const width = (event.currentTarget as HTMLElement).clientWidth;
    const step = Math.abs(dragX) > Math.min(90, width * 0.22) ? -Math.sign(dragX) : 0;
    swipe = null;
    dragX = 0;
    const next = session.pages[index + step];
    if (step && next) {
      haptic('tick');
      onOpen(next.id);
    }
  }

  function keydown(event: KeyboardEvent) {
    if ((event.target as Element).closest('input, textarea')) return;
    if (event.key === 'ArrowLeft' && index > 0) onOpen(session.pages[index - 1].id);
    if (event.key === 'ArrowRight' && index < session.pages.length - 1)
      onOpen(session.pages[index + 1].id);
  }

  const SLIDERS: { key: keyof Adjustments; label: string; min: number; max: number }[] = [
    { key: 'brightness', label: 'Whiteness', min: -1, max: 1 },
    { key: 'contrast', label: 'Ink depth', min: -1, max: 1 },
    { key: 'threshold', label: 'Text weight', min: -1, max: 1 },
    { key: 'sharpen', label: 'Sharpen', min: 0, max: 1 },
  ];
</script>

<svelte:window onkeydown={keydown} />

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

  <div
    class="viewport"
    role="group"
    aria-label="Page preview; swipe to change page"
    onpointerdown={swipeStart}
    onpointermove={swipeMove}
    onpointerup={swipeEnd}
    onpointercancel={swipeEnd}
  >
    <div class="slide" class:dragging={swipe !== null} style="transform: translateX({dragX}px)">
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
    </div>
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

    {#if session.pages.length > 1 && differing > 0}
      <button class="apply-all" onclick={applyToAll}>
        Apply this filter and adjustments to all pages
      </button>
    {/if}

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

  .viewport {
    touch-action: none;
    overflow: hidden;
  }

  .slide {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.2s ease;
  }

  .slide.dragging {
    transition: none;
  }

  .apply-all {
    align-self: center;
    padding: 6px 12px;
    font-size: 13px;
    color: var(--accent);
    background: transparent;
    border-color: transparent;
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
    color: #fff;
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
