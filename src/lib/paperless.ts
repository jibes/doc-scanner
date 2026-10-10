import type { AppSettings } from './settings';

type PaperlessConfig = AppSettings['paperless'];

export function isConfigured(config: PaperlessConfig): boolean {
  return config.baseUrl.trim() !== '' && config.token.trim() !== '';
}

function base(config: PaperlessConfig): string {
  return config.baseUrl.trim().replace(/\/+$/, '');
}

function headers(config: PaperlessConfig): HeadersInit {
  return { Authorization: `Token ${config.token.trim()}` };
}

/**
 * Upload a PDF. Paperless runs OCRmyPDF on ingest, which adds the searchable
 * text layer. Returns the consumption task id.
 */
export async function uploadDocument(
  config: PaperlessConfig,
  pdf: Blob,
  filename: string,
  title: string,
): Promise<string> {
  const form = new FormData();
  form.append('document', pdf, filename);
  if (title) form.append('title', title);
  // A repeated field, one id per entry; a JSON array is rejected.
  for (const tag of config.tagIds) form.append('tags', String(tag));

  let response: Response;
  try {
    response = await fetch(`${base(config)}/api/documents/post_document/`, {
      method: 'POST',
      headers: headers(config),
      body: form,
    });
  } catch (error) {
    throw new Error(
      `Could not reach ${base(config)}. Check the URL, that the server is up, and that PAPERLESS_CORS_ALLOWED_HOSTS includes this app's origin.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Paperless returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  const body = (await response.text()).trim();
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    return body.replace(/^"|"$/g, '');
  }
}

export type TaskOutcome = 'success' | 'failure' | 'pending';

/** Poll the consumption task until it finishes or `timeoutMs` passes. */
export async function waitForTask(
  config: PaperlessConfig,
  taskId: string,
  timeoutMs = 60_000,
): Promise<{ outcome: TaskOutcome; message: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const response = await fetch(
        `${base(config)}/api/tasks/?task_id=${encodeURIComponent(taskId)}`,
        { headers: headers(config) },
      );
      if (!response.ok) continue;
      const list: unknown = await response.json();
      const task = Array.isArray(list)
        ? (list[0] as Record<string, unknown> | undefined)
        : undefined;
      if (!task) continue;
      if (task.status === 'SUCCESS') return { outcome: 'success', message: null };
      if (task.status === 'FAILURE') {
        return {
          outcome: 'failure',
          message: typeof task.result === 'string' ? task.result : null,
        };
      }
    } catch {
      return { outcome: 'pending', message: null };
    }
  }
  return { outcome: 'pending', message: null };
}
