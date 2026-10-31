/**
 * Descriptor parity: CSS cannot import src/i18n/font-metrics.ts, so this test
 * pins every Inter and CJK @font-face rule of the app's font sheets to that one
 * home, and keeps the script faces (Thai, Arabic, Hebrew, Indic) without
 * metric descriptors.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as hb from 'harfbuzzjs';
import { describe, expect, it } from 'vitest';

import { openFontFile, parseFontFaceRules } from '../../../scripts/fonts/font-files.mts';
import { APP_FONT_SHEETS } from '../app-font-contract.ts';
import { CJK_FACE_METRICS, INTER_FACE_METRICS } from '../font-metrics.ts';

const ROOT = resolve('.');
const METRIC_DESCRIPTORS = [
  'size-adjust',
  'ascent-override',
  'descent-override',
  'line-gap-override',
] as const;
const CJK_FAMILIES = new Set(['Noto Sans KR', 'Noto Sans JP', 'Noto Sans SC', 'Noto Sans TC']);

const roundToHundredths = (value: number): number => Math.round(value * 100) / 100;

function descriptorsOf(metrics: typeof CJK_FACE_METRICS): Record<string, string> {
  return {
    'size-adjust': `${metrics.sizeAdjust}%`,
    'ascent-override': `${metrics.ascentOverride}%`,
    'descent-override': `${metrics.descentOverride}%`,
    'line-gap-override': `${metrics.lineGapOverride}%`,
  };
}

describe('app font metric descriptors', () => {
  it('hold the release-owner values', () => {
    expect(INTER_FACE_METRICS).toEqual({
      sizeAdjust: 97.2,
      ascentOverride: 97.96,
      descentOverride: 24.82,
      lineGapOverride: 0,
    });
    expect(CJK_FACE_METRICS).toEqual({
      sizeAdjust: 94,
      ascentOverride: 101.29,
      descentOverride: 25.66,
      lineGapOverride: 0,
    });
  });

  it("derive every override from Pretendard's own vertical metrics divided by size-adjust", async () => {
    const pretendard = await openFontFile(join(ROOT, 'fonts/PretendardVariable.woff2'));
    const { ascender, descender, lineGap } = new hb.Font(pretendard).hExtents();
    const unitsPerEm = pretendard.upem;
    for (const metrics of [INTER_FACE_METRICS, CJK_FACE_METRICS]) {
      const scale = metrics.sizeAdjust / 100;
      expect(metrics.ascentOverride).toBe(roundToHundredths((ascender / unitsPerEm / scale) * 100));
      expect(metrics.descentOverride).toBe(
        roundToHundredths((-descender / unitsPerEm / scale) * 100),
      );
      expect(metrics.lineGapOverride).toBe(roundToHundredths((lineGap / unitsPerEm / scale) * 100));
    }
  });

  it('pin every Inter and CJK face to the metrics home and leave the script faces without them', async () => {
    const facesByMetrics = { inter: 0, cjk: 0, none: 0 };
    for (const sheet of APP_FONT_SHEETS) {
      const css = await readFile(join(ROOT, sheet.path), 'utf8');
      const rules = parseFontFaceRules(css);
      expect(rules.length, sheet.path).toBeGreaterThan(0);
      for (const rule of rules) {
        const metrics =
          rule.family === 'Inter'
            ? INTER_FACE_METRICS
            : CJK_FAMILIES.has(rule.family)
              ? CJK_FACE_METRICS
              : null;
        const actual = Object.fromEntries(
          METRIC_DESCRIPTORS.flatMap((name) => {
            const value = rule.declarations.get(name);
            return value === undefined ? [] : [[name, value]];
          }),
        );
        expect(actual, `${sheet.path} ${rule.file}`).toEqual(metrics ? descriptorsOf(metrics) : {});
        facesByMetrics[
          metrics === INTER_FACE_METRICS ? 'inter' : metrics === CJK_FACE_METRICS ? 'cjk' : 'none'
        ] += 1;
      }
    }
    expect(facesByMetrics).toEqual({ inter: 7, cjk: 433, none: 11 });
  });
});
