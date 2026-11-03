/**
 * The public pages' Pretendard copy, its sheets and the font files nothing
 * uses any more stay retired (scripts/lib/font-retirement.mts;
 * guard:font-assets and guard:font-build run the same checks over the
 * repository and the build).
 *
 * The app switched to Inter and Noto in 9.0.29 and to MUSIXQUARE Hangul in
 * 9.0.33, and every page outside the app in the public-page font train. The
 * checks look only where a text loads or names a font, so text that credits
 * Pretendard stays. What stays on purpose: the Hangul faces' source file,
 * the share-image files and their licence, the maintenance page's font names
 * (its module ships with every Worker), and a frozen ad record.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  GENERATOR_INPUT_SHEETS,
  PRETENDARD_ALLOWLIST,
  PRETENDARD_FILE_ALLOWLIST,
  RETIRED_FONT_PATHS,
  pretendardFontReferences,
  pretendardMentions,
  retiredBuildFiles,
  unshippedFaceFiles,
} from '../../../scripts/lib/font-retirement.mts';

const ROOT = resolve('.');

describe('retired fonts', () => {
  it('loads and names Pretendard as a font nowhere a page, the app or a Worker ships, but the recorded places', () => {
    expect(pretendardMentions(ROOT)).toEqual([]);
    expect(Object.keys(PRETENDARD_ALLOWLIST).sort()).toEqual([
      '.workshop/promo/manifest.json',
      'cloudflare/service-maintenance.ts',
    ]);
    for (const [file, reason] of Object.entries(PRETENDARD_ALLOWLIST)) {
      expect(reason.length, file).toBeGreaterThan(10);
      // A recorded place that no longer names Pretendard as a font leaves the list.
      expect(
        pretendardFontReferences(file, readFileSync(resolve(ROOT, file), 'utf8')),
        file,
      ).not.toEqual([]);
    }
  });

  it('reports where a text loads or names the font, never a credit', () => {
    for (const [file, text] of [
      ['a.css', "body { font-family: 'Pretendard', sans-serif; }"],
      ['a.css', 'body { font: 400 16px/1.5 Pretendard Variable, sans-serif; }'],
      ['a.css', ':root { --font-primary: Pretendard; }'],
      [
        'a.css',
        "@font-face { font-family: X; src: url('/designsystem/fonts/PretendardVariable.woff2'); }",
      ],
      ['a.css', "@import url('/css/pretendard.css');"],
      ['a.html', '<link rel="stylesheet" href="/css/pretendard.css">'],
      ['a.html', '<link rel="preload" as="font" href="/fonts/Pretendard.woff2" crossorigin>'],
      ['a.html', '<p style="font-family: Pretendard">x</p>'],
      ['a.ts', "const style = { fontFamily: 'Pretendard' };"],
      ['a.ts', "const FONT = '/designsystem/fonts/PretendardVariable.woff2';"],
    ] as const) {
      expect(pretendardFontReferences(file, text), text).not.toEqual([]);
    }
    for (const [file, text] of [
      ['a.html', '<p>Hangul. Pretendard 1.309, cut into 87 subsets and renamed.</p>'],
      ['a.html', '<!-- font-family: Pretendard --><p>x</p>'],
      ['a.html', '<style>/* font-family: Pretendard */ p { color: red; }</style>'],
      ['a.css', "/* The line box is Pretendard's: url(/pretendard.woff2) */ body { margin: 0; }"],
      ['a.md', "MUSIXQUARE Hangul, the app's own subsets of Pretendard, renamed."],
      ['a.ts', '// Subsets of fonts/PretendardVariable.woff2, kept as the source.'],
      ['a.md', 'The share images read `public/fonts/og-pretendard-bold.ttf`.'],
      ['a.css', 'body { font-family: var(--font-sans, sans-serif); }'],
    ] as const) {
      expect(pretendardFontReferences(file, text), text).toEqual([]);
    }
  });

  it('keeps the Hangul source, the share-image files and the licence', () => {
    expect(Object.keys(PRETENDARD_FILE_ALLOWLIST).sort()).toEqual([
      'fonts/PRETENDARD_LICENSE.txt',
      'fonts/Pretendard-Bold.ttf',
      'fonts/PretendardVariable.woff2',
      'public/fonts/og-pretendard-bold.ttf',
    ]);
    for (const file of Object.keys(PRETENDARD_FILE_ALLOWLIST)) {
      expect(existsSync(resolve(ROOT, file)), file).toBe(true);
    }
  });

  it('has deleted the deployed Pretendard copy, the Pretendard sheets and the unused Noto files', () => {
    expect([...RETIRED_FONT_PATHS].sort()).toEqual([
      'css/fonts/noto-cyrillic.css',
      'css/fonts/noto-greek.css',
      'css/pretendard.css',
      'fonts/noto/noto-sans-cyrillic',
      'fonts/noto/noto-sans-greek',
      'public/designsystem/fonts',
      'public/designsystem/src_ref',
    ]);
    for (const retired of RETIRED_FONT_PATHS) {
      expect(existsSync(resolve(ROOT, retired)), retired).toBe(false);
    }
  });

  it("keeps Google's CJK and Thai sheets as generator inputs without their unshipped faces", () => {
    expect(GENERATOR_INPUT_SHEETS).toEqual([
      'css/fonts/noto-jp.css',
      'css/fonts/noto-sc.css',
      'css/fonts/noto-tc.css',
      'css/fonts/noto-thai.css',
    ]);
    let unshipped = 0;
    for (const sheet of GENERATOR_INPUT_SHEETS) {
      const files = unshippedFaceFiles(sheet, readFileSync(resolve(ROOT, sheet), 'utf8'));
      unshipped += files.length;
      for (const file of files) expect(existsSync(resolve(ROOT, file)), file).toBe(false);
    }
    // The Latin, Latin Extended, Cyrillic and Vietnamese faces of JP, SC and
    // TC, and Thai's two Latin faces.
    expect(unshipped).toBe(14);
  });

  it('finds the retired files in a build, and keeps the share-image subset', () => {
    expect(
      retiredBuildFiles([
        'designsystem/fonts/PretendardVariable.woff2',
        'designsystem/src_ref/notes.txt',
        'assets/pretendard-6LmBFNNg.css',
        'assets/noto-cyrillic-BGytjVtL.css',
        'assets/noto-jp-Dv3hj6dY.css',
        'assets/noto-thai-Cojp2FYt.css',
      ]),
    ).toEqual([
      'designsystem/fonts/PretendardVariable.woff2 is a Pretendard file',
      'designsystem/src_ref/notes.txt is under a retired folder',
      'assets/pretendard-6LmBFNNg.css is a Pretendard file',
      'assets/noto-cyrillic-BGytjVtL.css is a built copy of a sheet no page links',
      'assets/noto-jp-Dv3hj6dY.css is a built copy of a sheet no page links',
      'assets/noto-thai-Cojp2FYt.css is a built copy of a sheet no page links',
    ]);
    expect(
      retiredBuildFiles([
        'fonts/og-pretendard-bold.ttf',
        'assets/font-noto-jp-AbC12_-9.css',
        'assets/noto-arabic-AbC12_-9.css',
        'web-fonts/rest.css',
        'designsystem/index.html',
      ]),
    ).toEqual([]);
  });
});
