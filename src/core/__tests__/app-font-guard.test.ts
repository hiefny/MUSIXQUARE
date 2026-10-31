import { describe, expect, it } from 'vitest';

import {
  builtAssetStem,
  declaresFontFace,
  faceDescriptorMismatches,
  fontPreloadHrefs,
  initialAssetUrls,
  localDistAssetPath,
  woff2Urls,
} from '../../../scripts/lib/app-font-guard.mts';
import { CJK_FACE_METRICS, INTER_FACE_METRICS } from '../../i18n/font-metrics.ts';

// The pure parts of scripts/check-app-font.mts, which reads the repository and
// the build output and reports what these helpers find.

describe('app font guard: preloads', () => {
  it.each(['"', "'"])('finds a font preload of any file with %s attributes', (quote) => {
    for (const href of [
      '/designsystem/fonts/PretendardVariable.woff2',
      '/assets/inter-latin-AbC12_-9.woff2',
    ]) {
      const html = `<link rel=${quote}preload${quote} href=${quote}${href}${quote} as=${quote}font${quote} type=${quote}font/woff2${quote} crossorigin>`;
      expect(fontPreloadHrefs(html)).toEqual([href]);
    }
  });

  it('ignores stylesheets, other preloads and a missing href', () => {
    expect(
      fontPreloadHrefs(
        [
          '<link rel="stylesheet" href="/assets/font-inter-AbC12_-9.css">',
          '<link rel="preload" href="/assets/app.js" as="script">',
          '<link rel="preload" as="font">',
          '<link rel="modulepreload" href="/assets/app.js">',
        ].join(''),
      ),
    ).toEqual([]);
  });
});

describe('app font guard: the initial graph', () => {
  it('lists every script and link of the document in order', () => {
    const html = `<!doctype html><head>
      <script src="/bootstrap.js"></script>
      <link rel="stylesheet" href="/assets/main-AbC12_-9.css">
      <script type="module" crossorigin src="/assets/main-AbC12_-9.js"></script>
      <link rel="icon" href="/favicon.svg">
    </head>`;
    expect(initialAssetUrls(html)).toEqual([
      '/bootstrap.js',
      '/assets/main-AbC12_-9.css',
      '/assets/main-AbC12_-9.js',
      '/favicon.svg',
    ]);
  });

  it('maps only root-relative URLs into the build output', () => {
    expect(localDistAssetPath('/dist', '/assets/a.css')?.replace(/\\/gu, '/')).toBe(
      '/dist/assets/a.css',
    );
    expect(localDistAssetPath('/dist', '/assets/a.css?v=1#x')?.replace(/\\/gu, '/')).toBe(
      '/dist/assets/a.css',
    );
    expect(localDistAssetPath('/dist', 'https://example.test/a.css')).toBeNull();
    expect(localDistAssetPath('/dist', '//example.test/a.css')).toBeNull();
    expect(localDistAssetPath('/dist', '/../secret.txt')).toBeNull();
    expect(localDistAssetPath('/dist', 'assets/a.css')).toBeNull();
  });

  it('finds @font-face rules in source and minified CSS', () => {
    expect(declaresFontFace("@font-face { font-family: 'Inter'; src: url(a.woff2); }")).toBe(true);
    expect(
      declaresFontFace('@font-face{font-family:Noto Sans KR;src:url(/a.woff2)}', 'Noto Sans KR'),
    ).toBe(true);
    expect(
      declaresFontFace('@font-face{font-family:Inter;src:url(/a.woff2)}', 'Noto Sans KR'),
    ).toBe(false);
    expect(declaresFontFace('.title{font-family:var(--font-sans)}')).toBe(false);
  });

  it('lists the WOFF2 files a sheet points at', () => {
    expect(
      woff2Urls(
        '@font-face{src:url(/assets/a-AbC12_-9.woff2)format("woff2")}@font-face{src:url("../b.woff2") format("woff2")}',
      ),
    ).toEqual(['/assets/a-AbC12_-9.woff2', '../b.woff2']);
  });
});

describe('app font guard: built sheets', () => {
  it.each([
    ['assets/font-noto-kr-BhuhURak.css', 'font-noto-kr'],
    ['C:\\dist\\assets\\font-inter-B0CU3y3_.css', 'font-inter'],
    ['assets/noto-jp-Dv3hj6dY.css', 'noto-jp'],
    ['assets/inter-latin-a-b_C1D2.woff2', 'inter-latin'],
    [
      'assets/PbykFmXiEBPT4ITbgNA5Cgm20xz64px_1hVWr0wuPNGmlQNMEfD4.119-DzYXLDOB.woff2',
      'PbykFmXiEBPT4ITbgNA5Cgm20xz64px_1hVWr0wuPNGmlQNMEfD4.119',
    ],
    ['index.html', 'index.html'],
  ])('names %s by its source stem %s', (file, stem) => {
    expect(builtAssetStem(file)).toBe(stem);
  });

  const expected = new Map([
    ['Inter', INTER_FACE_METRICS],
    ['Noto Sans KR', CJK_FACE_METRICS],
    ['Noto Sans Arabic', null],
  ]);
  const interFace = `@font-face{font-family:Inter;font-weight:100 900;size-adjust:${INTER_FACE_METRICS.sizeAdjust}%;ascent-override:${INTER_FACE_METRICS.ascentOverride}%;descent-override:${INTER_FACE_METRICS.descentOverride}%;line-gap-override:${INTER_FACE_METRICS.lineGapOverride}%;src:url(/assets/inter-latin-AbC12_-9.woff2)format("woff2")}`;

  it('accepts faces whose metric descriptors equal the metrics home', () => {
    expect(faceDescriptorMismatches(interFace, expected)).toEqual([]);
    expect(
      faceDescriptorMismatches(
        '@font-face{font-family:Noto Sans Arabic;src:url(/assets/a.woff2)format("woff2")}',
        expected,
      ),
    ).toEqual([]);
  });

  it('reports a changed, missing or unexpected descriptor and an unknown family', () => {
    expect(
      faceDescriptorMismatches(
        interFace.replace('size-adjust:97.2%', 'size-adjust:100%'),
        expected,
      ),
    ).toEqual(['Inter inter-latin-AbC12_-9.woff2: size-adjust is 100%, not 97.2%']);
    expect(
      faceDescriptorMismatches(interFace.replace(/ascent-override:[^;]+;/u, ''), expected),
    ).toEqual(['Inter inter-latin-AbC12_-9.woff2: ascent-override is missing, not 97.96%']);
    expect(
      faceDescriptorMismatches(
        '@font-face{font-family:Noto Sans Arabic;size-adjust:94%;src:url(/assets/a.woff2)format("woff2")}',
        expected,
      ),
    ).toEqual(['Noto Sans Arabic a.woff2: size-adjust is 94%, not unset']);
    expect(
      faceDescriptorMismatches(
        '@font-face{font-family:Pretendard;src:url(/assets/p.woff2)format("woff2")}',
        expected,
      ),
    ).toEqual(['Pretendard p.woff2: not an app font family']);
  });
});
