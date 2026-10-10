import { binarize, type BinarizeMethod } from './binarize';
import { colorMask } from './color';
import { composite } from './composite';
import { orMask } from './morphology';
import { flattenIllumination } from './normalize';
import { toGray, type RGBAImage } from './types';

export interface ScanSettings {
  normalize: {
    /** Background-estimation radius in pixels. 0 disables illumination flattening. */
    radius: number;
    /** 0 = keep the original lighting, 1 = fully flattened. */
    strength: number;
    /** Cap on the per-pixel gain, so shadows are not amplified into noise. */
    maxGain: number;
  };
  binarize: {
    method: BinarizeMethod;
    window: number;
    k: number;
    c: number;
    invert: boolean;
  };
  color: {
    enabled: boolean;
    chromaThreshold: number;
    lumaFloor: number;
    minArea: number;
    grow: number;
  };
  composite: {
    paper: number;
    text: number;
    feather: number;
  };
  output: {
    targetDpi: number;
    maxLongEdge: number;
  };
}

export type Stage = 'normalize' | 'binarize' | 'color' | 'composite';

/**
 * Run the full cleanup pipeline on a rectified page.
 *
 * Order matters: illumination is flattened first so that thresholding sees a
 * uniformly lit page, the colour mask is computed from the flattened image so
 * that paper whitening does not create false colour, and the composite runs
 * last so it can blend all three layers at once.
 */
export function processImage(
  src: RGBAImage,
  settings: ScanSettings,
  onStage?: (stage: Stage) => void,
): RGBAImage {
  onStage?.('normalize');
  const flat = flattenIllumination(src, settings.normalize);

  // With binarisation off there is no ink layer to composite. Forcing a
  // paper/ink split would paint the whole page white, so hand back the
  // flattened photograph instead.
  if (settings.binarize.method === 'off') {
    onStage?.('composite');
    return flat;
  }

  onStage?.('binarize');
  const gray = toGray(flat);
  const ink = binarize(gray, flat.width, flat.height, settings.binarize);

  onStage?.('color');
  const color = colorMask(flat, settings.color);

  // With colour preservation off, coloured content is folded into the ink layer
  // so stamps and logos survive as solid black shapes rather than disappearing.
  const inkLayer = settings.color.enabled ? ink : orMask(ink, color);
  const colorLayer = settings.color.enabled ? color : new Uint8Array(flat.width * flat.height);

  onStage?.('composite');
  return composite(flat, inkLayer, colorLayer, settings.composite);
}
