<script lang="ts">
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
    const progress = phaseProgress(phase, backgroundText);
    return {
      progress,
      busy: phase === 'rendering' || phase === 'reading',
      label: progress >= 1 ? 'ready to export' : PHASE_LABEL[phase],
    };
  }

  /** Circumference of the readiness ring (r = 8). */
  const RING = 2 * Math.PI * 8;

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
  const suggestion = $derived(
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
  let suppressClick = false;

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

  function tap(id: string) {
    if (suppressClick) return;
    if (selecting) toggle(id);
    else onOpen(id);
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
  {#if selecting}
    <header class="topbar">
      <button class="icon ghost" onclick={stopSelecting} aria-label="Done selecting">
        <Icon name="close" />
      </button>
      <div class="title" aria-live="polite">
        {selection.length ? `${selection.length} selected` : 'Select pages'}
      </div>
      <button class="ghost text-button" onclick={selectAll}>
        {selection.length === session.pages.length ? 'None' : 'All'}
      </button>
    </header>
  {:else}
    <header class="topbar">
      <input
        class="title-input"
        value={session.title}
        {placeholder}
        oninput={(e) => session.setTitle(e.currentTarget.value)}
        aria-label="Document title"
        enterkeyhint="done"
      />
      {#if session.pages.length > 1}
        <button class="ghost text-button" onclick={startSelecting}>Select</button>
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
    </header>
    {#if suggestion}
      <div class="suggest">
        <span>Title from page 1:</span>
        <button class="chip suggest-chip" onclick={() => useSuggestion(suggestion)}>
          Use “{suggestion}”
        </button>
        <button
          class="icon ghost dismiss"
          onclick={() => (dismissed = suggestion)}
          aria-label="Dismiss the suggested title"
        >
          <Icon name="close" />
        </button>
      </div>
    {/if}
  {/if}

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
      <span>{selecting ? 'Selected' : 'All pages'}</span>
      <div class="chips">
        {#each FILTERS as f (f.id)}
          <button
            class="chip"
            class:active={commonFilter === f.id && filterPages.length > 0}
            disabled={filterPages.length === 0}
            onclick={() => applyToAll(f.id, f.label)}
          >
            {f.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="grid" class:selecting bind:this={grid}>
      {#each session.pages as page, i (page.id)}
        {@const prep = tileState(page)}
        {@const picked = selecting && selected.has(page.id)}
        <button
          class="tile"
          class:dragging={dragId === page.id}
          class:picked
          data-page-index={i}
          style:transform={dragId === page.id
            ? `translate(${dragOffset.x}px, ${dragOffset.y}px) scale(1.05)`
            : undefined}
          animate:flip={{ duration: 180 }}
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
                {#if picked}<Icon name="check" />{/if}
              </span>
            {:else}
              <span
                class="ring"
                class:done={prep.progress >= 1}
                class:busy={prep.busy}
                title="Export: {prep.label}"
                aria-hidden="true"
              >
                <svg viewBox="0 0 20 20">
                  <circle class="track" cx="10" cy="10" r="8" />
                  <circle
                    class="arc"
                    cx="10"
                    cy="10"
                    r="8"
                    stroke-dasharray="{prep.progress * RING} {RING}"
                  />
                  {#if prep.progress >= 1}<path class="tick" d="M6.5 10.2l2.3 2.3 4.7-4.9" />{/if}
                </svg>
              </span>
            {/if}
          </div>
          <span class="number">
            {i + 1}
            {#if isBlurred(page)}<span class="blurred">· blurred</span>{/if}
          </span>
        </button>
      {/each}
      {#if !selecting}
        <button class="tile add" onclick={onCamera} aria-label="Add pages">
          <div class="frame"><Icon name="plus" /></div>
          <span class="number">Add</span>
        </button>
      {/if}
    </div>
    {#if selecting}
      <p class="hint">Tap pages to select them.</p>
    {:else if session.pages.length > 1}
      <p class="hint">Press and hold a page to move it.</p>
    {/if}
  {/if}

  {#if selecting}
    <div class="bottombar tools" role="toolbar" aria-label="Selected pages">
      <button class="icon" onclick={rotateSelected} disabled={!selection.length}>
        <Icon name="rotate" /><span>Rotate</span>
      </button>
      <button class="icon" onclick={() => moveSelected('start')} disabled={!selection.length}>
        <Icon name="left" /><span>To start</span>
      </button>
      <button class="icon" onclick={() => moveSelected('end')} disabled={!selection.length}>
        <Icon name="right" /><span>To end</span>
      </button>
      <button
        class="icon"
        onclick={openSplit}
        disabled={!selection.length || selection.length === session.pages.length || !!ui.task}
        title="Save the selected pages as a document of their own"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 3h7v8H4z" />
          <path d="M13 13h7v8h-7z" />
          <path d="M15 4h5v5" />
          <path d="M20 4l-6 6" />
        </svg>
        <span>Split off</span>
      </button>
      <button class="icon danger" onclick={deleteSelected} disabled={!selection.length}>
        <Icon name="trash" /><span>Delete</span>
      </button>
    </div>
  {:else}
    <div class="bottombar">
      <button
        class="icon"
        onclick={discard}
        disabled={!session.pages.length}
        aria-label="Discard scanned pages"
        title="Discard scanned pages"
      >
        <Icon name="trash" />
      </button>
      {#if sharing}
        <button
          class="icon grow export"
          class:ready={pdfBadge.text === 'ready'}
          style:--progress={pdfBadge.progress}
          onclick={() => void save()}
          disabled={!session.pages.length || !!ui.task}
          aria-label="PDF"
          aria-describedby={pdfBadge.text ? 'pdf-state' : undefined}
        >
          <Icon name="share" />
          <span class="label"
            >PDF{#if pdfBadge.text}<span class="state" id="pdf-state">{pdfBadge.text}</span
              >{/if}</span
          >
        </button>
        <button
          class="icon"
          onclick={() => void save(true)}
          disabled={!session.pages.length || !!ui.task}
          aria-label="Download PDF"
          title="Download PDF"
        >
          <Icon name="download" />
        </button>
      {:else}
        <button
          class="icon grow export"
          class:ready={pdfBadge.text === 'ready'}
          style:--progress={pdfBadge.progress}
          onclick={() => void save(true)}
          disabled={!session.pages.length || !!ui.task}
          aria-label="PDF"
          aria-describedby={pdfBadge.text ? 'pdf-state' : undefined}
        >
          <Icon name="download" />
          <span class="label"
            >PDF{#if pdfBadge.text}<span class="state" id="pdf-state">{pdfBadge.text}</span
              >{/if}</span
          >
        </button>
      {/if}
      <button
        class="icon primary grow export"
        class:ready={uploadBadge.text === 'ready'}
        style:--progress={uploadBadge.progress}
        onclick={() => void upload()}
        disabled={!session.pages.length || !!ui.task}
        aria-label="Paperless"
        aria-describedby={uploadBadge.text ? 'upload-state' : undefined}
      >
        <Icon name="leaf" />
        <span class="label"
          >Paperless{#if uploadBadge.text}<span class="state" id="upload-state"
              >{uploadBadge.text}</span
            >{/if}</span
        >
      </button>
    </div>
  {/if}
</section>

<dialog bind:this={splitDialog} aria-labelledby="split-heading" class="split">
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
    <div class="actions">
      <button type="button" onclick={() => splitDialog?.close()}>Cancel</button>
      <button type="button" onclick={() => split(sharing ? 'share' : 'download')}>
        <Icon name={sharing ? 'share' : 'download'} /> PDF
      </button>
      <button type="button" class="primary" onclick={() => split('upload')}>
        <Icon name="leaf" /> Paperless
      </button>
    </div>
  </form>
</dialog>

<style>
  .history {
    position: relative;
  }

  .badge {
    position: absolute;
    top: 2px;
    right: 2px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
  }

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

  .text-button {
    padding: 8px 10px;
    font-size: 15px;
    font-weight: 600;
    color: var(--accent);
  }

  .suggest {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 14px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
  }

  .suggest > span {
    flex: 0 0 auto;
  }

  .suggest-chip {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--accent);
    font-weight: 600;
  }

  .dismiss {
    margin-left: auto;
    min-width: 36px;
    min-height: 36px;
    padding: 6px;
    color: var(--muted);
  }

  .dismiss :global(svg) {
    width: 16px;
    height: 16px;
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
    position: relative;
  }

  .selecting .tile:not(.picked) .frame :global(.thumb) {
    opacity: 0.75;
  }

  .tile.picked .frame {
    outline: 3px solid var(--accent);
    outline-offset: -3px;
  }

  .frame :global(.thumb) {
    max-width: 100%;
    max-height: 100%;
    box-shadow: 0 2px 10px rgb(0 0 0 / 25%);
    pointer-events: none;
  }

  /* Export readiness: an arc that fills as the page is rendered, then read. */
  .ring {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 22px;
    height: 22px;
    padding: 1px;
    border-radius: 50%;
    background: rgb(0 0 0 / 55%);
    pointer-events: none;
  }

  .ring svg {
    display: block;
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
    fill: none;
    stroke-width: 2.5;
  }

  .ring .track {
    stroke: rgb(255 255 255 / 25%);
  }

  .ring .arc {
    stroke: #fff;
    stroke-linecap: round;
    transition: stroke-dasharray 0.3s ease;
  }

  .ring.busy .arc {
    animation: pulse 1.2s ease-in-out infinite;
  }

  .ring.done {
    background: var(--good);
  }

  .ring.done .track,
  .ring.done .arc {
    stroke: transparent;
  }

  .ring .tick {
    stroke: #fff;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
    transform: rotate(90deg);
    transform-origin: 10px 10px;
  }

  @keyframes pulse {
    50% {
      opacity: 0.45;
    }
  }

  .check {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid #fff;
    background: rgb(0 0 0 / 35%);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
  }

  .check.on {
    background: var(--accent);
    border-color: var(--accent);
  }

  .check :global(svg) {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 3;
    stroke-linecap: round;
    stroke-linejoin: round;
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

  /* The PDF / Paperless buttons fill from below as their export is prepared. */
  .export {
    position: relative;
    overflow: hidden;
    white-space: nowrap;
  }

  .export::after {
    content: '';
    position: absolute;
    left: 0;
    bottom: 0;
    height: 3px;
    width: calc(var(--progress, 0) * 100%);
    background: currentColor;
    opacity: 0.45;
    transition: width 0.3s ease;
  }

  .export.ready::after {
    opacity: 0;
  }

  /* The name, with the readiness in small print under it. */
  .label {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    line-height: 1.15;
  }

  .state {
    font-size: 11px;
    font-weight: 500;
    opacity: 0.85;
    font-variant-numeric: tabular-nums;
  }

  .tools {
    gap: 4px;
    padding-left: 6px;
    padding-right: 6px;
  }

  .tools .icon {
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 6px 2px;
    font-size: 11px;
    background: transparent;
    border-color: transparent;
  }

  .danger {
    color: var(--err);
  }

  dialog.split {
    width: min(440px, calc(100vw - 24px));
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--panel);
    color: var(--text);
  }

  dialog.split::backdrop {
    background: rgb(0 0 0 / 65%);
    backdrop-filter: blur(4px);
  }

  .split .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px;
  }

  .split h2 {
    margin: 0;
    font-size: 17px;
  }

  .split .help {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    line-height: 1.5;
  }

  .split .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 20px;
    border-top: 1px solid var(--border);
  }

  .split .actions button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .split .actions :global(svg) {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }
</style>
