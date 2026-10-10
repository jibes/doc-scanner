import { analysePaper, flattenPaper, PICTURE, type PaperAnalysis } from './background';
import { boxMean, darkClassLevel, gaussian, halve, minFilter, sampleHalf } from './box';
import { keepBlobs, measureBlobs } from './cleanup';
import { dilate, labelComponents, removeSmallComponents } from './components';
import { createFloat, createRGBA, luma01, toLuma, type FloatImage, type RGBAImage } from './image';

/**
 * - `document`: black text on pure white, colour content (logos, stamps,
 *   signatures, highlights, coloured print, photos, colour areas) kept in
 *   colour. The default.
 * - `bw`: strictly black and white; photos and colour areas two-tone.
 * - `gray`: flattened greyscale with clean white paper.
 * - `color`: flattened colour; the paper keeps its own colour (white paper
 *   is white), shadows and colour casts removed.
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
/** Stroke width beyond which a faint blob is shading, not print. */
const FAINT_THICKNESS = 0.005;
/** Faint thin streaks shorter than this are fold or crease shadows. */
const DASH_LENGTH = 0.15;
/** Longest stroke of a single letter (an l, a 1). */
const GLYPH_LENGTH = 0.025;
/** Below this ink-to-paper contrast nothing is print. */
const MIN_INK_CONTRAST = 0.2;
/** Faint blobs with an area below this length squared are noise. */
const FAINT_EDGE = 0.0025;
const SPECK_EDGE = 0.0006;
const COLOR_BLOB_EDGE = 0.004;
/** Width of the border band in which edge slivers are removed. */
const BORDER_BAND = 0.012;
/**
 * A blob whose core has at least this chroma (0..255) and purity (chroma
 * over distance from white, which mixing with paper does not change) is
 * coloured print.
 */
const INK_CHROMA = 25;
const INK_PURITY = 0.35;
/**
 * Faded pages: where the darkest print (the ink level reached over an area of
 * FADED_EXTENT of the long edge squared, a few words) lies between FADED_MIN
 * and FADED_MAX, contrast is stretched so that it lands on FADED_TARGET, by
 * at most FADED_GAIN.
 */
const FADED_EXTENT = 0.02;
const FADED_MIN = 0.45;
const FADED_MAX = 0.85;
const FADED_TARGET = 0.3;
const FADED_GAIN = 4;
/** B&W: smoothing of a picture's smooth tones (fraction of the long edge) before its threshold. */
const PICTURE_SMOOTH = 0.003;
/** B&W: specks in a thresholded picture smaller than this (fraction of the long edge, squared) are noise. */
const PICTURE_SPECK = 0.0012;
/** Paper saturation up to which a warm tint is taken for the light, and any other tint. */
const WARM_CAST_MAX = 0.22;
const OTHER_CAST_MAX = 0.05;

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
  // The darkest few percent of ink defines black, but never more than a
  // sliver of the page: on a dark flyer or a photo most of the page is
  // darker than 0.6, and its typical tone must not become black. Sample
  // sparsely: this only needs a histogram, not every pixel.
  const hist = new Uint32Array(256);
  let inkCount = 0;
  let samples = 0;
  const step = Math.max(1, Math.floor(luma.data.length / 400_000));
  for (let i = 0; i < luma.data.length; i += step, samples++) {
    const v = luma.data[i];
    if (v < 0.6) {
      hist[Math.max(0, Math.min(255, Math.round(v * 255)))]++;
      inkCount++;
    }
  }
  let black = 0.12;
  if (inkCount > 50) {
    const target = Math.min(inkCount * 0.05, samples * 0.005);
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
function enhanceColor(
  flat: RGBAImage,
  adj: Adjustments,
  gray: boolean,
  picture: FloatImage | null,
): RGBAImage {
  const luma = toLuma(flat);
  const { white, black } = tonePoints(luma, adj);
  const out = createRGBA(flat.width, flat.height);
  const sat = 1.15;
  const curve = (whitePoint: number) => {
    const lut = new Float32Array(256);
    const scale = 1 / (whitePoint - black);
    for (let v = 0; v < 256; v++) {
      const t = Math.min(1, Math.max(0, (v / 255 - black) * scale));
      // A gentle S-curve on top of the levels keeps mid-tones from going muddy.
      const s = t * t * (3 - 2 * t);
      lut[v] = 255 * (0.7 * t + 0.3 * s);
    }
    return lut;
  };
  // Paper is pushed to white well before its nominal 1.0, so its noise and
  // leftover shading vanish. Photos and colour areas are not paper: there
  // the same push would bleach light colours (a peach panel turning pale
  // yellow as its green channel clips), so they get the full range.
  const lut = curve(white);
  const pictureLut = curve(Math.max(white, Math.min(1, 1 - adj.brightness * 0.07)));
  const pw = picture?.data;
  for (let i = 0, p = 0; i < luma.data.length; i++, p += 4) {
    const w = pw ? pw[i] : 0;
    if (gray) {
      const k = Math.round(luma.data[i] * 255);
      out.data[p] = out.data[p + 1] = out.data[p + 2] = lut[k] + (pictureLut[k] - lut[k]) * w;
    } else {
      const l = luma.data[i] * 255;
      for (let c = 0; c < 3; c++) {
        const v = l + (flat.data[p + c] - l) * sat;
        const k = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
        out.data[p + c] = lut[k] + (pictureLut[k] - lut[k]) * w;
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
/**
 * Faded print (an old photocopy, a washed-out page): when even the darkest
 * print on the page is light grey, every rule that tells print from shading
 * by its darkness would drop all of it. Stretch the contrast instead, so the
 * page's darkest print becomes dark grey. Judged on the local ink level (the
 * typical stroke darkness), which covers whole lines of text: a page needs
 * text, not a crease or a speck, to count as faded. Paper stays at 1. All
 * three fields are mapped the same way (they are averages and order
 * statistics of the same values, so the map commutes with them). Mutates.
 */
function stretchFadedPrint(luma: FloatImage, half: FloatImage, inkLevel: FloatImage): void {
  const hist = new Uint32Array(256);
  const d = inkLevel.data;
  for (let i = 0; i < d.length; i++) hist[Math.max(0, Math.min(255, Math.round(d[i] * 255)))]++;
  let acc = 0;
  let level = 1;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= Math.max(16, (FADED_EXTENT * Math.max(inkLevel.width, inkLevel.height)) ** 2)) {
      level = i / 255;
      break;
    }
  }
  if (level <= FADED_MIN || level >= FADED_MAX) return;
  const gain = Math.min(FADED_GAIN, (1 - FADED_TARGET) / (1 - level));
  for (const field of [luma.data, half.data, d]) {
    for (let i = 0; i < field.length; i++) field[i] = Math.max(0, 1 - (1 - field[i]) * gain);
  }
}

interface InkLayer {
  /** Coverage, 0 = ink, 1 = paper. */
  ink: FloatImage;
  /** Kept blob of every pixel (0 = none). */
  labels: Int32Array;
  /** Per blob: how far grey print is lifted towards white in the Document filter. */
  tone: Float32Array;
  /** Per blob: its darkest (smoothed) luma. */
  darkest: Float32Array;
}

function inkCoverage(flat: RGBAImage, adj: Adjustments, ctx: FilterContext): InkLayer {
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
  stretchFadedPrint(luma, half, inkLevel);
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
    glyphMaxLength: L * GLYPH_LENGTH,
    faintMaxThickness: Math.max(4, L * FAINT_THICKNESS),
    band,
    // Enlarging the photo softens every edge by the same factor.
    faintMinGradient: 0.15 / Math.max(1, ctx.sourceScale),
  });
  // Grey print (light rules, grey small print) can stay grey rather than be
  // forced to black; anything printed dark is pure black.
  const tone = new Float32Array(blobs.length);
  const darkest = new Float32Array(blobs.length);
  for (let l = 1; l < blobs.length; l++) {
    const b = blobs[l];
    if (!b || !keep[l]) continue;
    tone[l] = Math.min(0.6, Math.max(0, (b.minLuma - 0.3) / 0.6));
    darkest[l] = b.minLuma;
  }
  for (let i = 0; i < out.data.length; i++) {
    const l = labels[i];
    if (!l) continue;
    if (!keep[l]) {
      out.data[i] = 1;
      labels[i] = 0;
    }
  }

  return { ink: out, labels, tone, darkest };
}

/**
 * Coloured print drawn as ink: per kept blob, the mean colour of its core in
 * the flattened page. Blobs whose core is clearly coloured (links, coloured
 * headings and rules, ballpoint signatures) get that colour; everything else
 * gets none (-1). Returns RGB per label.
 *
 * The core of a thin line is still part paper: the lens mixes the ink with
 * white. Mixing with white scales the colour's chroma and its distance from
 * white alike, so their ratio (the colour's purity) tells coloured from
 * grey or black print however thin the line; and the colour is extended
 * from white until it is as dark as the blob's darkest point.
 */
function inkColours(ink: InkLayer, color: RGBAImage): Float32Array {
  const { labels } = ink;
  const n = ink.tone.length;
  const sums = new Float64Array(n * 4);
  const cov = ink.ink.data;
  for (let i = 0, p = 0; i < labels.length; i++, p += 4) {
    const l = labels[i];
    if (!l || cov[i] > 0.5) continue;
    sums[l * 4] += color.data[p];
    sums[l * 4 + 1] += color.data[p + 1];
    sums[l * 4 + 2] += color.data[p + 2];
    sums[l * 4 + 3]++;
  }
  const rgb = new Float32Array(n * 3).fill(-1);
  for (let l = 1; l < n; l++) {
    const count = sums[l * 4 + 3];
    if (count < 2) continue;
    const r = sums[l * 4] / count;
    const g = sums[l * 4 + 1] / count;
    const b = sums[l * 4 + 2] / count;
    const min = Math.min(r, g, b);
    const chroma = Math.max(r, g, b) - min;
    if (chroma < INK_CHROMA || chroma < INK_PURITY * (255 - min)) continue;
    const depth = 1 - luma01(r, g, b);
    const s = Math.min(3, Math.max(1, (1 - ink.darkest[l]) / Math.max(0.05, depth)));
    rgb[l * 3] = Math.max(0, 255 - (255 - r) * s);
    rgb[l * 3 + 1] = Math.max(0, 255 - (255 - g) * s);
    rgb[l * 3 + 2] = Math.max(0, 255 - (255 - b) * s);
  }
  return rgb;
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

/**
 * The paper's own colour, as a per-channel factor (1 = white), or white when
 * the tint is more likely the light than the paper.
 *
 * Only the page is seen, so a cast from the light and a coloured sheet look
 * alike. Phones white-balance, and what is left of a lamp's or the sun's
 * colour lies on the warm (orange-yellow) axis and stays moderate; so a warm
 * tint counts as paper colour only when it is strong (yellow paper), while
 * a tint of any other hue (blue, green, pink paper) counts already when
 * mild, since light rarely tints a page that way.
 */
export function paperTint(paper: readonly [number, number, number]): [number, number, number] {
  const [r, g, b] = paper;
  const max = Math.max(r, g, b, 1);
  const d = max - Math.min(r, g, b);
  const sat = d / max;
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = 60 * (((g - b) / d + 6) % 6);
    else if (max === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
  }
  const warm = hue >= 15 && hue <= 70;
  const k = warm
    ? smoothstep(WARM_CAST_MAX, WARM_CAST_MAX + 0.08, sat)
    : smoothstep(OTHER_CAST_MAX, OTHER_CAST_MAX + 0.04, sat);
  return [1 - k * (1 - r / max), 1 - k * (1 - g / max), 1 - k * (1 - b / max)];
}

/** Multiply by the paper colour, as if printed on it. Mutates and returns `image`. */
function onPaper(image: RGBAImage, tint: readonly [number, number, number]): RGBAImage {
  if (tint[0] === 1 && tint[1] === 1 && tint[2] === 1) return image;
  const d = image.data;
  for (let p = 0; p < d.length; p += 4) {
    d[p] *= tint[0];
    d[p + 1] *= tint[1];
    d[p + 2] *= tint[2];
  }
  return image;
}

/**
 * Per output pixel, 1 inside photos, colour areas and dark areas (which the
 * Document filter shows as they are), 0 on paper and pale neutral tints.
 * Null when there are none.
 */
function pictureWeight(analysis: PaperAnalysis, width: number, height: number): FloatImage | null {
  const { cols, rows, block } = analysis.surface;
  const coarse = createFloat(cols, rows);
  let any = false;
  for (let i = 0; i < coarse.data.length; i++) {
    if (analysis.regions[i] === PICTURE) {
      coarse.data[i] = 1;
      any = true;
    }
  }
  if (!any) return null;
  const soft = boxMean(coarse, 1).data;
  const out = createFloat(width, height);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(rows - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(rows - 1, y0 + 1);
    const ty = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(cols - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(cols - 1, x0 + 1);
      const tx = gx - x0;
      out.data[y * width + x] =
        (soft[y0 * cols + x0] * (1 - tx) + soft[y0 * cols + x1] * tx) * (1 - ty) +
        (soft[y1 * cols + x0] * (1 - tx) + soft[y1 * cols + x1] * tx) * ty;
    }
  }
  return out;
}

export function applyFilter(
  src: RGBAImage,
  filter: FilterId,
  adj: Adjustments = DEFAULT_ADJUSTMENTS,
  ctx: FilterContext = { sourceScale: 1 },
): RGBAImage {
  // Perspective correction only: no sharpening, no tone change.
  if (filter === 'original') return src;

  const analysis = analysePaper(src);
  const flat = flattenPaper(src, analysis.surface);
  const picture = pictureWeight(analysis, src.width, src.height);
  if (filter === 'color') {
    return onPaper(
      enhanceColor(sharpenRGBA(flat, adj.sharpen, ctx), adj, false, picture),
      paperTint(analysis.paper),
    );
  }
  if (filter === 'gray') {
    return enhanceColor(sharpenRGBA(flat, adj.sharpen, ctx), adj, true, picture);
  }

  const layer = inkCoverage(flat, adj, ctx);
  const ink = layer.ink.data;
  const out = createRGBA(src.width, src.height);
  const od = out.data;
  if (filter === 'bw') {
    // Strictly two levels: the coverage ramp is centred on each stroke's true
    // edge, so cutting it at one half keeps the printed stroke width. Photos
    // and colour areas get one fixed threshold on their tone instead (a
    // two-tone picture, with dark lettering on light grounds and light
    // lettering on dark ones), minus the specks that noise leaves where a
    // smooth tone sits right at the threshold.
    const dark = new Uint8Array(ink.length);
    for (let i = 0; i < ink.length; i++) dark[i] = ink[i] < 0.5 ? 1 : 0;
    if (picture) {
      // Smooth tones are judged on a well smoothed copy (noise would put
      // specks all along a tone that sits at the threshold), detail such as
      // lettering on the barely smoothed one.
      const pictureLuma = toLuma(flat);
      const sharp = boxMean(pictureLuma, 1).data;
      const smooth = boxMean(
        pictureLuma,
        Math.max(2, Math.round(longEdge(src) * PICTURE_SMOOTH)),
      ).data;
      const inPicture = new Uint8Array(ink.length);
      for (let i = 0; i < ink.length; i++) {
        if (picture.data[i] <= 0.5) continue;
        inPicture[i] = 1;
        const v = Math.abs(sharp[i] - smooth[i]) > 0.12 ? sharp[i] : smooth[i];
        dark[i] = v < 0.5 ? 1 : 0;
      }
      const speck = Math.max(2, Math.round((longEdge(src) * PICTURE_SPECK) ** 2));
      for (const value of [1, 0]) {
        const mask = new Uint8Array(ink.length);
        for (let i = 0; i < ink.length; i++) mask[i] = inPicture[i] && dark[i] === value ? 1 : 0;
        const { labels, areas } = labelComponents(mask, src.width, src.height);
        for (let i = 0; i < ink.length; i++) {
          if (mask[i] && areas[labels[i]] < speck) dark[i] = 1 - value;
        }
      }
    }
    for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
      od[p] = od[p + 1] = od[p + 2] = dark[i] ? 0 : 255;
      od[p + 3] = 255;
    }
    return out;
  }

  // document: black (or grey) text; coloured print in its own colour; logos,
  // stamps, highlights, photos and colour areas composited from the enhanced
  // colour page. Most pages have little or no colour, so that page is only
  // computed when needed.
  const { labels, tone } = layer;
  const colours = inkColours(layer, flat);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    const l = labels[i];
    const c = ink[i];
    if (l && colours[l * 3] >= 0) {
      od[p] = colours[l * 3] + (255 - colours[l * 3]) * c;
      od[p + 1] = colours[l * 3 + 1] + (255 - colours[l * 3 + 1]) * c;
      od[p + 2] = colours[l * 3 + 2] + (255 - colours[l * 3 + 2]) * c;
    } else {
      od[p] = od[p + 1] = od[p + 2] = (c + (1 - c) * tone[l]) * 255;
    }
    od[p + 3] = 255;
  }
  const weight = colorWeight(flat);
  let hasColor = picture !== null;
  for (let i = 0; i < weight.data.length && !hasColor; i++) hasColor = weight.data[i] > 0;
  if (!hasColor) return out;
  const color = enhanceColor(sharpenRGBA(flat, adj.sharpen, ctx), adj, false, picture);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    const w = picture ? Math.max(weight.data[i], picture.data[i]) : weight.data[i];
    if (w <= 0) continue;
    od[p] += (color.data[p] - od[p]) * w;
    od[p + 1] += (color.data[p + 1] - od[p + 1]) * w;
    od[p + 2] += (color.data[p + 2] - od[p + 2]) * w;
  }
  return out;
}

/** Whether a filter's output is greyscale, so the PDF can store one channel. */
export function isGrayFilter(filter: FilterId): boolean {
  return filter === 'bw' || filter === 'gray';
}
