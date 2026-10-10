import { flattenPaper } from './background';
import { boxMean, darkClassLevel, gaussian, halve, minFilter, sampleHalf } from './box';
import { keepBlobs, measureBlobs } from './cleanup';
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
  /** -1..1. For document/bw: text weight. Positive is bolder, negative thinner; 0 keeps the true stroke width. */
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
/** Window for the local ink level: about one glyph. */
const INK_WINDOW = 0.004;
/** Window for "darker than its surroundings": a few lines of text. */
const CONTEXT_WINDOW = 0.012;
/** Average thickness beyond which a faint blob is shading, not print. */
const FAINT_THICKNESS = 0.0035;
/** Faint thin streaks shorter than this are fold or crease shadows. */
const DASH_LENGTH = 0.15;
/** Below this ink-to-paper contrast nothing is print. */
const MIN_INK_CONTRAST = 0.2;
/** Faint blobs with an area below this length squared are noise. */
const FAINT_EDGE = 0.0025;
const SPECK_EDGE = 0.0006;
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
 * Stroke width is preserved by putting each pixel's threshold halfway between
 * the local ink level and the paper. A camera blurs every edge into a ramp
 * from ink to paper; cutting that ramp at its midpoint lands exactly on the
 * true edge, whereas Sauvola-style thresholds sit near the paper end and make
 * every stroke as much bolder as the lens was soft. Paper is 1.0 here (the
 * page is flattened), and the local ink level is the darkest value within a
 * glyph-sized window.
 *
 * Instead of snapping to 0/1 and blurring the result back into anti-aliasing
 * (what makes cheap scanners look soft), each pixel goes through a narrow
 * linear ramp centred on its threshold: clearly-ink is pure black,
 * clearly-paper pure white, and only pixels straddling an edge keep a grey.
 */
function inkCoverage(
  flat: RGBAImage,
  adj: Adjustments,
  ctx: FilterContext,
  preserveGray: boolean,
): FloatImage {
  // A whisker of smoothing at the scale of the camera's noise straightens the
  // wobble that JPEG blocks and sensor noise put into glyph outlines; the
  // ramp below re-sharpens every edge, so nothing ends up soft.
  // (No name for the unblurred luma, so it can be freed straight away.)
  const luma = gaussian(toLuma(flat), 0.45 * Math.max(1, ctx.sourceScale) * (1.2 - adj.sharpen));
  const { width, height } = luma;
  const L = longEdge(luma);
  const inkRadius = Math.max(2, Math.round(L * INK_WINDOW));
  // Smooth fields (ink level, presence, context) are computed at half
  // resolution: they vary over tens of pixels, and this is 4x cheaper.
  const half = halve(luma);
  const halfRadius = Math.max(2, inkRadius >> 1);
  // Typical stroke darkness nearby; see darkClassLevel for why not the minimum.
  const inkLevel = darkClassLevel(half, Math.round(halfRadius * 1.5));
  // Whether there is print here at all: the darkest value nearby, so a
  // one-pixel rule still counts.
  // Halved by taking the darkest of each 2x2, so a one-pixel rule is not
  // diluted with paper first.
  const presence = boxMean(minFilter(halve(luma, true), halfRadius), halfRadius);
  const mean = boxMean(half, Math.max(2, Math.round((L * CONTEXT_WINDOW) / 2)));

  // Where on the ink-to-paper ramp to cut: 0.5 is the true edge. "Text weight"
  // moves it towards paper (bolder) or towards ink (thinner).
  const cut = 0.5 + adj.threshold * 0.12;
  const paperCut = Math.min(0.97, 0.9 - adj.brightness * 0.05);
  // Anything this dark is ink whatever its surroundings, so solid shapes are
  // filled rather than outlined.
  const darkCut = 0.45 + adj.contrast * 0.08;

  const out = createFloat(width, height);
  for (let i = 0; i < out.data.length; i++) {
    const v = luma.data[i];
    if (v >= paperCut) {
      out.data[i] = 1;
      continue;
    }
    const x = i % width;
    const y = (i - x) / width;
    const ink = sampleHalf(inkLevel, x, y);
    const contrast = 1 - ink;
    const present = 1 - sampleHalf(presence, x, y) >= MIN_INK_CONTRAST;
    // Too little contrast to be print (fold shadows, tints, paper texture):
    // only genuinely dark pixels count.
    let t = present ? ink + contrast * cut : darkCut;
    // Ink is darker than its surroundings. A light tint fills its own
    // neighbourhood, so it fails this and stays white instead of turning
    // into a black block.
    t = Math.min(t, sampleHalf(mean, x, y) - 0.015);
    t = Math.min(paperCut, Math.max(darkCut, t));
    const half = Math.min(0.05, Math.max(0.015, contrast * 0.06));
    let c = (v - t) / (2 * half) + 0.5;
    // Solid dark areas go fully black over a short ramp of their own.
    if (v < darkCut) c = Math.min(c, (v - (darkCut - 0.06)) / 0.06);
    out.data[i] = c < 0 ? 0 : c > 1 ? 1 : c;
  }

  // Component cleanup: every non-white blob (a glyph plus its anti-aliased
  // fringe) is kept or dropped as a whole, so kept glyphs keep every edge
  // pixel and dropped noise leaves nothing behind. See cleanup.ts.
  const touched = new Uint8Array(out.data.length);
  for (let i = 0; i < touched.length; i++) touched[i] = out.data[i] < 0.97 ? 1 : 0;
  const band = Math.max(3, Math.round(L * BORDER_BAND));
  const { labels, blobs } = measureBlobs(touched, luma, band);
  const keep = keepBlobs(blobs, width, height, {
    speck: Math.max(2, Math.round((L * SPECK_EDGE) ** 2)),
    faintMinArea: Math.max(12, Math.round((L * FAINT_EDGE) ** 2)),
    dashMaxLength: L * DASH_LENGTH,
    faintMaxThickness: Math.max(4, L * FAINT_THICKNESS),
    band,
    // Enlarging the photo softens every edge by the same factor.
    faintMinGradient: 0.15 / Math.max(1, ctx.sourceScale),
  });
  for (let i = 0; i < out.data.length; i++) {
    const l = labels[i];
    if (!l) continue;
    if (!keep[l]) {
      out.data[i] = 1;
      continue;
    }
    if (preserveGray) {
      // Grey print (light rules, grey small print) stays grey rather than
      // being forced to black; anything printed dark is pure black.
      const tone = Math.min(0.6, Math.max(0, (blobs[l]!.minLuma - 0.3) / 0.6));
      out.data[i] = out.data[i] + (1 - out.data[i]) * tone;
    }
  }

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
  const grown = dilate(mask, width, height, 2);
  for (let i = 0; i < n; i++) if (!grown[i]) weight.data[i] = 0;
  return weight;
}

export function applyFilter(
  src: RGBAImage,
  filter: FilterId,
  adj: Adjustments = DEFAULT_ADJUSTMENTS,
  ctx: FilterContext = { sourceScale: 1 },
): RGBAImage {
  // Perspective correction only: no sharpening, no tone change.
  if (filter === 'original') return src;

  const flat = flattenPaper(src);
  if (filter === 'color') return enhanceColor(sharpenRGBA(flat, adj.sharpen, ctx), adj, false);
  if (filter === 'gray') return enhanceColor(sharpenRGBA(flat, adj.sharpen, ctx), adj, true);

  const ink = inkCoverage(flat, adj, ctx, filter === 'document');
  const out = createRGBA(src.width, src.height);
  if (filter === 'bw') {
    for (let i = 0, p = 0; i < ink.data.length; i++, p += 4) {
      const v = ink.data[i] * 255;
      out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
      out.data[p + 3] = 255;
    }
    return out;
  }

  // document: B&W text, colour content composited from the enhanced colour
  // page. Most pages have little or no colour, so the colour layer is only
  // computed when there is some.
  const weight = colorWeight(flat);
  let hasColor = false;
  for (let i = 0; i < weight.data.length && !hasColor; i++) hasColor = weight.data[i] > 0;
  if (!hasColor) {
    for (let i = 0, p = 0; i < ink.data.length; i++, p += 4) {
      const v = ink.data[i] * 255;
      out.data[p] = out.data[p + 1] = out.data[p + 2] = v;
      out.data[p + 3] = 255;
    }
    return out;
  }
  const color = enhanceColor(sharpenRGBA(flat, adj.sharpen, ctx), adj, false);
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
