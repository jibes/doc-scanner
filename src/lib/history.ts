import { checkTask, storedOutcome, type TaskResult } from './paperless';
import type { AppSettings } from './settings';
import {
  addHistory,
  deleteDocument,
  deleteHistory,
  loadDocument,
  loadHistory,
  pruneDocuments,
  saveDocument,
  storedDocumentIds,
  updateHistory,
  type HistoryEntry,
} from './store/db';
import type { Page } from './store/session.svelte';

export type { HistoryEntry };

/**
 * Record a finished document; returns the entry so it can be updated later.
 * It is saved in the background, so a slow store never holds up the caller.
 * With `pages`, their photos and edits are kept too (for the most recent
 * documents only), so the document can be edited again.
 */
export function recordHistory(
  entry: Omit<HistoryEntry, 'id' | 'createdAt'>,
  pages?: readonly Page[],
): HistoryEntry {
  const full: HistoryEntry = { ...entry, id: crypto.randomUUID(), createdAt: Date.now() };
  void addHistory(full);
  if (pages?.length) void keepPages(full, pages);
  return full;
}

/** Store the pages a history entry was made from. Returns whether they were kept. */
export function keepPages(entry: HistoryEntry, pages: readonly Page[]): Promise<boolean> {
  return saveDocument({
    id: entry.id,
    createdAt: entry.createdAt,
    title: entry.title,
    bytes: pages.reduce((sum, p) => sum + p.source.size, 0),
    pages: pages.map((p, order) => ({
      id: p.id,
      order,
      source: p.source,
      width: p.width,
      height: p.height,
      spec: p.spec,
      detected: p.detected,
      sharpness: p.sharpness,
    })),
  });
}

/** The pages kept for a history entry, ready to open as the document; null if none are kept. */
export async function keptPages(id: string): Promise<Omit<Page, 'id'>[] | null> {
  const doc = await loadDocument(id);
  if (!doc) return null;
  return [...doc.pages]
    .sort((a, b) => a.order - b.order)
    .map((p) => ({
      source: p.source,
      width: p.width,
      height: p.height,
      spec: p.spec,
      detected: p.detected,
      sharpness: p.sharpness ?? null,
    }));
}

/**
 * Ask Paperless once more about uploads that were still processing when the
 * app stopped waiting. Returns (and stores) only the entries that changed;
 * anything that cannot be checked right now stays pending.
 */
export async function refreshPendingUploads(
  config: AppSettings['paperless'],
  entries: readonly HistoryEntry[],
  check: (config: AppSettings['paperless'], taskId: string) => Promise<TaskResult> = checkTask,
): Promise<HistoryEntry[]> {
  const pending = entries.filter((e) => e.kind === 'upload' && e.outcome === 'pending' && e.taskId);
  const changed = await Promise.all(
    pending.map(async (entry) => {
      try {
        const result = await check(config, entry.taskId!);
        if (result.outcome === 'pending') return null;
        const updated: HistoryEntry = { ...entry, outcome: storedOutcome(result.outcome) };
        await updateHistory(updated, { onlyIfPresent: true });
        return updated;
      } catch {
        return null;
      }
    }),
  );
  return changed.filter((e): e is HistoryEntry => e !== null);
}

export {
  deleteDocument as forgetPages,
  deleteHistory,
  loadHistory,
  pruneDocuments,
  storedDocumentIds,
  updateHistory,
};
