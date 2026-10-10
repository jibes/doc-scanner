import { boxFilter } from './filters';
import { createImage, type RGBAImage } from './types';

export interface NormalizeOptions {
  /** Radius of the background-estimation window, in pixels. 0 disables the stage. */
  radius: number;
  /** Blend between the original (0) and the fully flattened image (1). */
  strength: number;
  /** Cap on the per-pixel gain, so shadows are not amplified into noise. */
  maxGain: number;
}

/**
 * Divide-by-background illumination flattening.
 *
 * The background is estimated as a heavily blurred copy of the page, then each
 * pixel is divided by it. Because the estimate is per channel, yellowed or
 * grey paper is pulled back to neutral white while coloured content keeps its
 * hue.
 */
export function flattenIllumination(src: RGBAImage, opts: NormalizeOptions): RGBAImage {
  const { width, height } = src;
  const radius = Math.floor(opts.radius);
  if (radius <= 0 || opts.strength <= 0) return src;

  const n = width * height;
  const out = createImage(width, height);
  const channel = new Float32Array(n);
  const strength = Math.min(1, Math.max(0, opts.strength));
  const maxGain = Math.max(1, opts.maxGain);

  for (let c = 0; c < 3; c++) {
    for (let i = 0, p = c; i < n; i++, p += 4) channel[i] = src.data[p];
    const background = boxFilter(channel, width, height, radius);
    for (let i = 0, p = c; i < n; i++, p += 4) {
      // Clamping the divisor at 1 rather than adding an epsilon keeps the gain
      // exactly 1 on already-white paper, so a flat background flattens to a
      // true 255 instead of drifting a level or two low.
      const gain = Math.min(maxGain, 255 / Math.max(background[i], 1));
      const blended = 1 + (gain - 1) * strength;
      const v = src.data[p] * blended;
      out.data[p] = v > 255 ? 255 : v;
    }
  }

  // Alpha is not part of the pipeline; keep it opaque.
  for (let p = 3; p < out.data.length; p += 4) out.data[p] = 255;

  return out;
}
