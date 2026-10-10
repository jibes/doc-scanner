import { createImage, type Quad, type RGBAImage } from './types';

/**
 * Homography mapping the unit square (0,0),(1,0),(1,1),(0,1) onto a quad.
 *
 * Returns [a,b,c,d,e,f,g,h] such that
 *   x = (a*u + b*v + c) / (g*u + h*v + 1)
 *   y = (d*u + e*v + f) / (g*u + h*v + 1)
 *
 * Applying it to output coordinates gives the source coordinate to sample,
 * which is exactly the backward mapping a warp needs.
 */
export function unitSquareToQuad(quad: Quad): number[] {
  const [p0, p1, p2, p3] = quad;
  const [x0, y0] = p0;
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;

  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;

  let g = 0;
  let h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) > 1e-12) {
      g = (dx3 * dy2 - dx2 * dy3) / den;
      h = (dx1 * dy3 - dx3 * dy1) / den;
    }
  }

  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

/**
 * Output size for a quad, derived from its own edge lengths rather than an
 * assumed paper size, so receipts stay long and narrow instead of being
 * stretched onto A4.
 */
export function quadOutputSize(quad: Quad, maxLongEdge: number): { width: number; height: number } {
  const [tl, tr, br, bl] = quad;
  const top = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const bottom = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
  const left = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  const right = Math.hypot(br[0] - tr[0], br[1] - tr[1]);

  let width = Math.round(Math.max(top, bottom));
  let height = Math.round(Math.max(left, right));

  const longEdge = Math.max(width, height);
  if (maxLongEdge > 0 && longEdge > maxLongEdge) {
    const scale = maxLongEdge / longEdge;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  return { width: Math.max(64, width), height: Math.max(64, height) };
}

/** Rectify a quad of the source image into an axis-aligned output. */
export function warpPerspective(
  src: RGBAImage,
  quad: Quad,
  outWidth: number,
  outHeight: number,
): RGBAImage {
  const h = unitSquareToQuad(quad);
  const out = createImage(outWidth, outHeight);
  const sd = src.data;
  const sw = src.width;
  const sh = src.height;
  const invW = outWidth > 1 ? 1 / (outWidth - 1) : 0;
  const invH = outHeight > 1 ? 1 / (outHeight - 1) : 0;

  for (let y = 0; y < outHeight; y++) {
    const v = y * invH;
    const rowOut = y * outWidth;
    for (let x = 0; x < outWidth; x++) {
      const u = x * invW;
      const den = h[6] * u + h[7] * v + 1;
      const sx = (h[0] * u + h[1] * v + h[2]) / den;
      const sy = (h[3] * u + h[4] * v + h[5]) / den;

      let x0 = Math.floor(sx);
      let y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      let x1 = x0 + 1;
      let y1 = y0 + 1;

      x0 = x0 < 0 ? 0 : x0 > sw - 1 ? sw - 1 : x0;
      x1 = x1 < 0 ? 0 : x1 > sw - 1 ? sw - 1 : x1;
      y0 = y0 < 0 ? 0 : y0 > sh - 1 ? sh - 1 : y0;
      y1 = y1 < 0 ? 0 : y1 > sh - 1 ? sh - 1 : y1;

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const o = (rowOut + x) * 4;
      out.data[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
      out.data[o + 1] =
        sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
      out.data[o + 2] =
        sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
      out.data[o + 3] = 255;
    }
  }

  return out;
}
