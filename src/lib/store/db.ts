import type { PageSpec } from '../pipeline';

/** A saved page. The source photo is kept; results are re-rendered. */
export interface StoredPage {
  id: string;
  order: number;
  source: Blob;
  width: number;
  height: number;
  spec: PageSpec;
  /** The detector's quad, so "reset crop" can return to it. */
  detected: PageSpec['quad'] | null;
  /** Older sessions have no sharpness. */
  sharpness?: number | null;
}

/**
 * What the pages store holds: everything but the photo. The multi-megabyte
 * source lives in its own store, keyed by page id, so that moving a slider
 * or reordering pages rewrites a few hundred bytes rather than every photo.
 */
export type PageRecord = Omit<StoredPage, 'source'>;

/** A finished document: saved/shared as a PDF, or uploaded to Paperless. */
export interface HistoryEntry {
  id: string;
  title: string;
  createdAt: number;
  kind: 'pdf' | 'upload';
  pages: number;
  bytes: number;
  /** Kept for the most recent entries only, so they can be shared again. */
  pdf: Blob | null;
  /** For uploads: how Paperless reported the result. */
  outcome?: 'success' | 'failure' | 'pending';
  /** For uploads: the Paperless consumption task, to look up a pending result later. */
  taskId?: string;
  /** A small JPEG of the first page, for the list. Older entries have none. */
  thumb?: Blob;
  /**
   * For uploads waiting in the offline queue (see uploadQueue.ts): set while
   * the server could not be reached, cleared once it took the file. Such an
   * entry has no `outcome` yet.
   */
  queued?: { since: number; attempts: number; lastError: string | null };
}

/**
 * The editable pages of a finished document, so it can be reopened from
 * History ("Edit again"). Keyed by the history entry's id.
 */
export interface StoredDocument {
  id: string;
  createdAt: number;
  title: string;
  pages: StoredPage[];
  /** Total size of the pages' photos. */
  bytes: number;
}

const DB_NAME = 'doc-scanner';
const DB_VERSION = 4;
const STORE = 'pages';
const SOURCES = 'sources';
const META = 'meta';
const HISTORY = 'history';
const DOCUMENTS = 'documents';
/** PDFs are kept for this many recent history entries. */
const KEEP_PDFS = 15;
/** Editable pages are kept for this many recent history entries... */
export const KEEP_DOCUMENTS = 10;
/** ...as long as their photos take no more than this together. */
export const DOCUMENTS_MAX_BYTES = 150 * 1024 * 1024;

let connection: Promise<IDBDatabase> | null = null;

/** If storage does not answer within this time, reads carry on without it. */
const OPEN_TIMEOUT_MS = 4000;

/** Open requests made before giving up on a connection that never answers. */
const OPEN_ATTEMPTS = 3;

/**
 * The shared connection, opened on first use. Opening can stall: another tab
 * holding an old version open blocks it until that tab closes, and WebKit
 * sometimes never answers an open at all. So the request is kept (a late
 * success still serves the calls waiting on it, writes included), and if
 * nothing answers within OPEN_TIMEOUT_MS another request is made alongside;
 * the first to succeed wins and the others are closed.
 */
function connect(): Promise<IDBDatabase> {
  if (connection) return connection;
  const current: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    let settled = false;
    let blocked = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // After the last attempt, an open that is not merely blocked by another
    // tab is given up on, so callers fail instead of waiting forever.
    const giveUp = () => {
      if (settled || blocked) return;
      settled = true;
      reject(new Error('Storage did not respond'));
    };
    const attempt = () => {
      attempts++;
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      // Another tab still runs an older version of the app and holds the
      // database open; the upgrade waits until that tab closes.
      request.onblocked = () => {
        if (blocked) return;
        blocked = true;
        onBlocked?.();
      };
      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (event.oldVersion < 1) {
          db.createObjectStore(STORE, { keyPath: 'id' });
          db.createObjectStore(META);
        }
        if (event.oldVersion < 2) db.createObjectStore(HISTORY, { keyPath: 'id' });
        if (event.oldVersion < 3) {
          db.createObjectStore(SOURCES);
          if (event.oldVersion >= 1) moveSourcesOut(request.transaction!);
        }
        if (event.oldVersion < 4) db.createObjectStore(DOCUMENTS, { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close();
          return;
        }
        settled = true;
        clearTimeout(retry);
        // The browser can drop the connection (iOS does after the app has
        // been in the background); another tab may need to upgrade the
        // schema. Either way, open a new one next time.
        db.onclose = () => forget(current);
        db.onversionchange = () => {
          db.close();
          forget(current);
        };
        resolve(db);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(retry);
        reject(request.error);
      };
      retry = setTimeout(attempts < OPEN_ATTEMPTS ? attempt : giveUp, OPEN_TIMEOUT_MS);
    };
    attempt();
  });
  // A failed open is retried next time rather than cached forever.
  current.catch(() => forget(current));
  connection = current;
  return current;
}

/** Version 3: pages saved with their photo inline get it moved to SOURCES. */
function moveSourcesOut(tx: IDBTransaction): void {
  const sources = tx.objectStore(SOURCES);
  const cursor = tx.objectStore(STORE).openCursor();
  cursor.onsuccess = () => {
    const at = cursor.result;
    if (!at) return;
    const { source, ...record } = at.value as StoredPage;
    if (source) {
      sources.put(source, record.id);
      at.update(record);
    }
    at.continue();
  };
}

let onBlocked: (() => void) | null = null;

/** Called once if opening waits on another tab running an older version. */
export function whenBlocked(listener: () => void): void {
  onBlocked = listener;
}

function forget(stale: Promise<IDBDatabase>): void {
  if (connection === stale) connection = null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Storage did not respond')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Errors meaning the connection itself is gone, not that the request was bad. */
function connectionLost(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'InvalidStateError' || error.name === 'UnknownError')
  );
}

type Action<T> = (tx: IDBTransaction) => IDBRequest<T> | void;

function attempt<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  action: Action<T>,
): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const request = action(tx);
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** How long a write waits for a slow open before it is reported as failed. */
const WRITE_TIMEOUT_MS = 30_000;

/**
 * Run one action in its own transaction over `stores`. Reads give up after
 * OPEN_TIMEOUT_MS so the app can start; writes wait longer, so they land
 * once a slow open finishes, but are reported as failed rather than hanging
 * when storage never answers. A lost connection is reopened once (every
 * action here is idempotent, so repeating it is safe).
 */
async function runAll<T>(
  stores: string[],
  mode: IDBTransactionMode,
  action: Action<T>,
  timeoutMs = mode === 'readonly' ? OPEN_TIMEOUT_MS : WRITE_TIMEOUT_MS,
): Promise<T | undefined> {
  const bounded = <V>(pending: Promise<V>) =>
    Number.isFinite(timeoutMs) ? withTimeout(pending, timeoutMs) : pending;
  const opened = connect();
  const db = await bounded(opened);
  try {
    // WebKit can also stall a transaction, not just the open.
    return await bounded(attempt(db, stores, mode, action));
  } catch (error) {
    if (!connectionLost(error)) throw error;
    forget(opened);
    db.close();
    return bounded(attempt(await bounded(connect()), stores, mode, action));
  }
}

/** One request against one store. */
function run<T>(
  store: string,
  mode: IDBTransactionMode,
  action: (s: IDBObjectStore) => IDBRequest<T> | void,
  timeoutMs?: number,
): Promise<T | undefined> {
  return runAll([store], mode, (tx) => action(tx.objectStore(store)), timeoutMs);
}

/*
 * Persistence is best effort throughout: a private window or a full disk must
 * not stop a scan, it only means the session will not survive a reload.
 */

/**
 * The saved pages in order, or null if storage could not be read (as opposed
 * to there being none). With `wait`, waits for a slow open to finish. A page
 * whose photo is missing cannot be shown and is left out.
 */
export async function loadPages(wait = false): Promise<StoredPage[] | null> {
  let records: PageRecord[] = [];
  let ids: IDBValidKey[] = [];
  let blobs: Blob[] = [];
  try {
    await runAll(
      [STORE, SOURCES],
      'readonly',
      (tx) => {
        const pages = tx.objectStore(STORE).getAll();
        pages.onsuccess = () => (records = pages.result as PageRecord[]);
        const keys = tx.objectStore(SOURCES).getAllKeys();
        keys.onsuccess = () => (ids = keys.result);
        const values = tx.objectStore(SOURCES).getAll();
        values.onsuccess = () => (blobs = values.result as Blob[]);
      },
      wait ? Infinity : OPEN_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
  const sources = new Map(ids.map((id, i) => [id, blobs[i]]));
  const pages: StoredPage[] = [];
  for (const record of records) {
    const source = sources.get(record.id);
    if (source) pages.push({ ...record, source });
  }
  return pages.sort((a, b) => a.order - b.order);
}

/** Save a page with its photo. Returns false if it could not be saved. */
export async function putPage(page: StoredPage): Promise<boolean> {
  const { source, ...record } = page;
  try {
    await runAll([STORE, SOURCES], 'readwrite', (tx) => {
      tx.objectStore(SOURCES).put(source, record.id);
      tx.objectStore(STORE).put(record);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Save the metadata (spec, order, ...) of pages whose photo is already
 * saved, in one transaction. Returns false if they could not be saved.
 */
export async function putRecords(records: PageRecord[]): Promise<boolean> {
  if (records.length === 0) return true;
  try {
    await runAll([STORE], 'readwrite', (tx) => {
      const store = tx.objectStore(STORE);
      for (const record of records) store.put(record);
    });
    return true;
  } catch {
    return false;
  }
}

export async function deletePages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await runAll([STORE, SOURCES], 'readwrite', (tx) => {
      for (const id of ids) {
        tx.objectStore(STORE).delete(id);
        tx.objectStore(SOURCES).delete(id);
      }
    });
  } catch {
    // See above.
  }
}

export function deletePage(id: string): Promise<void> {
  return deletePages([id]);
}

export async function clearPages(): Promise<void> {
  try {
    await runAll([STORE, SOURCES], 'readwrite', (tx) => {
      tx.objectStore(STORE).clear();
      tx.objectStore(SOURCES).clear();
    });
  } catch {
    // See above.
  }
}

export async function loadTitle(wait = false): Promise<string> {
  try {
    return (
      (await run<string>(
        META,
        'readonly',
        (s) => s.get('title'),
        wait ? Infinity : OPEN_TIMEOUT_MS,
      )) ?? ''
    );
  } catch {
    return '';
  }
}

export async function saveTitle(title: string): Promise<void> {
  try {
    await run(META, 'readwrite', (s) => s.put(title, 'title'));
  } catch {
    // See above.
  }
}

/* -------------------------------------------------------------- history ---- */

export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const entries = (await run<HistoryEntry[]>(HISTORY, 'readonly', (s) => s.getAll())) ?? [];
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/** Add an entry, dropping the stored PDF of all but the most recent ones. */
export async function addHistory(entry: HistoryEntry): Promise<void> {
  try {
    await run(HISTORY, 'readwrite', (s) => s.put(entry));
    const all = await loadHistory();
    for (const old of all.slice(KEEP_PDFS)) {
      if (old.pdf) await run(HISTORY, 'readwrite', (s) => s.put({ ...old, pdf: null }));
    }
  } catch {
    // See above.
  }
}

/**
 * Save an entry. With `onlyIfPresent`, an entry the user has removed in the
 * meantime stays removed (for results that arrive late).
 */
export async function updateHistory(
  entry: HistoryEntry,
  { onlyIfPresent = false } = {},
): Promise<void> {
  try {
    await run(HISTORY, 'readwrite', (s) => {
      if (!onlyIfPresent) return s.put(entry);
      const existing = s.getKey(entry.id);
      existing.onsuccess = () => {
        if (existing.result !== undefined) s.put(entry);
      };
    });
  } catch {
    // See above.
  }
}

export async function deleteHistory(id: string): Promise<void> {
  try {
    await run(HISTORY, 'readwrite', (s) => s.delete(id));
  } catch {
    // See above.
  }
}

/* ------------------------------------------------- editable documents ---- */

/**
 * Which stored documents to drop, oldest first: those whose history entry is
 * gone, then all beyond the newest `keep`, then the oldest until the rest
 * (plus `incoming` bytes about to be added) fit in `maxBytes`.
 */
export function documentsToPrune(
  stored: readonly Pick<StoredDocument, 'id' | 'createdAt' | 'bytes'>[],
  {
    entries,
    keep = KEEP_DOCUMENTS,
    maxBytes = DOCUMENTS_MAX_BYTES,
    incoming = 0,
    protect,
  }: {
    /** Ids of existing history entries; null when unknown (nothing counts as orphaned). */
    entries: ReadonlySet<string> | null;
    keep?: number;
    maxBytes?: number;
    /** Bytes of a document about to be stored (counted against the budget and one of `keep`). */
    incoming?: number;
    /** A document never to drop (the one being stored). */
    protect?: string;
  },
): string[] {
  const drop = new Set<string>();
  const newest = [...stored].sort((a, b) => b.createdAt - a.createdAt);
  let live = newest.filter((d) => {
    const orphan = entries !== null && d.id !== protect && !entries.has(d.id);
    if (orphan) drop.add(d.id);
    return !orphan;
  });
  const room = incoming > 0 ? keep - 1 : keep;
  for (const d of live.slice(Math.max(0, room))) if (d.id !== protect) drop.add(d.id);
  live = live.filter((d) => !drop.has(d.id));
  let total = incoming + live.reduce((sum, d) => sum + d.bytes, 0);
  for (let i = live.length - 1; i >= 0 && total > maxBytes; i--) {
    if (live[i].id === protect) continue;
    drop.add(live[i].id);
    total -= live[i].bytes;
  }
  return [...drop];
}

async function storedDocumentsMeta(): Promise<
  Pick<StoredDocument, 'id' | 'createdAt' | 'bytes'>[]
> {
  const all = (await run<StoredDocument[]>(DOCUMENTS, 'readonly', (s) => s.getAll())) ?? [];
  return all.map(({ id, createdAt, bytes }) => ({ id, createdAt, bytes }));
}

async function historyIds(): Promise<Set<string> | null> {
  try {
    const keys = (await run<IDBValidKey[]>(HISTORY, 'readonly', (s) => s.getAllKeys())) ?? [];
    return new Set(keys.map(String));
  } catch {
    return null;
  }
}

async function dropDocuments(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await runAll([DOCUMENTS], 'readwrite', (tx) => {
    for (const id of ids) tx.objectStore(DOCUMENTS).delete(id);
  });
}

/** Drop stored documents that are orphaned, too many or too large together. */
export async function pruneDocuments(
  options: { incoming?: number; protect?: string } = {},
): Promise<void> {
  try {
    const stored = await storedDocumentsMeta();
    await dropDocuments(documentsToPrune(stored, { entries: await historyIds(), ...options }));
  } catch {
    // See above.
  }
}

/**
 * Keep a finished document's pages, so it can be edited again. Older ones
 * make room; a document too large to keep at all is not kept. Returns
 * whether it was stored.
 */
export async function saveDocument(doc: StoredDocument): Promise<boolean> {
  if (doc.bytes > DOCUMENTS_MAX_BYTES || doc.pages.length === 0) return false;
  await pruneDocuments({ incoming: doc.bytes, protect: doc.id });
  try {
    await run(DOCUMENTS, 'readwrite', (s) => s.put(doc));
    return true;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'QuotaExceededError')) return false;
  }
  // The device is short of space: give up the other documents' pages for this one.
  try {
    const others = (await storedDocumentsMeta()).filter((d) => d.id !== doc.id);
    await dropDocuments(others.map((d) => d.id));
    await run(DOCUMENTS, 'readwrite', (s) => s.put(doc));
    return true;
  } catch {
    return false;
  }
}

export async function loadDocument(id: string): Promise<StoredDocument | null> {
  try {
    return (await run<StoredDocument>(DOCUMENTS, 'readonly', (s) => s.get(id))) ?? null;
  } catch {
    return null;
  }
}

/** Ids of the history entries whose pages are kept. */
export async function storedDocumentIds(): Promise<Set<string>> {
  try {
    const keys = (await run<IDBValidKey[]>(DOCUMENTS, 'readonly', (s) => s.getAllKeys())) ?? [];
    return new Set(keys.map(String));
  } catch {
    return new Set();
  }
}

export async function deleteDocument(id: string): Promise<void> {
  try {
    await dropDocuments([id]);
  } catch {
    // See above.
  }
}

/**
 * Ask the browser not to evict our data under storage pressure (Safari
 * otherwise may after 7 days without a visit). Best effort, asked once.
 */
let persistRequested = false;
export function requestPersistence(): void {
  if (persistRequested) return;
  persistRequested = true;
  void navigator.storage?.persist?.().catch(() => false);
}
