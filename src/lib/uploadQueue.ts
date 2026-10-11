/**
 * Offline upload queue. An upload that could not reach Paperless (no answer,
 * or a gateway error) is kept with its PDF and metadata and sent again when
 * the app is back online, comes to the foreground or starts, and on an
 * exponential backoff timer while it is open.
 *
 * The retry runs in the page, not in the service worker. Background Sync
 * would need a hand-written worker (vite-plugin-pwa's generateSW cannot route
 * a POST to a user-configured server), only works in Chromium, and replays
 * the request where the app cannot see the task id it returns, so History
 * could never learn the outcome.
 *
 * Queued PDFs live in their own small database: History drops the PDF of all
 * but its 15 newest entries, which must not lose a document still waiting.
 */
import { recordHistory, updateHistory, type HistoryEntry } from './history';
import { isConfigured, isRetryableError, waitForTask, type StoredOutcome } from './paperless';
import { uploadWithSelection, type UploadResult, type UploadSelection } from './paperlessMeta';
import type { PaperlessSettings } from './settings';

export interface QueuedUpload {
  /** The History entry's id. */
  id: string;
  /** The History entry without its PDF (kept in `pdf`). */
  entry: Omit<HistoryEntry, 'pdf'>;
  pdf: Blob;
  filename: string;
  selection: UploadSelection;
}

export interface QueueStore {
  all(): Promise<QueuedUpload[]>;
  get(id: string): Promise<QueuedUpload | undefined>;
  put(item: QueuedUpload): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface TaskOutcome {
  outcome: StoredOutcome;
  message: string | null;
  duplicate: boolean;
}

export interface QueueCallbacks {
  /** A queued document reached Paperless; `entry` is now `pending` with its task id. */
  onUploaded?: (entry: HistoryEntry, missing: string[]) => void;
  /** Paperless finished processing a document the queue sent. */
  onSettled?: (entry: HistoryEntry, result: TaskOutcome) => void;
  /** Paperless refused a queued document (an error retrying cannot fix). */
  onRejected?: (entry: HistoryEntry, message: string) => void;
  /** A queued entry changed (attempt count, last error) without leaving the queue. */
  onChanged?: (entry: HistoryEntry) => void;
  /** The number of queued uploads changed. */
  onCountChange?: (count: number) => void;
}

export interface StartOptions extends QueueCallbacks {
  /** The current settings, read at every attempt. */
  getConfig: () => PaperlessSettings;
}

export interface QueueInput {
  title: string;
  pages: number;
  pdf: Blob;
  filename: string;
  selection: UploadSelection;
  thumb?: Blob;
  /** Why the upload failed just now, shown in History. */
  error?: unknown;
  /** An existing History entry to queue instead of adding a new one. */
  entry?: HistoryEntry;
}

export interface QueueDeps {
  store: QueueStore;
  send: (config: PaperlessSettings, item: QueuedUpload) => Promise<UploadResult>;
  wait: (config: PaperlessSettings, taskId: string) => Promise<TaskOutcome>;
  record: (entry: Omit<HistoryEntry, 'id' | 'createdAt'>) => HistoryEntry;
  save: (entry: HistoryEntry, options: { onlyIfPresent?: boolean }) => Promise<void>;
  isOnline: () => boolean;
  now: () => number;
  /** Where `online` is announced (window). */
  events?: EventTarget | null;
  /** Where `visibilitychange` is announced (document). */
  page?: (EventTarget & { visibilityState?: string }) | null;
}

/** First retry after this long; doubled per failed round, up to the maximum. */
export const RETRY_BASE_MS = 15_000;
export const RETRY_MAX_MS = 10 * 60_000;

export function retryDelay(failures: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withPdf(item: QueuedUpload, patch: Partial<HistoryEntry>): HistoryEntry {
  const { queued: _queued, ...rest } = item.entry;
  void _queued;
  return { ...rest, pdf: item.pdf, ...patch };
}

export interface UploadQueue {
  enqueue(input: QueueInput): Promise<HistoryEntry>;
  /** Begin retrying; returns a function that stops. */
  start(options: StartOptions): () => void;
  /** Try every queued upload now. `reset` forgets the backoff. */
  flush(options?: { reset?: boolean }): Promise<void>;
  pendingCount(): Promise<number>;
  list(): Promise<QueuedUpload[]>;
  /** Take an upload out of the queue (e.g. its History entry was removed). */
  cancel(id: string): Promise<QueuedUpload | null>;
  /** Put a cancelled upload back (undo). */
  restore(item: QueuedUpload): Promise<void>;
  /** Milliseconds until the next timed retry, or null. For tests and status text. */
  nextRetryIn(): number | null;
}

export function createUploadQueue(deps: QueueDeps): UploadQueue {
  let options: StartOptions | null = null;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt: number | null = null;
  let running: Promise<void> | null = null;
  let again = false;

  const emitCount = async () => {
    if (!options?.onCountChange) return;
    const count = await pendingCount();
    options?.onCountChange?.(count);
  };

  async function pendingCount(): Promise<number> {
    try {
      return (await deps.store.all()).length;
    } catch {
      return 0;
    }
  }

  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
    timerAt = null;
  }

  function schedule(delay: number) {
    if (!options) return;
    clearTimer();
    timerAt = deps.now() + delay;
    timer = setTimeout(() => {
      timer = undefined;
      timerAt = null;
      void flush();
    }, delay);
  }

  /** One attempt; false when the server is still out of reach. */
  async function attempt(config: PaperlessSettings, item: QueuedUpload): Promise<boolean> {
    let result: UploadResult;
    try {
      result = await deps.send(config, item);
    } catch (error) {
      if (isRetryableError(error)) {
        const queued = {
          since: item.entry.queued?.since ?? deps.now(),
          attempts: (item.entry.queued?.attempts ?? 0) + 1,
          lastError: message(error),
        };
        const next: QueuedUpload = { ...item, entry: { ...item.entry, queued } };
        // Still queued unless it was cancelled meanwhile.
        if (await deps.store.get(item.id)) {
          await deps.store.put(next);
          const entry: HistoryEntry = { ...item.entry, queued, pdf: item.pdf };
          await deps.save(entry, { onlyIfPresent: true });
          options?.onChanged?.(entry);
        }
        return false;
      }
      await deps.store.delete(item.id);
      const entry = withPdf(item, { kind: 'upload', outcome: 'failure' });
      await deps.save(entry, { onlyIfPresent: true });
      options?.onRejected?.(entry, message(error));
      return true;
    }
    await deps.store.delete(item.id);
    const entry = withPdf(item, { kind: 'upload', outcome: 'pending', taskId: result.taskId });
    await deps.save(entry, { onlyIfPresent: true });
    options?.onUploaded?.(entry, result.missing);
    // Follow processing in the background; a status that cannot be read
    // leaves the entry pending for History to check later.
    void deps
      .wait(config, result.taskId)
      .then(async (outcome) => {
        const done: HistoryEntry = { ...entry, outcome: outcome.outcome };
        if (outcome.outcome !== 'pending') await deps.save(done, { onlyIfPresent: true });
        options?.onSettled?.(done, outcome);
      })
      .catch(() => {});
    return true;
  }

  async function run(): Promise<void> {
    const config = options?.getConfig();
    if (!config || !isConfigured(config)) return;
    let items: QueuedUpload[];
    try {
      items = await deps.store.all();
    } catch {
      return;
    }
    if (items.length === 0) {
      failures = 0;
      clearTimer();
      return;
    }
    // A browser that knows it is offline will be told when it is back.
    if (!deps.isOnline()) return;
    items.sort((a, b) => a.entry.createdAt - b.entry.createdAt);
    let changed = false;
    for (const item of items) {
      if (!options) break;
      const reached = await attempt(config, item);
      if (!reached) {
        // The server is away: the rest would only fail too.
        failures++;
        schedule(retryDelay(failures));
        break;
      }
      failures = 0;
      changed = true;
    }
    if (changed) await emitCount();
  }

  function flush({ reset = false } = {}): Promise<void> {
    if (reset) failures = 0;
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          clearTimer();
          await run();
        } while (again && options);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  const onOnline = () => void flush({ reset: true });
  const onVisible = () => {
    if (deps.page?.visibilityState === 'visible') void flush();
  };

  return {
    async enqueue(input) {
      const queued = {
        since: deps.now(),
        attempts: input.entry?.queued?.attempts ?? 1,
        lastError: input.error === undefined ? null : message(input.error),
      };
      const base = input.entry
        ? { ...input.entry, kind: 'upload' as const, pdf: input.pdf, queued }
        : null;
      if (base) {
        delete base.outcome;
        delete base.taskId;
      }
      const entry: HistoryEntry = base
        ? base
        : deps.record({
            title: input.title,
            kind: 'upload',
            pages: input.pages,
            bytes: input.pdf.size,
            pdf: input.pdf,
            thumb: input.thumb,
            queued,
          });
      if (base) await deps.save(entry, {});
      const { pdf: _pdf, ...rest } = entry;
      void _pdf;
      await deps.store.put({
        id: entry.id,
        entry: rest,
        pdf: input.pdf,
        filename: input.filename,
        selection: input.selection,
      });
      await emitCount();
      // It just failed: wait for the backoff (or `online`) before trying again.
      if (options && timer === undefined && !running) {
        failures = Math.max(failures, 1);
        schedule(retryDelay(failures));
      }
      return entry;
    },

    start(next) {
      options = next;
      deps.events?.addEventListener('online', onOnline);
      deps.page?.addEventListener('visibilitychange', onVisible);
      void flush().then(emitCount);
      return () => {
        if (options !== next) return;
        options = null;
        clearTimer();
        deps.events?.removeEventListener('online', onOnline);
        deps.page?.removeEventListener('visibilitychange', onVisible);
      };
    },

    flush,
    pendingCount,

    async list() {
      try {
        return await deps.store.all();
      } catch {
        return [];
      }
    },

    async cancel(id) {
      const item = (await deps.store.get(id).catch(() => undefined)) ?? null;
      if (item) {
        await deps.store.delete(id);
        await emitCount();
      }
      return item;
    },

    async restore(item) {
      await deps.store.put(item);
      await emitCount();
      if (options && timer === undefined && !running) schedule(retryDelay(Math.max(failures, 1)));
    },

    nextRetryIn() {
      return timerAt === null ? null : Math.max(0, timerAt - deps.now());
    },
  };
}

/* ---------------------------------------------------- IndexedDB store ---- */

const DB_NAME = 'doc-scanner-outbox';
const STORE = 'uploads';
const TIMEOUT_MS = 4000;

let db: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (db) return db;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    const timeout = setTimeout(() => reject(new Error('Storage did not respond')), TIMEOUT_MS);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => {
      clearTimeout(timeout);
      const connection = request.result;
      connection.onclose = () => (db = null);
      connection.onversionchange = () => {
        connection.close();
        db = null;
      };
      resolve(connection);
    };
    request.onerror = () => {
      clearTimeout(timeout);
      reject(request.error);
    };
  });
  opening.catch(() => (db = null));
  db = opening;
  return opening;
}

async function request<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const connection = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = connection.transaction(STORE, mode);
    const req = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
  });
}

export const idbQueueStore: QueueStore = {
  all: () => request<QueuedUpload[]>('readonly', (s) => s.getAll()),
  get: (id) => request<QueuedUpload | undefined>('readonly', (s) => s.get(id)),
  put: async (item) => void (await request('readwrite', (s) => s.put(item))),
  delete: async (id) => void (await request('readwrite', (s) => s.delete(id))),
};

/* -------------------------------------------------- the app's queue ---- */

const queue = createUploadQueue({
  store: idbQueueStore,
  send: (config, item) =>
    uploadWithSelection(config, item.pdf, item.filename, item.entry.title, item.selection),
  wait: (config, taskId) => waitForTask(config, taskId),
  record: recordHistory,
  save: updateHistory,
  isOnline: () => globalThis.navigator?.onLine !== false,
  now: Date.now,
  events: typeof window === 'undefined' ? null : window,
  page: typeof document === 'undefined' ? null : document,
});

/**
 * Keep an upload that could not reach Paperless and send it later. Adds a
 * History entry with `queued` set (or updates `input.entry`) and returns it.
 */
export const queueUpload = (input: QueueInput): Promise<HistoryEntry> => queue.enqueue(input);

/** Start retrying queued uploads (call once, at app start). Returns a stop function. */
export const startUploadQueue = (options: StartOptions): (() => void) => queue.start(options);

/** Retry now, ignoring the backoff (a "Retry" button). */
export const flushUploadQueue = (): Promise<void> => queue.flush({ reset: true });

export const pendingCount = (): Promise<number> => queue.pendingCount();

export const queuedUploads = (): Promise<QueuedUpload[]> => queue.list();

export const cancelQueued = (id: string): Promise<QueuedUpload | null> => queue.cancel(id);

export const restoreQueued = (item: QueuedUpload): Promise<void> => queue.restore(item);

/** Whether an upload error means "keep it and try later" rather than "tell the user". */
export { isRetryableError as shouldQueue };
