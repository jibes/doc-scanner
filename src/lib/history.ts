import { checkTask, storedOutcome, type TaskResult } from './paperless';
import type { AppSettings } from './settings';
import {
  addHistory,
  deleteHistory,
  loadHistory,
  updateHistory,
  type HistoryEntry,
} from './store/db';

export type { HistoryEntry };

/** Record a finished document; returns the entry so it can be updated later. */
/** Add an entry; it is saved in the background, so a slow store never holds up the caller. */
export function recordHistory(entry: Omit<HistoryEntry, 'id' | 'createdAt'>): HistoryEntry {
  const full: HistoryEntry = { ...entry, id: crypto.randomUUID(), createdAt: Date.now() };
  void addHistory(full);
  return full;
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

export { deleteHistory, loadHistory, updateHistory };
