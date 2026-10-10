import type { PdfImage } from './pdf/writer';
import { renderKey } from './renderCache';
import { renderJob } from './services';
import { RESOLUTION_LONG_EDGE, type AppSettings } from './settings';
import type { Page } from './store/session.svelte';
import { ProcessorClient } from './worker/clients';

export interface EncodedPage {
  image: PdfImage;
  width: number;
  height: number;
}

/*
 * Export-quality pages, prepared in the background while the user reviews the
 * document, so that "PDF" and "Upload" only have to assemble the file.
 *
 * A dedicated worker does this, so interactive previews are never queued
 * behind a multi-second export render, and it pauses while the camera is in
 * use so detection has the CPU to itself.
 */

let exporter: ProcessorClient | null = null;
const ready = new Map<string, EncodedPage>();
const inFlight = new Map<string, Promise<EncodedPage>>();
let paused = false;
let generation = 0;

function worker(): ProcessorClient {
  exporter ??= new ProcessorClient();
  return exporter;
}

function key(page: Page, settings: AppSettings): string {
  return `${renderKey(page, RESOLUTION_LONG_EDGE[settings.resolution], false)}|${settings.jpegQuality}`;
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
      })
      .then((result) => {
        ready.set(k, result);
        return result;
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
 * Prepare every page's export in the background, one at a time. Results for
 * pages or settings that no longer exist are dropped.
 */
export function prefetchExports(pages: Page[], settings: AppSettings): void {
  const wanted = new Set(pages.map((p) => key(p, settings)));
  for (const k of [...ready.keys()]) if (!wanted.has(k)) ready.delete(k);
  const run = ++generation;
  void (async () => {
    for (const page of pages) {
      if (paused || run !== generation) return;
      try {
        await encode(page, settings);
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
