/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLocaleFontLoadingForTests,
  __setLocaleFontLoaderForTests,
  isLocaleFontLoadedForTests,
  loadLocaleFont,
  preloadLocaleFontGlyphs,
} from '../locale-fonts.ts';

afterEach(() => {
  __resetLocaleFontLoadingForTests();
  Reflect.deleteProperty(document, 'fonts');
});

describe('locale font CSS loading', () => {
  it('deduplicates concurrent and completed shard loads', async () => {
    let resolveLoad!: () => void;
    const loader = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    __setLocaleFontLoaderForTests('ja', loader);

    const first = loadLocaleFont('ja');
    const concurrent = loadLocaleFont('ja');
    expect(concurrent).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);

    resolveLoad();
    await first;
    expect(isLocaleFontLoadedForTests('ja')).toBe(true);

    await loadLocaleFont('ja');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('allows a later render to retry a failed shard load', async () => {
    const loader = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary chunk failure'))
      .mockResolvedValueOnce();
    __setLocaleFontLoaderForTests('th', loader);

    await loadLocaleFont('th');
    expect(isLocaleFontLoadedForTests('th')).toBe(false);
    await loadLocaleFont('th');

    expect(loader).toHaveBeenCalledTimes(2);
    expect(isLocaleFontLoadedForTests('th')).toBe(true);
  });
});

describe('locale font glyph preloading', () => {
  function installFontSet() {
    const load = vi.fn(() => Promise.resolve([{} as FontFace]));
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load },
    });
    return load;
  }

  it('waits for CSS registration before requesting the exact glyph sample', async () => {
    let resolveCss!: () => void;
    const cssLoader = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCss = resolve;
        }),
    );
    const glyphLoader = installFontSet();
    __setLocaleFontLoaderForTests('ja', cssLoader);

    const preload = preloadLocaleFontGlyphs('ja', '日本語');
    expect(glyphLoader).not.toHaveBeenCalled();

    resolveCss();
    await expect(preload).resolves.toBe(true);

    expect(glyphLoader).toHaveBeenCalledOnce();
    expect(glyphLoader).toHaveBeenCalledWith('750 15px "Noto Sans JP"', '日本語');
  });

  it.each([
    ['ru', 'Русский', '750 15px "Noto Sans"'],
    ['th', 'ไทย', '750 15px "Noto Sans Thai"'],
    ['zh-hans', '简体中文', '750 15px "Noto Sans SC"'],
    ['zh-hant', '繁體中文', '750 15px "Noto Sans TC"'],
  ] as const)('uses the matching %s family', async (code, sample, font) => {
    const glyphLoader = installFontSet();
    __setLocaleFontLoaderForTests(code, vi.fn(() => Promise.resolve()));

    await expect(preloadLocaleFontGlyphs(code, sample)).resolves.toBe(true);

    expect(glyphLoader).toHaveBeenCalledWith(font, sample);
  });

  it('deduplicates concurrent and completed glyph requests', async () => {
    let resolveGlyphs!: (faces: FontFace[]) => void;
    const glyphLoader = vi.fn(
      () =>
        new Promise<FontFace[]>((resolve) => {
          resolveGlyphs = resolve;
        }),
    );
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { load: glyphLoader },
    });
    const cssLoader = vi.fn(() => Promise.resolve());
    __setLocaleFontLoaderForTests('ru', cssLoader);

    const first = preloadLocaleFontGlyphs('ru', 'Русский');
    const concurrent = preloadLocaleFontGlyphs('ru', 'Русский');
    expect(concurrent).toBe(first);

    await vi.waitFor(() => {
      expect(cssLoader).toHaveBeenCalledOnce();
      expect(glyphLoader).toHaveBeenCalledOnce();
    });

    resolveGlyphs([{} as FontFace]);
    await expect(first).resolves.toBe(true);
    await expect(preloadLocaleFontGlyphs('ru', 'Русский')).resolves.toBe(true);

    expect(cssLoader).toHaveBeenCalledOnce();
    expect(glyphLoader).toHaveBeenCalledOnce();
  });

  it('keeps CSS and glyph failures retryable without rejecting the caller', async () => {
    const cssLoader = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary CSS failure'))
      .mockResolvedValue();
    const glyphLoader = installFontSet()
      .mockRejectedValueOnce(new Error('temporary glyph failure'))
      .mockResolvedValueOnce([{} as FontFace]);
    __setLocaleFontLoaderForTests('th', cssLoader);

    await expect(preloadLocaleFontGlyphs('th', 'ไทย')).resolves.toBe(false);
    expect(glyphLoader).not.toHaveBeenCalled();

    await expect(preloadLocaleFontGlyphs('th', 'ไทย')).resolves.toBe(false);
    expect(glyphLoader).toHaveBeenCalledOnce();

    await expect(preloadLocaleFontGlyphs('th', 'ไทย')).resolves.toBe(true);
    expect(cssLoader).toHaveBeenCalledTimes(2);
    expect(glyphLoader).toHaveBeenCalledTimes(2);
  });

  it('retries when the browser reports no matching font faces', async () => {
    const glyphLoader = installFontSet()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{} as FontFace]);
    __setLocaleFontLoaderForTests('ru', vi.fn(() => Promise.resolve()));

    await expect(preloadLocaleFontGlyphs('ru', 'Русский')).resolves.toBe(false);
    await expect(preloadLocaleFontGlyphs('ru', 'Русский')).resolves.toBe(true);

    expect(glyphLoader).toHaveBeenCalledTimes(2);
  });

  it('falls back to natural rendering when the Font Loading API is unavailable', async () => {
    const cssLoader = vi.fn(() => Promise.resolve());
    __setLocaleFontLoaderForTests('ja', cssLoader);

    await expect(preloadLocaleFontGlyphs('ja', '日本語')).resolves.toBe(true);
    await expect(preloadLocaleFontGlyphs('ja', '日本語')).resolves.toBe(true);

    expect(cssLoader).toHaveBeenCalledOnce();
  });
});
