import type { ScanSettings } from './imaging/pipeline';

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export const DEFAULT_SETTINGS: ScanSettings = {
  normalize: { radius: 50, strength: 1, maxGain: 4 },
  binarize: { method: 'sauvola', window: 31, k: 0.15, c: 8, invert: false },
  color: { enabled: true, chromaThreshold: 60, lumaFloor: 40, minArea: 20, grow: 1 },
  composite: { paper: 255, text: 0, feather: 1 },
  output: { targetDpi: 300, maxLongEdge: 2400 },
};

/** Shallow-merge each settings group, so a partial override never drops a field. */
export function mergeSettings(
  base: ScanSettings,
  overrides: DeepPartial<ScanSettings>,
): ScanSettings {
  return {
    normalize: { ...base.normalize, ...overrides.normalize },
    binarize: { ...base.binarize, ...overrides.binarize },
    color: { ...base.color, ...overrides.color },
    composite: { ...base.composite, ...overrides.composite },
    output: { ...base.output, ...overrides.output },
  };
}

const SETTINGS_KEY = 'doc-scanner.settings.v1';

export function loadSettings(): ScanSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw) as DeepPartial<ScanSettings>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: ScanSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private browsing, quota). Settings are a
    // convenience, so failing to persist them must not break a scan.
  }
}
