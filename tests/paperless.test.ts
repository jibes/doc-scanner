import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkTask,
  parseTaskId,
  pollTask,
  taskResult,
  TaskCheckError,
  uploadDocument,
  waitForTask,
} from '../src/lib/paperless';

const config = { baseUrl: 'https://paperless.example.com/', token: 'secret', tagIds: [3] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A virtual clock: sleeping advances it instead of waiting. */
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('parseTaskId', () => {
  it('accepts a JSON string or a bare id', () => {
    expect(parseTaskId('"0b6c-42"\n')).toBe('0b6c-42');
    expect(parseTaskId('0b6c-42')).toBe('0b6c-42');
  });

  it('rejects anything else', () => {
    expect(() => parseTaskId('{"task_id":"x"}')).toThrow(/no task id/);
    expect(() => parseTaskId('42')).toThrow(/no task id/);
    expect(() => parseTaskId('""')).toThrow(/no task id/);
    expect(() => parseTaskId('<html>oops</html>')).toThrow(/no task id/);
  });
});

describe('uploadDocument', () => {
  it('posts the file and returns the task id', async () => {
    const fetch = vi.fn(async () => new Response('"abc-1"'));
    vi.stubGlobal('fetch', fetch);
    const id = await uploadDocument(config, new Blob(['%PDF']), 'a.pdf', 'A');
    expect(id).toBe('abc-1');
    expect(fetch).toHaveBeenCalledWith(
      'https://paperless.example.com/api/documents/post_document/',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('mentions https and never shows credentials when the server is unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const legacy = { ...config, baseUrl: 'https://me:hunter2@paperless.example.com' };
    const error: unknown = await uploadDocument(legacy, new Blob(['%PDF']), 'a.pdf', 'A').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/https/);
    expect(message).toMatch(/mixed content/);
    expect(message).not.toMatch(/hunter2|me:/);
  });
});

describe('taskResult', () => {
  it('reads the task states', () => {
    expect(taskResult({ status: 'SUCCESS' }).outcome).toBe('success');
    expect(taskResult({ status: 'FAILURE', result: 'Bad PDF' })).toEqual({
      outcome: 'failure',
      message: 'Bad PDF',
    });
    expect(taskResult({ status: 'REVOKED' }).outcome).toBe('failure');
    expect(taskResult({ status: 'STARTED' }).outcome).toBe('pending');
    expect(taskResult({ status: 'SOMETHING_NEW' }).outcome).toBe('pending');
    expect(taskResult(undefined).outcome).toBe('pending');
  });

  it('tells duplicates apart from failures', () => {
    const result = taskResult({
      status: 'FAILURE',
      result: 'Not consuming a.pdf: It is a duplicate of Invoice (#12).',
    });
    expect(result.outcome).toBe('duplicate');
  });
});

describe('checkTask', () => {
  it('stops on missing permission or endpoint', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 403 }));
    await expect(checkTask(config, 't')).rejects.toBeInstanceOf(TaskCheckError);
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    await expect(checkTask(config, 't')).rejects.toBeInstanceOf(TaskCheckError);
  });
});

describe('pollTask', () => {
  it('retries network errors and bad JSON, backing off', async () => {
    const answers: (() => Response)[] = [
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => new Response('not json'),
      () => new Response('', { status: 502 }),
      () => json([]),
      () => json([{ task_id: 't', status: 'STARTED' }]),
      () => json([{ task_id: 't', status: 'SUCCESS' }]),
    ];
    vi.stubGlobal('fetch', async () => answers.shift()!());
    const c = clock();
    const result = await pollTask(config, 't', { sleep: c.sleep, now: c.now });
    expect(result.outcome).toBe('success');
    expect(c.sleeps[0]).toBe(2000);
    expect(c.sleeps.every((ms, i) => i === 0 || ms >= c.sleeps[i - 1])).toBe(true);
    expect(Math.max(...c.sleeps)).toBeLessThanOrEqual(10_000);
  });

  it('gives up as pending after the time limit', async () => {
    vi.stubGlobal('fetch', async () => json([{ task_id: 't', status: 'STARTED' }]));
    const c = clock();
    const result = await pollTask(config, 't', { sleep: c.sleep, now: c.now });
    expect(result.outcome).toBe('pending');
    expect(c.now()).toBeGreaterThanOrEqual(5 * 60_000);
    expect(c.sleeps.at(-1)).toBe(10_000);
  });

  it('stops at once when the token may not read tasks', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    const c = clock();
    await expect(pollTask(config, 't', { sleep: c.sleep, now: c.now })).rejects.toThrow(
      /permission/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores tasks other than its own', async () => {
    vi.stubGlobal('fetch', async () =>
      json([
        { task_id: 'other', status: 'FAILURE', result: 'Bad PDF' },
        { task_id: 't', status: 'SUCCESS' },
      ]),
    );
    expect((await checkTask(config, 't')).outcome).toBe('success');
  });

  it('reports a duplicate', async () => {
    vi.stubGlobal('fetch', async () =>
      json([
        {
          task_id: 't',
          status: 'FAILURE',
          result: 'Not consuming a.pdf: It is a duplicate of b (#3)',
        },
      ]),
    );
    const c = clock();
    const result = await pollTask(config, 't', { sleep: c.sleep, now: c.now });
    expect(result.outcome).toBe('duplicate');
  });
});

describe('waitForTask', () => {
  it('stores a duplicate as filed', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', async () =>
        json([{ task_id: 't', status: 'FAILURE', result: 'It is a duplicate of b (#3)' }]),
      );
      const promise = waitForTask(config, 't');
      await vi.advanceTimersByTimeAsync(2000);
      expect(await promise).toEqual({
        outcome: 'success',
        message: 'It is a duplicate of b (#3)',
        duplicate: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
