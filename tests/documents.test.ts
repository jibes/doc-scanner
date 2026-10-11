import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSpec } from '../src/lib/pipeline';
import type { HistoryEntry, StoredDocument, StoredPage } from '../src/lib/store/db';
import type { Page } from '../src/lib/store/session.svelte';

/* Each test gets an empty database and fresh modules (the connection is module state). */
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  vi.stubGlobal('navigator', { storage: { persist: () => Promise.resolve(true) } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const spec = {
  quad: null,
  filter: 'document',
  adjustments: { brightness: 0, contrast: 0, threshold: 0, sharpen: 0 },
  rotation: 1,
} as unknown as PageSpec;

function page(id: string, bytes = 4): Page {
  return {
    id,
    source: new Blob(['x'.repeat(bytes)]),
    width: 10,
    height: 20,
    spec,
    detected: null,
    sharpness: 0.5,
  };
}

function entry(id: string, createdAt: number): HistoryEntry {
  return { id, title: id, createdAt, kind: 'pdf', pages: 1, bytes: 1, pdf: null };
}

/** A database as version 3 of the app left it: pages, photos apart, a title and history. */
async function version3With(): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('doc-scanner', 3);
    request.onupgradeneeded = () => {
      const d = request.result;
      d.createObjectStore('pages', { keyPath: 'id' });
      d.createObjectStore('meta');
      d.createObjectStore('history', { keyPath: 'id' });
      d.createObjectStore('sources');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve) => {
    const tx = db.transaction(['pages', 'sources', 'meta', 'history'], 'readwrite');
    const record: Omit<StoredPage, 'source'> = {
      id: 'p1',
      order: 0,
      width: 10,
      height: 20,
      spec,
      detected: null,
    };
    tx.objectStore('pages').put(record);
    tx.objectStore('sources').put(new Blob(['photo']), 'p1');
    tx.objectStore('meta').put('Old title', 'title');
    tx.objectStore('history').put(entry('h1', 1));
    tx.oncomplete = () => resolve();
  });
  db.close();
}

describe('database version 4', () => {
  it('adds the documents store and keeps everything already saved', async () => {
    await version3With();
    const db = await import('../src/lib/store/db');
    const pages = await db.loadPages();
    expect(pages?.map((p) => p.id)).toEqual(['p1']);
    expect(await pages![0].source.text()).toBe('photo');
    expect(await db.loadTitle()).toBe('Old title');
    expect((await db.loadHistory()).map((e) => e.id)).toEqual(['h1']);
    expect(await db.storedDocumentIds()).toEqual(new Set());
    expect(
      await db.saveDocument({ id: 'h1', createdAt: 1, title: 't', pages: pages!, bytes: 5 }),
    ).toBe(true);
    expect(await db.storedDocumentIds()).toEqual(new Set(['h1']));
  });
});

describe('documents to prune', () => {
  const docs = (n: number, bytes = 10) =>
    Array.from({ length: n }, (_, i) => ({ id: `d${i}`, createdAt: i, bytes }));

  it('drops orphans, then the oldest beyond the count', () => {
    const all = docs(5);
    const entries = new Set(['d0', 'd1', 'd3', 'd4']);
    expect(db().documentsToPrune(all, { entries, keep: 2 }).sort()).toEqual(['d0', 'd1', 'd2']);
  });

  it('makes room for an incoming document, by count and by size', () => {
    const all = docs(3, 40);
    expect(db().documentsToPrune(all, { entries: null, keep: 3, incoming: 1 })).toEqual(['d0']);
    expect(
      db().documentsToPrune(all, { entries: null, keep: 10, maxBytes: 100, incoming: 50 }).sort(),
    ).toEqual(['d0', 'd1']);
  });

  it('never drops the protected one, nor anything when the history is unknown', () => {
    const all = docs(2);
    expect(db().documentsToPrune(all, { entries: new Set(), protect: 'd1' })).toEqual(['d0']);
    expect(db().documentsToPrune(all, { entries: null })).toEqual([]);
  });

  let module: typeof import('../src/lib/store/db') | null = null;
  function db() {
    return module!;
  }
  beforeEach(async () => {
    module = await import('../src/lib/store/db');
  });
});

describe('edit again', () => {
  it('keeps the pages of the most recent documents only', async () => {
    const db = await import('../src/lib/store/db');
    const history = await import('../src/lib/history');
    const kept: string[] = [];
    for (let i = 0; i < db.KEEP_DOCUMENTS + 2; i++) {
      const e = entry(`h${i}`, i);
      await db.addHistory(e);
      expect(await history.keepPages(e, [page(`p${i}`)])).toBe(true);
      kept.push(e.id);
    }
    expect([...(await db.storedDocumentIds())].sort()).toEqual(
      kept.slice(2).sort((a, b) => a.localeCompare(b)),
    );
  });

  it('does not keep a document larger than the budget', async () => {
    const db = await import('../src/lib/store/db');
    const big: StoredDocument = {
      id: 'big',
      createdAt: 1,
      title: 'big',
      pages: [],
      bytes: db.DOCUMENTS_MAX_BYTES + 1,
    };
    expect(await db.saveDocument(big)).toBe(false);
  });

  it('drops the pages of removed history entries', async () => {
    const db = await import('../src/lib/store/db');
    const history = await import('../src/lib/history');
    const e = entry('gone', 1);
    await db.addHistory(e);
    await history.keepPages(e, [page('p')]);
    await db.deleteHistory('gone');
    expect(await db.storedDocumentIds()).toEqual(new Set(['gone']));
    await db.pruneDocuments();
    expect(await db.storedDocumentIds()).toEqual(new Set());
  });

  it('opens kept pages as the document, in order, with their edits', async () => {
    const db = await import('../src/lib/store/db');
    const history = await import('../src/lib/history');
    const { session } = await import('../src/lib/store/session.svelte');
    await session.restore();
    session.add({ ...page('old'), spec: { ...spec, rotation: 0 } });
    const e = entry('h', 1);
    await db.addHistory(e);
    await history.keepPages(e, [page('a', 1), page('b', 2)]);

    const pages = await history.keptPages('h');
    expect(pages?.map((p) => p.source.size)).toEqual([1, 2]);
    const before = session.document;
    session.open(pages!, 'Reopened');
    expect(session.document).not.toBe(before);
    expect(session.title).toBe('Reopened');
    expect(session.pages.map((p) => p.source.size)).toEqual([1, 2]);
    expect(session.pages.every((p) => p.spec.rotation === 1)).toBe(true);
    // Saved as the current document, replacing the old page.
    await vi.waitFor(async () =>
      expect((await db.loadPages())?.map((p) => p.source.size)).toEqual([1, 2]),
    );
    expect(await db.loadTitle()).toBe('Reopened');
    expect(await history.keptPages('missing')).toBeNull();
  });
});
