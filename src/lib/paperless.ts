export interface PaperlessConfig {
  baseUrl: string;
  token: string;
  tagIds: number[];
}

export const DEFAULT_PAPERLESS_CONFIG: PaperlessConfig = {
  baseUrl: '',
  token: '',
  tagIds: [],
};

const CONFIG_KEY = 'doc-scanner.paperless.v1';

export function loadPaperlessConfig(): PaperlessConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return DEFAULT_PAPERLESS_CONFIG;
    const parsed = JSON.parse(raw) as Partial<PaperlessConfig>;
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : '',
      token: typeof parsed.token === 'string' ? parsed.token : '',
      tagIds: Array.isArray(parsed.tagIds) ? parsed.tagIds.filter((n) => Number.isInteger(n)) : [],
    };
  } catch {
    return DEFAULT_PAPERLESS_CONFIG;
  }
}

export function savePaperlessConfig(config: PaperlessConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // See settings.ts — persistence is best effort.
  }
}

export function isConfigured(config: PaperlessConfig): boolean {
  return config.baseUrl.trim().length > 0 && config.token.trim().length > 0;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Upload a page to Paperless-ngx.
 *
 * Paperless runs OCRmyPDF + Tesseract on ingest, so the PNG we send becomes a
 * searchable PDF with a hidden text layer and gets indexed for full-text
 * search. Returns the task id, which can be polled with {@link waitForTask}.
 */
export async function uploadDocument(
  config: PaperlessConfig,
  file: Blob,
  filename: string,
  title: string,
): Promise<string> {
  const base = normalizeBaseUrl(config.baseUrl);
  if (!base) throw new Error('Paperless base URL is not configured');
  if (!config.token.trim()) throw new Error('Paperless API token is not configured');

  const form = new FormData();
  form.append('document', file, filename);
  form.append('title', title);
  // Paperless reads tags as a repeated multipart field, one id per entry.
  for (const tagId of config.tagIds) form.append('tags', String(tagId));

  let response: Response;
  try {
    response = await fetch(`${base}/api/documents/post_document/`, {
      method: 'POST',
      headers: { Authorization: `Token ${config.token.trim()}` },
      body: form,
    });
  } catch (error) {
    throw new Error(
      `Could not reach ${base}. Check the URL, that the server is running, and that it allows CORS from this origin. (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Paperless returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }

  const body = await response.text();
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    return body.trim();
  }
}

export interface TaskStatus {
  status: string;
  documentId: number | null;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Best-effort poll of the ingest task so the UI can confirm that OCR finished.
 * Returns null if the task is still running when the timeout expires, or if
 * polling is not permitted — the document is queued either way.
 */
export async function waitForTask(
  config: PaperlessConfig,
  taskId: string,
  { timeoutMs = 45000, intervalMs = 2500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<TaskStatus | null> {
  const base = normalizeBaseUrl(config.baseUrl);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await delay(intervalMs);
    try {
      const response = await fetch(`${base}/api/tasks/?task_id=${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Token ${config.token.trim()}` },
      });
      if (!response.ok) continue;

      const tasks: unknown = await response.json();
      const task = Array.isArray(tasks) ? (tasks[0] as Record<string, unknown>) : null;
      if (!task) continue;

      const status = String(task.status ?? '');
      if (status === 'SUCCESS' || status === 'FAILURE') {
        const related = task.related_document;
        return {
          status,
          documentId: typeof related === 'number' ? related : null,
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}
