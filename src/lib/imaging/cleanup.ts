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
  /** Faint blobs thicker than this on average are shading, not print. */
  faintMaxThickness: number;
  /** Faint, thin streaks shorter than this are fold or crease shadows. */
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
    // Faint print (grey rules, grey small print, and thin glyphs or dots at
    // low resolution, which never reach full black) is still reasonably dark
    // somewhere and has crisp edges; fold and crease shading is light and soft.
    if (b.minLuma > FAINT_MAX_LUMA || b.maxGradient < options.faintMinGradient) return;
    // Tiny faint blobs are noise unless they are clearly dark and crisp: at
    // preview size an i-dot is only a few pixels.
    if (
      b.area < options.faintMinArea &&
      (b.area < 2 || b.minLuma > 0.55 || b.maxGradient < options.faintMinGradient * 1.5)
    ) {
      return;
    }
    // Faint print is made of strokes and lines a few pixels thick. Wrinkle
    // and crease shadows are broad patches: their average thickness (area
    // over length) is far beyond any stroke.
    const extent = Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1);
    if (b.area / extent > options.faintMaxThickness) return;
    // Short, thin, never-dark streaks are the shadows of folds and creases.
    // A real glyph, even a thin one at low resolution, gets darker than this.
    const { w, h } = size(b);
    const length = Math.max(w, h);
    if (b.minLuma > 0.45 && length >= 3 * Math.min(w, h) && length < options.dashMaxLength) {
      return;
    }
    keep[l] = 1;
  });
  return keep;
}

/**
 * Punch holes, or rather the shadows inside them, as labels to remove.
 *
 * ISO 838 filing holes are ~6 mm across, centred 12 mm from the paper edge
 * and 80 mm apart. A candidate must match that geometry (centre 3.5-7.5% of
 * the short edge in from a long edge, 1.5-6% across including its shadow,
 * roughly round), have no neighbour within a letter gap on its line, and not
 * overlap other content. Holes are removed only in pairs that also match each
 * other: same distance from the edge (one punch made both), similar size, and
 * the ISO spacing (20-34% of the long edge, allowing for other paper sizes).
 * Text at the left margin can look hole-sized at low resolution, where
 * letters merge into word-sized blobs; it fails the matching.
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
  const minNeighbour = (0.004 * short) ** 2;

  const candidates: {
    label: number;
    side: number;
    across: number;
    along: number;
    w: number;
    h: number;
  }[] = [];
  // Candidates are taken from all blobs, not just kept ones: one hole of a
  // pair may already have been dropped as shading, and its partner must still
  // be recognised.
  blobs.forEach((b, l) => {
    if (!b) return;
    const { w, h } = size(b);
    const big = Math.max(w, h);
    if (big < 0.015 * short || big > 0.06 * short) return;
    // A hole is ~6 mm across in both directions; a word at the margin is only
    // as tall as its letters. Text must never be mistaken for a hole.
    if (Math.min(w, h) < 0.014 * short) return;
    // Roughly round; the shadow inside a hole is often a crescent.
    if (big > 2 * Math.min(w, h)) return;
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const span = portrait ? width : height;
    const across = portrait ? cx : cy;
    const fromEdge = Math.min(across, span - across);
    if (fromEdge < 0.035 * short || fromEdge > 0.075 * short) return;
    // Specks of the hole's own shadow do not count as other content.
    const overlaps = blobs.some(
      (o, m) =>
        o &&
        m !== l &&
        keep[m] &&
        o.area >= minNeighbour &&
        o.maxX >= b.minX &&
        o.minX <= b.maxX &&
        o.maxY >= b.minY &&
        o.minY <= b.maxY,
    );
    if (overlaps) return;
    // Not part of a line of text: at low resolution letters merge into
    // hole-sized blobs, but those have their neighbours a letter gap away.
    const gap = 0.003 * short;
    const crowded = blobs.some((o, m) => {
      if (!o || m === l || !keep[m] || o.area < minNeighbour) return false;
      if (portrait) {
        if (o.maxY < b.minY || o.minY > b.maxY) return false;
        return o.minX <= b.maxX + gap && o.maxX >= b.minX - gap;
      }
      if (o.maxX < b.minX || o.minX > b.maxX) return false;
      return o.minY <= b.maxY + gap && o.maxY >= b.minY - gap;
    });
    if (crowded) return;
    candidates.push({
      label: l,
      side: across < span / 2 ? 0 : 1,
      across: fromEdge,
      along: portrait ? cy : cx,
      w,
      h,
    });
  });

  const holes = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (a.side !== b.side) continue;
      // A crumpled or slightly skewed sheet shifts holes a little.
      if (Math.abs(a.across - b.across) > 0.02 * short) continue;
      // The shadow inside a hole depends on the light, so sizes vary
      // somewhat, but both holes are about the same shape in both directions.
      if (Math.max(a.w, b.w) > 2.2 * Math.min(a.w, b.w)) continue;
      if (Math.max(a.h, b.h) > 2.2 * Math.min(a.h, b.h)) continue;
      const gap = Math.abs(a.along - b.along) / long;
      if (gap >= 0.2 && gap <= 0.34) {
        holes.add(a.label);
        holes.add(b.label);
      }
    }
  }
  return [...holes];
}
