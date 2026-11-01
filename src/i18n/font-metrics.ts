/**
 * Face metrics of the app's self-hosted fonts: the one home for the
 * size-adjust and metric-override descriptors of every Inter and CJK
 * @font-face rule, and for the line box baked into their font files.
 *
 * CSS cannot import this module. scripts/fonts/build-font-sheets.mts writes
 * the descriptors into the generated sheets in css/fonts/app/, and
 * scripts/fonts/build-app-faces.mts writes the baked line box into the files
 * in fonts/app/. src/i18n/__tests__/font-metrics.test.ts pins every face's
 * descriptors to this module and src/i18n/__tests__/font-baked-metrics.test.ts
 * every file's tables.
 *
 * Pretendard drew Latin and Hangul before the switch. These values keep its
 * glyph sizes and line boxes:
 * - size-adjust scales a face. Inter at 97.2% matches Pretendard's cap height
 *   (0.9725 of Inter's) and x-height (0.970). The four CJK families share
 *   94%, which makes a Hangul syllable exactly as wide as Pretendard's (0.9394
 *   of Noto Sans KR's advance), so Korean lines keep their length. One CJK
 *   value keeps Hangul, kana and Han from different families the same size
 *   within a line.
 * - Browsers scale the metric overrides by size-adjust, so each override is
 *   Pretendard's metric divided by size-adjust. Pretendard's ascent is
 *   1950/2048 em, its descent 494/2048 em and its line gap 0, which keeps
 *   today's line boxes (18 px rows at 15 px, for example) for Latin, Hangul,
 *   kana and Han alike.
 * - Safari applies size-adjust but not the overrides, so it scales the file's
 *   own metrics instead. The files therefore carry the box in font units
 *   (hhea and the OS/2 typo metrics, with USE_TYPO_METRICS set): Pretendard's
 *   metric divided by size-adjust, rounded to the nearest unit, which is also
 *   the nearest unit to each override. A unit is 1/2048 em for Inter and
 *   1/1000 em for the CJK families, so the baked box is not the descriptors
 *   but within half a unit of them (at most 0.0004 em). A line box rounded to
 *   whole pixels from the one can be 1 px taller or shorter than from the
 *   other at sizes next to a rounding boundary: a CJK line at 14.5 px, and the
 *   fluid clamp() sizes of the setup overlay and the desktop demo at some
 *   window widths and heights (docs/design/app-font-baked-metrics-2026-11-01.md
 *   §3 lists them).
 */

interface FontFaceMetrics {
  /** size-adjust, in percent. */
  readonly sizeAdjust: number;
  /** ascent-override, in percent. */
  readonly ascentOverride: number;
  /** descent-override, in percent. */
  readonly descentOverride: number;
  /** line-gap-override, in percent. */
  readonly lineGapOverride: number;
  /** The units per em of the family's files. */
  readonly unitsPerEm: number;
  /** The baked ascender, in font units. */
  readonly ascender: number;
  /** The baked descent below the baseline, in font units (the tables store it negated). */
  readonly descender: number;
  /** The baked line gap, in font units. */
  readonly lineGap: number;
}

const PRETENDARD_UNITS_PER_EM = 2048;
const PRETENDARD_ASCENT = 1950;
const PRETENDARD_DESCENT = 494;
const PRETENDARD_LINE_GAP = 0;

/** A ratio as a percentage with two decimals, the precision the sheets carry. */
function percent(ratio: number): number {
  return Math.round(ratio * 10_000) / 100;
}

function metricsFor(sizeAdjust: number, unitsPerEm: number): FontFaceMetrics {
  const scale = sizeAdjust / 100;
  const em = (metric: number) => metric / PRETENDARD_UNITS_PER_EM / scale;
  return Object.freeze({
    sizeAdjust,
    ascentOverride: percent(em(PRETENDARD_ASCENT)),
    descentOverride: percent(em(PRETENDARD_DESCENT)),
    lineGapOverride: percent(em(PRETENDARD_LINE_GAP)),
    unitsPerEm,
    ascender: Math.round(em(PRETENDARD_ASCENT) * unitsPerEm),
    descender: Math.round(em(PRETENDARD_DESCENT) * unitsPerEm),
    lineGap: Math.round(em(PRETENDARD_LINE_GAP) * unitsPerEm),
  });
}

/** Inter's seven subsets: 97.2% / 97.96% / 24.82% / 0%, baked as 2006 / 508 / 0 of 2048. */
export const INTER_FACE_METRICS = metricsFor(97.2, 2048);

/** Noto Sans KR, JP, SC and TC alike: 94% / 101.29% / 25.66% / 0%, baked as 1013 / 257 / 0 of 1000. */
export const CJK_FACE_METRICS = metricsFor(94, 1000);
