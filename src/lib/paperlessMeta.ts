/**
 * Tags, document types and correspondents from Paperless: fetched, cached in
 * localStorage for offline use, and resolved from the names the settings and
 * the upload sheet store to the ids an upload needs.
 */
import {
  fetchList,
  isRetryableError,
  uploadDocument,
  type PaperlessItem,
  type UploadMeta,
} from './paperless';
import type { PaperlessSettings } from './settings';

export interface PaperlessLists {
  tags: PaperlessItem[];
  documentTypes: PaperlessItem[];
  correspondents: PaperlessItem[];
  /** When they were fetched (ms since epoch). */
  fetchedAt: number;
}

/**
 * What to file a document under, by name: names survive offline queueing and
 * a cache that is out of date, ids are looked up just before sending.
 */
export interface UploadSelection {
  tags: string[];
  documentType: string | null;
  correspondent: string | null;
  /** Legacy tag ids from the settings that no name is known for yet. */
  tagIds: number[];
}

/** Lists younger than this are used without asking Paperless again. */
export const META_TTL_MS = 10 * 60_000;

const KEY = 'doc-scanner.paperless-meta.v1';

interface CacheRecord {
  /** The server the lists belong to (never the token). */
  baseUrl: string;
  lists: PaperlessLists;
}

function serverKey(config: PaperlessSettings): string {
  return config.baseUrl.trim().replace(/\/+$/, '');
}

export function readCachedLists(config: PaperlessSettings): PaperlessLists | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<CacheRecord>;
    const lists = record.lists;
    if (record.baseUrl !== serverKey(config) || !lists) return null;
    if (
      !Array.isArray(lists.tags) ||
      !Array.isArray(lists.documentTypes) ||
      !Array.isArray(lists.correspondents) ||
      typeof lists.fetchedAt !== 'number'
    ) {
      return null;
    }
    return lists;
  } catch {
    return null;
  }
}

function writeCachedLists(config: PaperlessSettings, lists: PaperlessLists): void {
  try {
    const record: CacheRecord = { baseUrl: serverKey(config), lists };
    localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // Storage full or unavailable: the lists are just fetched again next time.
  }
}

export interface LoadedLists {
  lists: PaperlessLists;
  /** Served from the cache because Paperless could not be asked. */
  stale: boolean;
  /** Why Paperless could not be asked, when `stale`. */
  error: string | null;
}

export interface LoadOptions {
  /** Ask Paperless even if the cache is fresh. */
  force?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

/** In-flight requests per server, so the sheet and an upload share one. */
const inflight = new Map<string, Promise<PaperlessLists>>();

/**
 * The lists: from the cache while fresh, else from Paperless, else (offline,
 * or an error) from the cache however old. Throws only when there is neither.
 */
export async function loadLists(
  config: PaperlessSettings,
  { force = false, fetch: fetchImpl = fetch, now = Date.now }: LoadOptions = {},
): Promise<LoadedLists> {
  const cached = readCachedLists(config);
  if (!force && cached && now() - cached.fetchedAt < META_TTL_MS) {
    return { lists: cached, stale: false, error: null };
  }
  const key = serverKey(config);
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const [tags, documentTypes, correspondents] = await Promise.all([
        fetchList(config, 'tags', fetchImpl),
        fetchList(config, 'document_types', fetchImpl),
        fetchList(config, 'correspondents', fetchImpl),
      ]);
      const lists: PaperlessLists = { tags, documentTypes, correspondents, fetchedAt: now() };
      writeCachedLists(config, lists);
      return lists;
    })();
    inflight.set(key, pending);
    void pending.catch(() => {}).finally(() => inflight.delete(key));
  }
  try {
    return { lists: await pending, stale: false, error: null };
  } catch (error) {
    if (!cached) throw error;
    return {
      lists: cached,
      stale: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/* -------------------------------------------------------- selection ---- */

const same = (a: string, b: string) =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

export function findByName(items: readonly PaperlessItem[], name: string): PaperlessItem | null {
  return items.find((i) => i.name === name) ?? items.find((i) => same(i.name, name)) ?? null;
}

/**
 * The settings' defaults as a selection. Legacy tag ids are turned into names
 * where `lists` knows them.
 */
export function defaultSelection(
  config: PaperlessSettings,
  lists: PaperlessLists | null = null,
): UploadSelection {
  const tags = [...(config.tags ?? [])];
  const tagIds: number[] = [];
  for (const id of config.tagIds) {
    const tag = lists?.tags.find((t) => t.id === id);
    if (!tag) tagIds.push(id);
    else if (!tags.some((t) => same(t, tag.name))) tags.push(tag.name);
  }
  return {
    tags,
    documentType: config.documentType ?? null,
    correspondent: config.correspondent ?? null,
    tagIds,
  };
}

/** A selection with legacy ids turned into names where `lists` knows them. */
export function migrateSelection(
  selection: UploadSelection,
  lists: PaperlessLists,
): UploadSelection {
  return defaultSelection(
    {
      baseUrl: '',
      token: '',
      tags: selection.tags,
      tagIds: selection.tagIds,
      documentType: selection.documentType,
      correspondent: selection.correspondent,
    },
    lists,
  );
}

export function isEmptySelection(selection: UploadSelection): boolean {
  return (
    selection.tags.length === 0 &&
    selection.tagIds.length === 0 &&
    selection.documentType === null &&
    selection.correspondent === null
  );
}

export interface Resolved {
  meta: UploadMeta;
  /** Names Paperless no longer has (renamed or deleted); left out. */
  missing: string[];
}

/** Look the selection's names up. Unknown names are left out and reported. */
export function resolveSelection(selection: UploadSelection, lists: PaperlessLists): Resolved {
  const missing: string[] = [];
  const pick = (items: PaperlessItem[], name: string | null): number | null => {
    if (name === null) return null;
    const item = findByName(items, name);
    if (!item) missing.push(name);
    return item?.id ?? null;
  };
  const tags = new Set(selection.tagIds);
  for (const name of selection.tags) {
    const id = pick(lists.tags, name);
    if (id !== null) tags.add(id);
  }
  return {
    meta: {
      tags: [...tags],
      documentType: pick(lists.documentTypes, selection.documentType),
      correspondent: pick(lists.correspondents, selection.correspondent),
    },
    missing,
  };
}

export interface UploadResult {
  taskId: string;
  /** Selected names Paperless did not know; the document went without them. */
  missing: string[];
}

/**
 * Upload with a selection: look up the ids (cached lists are fine), then
 * send. Errors are those of `uploadDocument` and `loadLists`; check them
 * with `isRetryableError` to decide whether to queue.
 */
export async function uploadWithSelection(
  config: PaperlessSettings,
  pdf: Blob,
  filename: string,
  title: string,
  selection: UploadSelection,
  options: LoadOptions = {},
): Promise<UploadResult> {
  if (selection.tags.length === 0 && !selection.documentType && !selection.correspondent) {
    const meta: UploadMeta = { tags: selection.tagIds, documentType: null, correspondent: null };
    return { taskId: await uploadDocument(config, pdf, filename, title, meta), missing: [] };
  }
  let loaded: LoadedLists;
  try {
    loaded = await loadLists(config, options);
  } catch (error) {
    // Offline: worth queueing. Anything else (say the token may not read
    // tags) would fail the same way next time: send without the names.
    if (isRetryableError(error)) throw error;
    loaded = {
      lists: { tags: [], documentTypes: [], correspondents: [], fetchedAt: 0 },
      stale: true,
      error: null,
    };
  }
  let resolved = resolveSelection(selection, loaded.lists);
  // A name the cached lists lack may be new in Paperless: ask once more.
  if (resolved.missing.length > 0 && !options.force && !loaded.stale) {
    const fresh = await loadLists(config, { ...options, force: true }).catch(() => null);
    if (fresh && !fresh.stale) resolved = resolveSelection(selection, fresh.lists);
  }
  const { meta, missing } = resolved;
  return { taskId: await uploadDocument(config, pdf, filename, title, meta), missing };
}
