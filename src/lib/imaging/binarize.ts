import { boxFilter } from './filters';
import type { Mask } from './types';

export type BinarizeMethod = 'off' | 'otsu' | 'adaptive' | 'sauvola' | 'niblack' | 'wolf';

export interface BinarizeOptions {
  method: BinarizeMethod;
  /** Local window size in pixels. Forced odd, minimum 3. */
  window: number;
  /**
   * Sauvola / Niblack / Wolf sensitivity. For every method a higher value
   * lowers the threshold, so fewer pixels become ink and strokes get thinner.
   */
  k: number;
  /** Offset for the `adaptive` method. */
  c: number;
  /** Treat light-on-dark documents (white text on black) as normal text. */
  invert?: boolean;
}

/** Sauvola's dynamic range constant. */
const R = 128;

/**
 * Produce an ink mask: 255 where the pixel is text, 0 where it is paper.
 *
 * Every method returns a hard mask; softening happens later in the composite
 * stage, which feathers the mask so edges stay anti-aliased.
 */
export function binarize(
  gray: Uint8Array,
  width: number,
  height: number,
  opts: BinarizeOptions,
): Mask {
  const n = width * height;
  const mask = new Uint8Array(n);

  if (opts.method === 'off') return mask;
  if (opts.method === 'otsu') return otsu(gray, opts.invert);

  const radius = Math.max(1, Math.floor((opts.window | 1) / 2));
  const k = opts.k;
  const c = opts.c;

  const f = new Float32Array(n);
  const f2 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = gray[i];
    f[i] = v;
    f2[i] = v * v;
  }

  const mean = boxFilter(f, width, height, radius);
  const meanSq = boxFilter(f2, width, height, radius);

  // Reuse meanSq as the standard-deviation map.
  for (let i = 0; i < n; i++) {
    const m = mean[i];
    const variance = meanSq[i] - m * m;
    meanSq[i] = variance > 0 ? Math.sqrt(variance) : 0;
  }
  const std = meanSq;

  // Wolf's method needs the darkest pixel on the page; the global minimum is a
  // cheap stand-in for the local one and behaves the same on normal documents.
  let globalMin = 255;
  if (opts.method === 'wolf') {
    for (let i = 0; i < n; i++) if (gray[i] < globalMin) globalMin = gray[i];
  }

  for (let i = 0; i < n; i++) {
    const m = mean[i];
    const s = std[i];
    let threshold: number;
    switch (opts.method) {
      case 'sauvola':
        threshold = m * (1 + k * (s / R - 1));
        break;
      case 'niblack':
        // Niblack is usually written m + k*s with a negative k; negating here
        // keeps k's direction consistent with Sauvola and Wolf.
        threshold = m - k * s;
        break;
      case 'wolf':
        threshold = m - k * (1 - s / R) * (m - globalMin);
        break;
      default:
        threshold = m - c;
        break;
    }
    const ink = gray[i] < threshold;
    mask[i] = ink !== !!opts.invert ? 255 : 0;
  }

  return mask;
}

/** Global Otsu threshold. Fast, but fails on uneven lighting. */
function otsu(gray: Uint8Array, invert?: boolean): Mask {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;

  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let maxVariance = 0;
  let threshold = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVariance) {
      maxVariance = between;
      threshold = t;
    }
  }

  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const ink = gray[i] <= threshold;
    mask[i] = ink !== !!invert ? 255 : 0;
  }
  return mask;
}
