import { normalizeServerUrl, type PaperlessSettings } from './settings';

type PaperlessConfig = PaperlessSettings;

/**
 * The request never got an HTTP answer: the server is down or unreachable,
 * the network is offline, or the browser blocked it (CORS, mixed content,
 * an untrusted certificate). Browsers do not say which.
 */
export class PaperlessUnreachableError extends Error {}

/** Paperless (or a proxy in front of it) answered with an error status. */
export class PaperlessHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Worth trying again later: no answer at all, or a gateway / rate limit
 * answer meaning the server behind it is (temporarily) away. A 4xx from
 * Paperless itself would only be repeated.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof PaperlessUnreachableError) return true;
  return error instanceof PaperlessHttpError && [408, 429, 502, 503, 504].includes(error.status);
}

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

function unreachable(config: PaperlessConfig, error: unknown): PaperlessUnreachableError {
  const origin = globalThis.location?.origin ?? "this app's origin";
  return new PaperlessUnreachableError(
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

async function httpError(response: Response): Promise<PaperlessHttpError> {
  const detail = await response.text().catch(() => '');
  return new PaperlessHttpError(
    `Paperless returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    response.status,
  );
}

/** Paperless ids to file an upload under. */
export interface UploadMeta {
  tags: number[];
  documentType: number | null;
  correspondent: number | null;
}

/**
 * Upload a PDF. Paperless runs OCRmyPDF on ingest, which adds the searchable
 * text layer. Returns the consumption task id. Without `meta`, the legacy
 * `tagIds` from the settings are attached.
 *
 * Throws `PaperlessUnreachableError` when there was no answer and
 * `PaperlessHttpError` for an error status (see `isRetryableError`).
 */
export async function uploadDocument(
  config: PaperlessConfig,
  pdf: Blob,
  filename: string,
  title: string,
  meta?: UploadMeta,
): Promise<string> {
  const form = new FormData();
  form.append('document', pdf, filename);
  if (title) form.append('title', title);
  // A repeated field, one id per entry; a JSON array is rejected.
  for (const tag of new Set(meta?.tags ?? config.tagIds)) form.append('tags', String(tag));
  if (meta?.documentType != null) form.append('document_type', String(meta.documentType));
  if (meta?.correspondent != null) form.append('correspondent', String(meta.correspondent));

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
  if (!response.ok) throw await httpError(response);
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

/* ------------------------------------------------------------ lists ---- */

/** A tag, document type or correspondent. */
export interface PaperlessItem {
  id: number;
  name: string;
  /** Tags only: background colour, e.g. `#a6cee3`. */
  color?: string;
  /** Tags only: text colour Paperless picked for that background. */
  textColor?: string;
}

export type ListKind = 'tags' | 'document_types' | 'correspondents';

const PAGE_SIZE = 100;
/** A runaway server (ignoring `page`) must not loop forever. */
const MAX_PAGES = 50;
const HEX_COLOUR = /^#[0-9a-f]{3,8}$/i;

/** Read one entry of a list answer; anything without an id and a name is dropped. */
export function parseItem(raw: unknown): PaperlessItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'number' || !Number.isInteger(r.id) || typeof r.name !== 'string') {
    return null;
  }
  const item: PaperlessItem = { id: r.id, name: r.name };
  if (typeof r.color === 'string' && HEX_COLOUR.test(r.color)) item.color = r.color;
  if (typeof r.text_color === 'string' && HEX_COLOUR.test(r.text_color)) {
    item.textColor = r.text_color;
  }
  return item;
}

/**
 * Every tag, document type or correspondent the token's user can see. Pages
 * are requested by number rather than by following `next`: behind a reverse
 * proxy Paperless often builds that link with http://, which the browser
 * would then block as mixed content.
 */
export async function fetchList(
  config: PaperlessConfig,
  kind: ListKind,
  fetchImpl: typeof fetch = fetch,
): Promise<PaperlessItem[]> {
  const items: PaperlessItem[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let response: Response;
    try {
      response = await fetchImpl(
        `${base(config)}/api/${kind}/?page=${page}&page_size=${PAGE_SIZE}&ordering=name`,
        { headers: headers(config) },
      );
    } catch (error) {
      throw unreachable(config, error);
    }
    if (!response.ok) throw await httpError(response);
    const body: unknown = await response.json().catch(() => null);
    const paged = body && typeof body === 'object' && !Array.isArray(body);
    const results = Array.isArray(body)
      ? body
      : paged && Array.isArray((body as { results?: unknown }).results)
        ? (body as { results: unknown[] }).results
        : null;
    if (!results) throw new Error(`Paperless sent an unexpected answer for ${kind}.`);
    for (const raw of results) {
      const item = parseItem(raw);
      if (item) items.push(item);
    }
    const { next, count } = (paged ? body : {}) as { next?: unknown; count?: unknown };
    const done =
      !paged ||
      results.length === 0 ||
      !next ||
      (typeof count === 'number' && items.length >= count);
    if (done) break;
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/* -------------------------------------------------- connection test ---- */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export type CheckId = 'url' | 'reach' | 'token' | 'upload' | 'tasks' | 'tags' | 'version';

export interface ConnectionCheck {
  id: CheckId;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ConnectionReport {
  /** True when nothing failed: uploads should work (warnings aside). */
  ok: boolean;
  checks: ConnectionCheck[];
  version: string | null;
}

const LABELS: Record<CheckId, string> = {
  url: 'Server address',
  reach: 'Server reachable',
  token: 'API token accepted',
  upload: 'Allowed to add documents',
  tasks: 'Allowed to read upload status',
  tags: 'Allowed to read tags',
  version: 'Paperless version',
};

function versionFrom(response: Response): string | null {
  return response.headers.get('x-version') ?? response.headers.get('x-api-version') ?? null;
}

interface UiSettings {
  user?: { is_superuser?: unknown };
  permissions?: unknown;
  version?: unknown;
}

/**
 * Check a server address and token step by step, for the settings screen.
 * Never throws; every step reports what it found.
 */
export async function testConnection(
  raw: { baseUrl: string; token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionReport> {
  const checks: ConnectionCheck[] = [];
  const add = (id: CheckId, status: CheckStatus, detail: string) =>
    checks.push({ id, label: LABELS[id], status, detail });
  const rest: CheckId[] = ['reach', 'token', 'upload', 'tasks', 'tags', 'version'];
  let version: string | null = null;
  const stop = (why: string): ConnectionReport => {
    for (const id of rest) if (!checks.some((c) => c.id === id)) add(id, 'skip', why);
    return finish();
  };
  const finish = (): ConnectionReport => ({
    ok: !checks.some((c) => c.status === 'fail'),
    checks,
    version,
  });

  const url = normalizeServerUrl(raw.baseUrl);
  if (!url.ok || url.url === '') {
    add('url', 'fail', url.ok ? 'Enter the server address.' : url.error);
    return stop('Needs a valid address.');
  }
  add('url', 'ok', url.url);
  const token = raw.token.trim();
  const init: RequestInit = token ? { headers: { Authorization: `Token ${token}` } } : {};
  const origin = globalThis.location?.origin ?? "this app's origin";

  // 1. Reachable and allowed by CORS? Any HTTP answer, even a 401, says yes.
  let root: Response;
  try {
    root = await fetchImpl(`${url.url}/api/`, init);
  } catch {
    // To a normal request a CORS refusal and a dead server look the same. A
    // no-cors request is exempt from CORS: if it gets an (opaque) answer, the
    // server is there and only refuses to share its answers with this app.
    let answered = false;
    try {
      await fetchImpl(`${url.url}/api/`, { mode: 'no-cors' });
      answered = true;
    } catch {
      // Not reachable at all.
    }
    add(
      'reach',
      'fail',
      answered
        ? 'The server answers, but the browser blocks this app from reading it (CORS). ' +
            `Add ${origin} to PAPERLESS_CORS_ALLOWED_HOSTS and restart Paperless.`
        : 'No answer. The server may be down or the address wrong; its https certificate must ' +
            'be trusted by this device; a VPN or local-network restriction may block it. ' +
            `If it is up, PAPERLESS_CORS_ALLOWED_HOSTS must include ${origin}.`,
    );
    return stop('Needs the server to be reachable.');
  }
  version = versionFrom(root);
  if (root.status === 404) {
    add('reach', 'fail', `${url.url}/api/ does not exist (404). Is this the Paperless address?`);
    return stop('Needs the Paperless API.');
  }
  if (root.status >= 500) {
    add('reach', 'fail', `The server answered with an error (${root.status}).`);
    return stop('Needs a working server.');
  }
  add('reach', 'ok', `Answered over ${url.url.split(':')[0]}.`);

  // 2. Token.
  if (!token) {
    add('token', 'fail', 'Enter an API token.');
    return stop('Needs a token.');
  }
  if (root.status === 401 || root.status === 403) {
    add('token', 'fail', `Paperless rejected the token (${root.status}). Copy it again.`);
    return stop('Needs a valid token.');
  }
  if (root.ok) add('token', 'ok', 'Signed in.');
  else add('token', 'warn', `Unexpected answer (${root.status}).`);

  const get = async (path: string): Promise<Response | null> => {
    try {
      const response = await fetchImpl(`${url.url}${path}`, init);
      version ??= versionFrom(response);
      return response;
    } catch {
      return null;
    }
  };
  const denied = (r: Response | null) => r !== null && (r.status === 401 || r.status === 403);

  // 3. Upload permission, as far as ui_settings tells.
  const ui = await get('/api/ui_settings/');
  const settings = ui?.ok ? ((await ui.json().catch(() => null)) as UiSettings | null) : null;
  const perms = Array.isArray(settings?.permissions)
    ? settings.permissions.filter((p): p is string => typeof p === 'string')
    : null;
  const superuser = settings?.user?.is_superuser === true;
  if (typeof settings?.version === 'string') version ??= settings.version;
  if (superuser) add('upload', 'ok', 'Superuser.');
  else if (perms?.some((p) => /(^|\.)add_document$/.test(p))) {
    add('upload', 'ok', 'Has the “add document” permission.');
  } else if (perms) {
    add('upload', 'fail', 'The token’s user lacks the “add document” permission.');
  } else {
    add('upload', 'skip', 'Paperless did not list the permissions.');
  }

  // 4. Tasks: needed to tell whether an upload was filed.
  const tasks = await get('/api/tasks/?task_id=connection-test');
  if (tasks?.ok) add('tasks', 'ok', 'Upload results can be shown.');
  else if (denied(tasks)) {
    add(
      'tasks',
      'warn',
      'Uploads work, but the app cannot tell whether Paperless filed them. Give the user permission to view tasks.',
    );
  } else add('tasks', 'warn', tasks ? `Answered ${tasks.status}.` : 'No answer.');

  // 5. Tags: needed for the tag pickers.
  const tags = await get('/api/tags/?page_size=1');
  if (tags?.ok) {
    const body = (await tags.json().catch(() => null)) as { count?: unknown } | null;
    add('tags', 'ok', typeof body?.count === 'number' ? `${body.count} tags.` : 'Readable.');
  } else if (denied(tags)) {
    add('tags', 'warn', 'Tags cannot be picked: the user needs permission to view tags.');
  } else add('tags', 'warn', tags ? `Answered ${tags.status}.` : 'No answer.');

  // 6. Version: a response header (if the server exposes it to the browser)
  // or the admin-only status endpoint.
  if (!version) {
    const status = await get('/api/status/');
    if (status?.ok) {
      const body = (await status.json().catch(() => null)) as { pngx_version?: unknown } | null;
      if (typeof body?.pngx_version === 'string') version = body.pngx_version;
    }
  }
  add('version', version ? 'ok' : 'skip', version ?? 'Not reported to this app.');
  return finish();
}
