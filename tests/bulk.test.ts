import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PdfPage } from '../src/lib/pdf/writer';
import type { PageSpec } from '../src/lib/pipeline';
import { DEFAULT_SETTINGS } from '../src/lib/settings';
import type { Page } from '../src/lib/store/session.svelte';

/** The PDFs built, as the page images they were given. */
const built: PdfPage[][] = [];
vi.mock('../src/lib/pdf/writer', () => ({
  buildPdf: (pages: PdfPage[]) => {
    built.push(pages);
    return new Blob(['%PDF']);
  },
}));

/** An export worker that renders a page into an "image" naming the page it was given. */
class FakeWorker {
  /** Rendering waits for this, so a test can edit pages mid-export. */
  static gate: Promise<void> = Promise.resolve();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;

  postMessage(message: Record<string, unknown>): void {
    if (message.type !== 'encode') return;
    const spec = message.spec as PageSpec;
    const answer = {
      type: 'encoded',
      id: message.id,
      image: { page: message.pageId, rotation: spec.rotation, filter: spec.filter },
      width: 20,
      height: 10,
    };
    void FakeWorker.gate.then(() => this.onmessage?.({ data: answer }));
  }

  terminate(): void {}
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  vi.stubGlobal('navigator', { storage: { persist: () => Promise.resolve(true) } });
  vi.stubGlobal('Worker', FakeWorker);
  FakeWorker.gate = Promise.resolve();
  built.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function newPage(name: string): Omit<Page, 'id'> {
  return {
    source: new Blob([name]),
    width: 10,
    height: 10,
    spec: {
      quad: [
        [2, 2],
        [8, 2],
        [8, 8],
        [2, 8],
      ],
      filter: 'color',
      adjustments: { brightness: 0, contrast: 0, threshold: 0, sharpen: 0 },
      rotation: 0,
    } as unknown as PageSpec,
    detected: null,
    sharpness: null,
  };
}

async function fourPages() {
  const { session } = await import('../src/lib/store/session.svelte');
  await session.restore();
  const pages = ['a', 'b', 'c', 'd'].map((n) => session.add(newPage(n)));
  const names = () =>
    session.pages.map((p) => ['a', 'b', 'c', 'd'][pages.findIndex((q) => q.id === p.id)]);
  return { session, pages, names };
}

describe('bulk page actions', () => {
  it('deletes several pages and puts each back where it was', async () => {
    const { session, pages, names } = await fourPages();
    const db = await import('../src/lib/store/db');
    const undo = session.removeMany([pages[3].id, pages[1].id]);
    expect(names()).toEqual(['a', 'c']);
    await vi.waitFor(async () => expect(await db.loadPages()).toHaveLength(2));
    undo();
    expect(names()).toEqual(['a', 'b', 'c', 'd']);
    // Photos included.
    await vi.waitFor(async () => expect(await db.loadPages()).toHaveLength(4));
    // A second undo changes nothing.
    undo();
    expect(names()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rotates and filters several pages, and undoes only what was not edited since', async () => {
    const { session, pages } = await fourPages();
    const [a, b, c] = pages.map((p) => p.id);
    const undoRotate = session.updateMany([a, b], (s) => ({ rotation: (s.rotation + 1) % 4 }));
    expect(session.pages.map((p) => p.spec.rotation)).toEqual([1, 1, 0, 0]);
    // Turned by hand: auto-orientation must leave it alone.
    expect(session.get(a)?.spec.oriented).toBe(true);
    const undoFilter = session.updateMany([b, c], () => ({ filter: 'bw' }) as Partial<PageSpec>);
    expect(session.pages.map((p) => p.spec.filter)).toEqual(['color', 'bw', 'bw', 'color']);
    session.update(c, { filter: 'gray' } as Partial<PageSpec>);
    undoFilter();
    expect(session.pages.map((p) => p.spec.filter)).toEqual(['color', 'color', 'gray', 'color']);
    // Turned again by hand since: that page keeps its turn.
    session.update(a, { rotation: 2 });
    undoRotate();
    expect(session.pages.map((p) => p.spec.rotation)).toEqual([2, 0, 0, 0]);
  });

  it('moves pages to the start or end in their order, and back', async () => {
    const { session, pages, names } = await fourPages();
    const undoEnd = session.moveMany([pages[0].id, pages[2].id], 'end');
    expect(names()).toEqual(['b', 'd', 'a', 'c']);
    undoEnd();
    expect(names()).toEqual(['a', 'b', 'c', 'd']);
    session.moveMany([pages[3].id, pages[2].id], 'start');
    expect(names()).toEqual(['c', 'd', 'a', 'b']);
  });

  it('offers no undo across documents', async () => {
    const { session, pages } = await fourPages();
    const undo = session.removeMany([pages[0].id]);
    session.clear();
    undo();
    expect(session.pages).toEqual([]);
  });
});

describe('split', () => {
  it('exports the selected pages alone, then takes them out of the document', async () => {
    const { session, pages, names } = await fourPages();
    const { exportPdf } = await import('../src/lib/export');
    const ids = new Set([pages[1].id, pages[2].id]);
    const selected = () => session.pages.filter((p) => ids.has(p.id));
    await exportPdf(selected(), DEFAULT_SETTINGS, 'Part 2', () => {}, { latest: selected });
    expect(built[0].map((p) => (p.image as unknown as { page: string }).page)).toEqual([
      pages[1].id,
      pages[2].id,
    ]);
    const undo = session.removeMany(ids);
    expect(names()).toEqual(['a', 'd']);
    undo();
    expect(names()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('export while editing', () => {
  it('re-does a page edited while the export runs, and follows reordering', async () => {
    const { session, pages } = await fourPages();
    const { exportPdf } = await import('../src/lib/export');
    let open!: () => void;
    FakeWorker.gate = new Promise((resolve) => (open = resolve));
    const running = exportPdf(session.pages, DEFAULT_SETTINGS, 'Doc', () => {}, {
      latest: () => session.pages,
    });
    session.update(pages[1].id, { rotation: 3 } as Partial<PageSpec>);
    session.moveTo(pages[3].id, 0);
    open();
    await running;
    const images = built[0].map((p) => p.image as unknown as { page: string; rotation: number });
    expect(images.map((i) => i.page)).toEqual([pages[3].id, pages[0].id, pages[1].id, pages[2].id]);
    expect(images[2].rotation).toBe(3);
  });

  it('stops when cancelled, or when the document is discarded', async () => {
    const { session } = await fourPages();
    const { exportPdf } = await import('../src/lib/export');
    const controller = new AbortController();
    let open!: () => void;
    FakeWorker.gate = new Promise((resolve) => (open = resolve));
    const cancelled = exportPdf(session.pages, DEFAULT_SETTINGS, 'Doc', () => {}, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    const document = session.document;
    const discarded = exportPdf(session.pages, DEFAULT_SETTINGS, 'Doc', () => {}, {
      latest: () => (session.document === document ? session.pages : []),
    });
    session.clear();
    open();
    await expect(discarded).rejects.toMatchObject({ name: 'AbortError' });
    expect(built).toHaveLength(0);
  });
});
