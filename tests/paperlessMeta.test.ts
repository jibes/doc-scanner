import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaperlessHttpError, PaperlessUnreachableError } from '../src/lib/paperless';
import {
  defaultSelection,
  loadLists,
  META_TTL_MS,
  readCachedLists,
  resolveSelection,
  uploadWithSelection,
  type PaperlessLists,
} from '../src/lib/paperlessMeta';
import { loadSettings } from '../src/lib/settings';

const config = { baseUrl: 'https://paperless.example.com', token: 'secret', tagIds: [] };

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A Paperless with a few items per list; counts requests per list. */
function paperless(lists: Record<string, { id: number; name: string; color?: string }[]>) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    void _init;
    const kind = new URL(url).pathname.split('/')[2];
    calls.push(kind);
    if (kind === 'documents') return new Response('"task-1"');
    return json({ count: lists[kind].length, next: null, results: lists[kind] });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, mock: fetch };
}

const LISTS = {
  tags: [
    { id: 1, name: 'Bills', color: '#ff0000' },
    { id: 2, name: 'Tax' },
  ],
  document_types: [{ id: 5, name: 'Invoice' }],
  correspondents: [{ id: 9, name: 'ACME' }],
};

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe('loadLists', () => {
  it('fetches, caches per server, and serves the cache while fresh', async () => {
    const server = paperless(LISTS);
    let t = 1000;
    const now = () => t;
    const first = await loadLists(config, { fetch: server.fetch, now });
    expect(first.stale).toBe(false);
    expect(first.lists.tags.map((x) => x.name)).toEqual(['Bills', 'Tax']);
    expect(first.lists.tags[0].color).toBe('#ff0000');
    expect(server.calls.sort()).toEqual(['correspondents', 'document_types', 'tags']);

    t += META_TTL_MS - 1;
    await loadLists(config, { fetch: server.fetch, now });
    expect(server.calls).toHaveLength(3);

    t += 2;
    await loadLists(config, { fetch: server.fetch, now });
    expect(server.calls).toHaveLength(6);

    // Never the token, and not for another server.
    expect(localStorage.getItem('doc-scanner.paperless-meta.v1')).not.toContain('secret');
    expect(readCachedLists({ ...config, baseUrl: 'https://other.example.com' })).toBeNull();
  });

  it('falls back to an old cache offline, and fails without one', async () => {
    const server = paperless(LISTS);
    await loadLists(config, { fetch: server.fetch, now: () => 0 });
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const stale = await loadLists(config, { fetch: offline, now: () => META_TTL_MS * 10 });
    expect(stale.stale).toBe(true);
    expect(stale.error).toMatch(/Could not reach/);
    expect(stale.lists.correspondents[0].name).toBe('ACME');

    localStorage.clear();
    await expect(loadLists(config, { fetch: offline })).rejects.toBeInstanceOf(
      PaperlessUnreachableError,
    );
  });
});

describe('selection', () => {
  const lists: PaperlessLists = {
    tags: [
      { id: 1, name: 'Bills' },
      { id: 2, name: 'Tax' },
    ],
    documentTypes: [{ id: 5, name: 'Invoice' }],
    correspondents: [{ id: 9, name: 'ACME' }],
    fetchedAt: 0,
  };

  it('turns legacy tag ids into names where known', () => {
    const selection = defaultSelection(
      { ...config, tagIds: [2, 77], tags: ['Bills'], documentType: 'Invoice' },
      lists,
    );
    expect(selection).toEqual({
      tags: ['Bills', 'Tax'],
      tagIds: [77],
      documentType: 'Invoice',
      correspondent: null,
    });
    expect(defaultSelection({ ...config, tagIds: [2] }).tagIds).toEqual([2]);
  });

  it('resolves names case-insensitively and reports unknown ones', () => {
    const { meta, missing } = resolveSelection(
      { tags: ['bills', 'Gone'], tagIds: [77], documentType: 'Invoice', correspondent: 'Nobody' },
      lists,
    );
    expect(meta).toEqual({ tags: [77, 1], documentType: 5, correspondent: null });
    expect(missing).toEqual(['Gone', 'Nobody']);
  });
});

describe('uploadWithSelection', () => {
  it('looks the ids up and sends them', async () => {
    const server = paperless(LISTS);
    vi.stubGlobal('fetch', server.fetch);
    const result = await uploadWithSelection(
      config,
      new Blob(['%PDF']),
      'a.pdf',
      'A',
      { tags: ['Tax'], tagIds: [], documentType: 'Invoice', correspondent: 'ACME' },
      { fetch: server.fetch },
    );
    expect(result).toEqual({ taskId: 'task-1', missing: [] });
    const form = server.mock.mock.calls.at(-1)![1]!.body as FormData;
    expect(form.get('document_type')).toBe('5');
    expect(form.get('correspondent')).toBe('9');
    expect(form.getAll('tags')).toEqual(['2']);
  });

  it('re-fetches once when a name is not in the fresh cache', async () => {
    const server = paperless(LISTS);
    await loadLists(config, { fetch: server.fetch });
    LISTS.tags.push({ id: 3, name: 'New' });
    vi.stubGlobal('fetch', server.fetch);
    try {
      const result = await uploadWithSelection(
        config,
        new Blob(['%PDF']),
        'a.pdf',
        'A',
        { tags: ['New'], tagIds: [], documentType: null, correspondent: null },
        { fetch: server.fetch },
      );
      expect(result.missing).toEqual([]);
      const post = server.mock.mock.calls.find(([url]) => url.includes('post_document'))!;
      expect((post[1]!.body as FormData).getAll('tags')).toEqual(['3']);
    } finally {
      LISTS.tags.pop();
    }
  });

  it('sends without names when the lists may not be read, but throws when offline', async () => {
    const denied = vi.fn(async (url: string) =>
      url.includes('post_document') ? new Response('"t"') : json({}, 403),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', denied);
    const selection = { tags: ['Tax'], tagIds: [4], documentType: null, correspondent: null };
    const result = await uploadWithSelection(config, new Blob([]), 'a.pdf', 'A', selection, {
      fetch: denied,
    });
    expect(result.missing).toEqual(['Tax']);

    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      uploadWithSelection(config, new Blob([]), 'a.pdf', 'A', selection, { fetch: offline }),
    ).rejects.toBeInstanceOf(PaperlessUnreachableError);
    expect(new PaperlessHttpError('x', 403).status).toBe(403);
  });
});

describe('loadSettings', () => {
  it('keeps legacy tag ids and reads the new name fields', () => {
    localStorage.setItem(
      'doc-scanner.settings.v2',
      JSON.stringify({ paperless: { baseUrl: 'https://p', token: 't', tagIds: [1, -2, 'x'] } }),
    );
    expect(loadSettings().paperless).toEqual({
      baseUrl: 'https://p',
      token: 't',
      tagIds: [1],
      tags: [],
      documentType: null,
      correspondent: null,
    });
    localStorage.setItem(
      'doc-scanner.settings.v2',
      JSON.stringify({
        paperless: { tags: ['A', 'A', '', 3], documentType: 'Invoice', correspondent: '' },
      }),
    );
    expect(loadSettings().paperless).toMatchObject({
      tags: ['A'],
      documentType: 'Invoice',
      correspondent: null,
    });
  });
});
