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
}

const DB_NAME = 'doc-scanner';
const DB_VERSION = 3;
const STORE = 'pages';
const SOURCES = 'sources';
const META = 'meta';
const HISTORY = 'history';
/** PDFs are kept for this many recent history entries. */
const KEEP_PDFS = 15;

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
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      attempts++;
      const request = indexedDB.open(DB_NAME, DB_VERSION);
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
      if (attempts < OPEN_ATTEMPTS) retry = setTimeout(attempt, OPEN_TIMEOUT_MS);
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

/**
 * Run one action in its own transaction over `stores`. Reads give up after
 * OPEN_TIMEOUT_MS so the app can start; writes wait for storage, so they
 * land once a slow open finishes. A lost connection is reopened once (every
 * action here is idempotent, so repeating it is safe).
 */
async function runAll<T>(
  stores: string[],
  mode: IDBTransactionMode,
  action: Action<T>,
  timeoutMs = mode === 'readonly' ? OPEN_TIMEOUT_MS : Infinity,
): Promise<T | undefined> {
  const bounded = (pending: Promise<IDBDatabase>) =>
    Number.isFinite(timeoutMs) ? withTimeout(pending, timeoutMs) : pending;
  const opened = connect();
  const db = await bounded(opened);
  try {
    return await attempt(db, stores, mode, action);
  } catch (error) {
    if (!connectionLost(error)) throw error;
    forget(opened);
    db.close();
    return attempt(await bounded(connect()), stores, mode, action);
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

export async function updateHistory(entry: HistoryEntry): Promise<void> {
  try {
    await run(HISTORY, 'readwrite', (s) => s.put(entry));
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
