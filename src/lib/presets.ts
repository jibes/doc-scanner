import type { ScanSettings } from './imaging/pipeline';
import { DEFAULT_SETTINGS, mergeSettings, type DeepPartial } from './settings';

export type PresetId = 'auto' | 'text' | 'receipt' | 'invoice' | 'color' | 'photo';

export interface Preset {
  id: PresetId;
  label: string;
  hint: string;
  settings: ScanSettings;
}

function preset(
  id: PresetId,
  label: string,
  hint: string,
  overrides: DeepPartial<ScanSettings>,
): Preset {
  return { id, label, hint, settings: mergeSettings(DEFAULT_SETTINGS, overrides) };
}

/**
 * Presets are just named bundles of settings — nothing more. Touching any
 * slider afterwards leaves the preset selected but the values customised.
 */
export const PRESETS: readonly Preset[] = [
  preset('auto', 'Auto', 'Balanced defaults for a typical printed page.', {}),
  preset('text', 'Text', 'Pure black on pure white. Best for contracts and letters.', {
    binarize: { window: 41, k: 0.2 },
    color: { enabled: false },
  }),
  preset(
    'receipt',
    'Receipt',
    'Small text, tight threshold, no colour. Best for thermal receipts.',
    {
      normalize: { radius: 30 },
      binarize: { window: 25, k: 0.1 },
      color: { enabled: false },
    },
  ),
  preset('invoice', 'Invoice', 'Keeps logos and stamps while cleaning the body text.', {
    binarize: { window: 41, k: 0.16 },
    color: { chromaThreshold: 55, minArea: 40 },
  }),
  preset('color', 'Colour', 'No binarisation. Flattens lighting and keeps everything else.', {
    binarize: { method: 'off' },
    color: { chromaThreshold: 40 },
    composite: { feather: 0 },
  }),
  preset('photo', 'Photo', 'Pass-through for pages that are mostly image, not text.', {
    normalize: { radius: 0 },
    binarize: { method: 'off' },
    color: { enabled: false },
    composite: { feather: 0 },
  }),
];

export function presetById(id: PresetId): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
