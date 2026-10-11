<script lang="ts">
  import type { PaperlessLists, UploadSelection } from '../lib/paperlessMeta';
  import ChipSelect from './ChipSelect.svelte';

  interface Props {
    lists: PaperlessLists | null;
    selection: UploadSelection;
    disabled?: boolean;
  }

  let { lists, selection = $bindable(), disabled = false }: Props = $props();

  const loaded = $derived(lists !== null);
  const one = (name: string | null) => (name === null ? [] : [name]);
  const first = (names: string[]) => names[0] ?? null;
</script>

<div class="meta">
  <ChipSelect
    label="Tags"
    noun="tag"
    items={lists?.tags ?? []}
    multiple
    {loaded}
    {disabled}
    bind:value={() => selection.tags, (tags) => (selection = { ...selection, tags })}
  />
  {#if selection.tagIds.length > 0}
    <p class="legacy">
      Also tag ids
      {#each selection.tagIds as id (id)}
        <button
          type="button"
          class="chip"
          {disabled}
          aria-label="Remove tag id {id}"
          onclick={() =>
            (selection = { ...selection, tagIds: selection.tagIds.filter((t) => t !== id) })}
          >#{id} <span aria-hidden="true">×</span></button
        >
      {/each}
      <span>{lists ? '(not in Paperless any more)' : '(names not loaded yet)'}</span>
    </p>
  {/if}
  <ChipSelect
    label="Document type"
    noun="document type"
    items={lists?.documentTypes ?? []}
    {loaded}
    {disabled}
    bind:value={
      () => one(selection.documentType),
      (names) => (selection = { ...selection, documentType: first(names) })
    }
  />
  <ChipSelect
    label="Correspondent"
    noun="correspondent"
    items={lists?.correspondents ?? []}
    {loaded}
    {disabled}
    bind:value={
      () => one(selection.correspondent),
      (names) => (selection = { ...selection, correspondent: first(names) })
    }
  />
</div>

<style>
  .meta {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .legacy {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: -8px 0 0;
    font-size: 12.5px;
    color: var(--muted);
  }

  .legacy .chip {
    padding: 4px 10px;
    min-height: 30px;
  }
</style>
