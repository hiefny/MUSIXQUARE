/**
 * Lazy, self-hosted locale font CSS loader shared by UI-language changes and
 * script-aware user text. Importing this module does not fetch a font shard;
 * each CSS chunk remains behind its dynamic import until it is needed.
 */

import { log } from '../core/log.ts';

export type LocaleFontCode = 'ja' | 'ru' | 'th' | 'zh-hans' | 'zh-hant';
type FontCssLoader = () => Promise<unknown>;

const DEFAULT_FONT_LOADERS: Record<LocaleFontCode, FontCssLoader> = {
  ja: () => import('../../css/fonts/noto-jp.css'),
  ru: () => import('../../css/fonts/noto-cyrillic.css'),
  th: () => import('../../css/fonts/noto-thai.css'),
  'zh-hans': () => import('../../css/fonts/noto-sc.css'),
  'zh-hant': () => import('../../css/fonts/noto-tc.css'),
};

const FONT_FAMILIES: Record<LocaleFontCode, string> = {
  ja: 'Noto Sans JP',
  ru: 'Noto Sans',
  th: 'Noto Sans Thai',
  'zh-hans': 'Noto Sans SC',
  'zh-hant': 'Noto Sans TC',
};

const fontLoaders: Record<LocaleFontCode, FontCssLoader> = { ...DEFAULT_FONT_LOADERS };
const loadedFonts = new Set<LocaleFontCode>();
const inFlightFonts = new Map<LocaleFontCode, Promise<void>>();
const loadedGlyphSamples = new Set<string>();
const inFlightGlyphSamples = new Map<string, Promise<boolean>>();

export function hasLocaleFont(code: string): code is LocaleFontCode {
  return Object.prototype.hasOwnProperty.call(DEFAULT_FONT_LOADERS, code);
}

export function isLocaleFontLoadedForTests(code: LocaleFontCode): boolean {
  return loadedFonts.has(code);
}

/**
 * Resolve after the requested stylesheet is available. Concurrent callers
 * share one promise; successful loads remain cached explicitly. A failed load
 * is not cached, so a later render can retry after a transient chunk failure.
 */
export function loadLocaleFont(code: LocaleFontCode): Promise<void> {
  if (loadedFonts.has(code)) return Promise.resolve();
  const existing = inFlightFonts.get(code);
  if (existing) return existing;

  const pending = fontLoaders[code]()
    .then(() => {
      loadedFonts.add(code);
    })
    .catch((error) => {
      log.warn(`[i18n] Failed to load font CSS for "${code}"`, error);
    })
    .finally(() => {
      inFlightFonts.delete(code);
    });
  inFlightFonts.set(code, pending);
  return pending;
}

/**
 * Load only the unicode-range shards needed to render a known piece of text.
 * Importing a font stylesheet merely registers its @font-face rules; hidden
 * UI does not ask the browser for the matching WOFF2 shard. FontFaceSet.load()
 * performs that final glyph request without making the caller wait to render.
 */
export function preloadLocaleFontGlyphs(code: LocaleFontCode, text: string): Promise<boolean> {
  const sample = text.trim();
  if (!sample) return loadLocaleFont(code).then(() => loadedFonts.has(code));

  const cacheKey = `${code}\u0000${sample}`;
  if (loadedGlyphSamples.has(cacheKey)) return Promise.resolve(true);
  const existing = inFlightGlyphSamples.get(cacheKey);
  if (existing) return existing;

  const pending = loadLocaleFont(code)
    .then(async () => {
      // loadLocaleFont deliberately resolves after a failed CSS request so UI
      // rendering is never blocked. Keep this sample retryable in that case.
      if (!loadedFonts.has(code)) return false;

      const fontSet = typeof document === 'undefined' ? undefined : document.fonts;
      if (!fontSet || typeof fontSet.load !== 'function') {
        // Older browsers still fetch the shard naturally once the text renders.
        loadedGlyphSamples.add(cacheKey);
        return true;
      }

      const faces = await fontSet.load(`750 15px "${FONT_FAMILIES[code]}"`, sample);
      if (faces.length === 0) return false;
      loadedGlyphSamples.add(cacheKey);
      return true;
    })
    .catch((error) => {
      // Glyph warming is opportunistic and must never delay or reject a dialog
      // interaction. Do not cache failures so a later focus/open can retry.
      log.warn(`[i18n] Failed to preload font glyphs for "${code}"`, error);
      return false;
    })
    .finally(() => {
      inFlightGlyphSamples.delete(cacheKey);
    });

  inFlightGlyphSamples.set(cacheKey, pending);
  return pending;
}

/** Test-only loader injection keeps concurrency/completion caching observable. */
export function __setLocaleFontLoaderForTests(code: LocaleFontCode, loader: FontCssLoader): void {
  fontLoaders[code] = loader;
  loadedFonts.delete(code);
  inFlightFonts.delete(code);
  for (const cacheKey of loadedGlyphSamples) {
    if (cacheKey.startsWith(`${code}\u0000`)) loadedGlyphSamples.delete(cacheKey);
  }
  for (const cacheKey of inFlightGlyphSamples.keys()) {
    if (cacheKey.startsWith(`${code}\u0000`)) inFlightGlyphSamples.delete(cacheKey);
  }
}

export function __resetLocaleFontLoadingForTests(): void {
  loadedFonts.clear();
  inFlightFonts.clear();
  loadedGlyphSamples.clear();
  inFlightGlyphSamples.clear();
  for (const code of Object.keys(DEFAULT_FONT_LOADERS) as LocaleFontCode[]) {
    fontLoaders[code] = DEFAULT_FONT_LOADERS[code];
  }
}
