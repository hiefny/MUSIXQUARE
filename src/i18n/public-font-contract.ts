import {
  APP_FONT_SHEETS,
  HAN_ORDER_FONT_SHEET,
  HANGUL_FONT_SHEET,
  SCRIPT_FONT_SHEET_BY_LANGUAGE,
  type AppFontSheetId,
} from './app-font-contract.ts';
import type { LanguageCode } from './locales.ts';

/**
 * The font sheets of every page outside the app (About and its sibling pages,
 * the blog and its articles, history, the design system, events, admin, 404):
 * the app's own processed sheets in two groups, which the build concatenates
 * into /web-fonts/first.css and /web-fonts/rest.css
 * (scripts/public-font-sheets.mts, src/i18n/public-font-urls.ts).
 *
 * - first: what the app's loader declares in phase A for the Korean and
 *   English UIs when the browser names no Japanese or Chinese (Inter,
 *   MUSIXQUARE Hangul, Noto Sans KR); public-font-contract.test.ts drives
 *   src/i18n/locale-fonts.ts to hold that. A page links it in the head.
 * - rest: every other app sheet in contract order. A page links it after its
 *   last body script, or in the head where its language needs one of these
 *   faces on the first paint (restFontSheetInHead).
 *
 * Every page so declares every app family, like every app UI, and a font
 * file downloads only for characters on screen. The app never imports this
 * module.
 */
export const PUBLIC_FONT_SHEET_GROUPS: Readonly<{
  first: readonly AppFontSheetId[];
  rest: readonly AppFontSheetId[];
}> = (() => {
  const first: readonly AppFontSheetId[] = Object.freeze([
    'font-inter',
    HANGUL_FONT_SHEET,
    HAN_ORDER_FONT_SHEET.ko,
  ]);
  return Object.freeze({
    first,
    rest: Object.freeze(APP_FONT_SHEETS.map(({ id }) => id).filter((id) => !first.includes(id))),
  });
})();

/**
 * Whether a page in this language links rest.css in its head too: the app's
 * phase A for its UI declares a sheet that first.css lacks, its own script's
 * (the Japanese, Chinese, Thai, Arabic, Hebrew and Indic UIs), so its text
 * draws in its own faces on the first paint. public-font-contract.test.ts
 * holds it to the app's loader.
 */
export function restFontSheetInHead(code: LanguageCode): boolean {
  const own = SCRIPT_FONT_SHEET_BY_LANGUAGE[code];
  return own !== undefined && !PUBLIC_FONT_SHEET_GROUPS.first.includes(own);
}
