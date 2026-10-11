import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaperlessHttpError, PaperlessUnreachableError } from '../src/lib/paperless';
import type { UploadResult } from '../src/lib/paperlessMeta';
import type { HistoryEntry } from '../src/lib/store/db';
import {
  createUploadQueue,
  idbQueueStore,
  retryDelay,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  type QueueDeps,
  type QueuedUpload,
  type QueueStore,
  type TaskOutcome,
} from '../src/lib/uploadQueue';

const config = { baseUrl: 'https://paperless.example.com', token: 't', tagIds: [] };
const selection = { tags: ['Bills'], tagIds: [], documentType: null, correspondent: null };

function memoryStore(): QueueStore & { items: Map<string, QueuedUpload> } {
  const items = new Map<string, QueuedUpload>();
  return {
    items,
    all: async () => [...items.values()],
    get: async (id) => items.get(id),
    put: async (item) => void items.set(item.id, item),
    delete: async (id) => void items.delete(id),
  };
}

const unreachable = () => new PaperlessUnreachableError('Could not reach the server');

function setup(send: (item: QueuedUpload) => Promise<UploadResult>) {
  const store = memoryStore();
  const history = new Map<string, HistoryEntry>();
  const events = new EventTarget();
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let online = true;
  let n = 0;
  const waitResult: TaskOutcome = { outcome: 'success', message: null, duplicate: false };
  const deps: QueueDeps = {
    store,
    send: vi.fn(async (_config, item) => send(item)),
    wait: vi.fn(async () => waitResult),
    record: (entry) => {
      const full = { ...entry, id: `e${++n}`, createdAt: n };
      history.set(full.id, full);
      return full;
    },
    save: vi.fn(async (entry: HistoryEntry, { onlyIfPresent = false } = {}) => {
      if (!onlyIfPresent || history.has(entry.id)) history.set(entry.id, entry);
    }),
    isOnline: () => online,
    now: () => Date.now(),
    events,
    page,
  };
  const queue = createUploadQueue(deps);
  const callbacks = {
    onUploaded: vi.fn(),
    onSettled: vi.fn(),
    onRejected: vi.fn(),
    onChanged: vi.fn(),
    onCountChange: vi.fn(),
  };
  return {
    queue,
    deps,
    store,
    history,
    events,
    page,
    callbacks,
    setOnline: (value: boolean) => (online = value),
    enqueue: (title = 'Doc') =>
      queue.enqueue({
        title,
        pages: 1,
        pdf: new Blob(['%PDF']),
        filename: `${title}.pdf`,
        selection,
        error: unreachable(),
      }),
  };
}

/** Let pending promise chains run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('retryDelay', () => {
  it('doubles from the base up to the maximum', () => {
    expect(retryDelay(1)).toBe(RETRY_BASE_MS);
    expect(retryDelay(2)).toBe(RETRY_BASE_MS * 2);
    expect(retryDelay(3)).toBe(RETRY_BASE_MS * 4);
    expect(retryDelay(30)).toBe(RETRY_MAX_MS);
  });
});

describe('upload queue', () => {
  it('keeps a queued upload as a History entry with its PDF', async () => {
    const t = setup(async () => ({ taskId: 'x', missing: [] }));
    const entry = await t.enqueue();
    expect(entry).toMatchObject({ kind: 'upload', queued: { attempts: 1 } });
    expect(entry.queued!.lastError).toMatch(/Could not reach/);
    expect(entry.outcome).toBeUndefined();
    expect(entry.pdf).toBeInstanceOf(Blob);
    expect(await t.queue.pendingCount()).toBe(1);
    const stored = t.store.items.get(entry.id)!;
    expect(stored.selection).toEqual(selection);
    expect('pdf' in stored.entry).toBe(false);
  });

  it('retries with exponential backoff while unreachable, then reports success', async () => {
    let reachable = false;
    const t = setup(async () => {
      if (!reachable) throw unreachable();
      return { taskId: 'task-9', missing: ['Gone'] };
    });
    const entry = await t.enqueue();
    t.queue.start({ getConfig: () => config, ...t.callbacks });
    await settle();
    // The start attempt failed: next one after the base delay.
    expect(t.deps.send).toHaveBeenCalledTimes(1);
    expect(t.queue.nextRetryIn()).toBe(RETRY_BASE_MS);

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
    expect(t.deps.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.deps.send).toHaveBeenCalledTimes(2);
    expect(t.queue.nextRetryIn()).toBe(RETRY_BASE_MS * 2);
    expect(t.history.get(entry.id)!.queued!.attempts).toBe(3);
    expect(t.callbacks.onChanged).toHaveBeenCalled();

    reachable = true;
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2);
    expect(t.deps.send).toHaveBeenCalledTimes(3);
    expect(t.callbacks.onUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ id: entry.id, outcome: 'pending', taskId: 'task-9' }),
      ['Gone'],
    );
    expect(t.callbacks.onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ id: entry.id, outcome: 'success' }),
      expect.objectContaining({ outcome: 'success' }),
    );
    const final = t.history.get(entry.id)!;
    expect(final.outcome).toBe('success');
    expect(final.queued).toBeUndefined();
    expect(await t.queue.pendingCount()).toBe(0);
    expect(t.callbacks.onCountChange).toHaveBeenLastCalledWith(0);
    expect(t.queue.nextRetryIn()).toBeNull();
  });

  it('retries at once when the browser comes back online, resetting the backoff', async () => {
    let reachable = false;
    const t = setup(async () => {
      if (!reachable) throw unreachable();
      return { taskId: 'x', missing: [] };
    });
    await t.enqueue();
    t.setOnline(false);
    t.queue.start({ getConfig: () => config, ...t.callbacks });
    await settle();
    // Known offline: no request at all.
    expect(t.deps.send).not.toHaveBeenCalled();

    t.setOnline(true);
    reachable = true;
    t.events.dispatchEvent(new Event('online'));
    await settle();
    expect(t.deps.send).toHaveBeenCalledTimes(1);
    expect(t.callbacks.onUploaded).toHaveBeenCalledTimes(1);
  });

  it('retries when the app comes to the foreground', async () => {
    let reachable = false;
    const t = setup(async () => {
      if (!reachable) throw unreachable();
      return { taskId: 'x', missing: [] };
    });
    await t.enqueue();
    t.queue.start({ getConfig: () => config, ...t.callbacks });
    await settle();
    reachable = true;
    t.page.visibilityState = 'hidden';
    t.page.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(t.deps.send).toHaveBeenCalledTimes(1);
    t.page.visibilityState = 'visible';
    t.page.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(t.deps.send).toHaveBeenCalledTimes(2);
    expect(await t.queue.pendingCount()).toBe(0);
  });

  it('stops a round at the first unreachable attempt and keeps order', async () => {
    const sent: string[] = [];
    const t = setup(async (item) => {
      sent.push(item.entry.title);
      throw unreachable();
    });
    await t.enqueue('first');
    await t.enqueue('second');
    t.queue.start({ getConfig: () => config, ...t.callbacks });
    await settle();
    expect(sent).toEqual(['first']);
  });

  it('drops an upload Paperless refuses and reports it', async () => {
    const t = setup(async () => {
      throw new PaperlessHttpError('Paperless returned 400: bad file', 400);
    });
    const entry = await t.enqueue();
    t.queue.start({ getConfig: () => config, ...t.callbacks });
    await settle();
    expect(t.callbacks.onRejected).toHaveBeenCalledWith(
      expect.objectContaining({ id: entry.id, outcome: 'failure' }),
      'Paperless returned 400: bad file',
    );
    expect(await t.queue.pendingCount()).toBe(0);
    expect(t.queue.nextRetryIn()).toBeNull();
  });

  it('waits for settings and does nothing after stop', async () => {
    const t = setup(async () => ({ taskId: 'x', missing: [] }));
    await t.enqueue();
    let current = { ...config, token: '' };
    const stop = t.queue.start({ getConfig: () => current, ...t.callbacks });
    await settle();
    expect(t.deps.send).not.toHaveBeenCalled();
    current = config;
    stop();
    t.events.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(t.deps.send).not.toHaveBeenCalled();
  });

  it('cancels and restores an upload', async () => {
    const t = setup(async () => {
      throw unreachable();
    });
    const entry = await t.enqueue();
    const item = await t.queue.cancel(entry.id);
    expect(item?.id).toBe(entry.id);
    expect(await t.queue.pendingCount()).toBe(0);
    expect(await t.queue.cancel(entry.id)).toBeNull();
    await t.queue.restore(item!);
    expect(await t.queue.pendingCount()).toBe(1);
  });

  it('queues an existing History entry in place', async () => {
    const t = setup(async () => ({ taskId: 'x', missing: [] }));
    const existing: HistoryEntry = {
      id: 'h1',
      title: 'Old',
      createdAt: 5,
      kind: 'pdf',
      pages: 2,
      bytes: 4,
      pdf: new Blob(['%PDF']),
    };
    t.history.set('h1', existing);
    const entry = await t.queue.enqueue({
      title: 'Old',
      pages: 2,
      pdf: existing.pdf!,
      filename: 'Old.pdf',
      selection,
      entry: existing,
    });
    expect(entry.id).toBe('h1');
    expect(t.history.get('h1')).toMatchObject({ kind: 'upload', queued: { attempts: 1 } });
    expect(t.history.size).toBe(1);
  });
});

describe('idbQueueStore', () => {
  it('stores, lists and deletes queued uploads with their PDF', async () => {
    vi.useRealTimers();
    const item: QueuedUpload = {
      id: 'q1',
      entry: { id: 'q1', title: 'A', createdAt: 1, kind: 'upload', pages: 1, bytes: 4 },
      pdf: new Blob(['%PDF']),
      filename: 'A.pdf',
      selection,
    };
    await idbQueueStore.put(item);
    expect((await idbQueueStore.all()).map((i) => i.id)).toEqual(['q1']);
    const back = await idbQueueStore.get('q1');
    expect(back?.selection).toEqual(selection);
    expect(back?.pdf.size).toBe(4);
    await idbQueueStore.delete('q1');
    expect(await idbQueueStore.all()).toEqual([]);
  });
});
