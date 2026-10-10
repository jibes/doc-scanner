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
}

const DB_NAME = 'doc-scanner';
const STORE = 'pages';
const META = 'meta';

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(STORE, { keyPath: 'id' });
      db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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
