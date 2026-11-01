/**
 * Descriptor parity: CSS cannot import src/i18n/font-metrics.ts, so this test
 * pins every Inter and CJK @font-face rule of the app's font sheets to that one
 * home, and keeps the script faces (Thai, Arabic, Hebrew, Indic) without
 * metric descriptors. The same home holds the line box baked into the font
 * files in font units (src/i18n/__tests__/font-baked-metrics.test.ts reads it
 * back from every face).
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
      unitsPerEm: 2048,
      ascender: 2006,
      descender: 508,
      lineGap: 0,
    });
    expect(CJK_FACE_METRICS).toEqual({
      sizeAdjust: 94,
      ascentOverride: 101.29,
      descentOverride: 25.66,
      lineGapOverride: 0,
      unitsPerEm: 1000,
      ascender: 1013,
      descender: 257,
      lineGap: 0,
    });
  });

  it('bake the same line box into font units: the nearest unit to each override', async () => {
    // A browser that applies size-adjust but not the overrides (Safari) scales
    // the file's own metrics by size-adjust, as it scales the overrides, so a
    // file whose metrics in em equal the overrides draws the same line box.
    const pretendard = await openFontFile(join(ROOT, 'fonts/PretendardVariable.woff2'));
    const { ascender, descender, lineGap } = new hb.Font(pretendard).hExtents();
    for (const metrics of [INTER_FACE_METRICS, CJK_FACE_METRICS]) {
      const scale = metrics.sizeAdjust / 100;
      const units = (value: number) =>
        Math.round((value / pretendard.upem / scale) * metrics.unitsPerEm);
      expect(metrics.ascender).toBe(units(ascender));
      expect(metrics.descender).toBe(units(-descender));
      expect(metrics.lineGap).toBe(units(lineGap));
      // The rounded descriptors land on the same units, less than half a unit away.
      for (const [baked, override] of [
        [metrics.ascender, metrics.ascentOverride],
        [metrics.descender, metrics.descentOverride],
        [metrics.lineGap, metrics.lineGapOverride],
      ] as const) {
        expect(baked).toBe(Math.round((override / 100) * metrics.unitsPerEm));
        expect(Math.abs(baked / metrics.unitsPerEm - override / 100)).toBeLessThan(
          0.5 / metrics.unitsPerEm,
        );
      }
    }
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
