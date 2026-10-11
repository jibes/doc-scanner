import type { FilterId } from './imaging/filters';
import { importNote, importPhotos } from './importPhotos';
import { detector } from './services';
import { session } from './store/session.svelte';
import { busy, idle, toast } from './ui.svelte';

/**
 * Photos shared to the installed app from another app (Android share sheet).
 * The service worker add-on public/share-target.js receives them, keeps them
 * in this cache and opens the app with `?shared=<count>`.
 */
export const SHARED_CACHE = 'shared-files';
const FLAG = 'shared';

interface CacheStorageLike {
  has(name: string): Promise<boolean>;
  open(name: string): Promise<Cache>;
  delete(name: string): Promise<boolean>;
}

/** Drop the share flag from the address so a reload does not repeat it. */
export function clearShareFlag(): void {
  const url = new URL(location.href);
  if (!url.searchParams.has(FLAG)) return;
  url.searchParams.delete(FLAG);
  history.replaceState(history.state, '', url);
}

/**
 * The shared photos waiting in the cache, oldest first. Looked for on every
 * start, so photos shared while the app could not finish starting are not
 * lost. Call `clear` once they are safely in the document.
 */
export async function sharedFiles(
  storage: CacheStorageLike | undefined = globalThis.caches,
): Promise<{ files: File[]; clear: () => Promise<void> }> {
  const none = { files: [], clear: async () => undefined };
  if (!storage || !(await storage.has(SHARED_CACHE))) return none;
  const cache = await storage.open(SHARED_CACHE);
  const requests = [...(await cache.keys())].sort((a, b) => a.url.localeCompare(b.url));
  const files: File[] = [];
  for (const request of requests) {
    const response = await cache.match(request);
    if (!response) continue;
    const blob = await response.blob();
    const name = decodeURIComponent(response.headers.get('X-File-Name') ?? 'shared');
    files.push(new File([blob], name, { type: blob.type || 'image/jpeg' }));
  }
  return {
    files,
    clear: async () => {
      // Only what was read: a share arriving meanwhile stays for next time.
      for (const request of requests) await cache.delete(request);
    },
  };
}

/** Add photos shared to the app as pages, with progress and a summary. */
export async function importShared(
  shared: { files: File[]; clear: () => Promise<void> },
  filter: FilterId,
): Promise<void> {
  const total = shared.files.length;
  const label = `Adding ${total} shared ${total === 1 ? 'photo' : 'photos'}…`;
  busy(label, 0);
  try {
    const summary = await importPhotos(detector(), shared.files, {
      filter,
      onProgress: (done) => busy(label, done / total),
    });
    // Saved before the copies in the cache go.
    session.flush();
    await shared.clear();
    const note = importNote(summary);
    if (note) toast(note.message, note.kind);
    else toast(`${summary.added} ${summary.added === 1 ? 'page' : 'pages'} added`, 'good');
  } finally {
    idle();
  }
}
