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

/**
 * Decide which blobs are content. Returns a per-label keep flag.
 *
 * Losing content is far worse than leaving a smudge, so every rule that drops
 * something is written to fail towards keeping it.
 *
 * - Slivers of table or page edge go if they touch the border, or if they are
 *   long lines hugging it. Text set close to the edge of a tight crop stays.
 * - Dark blobs stay down to a few pixels: full stops and umlaut dots are
 *   content, single noisy pixels are not.
 * - Faint blobs must be reasonably dark somewhere and crisp. Next to dark
 *   text they stay (punctuation on a soft photo, grey words at low
 *   resolution). Away from text, tiny specks, broad shading patches and short
 *   streaks (what folds and creases leave behind) go; long lines (rules) and
 *   glyph-like shapes stay.
 */
export function keepBlobs(
  blobs: (Blob | null)[],
  width: number,
  height: number,
  options: CleanupOptions,
): Uint8Array {
  const keep = new Uint8Array(blobs.length);
  const long = Math.max(width, height);
  const hug = Math.max(2, Math.round(long * 0.004));
  const faint: number[] = [];

  blobs.forEach((b, l) => {
    if (!b) return;
    const length = Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1);
    if (b.inBand >= b.area * 0.9) {
      if (b.touchesBorder) return;
      const hugging =
        b.maxX < hug || b.minX >= width - hug || b.maxY < hug || b.minY >= height - hug;
      if (hugging && length >= 0.05 * long) return;
    }
    if (b.dark >= options.speck) keep[l] = 1;
    else faint.push(l);
  });

  // Where the text is, on a coarse grid of cells about a line high. Only
  // glyph-sized, clearly dark blobs count: the dark core of a long crease
  // must not vouch for the faint shading around it.
  const cell = Math.max(8, Math.round(long * 0.01));
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const occupied = new Uint8Array(cols * rows);
  blobs.forEach((b, l) => {
    if (!b || !keep[l] || b.minLuma > 0.35) return;
    if (Math.max(b.maxX - b.minX, b.maxY - b.minY) > 0.06 * long) return;
    for (let y = Math.floor(b.minY / cell); y <= Math.floor(b.maxY / cell); y++) {
      for (let x = Math.floor(b.minX / cell); x <= Math.floor(b.maxX / cell); x++) {
        occupied[y * cols + x] = 1;
      }
    }
  });
  const nearText = (b: Blob) => {
    const x0 = Math.max(0, Math.floor(b.minX / cell) - 1);
    const x1 = Math.min(cols - 1, Math.floor(b.maxX / cell) + 1);
    const y0 = Math.max(0, Math.floor(b.minY / cell) - 1);
    const y1 = Math.min(rows - 1, Math.floor(b.maxY / cell) + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if (occupied[y * cols + x]) return true;
    }
    return false;
  };

  for (const l of faint) {
    const b = blobs[l]!;
    if (b.area < 2) continue;
    // Faint print is still reasonably dark somewhere.
    if (b.minLuma > FAINT_MAX_LUMA) continue;
    // On a line of text it stays: soft letters and full stops of a blurry
    // photo, grey words at low resolution.
    if (nearText(b)) {
      keep[l] = 1;
      continue;
    }
    // Away from text it must also be crisp; fold and crease shading is soft.
    if (b.maxGradient < options.faintMinGradient) continue;
    // Away from text, a tiny faint blob is noise unless clearly dark and crisp.
    if (
      b.area < options.faintMinArea &&
      (b.minLuma > 0.55 || b.maxGradient < options.faintMinGradient * 1.5)
    ) {
      continue;
    }
    // Faint print is made of strokes and lines a few pixels thick. Wrinkle
    // and crease shadows are broad patches: their average thickness (area
    // over length) is far beyond any stroke.
    const extent = Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1);
    const thickness = b.area / extent;
    if (thickness > options.faintMaxThickness) continue;
    // Short, thin, never-dark streaks are what folds and creases leave
    // behind, straight or diagonal. Printed rules run much further.
    if (b.minLuma > 0.45 && extent >= 6 * thickness && extent < options.dashMaxLength) continue;
    keep[l] = 1;
  }
  return keep;
}
