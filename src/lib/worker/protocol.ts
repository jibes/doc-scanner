import type { Detection } from '../detect/heatmap';
import type { Quad } from '../imaging/image';
import type { OcrWord } from '../ocr/paddle';
import type { PdfImage } from '../pdf/writer';
import type { PageSpec } from '../pipeline';

/* ------------------------------------------------------------ processor ---- */

/** A page to render: its photo, the photo's pixel size, and what to do with it. */
export interface RenderJob {
  pageId: string;
  source: Blob;
  /** Full pixel size of `source`, so it can be decoded at a reduced size. */
  sourceWidth: number;
  sourceHeight: number;
  spec: PageSpec;
  /** Long edge of the rendered page, in pixels. */
  longEdge: number;
}

export type ProcessorRequest =
  | ({ type: 'render'; id: number } & RenderJob)
  | ({
      type: 'encode';
      id: number;
      jpegQuality: number;
      /** Also return the page scaled to this long edge, for OCR. */
      ocrEdge?: number;
    } & RenderJob)
  /** The rectified page before any filter, for "hold to compare". */
  | ({ type: 'rectified'; id: number } & RenderJob)
  /** Drop a queued job; handled immediately, not in queue order. */
  | { type: 'cancel'; id: number }
  | { type: 'forget'; pageId: string };

export type ProcessorResponse =
  | { type: 'bitmap'; id: number; bitmap: ImageBitmap }
  | {
      type: 'encoded';
      id: number;
      image: PdfImage;
      width: number;
      height: number;
      ocr?: { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };
    }
  | { type: 'error'; id: number; message: string };

/* ------------------------------------------------------------- detector ---- */

export type DetectorRequest =
  | { type: 'init' }
  /** A video frame, already resized to the model's input size. */
  | { type: 'frame'; id: number; frame: ImageBitmap }
  /** A captured photo: detect, then refine against the full-resolution edges. */
  | { type: 'still'; id: number; source: Blob };

export type DetectorResponse =
  | { type: 'ready'; backend: string }
  | { type: 'init-error'; message: string }
  | { type: 'frame'; id: number; detection: Detection | null; ms: number }
  | {
      type: 'still';
      id: number;
      /** In source pixel-edge coordinates, or null when no page was found. */
      quad: Quad | null;
      width: number;
      height: number;
      confidence: number;
      /** See imaging/sharpness.ts; low means blurred. */
      sharpness: number;
    }
  | { type: 'error'; id: number; message: string };

/* ------------------------------------------------------------------ ocr ---- */

export type OcrRequest = {
  type: 'ocr';
  id: number;
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
};

export type OcrResponse =
  { type: 'words'; id: number; words: OcrWord[] } | { type: 'error'; id: number; message: string };
