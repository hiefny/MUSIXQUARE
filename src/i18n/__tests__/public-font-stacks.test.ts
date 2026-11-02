/**
 * The public pages' font stacks: public/web-fonts/stacks.css mirrors the
 * app's stack custom properties and their html:lang(), dir and Han order
 * rules (css/style.css and css/rtl.css), so every page outside the app reads
 * exactly the app's --font-sans in every language, direction and Han order,
 * and its language names read the stacks the app picker reads. The Korean
 * and English pages read one stack.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { readFontStacks, type DocumentState } from '../../../scripts/fonts/font-stacks.mts';
import { LANGUAGE_OPTIONS } from '../locales.ts';

const ROOT = resolve('.');
const PUBLIC_STACKS = 'public/web-fonts/stacks.css';
const app = readFontStacks(ROOT);
const pages = readFontStacks(ROOT, { sheets: [PUBLIC_STACKS] });

const HAN_ORDERS = [null, 'ko', 'ja', 'zh-hans', 'zh-hant'] as const;

/** The root attributes of a Han order, as the app sets them. */
function hanAttributes(hanOrder: (typeof HAN_ORDERS)[number]): Readonly<Record<string, string>> {
  return hanOrder === null ? {} : { 'data-mxqr-han-order': hanOrder };
}

/** Every language in both directions under every Han order the app sets. */
const states: readonly (DocumentState & { label: string })[] = LANGUAGE_OPTIONS.flatMap(
  ({ code, htmlLang }) =>
    (['ltr', 'rtl'] as const).flatMap((dir) =>
      HAN_ORDERS.map((hanOrder) => ({
        label: `${code} ${dir} Han order ${hanOrder ?? '(none)'}`,
        htmlLang,
        dir,
        attributes: hanAttributes(hanOrder),
      })),
    ),
);

/** The stacks a page reads by name (the language picker and detected-language rules). */
const NAMED_STACKS = [
  '--font-sans-ui',
  '--font-sans-ja',
  '--font-sans-cjk-sc',
  '--font-sans-cjk-tc',
  '--font-sans-devanagari',
  '--font-sans-bengali',
  '--font-sans-tamil',
  '--font-sans-telugu',
  '--font-sans-gujarati',
  '--font-sans-kannada',
  '--font-sans-malayalam',
  '--font-sans-gurmukhi',
  '--font-sans-arabic',
  '--font-sans-hebrew',
] as const;

describe('the public font stacks', () => {
  it("resolve --font-sans to the app's in all 42 languages, both directions and every Han order", () => {
    expect(pages.sheets).toEqual([PUBLIC_STACKS]);
    expect(LANGUAGE_OPTIONS).toHaveLength(42);
    for (const state of states) {
      expect(pages.fontSans(state), state.label).toEqual(app.fontSans(state));
    }
  });

  it("resolve every named stack to the app's", () => {
    for (const state of states) {
      for (const property of NAMED_STACKS) {
        const expected = app.rootValue(state, property);
        expect(expected, `${state.label} ${property} (app)`).not.toBeNull();
        expect(pages.rootValue(state, property), `${state.label} ${property}`).toBe(expected);
      }
    }
  });

  it('give the Korean and English pages one stack under every Han order', () => {
    for (const hanOrder of HAN_ORDERS) {
      const attributes = hanAttributes(hanOrder);
      const korean = pages.fontSans({ htmlLang: 'ko', attributes });
      expect(korean, `Han order ${hanOrder ?? '(none)'}`).toEqual(
        pages.fontSans({ htmlLang: 'en', attributes }),
      );
      expect(korean.slice(0, 2)).toEqual(['Inter', 'MUSIXQUARE Hangul']);
    }
  });

  it('hold only root font stack properties: no face, no layer and no other property', () => {
    const css = readFileSync(resolve(ROOT, PUBLIC_STACKS), 'utf8');
    const root = postcss.parse(css);
    const atRules: string[] = [];
    root.walkAtRules((atRule) => {
      atRules.push(atRule.name);
    });
    expect(atRules).toEqual([]);
    root.walkRules((rule) => {
      for (const selector of rule.selectors) {
        expect(selector, selector).toMatch(
          /^(?:html|:root)(?::lang\([^)]+\)|\[dir='rtl'\]|\[data-mxqr-han-order='(?:ja|zh-hans|zh-hant)'\])*$/u,
        );
      }
      rule.walkDecls((declaration) => {
        expect(declaration.prop, `${rule.selector} ${declaration.prop}`).toMatch(
          /^--font-(?!weight-)/u,
        );
      });
    });
    expect(css).not.toMatch(/pretendard|@font-face/iu);
  });
});
