import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchList,
  isRetryableError,
  PaperlessHttpError,
  PaperlessUnreachableError,
  parseItem,
  testConnection,
  uploadDocument,
} from '../src/lib/paperless';

const config = { baseUrl: 'https://paperless.example.com', token: 'secret', tagIds: [3] };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const offline = async (): Promise<Response> => {
  throw new TypeError('Failed to fetch');
};

afterEach(() => vi.unstubAllGlobals());

describe('uploadDocument metadata', () => {
  async function sentForm(meta?: Parameters<typeof uploadDocument>[4]): Promise<FormData> {
    const fetch = vi.fn(
      async (...args: [string, RequestInit]) => (void args, new Response('"t-1"')),
    );
    vi.stubGlobal('fetch', fetch);
    await uploadDocument(config, new Blob(['%PDF']), 'a.pdf', 'A', meta);
    return fetch.mock.calls[0][1].body as FormData;
  }

  it('sends repeated tags, document type and correspondent', async () => {
    const form = await sentForm({ tags: [1, 2, 2], documentType: 7, correspondent: 9 });
    expect(form.getAll('tags')).toEqual(['1', '2']);
    expect(form.get('document_type')).toBe('7');
    expect(form.get('correspondent')).toBe('9');
    expect(form.get('title')).toBe('A');
  });

  it('falls back to the legacy tag ids and leaves out empty fields', async () => {
    const form = await sentForm();
    expect(form.getAll('tags')).toEqual(['3']);
    expect(form.has('document_type')).toBe(false);
    expect(form.has('correspondent')).toBe(false);
  });

  it('classifies errors: no answer and gateway errors are worth retrying, 4xx is not', async () => {
    vi.stubGlobal('fetch', offline);
    const unreachable = await uploadDocument(config, new Blob([]), 'a.pdf', 'A').catch((e) => e);
    expect(unreachable).toBeInstanceOf(PaperlessUnreachableError);
    expect(isRetryableError(unreachable)).toBe(true);

    for (const [status, retry] of [
      [400, false],
      [401, false],
      [413, false],
      [500, false],
      [502, true],
      [503, true],
      [504, true],
    ] as const) {
      vi.stubGlobal('fetch', async () => new Response('nope', { status }));
      const error = await uploadDocument(config, new Blob([]), 'a.pdf', 'A').catch((e) => e);
      expect(error).toBeInstanceOf(PaperlessHttpError);
      expect((error as PaperlessHttpError).status).toBe(status);
      expect(isRetryableError(error), String(status)).toBe(retry);
    }
    expect(isRetryableError(new Error('x'))).toBe(false);
  });
});

describe('parseItem', () => {
  it('keeps id, name and valid colours only', () => {
    expect(parseItem({ id: 1, name: 'Bills', color: '#a6cee3', text_color: '#000000' })).toEqual({
      id: 1,
      name: 'Bills',
      color: '#a6cee3',
      textColor: '#000000',
    });
    expect(parseItem({ id: 2, name: 'Old', colour: 3, color: 'red;}' })).toEqual({
      id: 2,
      name: 'Old',
    });
    expect(parseItem({ id: '3', name: 'x' })).toBeNull();
    expect(parseItem({ id: 3 })).toBeNull();
    expect(parseItem(null)).toBeNull();
  });
});

describe('fetchList', () => {
  it('reads every page by number, sorted by name, with the token', async () => {
    const pages: Record<string, unknown> = {
      '1': {
        count: 3,
        next: 'http://internal/api/tags/?page=2',
        results: [
          { id: 2, name: 'b' },
          { id: 1, name: 'a' },
        ],
      },
      '2': { count: 3, next: null, results: [{ id: 3, name: 'C' }] },
    };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Token secret');
      // Never follows the (http) next link.
      expect(url.startsWith('https://paperless.example.com/api/tags/?page=')).toBe(true);
      expect(url).toContain('page_size=100');
      return json(pages[new URL(url).searchParams.get('page')!]);
    });
    const items = await fetchList(config, 'tags', fetch as typeof globalThis.fetch);
    expect(items.map((i) => i.name)).toEqual(['a', 'b', 'C']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops when count is reached even if next is set', async () => {
    const fetch = vi.fn(async () => json({ count: 1, next: 'x', results: [{ id: 1, name: 'a' }] }));
    await fetchList(config, 'correspondents', fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('accepts a plain array', async () => {
    const fetch = vi.fn(async () => json([{ id: 1, name: 'Invoice' }]));
    expect(await fetchList(config, 'document_types', fetch)).toEqual([{ id: 1, name: 'Invoice' }]);
  });

  it('reports network and HTTP errors as such', async () => {
    await expect(fetchList(config, 'tags', offline)).rejects.toBeInstanceOf(
      PaperlessUnreachableError,
    );
    const denied = await fetchList(config, 'tags', async () => json({}, 403)).catch((e) => e);
    expect(denied).toBeInstanceOf(PaperlessHttpError);
    expect((denied as PaperlessHttpError).status).toBe(403);
    await expect(fetchList(config, 'tags', async () => json({ detail: 1 }))).rejects.toThrow(
      /unexpected/,
    );
  });
});

describe('testConnection', () => {
  type Route = (init?: RequestInit) => Response | Promise<Response>;
  function server(routes: Record<string, Route>) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('https://paperless.example.com', '');
      const route = routes[path] ?? routes[path.split('?')[0]];
      if (!route) return json({ detail: 'Not found' }, 404);
      return route(init);
    }) as unknown as typeof fetch;
  }
  const statusOf = (report: Awaited<ReturnType<typeof testConnection>>) =>
    Object.fromEntries(report.checks.map((c) => [c.id, c.status]));

  it('passes every step on a healthy server and reads the version header', async () => {
    const report = await testConnection(
      { baseUrl: 'https://paperless.example.com/', token: ' secret ' },
      server({
        '/api/': (init) =>
          new Headers(init?.headers).get('Authorization') === 'Token secret'
            ? json({}, 200, { 'X-Version': '2.14.7' })
            : json({}, 401),
        '/api/ui_settings/': () =>
          json({ user: { is_superuser: false }, permissions: ['documents.add_document'] }),
        '/api/tasks/': () => json([]),
        '/api/tags/': () => json({ count: 12, results: [] }),
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.version).toBe('2.14.7');
    expect(statusOf(report)).toEqual({
      url: 'ok',
      reach: 'ok',
      token: 'ok',
      upload: 'ok',
      tasks: 'ok',
      tags: 'ok',
      version: 'ok',
    });
    expect(report.checks.find((c) => c.id === 'tags')!.detail).toMatch(/12 tags/);
  });

  it('rejects a bad address without any request', async () => {
    const fetch = vi.fn();
    const report = await testConnection({ baseUrl: 'http://192.168.1.5', token: 'x' }, fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({ id: 'url', status: 'fail' });
    expect(report.checks[0].detail).toMatch(/mixed content/);
    expect(report.checks.slice(1).every((c) => c.status === 'skip')).toBe(true);
  });

  it('tells CORS (no-cors probe answers) from a dead server (it does not)', async () => {
    const cors = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const blocked = await testConnection(config, cors);
    expect(statusOf(blocked).reach).toBe('fail');
    expect(blocked.checks.find((c) => c.id === 'reach')!.detail).toMatch(
      /CORS.*PAPERLESS_CORS_ALLOWED_HOSTS/,
    );

    const dead = await testConnection(config, offline);
    const detail = dead.checks.find((c) => c.id === 'reach')!.detail;
    expect(detail).toMatch(/No answer/);
    expect(detail).toMatch(/certificate/);
    expect(statusOf(dead).token).toBe('skip');
  });

  it('reports a rejected token', async () => {
    const report = await testConnection(config, server({ '/api/': () => json({}, 401) }));
    expect(statusOf(report)).toMatchObject({ reach: 'ok', token: 'fail', tasks: 'skip' });
  });

  it('reports a missing token and a wrong path', async () => {
    const noToken = await testConnection(
      { baseUrl: config.baseUrl, token: '' },
      server({ '/api/': () => json({}, 401) }),
    );
    expect(statusOf(noToken).token).toBe('fail');
    const notFound = await testConnection(config, server({}));
    expect(statusOf(notFound).reach).toBe('fail');
    expect(notFound.checks.find((c) => c.id === 'reach')!.detail).toMatch(/404/);
  });

  it('warns about missing task and tag permissions and fails without add permission', async () => {
    const report = await testConnection(
      config,
      server({
        '/api/': () => json({}),
        '/api/ui_settings/': () => json({ user: {}, permissions: ['documents.view_document'] }),
        '/api/tasks/': () => json({}, 403),
        '/api/tags/': () => json({}, 403),
        '/api/status/': () => json({}, 403),
      }),
    );
    expect(statusOf(report)).toMatchObject({
      upload: 'fail',
      tasks: 'warn',
      tags: 'warn',
      version: 'skip',
    });
    expect(report.ok).toBe(false);
  });

  it('falls back to /api/status/ for the version', async () => {
    const report = await testConnection(
      config,
      server({
        '/api/': () => json({}),
        '/api/ui_settings/': () => json({ user: { is_superuser: true } }),
        '/api/tasks/': () => json([]),
        '/api/tags/': () => json({ count: 0, results: [] }),
        '/api/status/': () => json({ pngx_version: '2.15.0' }),
      }),
    );
    expect(report.version).toBe('2.15.0');
    expect(statusOf(report).upload).toBe('ok');
  });
});
