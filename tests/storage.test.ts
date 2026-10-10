import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSpec } from '../src/lib/pipeline';
import type { StoredPage } from '../src/lib/store/db';

/* Each test gets an empty database and fresh modules (the connection is module state). */
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  vi.stubGlobal('navigator', { storage: { persist: () => Promise.resolve(true) } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stored(id: string, order: number): StoredPage {
  return {
    id,
    order,
    source: new Blob([id]),
    width: 10,
    height: 10,
    spec: { quad: null } as unknown as PageSpec,
    detected: null,
  };
}

/** Another tab holding the database open at version 1, which blocks our upgrade to 2. */
async function oldTabWith(pages: StoredPage[]): Promise<IDBDatabase> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('doc-scanner', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('pages', { keyPath: 'id' });
      request.result.createObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve) => {
    const tx = db.transaction('pages', 'readwrite');
    for (const page of pages) tx.objectStore('pages').put(page);
    tx.oncomplete = () => resolve();
  });
  return db;
}

/** Let the 4 s storage timeout pass without waiting for it. */
async function pastTimeout<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(5000);
  return promise;
}

describe('storage', () => {
  it('reopens a connection the browser dropped', async () => {
    const db = await import('../src/lib/store/db');
    expect(await db.putPage(stored('a', 0))).toBe(true);
    // What iOS does after the app has been in the background.
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(() => {
      throw new DOMException('The database connection is closing.', 'InvalidStateError');
    });
    expect(await db.putPage(stored('b', 1))).toBe(true);
    expect((await db.loadPages())?.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('opens again when an open request never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const real = indexedDB.open.bind(indexedDB);
    // WebKit sometimes leaves the first open hanging forever.
    vi.spyOn(indexedDB, 'open')
      .mockImplementationOnce(() => ({}) as IDBOpenDBRequest)
      .mockImplementation(real);
    const db = await import('../src/lib/store/db');
    const write = db.putPage(stored('a', 0));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await write).toBe(true);
    expect((await db.loadPages())?.map((p) => p.id)).toEqual(['a']);
  });

  it('reports a write as failed when storage never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(indexedDB, 'open').mockImplementation(() => ({}) as IDBOpenDBRequest);
    const db = await import('../src/lib/store/db');
    const write = db.putPage(stored('a', 0));
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await write).toBe(false);
  });

  it('says so when another tab blocks the upgrade, and fails writes in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const blocker = await oldTabWith([]);
    const db = await import('../src/lib/store/db');
    const blocked = vi.fn();
    db.whenBlocked(blocked);
    const write = db.putPage(stored('a', 0));
    await vi.advanceTimersByTimeAsync(31_000);
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(await write).toBe(false);
    // Still waiting on the other tab, not given up: once it closes, saving works.
    blocker.close();
    await vi.advanceTimersByTimeAsync(10);
    expect(await db.putPage(stored('b', 0))).toBe(true);
  });

  it('tells "storage did not answer" apart from "nothing saved"', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const db = await import('../src/lib/store/db');
    expect(await db.loadPages()).toEqual([]);

    vi.resetModules();
    globalThis.indexedDB = new IDBFactory();
    const blocker = await oldTabWith([stored('old', 0)]);
    const late = await import('../src/lib/store/db');
    expect(await pastTimeout(late.loadPages())).toBeNull();
    blocker.close();
  });

  it('lands writes made while the database was slow to open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const blocker = await oldTabWith([]);
    const db = await import('../src/lib/store/db');
    const write = db.putPage(stored('new', 0));
    await vi.advanceTimersByTimeAsync(5000);
    blocker.close();
    expect(await write).toBe(true);
    expect((await db.loadPages())?.map((p) => p.id)).toEqual(['new']);
  });
});

describe('session restore', () => {
  it('puts saved pages back in front of new ones once slow storage answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const blocker = await oldTabWith([stored('old1', 0), stored('old2', 1)]);
    const { session } = await import('../src/lib/store/session.svelte');
    const db = await import('../src/lib/store/db');

    await pastTimeout(session.restore());
    expect(session.loaded).toBe(true);
    expect(session.pages).toEqual([]);
    const added = session.add({
      source: new Blob(['new']),
      width: 10,
      height: 10,
      spec: { quad: null } as unknown as PageSpec,
      detected: null,
      sharpness: null,
    });

    blocker.close();
    await vi.waitFor(() => expect(session.pages).toHaveLength(3));
    expect(session.pages.map((p) => p.id)).toEqual(['old1', 'old2', added.id]);
    await vi.waitFor(async () =>
      expect((await db.loadPages())?.map((p) => [p.id, p.order])).toEqual([
        ['old1', 0],
        ['old2', 1],
        [added.id, 2],
      ]),
    );
  });

  it('does not delete saved pages it never showed when the document is discarded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const blocker = await oldTabWith([stored('old', 0)]);
    const { session } = await import('../src/lib/store/session.svelte');
    const db = await import('../src/lib/store/db');

    await pastTimeout(session.restore());
    const added = session.add({
      source: new Blob(['new']),
      width: 10,
      height: 10,
      spec: { quad: null } as unknown as PageSpec,
      detected: null,
      sharpness: null,
    });
    session.clear();
    blocker.close();
    await vi.waitFor(() => expect(session.pages.map((p) => p.id)).toEqual(['old']));
    await vi.waitFor(async () =>
      expect((await db.loadPages())?.map((p) => p.id)).not.toContain(added.id),
    );
  });
});

/** A database left by the previous version, with photos stored inside the page records. */
async function version2With(pages: StoredPage[]): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('doc-scanner', 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('pages', { keyPath: 'id' });
      request.result.createObjectStore('meta');
      request.result.createObjectStore('history', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve) => {
    const tx = db.transaction('pages', 'readwrite');
    for (const page of pages) tx.objectStore('pages').put(page);
    tx.oncomplete = () => resolve();
  });
  db.close();
}

/** Everything in one object store, read directly. */
async function raw(store: string): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('doc-scanner');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const all = await new Promise<unknown[]>((resolve) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
  });
  db.close();
  return all;
}

/** Counts writes to the photo store. */
function countSourceWrites(): () => number {
  let writes = 0;
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    if (this.name === 'sources') writes++;
    return put.apply(this, args);
  });
  return () => writes;
}

function newPage() {
  return {
    source: new Blob(['photo']),
    width: 10,
    height: 10,
    spec: {
      quad: null,
      filter: 'color',
      adjustments: { brightness: 0, contrast: 0, threshold: 0, sharpen: 0 },
      rotation: 0,
    } as unknown as PageSpec,
    detected: null,
    sharpness: null,
  };
}

describe('photos stored apart from pages', () => {
  it('moves photos out of the page records of an older database', async () => {
    await version2With([stored('b', 1), stored('a', 0)]);
    const db = await import('../src/lib/store/db');
    const pages = await db.loadPages();
    expect(pages?.map((p) => p.id)).toEqual(['a', 'b']);
    expect(await pages![0].source.text()).toBe('a');
    const records = (await raw('pages')) as Record<string, unknown>[];
    expect(records).toHaveLength(2);
    for (const record of records) expect(record).not.toHaveProperty('source');
    expect(await raw('sources')).toHaveLength(2);
  });

  it('saves edits and reordering without rewriting photos, in batches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { session } = await import('../src/lib/store/session.svelte');
    const db = await import('../src/lib/store/db');
    await session.restore();
    const writes = countSourceWrites();
    const first = session.add(newPage());
    const second = session.add(newPage());
    await vi.waitFor(async () => expect(await db.loadPages()).toHaveLength(2));
    expect(writes()).toBe(2);

    for (let i = 1; i <= 21; i++) {
      session.update(first.id, { rotation: i % 4 } as Partial<PageSpec>);
    }
    session.moveTo(second.id, 0);
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(async () =>
      expect((await db.loadPages())?.map((p) => [p.id, p.order, p.spec.rotation])).toEqual([
        [second.id, 0, 0],
        [first.id, 1, 1],
      ]),
    );
    expect(writes()).toBe(2);
  });

  it('deletes photos with their pages', async () => {
    const { session } = await import('../src/lib/store/session.svelte');
    await session.restore();
    const page = session.add(newPage());
    session.add(newPage());
    session.remove(page.id);
    await vi.waitFor(async () => expect(await raw('sources')).toHaveLength(1));
    session.clear();
    await vi.waitFor(async () => expect(await raw('sources')).toHaveLength(0));
  });
});

describe('undo', () => {
  it('puts a deleted page back, photo included', async () => {
    const { session } = await import('../src/lib/store/session.svelte');
    const db = await import('../src/lib/store/db');
    await session.restore();
    const page = session.add(newPage());
    const undo = session.remove(page.id);
    undo();
    expect(session.pages.map((p) => p.id)).toEqual([page.id]);
    await vi.waitFor(async () =>
      expect((await db.loadPages())?.map((p) => p.id)).toEqual([page.id]),
    );
  });

  it('does not bring a page from a discarded document into the new one', async () => {
    const { session } = await import('../src/lib/store/session.svelte');
    await session.restore();
    const page = session.add(newPage());
    const undo = session.remove(page.id);
    session.clear();
    const fresh = session.add(newPage());
    undo();
    expect(session.pages.map((p) => p.id)).toEqual([fresh.id]);
  });

  it('restores each page’s own filter after applying one to all', async () => {
    const { session } = await import('../src/lib/store/session.svelte');
    await session.restore();
    const a = session.add(newPage());
    const b = session.add(newPage());
    session.update(b.id, { filter: 'bw' } as Partial<PageSpec>);
    const undo = session.applyToAll({ filter: 'document' } as Pick<PageSpec, 'filter'>);
    expect(session.pages.map((p) => p.spec.filter)).toEqual(['document', 'document']);
    session.update(a.id, { rotation: 1 } as Partial<PageSpec>);
    undo();
    expect(session.pages.map((p) => p.spec.filter)).toEqual(['color', 'bw']);
    expect(session.get(a.id)?.spec.rotation).toBe(1);
  });

  it('keeps a filter chosen after applying one to all when undoing', async () => {
    const { session } = await import('../src/lib/store/session.svelte');
    await session.restore();
    const a = session.add(newPage());
    const b = session.add(newPage());
    const undo = session.applyToAll({ filter: 'document' } as Pick<PageSpec, 'filter'>);
    session.update(b.id, { filter: 'gray' } as Partial<PageSpec>);
    undo();
    expect(session.get(a.id)?.spec.filter).toBe('color');
    expect(session.get(b.id)?.spec.filter).toBe('gray');
  });
});
