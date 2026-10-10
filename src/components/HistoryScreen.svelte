<script lang="ts">
  import { onMount } from 'svelte';
  import { pdfFilename, saveFile } from '../lib/export';
  import { haptic } from '../lib/haptics';
  import { deleteHistory, loadHistory, updateHistory, type HistoryEntry } from '../lib/history';
  import { isConfigured, uploadDocument, waitForTask } from '../lib/paperless';
  import type { AppSettings } from '../lib/settings';
  import { busy, errorMessage, idle, toast } from '../lib/ui.svelte';
  import Icon from './Icon.svelte';

  interface Props {
    settings: AppSettings;
    onBack: () => void;
  }

  let { settings, onBack }: Props = $props();

  let entries = $state.raw<HistoryEntry[]>([]);
  let loaded = $state(false);

  onMount(() => {
    void loadHistory().then((list) => {
      entries = list;
      loaded = true;
    });
  });

  const dateFormat = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  function size(bytes: number): string {
    return bytes > 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`;
  }

  async function share(entry: HistoryEntry) {
    if (!entry.pdf) return;
    try {
      await saveFile(entry.pdf, pdfFilename(entry.title));
      haptic('success');
    } catch (error) {
      toast(`Could not share: ${errorMessage(error)}`, 'err');
    }
  }

  async function upload(entry: HistoryEntry) {
    if (!entry.pdf) return;
    if (!isConfigured(settings.paperless)) {
      toast('Add your Paperless URL and API token in the settings first.', 'info');
      return;
    }
    try {
      busy('Uploading to Paperless…');
      const task = await uploadDocument(
        settings.paperless,
        entry.pdf,
        pdfFilename(entry.title),
        entry.title,
      );
      busy('Paperless is processing it…');
      const result = await waitForTask(settings.paperless, task);
      const updated: HistoryEntry = { ...entry, kind: 'upload', outcome: result.outcome };
      await updateHistory(updated);
      entries = entries.map((e) => (e.id === entry.id ? updated : e));
      if (result.outcome === 'failure') {
        haptic('error');
        toast(`Paperless rejected it: ${result.message ?? 'unknown error'}`, 'err');
      } else {
        haptic('success');
        toast(result.outcome === 'success' ? 'Filed in Paperless.' : 'Uploaded.', 'good');
      }
    } catch (error) {
      haptic('error');
      toast(`Upload failed: ${errorMessage(error)}`, 'err');
    } finally {
      idle();
    }
  }

  function remove(entry: HistoryEntry) {
    entries = entries.filter((e) => e.id !== entry.id);
    void deleteHistory(entry.id);
    toast('Removed from history.', 'info', {
      label: 'Undo',
      run: () => {
        void updateHistory(entry);
        entries = [...entries, entry].sort((a, b) => b.createdAt - a.createdAt);
      },
    });
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
          <div class="info">
            <div class="name">{entry.title}</div>
            <div class="meta">
              {dateFormat.format(entry.createdAt)} · {entry.pages}
              {entry.pages === 1 ? 'page' : 'pages'} · {size(entry.bytes)}
            </div>
            <div class="status" class:bad={entry.outcome === 'failure'}>
              {entry.kind === 'upload' && entry.outcome ? OUTCOME[entry.outcome] : 'Saved as PDF'}
              {#if !entry.pdf}· file no longer kept{/if}
            </div>
          </div>
          <div class="actions">
            <button
              class="icon ghost"
              onclick={() => void share(entry)}
              disabled={!entry.pdf}
              aria-label="Share or save {entry.title}"
            >
              <Icon name="share" />
            </button>
            <button
              class="icon ghost"
              onclick={() => void upload(entry)}
              disabled={!entry.pdf}
              aria-label="Upload {entry.title} to Paperless"
            >
              <Icon name="upload" />
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
    <p class="note">The last 15 PDFs are kept on this device for sharing again.</p>
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

  .entry {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }

  .info {
    flex: 1;
    min-width: 0;
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

  .status.bad {
    color: var(--err);
  }

  .actions {
    display: flex;
    gap: 2px;
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
