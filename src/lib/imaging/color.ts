import { dilate3, erode3, filterSmallBlobs } from './morphology';
import type { Mask, RGBAImage } from './types';

export interface ColorMaskOptions {
  /** Minimum chroma (max minus min of R,G,B) for a pixel to count as colour. */
  chromaThreshold: number;
  /** Pixels darker than this luma are ink, never colour content. */
  lumaFloor: number;
  /** Drop connected components smaller than this many pixels. 0 keeps everything. */
  minArea: number;
  /** Grow the mask by this many pixels so anti-aliased edges survive compositing. */
  grow: number;
}

/**
 * Find the parts of the page that carry colour: logos, stamps, signatures,
 * highlights. Everything else is treated as paper or ink.
 *
 * Chroma rather than HSV saturation is used because it is a single subtraction
 * and behaves identically for the near-neutral pixels that dominate a document.
 */
export function colorMask(flat: RGBAImage, opts: ColorMaskOptions): Mask {
  const { data, width, height } = flat;
  const n = width * height;
  const mask = new Uint8Array(n);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    const chroma = max - min;
    const luma = (r * 77 + g * 150 + b * 29) >> 8;
    mask[i] = chroma > opts.chromaThreshold && luma > opts.lumaFloor ? 255 : 0;
  }

  // Opening removes isolated JPEG chroma noise before the area filter runs.
  let cleaned = dilate3(erode3(mask, width, height), width, height);
  if (opts.minArea > 1) cleaned = filterSmallBlobs(cleaned, width, height, opts.minArea);
  if (opts.grow > 0) {
    for (let i = 0; i < opts.grow; i++) cleaned = dilate3(cleaned, width, height);
  }
  return cleaned;
}
