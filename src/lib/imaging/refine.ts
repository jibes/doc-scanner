import type { FloatImage, Point, Quad } from './image';
import { isConvex } from './quad';

/** Search band either side of each edge, as a fraction of the image's long edge. */
const SEARCH = 0.025;
const SAMPLES_PER_EDGE = 48;

function sample(img: FloatImage, x: number, y: number): number {
  const { width: w, height: h, data } = img;
  const fx = Math.min(w - 1.001, Math.max(0, x));
  const fy = Math.min(h - 1.001, Math.max(0, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * w + x0;
  return (
    data[i] * (1 - tx) * (1 - ty) +
    data[i + 1] * tx * (1 - ty) +
    data[i + w] * (1 - tx) * ty +
    data[i + w + 1] * tx * ty
  );
}

interface Line {
  /** Point on the line. */
  px: number;
  py: number;
  /** Unit direction. */
  dx: number;
  dy: number;
}

/** Total-least-squares line through weighted points. */
function fitLine(points: { x: number; y: number; w: number }[]): Line | null {
  let sw = 0;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    sw += p.w;
    mx += p.x * p.w;
    my += p.y * p.w;
  }
  if (sw <= 0) return null;
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += p.w * dx * dx;
    syy += p.w * dy * dy;
    sxy += p.w * dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { px: mx, py: my, dx: Math.cos(angle), dy: Math.sin(angle) };
}

function intersect(a: Line, b: Line): Point | null {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
  return [a.px + t * a.dx, a.py + t * a.dy];
}

/**
 * Snap a coarse quad onto the page's real edges.
 *
 * The detector works on a 256 px thumbnail, so its corners can be off by
 * several photo pixels. For each side, sample points along it, search along
 * the normal for the strongest step in brightness (sub-pixel, via a parabola
 * through the peak), fit a line robustly, and intersect neighbouring lines.
 * A refined corner is only accepted if it stays inside the search band and
 * the quad stays convex; otherwise the detector's corner is kept.
 *
 * `gray` is a luma image; `quad` is in its pixel-edge coordinates.
 */
export function refineQuad(gray: FloatImage, quad: Quad): Quad {
  const band = Math.max(4, Math.max(gray.width, gray.height) * SEARCH);
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4;
  const cy = quad.reduce((s, p) => s + p[1], 0) / 4;
  const lines: (Line | null)[] = [];

  for (let e = 0; e < 4; e++) {
    const [ax, ay] = quad[e];
    const [bx, by] = quad[(e + 1) % 4];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 8) {
      lines.push(null);
      continue;
    }
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    // Outward normal: away from the quad's centre.
    let nx = -uy;
    let ny = ux;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }

    const hits: { x: number; y: number; w: number; s: number }[] = [];
    const steps = Math.ceil(band);
    const profile = new Float64Array(2 * steps + 1);
    for (let k = 0; k < SAMPLES_PER_EDGE; k++) {
      // Stay clear of the corners, where the neighbouring edge interferes.
      const t = 0.12 + (0.76 * k) / (SAMPLES_PER_EDGE - 1);
      const ox = ax + (bx - ax) * t - 0.5;
      const oy = ay + (by - ay) * t - 0.5;
      for (let s = -steps; s <= steps; s++) {
        profile[s + steps] = sample(gray, ox + nx * s, oy + ny * s);
      }
      let best = -1;
      let bestScore = 0;
      for (let s = -steps + 1; s < steps; s++) {
        // Central difference across the normal, any polarity, gently
        // preferring steps near the detector's guess.
        const g = Math.abs(profile[s + steps + 1] - profile[s + steps - 1]);
        const score = g * Math.exp(-(s * s) / (2 * (band * 0.6) ** 2));
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
      }
      if (best === -1 || bestScore < 0.02) continue;
      // Parabolic sub-pixel peak.
      const g = (s: number) => Math.abs(profile[s + steps + 1] - profile[s + steps - 1]);
      let offset = 0;
      if (best > -steps + 1 && best < steps - 1) {
        const l = g(best - 1);
        const c = g(best);
        const r = g(best + 1);
        const den = l - 2 * c + r;
        if (den < 0) offset = (0.5 * (l - r)) / den;
      }
      const s = best + offset;
      hits.push({ x: ox + 0.5 + nx * s, y: oy + 0.5 + ny * s, w: bestScore, s });
    }

    if (hits.length < SAMPLES_PER_EDGE / 3) {
      lines.push(null);
      continue;
    }
    // Reject outliers (text lines, shadows) by distance to a first fit, refit.
    let line = fitLine(hits);
    for (let pass = 0; pass < 2 && line; pass++) {
      const l: Line = line;
      const residuals = hits.map((h) => Math.abs((h.x - l.px) * -l.dy + (h.y - l.py) * l.dx));
      const sorted = [...residuals].sort((a, b) => a - b);
      const cutoff = Math.max(1.5, sorted[Math.floor(sorted.length / 2)] * 3);
      const inliers = hits.filter((_, i) => residuals[i] <= cutoff);
      if (inliers.length < SAMPLES_PER_EDGE / 4) {
        line = null;
        break;
      }
      line = fitLine(inliers);
    }
    lines.push(line);
  }

  const refined: Point[] = [];
  for (let c = 0; c < 4; c++) {
    // Corner c sits between edge c-1 (into it) and edge c (out of it).
    const before = lines[(c + 3) % 4];
    const after = lines[c];
    const p = before && after ? intersect(before, after) : null;
    const original = quad[c];
    if (p && Math.hypot(p[0] - original[0], p[1] - original[1]) <= band * 1.5) refined.push(p);
    else refined.push(original);
  }
  const result: Quad = [refined[0], refined[1], refined[2], refined[3]];
  return isConvex(result) ? result : quad;
}
