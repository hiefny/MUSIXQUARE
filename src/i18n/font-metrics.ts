/**
 * Face metrics of the app's self-hosted fonts: the one home for the
 * size-adjust and metric-override descriptors of every Inter and CJK
 * @font-face rule.
 *
 * CSS cannot import this module. scripts/fonts/build-font-sheets.mts writes
 * these values into the generated sheets in css/fonts/app/, and
 * src/i18n/__tests__/font-metrics.test.ts pins every face to them.
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
}

const PRETENDARD_UNITS_PER_EM = 2048;
const PRETENDARD_ASCENT = 1950;
const PRETENDARD_DESCENT = 494;
const PRETENDARD_LINE_GAP = 0;

/** A ratio as a percentage with two decimals, the precision the sheets carry. */
function percent(ratio: number): number {
  return Math.round(ratio * 10_000) / 100;
}

function metricsForSizeAdjust(sizeAdjust: number): FontFaceMetrics {
  const scale = sizeAdjust / 100;
  return Object.freeze({
    sizeAdjust,
    ascentOverride: percent(PRETENDARD_ASCENT / PRETENDARD_UNITS_PER_EM / scale),
    descentOverride: percent(PRETENDARD_DESCENT / PRETENDARD_UNITS_PER_EM / scale),
    lineGapOverride: percent(PRETENDARD_LINE_GAP / PRETENDARD_UNITS_PER_EM / scale),
  });
}

/** Inter's seven subsets: 97.2% / 97.96% / 24.82% / 0%. */
export const INTER_FACE_METRICS = metricsForSizeAdjust(97.2);

/** Noto Sans KR, JP, SC and TC alike: 94% / 101.29% / 25.66% / 0%. */
export const CJK_FACE_METRICS = metricsForSizeAdjust(94);
