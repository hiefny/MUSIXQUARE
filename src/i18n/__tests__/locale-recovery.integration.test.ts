/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ja from '../ja.ts';

const url = '/assets/locale-recovery-ja-12345678.json';
const body = () => ({ version: 1, locale: 'ja', dictionary: ja, pluralMessages: {} });
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.body.replaceWith(document.createElement('body'));
  document.body.innerHTML = '<button data-i18n="setup.host_button"></button>';
  localStorage.setItem('musixquare-lang', 'ja');
  vi.stubGlobal('__MXQR_LOCALE_RECOVERY_URLS__', { ja: url });
  // Unlike a recoverable module mock, this models the document's permanently
  // rejected ESM URL. Only the independent data request can restore Japanese.
  vi.doMock('../ja.ts', () => {
    throw new Error('document module map failure');
  });
});
afterEach(() => {
  vi.doUnmock('../ja.ts');
  vi.unstubAllGlobals();
});

describe('locale recovery after a cached module failure', () => {
  it('recovers on online with one data fetch and keeps later healthy events silent', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body() });
    vi.stubGlobal('fetch', fetch);
    const { initI18n, t } = await import('../index.ts');
    await initI18n();
    expect(document.documentElement.lang).toBe('en');
    expect(fetch).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(t('setup.host_button')).toBe(ja['setup.host_button']));
    expect(document.documentElement.lang).toBe('ja');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(url);
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps data failures retryable and deduplicates concurrent user re-selections', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValue({ ok: true, json: async () => body() });
    vi.stubGlobal('fetch', fetch);
    const { initI18n, setLanguageMode, t } = await import('../index.ts');
    await initI18n();
    setLanguageMode('ja');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.documentElement.lang).toBe('en');
    setLanguageMode('ja');
    setLanguageMode('ja');
    await vi.waitFor(() => expect(t('setup.host_button')).toBe(ja['setup.host_button']));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not let an old recovery response overwrite a newer language choice', async () => {
    let release!: (value: unknown) => void;
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const { initI18n, setLanguageMode, t } = await import('../index.ts');
    await initI18n();
    setLanguageMode('ja');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    setLanguageMode('en');
    release({ ok: true, json: async () => body() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.documentElement.lang).toBe('en');
    expect(t('setup.host_button')).toBe('Create a Room');
    setLanguageMode('ja');
    await vi.waitFor(() => expect(document.documentElement.lang).toBe('ja'));
    expect(fetch).toHaveBeenCalledOnce();
  });
});
