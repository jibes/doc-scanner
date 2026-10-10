import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveFile } from '../src/lib/export';

const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0';

/** A phone browser whose share sheet ends with `outcome`; returns the share mock. */
function phone(outcome: string | null, extra: Record<string, unknown> = {}) {
  const share = vi.fn(() =>
    outcome ? Promise.reject(new DOMException('no', outcome)) : Promise.resolve(),
  );
  vi.stubGlobal('navigator', {
    userAgent: IPAD,
    maxTouchPoints: 5,
    canShare: () => true,
    share,
    ...extra,
  });
  const click = vi.fn();
  vi.stubGlobal('document', { createElement: () => ({ click }) });
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
  return { share, click };
}

afterEach(() => vi.unstubAllGlobals());

describe('saveFile', () => {
  it('shares on an iPad that reports itself as a Mac', async () => {
    const { share } = phone(null);
    expect(await saveFile(new Blob(['%PDF']), 'a.pdf')).toBe('shared');
    expect(share).toHaveBeenCalled();
  });

  it('does not count a closed share sheet as shared', async () => {
    phone('AbortError');
    expect(await saveFile(new Blob(['%PDF']), 'a.pdf', { deferShare: true })).toBe('cancelled');
  });

  it('asks for a fresh tap when the share sheet is refused', async () => {
    const { click } = phone('NotAllowedError');
    expect(await saveFile(new Blob(['%PDF']), 'a.pdf', { deferShare: true })).toBe('needs-tap');
    expect(click).not.toHaveBeenCalled();
  });

  it('does not try to share once the tap has expired', async () => {
    const { share } = phone(null, { userActivation: { isActive: false } });
    expect(await saveFile(new Blob(['%PDF']), 'a.pdf', { deferShare: true })).toBe('needs-tap');
    expect(share).not.toHaveBeenCalled();
  });

  it('downloads instead when a fresh tap is not possible', async () => {
    const { click } = phone('NotAllowedError');
    expect(await saveFile(new Blob(['%PDF']), 'a.pdf')).toBe('downloaded');
    expect(click).toHaveBeenCalled();
  });
});
