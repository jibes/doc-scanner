<script lang="ts">
  import { defaultTitle, exportPdf, pdfFilename, saveFile } from '../lib/export';
  import { FILTERS } from '../lib/filters';
  import type { FilterId } from '../lib/imaging/filters';
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
  }

  let { settings, onCamera, onOpen, onSettings }: Props = $props();

  const placeholder = defaultTitle();
  const title = $derived(session.title.trim() || placeholder);

  const commonFilter = $derived.by(() => {
    const first = session.pages[0]?.spec.filter;
    return session.pages.every((p) => p.spec.filter === first) ? first : null;
  });

  function applyToAll(filter: FilterId) {
    for (const page of session.pages) session.update(page.id, { filter });
  }

  async function build(): Promise<Blob> {
    return exportPdf(session.pages, settings, title, (done, total) =>
      busy(
        done < total ? `Rendering page ${done + 1} of ${total}…` : 'Building PDF…',
        done / total,
      ),
    );
  }

  async function save() {
    try {
      const pdf = await build();
      idle();
      const how = await saveFile(pdf, pdfFilename(title));
      if (how === 'downloaded')
        toast(`Saved ${pdfFilename(title)} (${(pdf.size / 1024).toFixed(0)} KB)`, 'good');
    } catch (error) {
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
      const pdf = await build();
      busy('Uploading to Paperless…');
      const task = await uploadDocument(settings.paperless, pdf, pdfFilename(title), title);
      busy('Paperless is processing (OCR)…');
      const result = await waitForTask(settings.paperless, task);
      idle();
      if (result.outcome === 'failure') {
        toast(`Paperless rejected it: ${result.message ?? 'unknown error'}`, 'err');
        return;
      }
      toast(
        result.outcome === 'success'
          ? 'Filed in Paperless.'
          : 'Uploaded; Paperless is still processing.',
        'good',
      );
      if (confirm('Uploaded. Start a new document?')) session.clear();
    } catch (error) {
      toast(`Upload failed: ${errorMessage(error)}`, 'err');
    } finally {
      idle();
    }
  }

  function discard() {
    if (confirm(`Discard all ${session.pages.length} pages?`)) session.clear();
  }
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
    <button class="icon ghost" onclick={onSettings} aria-label="Settings"
      ><Icon name="settings" /></button
    >
  </header>

  {#if session.pages.length === 0}
    <div class="empty">
      <p>No pages yet.</p>
      <button class="primary" onclick={onCamera}><Icon name="retake" /> Scan a page</button>
    </div>
  {:else}
    <div class="filters">
      <span>All pages</span>
      <div class="chips">
        {#each FILTERS as f (f.id)}
          <button
            class="chip"
            class:active={commonFilter === f.id}
            onclick={() => applyToAll(f.id)}
          >
            {f.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="grid">
      {#each session.pages as page, i (page.id)}
        <button class="tile" onclick={() => onOpen(page.id)} aria-label="Edit page {i + 1}">
          <div class="frame">
            <PageCanvas {page} longEdge={520} channel="thumb-{page.id}" class="thumb" />
          </div>
          <span class="number">{i + 1}</span>
        </button>
      {/each}
      <button class="tile add" onclick={onCamera} aria-label="Add pages">
        <div class="frame"><Icon name="plus" /></div>
        <span class="number">Add</span>
      </button>
    </div>
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
      <Icon name="download" /> PDF
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
    gap: 16px;
    color: var(--muted);
  }

  .empty .primary {
    display: inline-flex;
    gap: 8px;
    align-items: center;
  }

  .empty :global(svg) {
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
    box-shadow: 0 2px 10px rgb(0 0 0 / 40%);
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
</style>
