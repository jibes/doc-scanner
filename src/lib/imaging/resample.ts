import { createRGBA, downsampleBox, type Quad, type RGBAImage } from './image';
import { applyHomography, homography, quadNaturalSize } from './quad';

/**
 * Catmull-Rom cubic weights for fractional offset t. Catmull-Rom interpolates
 * (passes through the samples), so unlike B-spline or bilinear it does not
 * soften text edges when the page is enlarged.
 */
function cubicWeights(t: number, w: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  w[0] = -0.5 * t3 + t2 - 0.5 * t;
  w[1] = 1.5 * t3 - 2.5 * t2 + 1;
  w[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  w[3] = 0.5 * t3 - 0.5 * t2;
}

/**
 * Rectify `quad` (in source pixel-edge coordinates, so a full-image quad is
 * (0,0)..(width,height)) into a `outWidth x outHeight` image.
 *
 * When the warp would shrink the page by 2x or more, the source is first
 * box-averaged by the integer part of that factor, because a 4x4 kernel cannot
 * see enough source pixels to avoid aliasing on its own.
 */
export function warpQuad(
  src: RGBAImage,
  quad: Quad,
  outWidth: number,
  outHeight: number,
): RGBAImage {
  const natural = quadNaturalSize(quad);
  const shrink = Math.min(natural.width / outWidth, natural.height / outHeight);
  const factor = shrink >= 2 ? Math.floor(shrink) : 1;
  const source = factor > 1 ? downsampleBox(src, factor) : src;
  const q =
    factor > 1
      ? (quad.map(([x, y]) => [x / factor, y / factor] as const) as unknown as Quad)
      : quad;

  const h = homography(
    [
      [0, 0],
      [outWidth, 0],
      [outWidth, outHeight],
      [0, outHeight],
    ],
    q,
  );

  const out = createRGBA(outWidth, outHeight);
  const od = out.data;
  const sd = source.data;
  const sw = source.width;
  const sh = source.height;
  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const xs = new Int32Array(4);
  const ys = new Int32Array(4);

  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const [ex, ey] = applyHomography(h, x + 0.5, y + 0.5);
      // Pixel-edge coordinates to pixel-centre coordinates.
      const fx = ex - 0.5;
      const fy = ey - 0.5;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      cubicWeights(fx - ix, wx);
      cubicWeights(fy - iy, wy);
      for (let k = 0; k < 4; k++) {
        const cx = ix - 1 + k;
        const cy = iy - 1 + k;
        xs[k] = cx < 0 ? 0 : cx >= sw ? sw - 1 : cx;
        ys[k] = cy < 0 ? 0 : cy >= sh ? sh - 1 : cy;
      }

      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < 4; j++) {
        const row = ys[j] * sw;
        const wyj = wy[j];
        for (let i = 0; i < 4; i++) {
          const p = (row + xs[i]) * 4;
          const w = wyj * wx[i];
          r += sd[p] * w;
          g += sd[p + 1] * w;
          b += sd[p + 2] * w;
        }
      }
      const o = (y * outWidth + x) * 4;
      // Uint8ClampedArray rounds and clamps the cubic overshoot.
      od[o] = r;
      od[o + 1] = g;
      od[o + 2] = b;
      od[o + 3] = 255;
    }
  }
  return out;
}

/** Plain resize of a whole image (no perspective), same kernel and prefilter. */
export function resize(src: RGBAImage, width: number, height: number): RGBAImage {
  if (width === src.width && height === src.height) return src;
  return warpQuad(
    src,
    [
      [0, 0],
      [src.width, 0],
      [src.width, src.height],
      [0, src.height],
    ],
    width,
    height,
  );
}
