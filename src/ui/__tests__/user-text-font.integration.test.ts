/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLocaleFontLoadingForTests,
  __setLocaleFontLoaderForTests,
  isLocaleFontLoadedForTests,
  loadLocaleFontForTests as loadLocaleFont,
} from '../../i18n/locale-fonts.ts';
import { applyUserTextFontFallback } from '../user-text-font.ts';

afterEach(async () => {
  await vi.dynamicImportSettled();
  __resetLocaleFontLoadingForTests();
  document.documentElement.lang = '';
});

describe('user-text and UI-locale font loading integration', () => {
  it('deduplicates a locale load and a simultaneous user-text load', async () => {
    let resolveLoad!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    const loader = vi.fn(() => pending);
    __setLocaleFontLoaderForTests('ja', loader);

    const localeLoad = loadLocaleFont('ja');
    const element = document.createElement('span');
    applyUserTextFontFallback(element, 'かな');

    try {
      // The user-text path imports the shared runtime before requesting glyphs.
      // Keep the locale request pending until that second producer has entered.
      await vi.dynamicImportSettled();
      expect(loader).toHaveBeenCalledTimes(1);
    } finally {
      resolveLoad();
      await localeLoad;
    }
  });

  it.each(['ko', 'en'])(
    'detects user scripts independently of the %s UI locale',
    async (locale) => {
      const loader = vi.fn(async () => undefined);
      __setLocaleFontLoaderForTests('ru', loader);
      document.documentElement.lang = locale;
      const element = document.createElement('span');

      applyUserTextFontFallback(element, 'Привет');

      expect(document.documentElement.lang).toBe(locale);
      expect(element.classList).toContain('user-text-font-ru');
      await vi.dynamicImportSettled();
      expect(loader).toHaveBeenCalledTimes(1);
    },
  );

  it('marks text synchronously and remains non-blocking when a font chunk fails', async () => {
    const loader = vi.fn(async () => Promise.reject(new Error('offline')));
    __setLocaleFontLoaderForTests('th', loader);
    const element = document.createElement('span');

    expect(() => applyUserTextFontFallback(element, 'สวัสดี')).not.toThrow();
    expect(element.classList).toContain('user-text-font-th');
    await vi.dynamicImportSettled();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(isLocaleFontLoadedForTests('th')).toBe(false);
  });
});
