import { applyHomography, homography, isConvex, quadArea } from '../imaging/quad';
import type { Point, Quad, RGBAImage } from '../imaging/image';

/**
 * Classical page finder that checks and, where needed, replaces the neural
 * detector's quad.
 *
 * DocAligner is trained on pages that are mostly white with dark text. It
 * misses pages that fill most of the frame, and on pages with large coloured
 * areas it latches onto internal content: the white part under a photo, a
 * coloured band, a diagonal through a gradient. Page edges, though, are long
 * straight steps in colour that run the whole length of each side, which a
 * line search over the photo finds reliably.
 *
 * 1. Colour gradients (Sobel, strongest of R, G, B) vote in a Hough transform;
 *    each vote is capped so a long faint edge outweighs a short high-contrast
 *    one (a text line is mostly gaps).
 * 2. Every line found gets a support profile: at each pixel along it, is
 *    there a colour step across it? Prefix sums make any segment's support an
 *    O(1) lookup.
 * 3. Quads from two roughly opposite pairs of lines are scored. A side
 *    counts only if it is supported along nearly its whole length (within the
 *    frame) and right up to both corners, so a line that merely continues
 *    past the page's corner into the table does not qualify.
 * 4. Of the fully supported quads, the largest wins: the page boundary is the
 *    outermost one, while a photo's or a coloured band's edge inside the page
 *    only bounds a smaller quad. When the model's quad is itself fully
 *    supported, a replacement must contain it.
 */

/** Colour planes (0..1) at the search resolution. */
export interface Planes {
  width: number;
  height: number;
  c: [Float32Array, Float32Array, Float32Array];
}

/** Box-downsample an RGBA image by an integer factor into three float planes. */
export function colourPlanes(img: RGBAImage, factor: number): Planes {
  const f = Math.max(1, Math.floor(factor));
  const width = Math.max(1, Math.floor(img.width / f));
  const height = Math.max(1, Math.floor(img.height / f));
  const c: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(width * height),
    new Float32Array(width * height),
    new Float32Array(width * height),
  ];
  const norm = 1 / (255 * f * f);
  const d = img.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = 0; yy < f; yy++) {
        let p = ((y * f + yy) * img.width + x * f) * 4;
        for (let xx = 0; xx < f; xx++, p += 4) {
          r += d[p];
          g += d[p + 1];
          b += d[p + 2];
        }
      }
      const i = y * width + x;
      c[0][i] = r * norm;
      c[1][i] = g * norm;
      c[2][i] = b * norm;
    }
  }
  return { width, height, c };
}

/** A line x·cos θ + y·sin θ = ρ, in pixel-edge coordinates of the planes. */
export interface HoughLine {
  theta: number;
  rho: number;
  votes: number;
}

/** Below this colour step (Sobel, normalised to a unit step) a pixel does not vote. */
const VOTE_MIN = 0.03;
/** Votes are capped at this step, so that coverage, not contrast, ranks lines. */
const VOTE_CAP = 0.08;
const THETA_BINS = 180;
/** Votes go to angles up to this many degrees either side of the gradient's. */
const VOTE_SPREAD = 4;

interface Gradient {
  gx: Float32Array;
  gy: Float32Array;
  mag: Float32Array;
}

function gradient(p: Planes): Gradient {
  const { width: w, height: h } = p;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let best = 0;
      let bx = 0;
      let by = 0;
      for (const ch of p.c) {
        const sx =
          ch[i - w + 1] +
          2 * ch[i + 1] +
          ch[i + w + 1] -
          ch[i - w - 1] -
          2 * ch[i - 1] -
          ch[i + w - 1];
        const sy =
          ch[i + w - 1] +
          2 * ch[i + w] +
          ch[i + w + 1] -
          ch[i - w - 1] -
          2 * ch[i - w] -
          ch[i - w + 1];
        const m = sx * sx + sy * sy;
        if (m > best) {
          best = m;
          bx = sx;
          by = sy;
        }
      }
      gx[i] = bx / 4;
      gy[i] = by / 4;
      mag[i] = Math.sqrt(best) / 4;
    }
  }
  return { gx, gy, mag };
}

/**
 * The strongest straight edges, at most `max`, with near-duplicates
 * suppressed. Positions are refined by a least-squares fit to the edge
 * pixels along each line.
 */
export function houghLines(p: Planes, max = 28, grad = gradient(p)): HoughLine[] {
  const { width: w, height: h } = p;
  const { gx, gy, mag } = grad;
  const diag = Math.ceil(Math.hypot(w, h));
  const rhoBins = 2 * diag + 1;
  const acc = new Float32Array(THETA_BINS * rhoBins);
  const cos = new Float64Array(THETA_BINS);
  const sin = new Float64Array(THETA_BINS);
  for (let t = 0; t < THETA_BINS; t++) {
    cos[t] = Math.cos((t * Math.PI) / THETA_BINS);
    sin[t] = Math.sin((t * Math.PI) / THETA_BINS);
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < VOTE_MIN) continue;
      const weight = Math.min(m, VOTE_CAP) / VOTE_CAP;
      let theta = Math.atan2(gy[i], gx[i]);
      if (theta < 0) theta += Math.PI;
      const tb = Math.round((theta / Math.PI) * THETA_BINS);
      const px = x + 0.5;
      const py = y + 0.5;
      // Gradient directions are noisy on faint or jagged edges: vote for
      // nearby angles too, less strongly.
      for (let dt = -VOTE_SPREAD; dt <= VOTE_SPREAD; dt++) {
        const t = (tb + dt + THETA_BINS) % THETA_BINS;
        const rho = px * cos[t] + py * sin[t];
        const r = Math.round(rho) + diag;
        acc[t * rhoBins + r] += weight * (1 - Math.abs(dt) / (VOTE_SPREAD + 1));
      }
    }
  }

  // Peaks, strongest first, with near-duplicates suppressed.
  const minVotes = 0.08 * Math.min(w, h);
  const peaks: number[] = [];
  for (let t = 0; t < THETA_BINS; t++) {
    for (let r = 1; r < rhoBins - 1; r++) {
      const v = acc[t * rhoBins + r];
      if (v < minVotes) continue;
      if (v < acc[t * rhoBins + r - 1] || v < acc[t * rhoBins + r + 1]) continue;
      peaks.push(t * rhoBins + r);
    }
  }
  peaks.sort((a, b) => acc[b] - acc[a]);
  const lines: HoughLine[] = [];
  for (const k of peaks) {
    if (lines.length >= max * 3) break;
    const theta = (Math.floor(k / rhoBins) * Math.PI) / THETA_BINS;
    const rho = (k % rhoBins) - diag;
    if (lines.some((l) => sameLine(l, theta, rho))) continue;
    lines.push({ theta, rho, votes: acc[k] });
  }
  const refined = lines.map((l) => refineLine(l, grad, w, h));
  // Refinement can merge two peaks onto one edge.
  const out: HoughLine[] = [];
  for (const l of refined) {
    if (out.length >= max) break;
    if (out.some((o) => sameLine(o, l.theta, l.rho))) continue;
    out.push(l);
  }
  return out;
}

function sameLine(l: HoughLine, theta: number, rho: number): boolean {
  let dt = Math.abs(l.theta - theta);
  let dr = Math.abs(l.rho - rho);
  if (dt > Math.PI / 2) {
    dt = Math.PI - dt;
    dr = Math.abs(l.rho + rho);
  }
  return dt < (4 * Math.PI) / 180 && dr < 8;
}

/** Least-squares fit to the edge pixels within a few pixels of a Hough line. */
function refineLine(l: HoughLine, grad: Gradient, w: number, h: number): HoughLine {
  const { gx, gy, mag } = grad;
  const nx = Math.cos(l.theta);
  const ny = Math.sin(l.theta);
  const ux = -ny;
  const uy = nx;
  const diag = Math.hypot(w, h);
  let sw = 0;
  let mx = 0;
  let my = 0;
  const pts: number[] = [];
  for (let t = -diag; t <= diag; t += 1) {
    const cx = l.rho * nx + t * ux;
    const cy = l.rho * ny + t * uy;
    if (cx < 2 || cy < 2 || cx > w - 2 || cy > h - 2) continue;
    // Best edge pixel across the line within ±3 px, with a matching orientation.
    let best = -1;
    let bestM = VOTE_MIN;
    for (let s = -3; s <= 3; s++) {
      const x = Math.floor(cx + s * nx);
      const y = Math.floor(cy + s * ny);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const i = y * w + x;
      const m = mag[i];
      if (m <= bestM) continue;
      const along = Math.abs(gx[i] * nx + gy[i] * ny) / m;
      if (along < 0.94) continue;
      bestM = m;
      best = i;
    }
    if (best < 0) continue;
    const wgt = Math.min(bestM, VOTE_CAP);
    const x = (best % w) + 0.5;
    const y = Math.floor(best / w) + 0.5;
    pts.push(x, y, wgt);
    sw += wgt;
    mx += x * wgt;
    my += y * wgt;
  }
  if (pts.length < 30 || sw <= 0) return l;
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k < pts.length; k += 3) {
    const dx = pts[k] - mx;
    const dy = pts[k + 1] - my;
    sxx += pts[k + 2] * dx * dx;
    syy += pts[k + 2] * dy * dy;
    sxy += pts[k + 2] * dx * dy;
  }
  // Direction of the line = major axis; normal is perpendicular.
  const dir = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let theta = dir + Math.PI / 2;
  // Keep the normal close to the original one.
  if (Math.cos(theta - l.theta) < 0) theta += Math.PI;
  theta = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let rho = mx * Math.cos(theta) + my * Math.sin(theta);
  if (theta >= Math.PI) {
    theta -= Math.PI;
    rho = -rho;
  }
  // A refit that wandered off to another edge is not a refinement.
  if (Math.abs(theta - l.theta) > 0.06 && Math.PI - Math.abs(theta - l.theta) > 0.06) return l;
  return { theta, rho, votes: l.votes };
}

/* ------------------------------------------------------------- support ---- */

/** Colour step (Euclidean, RGB 0..1) across a side that counts as an edge. */
const STEP_MIN = 0.05;
/** Half the distance across which the step is measured, in search pixels. */
const STEP_SPAN = 2;

function bilinear(ch: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.min(w - 1.001, Math.max(0, x - 0.5));
  const fy = Math.min(h - 1.001, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * w + x0;
  return (
    ch[i] * (1 - tx) * (1 - ty) +
    ch[i + 1] * tx * (1 - ty) +
    ch[i + w] * (1 - tx) * ty +
    ch[i + w + 1] * tx * ty
  );
}

/** Scratch output of `stepAt`: the colour step vector (outside minus inside along n). */
const delta = new Float64Array(3);

/**
 * Whether there is a colour step across direction (nx, ny) at (x, y): the
 * largest step over a few offsets across, so a slightly bent or misplaced
 * edge still counts. Returns -1 outside the frame (unknown), else 0 or 1;
 * the step itself is left in `delta`.
 */
function stepAt(p: Planes, x: number, y: number, nx: number, ny: number): number {
  const { width: w, height: h } = p;
  const reach = STEP_SPAN + 2;
  delta[0] = delta[1] = delta[2] = 0;
  if (x - reach < 0 || y - reach < 0 || x + reach > w || y + reach > h) return -1;
  let best = 0;
  for (let o = -2; o <= 2; o++) {
    const d0 =
      bilinear(p.c[0], w, h, x + nx * (o + STEP_SPAN), y + ny * (o + STEP_SPAN)) -
      bilinear(p.c[0], w, h, x + nx * (o - STEP_SPAN), y + ny * (o - STEP_SPAN));
    const d1 =
      bilinear(p.c[1], w, h, x + nx * (o + STEP_SPAN), y + ny * (o + STEP_SPAN)) -
      bilinear(p.c[1], w, h, x + nx * (o - STEP_SPAN), y + ny * (o - STEP_SPAN));
    const d2 =
      bilinear(p.c[2], w, h, x + nx * (o + STEP_SPAN), y + ny * (o + STEP_SPAN)) -
      bilinear(p.c[2], w, h, x + nx * (o - STEP_SPAN), y + ny * (o - STEP_SPAN));
    const s = d0 * d0 + d1 * d1 + d2 * d2;
    if (s > best) {
      best = s;
      delta[0] = d0;
      delta[1] = d1;
      delta[2] = d2;
    }
  }
  return best >= STEP_MIN * STEP_MIN ? 1 : 0;
}

/**
 * Edge evidence along a straight path in 1 px steps, as prefix sums so that
 * any stretch of it is an O(1) lookup: samples in the frame, samples with a
 * step, and the summed step vectors (with their summed lengths) of those.
 */
interface Track {
  /** Path parameter of sample 0. */
  t0: number;
  inFrame: Int32Array;
  on: Int32Array;
  d: [Float64Array, Float64Array, Float64Array];
  abs: Float64Array;
}

function track(
  p: Planes,
  x0: number,
  y0: number,
  ux: number,
  uy: number,
  t0: number,
  n: number,
  nx: number,
  ny: number,
): Track {
  const inFrame = new Int32Array(n + 1);
  const on = new Int32Array(n + 1);
  const d: [Float64Array, Float64Array, Float64Array] = [
    new Float64Array(n + 1),
    new Float64Array(n + 1),
    new Float64Array(n + 1),
  ];
  const abs = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) {
    const t = t0 + k + 0.5;
    const s = stepAt(p, x0 + ux * t, y0 + uy * t, nx, ny);
    inFrame[k + 1] = inFrame[k] + (s >= 0 ? 1 : 0);
    on[k + 1] = on[k] + (s > 0 ? 1 : 0);
    const keep = s > 0 ? 1 : 0;
    for (let c = 0; c < 3; c++) d[c][k + 1] = d[c][k] + keep * delta[c];
    abs[k + 1] = abs[k] + keep * Math.hypot(delta[0], delta[1], delta[2]);
  }
  return { t0, inFrame, on, d, abs };
}

interface Stretch {
  inFrame: number;
  on: number;
  d: [number, number, number];
  abs: number;
}

function stretch(tr: Track, ta: number, tb: number): Stretch {
  const n = tr.inFrame.length - 1;
  const a = Math.max(0, Math.min(n, Math.round(Math.min(ta, tb) - tr.t0)));
  const b = Math.max(0, Math.min(n, Math.round(Math.max(ta, tb) - tr.t0)));
  return {
    inFrame: tr.inFrame[b] - tr.inFrame[a],
    on: tr.on[b] - tr.on[a],
    d: [tr.d[0][b] - tr.d[0][a], tr.d[1][b] - tr.d[1][a], tr.d[2][b] - tr.d[2][a]],
    abs: tr.abs[b] - tr.abs[a],
  };
}

/** A Hough line's whole track across the frame. */
interface Profile {
  line: HoughLine;
  track: Track;
}

function profile(p: Planes, line: HoughLine): Profile {
  const diag = Math.ceil(Math.hypot(p.width, p.height));
  const nx = Math.cos(line.theta);
  const ny = Math.sin(line.theta);
  // Point at parameter t: rho * n + t * (-ny, nx).
  return {
    line,
    track: track(p, line.rho * nx, line.rho * ny, -ny, nx, -diag, 2 * diag + 1, nx, ny),
  };
}

/** Position of point (x, y) along a line. */
function along(line: HoughLine, x: number, y: number): number {
  return -x * Math.sin(line.theta) + y * Math.cos(line.theta);
}

/** Required share of a side's in-frame length with a colour step across it. */
const SIDE_SUPPORT = 0.8;
/** Required share near each corner (the last `CORNER_SPAN` of the side). */
const CORNER_SUPPORT = 0.6;
const CORNER_SPAN = 0.12;
/**
 * The steps along a side must mostly be the same step (paper to table, or
 * photo to table): their summed vector at least this share of their summed
 * lengths. Texture (wood grain, noise) steps every which way.
 */
const COHERENCE = 0.5;
/** ... and near each corner on its own. */
const CORNER_COHERENCE = 0.5;
/** At least this share of a side must be in the frame to be judged at all. */
const MIN_IN_FRAME = 0.12;
/** ... and at least this many search pixels of it. */
const MIN_VISIBLE_PX = 40;

export interface SideScore {
  /** Share of the side's in-frame samples with a step across. */
  support: number;
  /** Share of the side inside the frame. */
  visible: number;
  /** Lowest support over the two corner ends (1 where out of frame). */
  corners: number;
  /** How consistent the steps are along the side, 0..1. */
  coherence: number;
  /** Lowest consistency of the steps near either corner, 0..1 (1 where out of frame). */
  cornerCoherence: number;
  /** In-frame length, search pixels. */
  length: number;
  /** Mean colour step of the supported samples. */
  strength: number;
}

function judge(tr: Track, ta: number, tb: number): SideScore {
  const len = Math.abs(tb - ta);
  const whole = stretch(tr, ta, tb);
  const end = len * CORNER_SPAN;
  const dir = tb >= ta ? 1 : -1;
  const mean = Math.hypot(whole.d[0], whole.d[1], whole.d[2]);
  const judged = (c: Stretch) => c.inFrame >= Math.max(4, end * 0.3);
  const ratio = (c: Stretch) => (judged(c) ? c.on / c.inFrame : 1);
  // Self-consistency of each end on its own: a dark band or a photo may meet
  // the page edge at a corner, stepping the other way from the rest of it.
  const agree = (c: Stretch) =>
    judged(c) ? Math.hypot(c.d[0], c.d[1], c.d[2]) / Math.max(1e-9, c.abs) : 1;
  const a = stretch(tr, ta, ta + dir * end);
  const b = stretch(tr, tb - dir * end, tb);
  return {
    support: whole.inFrame > 0 ? whole.on / whole.inFrame : 0,
    visible: len > 0 ? whole.inFrame / len : 0,
    corners: Math.min(ratio(a), ratio(b)),
    coherence: whole.abs > 0 ? mean / whole.abs : 0,
    cornerCoherence: Math.min(agree(a), agree(b)),
    length: whole.inFrame,
    strength: whole.on > 0 ? whole.abs / whole.on : 0,
  };
}

function sideOk(s: SideScore): boolean {
  return (
    s.visible >= MIN_IN_FRAME &&
    s.length >= MIN_VISIBLE_PX &&
    s.support >= SIDE_SUPPORT &&
    s.corners >= CORNER_SUPPORT &&
    s.coherence >= COHERENCE &&
    s.cornerCoherence >= CORNER_COHERENCE
  );
}

/** Scores of a quad's four sides (TL-TR, TR-BR, BR-BL, BL-TL), sampled directly. */
export function quadSupport(p: Planes, q: Quad): SideScore[] {
  const out: SideScore[] = [];
  for (let e = 0; e < 4; e++) {
    const a = q[e];
    const b = q[(e + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / Math.max(1e-9, len);
    const uy = (b[1] - a[1]) / Math.max(1e-9, len);
    const n = Math.max(1, Math.round(len));
    // Any fixed normal will do: only the consistency of the steps matters.
    out.push(judge(track(p, a[0], a[1], ux, uy, 0, n, -uy, ux), 0, n));
  }
  return out;
}

/** Whether every side of a quad is an edge along its whole (visible) length. */
export function quadSupported(p: Planes, q: Quad): boolean {
  const sides = quadSupport(p, q);
  return sides.every(sideOk) && sides.filter((s) => s.visible > 0.9).length >= 2;
}

/* -------------------------------------------------------------- search ---- */

function intersect(a: HoughLine, b: HoughLine): Point | null {
  const c1 = Math.cos(a.theta);
  const s1 = Math.sin(a.theta);
  const c2 = Math.cos(b.theta);
  const s2 = Math.sin(b.theta);
  const den = c1 * s2 - s1 * c2;
  if (Math.abs(den) < 1e-6) return null;
  return [(a.rho * s2 - b.rho * s1) / den, (b.rho * c1 - a.rho * c2) / den];
}

/** Angle between two lines' directions, 0..π/2. */
function angleBetween(a: HoughLine, b: HoughLine): number {
  const d = Math.abs(a.theta - b.theta) % Math.PI;
  return Math.min(d, Math.PI - d);
}

/** Smallest interior angle of a convex quad, radians. */
function minAngle(q: Quad): number {
  let min = Math.PI;
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4];
    const c = q[i];
    const n = q[(i + 1) % 4];
    const a = Math.atan2(p[1] - c[1], p[0] - c[0]);
    const b = Math.atan2(n[1] - c[1], n[0] - c[0]);
    let d = Math.abs(a - b);
    if (d > Math.PI) d = 2 * Math.PI - d;
    min = Math.min(min, d, Math.PI - d);
  }
  return min;
}

/** Order four corners TL, TR, BR, BL, keeping their cyclic order. */
function orderCyclic(pts: Point[]): Quad {
  // Make the winding clockwise in image coordinates (y down).
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    s += a[0] * b[1] - b[0] * a[1];
  }
  const cw = s > 0 ? pts : [pts[0], pts[3], pts[2], pts[1]];
  let start = 0;
  for (let i = 1; i < 4; i++) if (cw[i][0] + cw[i][1] < cw[start][0] + cw[start][1]) start = i;
  return [cw[start], cw[(start + 1) % 4], cw[(start + 2) % 4], cw[(start + 3) % 4]];
}

function inside(q: Quad, x: number, y: number, margin: number): boolean {
  // Clockwise quad: the point is inside if it is right of every edge.
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const cross = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / len;
    if (cross < -margin) return false;
  }
  return true;
}

export interface SearchResult {
  quad: Quad;
  /** Whether the page runs off the frame (a corner outside it, or a side on its border). */
  offFrame: boolean;
  /** Fully supported quads considered, for diagnostics. */
  candidates: number;
}

/** Quads whose areas differ by less than this are the same page, edge-wise. */
const SAME_SIZE = 0.03;

/** Opposite sides may converge by this much (steep perspective). */
const MAX_OPPOSITE_ANGLE = (40 * Math.PI) / 180;
/** Adjacent sides must differ by at least this much. */
const MIN_ADJACENT_ANGLE = (45 * Math.PI) / 180;

/**
 * The largest quad whose four sides are colour edges along their whole
 * length, in the planes' pixel-edge coordinates. Corners may lie outside the
 * frame when a page runs off it. With `contain`, only quads containing that
 * quad (the model's, when it is itself well supported) qualify.
 */
export function searchQuad(
  p: Planes,
  { contain, lines: maxLines = 28 }: { contain?: Quad; lines?: number } = {},
): SearchResult | null {
  const { width: w, height: h } = p;
  const detected = houghLines(p, maxLines);
  // The frame's own borders stand in for a side that is entirely out of view.
  const frame: HoughLine[] = [
    { theta: Math.PI / 2, rho: 0, votes: 0 },
    { theta: 0, rho: w, votes: 0 },
    { theta: Math.PI / 2, rho: h, votes: 0 },
    { theta: 0, rho: 0, votes: 0 },
  ];
  const lines = [...detected, ...frame];
  const isFrame = (i: number) => i >= detected.length;
  const profiles = lines.map((l, i) => (isFrame(i) ? null : profile(p, l)));
  const minArea = 0.1 * w * h;
  const minSep = 0.15 * Math.min(w, h);

  const pairs: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (angleBetween(lines[i], lines[j]) > MAX_OPPOSITE_ANGLE) continue;
      // Far enough apart where they cross the middle of the frame.
      const mi = intersectMid(lines[i], w, h);
      const mj = intersectMid(lines[j], w, h);
      if (Math.abs(mi - mj) < minSep) continue;
      pairs.push([i, j]);
    }
  }

  const found: { quad: Quad; area: number; border: number; strength: number; off: boolean }[] = [];
  for (let a = 0; a < pairs.length; a++) {
    const [i, j] = pairs[a];
    for (let b = a + 1; b < pairs.length; b++) {
      const [k, l] = pairs[b];
      if (k === i || k === j || l === i || l === j) continue;
      if (
        angleBetween(lines[i], lines[k]) < MIN_ADJACENT_ANGLE ||
        angleBetween(lines[i], lines[l]) < MIN_ADJACENT_ANGLE ||
        angleBetween(lines[j], lines[k]) < MIN_ADJACENT_ANGLE ||
        angleBetween(lines[j], lines[l]) < MIN_ADJACENT_ANGLE
      ) {
        continue;
      }
      // Cyclic: i∩k, k∩j, j∩l, l∩i.
      const c0 = intersect(lines[i], lines[k]);
      const c1 = intersect(lines[k], lines[j]);
      const c2 = intersect(lines[j], lines[l]);
      const c3 = intersect(lines[l], lines[i]);
      if (!c0 || !c1 || !c2 || !c3) continue;
      const corners = [c0, c1, c2, c3];
      if (corners.some(([x, y]) => x < -0.3 * w || y < -0.3 * h || x > 1.3 * w || y > 1.3 * h)) {
        continue;
      }
      const raw: Quad = [c0, c1, c2, c3];
      if (!isConvex(raw)) continue;
      const area = quadArea(raw);
      if (area < minArea) continue;
      if (minAngle(raw) < (35 * Math.PI) / 180) continue;
      // Sides: on line k from c0 to c1, j from c1 to c2, l from c2 to c3, i from c3 to c0.
      const sides: [number, Point, Point][] = [
        [k, c0, c1],
        [j, c1, c2],
        [l, c2, c3],
        [i, c3, c0],
      ];
      let ok = true;
      let fullyVisible = 0;
      let onBorder = 0;
      let strength = 0;
      for (const [li, pa, pb] of sides) {
        const pr = profiles[li];
        if (!pr) {
          onBorder++;
          continue;
        }
        const ta = along(pr.line, pa[0], pa[1]);
        const tb = along(pr.line, pb[0], pb[1]);
        const s = judge(pr.track, ta, tb);
        if (!sideOk(s)) {
          ok = false;
          break;
        }
        if (s.visible > 0.9) fullyVisible++;
        strength += s.strength;
      }
      if (!ok || fullyVisible < 2 || onBorder > 2) continue;
      const quad = orderCyclic(corners);
      if (contain && !contain.every(([x, y]) => inside(quad, x, y, 0.01 * Math.max(w, h)))) {
        continue;
      }
      found.push({
        quad,
        area,
        border: onBorder,
        strength: strength / (4 - onBorder),
        off: onBorder > 0 || corners.some(([x, y]) => x < -1 || y < -1 || x > w + 1 || y > h + 1),
      });
    }
  }
  if (!found.length) return null;
  // A quad with a side on the frame's border only wins when no quad has all
  // four sides on real edges. Then the largest; but among quads of nearly the
  // same size (the page edge, or the soft edge of its shadow just outside),
  // the one with the strongest edges.
  const border = Math.min(...found.map((f) => f.border));
  const fair = found.filter((f) => f.border === border);
  const largest = Math.max(...fair.map((f) => f.area));
  const best = fair
    .filter((f) => f.area >= largest * (1 - SAME_SIZE))
    .reduce((a, b) => (b.strength > a.strength ? b : a));
  return { quad: best.quad, offFrame: best.off, candidates: found.length };
}

/** Where a line crosses the frame's centre row or column (whichever it is closer to parallel to). */
function intersectMid(l: HoughLine, w: number, h: number): number {
  const c = Math.cos(l.theta);
  const s = Math.sin(l.theta);
  // Mostly vertical line (normal near x): x at the centre row.
  if (Math.abs(c) >= Math.abs(s)) return (l.rho - (h / 2) * s) / c;
  return (l.rho - (w / 2) * c) / s;
}

/* ------------------------------------------------------------ clipping ---- */

/**
 * Fit a page quad whose corners may lie outside a `width` × `height` frame
 * into it: the largest rectangle of the page (in the page's own coordinates,
 * so the crop stays undistorted) whose photo lies inside the frame.
 * Returns the quad unchanged when it is already inside.
 */
export function clipToFrame(q: Quad, width: number, height: number): Quad {
  const tol = 0.5;
  const inFrame = ([x, y]: Point) =>
    x >= -tol && y >= -tol && x <= width + tol && y <= height + tol;
  if (q.every(inFrame)) return q;
  const unit: Quad = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const H = homography(unit, q);
  const map = (u: number, v: number): Point => applyHomography(H, u, v);
  const ok = (u: number, v: number) => {
    const [x, y] = map(u, v);
    return x >= 0 && y >= 0 && x <= width && y <= height;
  };

  let best: [number, number, number, number] | null = null;
  let bestArea = 0;
  // Each corner outside the frame is fixed by cutting one of its two sides;
  // try every combination of choices and keep the largest result.
  for (let choice = 0; choice < 16; choice++) {
    let u0 = 0;
    let u1 = 1;
    let v0 = 0;
    let v1 = 1;
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      const corners: [number, number, number][] = [
        [0, u0, v0],
        [1, u1, v0],
        [2, u1, v1],
        [3, u0, v1],
      ];
      for (const [c, u, v] of corners) {
        if (ok(u, v)) continue;
        changed = true;
        const cutU = (choice >> c) & 1;
        if (cutU) {
          // Move this corner's vertical side inward until the corner is in.
          const target = c === 0 || c === 3 ? u1 : u0;
          const nu = bisect(u, target, (x) => ok(x, v));
          if (c === 0 || c === 3) u0 = nu;
          else u1 = nu;
        } else {
          const target = c === 0 || c === 1 ? v1 : v0;
          const nv = bisect(v, target, (y) => ok(u, y));
          if (c === 0 || c === 1) v0 = nv;
          else v1 = nv;
        }
      }
      if (!changed) break;
    }
    if (!(ok(u0, v0) && ok(u1, v0) && ok(u1, v1) && ok(u0, v1))) continue;
    // Page area (in the page's own units) kept.
    const area = (u1 - u0) * (v1 - v0);
    if (area > bestArea) {
      bestArea = area;
      best = [u0, u1, v0, v1];
    }
  }
  if (!best || bestArea < 0.2) {
    // Nothing sensible: clamp the corners instead.
    return q.map(([x, y]) => [
      Math.min(width, Math.max(0, x)),
      Math.min(height, Math.max(0, y)),
    ]) as unknown as Quad;
  }
  const [u0, u1, v0, v1] = best;
  const clamp = ([x, y]: Point): Point => [
    Math.min(width, Math.max(0, x)),
    Math.min(height, Math.max(0, y)),
  ];
  return [clamp(map(u0, v0)), clamp(map(u1, v0)), clamp(map(u1, v1)), clamp(map(u0, v1))];
}

/** First point from `from` towards `to` where `inside` holds (assumes it holds at `to`). */
function bisect(from: number, to: number, inside: (x: number) => boolean): number {
  if (!inside(to)) return to;
  let a = from;
  let b = to;
  for (let i = 0; i < 30; i++) {
    const m = (a + b) / 2;
    if (inside(m)) b = m;
    else a = m;
  }
  return b;
}
