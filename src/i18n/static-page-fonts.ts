/**
 * Lazy locale font loader for the static pages that link the original Google
 * sheets in css/fonts/ (the sitemap page loads a language's sheet when its name
 * scrolls into view). The app loads its own sheets through locale-fonts.ts.
 *
 * Its dynamic imports also keep the processed copy of each of the 16 original
 * sheets in the build, which bindStaticLocaleFontAssets in vite.config.ts binds
 * About's disabled links to. Importing this module does not fetch a font shard;
 * each CSS chunk remains behind its dynamic import until it is needed.
 */

import { log } from '../core/log.ts';
import { createRetryableStylesheet } from './retryable-stylesheet.ts';
import type { LocaleFontCode } from './locale-font-contract.ts';

type FontCssLoader = () => Promise<unknown>;

const FONT_SHEETS = {
  arabic: createRetryableStylesheet('noto-arabic', () => import('../../css/fonts/noto-arabic.css')),
  bengali: createRetryableStylesheet(
    'noto-bengali',
    () => import('../../css/fonts/noto-bengali.css'),
  ),
  cyrillic: createRetryableStylesheet(
    'noto-cyrillic',
    () => import('../../css/fonts/noto-cyrillic.css'),
  ),
  devanagari: createRetryableStylesheet(
    'noto-devanagari',
    () => import('../../css/fonts/noto-devanagari.css'),
  ),
  greek: createRetryableStylesheet('noto-greek', () => import('../../css/fonts/noto-greek.css')),
  gujarati: createRetryableStylesheet(
    'noto-gujarati',
    () => import('../../css/fonts/noto-gujarati.css'),
  ),
  gurmukhi: createRetryableStylesheet(
    'noto-gurmukhi',
    () => import('../../css/fonts/noto-gurmukhi.css'),
  ),
  hebrew: createRetryableStylesheet('noto-hebrew', () => import('../../css/fonts/noto-hebrew.css')),
  japanese: createRetryableStylesheet('noto-jp', () => import('../../css/fonts/noto-jp.css')),
  kannada: createRetryableStylesheet(
    'noto-kannada',
    () => import('../../css/fonts/noto-kannada.css'),
  ),
  malayalam: createRetryableStylesheet(
    'noto-malayalam',
    () => import('../../css/fonts/noto-malayalam.css'),
  ),
  simplifiedChinese: createRetryableStylesheet(
    'noto-sc',
    () => import('../../css/fonts/noto-sc.css'),
  ),
  tamil: createRetryableStylesheet('noto-tamil', () => import('../../css/fonts/noto-tamil.css')),
  telugu: createRetryableStylesheet('noto-telugu', () => import('../../css/fonts/noto-telugu.css')),
  thai: createRetryableStylesheet('noto-thai', () => import('../../css/fonts/noto-thai.css')),
  traditionalChinese: createRetryableStylesheet(
    'noto-tc',
    () => import('../../css/fonts/noto-tc.css'),
  ),
} as const satisfies Readonly<Record<string, FontCssLoader>>;

const FONT_SHEET_BY_LOCALE: Readonly<Record<LocaleFontCode, FontCssLoader>> = {
  ar: FONT_SHEETS.arabic,
  bn: FONT_SHEETS.bengali,
  bg: FONT_SHEETS.cyrillic,
  el: FONT_SHEETS.greek,
  fa: FONT_SHEETS.arabic,
  gu: FONT_SHEETS.gujarati,
  he: FONT_SHEETS.hebrew,
  hi: FONT_SHEETS.devanagari,
  ja: FONT_SHEETS.japanese,
  kn: FONT_SHEETS.kannada,
  ml: FONT_SHEETS.malayalam,
  mr: FONT_SHEETS.devanagari,
  pa: FONT_SHEETS.gurmukhi,
  ru: FONT_SHEETS.cyrillic,
  ta: FONT_SHEETS.tamil,
  te: FONT_SHEETS.telugu,
  th: FONT_SHEETS.thai,
  uk: FONT_SHEETS.cyrillic,
  ur: FONT_SHEETS.arabic,
  'zh-hans': FONT_SHEETS.simplifiedChinese,
  'zh-hant': FONT_SHEETS.traditionalChinese,
};

const loadedFonts = new Set<LocaleFontCode>();
const inFlightFonts = new Map<LocaleFontCode, Promise<void>>();

/**
 * Resolve after the requested stylesheet is available. Concurrent callers
 * share one promise; successful loads remain cached explicitly. A failed load
 * is not cached, so a later request can retry after a transient chunk failure.
 */
function loadLocaleFont(code: LocaleFontCode): Promise<void> {
  if (loadedFonts.has(code)) return Promise.resolve();
  const existing = inFlightFonts.get(code);
  if (existing) return existing;

  const pending = FONT_SHEET_BY_LOCALE[code]()
    .then(() => {
      loadedFonts.add(code);
    })
    .catch((error: unknown) => {
      log.warn(`[i18n] Failed to load font CSS for "${code}"`, error);
    })
    .finally(() => {
      inFlightFonts.delete(code);
    });
  inFlightFonts.set(code, pending);
  return pending;
}

const staticPageFontRuntime = Object.freeze({ loadLocaleFont });

export default staticPageFontRuntime;
