import type { FilterId } from './imaging/filters';

export type Resolution = 'standard' | 'high' | 'max';

export interface PaperlessSettings {
  baseUrl: string;
  token: string;
  /**
   * Tag ids from before tags were picked by name. Ids that could be matched
   * to a name move to `tags` the next time the settings are saved; the rest
   * stay here and are still sent with uploads.
   */
  tagIds: number[];
  /** Default tags, by name. Optional only so older call sites still type-check. */
  tags?: string[];
  /** Default document type, by name. */
  documentType?: string | null;
  /** Default correspondent, by name. */
  correspondent?: string | null;
}

export interface AppSettings {
  paperless: PaperlessSettings;
  defaultFilter: FilterId;
  autoCapture: boolean;
  resolution: Resolution;
  /** JPEG quality for colour pages in the PDF, 0..1. */
  jpegQuality: number;
  /** A lens picked by hand, or null for automatic selection. */
  cameraDeviceId: string | null;
  /** Add an invisible OCR text layer to saved and shared PDFs. */
  ocr: boolean;
}

/** Long edge of an exported page. ~300 dpi on A4 for 'high'. */
export const RESOLUTION_LONG_EDGE: Record<Resolution, number> = {
  standard: 2400,
  high: 3500,
  max: 4400,
};

export const DEFAULT_SETTINGS: AppSettings = {
  paperless: {
    baseUrl: '',
    token: '',
    tagIds: [],
    tags: [],
    documentType: null,
    correspondent: null,
  },
  defaultFilter: 'document',
  autoCapture: true,
  resolution: 'high',
  jpegQuality: 0.88,
  cameraDeviceId: null,
  ocr: true,
};

const KEY = 'doc-scanner.settings.v2';
const FILTERS: FilterId[] = ['document', 'bw', 'gray', 'color', 'original'];

function nameOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

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
        tags: Array.isArray(p.tags)
          ? [...new Set(p.tags.filter((t) => typeof t === 'string' && t.trim() !== ''))]
          : [],
        documentType: nameOrNull(p.documentType),
        correspondent: nameOrNull(p.correspondent),
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
      ocr: typeof s.ocr === 'boolean' ? s.ocr : DEFAULT_SETTINGS.ocr,
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

/** Hosts that browsers treat as secure even over plain http. */
// Not [::1]: the Content Security Policy cannot name IPv6 addresses.
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

export type ServerUrlCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validate and normalise the Paperless server URL: https only (plain http just
 * for this device), no credentials, query or fragment, no trailing slash. An
 * empty value is allowed (uploads stay off). Errors never echo the input,
 * which could hold a password.
 */
export function normalizeServerUrl(raw: string): ServerUrlCheck {
  const value = raw.trim();
  if (value === '') return { ok: true, url: '' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: 'Enter the full address, starting with https://' };
  }
  const loopback = url.protocol === 'http:' && LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    return {
      ok: false,
      error:
        url.protocol === 'http:'
          ? 'Use https://. Browsers block plain http requests from this app as mixed content.'
          : 'The address must start with https://',
    };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Leave the user name and password out of the address.' };
  }
  if (url.search || url.hash || value.includes('?') || value.includes('#')) {
    return { ok: false, error: 'Remove the ? or # part from the address.' };
  }
  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}
