import { pageSizePoints } from './pdf/paper';
import { buildPdf, type PdfPage } from './pdf/writer';
import { encodedPage } from './exportCache';
import type { OcrWord } from './ocr/paddle';
import type { AppSettings } from './settings';
import type { Page } from './store/session.svelte';

/** Nominal resolution for pages whose shape matches no paper format (receipts). */
const FALLBACK_DPI = 300;

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
  }: {
    searchable?: boolean;
    /** Called while waiting for a page's text recognition. */
    onReading?: (page: number, total: number) => void;
    /** Resolves when the user chooses to save without the remaining text. */
    skipText?: Promise<void>;
  } = {},
): Promise<Blob> {
  let skipped = false;
  void skipText?.then(() => (skipped = true));
  // The page's words, or none once the user chooses to skip the text.
  const waitForText = (words: Promise<OcrWord[]>, index: number) => {
    onReading?.(index, pages.length);
    return skipText ? Promise.race([words, skipText.then((): OcrWord[] => [])]) : words;
  };
  const out: PdfPage[] = [];
  for (let i = 0; i < pages.length; i++) {
    onProgress(i, pages.length);
    const page = pages[i];
    const { image, width, height, words } = await encodedPage(page, settings, { text: searchable });
    const size = pageSizePoints(width, height, FALLBACK_DPI);
    out.push({
      pixelWidth: width,
      pixelHeight: height,
      width: size.width,
      height: size.height,
      image,
      words: searchable && words && !skipped ? await waitForText(words, i) : undefined,
    });
  }
  onProgress(pages.length, pages.length);
  return buildPdf(out, { title });
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
 *   share sheet because the tap that started the export has expired (it
 *   lasts a few seconds; building a PDF takes longer). Call again from a
 *   new tap.
 */
export type SaveOutcome = 'shared' | 'cancelled' | 'downloaded' | 'needs-tap';

/** Hand the file to the OS share sheet where possible, else download it. */
export async function saveFile(
  blob: Blob,
  filename: string,
  { deferShare = false }: { deferShare?: boolean } = {},
): Promise<SaveOutcome> {
  const file = new File([blob], filename, { type: blob.type });
  if (mobile() && navigator.canShare?.({ files: [file] })) {
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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'downloaded';
}
