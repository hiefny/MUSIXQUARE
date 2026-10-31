import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  builtAssetStem,
  declaresFontFace,
  disablesContextualAlternates,
  faceDescriptorMismatches,
  faceSourceProblems,
  fontFaceSheets,
  fontPreloadHrefs,
  initialAssetUrls,
  ksX1001CodePoints,
  languageSplitTests,
  localDistAssetPath,
  parseCodePointList,
  stackCoverageGaps,
  textSymbolCodePoints,
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

describe('app font guard: self-hosted faces', () => {
  const face = (src: string, family = "'Inter'") =>
    `@font-face {\n  font-family: ${family};\n  font-weight: 100 900;\n  src: ${src};\n  unicode-range: U+0000-00FF;\n}\n`;

  it('accepts one WOFF2 file per face, relative in the source and root-relative in the build', () => {
    expect(
      faceSourceProblems(
        face("url(../../../fonts/inter/inter-latin.woff2) format('woff2')"),
        'relative',
      ),
    ).toEqual([]);
    expect(
      faceSourceProblems(
        '@font-face{font-family:Inter;src:url(/assets/inter-latin-AbC12_-9.woff2)format("woff2")}',
        'root',
      ),
    ).toEqual([]);
  });

  it('reports a device face, a remote or data URL, a second source and a missing WOFF2 format', () => {
    expect(
      faceSourceProblems(
        face("local('Inter'), url(../../../fonts/inter/inter-latin.woff2) format('woff2')"),
        'relative',
      ),
    ).toEqual(['Inter ../../../fonts/inter/inter-latin.woff2: names a device face with local()']);
    expect(
      faceSourceProblems(
        face("url(https://fonts.gstatic.com/s/inter/v20/a.woff2) format('woff2')"),
        'relative',
      ),
    ).toEqual(['Inter https://fonts.gstatic.com/s/inter/v20/a.woff2: is not a self-hosted file']);
    expect(
      faceSourceProblems(face("url(//fonts.gstatic.com/a.woff2) format('woff2')"), 'relative'),
    ).toEqual(['Inter //fonts.gstatic.com/a.woff2: is not a self-hosted file']);
    expect(
      faceSourceProblems(face("url(data:font/woff2;base64,d09GMg) format('woff2')"), 'relative'),
    ).toEqual(['Inter data:font/woff2;base64,d09GMg: is not a self-hosted file']);
    expect(
      faceSourceProblems(
        face("url(../a.woff2) format('woff2'), url(../a.woff) format('woff')"),
        'relative',
      ),
    ).toEqual(['Inter ../a.woff2: has 2 url() sources, not one']);
    expect(faceSourceProblems(face('url(../a.ttf)'), 'relative')).toEqual([
      'Inter ../a.ttf: is not a WOFF2 file',
      "Inter ../a.ttf: does not declare format('woff2')",
    ]);
    expect(faceSourceProblems(face("local('Inter')"), 'relative')).toEqual([
      'Inter (no url): names a device face with local()',
      'Inter (no url): has 0 url() sources, not one',
    ]);
  });

  it('holds the source to sheet-relative files and the build to root-relative ones', () => {
    expect(faceSourceProblems(face("url(/fonts/a.woff2) format('woff2')"), 'relative')).toEqual([
      'Inter /fonts/a.woff2: is root-relative; a source sheet points at its files relative to itself',
    ]);
    expect(
      faceSourceProblems(
        '@font-face{font-family:Inter;src:url(./inter-latin-AbC12_-9.woff2)format("woff2")}',
        'root',
      ),
    ).toEqual(['Inter ./inter-latin-AbC12_-9.woff2: is not root-relative in the build']);
  });

  it('reports a sheet that imports another sheet', () => {
    expect(
      faceSourceProblems(
        `@import url('https://fonts.googleapis.com/css2?family=Inter');\n${face("url(../a.woff2) format('woff2')")}`,
        'relative',
      ),
    ).toEqual(['the sheet imports another sheet with @import']);
  });
});

describe('app font guard: the recorded coverage gaps', () => {
  it('reads U+ lines in ascending order and skips comments and blank lines', () => {
    expect(
      parseCodePointList(
        [
          '# Gaps',
          '',
          '# IPA',
          'U+0255  # ɕ',
          'U+027C',
          '',
          '# Arrows',
          'U+21A9 # ↩',
          'U+1F850',
        ].join('\n'),
      ),
    ).toEqual({ codePoints: [0x0255, 0x027c, 0x21a9, 0x1f850], problems: [] });
  });

  it('reports malformed, repeated and unordered lines', () => {
    expect(
      parseCodePointList(['U+0255', 'u+027c', '0x21A9', 'U+0255', 'U+0100', 'U+12'].join('\n'))
        .problems,
    ).toEqual([
      'line 2: "u+027c" is not a U+XXXX code point',
      'line 3: "0x21A9" is not a U+XXXX code point',
      'line 4: U+0255 is listed twice',
      'line 5: U+0100 comes after U+0255; keep the list in code point order',
      'line 6: "U+12" is not a U+XXXX code point',
    ]);
  });

  const faces: Readonly<Record<string, readonly number[]>> = {
    Inter: [0x41, 0x42],
    'Noto Sans KR': [0xac00, 0x203b],
    'Noto Sans JP': [0x3042, 0x2049],
  };
  const hasFace = (families: readonly string[], codePoint: number): boolean =>
    families.some((family) => faces[family]?.includes(codePoint) ?? false);

  it('passes when every stack draws every required character but the listed ones', () => {
    const stacks = new Map([
      ['--font-sans (ko)', ['Inter', 'Noto Sans KR', 'Noto Sans JP', 'sans-serif']],
      ['--font-sans (ja)', ['Inter', 'Noto Sans JP', 'Noto Sans KR', 'sans-serif']],
    ]);
    expect(
      stackCoverageGaps(stacks, [0x41, 0xac00, 0x203b, 0x2049, 0x0255], hasFace, new Set([0x0255])),
    ).toEqual({ unlisted: new Map(), stale: [] });
  });

  it('names each stack that misses a required character, and listed characters every stack now draws', () => {
    const stacks = new Map([
      ['--font-sans (ko)', ['Inter', 'Noto Sans KR', 'Noto Sans JP', 'sans-serif']],
      ['.user-text-font-ja (en)', ['Inter', 'Noto Sans JP', 'sans-serif']],
    ]);
    expect(
      stackCoverageGaps(
        stacks,
        [0x41, 0xac00, 0x203b, 0x2049, 0x0255],
        hasFace,
        new Set([0x0255, 0x2049, 0x1f850]),
      ),
    ).toEqual({
      unlisted: new Map([['.user-text-font-ja (en)', [0x203b, 0xac00]]]),
      stale: [0x2049, 0x1f850],
    });
  });
});

describe('app font guard: the Korean and English UIs apply the same rules', () => {
  // A rule whose selector tests the language answers differently in the
  // Korean and English UIs for every element that does not carry its own
  // lang, whatever property it sets. Each of these passed the guard before.
  it.each([
    ['(a) a Korean-UI font stack for chat', 'html:lang(ko) .chat-text', [':lang(ko)']],
    ['(b) an element-level Korean test', '.chat-text:lang(ko)', [':lang(ko)']],
    ['(c) a negated test', ':root:not(:lang(ko)) .track-name-text', [':lang(ko)']],
    ['(d) Korean-UI feature settings', 'html:lang(ko) body', [':lang(ko)']],
    ['(e) Korean-UI line breaking', 'html:lang(ko) .chat-text', [':lang(ko)']],
    ['an English range list', 'html:lang(fr, en) .title', [':lang(en)']],
    ['a quoted range', "html:lang('ko') .title", [':lang(ko)']],
    ['an exact lang attribute', 'html[lang="ko"] .title', ['[lang="ko"]']],
    ['a dash-match lang attribute', 'html[lang|=en] .title', ['[lang|=en]']],
    ['a prefix lang attribute', "[lang^='k' i] .title", ["[lang^='k' i]"]],
  ])('reports %s', (_label, selector, tests) => {
    expect(languageSplitTests(selector, 'ko', 'en')).toEqual(tests);
  });

  it.each([
    'html:lang(ja) .dialog-title',
    'html:lang(zh-Hans) .setup-header-text h2',
    '.language-option-native:lang(zh-Hant)',
    '.settings-option-description:lang(zh-hans)',
    ":root:lang(he)[dir='rtl']",
    "html[data-mxqr-han-order='ja']",
    'html:not(:lang(ja)) .title',
    'html[lang] .title',
    '.chat-text',
  ])('accepts %s, which answers alike in both UIs', (selector) => {
    expect(languageSplitTests(selector, 'ko', 'en')).toEqual([]);
  });

  it.each([
    ['font-variant-ligatures', 'no-contextual', true],
    ['font-variant-ligatures', 'common-ligatures no-contextual', true],
    ['font-variant-ligatures', 'none', true],
    ['font-variant', 'no-contextual', true],
    ['font-variant', 'none', true],
    ['font-feature-settings', "'calt' 0", true],
    ['font-feature-settings', '"liga" 1, "calt" off', true],
    ['FONT-FEATURE-SETTINGS', "'CALT' 0", true],
    ['font-variant-ligatures', 'common-ligatures', false],
    ['font-variant-ligatures', 'normal', false],
    ['font-variant-numeric', 'tabular-nums', false],
    ['font-feature-settings', "'calt'", false],
    ['font-feature-settings', "'calt' 1", false],
    ['font-feature-settings', "'liga' 0", false],
  ] as const)('reads %s: %s as turning calt off: %s', (property, value, off) => {
    expect(disablesContextualAlternates(property, value)).toBe(off);
  });
});

describe('app font guard: app stylesheets declare no face', () => {
  it('names each app stylesheet that declares @font-face, a device face included', () => {
    expect(
      fontFaceSheets([
        { path: 'css/app.css', css: "@import './style.css';" },
        {
          path: 'css/style.css',
          css: ".a { color: red }\n@font-face { font-family: 'Inter'; src: local('Inter') }",
        },
        { path: 'css/desktop.css', css: '@media (min-width: 1px) { .b { color: blue } }' },
      ]),
    ).toEqual(['css/style.css']);
  });
});

describe('app font guard: the characters coverage requires beyond Pretendard', () => {
  it('reads the KS X 1001 repertoire from the EUC-KR decoder', () => {
    const repertoire = new Set(ksX1001CodePoints());
    // The Korean national character set: every precomposed syllable it has,
    // its Hanja, and symbols such as ∼ ≒ ◈ that Malgun Gothic draws in a
    // Korean page and Cambria Math in an English one.
    expect(
      [...repertoire].filter((codePoint) => codePoint >= 0xac00 && codePoint <= 0xd7a3),
    ).toHaveLength(2_350);
    for (const character of ['∼', '≒', '◈', '※', '‰', '一', '丁', 'ア', 'Я']) {
      expect(repertoire.has(character.codePointAt(0) ?? 0), character).toBe(true);
    }
    for (const character of ['A', '☺', '\u0000']) {
      expect(repertoire.has(character.codePointAt(0) ?? 0), character).toBe(false);
    }
  });

  it('takes the visible text-presentation symbols of the blocks the review swept', () => {
    const symbols = new Set(textSymbolCodePoints());
    for (const character of ['☺', '☻', 'ℹ', '‣', '☼', '⌂', 'ℋ', 'ℍ', 'ℝ', '→', '★', '〈']) {
      expect(symbols.has(character.codePointAt(0) ?? 0), character).toBe(true);
    }
    // Emoji presentation, invisible format characters, spaces and unassigned
    // code points are not text symbols.
    for (const codePoint of [0x26bd, 0x2705, 0x200b, 0x2060, 0x2003, 0x3000, 0x2065]) {
      expect(symbols.has(codePoint), codePoint.toString(16)).toBe(false);
    }
  });

  it('records the characters the review measured drawing differently in the Korean and English UIs', () => {
    const recorded = new Set(
      parseCodePointList(readFileSync('scripts/fonts/uncovered-code-points.txt', 'utf8'))
        .codePoints,
    );
    const measured = ['☺', '☻', 'ℹ', '∼', '≒', '◈', '‣', '☼', '⌂', 'ℋ', 'ℍ', 'ℝ'];
    expect(measured.filter((character) => !recorded.has(character.codePointAt(0) ?? 0))).toEqual(
      [],
    );
  });
});
