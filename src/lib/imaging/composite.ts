import { featherMask } from './morphology';
import { createImage, type Mask, type RGBAImage } from './types';

export interface CompositeOptions {
  /** Background level, 0-255. 255 gives a pure #FFFFFF background. */
  paper: number;
  /** Ink level, 0-255. 0 gives pure #000000 text. */
  text: number;
  /** Feather radius in pixels applied to both masks before blending. */
  feather: number;
}

function toUnit(mask: Mask): Float32Array {
  const out = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] / 255;
  return out;
}

/**
 * Blend paper, ink and colour content into the final page.
 *
 * The three weights are normalised so they always sum to one:
 *
 *   colour = c
 *   ink    = k * (1 - c)
 *   paper  = (1 - c) * (1 - k)
 *
 * That guarantees two things the whole design rests on: any pixel that is
 * neither ink nor colour lands on exactly `paper` (so the background is a
 * literal #FFFFFF), and any pixel at the core of a stroke lands on exactly
 * `text` (so text is a literal #000000). Colour content is copied straight
 * from the flattened source, so logos and stamps keep their original pixels.
 */
export function composite(
  flat: RGBAImage,
  ink: Mask,
  color: Mask,
  opts: CompositeOptions,
): RGBAImage {
  const { width, height } = flat;
  const n = width * height;
  const out = createImage(width, height);

  const inkW = opts.feather > 0 ? featherMask(ink, width, height, opts.feather) : toUnit(ink);
  const colorW = opts.feather > 0 ? featherMask(color, width, height, opts.feather) : toUnit(color);

  const paper = opts.paper;
  const text = opts.text;

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const c = colorW[i];
    const k = inkW[i];
    const inkWeight = k * (1 - c);
    const paperWeight = (1 - c) * (1 - k);
    const base = paperWeight * paper + inkWeight * text;
    out.data[p] = base + c * flat.data[p];
    out.data[p + 1] = base + c * flat.data[p + 1];
    out.data[p + 2] = base + c * flat.data[p + 2];
    out.data[p + 3] = 255;
  }

  return out;
}
