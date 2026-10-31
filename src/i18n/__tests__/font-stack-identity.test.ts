/**
 * Font stack identity (owner decisions 2026-10-31, the app font switch).
 *
 * The Korean and English UIs draw the same content with the same faces: both
 * read one stack, Inter first for Latin, Cyrillic and Greek, then the four CJK
 * families, then the script families, then the system fonts. Only the Han
 * order differs between UIs:
 * - the Japanese, Simplified Chinese and Traditional Chinese UIs put their own
 *   family first;
 * - every other UI uses one order chosen at startup from the browser's
 *   languages (html[data-mxqr-han-order]), Korean first when the attribute is
 *   absent, so the Korean and English UIs stay identical under every order.
 * The Indic, Arabic and Hebrew UIs put their own script face first, then the
 * same stack. Every family is self-hosted (css/fonts/app/ and the script
 * sheets in src/i18n/app-font-contract.ts) and named in every stack, and each
 * script comes from exactly one family.
 *
 * Text the app detects as Japanese or Chinese (src/ui/user-text-font.ts)
 * takes that language's fixed order, and the language picker draws each
 * native name the same way in every UI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  readFaceResolver,
  readFontStacks,
  type DocumentState,
  type FaceResolver,
} from '../../../scripts/fonts/font-stacks.mts';
import {
  disablesContextualAlternates,
  fontFaceSheets,
  KOREAN_ENGLISH_COPY_RULES,
  languageSplitTests,
} from '../../../scripts/lib/app-font-guard.mts';
import { APP_FONT_SHEETS } from '../app-font-contract.ts';
import { LANGUAGE_OPTIONS, languageDirection, type LanguageCode } from '../locales.ts';

const ROOT = resolve('.');
const stacks = readFontStacks(ROOT);

const INTER = 'Inter';
const KR = 'Noto Sans KR';
const JP = 'Noto Sans JP';
const SC = 'Noto Sans SC';
const TC = 'Noto Sans TC';
const SYSTEM = ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'];
const SCRIPT_FAMILIES = APP_FONT_SHEETS.map(({ family }) => family).filter(
  (family) => ![INTER, KR, JP, SC, TC].includes(family),
);
const APP_FAMILIES: ReadonlySet<string> = new Set(APP_FONT_SHEETS.map(({ family }) => family));

/** html[data-mxqr-han-order] values; null is the absent attribute (Korean first). */
const HAN_ORDERS = [null, 'ja', 'zh-hans', 'zh-hant'] as const;
type HanOrder = (typeof HAN_ORDERS)[number];
const CJK_ORDER: Readonly<Record<'ko' | 'ja' | 'zh-hans' | 'zh-hant', readonly string[]>> = {
  ko: [KR, JP, SC, TC],
  ja: [JP, KR, SC, TC],
  'zh-hans': [SC, TC, JP, KR],
  'zh-hant': [TC, SC, JP, KR],
};
/** The UIs whose own Han order ignores the startup order. */
const OWN_HAN_ORDER: Partial<Record<LanguageCode, keyof typeof CJK_ORDER>> = {
  ja: 'ja',
  'zh-hans': 'zh-hans',
  'zh-hant': 'zh-hant',
};
/** The UIs that put their own script face before the shared stack. */
const SCRIPT_FIRST: Partial<Record<LanguageCode, string>> = {
  hi: 'Noto Sans Devanagari',
  mr: 'Noto Sans Devanagari',
  bn: 'Noto Sans Bengali',
  ta: 'Noto Sans Tamil',
  te: 'Noto Sans Telugu',
  gu: 'Noto Sans Gujarati',
  kn: 'Noto Sans Kannada',
  ml: 'Noto Sans Malayalam',
  pa: 'Noto Sans Gurmukhi',
  ar: 'Noto Sans Arabic',
  ur: 'Noto Sans Arabic',
  fa: 'Noto Sans Arabic',
  he: 'Noto Sans Hebrew',
};

function option(code: LanguageCode) {
  const found = LANGUAGE_OPTIONS.find((entry) => entry.code === code);
  if (!found) throw new Error(`Unknown UI language ${code}`);
  return found;
}

function documentState(code: LanguageCode, hanOrder: HanOrder): DocumentState {
  return {
    htmlLang: option(code).htmlLang,
    dir: languageDirection(code),
    attributes: hanOrder === null ? {} : { 'data-mxqr-han-order': hanOrder },
  };
}

const uiStack = (code: LanguageCode, hanOrder: HanOrder): string[] =>
  stacks.fontSans(documentState(code, hanOrder));

function expectedStack(code: LanguageCode, hanOrder: HanOrder): string[] {
  const cjk = CJK_ORDER[OWN_HAN_ORDER[code] ?? hanOrder ?? 'ko'];
  const shared = [INTER, ...cjk, ...SCRIPT_FAMILIES, ...SYSTEM];
  const script = SCRIPT_FIRST[code];
  return script ? [script, ...shared] : shared;
}

const everyState = LANGUAGE_OPTIONS.flatMap(({ code }) =>
  HAN_ORDERS.map((hanOrder) => ({ code, hanOrder })),
);

const appSheetText = (): string =>
  stacks.sheets.map((sheet) => readFileSync(resolve(sheet), 'utf8')).join('\n');

const hex = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;

function codePointsIn(ranges: readonly (readonly [number, number])[]): number[] {
  const codePoints: number[] = [];
  for (const [start, end] of ranges) {
    for (let codePoint = start; codePoint <= end; codePoint += 1) codePoints.push(codePoint);
  }
  return codePoints;
}

describe('app font stacks', () => {
  it('resolves the Korean and English UIs to the same stack under every Han order', () => {
    for (const hanOrder of HAN_ORDERS) {
      expect(uiStack('ko', hanOrder), String(hanOrder)).toEqual(uiStack('en', hanOrder));
    }
  });

  it('gives every UI language the shared stack, its own Han order or its script face first', () => {
    const wrong: string[] = [];
    for (const { code, hanOrder } of everyState) {
      const actual = uiStack(code, hanOrder);
      const expected = expectedStack(code, hanOrder);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        wrong.push(`${code} (${String(hanOrder)}): ${actual.join(', ')}`);
      }
    }
    expect(wrong).toEqual([]);
    // Every UI without its own Han order or script face reads the English stack.
    for (const { code, hanOrder } of everyState) {
      if (OWN_HAN_ORDER[code] || SCRIPT_FIRST[code]) continue;
      expect(uiStack(code, hanOrder), `${code} (${String(hanOrder)})`).toEqual(
        uiStack('en', hanOrder),
      );
    }
  });

  it('names only self-hosted families and the system fallbacks, every family in every stack', () => {
    for (const { code, hanOrder } of everyState) {
      const stack = uiStack(code, hanOrder);
      const where = `${code} (${String(hanOrder)})`;
      expect(
        stack.filter((family) => !APP_FAMILIES.has(family) && !SYSTEM.includes(family)),
        where,
      ).toEqual([]);
      expect(
        [...APP_FAMILIES].filter((family) => !stack.includes(family)),
        where,
      ).toEqual([]);
    }
  });

  it('leaves Pretendard, its recovery family and the retired stacks out of the app sheets', () => {
    const css = appSheetText();
    expect(css).not.toMatch(/pretendard/iu);
    expect(css).not.toContain('data-mxqr-font-recovery');
    for (const retired of [
      '--font-sans-ko',
      '--font-sans-th',
      '--font-sans-cyrillic',
      '--font-sans-greek',
      '--user-text-font-',
    ]) {
      expect(css, retired).not.toContain(retired);
    }
    expect(css).not.toMatch(/['"]Noto Sans['"]/u);
  });
});

describe('the Korean and English UIs apply the same rules', () => {
  const KO = option('ko').htmlLang;
  const EN = option('en').htmlLang;

  it('applies no app rule in only one of them, whatever it sets, but the recorded UI copy rules', () => {
    const split = new Map<string, string[]>();
    for (const { sheet, selectors } of stacks.rules) {
      for (const selector of selectors) {
        const tests = languageSplitTests(selector, KO, EN);
        if (tests.length > 0) split.set(selector, [sheet, ...tests]);
      }
    }
    expect([...split.keys()].sort()).toEqual(Object.keys(KOREAN_ENGLISH_COPY_RULES).sort());
  });

  it("keeps Inter's contextual alternates on in every app rule", () => {
    const off: string[] = [];
    for (const { sheet, selector, rule } of stacks.rules) {
      rule.walkDecls((declaration) => {
        if (disablesContextualAlternates(declaration.prop, declaration.value)) {
          off.push(`${sheet} ${selector} { ${declaration.prop}: ${declaration.value} }`);
        }
      });
    }
    expect(off).toEqual([]);
  });

  it('declares no face in the app stylesheets; faces live in the generated sheets only', () => {
    expect(
      fontFaceSheets(
        ['css/app.css', ...stacks.sheets].map((path) => ({
          path,
          css: readFileSync(resolve(path), 'utf8'),
        })),
      ),
    ).toEqual([]);
  });
});

describe('one family per script', () => {
  let faces: FaceResolver;

  beforeAll(async () => {
    faces = await readFaceResolver(ROOT, APP_FONT_SHEETS);
  }, 60_000);

  /** Each distinct stack once, with the UIs that read it. */
  function distinctStacks(): Map<string, { stack: string[]; where: string }> {
    const distinct = new Map<string, { stack: string[]; where: string }>();
    for (const { code, hanOrder } of everyState) {
      const stack = uiStack(code, hanOrder);
      const key = stack.join('|');
      if (!distinct.has(key)) distinct.set(key, { stack, where: `${code} (${String(hanOrder)})` });
    }
    return distinct;
  }

  it.each([
    {
      script: 'Latin, Cyrillic and Greek letters, digits and ASCII punctuation',
      family: INTER,
      codePoints: (): number[] =>
        codePointsIn([
          [0x0020, 0x007e],
          [0x00c0, 0x024f],
          [0x0370, 0x03ff],
          [0x0400, 0x04ff],
          [0x1e00, 0x1eff],
        ]).filter((codePoint) => {
          const character = String.fromCodePoint(codePoint);
          return (
            codePoint <= 0x7e ||
            /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u.test(character)
          );
        }),
    },
    {
      script: 'Hangul syllables and compatibility jamo',
      family: KR,
      codePoints: (): number[] =>
        codePointsIn([
          [0xac00, 0xd7a3],
          [0x3131, 0x318e],
        ]),
    },
    {
      script: 'Hiragana and Katakana',
      family: JP,
      codePoints: (): number[] =>
        codePointsIn([
          [0x3041, 0x3096],
          [0x30a1, 0x30fa],
          [0x31f0, 0x31ff],
          [0xff66, 0xff9d],
        ]),
    },
    {
      script: 'Thai',
      family: 'Noto Sans Thai',
      codePoints: (): number[] => codePointsIn([[0x0e01, 0x0e5b]]),
    },
    {
      script: 'Arabic letters',
      family: 'Noto Sans Arabic',
      codePoints: (): number[] => codePointsIn([[0x0621, 0x064a]]),
    },
    {
      script: 'Hebrew letters',
      family: 'Noto Sans Hebrew',
      codePoints: (): number[] => codePointsIn([[0x05d0, 0x05ea]]),
    },
    {
      script: 'Devanagari letters',
      family: 'Noto Sans Devanagari',
      codePoints: (): number[] => codePointsIn([[0x0905, 0x0939]]),
    },
  ])('draws $script with $family in every UI, or with no web face', ({ family, codePoints }) => {
    const elsewhere: string[] = [];
    let drawn = 0;
    for (const { stack, where } of distinctStacks().values()) {
      for (const codePoint of codePoints()) {
        const face = faces.faceFor(stack, codePoint);
        if (!face) continue;
        if (face.family === family) drawn += 1;
        else if (elsewhere.length < 20)
          elsewhere.push(`${where} ${hex(codePoint)}: ${face.family}`);
      }
    }
    expect(elsewhere).toEqual([]);
    expect(drawn).toBeGreaterThan(0);
  });
});

describe('detected Japanese and Chinese user text', () => {
  const orderRules = stacks.rules.filter((rule) =>
    rule.selectors.some((selector) => selector.includes('user-text-font')),
  );

  it('takes the detected language order from three rules, Japanese last so it wins', () => {
    expect(orderRules.map(({ sheet, selector, layer }) => `${sheet} ${layer} ${selector}`)).toEqual(
      [
        'css/style.css components .user-text-font.user-text-font-zh-hant',
        'css/style.css components .user-text-font.user-text-font-zh-hans',
        'css/style.css components .user-text-font.user-text-font-ja',
      ],
    );
    for (const { rule, selector } of orderRules) {
      expect(
        rule.nodes.map((node) => (node.type === 'decl' ? node.prop : node.type)),
        selector,
      ).toEqual(['font-family']);
    }
  });

  it.each([
    ['.user-text-font.user-text-font-ja', 'ja'],
    ['.user-text-font.user-text-font-zh-hans', 'zh-hans'],
    ['.user-text-font.user-text-font-zh-hant', 'zh-hant'],
  ] as const)('draws %s with the %s UI stack in every UI', (selector, language) => {
    const rule = orderRules.find((entry) => entry.selector === selector);
    const declaration = rule?.rule.nodes.find(
      (node) => node.type === 'decl' && node.prop === 'font-family',
    );
    expect(declaration?.type, selector).toBe('decl');
    const value = declaration?.type === 'decl' ? declaration.value : '';
    for (const { code, hanOrder } of everyState) {
      expect(
        stacks.families(documentState(code, hanOrder), value),
        `${code} (${String(hanOrder)})`,
      ).toEqual(uiStack(language, null));
    }
  });
});

describe('language picker native names', () => {
  /** The :lang() range of each native-name rule and the stack it reads. */
  const PICKER_STACKS: Readonly<Record<string, string>> = {
    ja: 'var(--font-sans-ja)',
    'zh-Hans': 'var(--font-sans-cjk-sc)',
    'zh-Hant': 'var(--font-sans-cjk-tc)',
    hi: 'var(--font-sans-devanagari)',
    mr: 'var(--font-sans-devanagari)',
    bn: 'var(--font-sans-bengali)',
    ta: 'var(--font-sans-tamil)',
    te: 'var(--font-sans-telugu)',
    gu: 'var(--font-sans-gujarati)',
    kn: 'var(--font-sans-kannada)',
    ml: 'var(--font-sans-malayalam)',
    pa: 'var(--font-sans-gurmukhi)',
    ar: 'var(--font-sans-arabic)',
    fa: 'var(--font-sans-arabic)',
    ur: 'var(--font-sans-arabic)',
    he: 'var(--font-sans-hebrew)',
  };
  const pickerRules = stacks.rules.flatMap((rule) =>
    rule.selectors.flatMap((selector) => {
      const range = /^\.language-option-native:lang\(([^)]+)\)$/u.exec(selector)?.[1];
      if (!range) return [];
      const declaration = rule.rule.nodes.find(
        (node) => node.type === 'decl' && node.prop === 'font-family',
      );
      return [{ range, value: declaration?.type === 'decl' ? declaration.value.trim() : '' }];
    }),
  );

  it('points each script-specific native name at its stack, and nothing else', () => {
    expect(Object.fromEntries(pickerRules.map(({ range, value }) => [range, value]))).toEqual(
      PICKER_STACKS,
    );
  });

  it('draws every native name with the same faces in every UI', async () => {
    const faces = await readFaceResolver(ROOT, APP_FONT_SHEETS);
    const differing: string[] = [];
    for (const target of LANGUAGE_OPTIONS) {
      const rule = pickerRules.find(
        ({ range }) =>
          target.htmlLang.toLowerCase() === range.toLowerCase() ||
          target.htmlLang.toLowerCase().startsWith(`${range.toLowerCase()}-`),
      );
      const drawn = new Map<string, string>();
      for (const { code, hanOrder } of everyState) {
        const state = documentState(code, hanOrder);
        const stack = rule ? stacks.families(state, rule.value) : stacks.fontSans(state);
        const families = [...target.nativeName]
          .filter((character) => character.trim())
          .map((character) => faces.faceFor(stack, character.codePointAt(0) ?? 0)?.family ?? '-')
          .join(' ');
        drawn.set(families, `${code} (${String(hanOrder)})`);
      }
      if (drawn.size !== 1)
        differing.push(`${target.code} ${target.nativeName}: ${[...drawn.keys()].join(' / ')}`);
    }
    expect(differing).toEqual([]);
  }, 60_000);
});
