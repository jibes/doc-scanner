<script lang="ts">
  import { flip } from 'svelte/animate';
  import { defaultTitle, exportPdf, pdfFilename, saveFile } from '../lib/export';
  import { FILTERS } from '../lib/filters';
  import { haptic } from '../lib/haptics';
  import { recordHistory, updateHistory } from '../lib/history';
  import type { FilterId } from '../lib/imaging/filters';
  import { isBlurred } from '../lib/imaging/sharpness';
  import { isConfigured, uploadDocument, waitForTask } from '../lib/paperless';
  import type { AppSettings } from '../lib/settings';
  import { session } from '../lib/store/session.svelte';
  import { busy, errorMessage, idle, toast } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';
  import PageCanvas from './PageCanvas.svelte';

  interface Props {
    settings: AppSettings;
    onCamera: () => void;
    onOpen: (id: string) => void;
    onSettings: () => void;
    onHistory: () => void;
  }

  let { settings, onCamera, onOpen, onSettings, onHistory }: Props = $props();

  const placeholder = defaultTitle();
  const title = $derived(session.title.trim() || placeholder);

  const commonFilter = $derived.by(() => {
    const first = session.pages[0]?.spec.filter;
    return session.pages.every((p) => p.spec.filter === first) ? first : null;
  });

  function applyToAll(filter: FilterId, label: string) {
    if (commonFilter === filter) return;
    const undo = session.applyToAll({ filter });
    haptic('tick');
    toast(`${label} on all pages.`, 'info', { label: 'Undo', run: undo });
  }

  /* ----------------------------------------------------------- export ---- */

  async function build(searchable: boolean): Promise<Blob> {
    let skip: () => void = () => {};
    const skipText = new Promise<void>((resolve) => (skip = resolve));
    return exportPdf(
      session.pages,
      settings,
      title,
      (done, total) =>
        busy(
          done < total ? `Preparing page ${done + 1} of ${total}…` : 'Building PDF…',
          done / total,
        ),
      {
        searchable: searchable && settings.ocr,
        skipText,
        onReading: (page, total) =>
          busy(`Reading the text on page ${page + 1} of ${total}…`, page / total, {
            label: 'Save without text',
            run: skip,
          }),
      },
    );
  }

  function offerNewDocument(message: string) {
    // Starting over deletes the pages, so it asks first, like Discard.
    toast(message, 'good', { label: 'New document', run: discard });
  }

  /**
   * Hand the PDF over. The share sheet needs a recent tap, and building the
   * PDF usually outlasts the one on "PDF"; the browser then refuses, and a
   * "Share" button offers a fresh tap instead of silently downloading.
   */
  async function deliver(pdf: Blob, name: string, docTitle: string, pages: number, retry = false) {
    // A second refusal, despite the fresh tap, falls back to a download.
    const how = await saveFile(pdf, name, { deferShare: !retry });
    if (how === 'needs-tap') {
      toast('Your PDF is ready.', 'good', {
        label: 'Share',
        run: () => void deliver(pdf, name, docTitle, pages, true).catch(shareFailed),
      });
      return;
    }
    // Closing the share sheet sends nothing anywhere.
    if (how === 'cancelled') return;
    haptic('success');
    void recordHistory({ title: docTitle, kind: 'pdf', pages, bytes: pdf.size, pdf });
    offerNewDocument(
      how === 'downloaded' ? `Saved ${name} (${(pdf.size / 1024).toFixed(0)} KB)` : 'Shared.',
    );
  }

  function shareFailed(error: unknown) {
    haptic('error');
    toast(`Could not share the PDF: ${errorMessage(error)}`, 'err');
  }

  async function save() {
    try {
      // Saved and shared PDFs carry the OCR text layer.
      const pdf = await build(true);
      idle();
      await deliver(pdf, pdfFilename(title), title, session.pages.length);
    } catch (error) {
      haptic('error');
      toast(`Could not create the PDF: ${errorMessage(error)}`, 'err');
    } finally {
      idle();
    }
  }

  async function upload() {
    if (!isConfigured(settings.paperless)) {
      toast('Add your Paperless URL and API token first.', 'info');
      onSettings();
      return;
    }
    try {
      // Paperless runs its own OCR on upload, so the PDF stays image-only.
      const pdf = await build(false);
      busy('Uploading to Paperless…');
      const task = await uploadDocument(settings.paperless, pdf, pdfFilename(title), title);
      const entry = await recordHistory({
        title,
        kind: 'upload',
        pages: session.pages.length,
        bytes: pdf.size,
        pdf,
        outcome: 'pending',
        taskId: task,
      });
      busy('Paperless is processing it…');
      let result: Awaited<ReturnType<typeof waitForTask>>;
      try {
        result = await waitForTask(settings.paperless, task);
      } catch (error) {
        // The file is in Paperless; only its status could not be read. The
        // entry stays pending and History checks again later.
        haptic('success');
        offerNewDocument(`Uploaded, but its status could not be checked: ${errorMessage(error)}`);
        return;
      }
      idle();
      void updateHistory({ ...entry, outcome: result.outcome });
      if (result.outcome === 'failure') {
        haptic('error');
        toast(`Paperless rejected it: ${result.message ?? 'unknown error'}`, 'err');
        return;
      }
      haptic('success');
      offerNewDocument(
        result.duplicate
          ? 'Already in Paperless.'
          : result.outcome === 'success'
            ? 'Filed in Paperless.'
            : 'Uploaded; Paperless is still processing.',
      );
    } catch (error) {
      haptic('error');
      toast(`Upload failed: ${errorMessage(error)}`, 'err');
    } finally {
      idle();
    }
  }

  function discard() {
    if (confirm(`Discard all ${session.pages.length} pages?`)) session.clear();
  }

  /* ---------------------------------------------- drag-and-drop order ---- */

  const LONG_PRESS_MS = 300;
  const SLOP = 8;

  let grid = $state<HTMLDivElement | null>(null);
  let dragId = $state<string | null>(null);
  let dragOffset = $state({ x: 0, y: 0 });
  let press: {
    id: string;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
    pointerId: number;
    target: HTMLElement;
  } | null = null;
  let suppressClick = false;

  function pointerDown(event: PointerEvent, id: string) {
    if (event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    const { clientX: x, clientY: y, pointerId } = event;
    press = {
      id,
      x,
      y,
      pointerId,
      target,
      timer: setTimeout(() => {
        if (!press) return;
        dragId = press.id;
        dragOffset = { x: 0, y: 0 };
        suppressClick = true;
        haptic('tick');
        try {
          press.target.setPointerCapture(press.pointerId);
        } catch {
          // The pointer may already be gone.
        }
      }, LONG_PRESS_MS),
    };
  }

  function pointerMove(event: PointerEvent) {
    if (!press) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (!dragId) {
      // Moving before the long press completes is a scroll, not a drag.
      if (Math.hypot(dx, dy) > SLOP) cancelPress();
      return;
    }
    dragOffset = { x: dx, y: dy };
    const over = tileAt(event.clientX, event.clientY);
    if (over !== null) {
      const from = session.pages.findIndex((p) => p.id === dragId);
      if (over !== from) {
        session.moveTo(dragId, over);
        // The tile jumped to its new slot; keep it under the finger.
        press.x = event.clientX;
        press.y = event.clientY;
        dragOffset = { x: 0, y: 0 };
        haptic('tick');
      }
    }
  }

  function pointerUp() {
    cancelPress();
    // The click that follows a drag must not open the page.
    setTimeout(() => (suppressClick = false), 0);
  }

  function cancelPress() {
    if (press) clearTimeout(press.timer);
    press = null;
    dragId = null;
    dragOffset = { x: 0, y: 0 };
  }

  function tileAt(x: number, y: number): number | null {
    const tiles = grid?.querySelectorAll<HTMLElement>('[data-page-index]') ?? [];
    for (const tile of tiles) {
      const r = tile.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return Number(tile.dataset.pageIndex);
      }
    }
    return null;
  }

  // While dragging, the page must not scroll under the finger.
  $effect(() => {
    const el = grid;
    if (!el) return;
    const block = (e: TouchEvent) => {
      if (dragId) e.preventDefault();
    };
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  });
</script>

<section class="screen document">
  <header class="topbar">
    <input
      class="title-input"
      value={session.title}
      {placeholder}
      oninput={(e) => session.setTitle(e.currentTarget.value)}
      aria-label="Document title"
      enterkeyhint="done"
    />
    <button class="icon ghost" onclick={onHistory} aria-label="History">
      <Icon name="history" />
    </button>
    <button class="icon ghost" onclick={onSettings} aria-label="Settings">
      <Icon name="settings" />
    </button>
  </header>

  {#if session.pages.length === 0}
    <div class="empty">
      <div class="empty-art" aria-hidden="true"><Icon name="scan" /></div>
      <h2>Scan a document</h2>
      <p>
        Point the camera at a page. Edges are found automatically and the photo is taken when you
        hold still. Add as many pages as you need, then save a PDF or send it to Paperless.
      </p>
      <button class="primary big" onclick={onCamera}><Icon name="retake" /> Start scanning</button>
    </div>
  {:else}
    <div class="filters">
      <span>All pages</span>
      <div class="chips">
        {#each FILTERS as f (f.id)}
          <button
            class="chip"
            class:active={commonFilter === f.id}
            onclick={() => applyToAll(f.id, f.label)}
          >
            {f.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="grid" bind:this={grid}>
      {#each session.pages as page, i (page.id)}
        <button
          class="tile"
          class:dragging={dragId === page.id}
          data-page-index={i}
          style:transform={dragId === page.id
            ? `translate(${dragOffset.x}px, ${dragOffset.y}px) scale(1.05)`
            : undefined}
          animate:flip={{ duration: 180 }}
          onclick={() => !suppressClick && onOpen(page.id)}
          onpointerdown={(e) => pointerDown(e, page.id)}
          onpointermove={pointerMove}
          onpointerup={pointerUp}
          onpointercancel={cancelPress}
          oncontextmenu={(e) => e.preventDefault()}
          aria-label="Page {i + 1}. Tap to edit, press and hold to move."
        >
          <div class="frame">
            <PageCanvas {page} longEdge={520} channel="thumb-{page.id}" class="thumb" />
          </div>
          <span class="number">
            {i + 1}
            {#if isBlurred(page)}<span class="blurred">· blurred</span>{/if}
          </span>
        </button>
      {/each}
      <button class="tile add" onclick={onCamera} aria-label="Add pages">
        <div class="frame"><Icon name="plus" /></div>
        <span class="number">Add</span>
      </button>
    </div>
    {#if session.pages.length > 1}
      <p class="hint">Press and hold a page to move it.</p>
    {/if}
  {/if}

  <div class="bottombar">
    <button
      class="icon"
      onclick={discard}
      disabled={!session.pages.length}
      aria-label="Discard document"
    >
      <Icon name="trash" />
    </button>
    <button class="icon grow" onclick={() => void save()} disabled={!session.pages.length}>
      <Icon name="share" /> PDF
    </button>
    <button
      class="icon primary grow"
      onclick={() => void upload()}
      disabled={!session.pages.length}
    >
      <Icon name="upload" /> Upload
    </button>
  </div>
</section>

<style>
  .title-input {
    flex: 1;
    min-width: 0;
    font: inherit;
    font-weight: 600;
    font-size: 17px;
    color: var(--text);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 10px;
    padding: 8px 10px;
  }

  .title-input:focus {
    background: var(--panel-2);
    border-color: var(--border);
    outline: none;
  }

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 32px;
    text-align: center;
    color: var(--muted);
  }

  .empty h2 {
    margin: 0;
    color: var(--text);
    font-size: 20px;
  }

  .empty p {
    margin: 0 0 8px;
    max-width: 36ch;
    line-height: 1.5;
  }

  .empty-art {
    width: 88px;
    height: 88px;
    border-radius: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--panel-2);
    color: var(--accent);
  }

  .empty-art :global(svg) {
    width: 44px;
    height: 44px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
  }

  .primary.big {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    padding: 14px 22px;
    font-size: 16px;
  }

  .primary.big :global(svg) {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }

  .filters {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
  }

  .filters > span {
    flex: 0 0 auto;
  }

  .grid {
    flex: 1;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 16px;
    padding: 16px;
    align-content: start;
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    padding: 0;
    background: none;
    border: none;
    touch-action: pan-y;
    -webkit-touch-callout: none;
    position: relative;
  }

  .tile.dragging {
    z-index: 5;
    transition: none;
  }

  .tile.dragging .frame {
    box-shadow: 0 12px 30px rgb(0 0 0 / 45%);
    outline: 2px solid var(--accent);
  }

  .frame {
    width: 100%;
    aspect-ratio: 3 / 4;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--panel);
    border-radius: 8px;
    overflow: hidden;
  }

  .frame :global(.thumb) {
    max-width: 100%;
    max-height: 100%;
    box-shadow: 0 2px 10px rgb(0 0 0 / 25%);
    pointer-events: none;
  }

  .add .frame {
    border: 2px dashed var(--border);
    background: transparent;
    color: var(--muted);
  }

  .add :global(svg) {
    width: 32px;
    height: 32px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
  }

  .number {
    font-size: 12px;
    color: var(--muted);
  }

  .blurred {
    color: var(--warn);
    font-weight: 600;
  }

  .hint {
    margin: 0;
    padding: 0 16px 8px;
    font-size: 12px;
    color: var(--muted);
    text-align: center;
  }
</style>
