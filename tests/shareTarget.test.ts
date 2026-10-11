import { describe, expect, it } from 'vitest';
import { SHARED_CACHE, sharedFiles } from '../src/lib/shareTarget';
import { isIos } from '../src/lib/onboarding.svelte';

/** Just enough Cache Storage for the shared-files cache. */
function fakeCaches(entries: Record<string, Response>) {
  const map = new Map(Object.entries(entries).map(([url, r]) => [url, r]));
  const cache = {
    keys: async () => [...map.keys()].map((url) => new Request(url)),
    match: async (r: Request) => map.get(r.url)?.clone(),
    delete: async (r: Request) => map.delete(r.url),
  } as unknown as Cache;
  return {
    map,
    storage: {
      has: async (name: string) => name === SHARED_CACHE && map.size > 0,
      open: async () => cache,
      delete: async () => true,
    },
  };
}

const photo = (bytes: string, name: string) =>
  new Response(new Blob([bytes], { type: 'image/jpeg' }), {
    headers: { 'Content-Type': 'image/jpeg', 'X-File-Name': encodeURIComponent(name) },
  });

describe('sharedFiles', () => {
  it('returns nothing when nothing was shared', async () => {
    const { storage } = fakeCaches({});
    expect((await sharedFiles(storage)).files).toEqual([]);
    expect((await sharedFiles(undefined)).files).toEqual([]);
  });

  it('reads shared photos in order and removes them only when cleared', async () => {
    const base = 'https://x.test/doc-scanner/shared-files/';
    const { storage, map } = fakeCaches({
      [`${base}17-001`]: photo('b', 'Scan 2.jpg'),
      [`${base}17-000`]: photo('a', 'Scan 1.jpg'),
    });
    const shared = await sharedFiles(storage);
    expect(shared.files.map((f) => f.name)).toEqual(['Scan 1.jpg', 'Scan 2.jpg']);
    expect(shared.files[0].type).toBe('image/jpeg');
    expect(await shared.files[1].text()).toBe('b');
    expect(map.size).toBe(2);
    // A share that lands meanwhile is kept for next time.
    map.set(`${base}18-000`, photo('c', 'later.jpg'));
    await shared.clear();
    expect([...map.keys()]).toEqual([`${base}18-000`]);
  });
});

describe('isIos', () => {
  it('recognises iPhones and iPads that call themselves Macs', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
    expect(isIos('Mozilla/5.0 (Linux; Android 15; Pixel 9)', 5)).toBe(false);
  });
});
