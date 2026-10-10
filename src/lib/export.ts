import { cropShapeUnknown } from './imaging/quad';
import { pageSizePoints, type PageSize } from './pdf/paper';
import { buildPdf, type PdfPage } from './pdf/writer';
import { encodedPage, turnedPage, uprightPage, type PageText } from './exportCache';
import type { AppSettings } from './settings';
import type { Page } from './store/session.svelte';

/**
 * Physical size of a page rendered at `width` x `height` pixels: from its
 * shape (pdf/paper.ts), unless the crop is a guess or clipped to the photo,
 * whose shape says nothing about the paper.
 */
export function pagePaperSize(page: Page, width: number, height: number): PageSize {
  const known = !cropShapeUnknown(page.spec.quad, page.width, page.height);
  return pageSizePoints(width, height, { known });
}

export function defaultTitle(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Scan ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}.${p(date.getMinutes())}`;
}

export function pdfFilename(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'scan';
  return `${safe}.pdf`;
}

/**
 * Render every page at export resolution and assemble the PDF. With
 * `searchable`, pages carry an invisible OCR text layer (when OCR is enabled
 * in the settings).
 */
export async function exportPdf(
  pages: Page[],
  settings: AppSettings,
  title: string,
  onProgress: (done: number, total: number) => void,
  {
    searchable = false,
    onReading,
    skipText,
    onTurn,
  }: {
    searchable?: boolean;
    /** Called while waiting for a page's text recognition. */
    onReading?: (page: number, total: number) => void;
    /** Resolves when the user chooses to save without the remaining text. */
    skipText?: Promise<void>;
    /** Called when OCR finds a page sideways or upside down (clockwise quarter turns). */
    onTurn?: (page: number, turn: number) => void;
  } = {},
): Promise<Blob> {
  let skipped = false;
  void skipText?.then(() => (skipped = true));
  const none: PageText = { words: [], turn: 0 };
  // The page's text, or none once the user chooses to skip the text.
  const waitForText = (text: Promise<PageText>, index: number) => {
    onReading?.(index, pages.length);
    return skipText ? Promise.race([text, skipText.then(() => none)]) : text;
  };
  const out: PdfPage[] = [];
  for (let i = 0; i < pages.length; i++) {
    onProgress(i, pages.length);
    const page = pages[i];
    const encoded = await encodedPage(page, settings, { text: searchable });
    let { image, width, height } = encoded;
    const reading = encoded.text;
    const text = searchable && reading && !skipped ? await waitForText(reading, i) : undefined;
    let found = text?.words;
    if (text?.turn) {
      // OCR found the page sideways or upside down: put it in upright.
      onTurn?.(i, text.turn);
      ({ image, width, height, words: found } = await uprightPage(page, settings, text));
    }
    const upright = text?.turn ? turnedPage(page, text.turn) : page;
    const size = pagePaperSize(upright, width, height);
    out.push({
      pixelWidth: width,
      pixelHeight: height,
      width: size.width,
      height: size.height,
      image,
      words: found,
    });
  }
  onProgress(pages.length, pages.length);
  return buildPdf(out, { title });
}

function ios(): boolean {
  if (/iPhone|iPad/i.test(navigator.userAgent)) return true;
  return /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
}

/** Phones and tablets, where the share sheet is how files leave the browser. */
function mobile(): boolean {
  if (/Android|iPhone|iPad/i.test(navigator.userAgent)) return true;
  // iPadOS asks for desktop sites and reports itself as a Mac.
  return /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
}

/**
 * What became of a file:
 * - `shared`: handed to the share sheet and sent somewhere;
 * - `cancelled`: the user closed the share sheet;
 * - `downloaded`: saved through the browser instead;
 * - `needs-tap`: only with `deferShare`. The browser refused to open the
 *   share sheet, or on a phone would ignore the download, because the tap
 *   that started the export has expired (it lasts a few seconds; building a
 *   PDF takes longer). Call again from a new tap.
 */
export type SaveOutcome = 'shared' | 'cancelled' | 'downloaded' | 'needs-tap';

/** Whether files can go to the OS share sheet ("open with" another app) here. */
export function canShareFiles(): boolean {
  try {
    const probe = new File([''], 'probe.pdf', { type: 'application/pdf' });
    return mobile() && !!navigator.canShare?.({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * Hand the file to the OS share sheet where possible, else download it.
 * With `download`, always save it as a file through the browser.
 */
export async function saveFile(
  blob: Blob,
  filename: string,
  { deferShare = false, download = false }: { deferShare?: boolean; download?: boolean } = {},
): Promise<SaveOutcome> {
  const file = new File([blob], filename, { type: blob.type });
  if (!download && mobile() && navigator.canShare?.({ files: [file] })) {
    // Where the browser says so up front, do not even try: a refused share
    // can leave iOS unwilling to open the sheet on the next tap either.
    if (deferShare && navigator.userActivation && !navigator.userActivation.isActive) {
      return 'needs-tap';
    }
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'AbortError') return 'cancelled';
      if (name === 'NotAllowedError' && deferShare) return 'needs-tap';
      // Fall through to a download.
    }
  }
  // iOS may also ignore a download without a recent tap; Android does not.
  if (deferShare && ios() && navigator.userActivation && !navigator.userActivation.isActive) {
    return 'needs-tap';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'downloaded';
}
