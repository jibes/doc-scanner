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
   * a good PDF.
   */
  words: Promise<OcrWord[]> | null;
}

/** Long edge of the page image handed to OCR: text lines come out ~35 px tall. */
const OCR_EDGE = 2600;

/*
 * Export-quality pages, prepared in the background while the user reviews the
 * document, so that "PDF" and "Upload" only have to assemble the file.
 *
 * A dedicated worker does this, so interactive previews are never queued
 * behind a multi-second export render, and it pauses while the camera is in
 * use so detection has the CPU to itself. OCR runs in a third worker right
 * after each page is rendered.
 */

let exporter: ProcessorClient | null = null;
let reader: OcrClient | null = null;
const ready = new Map<string, EncodedPage>();
const inFlight = new Map<string, Promise<EncodedPage>>();
let paused = false;
let generation = 0;

function worker(): ProcessorClient {
  if (!exporter || exporter.dead) exporter = new ProcessorClient();
  return exporter;
}

function ocr(): OcrClient {
  if (!reader || reader.dead) reader = new OcrClient();
  return reader;
}

function key(page: Page, settings: AppSettings): string {
  return `${renderKey(page, RESOLUTION_LONG_EDGE[settings.resolution], false)}|${settings.jpegQuality}|${settings.ocr ? 1 : 0}`;
}

function encode(page: Page, settings: AppSettings): Promise<EncodedPage> {
  const k = key(page, settings);
  const done = ready.get(k);
  if (done) return Promise.resolve(done);
  let running = inFlight.get(k);
  if (!running) {
    running = worker()
      .encode({
        ...renderJob(page, RESOLUTION_LONG_EDGE[settings.resolution]),
        jpegQuality: settings.jpegQuality,
        ocrEdge: settings.ocr ? OCR_EDGE : undefined,
      })
      .then((result) => {
        let words: Promise<OcrWord[]> | null = null;
        if (result.ocr) {
          const toPage = result.width / result.ocr.width;
          words = ocr()
            .recognise(result.ocr)
            .then((found) =>
              found.map((w) => ({
                ...w,
                x0: w.x0 * toPage,
                x1: w.x1 * toPage,
                y0: w.y0 * toPage,
                y1: w.y1 * toPage,
              })),
            )
            .catch(() => []);
        }
        const entry: EncodedPage = {
          image: result.image,
          width: result.width,
          height: result.height,
          words,
        };
        ready.set(k, entry);
        return entry;
      })
      .finally(() => inFlight.delete(k));
    inFlight.set(k, running);
  }
  return running;
}

/** The export render for a page: from the background cache, or now. */
export function encodedPage(page: Page, settings: AppSettings): Promise<EncodedPage> {
  return encode(page, settings);
}

/**
 * Prepare every page's export (and its OCR) in the background, one at a time.
 * Results for pages or settings that no longer exist are dropped.
 */
export function prefetchExports(pages: Page[], settings: AppSettings): void {
  const wanted = new Set(pages.map((p) => key(p, settings)));
  for (const k of [...ready.keys()]) if (!wanted.has(k)) ready.delete(k);
  const run = ++generation;
  void (async () => {
    for (const page of pages) {
      if (paused || run !== generation) return;
      try {
        const entry = await encode(page, settings);
        // Let OCR finish before starting the next render, so the two
        // background workers do not compete with each other for the CPU.
        await entry.words;
      } catch {
        // A failed prefetch is retried for real when the user exports.
      }
    }
  })();
}

/** Stop starting new background renders (the one in progress finishes). */
export function pausePrefetch(): void {
  paused = true;
  generation++;
}

export function resumePrefetch(): void {
  paused = false;
}
