<script lang="ts">
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { canShareFiles, pdfFilename, saveFile } from '../lib/export';
  import { haptic } from '../lib/haptics';
  import {
    deleteHistory,
    forgetPages,
    keptPages,
    loadHistory,
    pruneDocuments,
    refreshPendingUploads,
    storedDocumentIds,
    updateHistory,
    type HistoryEntry,
  } from '../lib/history';
  import { isConfigured, pollTask, storedOutcome } from '../lib/paperless';
  import { defaultSelection, uploadWithSelection } from '../lib/paperlessMeta';
  import { pickUploadMeta } from '../lib/paperlessSheet';
  import { queueStatus } from '../lib/queueStatus.svelte';
  import {
    cancelQueued,
    flushUploadQueue,
    queueUpload,
    restoreQueued,
    shouldQueue,
  } from '../lib/uploadQueue';
  import type { AppSettings } from '../lib/settings';
  import { session } from '../lib/store/session.svelte';
  import { busy, errorMessage, idle, toast, ui } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    settings: AppSettings;
    onBack: () => void;
    /** A document from History was opened for editing. */
    onEdit: () => void;
  }

  let { settings, onBack, onEdit }: Props = $props();

  /** Entries whose pages are kept, so they can be edited again. */
  const editable = new SvelteSet<string>();

  let entries = $state.raw<HistoryEntry[]>([]);
  let loaded = $state(false);
  /** Entries being uploaded right now, so a second tap does not send them twice. */
  const uploading = new SvelteSet<string>();

  // The queue sent, rejected or retried an entry: show it as it is now.
  let seenChanges = queueStatus.changes;
  $effect(() => {
    if (queueStatus.changes === seenChanges) return;
    seenChanges = queueStatus.changes;
    void loadHistory().then((list) => (entries = list));
  });

  onMount(() => {
    // Pages kept for entries that were removed meanwhile are dropped first.
    void pruneDocuments()
      .then(storedDocumentIds)
      .then((ids) => {
        for (const id of ids) editable.add(id);
      });
    void loadHistory().then(async (list) => {
      entries = list;
      loaded = true;
      if (!isConfigured(settings.paperless)) return;
      // Uploads still processing when the app stopped waiting may have finished.
      const changed = await refreshPendingUploads(settings.paperless, list);
      if (changed.length === 0) return;
      const byId = new Map(changed.map((e) => [e.id, e]));
      entries = entries.map((e) => byId.get(e.id) ?? e);
    });
  });

  function replace(updated: HistoryEntry) {
    entries = entries.map((e) => (e.id === updated.id ? updated : e));
  }

  const dateFormat = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  function size(bytes: number): string {
    return bytes > 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`;
  }

  const sharing = canShareFiles();

  /** Shows a stored image Blob, releasing its object URL when done. */
  function blobSrc(img: HTMLImageElement, blob: Blob) {
    let url = URL.createObjectURL(blob);
    img.src = url;
    return {
      update(next: Blob) {
        URL.revokeObjectURL(url);
        url = URL.createObjectURL(next);
        img.src = url;
      },
      destroy() {
        URL.revokeObjectURL(url);
      },
    };
  }

  /** Open the stored PDF in the browser's own viewer. */
  function view(entry: HistoryEntry) {
    if (!entry.pdf) return;
    const url = URL.createObjectURL(entry.pdf);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function share(entry: HistoryEntry, download = false) {
    if (!entry.pdf) return;
    try {
      if ((await saveFile(entry.pdf, pdfFilename(entry.title), { download })) === 'cancelled')
        return;
      haptic('success');
    } catch (error) {
      toast(`Could not share: ${errorMessage(error)}`, 'err');
    }
  }

  async function upload(entry: HistoryEntry) {
    if (!entry.pdf || uploading.has(entry.id)) return;
    if (!isConfigured(settings.paperless)) {
      toast('Add your Paperless URL and API token in the settings first.', 'info');
      return;
    }
    const selection = await pickUploadMeta(settings.paperless, entry.title, {
      initial: defaultSelection(settings.paperless),
    });
    if (!selection) return;
    uploading.add(entry.id);
    try {
      busy('Uploading to Paperless…');
      let taskId: string;
      try {
        const sent = await uploadWithSelection(
          settings.paperless,
          entry.pdf,
          pdfFilename(entry.title),
          entry.title,
          selection,
        );
        taskId = sent.taskId;
        if (sent.missing.length > 0) {
          toast(`Not found in Paperless, left out: ${sent.missing.join(', ')}`, 'info');
        }
      } catch (error) {
        if (!shouldQueue(error)) throw error;
        const queued = await queueUpload({
          title: entry.title,
          pages: entry.pages,
          pdf: entry.pdf,
          filename: pdfFilename(entry.title),
          selection,
          thumb: entry.thumb,
          error,
          entry,
        });
        replace(queued);
        toast('Paperless is unreachable; it will be sent when it is back.', 'info');
        return;
      }
      // Stored before waiting, so a later visit can look the result up.
      const sent: HistoryEntry = { ...entry, kind: 'upload', outcome: 'pending', taskId };
      void updateHistory(sent);
      replace(sent);
      busy('Paperless is processing it…');
      let result: Awaited<ReturnType<typeof pollTask>>;
      try {
        result = await pollTask(settings.paperless, taskId);
      } catch (error) {
        // The file is in Paperless; only its status could not be read. The
        // entry stays pending and is checked again on the next visit.
        toast(`Uploaded, but its status could not be checked: ${errorMessage(error)}`, 'info');
        return;
      }
      // Removed from history while waiting: leave it removed.
      if (!entries.some((e) => e.id === entry.id)) return;
      const updated: HistoryEntry = { ...sent, outcome: storedOutcome(result.outcome) };
      void updateHistory(updated, { onlyIfPresent: true });
      replace(updated);
      if (result.outcome === 'failure') {
        haptic('error');
        toast(`Paperless rejected it: ${result.message ?? 'unknown error'}`, 'err');
      } else if (result.outcome === 'duplicate') {
        toast('Already in Paperless.', 'info');
      } else {
        haptic('success');
        toast(
          result.outcome === 'success'
            ? 'Filed in Paperless.'
            : 'Uploaded; Paperless is still processing.',
          'good',
        );
      }
    } catch (error) {
      haptic('error');
      toast(`Upload failed: ${errorMessage(error)}`, 'err');
    } finally {
      uploading.delete(entry.id);
      idle();
    }
  }

  /** How long a removed entry's kept pages outlive it, so Undo can bring them back too. */
  const FORGET_PAGES_MS = 8000;

  function remove(entry: HistoryEntry) {
    entries = entries.filter((e) => e.id !== entry.id);
    void deleteHistory(entry.id);
    // A waiting upload is withdrawn with it (and put back by Undo).
    const withdrawn = entry.queued ? cancelQueued(entry.id) : Promise.resolve(null);
    // Pages left behind if the app closes first are dropped on the next visit.
    const forget = setTimeout(() => {
      editable.delete(entry.id);
      void forgetPages(entry.id);
    }, FORGET_PAGES_MS);
    toast('Removed from history.', 'info', {
      label: 'Undo',
      run: () => {
        clearTimeout(forget);
        void updateHistory(entry);
        void withdrawn.then((item) => item && restoreQueued(item));
        entries = [...entries, entry].sort((a, b) => b.createdAt - a.createdAt);
      },
    });
  }

  /** Open an entry's kept pages as the document, after asking to replace a non-empty one. */
  async function editAgain(entry: HistoryEntry) {
    if (ui.task) {
      toast('Wait for the current export to finish.', 'info');
      return;
    }
    const n = session.pages.length;
    if (
      n > 0 &&
      !confirm(
        `Replace the ${n} ${n === 1 ? 'page' : 'pages'} you are working on with “${entry.title}”? PDFs you saved or sent to Paperless stay in History.`,
      )
    )
      return;
    const pages = await keptPages(entry.id);
    if (!pages?.length) {
      editable.delete(entry.id);
      toast('The pages of this document are no longer kept.', 'err');
      return;
    }
    session.open(pages, entry.title);
    haptic('success');
    toast(`Opened “${entry.title}” for editing.`, 'good');
    onEdit();
  }

  const OUTCOME: Record<NonNullable<HistoryEntry['outcome']>, string> = {
    success: 'Filed in Paperless',
    pending: 'Sent to Paperless',
    failure: 'Rejected by Paperless',
  };
</script>

<section class="screen history">
  <header class="topbar">
    <button class="icon ghost" onclick={onBack} aria-label="Back"><Icon name="back" /></button>
    <div class="title">History</div>
  </header>

  {#if loaded && entries.length === 0}
    <div class="empty">
      <Icon name="history" />
      <p>Documents you save, share or upload appear here.</p>
    </div>
  {:else}
    <ul class="list">
      {#each entries as entry (entry.id)}
        <li class="entry">
          <button
            class="thumb"
            onclick={() => view(entry)}
            disabled={!entry.pdf}
            aria-label="Open {entry.title}"
          >
            {#if entry.thumb}
              <img use:blobSrc={entry.thumb} alt="" />
            {:else}
              <Icon name="scan" />
            {/if}
          </button>
          <div class="info">
            <div class="name">{entry.title}</div>
            <div class="meta">
              {dateFormat.format(entry.createdAt)} · {entry.pages}
              {entry.pages === 1 ? 'page' : 'pages'} · {size(entry.bytes)}
            </div>
            <div class="status" class:bad={entry.outcome === 'failure'}>
              {#if entry.queued}
                Waiting to upload
                <button class="link" onclick={() => void flushUploadQueue()}>Retry now</button>
              {:else}
                {entry.kind === 'upload' && entry.outcome ? OUTCOME[entry.outcome] : 'Saved as PDF'}
              {/if}
              {#if !entry.pdf}· file no longer kept{/if}
            </div>
          </div>
          <div class="actions">
            <button
              class="edit"
              onclick={() => void editAgain(entry)}
              disabled={!editable.has(entry.id)}
              aria-label="Edit {entry.title} again"
              title={editable.has(entry.id)
                ? 'Open its pages as the document'
                : 'Its pages are no longer kept'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
              </svg>
              Edit again
            </button>
            {#if sharing}
              <button
                class="icon ghost"
                onclick={() => void share(entry)}
                disabled={!entry.pdf}
                aria-label="Share {entry.title}"
              >
                <Icon name="share" />
              </button>
            {/if}
            <button
              class="icon ghost"
              onclick={() => void share(entry, true)}
              disabled={!entry.pdf}
              aria-label="Download {entry.title}"
            >
              <Icon name="download" />
            </button>
            <button
              class="icon ghost"
              onclick={() => void upload(entry)}
              disabled={!entry.pdf || uploading.has(entry.id)}
              aria-label="Send {entry.title} to Paperless"
              title="Send to Paperless"
            >
              <Icon name="leaf" />
            </button>
            <button
              class="icon ghost danger"
              onclick={() => remove(entry)}
              aria-label="Remove {entry.title} from history"
            >
              <Icon name="trash" />
            </button>
          </div>
        </li>
      {/each}
    </ul>
    <p class="note">
      The last 15 PDFs are kept on this device for sharing again, and the pages of the last 10
      documents for editing again.
    </p>
  {/if}
</section>

<style>
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--muted);
    padding: 32px;
    text-align: center;
  }

  .empty :global(svg) {
    width: 40px;
    height: 40px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 8px 0;
    overflow-y: auto;
    flex: 1;
  }

  /* Thumbnail on the left; name and details on top, actions in a row below,
     so a long title and the date get the full width on a phone. */
  .entry {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 12px;
    row-gap: 6px;
    align-items: start;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  .entry .thumb {
    grid-row: span 2;
  }

  .entry .actions {
    grid-column: 2;
    align-items: center;
  }

  .entry .actions .edit {
    margin-right: auto;
  }

  .info {
    flex: 1;
    min-width: 0;
  }

  .thumb {
    flex: none;
    width: 44px;
    height: 58px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel-2);
    color: var(--muted);
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top;
  }

  .thumb :global(svg) {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
  }

  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta,
  .status {
    font-size: 12.5px;
    color: var(--muted);
  }

  .link {
    padding: 0 0 0 6px;
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    text-decoration: underline;
  }

  .status.bad {
    color: var(--err);
  }

  .actions {
    display: flex;
    gap: 2px;
  }

  .edit {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px 5px 8px;
    border-radius: 999px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--accent);
    background: var(--panel-2);
  }

  .edit svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .edit:disabled {
    color: var(--muted);
  }

  .danger {
    color: var(--err);
  }

  .note {
    margin: 0;
    padding: 12px 16px calc(12px + var(--safe-bottom));
    font-size: 12px;
    color: var(--muted);
    text-align: center;
  }
</style>
