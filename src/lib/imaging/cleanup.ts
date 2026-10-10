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
    // Slivers of table or page edge along the border. One that does not touch
    // the border must at least be a long thin line, so that text set close
    // to the edge of a tightly cropped page survives.
    if (b.inBand >= b.area * 0.9) {
      const length = Math.max(b.maxX - b.minX + 1, b.maxY - b.minY + 1);
      if (b.touchesBorder || length >= 8 * (b.area / length)) return;
    }
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
    // Short, thin, never-dark streaks are what folds and creases leave
    // behind, straight or diagonal. Thickness is area over length, so a
    // diagonal crease counts as thin too. Printed rules run much further; a
    // glyph, even a thin one at low resolution, gets darker than this.
    if (b.minLuma > 0.45 && extent >= 6 * (b.area / extent) && extent < options.dashMaxLength) {
      return;
    }
    keep[l] = 1;
  });
  return keep;
}
