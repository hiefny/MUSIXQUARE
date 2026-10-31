/**
 * The app's font stylesheets, one lazy CSS chunk each.
 *
 * - css/fonts/app/ holds the sheets scripts/fonts/build-font-sheets.mts
 *   generates: Inter, the four CJK families with the range edits that give
 *   each script exactly one family, and the Thai face alone.
 * - The single-script sheets (Arabic, Hebrew and the eight Indic scripts) are
 *   Google's sheets in css/fonts/, shared with the static pages.
 *
 * Generated sheets carry a 'font-' prefix so their emitted file names never
 * collide with the static pages' 'noto-*.css' sheets, which the build and the
 * retryable stylesheet loader match by name.
 */
export const APP_FONT_SHEETS = [
  { id: 'font-inter', path: 'css/fonts/app/font-inter.css', family: 'Inter' },
  { id: 'font-noto-kr', path: 'css/fonts/app/font-noto-kr.css', family: 'Noto Sans KR' },
  { id: 'font-noto-jp', path: 'css/fonts/app/font-noto-jp.css', family: 'Noto Sans JP' },
  { id: 'font-noto-sc', path: 'css/fonts/app/font-noto-sc.css', family: 'Noto Sans SC' },
  { id: 'font-noto-tc', path: 'css/fonts/app/font-noto-tc.css', family: 'Noto Sans TC' },
  { id: 'font-noto-thai', path: 'css/fonts/app/font-noto-thai.css', family: 'Noto Sans Thai' },
  { id: 'noto-arabic', path: 'css/fonts/noto-arabic.css', family: 'Noto Sans Arabic' },
  { id: 'noto-hebrew', path: 'css/fonts/noto-hebrew.css', family: 'Noto Sans Hebrew' },
  { id: 'noto-devanagari', path: 'css/fonts/noto-devanagari.css', family: 'Noto Sans Devanagari' },
  { id: 'noto-bengali', path: 'css/fonts/noto-bengali.css', family: 'Noto Sans Bengali' },
  { id: 'noto-tamil', path: 'css/fonts/noto-tamil.css', family: 'Noto Sans Tamil' },
  { id: 'noto-telugu', path: 'css/fonts/noto-telugu.css', family: 'Noto Sans Telugu' },
  { id: 'noto-gujarati', path: 'css/fonts/noto-gujarati.css', family: 'Noto Sans Gujarati' },
  { id: 'noto-kannada', path: 'css/fonts/noto-kannada.css', family: 'Noto Sans Kannada' },
  { id: 'noto-malayalam', path: 'css/fonts/noto-malayalam.css', family: 'Noto Sans Malayalam' },
  { id: 'noto-gurmukhi', path: 'css/fonts/noto-gurmukhi.css', family: 'Noto Sans Gurmukhi' },
] as const;
