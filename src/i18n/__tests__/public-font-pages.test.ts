/**
 * The font contract of the pages outside the app (scripts/lib/public-font-pages.mts):
 * every page links /web-fonts/first.css and /web-fonts/stacks.css in its
 * head before its own stylesheets, and /web-fonts/rest.css after its last
 * body script (in the head for a page whose language needs those faces
 * first, and not at all where a page's scripts must not wait for it), loads
 * fonts no other way, and its stylesheets declare no face and set no stack,
 * so it reads the app's stacks. These fixtures pin each departure the checks
 * report; the page cases follow, one group of pages at a time.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type AtRule, type Rule } from 'postcss';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import { readFontStacks } from '../../../scripts/fonts/font-stacks.mts';
import { languageSplitTests } from '../../../scripts/lib/app-font-guard.mts';
import {
  PUBLIC_FONT_PAGES,
  PUBLIC_KOREAN_ENGLISH_COPY_RULES,
  PUBLIC_TEXT_FONT_FAMILY,
  inlineStyles,
  publicFontCssProblems,
  publicFontLinkProblems,
  type PublicFontPage,
} from '../../../scripts/lib/public-font-pages.mts';
import { renderLocalizedAbout } from '../../../scripts/localized-html-lib.mts';
import { LANGUAGE_OPTIONS, languageDirection, type LanguageCode } from '../locales.ts';
import { restFontSheetInHead } from '../public-font-contract.ts';
import { PUBLIC_FONT_SHEET_URLS } from '../public-font-urls.ts';

const { first, stacks, rest } = PUBLIC_FONT_SHEET_URLS;

const GOOD_PAGE = `<!doctype html><html><head>
<link rel="icon" href="/favicon.svg">
<link rel="stylesheet" href="${first}">
<link rel="stylesheet" href="${stacks}">
<link rel="stylesheet" href="/page.css">
<style>body{color:red}</style>
</head><body><p>Text</p><script src="/page.js"></script>
<link rel="stylesheet" href="${rest}">
</body></html>`;

const REST_LINK = `<link rel="stylesheet" href="${rest}">\n`;

const REST_IN_HEAD = GOOD_PAGE.replace(REST_LINK, '').replace(
  '<link rel="stylesheet" href="/page.css">',
  `<link rel="stylesheet" href="${rest}">\n<link rel="stylesheet" href="/page.css">`,
);

describe('the public font link check', () => {
  it('accepts the shared layout, rest.css after the last body script', () => {
    expect(publicFontLinkProblems(GOOD_PAGE, { rest: 'body' })).toEqual([]);
    expect(publicFontLinkProblems(GOOD_PAGE, { rest: 'head' })).toEqual([
      'links rest.css in the body, not the head',
    ]);
    expect(publicFontLinkProblems(GOOD_PAGE, { rest: 'none' })).toEqual([
      'links rest.css, which this page must not',
    ]);
  });

  it('accepts rest.css in the head where the page asks for it there', () => {
    expect(publicFontLinkProblems(REST_IN_HEAD, { rest: 'head' })).toEqual([]);
    expect(publicFontLinkProblems(REST_IN_HEAD, { rest: 'body' })).toEqual([
      'links rest.css in the head, not the body',
    ]);
  });

  it('accepts a page without rest.css where it must not have one', () => {
    const withoutRest = GOOD_PAGE.replace(REST_LINK, '');
    expect(publicFontLinkProblems(withoutRest, { rest: 'none' })).toEqual([]);
    expect(publicFontLinkProblems(withoutRest, { rest: 'body' })).toEqual([
      'links rest.css 0 times, not once',
    ]);
  });

  it('names a shared sheet linked late or out of order', () => {
    const lateFirst = GOOD_PAGE.replace(`<link rel="stylesheet" href="${first}">\n`, '').replace(
      '</head>',
      `<link rel="stylesheet" href="${first}">\n</head>`,
    );
    expect(publicFontLinkProblems(lateFirst, { rest: 'body' })).toEqual([
      'links first.css after the page stylesheet /page.css',
      'links first.css after a <style> element',
      'links stacks.css before first.css',
    ]);
    const firstInBody = GOOD_PAGE.replace(`<link rel="stylesheet" href="${first}">\n`, '').replace(
      '<p>Text</p>',
      `<p>Text</p><link rel="stylesheet" href="${first}">`,
    );
    expect(publicFontLinkProblems(firstInBody, { rest: 'body' })).toEqual([
      'links first.css outside the head',
      'links first.css after the page stylesheet /page.css',
      'links first.css after a <style> element',
      'links stacks.css before first.css',
    ]);
    const scriptAfterRest = GOOD_PAGE.replace('</body>', '<script src="/late.js"></script></body>');
    expect(publicFontLinkProblems(scriptAfterRest, { rest: 'body' })).toEqual([
      'links rest.css before a body script',
    ]);
    const twice = GOOD_PAGE.replace('</head>', `<link rel="stylesheet" href="${stacks}">\n</head>`);
    expect(publicFontLinkProblems(twice, { rest: 'body' })).toEqual([
      'links stacks.css 2 times, not once',
    ]);
  });

  it('names a font preload and every retired font link', () => {
    const retired = GOOD_PAGE.replace(
      '</head>',
      [
        '<link rel="preload" href="/designsystem/fonts/PretendardVariable.woff2" as="font" crossorigin>',
        '<link rel="stylesheet" href="/css/fonts/noto-jp.css" data-static-lang-font-codes="ja" disabled>',
        '<link rel="stylesheet" href="/assets/font-hangul-AbCdEfGh.css">',
        '<link rel="stylesheet" href="/assets/noto-arabic-AbCdEfGh.css">',
        '<link rel="preload" href="/assets/inter-latin-AbCdEfGh.woff2" as="font" crossorigin>',
        '</head>',
      ].join('\n'),
    );
    expect(publicFontLinkProblems(retired, { rest: 'body' })).toEqual([
      'preloads a font: /designsystem/fonts/PretendardVariable.woff2',
      expect.stringMatching(
        /^links a retired font sheet: <link rel="preload" href="\/designsystem/u,
      ),
      expect.stringMatching(
        /^links a retired font sheet: <link rel="stylesheet" href="\/css\/fonts/u,
      ),
      expect.stringMatching(
        /^links a retired font sheet: <link rel="stylesheet" href="\/assets\/font-hangul/u,
      ),
      expect.stringMatching(
        /^links a retired font sheet: <link rel="stylesheet" href="\/assets\/noto-arabic/u,
      ),
      'preloads a font: /assets/inter-latin-AbCdEfGh.woff2',
    ]);
  });

  it('names a page with no shared sheet, and reads no link inside a script or a comment', () => {
    expect(
      publicFontLinkProblems('<html><head></head><body></body></html>', { rest: 'body' }),
    ).toEqual([
      'links first.css 0 times, not once',
      'links stacks.css 0 times, not once',
      'links rest.css 0 times, not once',
    ]);
    expect(publicFontLinkProblems('<p>no head</p>', { rest: 'body' })).toEqual([
      'the page has no head',
    ]);
    const quoted = GOOD_PAGE.replace(
      '</head>',
      `<script>document.write('<link rel="stylesheet" href="${first}">')</script><!-- <link rel="preload" as="font" href="/x.woff2"> --></head>`,
    );
    expect(publicFontLinkProblems(quoted, { rest: 'body' })).toEqual([]);
  });
});

describe('the public font CSS check', () => {
  it('lets page CSS read a stack or inherit it, and name only device monospace', () => {
    expect(PUBLIC_TEXT_FONT_FAMILY).toBe(
      "var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)",
    );
    expect(
      publicFontCssProblems(
        [
          `body { font-family: ${PUBLIC_TEXT_FONT_FAMILY}; }`,
          '.name:lang(ja) { font-family: var(--font-sans-ja, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif); }',
          '.label { font-family: var(--font-sans); font: inherit; }',
          'button { font-family: inherit; }',
          'code { font-family: "SFMono-Regular", Consolas, monospace; }',
          ':root { --font-weight-title: 700; }',
          '@media (max-width: 640px) { .label { font-family: var(--font-sans-ui); } }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('names a face, a stack property, an unsafe stack reference and a literal family', () => {
    expect(
      publicFontCssProblems(
        [
          "@font-face { font-family: 'Pretendard'; src: url(p.woff2); }",
          ':root { --font-sans: Pretendard, sans-serif; --font-ui: var(--font-sans); }',
          '.a { font-family: var(--font-sans, Pretendard, sans-serif); }',
          ".b { font-family: 'Noto Sans JP', sans-serif; }",
          '.c { font: 700 14px Inter; }',
          ".d { font-family: 'Google Sans', Arial, sans-serif; }",
          ".e { font-family: 'Inter', monospace; }",
        ].join('\n'),
      ),
    ).toEqual([
      'declares @font-face',
      ':root sets the stack property --font-sans',
      ':root sets the stack property --font-ui',
      '.a reads var(--font-sans, Pretendard, sans-serif), not a stack with the system fallback',
      ".b names its own families ('Noto Sans JP', sans-serif)",
      ".c sets a family through 'font: 700 14px Inter'",
      ".d names its own families ('Google Sans', Arial, sans-serif)",
      ".e names its own families ('Inter', monospace)",
      'names Pretendard',
    ]);
  });

  it('allows a recorded literal family only for its own selector', () => {
    const css = ".d { font-family: 'Google Sans', Arial, sans-serif; }";
    const literals = { '.d': "Google's sign-in button" };
    expect(publicFontCssProblems(css, literals)).toEqual([]);
    expect(publicFontCssProblems(css.replace('.d', '.other'), literals)).toEqual([
      ".other names its own families ('Google Sans', Arial, sans-serif)",
    ]);
  });

  it('names Pretendard where it loads or names a font, not in a comment', () => {
    expect(
      publicFontCssProblems(
        "/* The line box is Pretendard's, which MUSIXQUARE Hangul keeps. */\nbody { line-height: 1.2; }",
      ),
    ).toEqual([]);
    expect(publicFontCssProblems('.logo { background: url(/pretendard-mark.svg); }')).toEqual([
      'names Pretendard',
    ]);
    expect(publicFontCssProblems("@import url('/css/pretendard.css');")).toEqual([
      'names Pretendard',
    ]);
  });
});

const ROOT = resolve('.');
const read = (file: string): string => readFileSync(resolve(ROOT, file), 'utf8');
const app = readFontStacks(ROOT);
const STACKS = 'public/web-fonts/stacks.css';
const TOKENS = 'public/designsystem/colors_and_type.css';

/** A registered page by its source HTML. */
function page(html: string): PublicFontPage {
  const found = PUBLIC_FONT_PAGES.find((candidate) => candidate.html === html);
  if (!found) throw new Error(`${html} is not a registered public font page`);
  return found;
}

/** The page's --font-sans equals the app's in each of its languages, through its own sheets. */
function expectAppStacks(registered: PublicFontPage): void {
  const chain = readFontStacks(ROOT, { sheets: [STACKS, ...registered.sheets] });
  for (const htmlLang of registered.htmlLangs) {
    const option = LANGUAGE_OPTIONS.find((candidate) => candidate.htmlLang === htmlLang);
    if (!option) throw new Error(`unknown html lang ${htmlLang}`);
    const state = { htmlLang, dir: languageDirection(option.code) };
    expect(chain.fontSans(state), `${registered.html} ${htmlLang} --font-sans`).toEqual(
      app.fontSans(state),
    );
  }
}

/** The rules of a page's sheets that apply in only one of the Korean and English pages. */
function koreanEnglishSplits(sheets: readonly string[]): { selector: string; rule: Rule }[] {
  const chain = readFontStacks(ROOT, { sheets: [STACKS, ...sheets] });
  return chain.rules.flatMap(({ selectors, rule }) =>
    selectors
      .filter((selector) => languageSplitTests(selector, 'ko', 'en').length > 0)
      .map((selector) => ({ selector, rule })),
  );
}

/** The app picker's stack for each language-name range (css/style.css). */
function appPickerStacks(): Map<string, string> {
  const stacks = new Map<string, string>();
  for (const { selectors, rule } of app.rules) {
    const family = rule.nodes.find((node) => node.type === 'decl' && node.prop === 'font-family');
    if (family?.type !== 'decl') continue;
    for (const selector of selectors) {
      const range = /^\.language-option-native:lang\(([^)]+)\)$/u.exec(selector)?.[1];
      if (range) {
        stacks.set(
          range.toLowerCase(),
          /^var\((--font-sans-[a-z-]+)\)$/u.exec(family.value)?.[1] ?? family.value,
        );
      }
    }
  }
  return stacks;
}

describe('About', () => {
  const SOURCE = '.workshop/landing/landing.html';
  const outputs = new Map<LanguageCode, string>();

  beforeAll(async () => {
    const asset = CLASSIC_RUNTIME_ASSETS.find(({ outputPath }) => outputPath === 'landing-i18n.js');
    if (!asset) throw new Error('landing-i18n.js is missing from the classic asset manifest');
    const landingI18n = (await compileClassicRuntimeAsset(ROOT, asset)).code;
    const source = read(SOURCE);
    for (const { code } of LANGUAGE_OPTIONS) {
      outputs.set(code, renderLocalizedAbout(source, landingI18n, code).html);
    }
  });

  it('links the shared font sheets as written, and nothing else that loads fonts', () => {
    const source = read(SOURCE);
    expect(page(SOURCE).rest).toBe('body');
    expect(publicFontLinkProblems(source, { rest: 'body' })).toEqual([]);
    for (const href of Object.values(PUBLIC_FONT_SHEET_URLS)) {
      // The build emits first.css and rest.css, so Vite must leave the links as written.
      expect(source).toMatch(
        new RegExp(`<link rel="stylesheet" href="${href}" vite-ignore />`, 'u'),
      );
    }
    expect(source).not.toMatch(/pretendard|\/css\/fonts\/|data-static-lang-font/iu);
  });

  it.each(LANGUAGE_OPTIONS.map(({ code }) => code))(
    'the %s copy links rest.css where its language needs it',
    (code) => {
      const html = outputs.get(code) ?? '';
      expect(
        publicFontLinkProblems(html, { rest: restFontSheetInHead(code) ? 'head' : 'body' }),
      ).toEqual([]);
    },
  );

  it('gives the Korean and English copies the same font links in the same places', () => {
    const fontLinks = (html: string) => {
      const headEnd = html.indexOf('</head>');
      return [...html.matchAll(/<link\b[^>]*href="(\/web-fonts\/[^"]+)"[^>]*>/gu)].map(
        (match) => `${match[1]} ${match.index < headEnd ? 'head' : 'body'}`,
      );
    };
    expect(fontLinks(outputs.get('ko') ?? '')).toEqual(fontLinks(outputs.get('en') ?? ''));
    expect(fontLinks(outputs.get('en') ?? '')).toEqual([
      `${PUBLIC_FONT_SHEET_URLS.first} head`,
      `${PUBLIC_FONT_SHEET_URLS.stacks} head`,
      `${PUBLIC_FONT_SHEET_URLS.rest} body`,
    ]);
  });

  it("reads the app's stacks in every language, with no face or stack of its own", () => {
    const about = page(SOURCE);
    expect(about.sheets).toEqual([
      TOKENS,
      'public/editorial-base.css',
      'public/static-language.css',
      'public/editorial-about.css',
      'public/editorial-rtl.css',
    ]);
    expect(about.htmlLangs).toEqual(LANGUAGE_OPTIONS.map(({ htmlLang }) => htmlLang));
    for (const sheet of about.sheets) expect(publicFontCssProblems(read(sheet)), sheet).toEqual([]);
    for (const style of inlineStyles(read(SOURCE)))
      expect(publicFontCssProblems(style)).toEqual([]);
    expectAppStacks(about);
    for (const sheet of ['public/editorial-base.css', TOKENS]) {
      expect(read(sheet), sheet).toMatch(
        /\nbody \{[^}]*font-family: var\(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif\);/u,
      );
    }
  });

  it('draws form controls with the page text, not the browser default family', () => {
    // A browser gives button, input, select and textarea its own default
    // family (Arial on Windows); the token sheet makes them inherit the page's.
    const controls: string[] = [];
    postcss.parse(read(TOKENS)).walkRules((rule) => {
      if ([...rule.selectors].sort().join(',') !== 'button,input,select,textarea') return;
      if (rule.parent?.type !== 'root') return;
      rule.walkDecls('font-family', (declaration) => {
        controls.push(declaration.value);
      });
    });
    expect(controls).toEqual(['inherit']);
  });

  it('tells the Korean and English pages apart only in the recorded copy rules, never by tracking', () => {
    const splits = koreanEnglishSplits(page(SOURCE).sheets);
    expect([...new Set(splits.map(({ selector }) => selector))].sort()).toEqual(
      Object.keys(PUBLIC_KOREAN_ENGLISH_COPY_RULES).sort(),
    );
    // The app draws Korean and English alike since 9.0.29: no Korean-only tracking.
    for (const { selector, rule } of splits) {
      const tracking = rule.nodes.filter(
        (node) => node.type === 'decl' && node.prop === 'letter-spacing',
      );
      expect(tracking, selector).toEqual([]);
    }
  });

  it("draws each language name with the stack the app's picker gives it", () => {
    const appPicker = appPickerStacks();
    expect(appPicker.size).toBe(16);
    const names = readFontStacks(ROOT, { sheets: ['public/static-language.css'] });
    const pagePicker = new Map<string, Set<string>>();
    for (const { selectors, rule } of names.rules) {
      const family = rule.nodes.find((node) => node.type === 'decl' && node.prop === 'font-family');
      if (family?.type !== 'decl') continue;
      for (const selector of selectors) {
        const match = /^\.static-lang-(?:option__native|trigger__label):lang\(([^)]+)\)$/u.exec(
          selector,
        );
        expect(match, selector).not.toBeNull();
        const range = (match?.[1] ?? '').toLowerCase();
        expect(family.value.replace(/\s+/gu, ' '), selector).toMatch(
          /^var\(--font-sans-[a-z-]+, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif\)$/u,
        );
        const stack = /^var\((--font-sans-[a-z-]+),/u.exec(family.value)?.[1] ?? family.value;
        const kinds = pagePicker.get(range) ?? new Set<string>();
        kinds.add(`${selector.includes('trigger') ? 'trigger' : 'option'} ${stack}`);
        pagePicker.set(range, kinds);
      }
    }
    expect([...pagePicker.keys()].sort()).toEqual([...appPicker.keys()].sort());
    for (const [range, stack] of appPicker) {
      expect([...(pagePicker.get(range) ?? [])].sort(), range).toEqual([
        `option ${stack}`,
        `trigger ${stack}`,
      ]);
    }
  });

  it('takes the closed language menu out of layout, so its names fetch no font until it opens', () => {
    // Every face is declared on the page, so text that is laid out fetches
    // its font even at opacity 0: the closed menu's 42 native names would
    // pull every script face on each visit. display: none builds no boxes in
    // any engine, unlike content-visibility, which some engines lack.
    const css = postcss.parse(read('public/static-language.css'));
    const declarations = (selector: string, property: string, inStartingStyle = false) => {
      const values: string[] = [];
      css.walkRules((rule) => {
        if (!rule.selectors.includes(selector)) return;
        const startingStyle =
          rule.parent?.type === 'atrule' && (rule.parent as AtRule).name === 'starting-style';
        if (startingStyle !== inStartingStyle) return;
        rule.walkDecls(property, (declaration) => {
          values.push(declaration.value.replace(/\s+/gu, ' ').trim());
        });
      });
      return values;
    };
    const OPEN = '.static-lang-picker.is-open .static-lang-menu';
    expect(declarations('.static-lang-menu', 'display')).toEqual(['none']);
    expect(declarations(OPEN, 'display')).toEqual(['grid']);
    expect(declarations('.static-lang-menu', 'content-visibility')).toEqual([]);
    // The close fade keeps the menu laid out until it ends, on desktop and
    // phone; a browser without allow-discrete keeps the first declaration and
    // closes at once.
    const closed = declarations('.static-lang-menu', 'transition');
    expect(closed.filter((value) => /\bdisplay \d+ms allow-discrete\b/u.test(value))).toHaveLength(
      2,
    );
    // Opening lays the names out at once, so openPicker can move focus to the
    // selected one in the next frame: the open state names its own
    // transitions, without display, and fades in from its starting style.
    const open = declarations(OPEN, 'transition');
    expect(open, 'desktop and phone open-state transitions').toHaveLength(2);
    for (const value of open) expect(value).not.toMatch(/display|content-visibility/u);
    expect(declarations(OPEN, 'opacity', true)).toEqual(['0']);
  });

  it('loads no font from its scripts', () => {
    for (const file of [
      'browser/classic-runtime/static-language.ts',
      'browser/classic-runtime/landing-bootstrap.ts',
      'browser/classic-runtime/landing-i18n.ts',
      '.workshop/landing/main.ts',
    ]) {
      expect(read(file), file).not.toMatch(
        /ensureFont|ensurePickerFonts|FONT_STYLESHEET|\/css\/fonts\/|data-static-lang-font|document\.fonts|new FontFace|createElement\(\s*['"]link['"]\s*\)/u,
      );
    }
  });
});
