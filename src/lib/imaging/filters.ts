import { flattenPaper } from './background';
import { gaussian, localStats } from './box';
import { dilate, labelComponents, removeSmallComponents } from './components';
import { createFloat, createRGBA, toLuma, type FloatImage, type RGBAImage } from './image';

/**
 * - `document`: black text on pure white, colour content (logos, stamps,
 *   signatures, highlights) kept in colour. The default.
 * - `bw`: black text on pure white, everything else too.
 * - `gray`: flattened greyscale with clean white paper.
 * - `color`: flattened colour with clean white paper.
 * - `original`: perspective correction only.
 */
export type FilterId = 'document' | 'bw' | 'gray' | 'color' | 'original';

export interface Adjustments {
  /** -1..1. Raises or lowers the white point, i.e. how aggressively near-white becomes paper. */
  brightness: number;
  /** -1..1. Moves the black point. */
  contrast: number;
  /** -1..1. For document/bw: lower keeps fainter strokes, higher drops more. */
  threshold: number;
  /**
   * 0..1. Unsharp-mask amount for colour and grey content. For black text it
   * instead reduces the contour smoothing applied before thresholding.
   */
  sharpen: number;
}

export interface FilterContext {
  /**
   * Output pixels per source-photo pixel. Noise and blur live at the source
   * scale, so smoothing and sharpening radii follow it; everything that is
   * about page content (windows, blob sizes) follows the page size instead.
   */
  sourceScale: number;
}

export const DEFAULT_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  threshold: 0,
  sharpen: 0.35,
};

/**
 * Lengths below are fractions of the page's long edge, so a 1400 px preview
 * and a 3500 px export apply the same filter to the same part of the page.
 */
const SAUVOLA_RADIUS = 0.012;
const SPECK_EDGE = 0.0011;
const COLOR_BLOB_EDGE = 0.004;
/** Width of the border band in which edge slivers are removed. */
const BORDER_BAND = 0.012;

function longEdge(image: { width: number; height: number }): number {
  return Math.max(image.width, image.height);
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Unsharp mask driven by luma, applied equally to all channels so it adds no
 * colour fringes. The blur here only builds the detail signal; the output is
 * sharper than the input, never softer.
 */
function sharpenRGBA(src: RGBAImage, amount: number, ctx: FilterContext): RGBAImage {
  if (amount <= 0) return src;
  const luma = toLuma(src);
  const sigma = 0.9 * Math.max(1, ctx.sourceScale);
  const blurred = gaussian(luma, sigma);
  const out = createRGBA(src.width, src.height);
  const gain = amount * 1.6;
  for (let i = 0, p = 0; i < luma.data.length; i++, p += 4) {
    const detail = (luma.data[i] - blurred.data[i]) * 255 * gain;
    out.data[p] = src.data[p] + detail;
    out.data[p + 1] = src.data[p + 1] + detail;
    out.data[p + 2] = src.data[p + 2] + detail;
    out.data[p + 3] = 255;
  }
  return out;
}

/** White and black points for a flattened page, in 0..1 luma. */
function tonePoints(luma: FloatImage, adj: Adjustments): { white: number; black: number } {
  // The darkest few percent of ink defines black. Sample sparsely: this only
  // needs a histogram, not every pixel.
  const hist = new Uint32Array(256);
  let inkCount = 0;
  const step = Math.max(1, Math.floor(luma.data.length / 400_000));
  for (let i = 0; i < luma.data.length; i += step) {
    const v = luma.data[i];
    if (v < 0.6) {
      hist[Math.max(0, Math.min(255, Math.round(v * 255)))]++;
      inkCount++;
    }
  }
  let black = 0.12;
  if (inkCount > 50) {
    const target = inkCount * 0.05;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) {
        // Never map anything lighter than mid-dark grey to pure black.
        black = Math.min(0.35, i / 255 + 0.04);
        break;
      }
    }
  }
  black = Math.max(0, Math.min(0.5, black + adj.contrast * 0.12));
  const white = Math.max(black + 0.2, Math.min(1, 0.9 - adj.brightness * 0.07));
  return { white, black };
}

/**
 * Colour and greyscale enhancement on a flattened page: a levels curve that
 * sends paper to exactly 255 and the darkest ink to 0, plus a mild saturation
 * lift so colour content does not look washed out next to the white paper.
 */
function enhanceColor(flat: RGBAImage, adj: Adjustments, gray: boolean): RGBAImage {
  const luma = toLuma(flat);
  const { white, black } = tonePoints(luma, adj);
  const out = createRGBA(flat.width, flat.height);
  const scale = 1 / (white - black);
  const sat = 1.15;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v / 255 - black) * scale));
    // A gentle S-curve on top of the levels keeps mid-tones from going muddy.
    const s = t * t * (3 - 2 * t);
    lut[v] = 255 * (0.7 * t + 0.3 * s);
  }
  for (let i = 0, p = 0; i < luma.data.length; i++, p += 4) {
    if (gray) {
      const v = lut[Math.round(luma.data[i] * 255)];
      out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
    } else {
      const l = luma.data[i] * 255;
      for (let c = 0; c < 3; c++) {
        const v = l + (flat.data[p + c] - l) * sat;
        out.data[p + c] = lut[v < 0 ? 0 : v > 255 ? 255 : Math.round(v)];
      }
    }
    out.data[p + 3] = 255;
  }
  return out;
}

/**
 * Black text on white paper, as a coverage map (0 = ink, 1 = paper).
 *
 * The threshold surface is Sauvola's, computed on the flattened page. Instead
 * of snapping to 0/1 and blurring the result back into anti-aliasing (which is
 * what makes cheap scanners look soft), each pixel is mapped through a narrow
 * linear ramp centred on its threshold. Pixels clearly on one side become pure
 * black or pure white; the one or two pixels that straddle a stroke edge keep
 * a proportional grey, so edges stay exactly as sharp as the optics allowed.
 */
function inkCoverage(flat: RGBAImage, adj: Adjustments, ctx: FilterContext): FloatImage {
  // A whisker of smoothing at the scale of the camera's noise. On its own it
  // would soften; ahead of the threshold ramp it only straightens the wobble
  // that JPEG blocks and sensor noise put into glyph outlines, because the
  // ramp then re-sharpens every edge.
  const luma = gaussian(toLuma(flat), 0.45 * Math.max(1, ctx.sourceScale) * (1.2 - adj.sharpen));
  const { width, height } = luma;
  const radius = Math.max(4, Math.round(longEdge(luma) * SAUVOLA_RADIUS));
  const { mean, std } = localStats(luma, radius);
  const k = 0.2 + adj.threshold * 0.12;
  const R = 0.5;
  // Anything this close to paper is paper, whatever the local statistics say.
  const paperCut = Math.min(0.97, 0.88 - adj.brightness * 0.05);
  const inkCut = 0.22 + adj.contrast * 0.08;
  const flatCut = 0.55 - adj.threshold * 0.08;
  const darkCut = flatCut - 0.05;

  const out = createFloat(width, height);
  for (let i = 0; i < out.data.length; i++) {
    const v = luma.data[i];
    if (v >= paperCut) {
      out.data[i] = 1;
      continue;
    }
    if (v <= inkCut) {
      out.data[i] = 0;
      continue;
    }
    const m = mean.data[i];
    const s = std.data[i];
    // Sauvola needs local contrast to work with. Inside a large flat region
    // (a solid logo, a filled box, a tinted table cell) there is none, and its
    // threshold slides to just under the local mean, hollowing the fill out.
    // There, decide on absolute darkness instead: dark fills go solid black,
    // light tints go white. Text always has contrast, so it stays adaptive.
    const adaptive = m * (1 + k * (s / R - 1));
    const w = smoothstep(0.015, 0.05, s);
    // And whatever the statistics say, anything this dark is ink: near the
    // edge of a solid shape Sauvola's window straddles the edge and would
    // otherwise leave a white ring inside it.
    const t = Math.min(paperCut, Math.max(darkCut, w * adaptive + (1 - w) * flatCut));
    // Ramp half-width tracks local contrast: crisp on bold print, a little
    // more forgiving on faint pencil.
    const half = Math.min(0.1, Math.max(0.035, s * 0.35));
    let c = (v - t) / (2 * half) + 0.5;
    // Solid dark areas go fully black over a short ramp of their own, rather
    // than sitting in the grey middle of a wide edge ramp.
    if (v < darkCut) c = Math.min(c, (v - (darkCut - 0.06)) / 0.06);
    out.data[i] = c < 0 ? 0 : c > 1 ? 1 : c;
  }

  // Hysteresis cleanup. Every non-white blob (a glyph plus its anti-aliased
  // fringe) survives only if it holds enough real ink. That removes faint
  // grey noise and dots far smaller than a full stop, while every pixel of a
  // genuine glyph, fringe included, is kept.
  const speck = Math.max(2, Math.round((longEdge(luma) * SPECK_EDGE) ** 2));
  const touched = new Uint8Array(out.data.length);
  for (let i = 0; i < touched.length; i++) touched[i] = out.data[i] < 0.97 ? 1 : 0;
  const { labels, areas } = labelComponents(touched, width, height);
  const core = new Int32Array(areas.length);
  for (let i = 0; i < labels.length; i++) if (labels[i] && out.data[i] < 0.5) core[labels[i]]++;
  const keep = new Uint8Array(touched.length);
  for (let i = 0; i < keep.length; i++) keep[i] = labels[i] && core[labels[i]] >= speck ? 1 : 0;
  clearBorderSlivers(keep, width, height);
  for (let i = 0; i < keep.length; i++) if (touched[i] && !keep[i]) out.data[i] = 1;

  return out;
}

/**
 * Remove components that lie (almost) entirely in a thin band along the image
 * border: the strip of table or page edge a crop grazes, never content. Judged
 * by the share of pixels in the band rather than by bounding box, so slivers
 * along two edges that meet in a corner still count. Mutates `mask`.
 */
function clearBorderSlivers(mask: Uint8Array, width: number, height: number): void {
  const band = Math.max(3, Math.round(Math.max(width, height) * BORDER_BAND));
  const { labels, areas } = labelComponents(mask, width, height);
  const inBand = new Int32Array(areas.length);
  const touches = new Uint8Array(areas.length);
  for (let y = 0; y < height; y++) {
    const yBand = y < band || y >= height - band;
    const yEdge = y === 0 || y === height - 1;
    for (let x = 0; x < width; x++) {
      const l = labels[y * width + x];
      if (!l) continue;
      if (yBand || x < band || x >= width - band) inBand[l]++;
      if (yEdge || x === 0 || x === width - 1) touches[l] = 1;
    }
  }
  for (let i = 0; i < mask.length; i++) {
    const l = labels[i];
    if (l && touches[l] && inBand[l] >= areas[l] * 0.9) mask[i] = 0;
  }
}

/**
 * Per-pixel weight of colour content in [0, 1]: saturated, not paper, and part
 * of a blob large enough to be a logo, stamp, highlight or signature rather
 * than a chromatic-aberration fringe on black text.
 */
function colorWeight(flat: RGBAImage): FloatImage {
  const { width, height, data } = flat;
  const n = width * height;
  const weight = createFloat(width, height);
  const mask = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    const saturation = max > 0 ? chroma / max : 0;
    const w = smoothstep(28, 60, chroma) * smoothstep(0.22, 0.38, saturation) * (max < 250 ? 1 : 0);
    weight.data[i] = w;
    mask[i] = w > 0.5 ? 1 : 0;
  }
  const minBlob = Math.max(4, Math.round((longEdge(flat) * COLOR_BLOB_EDGE) ** 2));
  removeSmallComponents(mask, width, height, minBlob);
  clearBorderSlivers(mask, width, height);
  const grown = dilate(dilate(mask, width, height), width, height);
  for (let i = 0; i < n; i++) if (!grown[i]) weight.data[i] = 0;
  return weight;
}

export function applyFilter(
  src: RGBAImage,
  filter: FilterId,
  adj: Adjustments = DEFAULT_ADJUSTMENTS,
  ctx: FilterContext = { sourceScale: 1 },
): RGBAImage {
  if (filter === 'original') return sharpenRGBA(src, adj.sharpen * 0.5, ctx);

  const flat = flattenPaper(src);
  if (filter === 'color') return enhanceColor(sharpenRGBA(flat, adj.sharpen, ctx), adj, false);
  if (filter === 'gray') return enhanceColor(sharpenRGBA(flat, adj.sharpen, ctx), adj, true);

  const ink = inkCoverage(flat, adj, ctx);
  const out = createRGBA(src.width, src.height);
  if (filter === 'bw') {
    for (let i = 0, p = 0; i < ink.data.length; i++, p += 4) {
      const v = ink.data[i] * 255;
      out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
      out.data[p + 3] = 255;
    }
    return out;
  }

  // document: B&W text, colour content composited from the enhanced colour page.
  const color = enhanceColor(sharpenRGBA(flat, adj.sharpen, ctx), adj, false);
  const weight = colorWeight(flat);
  for (let i = 0, p = 0; i < ink.data.length; i++, p += 4) {
    const w = weight.data[i];
    const v = ink.data[i] * 255;
    out.data[p] = v + (color.data[p] - v) * w;
    out.data[p + 1] = v + (color.data[p + 1] - v) * w;
    out.data[p + 2] = v + (color.data[p + 2] - v) * w;
    out.data[p + 3] = 255;
  }
  return out;
}

/** Whether a filter's output is greyscale, so the PDF can store one channel. */
export function isGrayFilter(filter: FilterId): boolean {
  return filter === 'bw' || filter === 'gray';
}
