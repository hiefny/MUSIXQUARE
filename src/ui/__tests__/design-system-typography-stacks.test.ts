/**
 * The design system page's Typography section (public/designsystem/index.html
 * #typography) draws its specimens with the page's own text font, which is the
 * app's: /web-fonts/stacks.css gives every page outside the app the app's
 * stacks, and /web-fonts/first.css and rest.css the app's faces. The section
 * declares no face and no stack of its own, so it cannot drift from the app;
 * only the classes the app gives text it detects as Japanese or Chinese pick
 * a named stack, the one the app's own rule for that class reads. These cases
 * resolve the page's stylesheet chain as a browser does and compare it with
 * the app's stacks (css/style.css), in every Han order the app marks.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import { readFontStacks, type DocumentState } from '../../../scripts/fonts/font-stacks.mts';

const ROOT = resolve('.');
const PAGE = 'public/designsystem/index.html';
const SECTION_SHEET = 'public/editorial-design.css';
/** The page's stylesheets after /web-fonts/stacks.css, in cascade order. */
const PAGE_SHEETS = [
  'public/web-fonts/stacks.css',
  'public/designsystem/colors_and_type.css',
  'public/editorial-base.css',
  SECTION_SHEET,
] as const;

/** The classes the app gives detected Japanese and Chinese text (src/ui/user-text-font.ts). */
const DETECTED_LANGUAGE_CLASSES = [
  'user-text-font-ja',
  'user-text-font-zh-hans',
  'user-text-font-zh-hant',
] as const;

/** The page's language, and the root marks the app's Han order can put on it. */
const STATES: readonly DocumentState[] = [null, 'ja', 'zh-hans', 'zh-hant'].map(
  (hanOrder): DocumentState => ({
    htmlLang: 'en',
    attributes: hanOrder === null ? {} : { 'data-mxqr-han-order': hanOrder },
  }),
);

const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');
const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();

const app = readFontStacks(ROOT);
const page = readFontStacks(ROOT, { sheets: PAGE_SHEETS });

/** Every rule of a sheet with its whitespace-collapsed selectors. */
function rules(path: string): { selectors: string[]; rule: Rule }[] {
  const found: { selectors: string[]; rule: Rule }[] = [];
  postcss.parse(read(path)).walkRules((rule) => {
    found.push({ selectors: rule.selectors.map(normalize), rule });
  });
  return found;
}

function fontFamilies(rule: Rule): string[] {
  const values: string[] = [];
  rule.walkDecls('font-family', (declaration) => {
    if (declaration.parent === rule) values.push(normalize(declaration.value));
  });
  return values;
}

const sectionRules = rules(SECTION_SHEET).filter(({ selectors }) =>
  selectors.some((selector) => selector.startsWith('#typography')),
);

describe('design system Typography stacks', () => {
  it('has the section, in an English page that loads the shared font sheets', () => {
    const html = read(PAGE);
    expect(html).toMatch(/<html lang="en"/u);
    expect(html).toMatch(/<section class="section" id="typography">/u);
    expect(sectionRules.length).toBeGreaterThan(20);
  });

  it('declares no face, no stack property and no font of its own', () => {
    for (const { selectors, rule } of sectionRules) {
      rule.walkDecls((declaration) => {
        expect(
          /^--font-(?!weight-)/u.test(declaration.prop),
          `${selectors.join(', ')} sets ${declaration.prop}`,
        ).toBe(false);
        expect(declaration.value, `${selectors.join(', ')} ${declaration.prop}`).not.toMatch(
          /var\(--font-ui\b/u,
        );
      });
    }
    expect(read(SECTION_SHEET)).not.toMatch(/@font-face|--font-ui\b/u);
    // Only the detected-language classes name a stack.
    expect(
      sectionRules
        .filter(({ rule }) => fontFamilies(rule).length > 0)
        .map(({ selectors }) => selectors.join(', ')),
    ).toEqual(DETECTED_LANGUAGE_CLASSES.map((name) => `#typography .${name}`));
  });

  it("draws the specimens with the app's stack in every Han order the app marks", () => {
    for (const state of STATES) {
      expect(page.fontSans(state), JSON.stringify(state.attributes)).toEqual(app.fontSans(state));
    }
  });

  it("gives the app's detected-language classes the stacks the app gives them", () => {
    const appRules = rules('css/style.css');
    for (const name of DETECTED_LANGUAGE_CLASSES) {
      const appRule = appRules.find(({ selectors }) =>
        selectors.includes(`.user-text-font.${name}`),
      );
      const sectionRule = sectionRules.find(({ selectors }) =>
        selectors.includes(`#typography .${name}`),
      );
      expect(appRule, name).toBeDefined();
      expect(sectionRule, name).toBeDefined();
      if (!appRule || !sectionRule) continue;
      const [appValue] = fontFamilies(appRule.rule);
      expect(fontFamilies(sectionRule.rule), name).toEqual([appValue]);
      for (const state of STATES) {
        expect(page.families(state, appValue ?? ''), `${name} ${JSON.stringify(state)}`).toEqual(
          app.families(state, appValue ?? ''),
        );
      }
    }
  });
});
