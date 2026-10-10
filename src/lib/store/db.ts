import type { PageSpec } from '../pipeline';

/** What is persisted per page. The source photo is kept; results are re-rendered. */
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
}

const DB_NAME = 'doc-scanner';
const DB_VERSION = 2;
const STORE = 'pages';
const META = 'meta';
const HISTORY = 'history';
/** PDFs are kept for this many recent history entries. */
const KEEP_PDFS = 15;

let opening: Promise<IDBDatabase> | null = null;

/** If storage does not answer within this time, carry on without it. */
const OPEN_TIMEOUT_MS = 4000;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    // Opening can stall indefinitely (another tab holding an old version
    // open, a pending delete). The app must still start.
    const timer = setTimeout(() => reject(new Error('Storage did not respond')), OPEN_TIMEOUT_MS);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore(STORE, { keyPath: 'id' });
        db.createObjectStore(META);
      }
      if (event.oldVersion < 2) db.createObjectStore(HISTORY, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error);
    };
  });
  // A failed open is retried next time rather than cached forever.
  opening.catch(() => (opening = null));
  return opening;
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  action: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = action(tx.objectStore(store));
        tx.oncomplete = () => resolve(request ? request.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

/*
 * Persistence is best effort throughout: a private window or a full disk must
 * not stop a scan, it only means the session will not survive a reload.
 */

export async function loadPages(): Promise<StoredPage[]> {
  try {
    const pages = (await run<StoredPage[]>(STORE, 'readonly', (s) => s.getAll())) ?? [];
    return pages.sort((a, b) => a.order - b.order);
  } catch {
    return [];
  }
}

export async function putPage(page: StoredPage): Promise<void> {
  try {
    await run(STORE, 'readwrite', (s) => s.put(page));
  } catch {
    // See above.
  }
}

export async function deletePage(id: string): Promise<void> {
  try {
    await run(STORE, 'readwrite', (s) => s.delete(id));
  } catch {
    // See above.
  }
}

export async function clearPages(): Promise<void> {
  try {
    await run(STORE, 'readwrite', (s) => s.clear());
  } catch {
    // See above.
  }
}

export async function loadTitle(): Promise<string> {
  try {
    return (await run<string>(META, 'readonly', (s) => s.get('title'))) ?? '';
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
