/**
 * Lazy, self-hosted locale font CSS loader shared by UI-language changes and
 * script-aware user text. Importing this module does not fetch a font shard;
 * each CSS chunk remains behind its dynamic import until it is needed.
 */

import { log } from '../core/log.ts';

export type LocaleFontCode =
  | 'ar'
  | 'bn'
  | 'bg'
  | 'el'
  | 'fa'
  | 'gu'
  | 'he'
  | 'hi'
  | 'ja'
  | 'kn'
  | 'ml'
  | 'mr'
  | 'pa'
  | 'ru'
  | 'ta'
  | 'te'
  | 'th'
  | 'uk'
  | 'ur'
  | 'zh-hans'
  | 'zh-hant';
type FontCssLoader = () => Promise<unknown>;

const DEFAULT_FONT_LOADERS: Record<LocaleFontCode, FontCssLoader> = {
  ar: () => import('../../css/fonts/noto-arabic.css'),
  bn: () => import('../../css/fonts/noto-bengali.css'),
  bg: () => import('../../css/fonts/noto-cyrillic.css'),
  el: () => import('../../css/fonts/noto-greek.css'),
  fa: () => import('../../css/fonts/noto-arabic.css'),
  gu: () => import('../../css/fonts/noto-gujarati.css'),
  he: () => import('../../css/fonts/noto-hebrew.css'),
  hi: () => import('../../css/fonts/noto-devanagari.css'),
  ja: () => import('../../css/fonts/noto-jp.css'),
  kn: () => import('../../css/fonts/noto-kannada.css'),
  ml: () => import('../../css/fonts/noto-malayalam.css'),
  mr: () => import('../../css/fonts/noto-devanagari.css'),
  pa: () => import('../../css/fonts/noto-gurmukhi.css'),
  ru: () => import('../../css/fonts/noto-cyrillic.css'),
  ta: () => import('../../css/fonts/noto-tamil.css'),
  te: () => import('../../css/fonts/noto-telugu.css'),
  th: () => import('../../css/fonts/noto-thai.css'),
  uk: () => import('../../css/fonts/noto-cyrillic.css'),
  ur: () => import('../../css/fonts/noto-arabic.css'),
  'zh-hans': () => import('../../css/fonts/noto-sc.css'),
  'zh-hant': () => import('../../css/fonts/noto-tc.css'),
};

const FONT_FAMILIES: Record<LocaleFontCode, string> = {
  ar: 'Noto Sans Arabic',
  bn: 'Noto Sans Bengali',
  bg: 'Noto Sans',
  el: 'Noto Sans',
  fa: 'Noto Sans Arabic',
  gu: 'Noto Sans Gujarati',
  he: 'Noto Sans Hebrew',
  hi: 'Noto Sans Devanagari',
  ja: 'Noto Sans JP',
  kn: 'Noto Sans Kannada',
  ml: 'Noto Sans Malayalam',
  mr: 'Noto Sans Devanagari',
  pa: 'Noto Sans Gurmukhi',
  ru: 'Noto Sans',
  ta: 'Noto Sans Tamil',
  te: 'Noto Sans Telugu',
  th: 'Noto Sans Thai',
  uk: 'Noto Sans',
  ur: 'Noto Sans Arabic',
  'zh-hans': 'Noto Sans SC',
  'zh-hant': 'Noto Sans TC',
};

const fontLoaders: Record<LocaleFontCode, FontCssLoader> = { ...DEFAULT_FONT_LOADERS };
const loadedFonts = new Set<LocaleFontCode>();
const inFlightFonts = new Map<LocaleFontCode, Promise<void>>();
const loadedGlyphCharacters = new Map<LocaleFontCode, Set<string>>();
const inFlightGlyphCharacters = new Map<LocaleFontCode, Map<string, Promise<boolean>>>();
const inFlightGlyphSamples = new Map<string, Promise<boolean>>();
const MAX_TRACKED_GLYPH_CHARACTERS_PER_FONT = 4_096;

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
  const existing = inFlightGlyphSamples.get(cacheKey);
  if (existing) return existing;

  const loaded = loadedGlyphCharacters.get(code) ?? new Set<string>();
  if (!loadedGlyphCharacters.has(code)) loadedGlyphCharacters.set(code, loaded);
  const characterTasks = inFlightGlyphCharacters.get(code) ?? new Map<string, Promise<boolean>>();
  if (!inFlightGlyphCharacters.has(code)) inFlightGlyphCharacters.set(code, characterTasks);

  const uniqueCharacters = [
    ...new Set(Array.from(sample).filter((character) => !/\s/u.test(character))),
  ];
  const sharedTasks = new Set<Promise<boolean>>();
  const freshCharacters: string[] = [];
  for (const character of uniqueCharacters) {
    if (loaded.has(character)) continue;
    const characterTask = characterTasks.get(character);
    if (characterTask) sharedTasks.add(characterTask);
    else freshCharacters.push(character);
  }

  if (freshCharacters.length > 0) {
    const freshSample = freshCharacters.join('');
    const freshTask = loadLocaleFont(code)
      .then(async () => {
        // loadLocaleFont deliberately resolves after a failed CSS request so UI
        // rendering is never blocked. Keep these characters retryable then.
        if (!loadedFonts.has(code)) return false;

        const fontSet = typeof document === 'undefined' ? undefined : document.fonts;
        if (fontSet && typeof fontSet.load === 'function') {
          const faces = await fontSet.load(`750 15px "${FONT_FAMILIES[code]}"`, freshSample);
          if (faces.length === 0) return false;
        }

        // Older browsers fetch the shard naturally once text renders. Track
        // code points, not whole input prefixes/messages, so typing and chat
        // rendering cannot create an unbounded full-string cache.
        for (const character of freshCharacters) {
          loaded.delete(character);
          loaded.add(character);
          while (loaded.size > MAX_TRACKED_GLYPH_CHARACTERS_PER_FONT) {
            const oldest = loaded.values().next().value;
            if (oldest === undefined) break;
            loaded.delete(oldest);
          }
        }
        return true;
      })
      .catch((error) => {
        // Glyph warming is opportunistic and must never delay or reject a
        // render. Do not cache failures so a later boundary can retry.
        log.warn(`[i18n] Failed to preload font glyphs for "${code}"`, error);
        return false;
      })
      .finally(() => {
        for (const character of freshCharacters) {
          if (characterTasks.get(character) === freshTask) characterTasks.delete(character);
        }
      });
    for (const character of freshCharacters) characterTasks.set(character, freshTask);
    sharedTasks.add(freshTask);
  }

  const pending =
    sharedTasks.size === 0
      ? Promise.resolve(true)
      : Promise.all([...sharedTasks]).then((results) => results.every(Boolean));
  const tracked = pending.finally(() => {
    if (inFlightGlyphSamples.get(cacheKey) === tracked) inFlightGlyphSamples.delete(cacheKey);
  });

  inFlightGlyphSamples.set(cacheKey, tracked);
  return tracked;
}

/** Test-only loader injection keeps concurrency/completion caching observable. */
export function __setLocaleFontLoaderForTests(code: LocaleFontCode, loader: FontCssLoader): void {
  fontLoaders[code] = loader;
  loadedFonts.delete(code);
  inFlightFonts.delete(code);
  loadedGlyphCharacters.delete(code);
  inFlightGlyphCharacters.delete(code);
  for (const cacheKey of inFlightGlyphSamples.keys()) {
    if (cacheKey.startsWith(`${code}\u0000`)) inFlightGlyphSamples.delete(cacheKey);
  }
}

export function __resetLocaleFontLoadingForTests(): void {
  loadedFonts.clear();
  inFlightFonts.clear();
  loadedGlyphCharacters.clear();
  inFlightGlyphCharacters.clear();
  inFlightGlyphSamples.clear();
  for (const code of Object.keys(DEFAULT_FONT_LOADERS) as LocaleFontCode[]) {
    fontLoaders[code] = DEFAULT_FONT_LOADERS[code];
  }
}
