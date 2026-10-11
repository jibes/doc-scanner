<script lang="ts">
  import { tick } from 'svelte';
  import { flip } from 'svelte/animate';
  import { SvelteSet } from 'svelte/reactivity';
  import { canShareFiles, defaultTitle, exportPdf, pdfFilename, saveFile } from '../lib/export';
  import { readText } from '../lib/exportCache';
  import {
    phaseOf,
    phaseProgress,
    readiness,
    readsTextInBackground,
    type ExportPhase,
  } from '../lib/exportStatus.svelte';
  import { FILTERS } from '../lib/filters';
  import { haptic } from '../lib/haptics';
  import { recordHistory, updateHistory } from '../lib/history';
  import type { FilterId } from '../lib/imaging/filters';
  import { isBlurred } from '../lib/imaging/sharpness';
  import { isConfigured, waitForTask } from '../lib/paperless';
  import { uploadWithSelection } from '../lib/paperlessMeta';
  import { pickUploadMeta } from '../lib/paperlessSheet';
  import { queueStatus } from '../lib/queueStatus.svelte';
  import { queueUpload, shouldQueue } from '../lib/uploadQueue';
  import type { AppSettings } from '../lib/settings';
  import { pageThumbnail } from '../lib/services';
  import { session, type Page } from '../lib/store/session.svelte';
  import { suggestTitle } from '../lib/titleSuggest';
  import {
    dock,
    endTask,
    errorMessage,
    isAbort,
    startTask,
    toast,
    ui,
    updateTask,
    type Task,
  } from '../lib/ui.svelte';
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
  /** Phones offer both: the share sheet ("open with") and a plain download. */
  const sharing = canShareFiles();
  const title = $derived(session.title.trim() || placeholder);

  function plural(n: number, one = 'page', many = 'pages') {
    return `${n} ${n === 1 ? one : many}`;
  }

  /* ---------------------------------------------------------- selection ---- */

  let selecting = $state(false);
  const selected = new SvelteSet<string>();
  /** The selected pages that still exist, in document order. */
  const selection = $derived(session.pages.filter((p) => selected.has(p.id)).map((p) => p.id));

  function startSelecting() {
    selected.clear();
    selecting = true;
    haptic('tick');
  }

  function stopSelecting() {
    selecting = false;
    selected.clear();
  }

  function toggle(id: string) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    haptic('tick');
  }

  function selectAll() {
    if (selection.length === session.pages.length) selected.clear();
    else for (const p of session.pages) selected.add(p.id);
  }

  $effect(() => {
    if (selecting && session.pages.length === 0) stopSelecting();
  });

  function rotateSelected() {
    const ids = selection;
    const undo = session.updateMany(ids, (spec) => ({ rotation: (spec.rotation + 1) % 4 }));
    haptic('tick');
    toast(`Rotated ${plural(ids.length)}.`, 'info', { label: 'Undo', run: undo });
  }

  function moveSelected(where: 'start' | 'end') {
    const ids = selection;
    const undo = session.moveMany(ids, where);
    haptic('tick');
    toast(`Moved ${plural(ids.length)} to the ${where}.`, 'info', { label: 'Undo', run: undo });
  }

  function deleteSelected() {
    const ids = selection;
    const undo = session.removeMany(ids);
    haptic('tick');
    stopSelecting();
    toast(`Deleted ${plural(ids.length)}.`, 'info', { label: 'Undo', run: undo });
  }

  /* -------------------------------------------------------------- filter ---- */

  /** Pages the filter row applies to: the selection while selecting, else all. */
  const filterPages = $derived(
    selecting ? session.pages.filter((p) => selected.has(p.id)) : session.pages,
  );

  const commonFilter = $derived.by(() => {
    const first = filterPages[0]?.spec.filter;
    return filterPages.every((p) => p.spec.filter === first) ? first : null;
  });

  function applyToAll(filter: FilterId, label: string) {
    if (commonFilter === filter || filterPages.length === 0) return;
    haptic('tick');
    if (selecting) {
      const ids = selection;
      const undo = session.updateMany(ids, () => ({ filter }));
      toast(`${label} on ${plural(ids.length)}.`, 'info', { label: 'Undo', run: undo });
      return;
    }
    const undo = session.applyToAll({ filter });
    toast(`${label} on all pages.`, 'info', { label: 'Undo', run: undo });
  }

  /* --------------------------------------------------- export readiness ---- */

  /** Whether a PDF's text is read in the background (else it is read when saving). */
  const backgroundText = $derived(settings.ocr && readsTextInBackground());
  const pdfState = $derived(readiness(session.pages, settings, settings.ocr));
  const uploadState = $derived(readiness(session.pages, settings, false));

  interface Badge {
    /** Shown after the button's name: a percentage, "ready", or nothing. */
    text: string;
    /** Fills the button's underline, 0 to 1. */
    progress: number;
  }

  function percent(progress: number): Badge {
    return { text: progress > 0 ? `${Math.round(progress * 100)}%` : '', progress };
  }

  /**
   * What the PDF / Paperless button says besides its name: its export's
   * progress while one runs, "ready" once every page is prepared, else how
   * far the background preparation has got.
   */
  function badge(kind: Task['kind']): Badge {
    if (ui.task?.kind === kind) {
      return ui.task.progress === null ? { text: '…', progress: 0 } : percent(ui.task.progress);
    }
    if (ui.task || session.pages.length === 0) return { text: '', progress: 0 };
    const state = kind === 'pdf' ? pdfState : uploadState;
    if (state.ready) return { text: 'ready', progress: 1 };
    // Text not read in the background is read when saving: show only the
    // renders' progress, and no "ready".
    if (kind === 'pdf' && settings.ocr && !backgroundText) {
      return uploadState.ready ? { text: '', progress: 0 } : percent(uploadState.progress);
    }
    return percent(state.progress);
  }

  const pdfBadge = $derived(badge('pdf'));
  const uploadBadge = $derived(badge('upload'));

  const PHASE_LABEL: Record<ExportPhase, string> = {
    queued: 'not prepared yet',
    rendering: 'being prepared',
    rendered: 'prepared',
    reading: 'reading its text',
    read: 'prepared',
  };

  function tileState(page: Page) {
    const phase = phaseOf(page, settings);
    // With OCR on, a page is only ready once its text is read too: a page
    // rendered without it is rendered again (with text) when saving.
    const progress = phaseProgress(phase, settings.ocr);
    return {
      progress,
      busy: phase === 'rendering' || phase === 'reading',
      label: progress >= 1 ? 'ready to export' : PHASE_LABEL[phase],
    };
  }

  /* ---------------------------------------------------- suggested title ---- */

  let suggested = $state<{ pageId: string; text: string } | null>(null);
  let dismissed = $state<string | null>(null);
  const first = $derived(session.pages[0]);
  const firstRead = $derived(!!first && settings.ocr && phaseOf(first, settings) === 'read');

  // Once page 1's text has been read (by the background preparation; this
  // never starts OCR), its most prominent line near the top is suggested.
  $effect(() => {
    if (!first || !firstRead) return;
    const page = first;
    const reading = readText(page, settings);
    if (!reading) return;
    let live = true;
    void reading.then(({ words, height }) => {
      if (!live) return;
      const text = suggestTitle(words, height);
      suggested = text ? { pageId: page.id, text } : null;
    });
    return () => (live = false);
  });

  /** Offered only while the title is empty: a typed title is never replaced. */
  const offered = $derived(
    suggested &&
      suggested.pageId === first?.id &&
      !session.title.trim() &&
      suggested.text !== dismissed
      ? suggested.text
      : null,
  );

  function useSuggestion(text: string) {
    session.setTitle(text);
    haptic('tick');
  }

  /* ----------------------------------------------------------- export ---- */

  /**
   * What an export covers: the whole document, or (split) the selected
   * pages, which leave the document once they are saved or uploaded.
   */
  interface Target {
    /** The pages to export; null for the whole document. */
    ids: ReadonlySet<string> | null;
    title: () => string;
  }

  const wholeDocument: Target = { ids: null, title: () => title };

  function pagesOf(target: Target): Page[] {
    const { ids } = target;
    return ids ? session.pages.filter((p) => ids.has(p.id)) : session.pages;
  }

  /**
   * Start an export, unless one is running: one at a time, so they do not
   * compete for the workers. The app stays usable meanwhile; the progress
   * shows in a bar (Overlays) with Cancel.
   */
  function begin(kind: Task['kind']): AbortController | null {
    const controller = new AbortController();
    const started = startTask({
      kind,
      label: 'Preparing…',
      progress: 0,
      cancel: () => controller.abort(),
    });
    if (started) return controller;
    toast('Wait for the current export to finish.', 'info');
    return null;
  }

  async function build(
    searchable: boolean,
    target: Target,
    controller: AbortController,
    current: AppSettings,
  ): Promise<Blob> {
    let skip: () => void = () => {};
    const skipText = new Promise<void>((resolve) => (skip = resolve));
    // Pages edited while it runs are done again (exportPdf follows the
    // document); discarding or replacing the document cancels it.
    const document = session.document;
    return exportPdf(
      pagesOf(target),
      current,
      target.title,
      (done, total) =>
        updateTask({
          label: done < total ? `Preparing page ${done + 1} of ${total}…` : 'Building PDF…',
          progress: done / total,
          action: undefined,
        }),
      {
        searchable: searchable && current.ocr,
        skipText,
        signal: controller.signal,
        latest: () => (session.document === document ? pagesOf(target) : []),
        onReading: (page, total) =>
          updateTask({
            label: `Reading the text on page ${page + 1} of ${total}…`,
            progress: (page + 0.5) / total,
            action: { label: 'Save without text', run: skip },
          }),
      },
    );
  }

  function offerNewDocument(message: string) {
    // Starting over deletes the pages, so it asks first, like Discard.
    toast(message, 'good', { label: 'New document', run: discard });
  }

  /** A document is out: offer a new one, or take split-off pages out of this one. */
  function finished(target: Target, message: string) {
    if (!target.ids) {
      offerNewDocument(message);
      return;
    }
    const n = pagesOf(target).length;
    const undo = session.removeMany(target.ids);
    toast(`${message} ${plural(n)} split off.`, 'good', { label: 'Undo', run: undo });
  }

  /**
   * Hand the PDF over. The share sheet needs a recent tap, and building the
   * PDF usually outlasts the one on "PDF"; the browser then refuses, and a
   * "Share" button offers a fresh tap instead of silently downloading.
   */
  async function deliver(
    pdf: Blob,
    name: string,
    docTitle: string,
    pages: Page[],
    target: Target,
    {
      retry = false,
      download = false,
      thumb,
    }: { retry?: boolean; download?: boolean; thumb?: Blob } = {},
  ) {
    // A second refusal, despite the fresh tap, falls back to a download.
    const how = await saveFile(pdf, name, { deferShare: !retry, download });
    if (how === 'needs-tap') {
      toast('Your PDF is ready.', 'good', {
        label: download ? 'Download' : 'Share',
        run: () =>
          void deliver(pdf, name, docTitle, pages, target, {
            retry: true,
            download,
            thumb,
          }).catch(shareFailed),
      });
      return;
    }
    // Closing the share sheet sends nothing anywhere.
    if (how === 'cancelled') return;
    haptic('success');
    recordHistory(
      { title: docTitle, kind: 'pdf', pages: pages.length, bytes: pdf.size, pdf, thumb },
      pages,
    );
    finished(
      target,
      how === 'downloaded' ? `Saved ${name} (${(pdf.size / 1024).toFixed(0)} KB).` : 'Shared.',
    );
  }

  function shareFailed(error: unknown) {
    haptic('error');
    toast(`Could not share the PDF: ${errorMessage(error)}`, 'err');
  }

  async function save(download = false, target: Target = wholeDocument) {
    const controller = begin('pdf');
    if (!controller) return;
    try {
      // Saved and shared PDFs carry the OCR text layer.
      const pdf = await build(true, target, controller, $state.snapshot(settings));
      const pages = pagesOf(target);
      const docTitle = target.title();
      const thumb = await pageThumbnail(pages[0]);
      endTask();
      await deliver(pdf, pdfFilename(docTitle), docTitle, pages, target, { download, thumb });
    } catch (error) {
      if (isAbort(error)) {
        toast('Export cancelled.', 'info');
        return;
      }
      haptic('error');
      toast(`Could not create the PDF: ${errorMessage(error)}`, 'err');
    } finally {
      endTask();
    }
  }

  async function upload(target: Target = wholeDocument) {
    if (!isConfigured(settings.paperless)) {
      toast('Add your Paperless URL and API token first.', 'info');
      onSettings();
      return;
    }
    const current = $state.snapshot(settings);
    // Tags, document type and correspondent for this upload; the defaults
    // from the settings come preselected.
    const selection = await pickUploadMeta(current.paperless, target.title());
    if (!selection) return;
    const controller = begin('upload');
    if (!controller) return;
    try {
      // Paperless runs its own OCR on upload, so the PDF stays image-only.
      const pdf = await build(false, target, controller, current);
      const pages = pagesOf(target);
      const docTitle = target.title();
      const thumb = await pageThumbnail(pages[0]);
      // Once on its way, it can no longer be called back.
      updateTask({ label: 'Uploading to Paperless…', progress: null, cancel: undefined });
      let task: string;
      try {
        const sent = await uploadWithSelection(
          current.paperless,
          pdf,
          pdfFilename(docTitle),
          docTitle,
          selection,
        );
        task = sent.taskId;
        if (sent.missing.length > 0) {
          toast(`Not found in Paperless, left out: ${sent.missing.join(', ')}`, 'info');
        }
      } catch (error) {
        if (!shouldQueue(error)) throw error;
        // Paperless cannot be reached: keep it and send it once it can.
        await queueUpload({
          title: docTitle,
          pages: pages.length,
          pdf,
          filename: pdfFilename(docTitle),
          selection,
          thumb,
          error,
        });
        haptic('success');
        finished(target, 'Paperless is unreachable; it will be sent when it is back.');
        return;
      }
      const entry = recordHistory(
        {
          title: docTitle,
          kind: 'upload',
          pages: pages.length,
          bytes: pdf.size,
          pdf,
          outcome: 'pending',
          taskId: task,
          thumb,
        },
        pages,
      );
      updateTask({ label: 'Paperless is processing it…' });
      let result: Awaited<ReturnType<typeof waitForTask>>;
      try {
        result = await waitForTask(current.paperless, task);
      } catch (error) {
        // The file is in Paperless; only its status could not be read. The
        // entry stays pending and History checks again later.
        haptic('success');
        finished(target, `Uploaded, but its status could not be checked: ${errorMessage(error)}`);
        return;
      }
      endTask();
      void updateHistory({ ...entry, outcome: result.outcome }, { onlyIfPresent: true });
      if (result.outcome === 'failure') {
        haptic('error');
        toast(`Paperless rejected it: ${result.message ?? 'unknown error'}`, 'err');
        return;
      }
      haptic('success');
      finished(
        target,
        result.duplicate
          ? 'Already in Paperless.'
          : result.outcome === 'success'
            ? 'Filed in Paperless.'
            : 'Uploaded; Paperless is still processing.',
      );
    } catch (error) {
      if (isAbort(error)) {
        toast('Upload cancelled.', 'info');
        return;
      }
      haptic('error');
      toast(`Upload failed: ${errorMessage(error)}`, 'err');
    } finally {
      endTask();
    }
  }

  function discard() {
    const n = session.pages.length;
    // History keeps its own copy of every PDF saved or uploaded; this only
    // drops the pages being worked on.
    if (
      confirm(
        `Discard the ${n} scanned ${n === 1 ? 'page' : 'pages'}? PDFs you saved or sent to Paperless stay in History.`,
      )
    )
      session.clear();
  }

  /* -------------------------------------------------------------- split ---- */

  let splitDialog = $state<HTMLDialogElement | null>(null);
  let splitTitle = $state('');
  let splitIds = $state.raw<string[]>([]);
  let splitPlaceholder = $state('');

  function openSplit() {
    if (selection.length === 0 || selection.length === session.pages.length) return;
    splitIds = selection;
    splitTitle = '';
    splitPlaceholder = `${title} – part 2`;
    splitDialog?.showModal();
  }

  /** Export the selected pages as a document of their own; they leave this one once it is out. */
  function split(how: 'share' | 'download' | 'upload') {
    splitDialog?.close();
    const name = splitTitle.trim() || splitPlaceholder;
    const target: Target = { ids: new Set(splitIds), title: () => name };
    stopSelecting();
    if (how === 'upload') void upload(target);
    else void save(how === 'download', target);
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
  /** Where in the dragged tile the finger holds it, so the tile stays put under it. */
  let grab = { x: 0, y: 0 };
  /** A reorder is being laid out; the next move waits for it. */
  let moving = false;
  let suppressClick = false;

  /**
   * A tile's place in the grid as laid out, in viewport pixels: from its
   * offsets, so neither the dragged tile's transform nor the other tiles'
   * slide animations move it.
   */
  function slot(tile: HTMLElement): { x: number; y: number; w: number; h: number } {
    const g = grid!.getBoundingClientRect();
    return {
      x: g.left + tile.offsetLeft - grid!.scrollLeft,
      y: g.top + tile.offsetTop - grid!.scrollTop,
      w: tile.offsetWidth,
      h: tile.offsetHeight,
    };
  }

  function tileOf(id: string): HTMLElement | null {
    return grid?.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(id)}"]`) ?? null;
  }

  function pointerDown(event: PointerEvent, id: string) {
    // While selecting, a tap toggles a page and nothing is dragged.
    if (event.button !== 0 || selecting) return;
    const target = event.currentTarget as HTMLElement;
    const { clientX: x, clientY: y, pointerId } = event;
    press = {
      id,
      x,
      y,
      pointerId,
      target,
      timer: setTimeout(() => {
        if (!press || !grid) return;
        const at = slot(press.target);
        grab = { x: press.x - at.x, y: press.y - at.y };
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

  /** Keep the dragged tile exactly where the finger holds it, wherever its slot now is. */
  function follow(x: number, y: number) {
    const tile = dragId ? tileOf(dragId) : null;
    if (!tile) return;
    const at = slot(tile);
    dragOffset = { x: x - grab.x - at.x, y: y - grab.y - at.y };
  }

  async function pointerMove(event: PointerEvent) {
    if (!press) return;
    const { clientX: x, clientY: y } = event;
    if (!dragId) {
      // Moving before the long press completes is a scroll, not a drag.
      if (Math.hypot(x - press.x, y - press.y) > SLOP) cancelPress();
      return;
    }
    follow(x, y);
    if (moving) return;
    const id = dragId;
    const over = tileAt(x, y, id);
    const from = session.pages.findIndex((p) => p.id === id);
    if (over === null || over === from) return;
    moving = true;
    session.moveTo(id, over);
    haptic('tick');
    // The tile now has a new slot: re-anchor it to the finger there.
    await tick();
    moving = false;
    if (dragId === id) follow(x, y);
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

  /**
   * The slot of the page under the finger, other than the dragged one. Slots
   * are taken as laid out, and only their middle counts, so a finger near the
   * border between two pages does not swap them to and fro.
   */
  function tileAt(x: number, y: number, dragged: string): number | null {
    const tiles = grid?.querySelectorAll<HTMLElement>('[data-page-index]') ?? [];
    for (const tile of tiles) {
      if (tile.dataset.pageId === dragged) continue;
      const r = slot(tile);
      const mx = r.w * 0.2;
      const my = r.h * 0.2;
      if (x >= r.x + mx && x <= r.x + r.w - mx && y >= r.y + my && y <= r.y + r.h - my) {
        return Number(tile.dataset.pageIndex);
      }
    }
    return null;
  }

  function tap(id: string) {
    if (suppressClick) return;
    if (selecting) toggle(id);
    else onOpen(id);
  }

  /*
   * The suggestion sits in the title's subtitle line, which keeps its height,
   * so it never moves the grid. Which page is first changes while a page is
   * dragged across the first place; the offer waits for the drop.
   */
  let suggestion = $state<string | null>(null);
  $effect(() => {
    const next = offered;
    if (!dragId) suggestion = next;
  });

  /* Hairlines only where the pages scroll under the bars. */
  let scrolledTop = $state(false);
  let moreBelow = $state(false);

  function measureScroll() {
    const el = grid;
    if (!el) return;
    scrolledTop = el.scrollTop > 0;
    moreBelow = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }

  $effect(() => {
    void session.pages.length;
    void selecting;
    const el = grid;
    if (!el) return;
    const observer = new ResizeObserver(measureScroll);
    observer.observe(el);
    void tick().then(measureScroll);
    return () => observer.disconnect();
  });

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
  <header class="topbar column">
    {#if selecting}
      <button class="icon ghost" onclick={stopSelecting} aria-label="Done selecting">
        <Icon name="close" />
      </button>
      <div class="title count" aria-live="polite">
        {selection.length ? `${selection.length} selected` : 'Select pages'}
      </div>
      <button class="text" onclick={selectAll}>
        {selection.length === session.pages.length ? 'None' : 'All'}
      </button>
    {:else}
      <div class="title"></div>
      {#if session.pages.length > 1}
        <button class="text" onclick={startSelecting}>Select</button>
      {/if}
      <button
        class="icon ghost history"
        onclick={onHistory}
        aria-label={queueStatus.waiting > 0
          ? `History, ${queueStatus.waiting} waiting to upload`
          : 'History'}
      >
        <Icon name="history" />
        {#if queueStatus.waiting > 0}<span class="badge">{queueStatus.waiting}</span>{/if}
      </button>
      <button class="icon ghost" onclick={onSettings} aria-label="Settings">
        <Icon name="settings" />
      </button>
    {/if}
  </header>

  {#if session.pages.length === 0}
    <div class="empty column">
      <div class="sheet-art" aria-hidden="true">
        <span></span><span></span><span></span>
      </div>
      <h1>Scan a document</h1>
      <p>
        Point the camera at a page. Edges are found automatically and the photo is taken when you
        hold still. Add as many pages as you need, then save a PDF or send it to Paperless.
      </p>
      <button class="primary big" onclick={onCamera}>
        <Icon name="retake" /> Start scanning
      </button>
    </div>
  {:else}
    <div class="head column" class:hairline={scrolledTop}>
      <input
        class="title-input"
        value={session.title}
        {placeholder}
        oninput={(e) => session.setTitle(e.currentTarget.value)}
        aria-label="Document title"
        enterkeyhint="done"
        disabled={selecting}
      />
      <!-- Always one line high: a suggestion appearing never moves the pages. -->
      <div class="subtitle">
        <span class="pages">{plural(session.pages.length)}</span>
        {#if suggestion && !selecting}
          <span class="sep" aria-hidden="true">·</span>
          <button
            class="suggest"
            onclick={() => suggestion && useSuggestion(suggestion)}
            aria-label="Use “{suggestion}” as the title, from page 1"
          >
            <span class="suggest-label">Use</span>
            <span class="suggest-text">“{suggestion}”</span>
          </button>
          <button
            class="dismiss"
            onclick={() => (dismissed = suggestion)}
            aria-label="Dismiss the suggested title"
          >
            <Icon name="close" size={16} />
          </button>
        {/if}
      </div>
      <div
        class="filters chips"
        role="group"
        aria-label={selecting ? 'Filter for the selected pages' : 'Filter for all pages'}
      >
        {#each FILTERS as f (f.id)}
          <button
            class="chip"
            class:active={commonFilter === f.id && filterPages.length > 0}
            aria-pressed={commonFilter === f.id && filterPages.length > 0}
            disabled={filterPages.length === 0}
            onclick={() => applyToAll(f.id, f.label)}
            title={f.hint}
          >
            {f.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="grid column" class:selecting bind:this={grid} onscroll={measureScroll}>
      {#each session.pages as page, i (page.id)}
        {@const prep = tileState(page)}
        {@const picked = selecting && selected.has(page.id)}
        <button
          class="tile"
          class:dragging={dragId === page.id}
          class:picked
          data-page-index={i}
          data-page-id={page.id}
          style:transform={dragId === page.id
            ? `translate(${dragOffset.x}px, ${dragOffset.y}px) scale(1.05)`
            : undefined}
          animate:flip={{ duration: dragId === page.id ? 0 : 200 }}
          onclick={() => tap(page.id)}
          onpointerdown={(e) => pointerDown(e, page.id)}
          onpointermove={pointerMove}
          onpointerup={pointerUp}
          onpointercancel={cancelPress}
          oncontextmenu={(e) => e.preventDefault()}
          aria-pressed={selecting ? picked : undefined}
          aria-label={selecting
            ? `Page ${i + 1}`
            : `Page ${i + 1}, ${prep.label}. Tap to edit, press and hold to move.`}
        >
          <div class="frame">
            <PageCanvas {page} longEdge={520} channel="thumb-{page.id}" class="thumb" />
            {#if selecting}
              <span class="check" class:on={picked} aria-hidden="true">
                {#if picked}<Icon name="check" size={16} />{/if}
              </span>
            {/if}
          </div>
          <!-- Export readiness: a hairline that fills, then fades once ready. -->
          <span
            class="prep"
            class:done={prep.progress >= 1 || selecting}
            class:busy={prep.busy}
            style:--progress={prep.progress}
            aria-hidden="true"
          ></span>
          <span class="number">
            {i + 1}
            {#if isBlurred(page)}<span class="blurred">Blurred</span>{/if}
          </span>
        </button>
      {/each}
      {#if !selecting}
        <button class="tile add" onclick={onCamera} aria-label="Add pages">
          <div class="frame"><Icon name="plus" size={28} /></div>
          <span class="prep done" aria-hidden="true"></span>
          <span class="number">Add</span>
        </button>
      {/if}
      {#if selecting}
        <p class="hint">Tap pages to select them.</p>
      {:else if session.pages.length > 1}
        <p class="hint">Press and hold a page to move it.</p>
      {/if}
    </div>
  {/if}

  {#if selecting}
    <div
      class="bottombar tools column"
      class:hairline={moreBelow}
      role="toolbar"
      aria-label="Selected pages"
      use:dock
    >
      <button class="icon ghost" onclick={rotateSelected} disabled={!selection.length}>
        <Icon name="rotate" /><span>Rotate</span>
      </button>
      <button class="icon ghost" onclick={() => moveSelected('start')} disabled={!selection.length}>
        <Icon name="toStart" /><span>To start</span>
      </button>
      <button class="icon ghost" onclick={() => moveSelected('end')} disabled={!selection.length}>
        <Icon name="toEnd" /><span>To end</span>
      </button>
      <button
        class="icon ghost"
        onclick={openSplit}
        disabled={!selection.length || selection.length === session.pages.length || !!ui.task}
        title="Save the selected pages as a document of their own"
      >
        <Icon name="split" /><span>Split off</span>
      </button>
      <button class="icon ghost danger" onclick={deleteSelected} disabled={!selection.length}>
        <Icon name="trash" /><span>Delete</span>
      </button>
    </div>
  {:else if session.pages.length > 0}
    <div class="bottombar actions column" class:hairline={moreBelow} use:dock>
      <button
        class="icon ghost quiet"
        onclick={discard}
        aria-label="Discard scanned pages"
        title="Discard scanned pages"
      >
        <Icon name="trash" />
      </button>
      <button
        class="icon ghost export"
        style:--progress={uploadBadge.text === 'ready' ? 0 : uploadBadge.progress}
        onclick={() => void upload()}
        disabled={!!ui.task}
        aria-label={uploadBadge.text
          ? `Send to Paperless… (${uploadBadge.text})`
          : 'Send to Paperless…'}
        title="Send to Paperless"
      >
        <Icon name="leaf" />
      </button>
      <button
        class="icon export download"
        class:primary={!sharing}
        style:--progress={!sharing && pdfBadge.text !== 'ready' ? pdfBadge.progress : 0}
        onclick={() => void save(true)}
        disabled={!!ui.task}
        aria-label="Download PDF"
        aria-describedby={pdfBadge.text && !sharing ? 'pdf-state' : undefined}
      >
        <Icon name="download" />
        <span class="label">Download</span>
      </button>
      {#if sharing}
        <!-- Open with another app (the share sheet): the usual way out. -->
        <button
          class="icon primary export share"
          style:--progress={pdfBadge.text === 'ready' ? 0 : pdfBadge.progress}
          onclick={() => void save()}
          disabled={!!ui.task}
          aria-label="Share PDF"
          aria-describedby={pdfBadge.text ? 'pdf-state' : undefined}
        >
          <Icon name="share" />
          <span class="label">Share</span>
        </button>
      {/if}
      {#if pdfBadge.text}
        <span class="sr-only" id="pdf-state">{pdfBadge.text}</span>
      {/if}
    </div>
  {/if}
</section>

<dialog bind:this={splitDialog} aria-labelledby="split-heading" class="dialog split">
  <form method="dialog" onsubmit={(e) => e.preventDefault()}>
    <div class="body">
      <h2 id="split-heading">Split off {plural(splitIds.length)}</h2>
      <p class="help">
        They are saved or uploaded as a document of their own, then taken out of this one. You can
        undo that, and edit the new document again from History.
      </p>
      <label class="field">
        Title
        <input bind:value={splitTitle} placeholder={splitPlaceholder} enterkeyhint="done" />
      </label>
    </div>
    <div class="dialog-actions">
      <button type="button" class="ghost cancel" onclick={() => splitDialog?.close()}>Cancel</button
      >
      <button type="button" class="icon" onclick={() => split(sharing ? 'share' : 'download')}>
        <Icon name={sharing ? 'share' : 'download'} size={18} /> PDF
      </button>
      <button type="button" class="icon primary" onclick={() => split('upload')}>
        <Icon name="leaf" size={18} /> Paperless
      </button>
    </div>
  </form>
</dialog>

<style>
  /* ---------------------------------------------------------- top bar ---- */

  .topbar .count {
    font-variant-numeric: tabular-nums;
  }

  .history {
    position: relative;
  }

  .badge {
    position: absolute;
    top: 6px;
    right: 4px;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: var(--r-full);
    background: var(--accent);
    color: var(--on-accent);
    box-shadow: 0 0 0 2px var(--bg);
    font-size: var(--fs-micro);
    font-weight: 700;
    line-height: 18px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  /* ------------------------------------------------------------- head ---- */

  .head {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    padding-bottom: var(--s-2);
    border-bottom: 1px solid transparent;
    transition: border-color var(--dur-1) var(--ease);
  }

  .hairline.head {
    border-bottom-color: var(--line);
  }

  .title-input {
    width: 100%;
    min-width: 0;
    margin: 0 0 0 calc(-1 * var(--s-2));
    padding: 2px var(--s-2);
    font: inherit;
    /* 28 px, a little smaller on the narrowest phones so a dated title fits. */
    font-size: clamp(22px, 7vw, var(--fs-title));
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.2;
    color: var(--text);
    background: transparent;
    border: none;
    border-radius: var(--r-s);
    text-overflow: ellipsis;
    transition: background-color var(--dur-1) var(--ease);
  }

  /* The default title reads as the title, just a shade quieter. */
  .title-input::placeholder {
    color: var(--text-2);
    opacity: 1;
  }

  @media (hover: hover) {
    .title-input:hover:not(:disabled) {
      background: color-mix(in srgb, var(--fill) 60%, transparent);
    }
  }

  .title-input:focus {
    background: var(--fill);
    outline: none;
  }

  .title-input:focus-visible {
    box-shadow: 0 0 0 2px var(--accent-text);
  }

  .title-input:disabled {
    opacity: 1;
    color: var(--text);
  }

  .subtitle {
    display: flex;
    align-items: center;
    gap: var(--s-1);
    height: 32px;
    min-width: 0;
    font-size: var(--fs-caption);
    color: var(--text-2);
    white-space: nowrap;
  }

  .pages {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }

  .sep {
    flex: 0 0 auto;
    padding: 0 2px;
  }

  .suggest {
    display: inline-flex;
    align-items: baseline;
    gap: var(--s-1);
    min-width: 0;
    min-height: 32px;
    margin: 0 -6px;
    padding: 0 6px;
    border-radius: var(--r-s);
    background: transparent;
    font-size: var(--fs-caption);
    font-weight: 500;
    color: var(--accent-text);
    animation: fade-in var(--dur-2) var(--ease);
  }

  @media (hover: hover) {
    .suggest:hover:not(:disabled) {
      background: var(--accent-soft);
    }
  }

  .suggest-label {
    flex: 0 0 auto;
    font-weight: 650;
  }

  .suggest-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dismiss {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 36px;
    min-height: 36px;
    margin-left: var(--s-1);
    padding: 0;
    border-radius: var(--r-full);
    background: transparent;
    color: var(--text-2);
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }

  .filters {
    margin: var(--s-1) calc(-1 * var(--gutter)) 0;
    padding: 0 var(--gutter);
  }

  .filters .chip:first-child {
    margin-left: -14px;
  }

  @media (max-width: 374px) {
    .filters .chip:first-child {
      margin-left: -10px;
    }
  }

  /* ------------------------------------------------------------ empty ---- */

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--s-4);
    padding-bottom: calc(var(--s-10) + var(--safe-bottom));
    text-align: center;
  }

  /* Three sheets, fanned: a quiet picture of what the app makes. */
  .sheet-art {
    position: relative;
    width: 96px;
    height: 112px;
    margin-bottom: var(--s-4);
  }

  .sheet-art span {
    position: absolute;
    inset: 8px 14px;
    border-radius: var(--r-xs);
    background: var(--surface);
    box-shadow: var(--shadow-paper);
  }

  .sheet-art span:nth-child(1) {
    transform: rotate(-9deg) translateX(-10px);
    opacity: 0.6;
  }

  .sheet-art span:nth-child(2) {
    transform: rotate(5deg) translateX(8px);
    opacity: 0.8;
  }

  .sheet-art span:nth-child(3) {
    background:
      linear-gradient(var(--line), var(--line)) 12px 18px / 40% 3px no-repeat,
      linear-gradient(var(--line), var(--line)) 12px 30px / 60% 2px no-repeat,
      linear-gradient(var(--line), var(--line)) 12px 38px / 55% 2px no-repeat,
      linear-gradient(var(--line), var(--line)) 12px 46px / 60% 2px no-repeat,
      var(--surface);
  }

  .empty h1 {
    margin: 0;
    font-size: var(--fs-heading);
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .empty p {
    margin: 0 0 var(--s-4);
    max-width: 34ch;
    font-size: var(--fs-body);
    line-height: 1.5;
    color: var(--text-2);
  }

  .primary.big {
    display: inline-flex;
    gap: var(--s-2);
    align-items: center;
    min-height: 52px;
    padding: 0 var(--s-6);
    border-radius: var(--r-full);
    font-size: var(--fs-large);
  }

  /* ------------------------------------------------------------- grid ---- */

  .grid {
    /* Tiles' offsetLeft/offsetTop are measured from here (drag and drop). */
    position: relative;
    flex: 1;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(124px, 1fr));
    column-gap: var(--s-4);
    row-gap: var(--s-5);
    padding-top: var(--s-3);
    padding-bottom: var(--s-6);
    align-content: start;
  }

  @media (min-width: 390px) {
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      column-gap: var(--s-5);
      row-gap: var(--s-6);
    }
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: stretch;
    min-height: auto;
    padding: 0;
    background: none;
    border-radius: var(--r-xs);
    touch-action: pan-y;
    -webkit-touch-callout: none;
    position: relative;
  }

  @media (hover: hover) {
    .tile:hover:not(:disabled) {
      background: none;
    }
  }

  .tile:active:not(:disabled) {
    transform: none;
  }

  .tile.dragging {
    z-index: 5;
    transition: none;
  }

  .frame {
    flex: 0 0 auto;
    width: 100%;
    /* A4's proportions: a portrait page fills it exactly. */
    aspect-ratio: 210 / 297;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }

  /* Centred in the frame; absolute, so the percentages have a size to refer to. */
  .frame :global(.thumb) {
    position: absolute;
    inset: 0;
    margin: auto;
    max-width: 100%;
    max-height: 100%;
    border-radius: var(--r-xs);
    box-shadow: var(--shadow-paper);
    pointer-events: none;
    transition:
      box-shadow var(--dur-2) var(--ease),
      opacity var(--dur-2) var(--ease),
      outline-color var(--dur-1) var(--ease);
    outline: 2.5px solid transparent;
    outline-offset: 3px;
  }

  @media (hover: hover) {
    .tile:hover .frame :global(.thumb) {
      box-shadow:
        var(--shadow-paper),
        0 6px 20px rgb(0 0 0 / 10%);
    }
  }

  .tile.dragging .frame :global(.thumb) {
    box-shadow:
      var(--paper-ring),
      0 18px 40px rgb(0 0 0 / 30%);
  }

  .selecting .tile:not(.picked) .frame :global(.thumb) {
    opacity: 0.6;
  }

  .tile.picked .frame :global(.thumb) {
    outline-color: var(--accent);
  }

  .check {
    position: absolute;
    right: 8px;
    bottom: 8px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 1.5px solid rgb(0 0 0 / 30%);
    background: rgb(255 255 255 / 85%);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--on-accent);
  }

  .check.on {
    background: var(--accent);
    border-color: var(--accent);
  }

  .check :global(svg) {
    stroke-width: 2.5;
  }

  /* Readiness: a hairline under the page that fills, then fades away. */
  .prep {
    position: relative;
    height: 2px;
    margin: 2px 25% 0;
    border-radius: 1px;
    background: var(--line);
    overflow: hidden;
    transition: opacity var(--dur-3) var(--ease);
  }

  .prep::after {
    content: '';
    position: absolute;
    inset: 0;
    transform-origin: left;
    transform: scaleX(var(--progress, 0));
    background: var(--text-2);
    transition: transform var(--dur-3) var(--ease);
  }

  .prep.busy::after {
    animation: pulse 1.2s ease-in-out infinite;
  }

  .prep.done {
    opacity: 0;
  }

  @keyframes pulse {
    50% {
      opacity: 0.4;
    }
  }

  .number {
    display: flex;
    justify-content: center;
    gap: 6px;
    font-size: var(--fs-caption);
    font-weight: 500;
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
    line-height: 18px;
  }

  .blurred {
    color: var(--warn);
    font-weight: 600;
  }

  .add .frame {
    border-radius: var(--r-s);
    border: 1.5px dashed color-mix(in srgb, var(--text-2) 45%, transparent);
    color: var(--text-2);
    transition:
      border-color var(--dur-1) var(--ease),
      color var(--dur-1) var(--ease);
  }

  @media (hover: hover) {
    .add:hover .frame {
      border-color: var(--accent-text);
      color: var(--accent-text);
    }
  }

  .hint {
    grid-column: 1 / -1;
    margin: 0;
    font-size: var(--fs-caption);
    color: var(--text-2);
    text-align: center;
  }

  /* ------------------------------------------------------- bottom bar ---- */

  .bottombar {
    border-top: 1px solid transparent;
    transition: border-color var(--dur-1) var(--ease);
  }

  .bottombar.hairline {
    border-top-color: var(--line);
  }

  .quiet {
    color: var(--text-2);
  }

  .actions .quiet {
    margin-left: -10px;
  }

  .actions .download {
    flex: 2;
    margin-left: auto;
  }

  .actions .share {
    flex: 3;
  }

  .actions .download,
  .actions .share {
    min-height: 48px;
    min-width: 48px;
    max-width: 220px;
  }

  .actions .download:not(.primary) {
    max-width: 180px;
  }

  /* On the narrowest phones Download is its icon alone (its accessible name stays). */
  @media (max-width: 374px) {
    .actions .download:not(.primary) {
      flex: 0 0 auto;
    }

    .actions .download:not(.primary) .label {
      display: none;
    }
  }

  /* An export being prepared: a hairline along the button's bottom edge. */
  .export {
    position: relative;
    overflow: hidden;
    white-space: nowrap;
  }

  .export::after {
    content: '';
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 5px;
    height: 2px;
    border-radius: 1px;
    transform-origin: left;
    transform: scaleX(var(--progress, 0));
    background: currentColor;
    opacity: 0.45;
    transition: transform var(--dur-3) var(--ease);
  }

  .tools {
    gap: 0;
    padding-top: var(--s-2);
  }

  .tools .icon {
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    min-height: 52px;
    padding: 4px 2px;
    font-size: var(--fs-micro);
    font-weight: 500;
    letter-spacing: 0.01em;
  }

  .danger {
    color: var(--err);
  }

  /* ------------------------------------------------------------ split ---- */

  .split .body {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    padding: var(--s-6) var(--s-6) var(--s-4);
  }

  .split h2 {
    margin: 0;
    font-size: var(--fs-heading);
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .split .dialog-actions .cancel {
    margin-right: auto;
  }
</style>
