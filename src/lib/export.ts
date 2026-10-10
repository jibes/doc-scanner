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
    const { image, width, height, words } = await encodedPage(page, settings);
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

/** Hand the file to the OS share sheet where possible, else download it. */
export async function saveFile(blob: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] }) && /Android|iPhone|iPad/i.test(navigator.userAgent)) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared';
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
