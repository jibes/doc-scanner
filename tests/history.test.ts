import { describe, expect, it, vi } from 'vitest';
import type { TaskResult } from '../src/lib/paperless';
import type { HistoryEntry } from '../src/lib/store/db';

const { updateHistory } = vi.hoisted(() => ({
  updateHistory: vi.fn(async (entry: HistoryEntry) => void entry),
}));
vi.mock('../src/lib/store/db', () => ({
  addHistory: vi.fn(),
  deleteHistory: vi.fn(),
  loadHistory: vi.fn(),
  updateHistory,
}));

const { refreshPendingUploads } = await import('../src/lib/history');

const config = { baseUrl: 'https://paperless.example.com', token: 't', tagIds: [] };

function entry(id: string, extra: Partial<HistoryEntry>): HistoryEntry {
  return { id, title: id, createdAt: 0, kind: 'upload', pages: 1, bytes: 1, pdf: null, ...extra };
}

describe('refreshPendingUploads', () => {
  it('updates only pending uploads whose task has finished', async () => {
    const results: Record<string, TaskResult | Error> = {
      done: { outcome: 'success', message: null },
      dup: { outcome: 'duplicate', message: 'It is a duplicate of x (#1)' },
      bad: { outcome: 'failure', message: 'Broken' },
      wait: { outcome: 'pending', message: null },
      offline: new Error('Failed to fetch'),
    };
    const check = vi.fn(async (_config: unknown, taskId: string) => {
      const r = results[taskId];
      if (r instanceof Error) throw r;
      return r;
    });
    const entries = [
      entry('a', { outcome: 'pending', taskId: 'done' }),
      entry('b', { outcome: 'pending', taskId: 'dup' }),
      entry('c', { outcome: 'pending', taskId: 'bad' }),
      entry('d', { outcome: 'pending', taskId: 'wait' }),
      entry('e', { outcome: 'pending', taskId: 'offline' }),
      entry('f', { outcome: 'pending' }),
      entry('g', { outcome: 'success', taskId: 'done' }),
      entry('h', { kind: 'pdf' }),
    ];
    const changed = await refreshPendingUploads(config, entries, check);
    expect(changed.map((e) => [e.id, e.outcome])).toEqual([
      ['a', 'success'],
      ['b', 'success'],
      ['c', 'failure'],
    ]);
    expect(check).toHaveBeenCalledTimes(5);
    expect(updateHistory).toHaveBeenCalledTimes(3);
  });
});
