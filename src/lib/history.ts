import {
  addHistory,
  deleteHistory,
  loadHistory,
  updateHistory,
  type HistoryEntry,
} from './store/db';

export type { HistoryEntry };

/** Record a finished document; returns the entry so it can be updated later. */
export async function recordHistory(
  entry: Omit<HistoryEntry, 'id' | 'createdAt'>,
): Promise<HistoryEntry> {
  const full: HistoryEntry = { ...entry, id: crypto.randomUUID(), createdAt: Date.now() };
  await addHistory(full);
  return full;
}

export { deleteHistory, loadHistory, updateHistory };
