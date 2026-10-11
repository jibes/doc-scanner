import { isConfigured, PaperlessUnreachableError } from './paperless';
import { loadLists, readCachedLists, type PaperlessLists } from './paperlessMeta';
import type { PaperlessSettings } from './settings';

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

/** Tags, types and correspondents for a picker: cached ones at once, then fresh ones. */
export class ListsState {
  lists = $state.raw<PaperlessLists | null>(null);
  loading = $state(false);
  /** Why the lists are old or missing, for the user. */
  note = $state<string | null>(null);
  #request = 0;

  async load(config: PaperlessSettings, force = false): Promise<void> {
    const request = ++this.#request;
    if (!isConfigured(config)) {
      this.lists = null;
      this.loading = false;
      this.note = 'Add the server URL and token to pick tags.';
      return;
    }
    this.lists = readCachedLists(config);
    this.loading = true;
    this.note = null;
    try {
      const result = await loadLists(config, { force });
      if (request !== this.#request) return;
      this.lists = result.lists;
      this.note = result.stale
        ? `Offline: showing the lists from ${timeFormat.format(result.lists.fetchedAt)}.`
        : null;
    } catch (error) {
      if (request !== this.#request) return;
      this.note =
        error instanceof PaperlessUnreachableError
          ? 'Could not reach Paperless to load tags. “Test connection” shows why.'
          : `Could not load tags: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (request === this.#request) this.loading = false;
    }
  }
}
