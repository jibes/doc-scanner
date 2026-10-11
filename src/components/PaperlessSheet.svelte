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
  import Icon from './Icon.svelte';
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
      <span class="mark" aria-hidden="true"><Icon name="leaf" size={20} /></span>
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
      <button type="button" class="ghost" onclick={cancel}>Cancel</button>
      <button type="submit" class="primary">{confirmLabel}</button>
    </div>
  </form>
</dialog>

<style>
  .sheet {
    width: min(560px, 100vw);
    max-width: 100vw;
    max-height: min(88dvh, 720px);
    margin: auto auto 0;
    padding: 0;
    border: none;
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-3);
  }

  @media (min-width: 600px) {
    .sheet {
      margin: auto;
      border-radius: var(--r-xl);
    }
  }

  .sheet[open] {
    animation: sheet-in var(--dur-3) var(--ease);
  }

  @keyframes sheet-in {
    from {
      transform: translateY(32px);
      opacity: 0;
    }
  }

  .sheet::backdrop {
    background: var(--scrim);
  }

  form {
    display: flex;
    flex-direction: column;
    max-height: min(88dvh, 720px);
  }

  .grip {
    width: 36px;
    height: 4px;
    margin: var(--s-2) auto 0;
    border-radius: 2px;
    background: var(--fill-strong);
  }

  header {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: var(--s-3);
    align-items: center;
    padding: var(--s-4) var(--s-6) var(--s-1);
  }

  .mark {
    grid-row: span 2;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--fill);
    color: var(--text);
  }

  h2 {
    margin: 0;
    font-size: var(--fs-large);
    font-weight: 650;
  }

  .doc {
    margin: 0;
    color: var(--text-2);
    font-size: var(--fs-caption);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    padding: var(--s-4) var(--s-6);
    overflow-y: auto;
  }

  .note {
    margin: 0;
    font-size: var(--fs-caption);
    color: var(--text-2);
  }

  .actions {
    display: flex;
    gap: var(--s-2);
    padding: var(--s-3) var(--s-6) calc(var(--s-4) + var(--safe-bottom));
    border-top: 1px solid var(--line);
  }

  .actions button {
    flex: 1;
    min-height: 48px;
  }

  .actions .primary {
    flex: 2;
  }
</style>
