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

const fontLoaders: Record<LocaleFontCode, FontCssLoader> = { ...DEFAULT_FONT_LOADERS };
const loadedFonts = new Set<LocaleFontCode>();
const inFlightFonts = new Map<LocaleFontCode, Promise<void>>();

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

/** Test-only loader injection keeps concurrency/completion caching observable. */
export function __setLocaleFontLoaderForTests(code: LocaleFontCode, loader: FontCssLoader): void {
  fontLoaders[code] = loader;
  loadedFonts.delete(code);
  inFlightFonts.delete(code);
}

export function __resetLocaleFontLoadingForTests(): void {
  loadedFonts.clear();
  inFlightFonts.clear();
  for (const code of Object.keys(DEFAULT_FONT_LOADERS) as LocaleFontCode[]) {
    fontLoaders[code] = DEFAULT_FONT_LOADERS[code];
  }
}
