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
