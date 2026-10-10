import type { FilterId } from './imaging/filters';

export type Resolution = 'standard' | 'high' | 'max';

export interface AppSettings {
  paperless: { baseUrl: string; token: string; tagIds: number[] };
  defaultFilter: FilterId;
  autoCapture: boolean;
  resolution: Resolution;
  /** JPEG quality for colour pages in the PDF, 0..1. */
  jpegQuality: number;
  /** A lens picked by hand, or null for automatic selection. */
  cameraDeviceId: string | null;
}

/** Long edge of an exported page. ~300 dpi on A4 for 'high'. */
export const RESOLUTION_LONG_EDGE: Record<Resolution, number> = {
  standard: 2400,
  high: 3500,
  max: 4400,
};

export const DEFAULT_SETTINGS: AppSettings = {
  paperless: { baseUrl: '', token: '', tagIds: [] },
  defaultFilter: 'document',
  autoCapture: true,
  resolution: 'high',
  jpegQuality: 0.88,
  cameraDeviceId: null,
};

const KEY = 'doc-scanner.settings.v2';
const FILTERS: FilterId[] = ['document', 'bw', 'gray', 'color', 'original'];

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const s = JSON.parse(raw) as Partial<AppSettings>;
    const p = (s.paperless ?? {}) as Partial<AppSettings['paperless']>;
    return {
      paperless: {
        baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
        token: typeof p.token === 'string' ? p.token : '',
        tagIds: Array.isArray(p.tagIds) ? p.tagIds.filter((n) => Number.isInteger(n) && n > 0) : [],
      },
      defaultFilter: FILTERS.includes(s.defaultFilter as FilterId)
        ? (s.defaultFilter as FilterId)
        : DEFAULT_SETTINGS.defaultFilter,
      autoCapture:
        typeof s.autoCapture === 'boolean' ? s.autoCapture : DEFAULT_SETTINGS.autoCapture,
      resolution:
        s.resolution && s.resolution in RESOLUTION_LONG_EDGE
          ? s.resolution
          : DEFAULT_SETTINGS.resolution,
      jpegQuality:
        typeof s.jpegQuality === 'number' && s.jpegQuality >= 0.5 && s.jpegQuality <= 1
          ? s.jpegQuality
          : DEFAULT_SETTINGS.jpegQuality,
      cameraDeviceId: typeof s.cameraDeviceId === 'string' ? s.cameraDeviceId : null,
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode, quota); settings are a convenience.
  }
}
