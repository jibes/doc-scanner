import type { Detection } from '../detect/heatmap';
import type { Quad } from '../imaging/image';
import type { PdfImage } from '../pdf/writer';
import type { PageSpec } from '../pipeline';

/* ------------------------------------------------------------ processor ---- */

export type ProcessorRequest =
  | {
      type: 'render';
      id: number;
      pageId: string;
      source: Blob;
      spec: PageSpec;
      longEdge: number;
    }
  | {
      type: 'encode';
      id: number;
      pageId: string;
      source: Blob;
      spec: PageSpec;
      longEdge: number;
      jpegQuality: number;
    }
  | {
      /** The rectified page before any filter, for "hold to compare". */
      type: 'rectified';
      id: number;
      pageId: string;
      source: Blob;
      spec: PageSpec;
      longEdge: number;
    }
  | { type: 'forget'; pageId: string };

export type ProcessorResponse =
  | { type: 'bitmap'; id: number; bitmap: ImageBitmap }
  | { type: 'encoded'; id: number; image: PdfImage; width: number; height: number }
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
    }
  | { type: 'error'; id: number; message: string };
