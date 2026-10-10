import type { OcrWord } from './ocr/paddle';
import type { PdfImage } from './pdf/writer';
import { renderKey } from './renderCache';
import { renderJob } from './services';
import { RESOLUTION_LONG_EDGE, type AppSettings } from './settings';
import type { Page } from './store/session.svelte';
import { OcrClient, ProcessorClient } from './worker/clients';

export interface EncodedPage {
  image: PdfImage;
  width: number;
  height: number;
  /**
   * Recognised words in the encoded image's pixels, once OCR has run. The
   * promise resolves to [] if OCR fails: a PDF without a text layer is still
   * a good PDF. Null when the text was not asked for.
   */
  words: Promise<OcrWord[]> | null;
}

/** Long edge of the page image handed to OCR: text lines come out ~35 px tall. */
const OCR_EDGE = 2600;

/** The OCR worker holds its models in memory; it is closed after this long unused. */
const OCR_IDLE_MS = 60_000;

/** The service worker's cache for the OCR models (vite.config.ts), by name prefix. */
const OCR_CACHE = 'ocr-models';
/** Files the OCR models consist of: detection, recognition and the dictionary. */
const OCR_FILES = 3;

/*
 * Export-quality pages, prepared in the background while the user reviews the
 * document, so that "PDF" and "Upload" only have to assemble the file.
 *
 * A dedicated worker does this, so interactive previews are never queued
 * behind a multi-second export render, and it pauses while the camera is in
 * use so detection has the CPU to itself. OCR runs in a third worker right
 * after each page is rendered, in the background only once its models are
 * downloaded: the first download (~13 MB, maybe over cellular) waits until
 * the user saves a PDF, since an upload does not need it.
 */

let exporter: ProcessorClient | null = null;
let reader: OcrClient | null = null;
let reading = 0;
let readerIdle: ReturnType<typeof setTimeout> | undefined;
const ready = new Map<string, EncodedPage>();
const inFlight = new Map<string, Promise<EncodedPage>>();
let paused = false;
let generation = 0;

function worker(): ProcessorClient {
  if (!exporter || exporter.dead) exporter = new ProcessorClient();
  return exporter;
}

/** Run OCR, closing the worker once it has been idle for a while (it is recreated on demand). */
function recognise(image: {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}): Promise<OcrWord[]> {
  clearTimeout(readerIdle);
  if (!reader || reader.dead) reader = new OcrClient();
  reading++;
  return reader.recognise(image).finally(() => {
    if (--reading > 0) return;
    readerIdle = setTimeout(() => {
      reader?.dispose();
      reader = null;
    }, OCR_IDLE_MS);
  });
}

function key(page: Page, settings: AppSettings): string {
  return `${renderKey(page, RESOLUTION_LONG_EDGE[settings.resolution], false)}|${settings.jpegQuality}`;
}

/** Whether the OCR models are already downloaded, so OCR costs no data. */
export async function ocrModelsCached(): Promise<boolean> {
  try {
    if (typeof caches === 'undefined') return false;
    for (const name of await caches.keys()) {
      if (!name.startsWith(OCR_CACHE)) continue;
      const cache = await caches.open(name);
      if ((await cache.keys()).length >= OCR_FILES) return true;
    }
  } catch {
    // No cache access (e.g. a private window): treat as not downloaded.
  }
  return false;
}

/**
 * The export render of a page, with its text (when OCR is on in the
 * settings) if `text` is set. A page rendered without text is rendered again
 * when the text is wanted: the OCR image is too large to keep just in case.
 */
async function encode(page: Page, settings: AppSettings, text: boolean): Promise<EncodedPage> {
  const k = key(page, settings);
  const withText = text && settings.ocr;
  for (;;) {
    const done = ready.get(k);
    if (done && (done.words || !withText)) return done;
    const running = inFlight.get(k);
    if (!running) break;
    await running.catch(() => undefined);
  }
  const running = worker()
    .encode({
      ...renderJob(page, RESOLUTION_LONG_EDGE[settings.resolution]),
      jpegQuality: settings.jpegQuality,
      ocrEdge: withText ? OCR_EDGE : undefined,
    })
    .then((result) => {
      const entry: EncodedPage = {
        image: result.image,
        width: result.width,
        height: result.height,
        words: null,
      };
      if (result.ocr) {
        const toPage = result.width / result.ocr.width;
        entry.words = recognise(result.ocr)
          .then((found) =>
            found.map((w) => ({
              ...w,
              x0: w.x0 * toPage,
              x1: w.x1 * toPage,
              y0: w.y0 * toPage,
              y1: w.y1 * toPage,
            })),
          )
          .catch(() => {
            // This export goes out without text; the next one tries again.
            if (ready.get(k) === entry) ready.set(k, { ...entry, words: null });
            return [];
          });
      }
      ready.set(k, entry);
      return entry;
    })
    .finally(() => inFlight.delete(k));
  inFlight.set(k, running);
  return running;
}

/**
 * The export render for a page: from the background cache, or now. With
 * `text`, its OCR words are on their way too (when OCR is enabled).
 */
export function encodedPage(
  page: Page,
  settings: AppSettings,
  { text = false }: { text?: boolean } = {},
): Promise<EncodedPage> {
  return encode(page, settings, text);
}

/**
 * Prepare every page's export (and its OCR, if the models are downloaded) in
 * the background, one at a time. Results for pages or settings that no
 * longer exist are dropped.
 */
export function prefetchExports(pages: Page[], settings: AppSettings): void {
  const wanted = new Set(pages.map((p) => key(p, settings)));
  for (const k of [...ready.keys()]) if (!wanted.has(k)) ready.delete(k);
  const run = ++generation;
  void (async () => {
    const text = settings.ocr && (await ocrModelsCached());
    for (const page of pages) {
      if (paused || run !== generation) return;
      try {
        const entry = await encode(page, settings, text);
        // Let OCR finish before starting the next render, so the two
        // background workers do not compete with each other for the CPU.
        await entry.words;
      } catch {
        // A failed prefetch is retried for real when the user exports.
      }
    }
  })();
}

/** Let the export worker drop what it keeps for a page that is gone. */
export function forgetExport(pageId: string): void {
  exporter?.forget(pageId);
}

/** Stop starting new background renders (the one in progress finishes). */
export function pausePrefetch(): void {
  paused = true;
  generation++;
}

export function resumePrefetch(): void {
  paused = false;
}
