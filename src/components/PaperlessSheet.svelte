<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { ListsState } from '../lib/paperlessLists.svelte';
  import {
    defaultSelection,
    migrateSelection,
    readCachedLists,
    type UploadSelection,
  } from '../lib/paperlessMeta';
  import type { PaperlessSettings } from '../lib/settings';
  import MetaFields from './MetaFields.svelte';

  interface Props {
    config: PaperlessSettings;
    /** The document's title, shown in the heading. */
    title: string;
    /** Prefilled choice; the settings' defaults when left out. */
    initial?: UploadSelection;
    /** Label of the confirm button. */
    confirmLabel?: string;
    onConfirm: (selection: UploadSelection) => void;
    onCancel: () => void;
  }

  let { config, title, initial, confirmLabel = 'Upload', onConfirm, onCancel }: Props = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  const lists = new ListsState();
  // The sheet is opened for one upload: its props are read once.
  let selection = $state<UploadSelection>(
    untrack(() =>
      initial
        ? (structuredClone($state.snapshot(initial)) as UploadSelection)
        : defaultSelection(config, readCachedLists(config)),
    ),
  );
  let done = false;

  onMount(() => {
    dialog?.showModal();
    void lists.load(config);
  });

  // Legacy tag ids get their names as soon as the lists know them.
  $effect(() => {
    const known = lists.lists;
    if (!known) return;
    untrack(() => {
      if (selection.tagIds.length === 0) return;
      const next = migrateSelection($state.snapshot(selection), known);
      if (next.tagIds.length !== selection.tagIds.length) selection = next;
    });
  });

  function confirm() {
    if (done) return;
    done = true;
    dialog?.close();
    onConfirm($state.snapshot(selection));
  }

  function cancel() {
    if (done) return;
    done = true;
    dialog?.close();
    onCancel();
  }
</script>

<dialog
  bind:this={dialog}
  class="sheet"
  aria-labelledby="paperless-sheet-title"
  oncancel={(e) => (e.preventDefault(), cancel())}
  onclick={(e) => e.target === dialog && cancel()}
>
  <form onsubmit={(e) => (e.preventDefault(), confirm())}>
    <div class="grip" aria-hidden="true"></div>
    <header>
      <h2 id="paperless-sheet-title">Send to Paperless</h2>
      <p class="doc">{title}</p>
    </header>
    <div class="body">
      {#if lists.note}
        <p class="note" role="status">{lists.note}</p>
      {:else if lists.loading && !lists.lists}
        <p class="note" role="status">Loading tags…</p>
      {/if}
      <MetaFields lists={lists.lists} bind:selection />
    </div>
    <div class="actions">
      <button type="button" onclick={cancel}>Cancel</button>
      <button type="submit" class="primary">{confirmLabel}</button>
    </div>
  </form>
</dialog>

<style>
  .sheet {
    width: min(560px, 100vw);
    max-width: 100vw;
    max-height: min(86dvh, 720px);
    margin: auto auto 0;
    padding: 0;
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 20px 20px 0 0;
    background: var(--panel);
    color: var(--text);
  }

  .sheet[open] {
    animation: sheet-in 0.2s ease-out;
  }

  @keyframes sheet-in {
    from {
      transform: translateY(40px);
      opacity: 0;
    }
  }

  .sheet::backdrop {
    background: rgb(0 0 0 / 55%);
  }

  form {
    display: flex;
    flex-direction: column;
    max-height: min(86dvh, 720px);
  }

  .grip {
    width: 40px;
    height: 4px;
    margin: 10px auto 0;
    border-radius: 2px;
    background: var(--panel-3);
  }

  header {
    padding: 10px 20px 0;
  }

  h2 {
    margin: 0;
    font-size: 17px;
  }

  .doc {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px 20px;
    overflow-y: auto;
  }

  .note {
    margin: 0;
    font-size: 12.5px;
    color: var(--muted);
  }

  .actions {
    display: flex;
    gap: 10px;
    padding: 12px 20px calc(12px + var(--safe-bottom));
    border-top: 1px solid var(--border);
  }

  .actions button {
    flex: 1;
  }
</style>
