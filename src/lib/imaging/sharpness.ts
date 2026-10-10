import { gaussian } from './box';
import type { FloatImage } from './image';

/** Below this score a capture is treated as blurred (see `sharpness`). */
export const BLURRED_BELOW = 1.55;

/** 99.5th percentile of the absolute luma step along (dx, dy), within a region. */
function strongestStep(
  img: FloatImage,
  dx: number,
  dy: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const { width: w, data } = img;
  const hist = new Uint32Array(1024);
  let n = 0;
  const offset = dy * w + dx;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      const g = Math.abs(data[i + offset] - data[i - offset]);
      hist[Math.min(1023, Math.round(g * 1023))]++;
      n++;
    }
  }
  let acc = 0;
  for (let i = 0; i < 1024; i++) {
    acc += hist[i];
    if (acc >= 0.995 * n) return i / 1023;
  }
  return 1;
}

/**
 * How sharp a photo of a page is: about 2-3 for a sharp phone photo, falling
 * towards 1 as it blurs.
 *
 * The score compares the strongest edges with those of a copy blurred a
 * little further: blurring a sharp photo weakens its edges a lot, blurring an
 * already blurred one hardly changes them. That makes it independent of
 * contrast and paper. Motion blur only smears edges along the direction of the
 * shake, so the score is the worst of four directions.
 *
 * `region` (pixel bounds) restricts it to the page, ignoring the table around.
 */
export function sharpness(
  luma: FloatImage,
  region: { x0: number; y0: number; x1: number; y1: number } = {
    x0: 0,
    y0: 0,
    x1: luma.width,
    y1: luma.height,
  },
): number {
  const x0 = Math.max(2, Math.floor(region.x0));
  const y0 = Math.max(2, Math.floor(region.y0));
  const x1 = Math.min(luma.width - 2, Math.ceil(region.x1));
  const y1 = Math.min(luma.height - 2, Math.ceil(region.y1));
  if (x1 - x0 < 16 || y1 - y0 < 16) return Infinity;
  const blurred = gaussian(luma, 1.5);
  let worst = Infinity;
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ]) {
    const sharp = strongestStep(luma, dx, dy, x0, y0, x1, y1);
    const soft = strongestStep(blurred, dx, dy, x0, y0, x1, y1);
    worst = Math.min(worst, sharp / Math.max(1e-3, soft));
  }
  return worst;
}

/** Whether a page's photo was measured as blurred at capture. */
export function isBlurred(page: { sharpness: number | null }): boolean {
  return page.sharpness !== null && page.sharpness < BLURRED_BELOW;
}
