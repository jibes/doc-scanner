import type { AppSettings } from './settings';

type PaperlessConfig = AppSettings['paperless'];

export function isConfigured(config: PaperlessConfig): boolean {
  return config.baseUrl.trim() !== '' && config.token.trim() !== '';
}

function base(config: PaperlessConfig): string {
  return config.baseUrl.trim().replace(/\/+$/, '');
}

/**
 * The server address for messages. Settings saved before URLs were validated
 * may carry a user name and password; those must never reach the screen.
 */
function shownBase(config: PaperlessConfig): string {
  try {
    const url = new URL(base(config));
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return 'the Paperless server';
  }
}

function headers(config: PaperlessConfig): HeadersInit {
  return { Authorization: `Token ${config.token.trim()}` };
}

function unreachable(config: PaperlessConfig, error: unknown): Error {
  const origin = globalThis.location?.origin ?? "this app's origin";
  return new Error(
    `Could not reach ${shownBase(config)}. Check the URL and that the server is up. ` +
      'Paperless must be served over https: browsers block http requests from this page ' +
      '(mixed content) and may block addresses on your local network. ' +
      `PAPERLESS_CORS_ALLOWED_HOSTS must include ${origin}.`,
    { cause: error },
  );
}

/** Read the consumption task id from the answer to post_document. */
export function parseTaskId(body: string): string {
  const text = body.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: accept a bare id (a UUID), nothing else.
    if (/^[\w-]+$/.test(text)) return text;
    throw new Error('Paperless accepted the upload but sent no task id back.');
  }
  if (typeof parsed === 'string' && parsed.trim() !== '') return parsed.trim();
  throw new Error('Paperless accepted the upload but sent no task id back.');
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
    throw unreachable(config, error);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Paperless returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  return parseTaskId(await response.text());
}

/** `duplicate`: Paperless refused the file because it already has it. */
export type TaskOutcome = 'success' | 'failure' | 'pending' | 'duplicate';

/** What history stores: a duplicate is already filed, so it counts as success. */
export type StoredOutcome = Exclude<TaskOutcome, 'duplicate'>;

export interface TaskResult {
  outcome: TaskOutcome;
  /** Paperless's own message for a failure or duplicate. */
  message: string | null;
}

export function storedOutcome(outcome: TaskOutcome): StoredOutcome {
  return outcome === 'duplicate' ? 'success' : outcome;
}

/** Interpret one entry of /api/tasks/. Unknown or missing states are still pending. */
export function taskResult(task: Record<string, unknown> | undefined): TaskResult {
  const message = typeof task?.result === 'string' ? task.result : null;
  switch (task?.status) {
    case 'SUCCESS':
      return { outcome: 'success', message: null };
    case 'FAILURE':
      // "Not consuming x.pdf: It is a duplicate of y (#12)."
      return { outcome: message && /duplicate/i.test(message) ? 'duplicate' : 'failure', message };
    case 'REVOKED':
      return { outcome: 'failure', message: message ?? 'Paperless cancelled the task.' };
    default:
      return { outcome: 'pending', message: null };
  }
}

/** Polling cannot succeed: retrying would only repeat the same answer. */
export class TaskCheckError extends Error {}

/**
 * Ask Paperless once how a consumption task is doing. Throws `TaskCheckError`
 * when the status cannot be read at all; any other error is worth retrying.
 */
export async function checkTask(config: PaperlessConfig, taskId: string): Promise<TaskResult> {
  const response = await fetch(`${base(config)}/api/tasks/?task_id=${encodeURIComponent(taskId)}`, {
    headers: headers(config),
  });
  if (response.status === 401 || response.status === 403) {
    throw new TaskCheckError(
      `Paperless took the file but will not report its progress (${response.status}): ` +
        "the API token's user needs permission to view tasks. Check the document in Paperless.",
    );
  }
  if (response.status === 404) {
    throw new TaskCheckError(
      'Paperless took the file but has no task status to report (404). Check the document in Paperless.',
    );
  }
  if (!response.ok) throw new Error(`Paperless returned ${response.status}`);
  const list: unknown = await response.json();
  // A plain array; tolerate a paginated answer too.
  const items = Array.isArray(list)
    ? list
    : list && typeof list === 'object' && Array.isArray((list as { results?: unknown }).results)
      ? (list as { results: unknown[] }).results
      : [];
  // Only this upload's task: a server that ignores the filter must not
  // report another document's outcome.
  const task = items.find(
    (item) =>
      item && typeof item === 'object' && (item as { task_id?: unknown }).task_id === taskId,
  );
  return taskResult(
    task && typeof task === 'object' ? (task as Record<string, unknown>) : undefined,
  );
}

export const POLL_TIMEOUT_MS = 5 * 60_000;
const FIRST_DELAY_MS = 2000;
const MAX_DELAY_MS = 10_000;

export interface PollOptions {
  timeoutMs?: number;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll the consumption task until it finishes or `timeoutMs` passes, backing
 * off from 2 s to 10 s. Network blips and garbled answers are retried.
 */
export async function pollTask(
  config: PaperlessConfig,
  taskId: string,
  {
    timeoutMs = POLL_TIMEOUT_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  }: PollOptions = {},
): Promise<TaskResult> {
  const deadline = now() + timeoutMs;
  let delay = FIRST_DELAY_MS;
  while (now() < deadline) {
    await sleep(delay);
    delay = Math.min(delay * 1.5, MAX_DELAY_MS);
    try {
      const result = await checkTask(config, taskId);
      if (result.outcome !== 'pending') return result;
    } catch (error) {
      if (error instanceof TaskCheckError) throw error;
    }
  }
  return { outcome: 'pending', message: null };
}

/**
 * `pollTask` in the shape history stores; `duplicate` says the file was
 * already in Paperless (reported as success).
 */
export async function waitForTask(
  config: PaperlessConfig,
  taskId: string,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<{ outcome: StoredOutcome; message: string | null; duplicate: boolean }> {
  const result = await pollTask(config, taskId, { timeoutMs });
  return {
    outcome: storedOutcome(result.outcome),
    message: result.message,
    duplicate: result.outcome === 'duplicate',
  };
}
