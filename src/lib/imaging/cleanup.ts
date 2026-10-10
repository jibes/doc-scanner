import { labelComponents } from './components';
import type { FloatImage } from './image';

/** Per-component measurements used by the cleanup rules. */
export interface Blob {
  area: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Pixels darker than DARK. */
  dark: number;
  /** Darkest luma in the blob. */
  minLuma: number;
  /** Pixels inside the border band. */
  inBand: number;
  touchesBorder: boolean;
  /** Steepest luma step (per pixel) inside the blob: print is crisp, shading is soft. */
  maxGradient: number;
}

/** Luma below which a pixel is unmistakably print. */
const DARK = 0.5;
/** A faint blob must get at least this dark somewhere to count as print. */
const FAINT_MAX_LUMA = 0.7;

export interface CleanupOptions {
  /** Fewer dark pixels than this and a blob is noise, not a dot or a glyph. */
  speck: number;
  /** A faint blob smaller than this is noise. */
  faintMinArea: number;
  /** Faint, thin blobs shorter than this are shadow dashes (folds, creases). */
  dashMaxLength: number;
  /** Width of the border band in which edge slivers are removed. */
  band: number;
  /** Minimum edge steepness (luma per pixel) for a faint blob to count as print. */
  faintMinGradient: number;
}

export function measureBlobs(
  mask: Uint8Array,
  luma: FloatImage,
  band: number,
): { labels: Int32Array; blobs: (Blob | null)[] } {
  const { width, height } = luma;
  const { labels, areas } = labelComponents(mask, width, height);
  const blobs: (Blob | null)[] = Array.from({ length: areas.length }, (_, l) =>
    l && areas[l]
      ? {
          area: areas[l],
          minX: width,
          maxX: -1,
          minY: height,
          maxY: -1,
          dark: 0,
          minLuma: 1,
          inBand: 0,
          touchesBorder: false,
          maxGradient: 0,
        }
      : null,
  );
  for (let y = 0; y < height; y++) {
    const yBand = y < band || y >= height - band;
    const yEdge = y === 0 || y === height - 1;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const b = blobs[labels[i]];
      if (!b) continue;
      if (x < b.minX) b.minX = x;
      if (x > b.maxX) b.maxX = x;
      if (y < b.minY) b.minY = y;
      if (y > b.maxY) b.maxY = y;
      const v = luma.data[i];
      if (v < b.minLuma) b.minLuma = v;
      if (v < DARK) b.dark++;
      if (yBand || x < band || x >= width - band) b.inBand++;
      if (yEdge || x === 0 || x === width - 1) b.touchesBorder = true;
      if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
        const gx = (luma.data[i + 1] - luma.data[i - 1]) / 2;
        const gy = (luma.data[i + width] - luma.data[i - width]) / 2;
        const g = Math.hypot(gx, gy);
        if (g > b.maxGradient) b.maxGradient = g;
      }
    }
  }
  return { labels, blobs };
}

const size = (b: Blob) => ({ w: b.maxX - b.minX + 1, h: b.maxY - b.minY + 1 });

/**
 * Decide which blobs are content. Returns a per-label keep flag.
 *
 * - Slivers of table or page edge along the border go.
 * - Dark blobs stay down to a few pixels: full stops and umlaut dots are
 *   content, single noisy pixels are not.
 * - Faint blobs stay if they are glyph-like (grey print) or long lines
 *   (table rules); short, thin, faint dashes are the shadows of folds and
 *   creases and go.
 * - Punch holes go (see `findPunchHoles`).
 */
export function keepBlobs(
  blobs: (Blob | null)[],
  width: number,
  height: number,
  options: CleanupOptions,
): Uint8Array {
  const keep = new Uint8Array(blobs.length);
  blobs.forEach((b, l) => {
    if (!b) return;
    if (b.inBand >= b.area * 0.9 && (b.touchesBorder || b.inBand === b.area)) return;
    if (b.dark >= options.speck) {
      keep[l] = 1;
      return;
    }
    if (b.area < options.faintMinArea) return;
    // Faint print (grey rules, grey small print) is still reasonably dark
    // somewhere and has crisp edges; fold and crease shading is light and soft.
    if (b.minLuma > FAINT_MAX_LUMA || b.maxGradient < options.faintMinGradient) return;
    const { w, h } = size(b);
    const length = Math.max(w, h);
    const thickness = Math.min(w, h);
    if (length >= 3 * thickness && length < options.dashMaxLength) return;
    keep[l] = 1;
  });
  for (const l of findPunchHoles(blobs, keep, width, height)) keep[l] = 0;
  return keep;
}

/**
 * Punch holes, or rather the shadows inside them, as labels to remove.
 *
 * ISO 838 filing holes are ~6 mm across, centred 12 mm from the paper edge
 * and 80 mm apart. A candidate must match that geometry closely (centre 3-10%
 * of the short edge in from a long edge, size 1.5-4.5% of it) and not overlap
 * any other content. Holes are removed only in pairs at the right spacing
 * (20-34% of the long edge, allowing for other paper sizes), so a margin note
 * or a bullet is never mistaken for one.
 */
export function findPunchHoles(
  blobs: (Blob | null)[],
  keep: Uint8Array,
  width: number,
  height: number,
): number[] {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const portrait = height >= width;

  const candidates: { label: number; side: number; along: number }[] = [];
  blobs.forEach((b, l) => {
    if (!b || !keep[l]) return;
    const { w, h } = size(b);
    if (Math.max(w, h) < 0.015 * short || Math.max(w, h) > 0.045 * short) return;
    if (Math.min(w, h) < 0.005 * short) return;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const across = portrait ? cx : cy;
    const span = portrait ? width : height;
    let side: number;
    if (across > 0.03 * short && across < 0.1 * short) side = 0;
    else if (across < span - 0.03 * short && across > span - 0.1 * short) side = 1;
    else return;
    const overlaps = blobs.some(
      (o, m) =>
        o &&
        m !== l &&
        keep[m] &&
        o.maxX >= b.minX &&
        o.minX <= b.maxX &&
        o.maxY >= b.minY &&
        o.minY <= b.maxY,
    );
    if (overlaps) return;
    candidates.push({ label: l, side, along: portrait ? cy : cx });
  });

  const holes = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (a.side !== b.side) continue;
      const gap = Math.abs(a.along - b.along) / long;
      if (gap >= 0.2 && gap <= 0.34) {
        holes.add(a.label);
        holes.add(b.label);
      }
    }
  }
  return [...holes];
}
