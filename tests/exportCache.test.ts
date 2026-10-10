import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSpec } from '../src/lib/pipeline';
import { DEFAULT_SETTINGS } from '../src/lib/settings';
import type { Page } from '../src/lib/store/session.svelte';

/** A worker that answers at once: export renders, and OCR finding no words. */
class FakeWorker {
  static all: FakeWorker[] = [];
  /** Whether OCR workers answer; off to let a test crash one first. */
  static ocrAnswers = true;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  posted: Record<string, unknown>[] = [];
  terminated = false;
  readonly ocr: boolean;

  constructor(url: URL) {
    this.ocr = String(url).includes('ocr.worker');
    FakeWorker.all.push(this);
  }

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
    const { id } = message;
    const answer =
      message.type === 'encode'
        ? {
            type: 'encoded',
            id,
            image: {},
            width: 20,
            height: 10,
            ocr: message.ocrEdge
              ? { data: new Uint8ClampedArray(4), width: 2, height: 1 }
              : undefined,
          }
        : message.type === 'ocr' && FakeWorker.ocrAnswers
          ? { type: 'words', id, words: [] }
          : null;
    if (answer) queueMicrotask(() => this.onmessage?.({ data: answer }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

const page: Page = {
  id: 'p',
  source: new Blob(['photo']),
  width: 10,
  height: 10,
  spec: { quad: null } as unknown as PageSpec,
  detected: null,
  sharpness: null,
};

function ocrWorkers() {
  return FakeWorker.all.filter((w) => w.ocr);
}

function encodes() {
  return FakeWorker.all.flatMap((w) => w.posted).filter((m) => m.type === 'encode');
}

/** The service worker's cache, holding `files` OCR model files. */
function cachedModels(files: number) {
  vi.stubGlobal('caches', {
    keys: () => Promise.resolve(['workbox-precache', 'ocr-models-1a2b']),
    open: () => Promise.resolve({ keys: () => Promise.resolve(new Array(files).fill({})) }),
  });
}

beforeEach(() => {
  FakeWorker.all = [];
  FakeWorker.ocrAnswers = true;
  vi.stubGlobal('Worker', FakeWorker);
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('export cache', () => {
  it('does not download OCR models in the background', async () => {
    cachedModels(1);
    const cache = await import('../src/lib/exportCache');
    cache.prefetchExports([page], DEFAULT_SETTINGS);
    await vi.waitFor(() => expect(encodes()).toHaveLength(1));
    expect(encodes()[0].ocrEdge).toBeUndefined();
    expect(ocrWorkers()).toHaveLength(0);

    // Saving a searchable PDF is what fetches them.
    const encoded = await cache.encodedPage(page, DEFAULT_SETTINGS, { text: true });
    expect(await encoded.words).toEqual([]);
    expect(encodes()).toHaveLength(2);
    expect(ocrWorkers()).toHaveLength(1);
  });

  it('reads pages in the background once the models are downloaded', async () => {
    cachedModels(3);
    const cache = await import('../src/lib/exportCache');
    cache.prefetchExports([page], DEFAULT_SETTINGS);
    await vi.waitFor(() => expect(ocrWorkers()).toHaveLength(1));
    const encoded = await cache.encodedPage(page, DEFAULT_SETTINGS, { text: true });
    expect(await encoded.words).toEqual([]);
    expect(encodes()).toHaveLength(1);
  });

  it('reads the page again after OCR failed, instead of keeping "no text"', async () => {
    const cache = await import('../src/lib/exportCache');
    FakeWorker.ocrAnswers = false;
    const first = await cache.encodedPage(page, DEFAULT_SETTINGS, { text: true });
    await vi.waitFor(() => expect(ocrWorkers()).toHaveLength(1));
    const [reader] = ocrWorkers();
    // The OCR worker crashes before answering.
    (reader as unknown as { onerror: (e: object) => void }).onerror({
      message: 'crashed',
      preventDefault: () => undefined,
    });
    expect(await first.words).toEqual([]);
    FakeWorker.ocrAnswers = true;
    const second = await cache.encodedPage(page, DEFAULT_SETTINGS, { text: true });
    expect(second.words).not.toBeNull();
    expect(await second.words).toEqual([]);
    expect(encodes()).toHaveLength(2);
  });

  it('closes the OCR worker after a minute unused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const cache = await import('../src/lib/exportCache');
    await (
      await cache.encodedPage(page, DEFAULT_SETTINGS, { text: true })
    ).words;
    const [reader] = ocrWorkers();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(reader.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reader.terminated).toBe(true);

    // And starts a new one when needed again.
    const again = { ...page, spec: { quad: null, rotation: 1 } as unknown as PageSpec };
    await (
      await cache.encodedPage(again, DEFAULT_SETTINGS, { text: true })
    ).words;
    expect(ocrWorkers()).toHaveLength(2);
  });
});
