<script lang="ts">
  import type { PaperlessItem } from '../lib/paperless';
  import { findByName } from '../lib/paperlessMeta';

  interface Props {
    /** Field name, e.g. "Tags". */
    label: string;
    /** Singular noun for button labels, e.g. "tag". */
    noun: string;
    items: readonly PaperlessItem[];
    /** Selected names. */
    value: string[];
    /** Pick several (tags) or at most one (type, correspondent). */
    multiple?: boolean;
    /** Whether `items` is known, so unknown names can be flagged. */
    loaded?: boolean;
    disabled?: boolean;
    /** Shown when nothing is selected. */
    emptyLabel?: string;
  }

  let {
    label,
    noun,
    items,
    value = $bindable(),
    multiple = false,
    loaded = true,
    disabled = false,
    emptyLabel = 'None',
  }: Props = $props();

  const uid = $props.id();
  let query = $state('');

  /** Few options when browsing, more when searching. */
  const LIMIT_BROWSE = 12;
  const LIMIT_SEARCH = 40;

  const normalised = (s: string) => s.toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

  const matches = $derived.by(() => {
    const q = normalised(query.trim());
    if (!q) return items;
    const starts: PaperlessItem[] = [];
    const contains: PaperlessItem[] = [];
    for (const item of items) {
      const name = normalised(item.name);
      if (name.startsWith(q)) starts.push(item);
      else if (name.includes(q)) contains.push(item);
    }
    return [...starts, ...contains];
  });
  const limit = $derived(query.trim() ? LIMIT_SEARCH : LIMIT_BROWSE);
  const shown = $derived(matches.slice(0, limit));

  const isSelected = (name: string) => value.some((v) => v === name);

  function toggle(item: PaperlessItem) {
    if (isSelected(item.name)) value = value.filter((v) => v !== item.name);
    else value = multiple ? [...value, item.name] : [item.name];
  }

  function remove(name: string) {
    value = value.filter((v) => v !== name);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      // Enter picks the best match instead of submitting the form.
      event.preventDefault();
      const first = matches[0];
      if (first && !isSelected(first.name)) toggle(first);
      query = '';
    } else if (event.key === 'Escape' && query) {
      // Clear the search rather than closing the dialog.
      event.preventDefault();
      event.stopPropagation();
      query = '';
    }
  }

  function colours(name: string) {
    return findByName(items, name);
  }
</script>

<div class="pick" role="group" aria-labelledby="{uid}-label">
  <div class="head">
    <span id="{uid}-label" class="label">{label}</span>
    {#if value.length === 0}<span class="none">{emptyLabel}</span>{/if}
  </div>
  {#if value.length > 0}
    <ul class="selected" aria-label="Selected {label.toLocaleLowerCase()}">
      {#each value as name (name)}
        {@const item = colours(name)}
        <li>
          <button
            type="button"
            class="chip on"
            class:missing={loaded && !item}
            style:--chip-bg={item?.color}
            style:--chip-fg={item?.textColor}
            onclick={() => remove(name)}
            {disabled}
            aria-label="Remove {noun} {name}"
            title={loaded && !item ? `${name} is not in Paperless any more` : undefined}
          >
            <span>{name}</span><span class="x" aria-hidden="true">×</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if items.length > 0}
    <input
      type="search"
      class="search"
      bind:value={query}
      onkeydown={onKeydown}
      placeholder="Search {label.toLocaleLowerCase()}"
      aria-label="Search {label.toLocaleLowerCase()}"
      aria-controls="{uid}-options"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      {disabled}
    />
    <div class="options" id="{uid}-options" role="group" aria-label="Available {noun}s">
      {#each shown as item (item.id)}
        {@const on = isSelected(item.name)}
        <button
          type="button"
          class="chip option"
          class:on
          class:tinted={!!item.color}
          style:--chip-bg={item.color}
          style:--chip-fg={item.textColor}
          aria-pressed={on}
          onclick={() => toggle(item)}
          {disabled}
        >
          {item.name}
        </button>
      {:else}
        <span class="hint">No {noun} matches “{query}”.</span>
      {/each}
      {#if matches.length > shown.length}
        <span class="hint">+{matches.length - shown.length} more — type to narrow down</span>
      {/if}
    </div>
  {/if}
</div>

<style>
  .pick {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .label {
    font-size: 13px;
    color: var(--muted);
  }

  .none {
    font-size: 12.5px;
    color: var(--muted);
  }

  .selected,
  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .options {
    max-height: 168px;
    overflow-y: auto;
    padding: 2px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 13px;
    max-width: 100%;
  }

  .chip span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip.option.tinted::before {
    content: '';
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--chip-bg);
    flex: 0 0 auto;
  }

  .chip.on {
    background: var(--chip-bg, var(--accent));
    border-color: var(--chip-bg, var(--accent));
    color: var(--chip-fg, #fff);
  }

  .chip.option.on::before {
    background: var(--chip-fg, #fff);
  }

  .chip.on:hover:not(:disabled) {
    background: var(--chip-bg, var(--accent-strong));
    filter: brightness(0.92);
  }

  .chip.missing {
    background: transparent;
    color: var(--warn);
    border: 1px dashed var(--warn);
  }

  .x {
    font-size: 16px;
    line-height: 1;
    opacity: 0.8;
  }

  .search {
    font: inherit;
    font-size: 15px;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 9px 12px;
    min-width: 0;
  }

  .hint {
    align-self: center;
    font-size: 12.5px;
    color: var(--muted);
    padding: 4px 2px;
  }
</style>
