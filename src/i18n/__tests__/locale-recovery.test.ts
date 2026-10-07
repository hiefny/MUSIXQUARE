/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadLocaleRecovery } from '../locale-recovery.ts';
import ar, { pluralMessages } from '../ar.ts';

const url = '/assets/locale-recovery-ar-12345678.json';
const payload = () => ({
  version: 1,
  locale: 'ar',
  dictionary: { ...ar },
  pluralMessages: structuredClone(pluralMessages),
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('build-bound locale data recovery', () => {
  it('loads the complete dictionary and grammatical overrides together without module evaluation', async () => {
    vi.stubGlobal('__MXQR_LOCALE_RECOVERY_URLS__', { ar: url });
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload() });
    vi.stubGlobal('fetch', fetch);
    await expect(loadLocaleRecovery('ar')).resolves.toEqual({ default: ar, pluralMessages });
    expect(fetch).toHaveBeenCalledWith(url);
  });

  it('does not cache a network failure, so the same immutable URL remains retryable', async () => {
    vi.stubGlobal('__MXQR_LOCALE_RECOVERY_URLS__', { ar: url });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => payload() });
    vi.stubGlobal('fetch', fetch);
    await expect(loadLocaleRecovery('ar')).rejects.toThrow('503');
    await expect(loadLocaleRecovery('ar')).resolves.toMatchObject({ default: ar });
    expect(fetch.mock.calls).toEqual([[url], [url]]);
  });

  it.each(['locale', 'dictionary', 'plural'] as const)(
    'rejects inconsistent %s data before publishing any translation',
    async (invalid) => {
      vi.stubGlobal('__MXQR_LOCALE_RECOVERY_URLS__', { ar: url });
      const data = payload();
      if (invalid === 'locale') data.locale = 'ja';
      if (invalid === 'dictionary') Reflect.deleteProperty(data.dictionary, 'common.ok');
      if (invalid === 'plural') Object.assign(data.pluralMessages, { unknown: { one: 'text' } });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }));
      await expect(loadLocaleRecovery('ar')).rejects.toThrow();
    },
  );

  it('does not invent a stable latest-build URL when no asset belongs to this build', async () => {
    vi.stubGlobal('__MXQR_LOCALE_RECOVERY_URLS__', {});
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(loadLocaleRecovery('ar')).rejects.toThrow('unavailable');
    expect(fetch).not.toHaveBeenCalled();
  });
});
