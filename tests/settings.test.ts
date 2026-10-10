import { describe, expect, it } from 'vitest';
import { normalizeServerUrl } from '../src/lib/settings';

describe('normalizeServerUrl', () => {
  it('normalises https addresses', () => {
    expect(normalizeServerUrl('  https://Paperless.Example.com/  ')).toEqual({
      ok: true,
      url: 'https://paperless.example.com',
    });
    expect(normalizeServerUrl('https://example.com/paperless//')).toEqual({
      ok: true,
      url: 'https://example.com/paperless',
    });
    expect(normalizeServerUrl('https://example.com:8443')).toEqual({
      ok: true,
      url: 'https://example.com:8443',
    });
    expect(normalizeServerUrl('')).toEqual({ ok: true, url: '' });
  });

  it('allows plain http only on this device', () => {
    expect(normalizeServerUrl('http://localhost:8000/')).toEqual({
      ok: true,
      url: 'http://localhost:8000',
    });
    expect(normalizeServerUrl('http://127.0.0.1:8000').ok).toBe(true);
    expect(normalizeServerUrl('http://[::1]:8000').ok).toBe(false);
    const lan = normalizeServerUrl('http://192.168.1.5:8000');
    expect(lan.ok).toBe(false);
    expect(!lan.ok && lan.error).toMatch(/https/);
    expect(normalizeServerUrl('ftp://example.com').ok).toBe(false);
  });

  it('rejects credentials, queries and fragments without echoing them', () => {
    for (const raw of [
      'https://me:hunter2@example.com',
      'https://hunter2@example.com',
      'https://example.com/?token=hunter2',
      'https://example.com/#hunter2',
      'https://example.com/?',
      'example.com/hunter2',
    ]) {
      const result = normalizeServerUrl(raw);
      expect(result.ok, raw).toBe(false);
      expect(!result.ok && result.error).not.toMatch(/hunter2/);
    }
  });
});
