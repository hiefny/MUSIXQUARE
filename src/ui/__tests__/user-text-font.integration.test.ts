/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLocaleFontLoadingForTests,
  __setLocaleFontLoaderForTests,
  loadLocaleFontForTests as loadLocaleFont,
} from '../../i18n/locale-fonts.ts';
import { applyUserTextFontFallback } from '../user-text-font.ts';

afterEach(() => {
  __resetLocaleFontLoadingForTests();
  document.documentElement.lang = '';
});

describe('user-text and UI-locale font loading integration', () => {
  it('deduplicates a locale load and a simultaneous user-text load', async () => {
    let resolveLoad!: () => void;
    const loader = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    __setLocaleFontLoaderForTests('ja', loader);

    const localeLoad = loadLocaleFont('ja');
    const element = document.createElement('span');
    applyUserTextFontFallback(element, 'かな');

    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    resolveLoad();
    await localeLoad;
  });

  it.each(['ko', 'en'])('detects user scripts independently of the %s UI locale', (locale) => {
    __setLocaleFontLoaderForTests(
      'ru',
      vi.fn(async () => undefined),
    );
    document.documentElement.lang = locale;
    const element = document.createElement('span');

    applyUserTextFontFallback(element, 'Привет');

    expect(document.documentElement.lang).toBe(locale);
    expect(element.classList).toContain('user-text-font-ru');
  });

  it('marks text synchronously and remains non-blocking when a font chunk fails', async () => {
    __setLocaleFontLoaderForTests(
      'th',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    const element = document.createElement('span');

    expect(() => applyUserTextFontFallback(element, 'สวัสดี')).not.toThrow();
    expect(element.classList).toContain('user-text-font-th');
    await Promise.resolve();
  });
});
