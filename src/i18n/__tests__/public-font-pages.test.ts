/**
 * The font contract of the pages outside the app (scripts/lib/public-font-pages.mts):
 * every page links /web-fonts/first.css and /web-fonts/stacks.css in its
 * head before its own stylesheets, and /web-fonts/rest.css after its last
 * body script (in the head for a page whose language needs those faces
 * first, and not at all where a page's scripts must not wait for it), loads
 * fonts no other way, and its stylesheets declare no face and set no stack,
 * so it reads the app's stacks. These fixtures pin each departure the checks
 * report; the page cases follow, one group of pages at a time. The sign-in
 * completion page is the app's, not a public page: its script adds the
 * shared sheets, and it is tested with it (src/ui/__tests__/account-complete.test.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import postcss, { type AtRule, type Rule } from 'postcss';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CLASSIC_RUNTIME_ASSETS,
  compileClassicRuntimeAsset,
} from '../../../scripts/classic-runtime-assets.ts';
import { readFontStacks } from '../../../scripts/fonts/font-stacks.mts';
import { languageSplitTests } from '../../../scripts/lib/app-font-guard.mts';
import {
  PUBLIC_FONT_PAGE_EXCLUSIONS,
  PUBLIC_FONT_PAGES,
  PUBLIC_KOREAN_ENGLISH_COPY_RULES,
  PUBLIC_LITERAL_FONT_FAMILIES,
  PUBLIC_TEXT_FONT_FAMILY,
  PUBLIC_WORKER_FONT_PAGES,
  inlineStyles,
  listPageSources,
  publicFontCssProblems,
  publicFontLinkProblems,
  type PublicFontPage,
  unlistedBuiltPages,
  unlistedPageSources,
} from '../../../scripts/lib/public-font-pages.mts';
import { renderLocalizedAbout } from '../../../scripts/localized-html-lib.mts';
import { LANGUAGE_OPTIONS, languageDirection, type LanguageCode } from '../locales.ts';
import { restFontSheetInHead } from '../public-font-contract.ts';
import { PUBLIC_FONT_SHEET_URLS, PUBLIC_HAN_ORDER_SCRIPT_URL } from '../public-font-urls.ts';

const { first, stacks, rest } = PUBLIC_FONT_SHEET_URLS;

const HAN_ORDER_SCRIPT = `<script src="${PUBLIC_HAN_ORDER_SCRIPT_URL}"></script>`;

const GOOD_PAGE = `<!doctype html><html><head>
<link rel="icon" href="/favicon.svg">
${HAN_ORDER_SCRIPT}
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

  it("names a missing, late, deferred or misplaced script for the app's Han order", () => {
    const without = GOOD_PAGE.replace(`${HAN_ORDER_SCRIPT}\n`, '');
    expect(publicFontLinkProblems(without, { rest: 'body' })).toEqual([
      'loads /han-order.js 0 times, not once',
    ]);
    const late = without.replace('</head>', `${HAN_ORDER_SCRIPT}\n</head>`);
    expect(publicFontLinkProblems(late, { rest: 'body' })).toEqual([
      'loads /han-order.js after first.css',
    ]);
    for (const attribute of ['defer', 'async', 'type="module"']) {
      const deferred = GOOD_PAGE.replace(
        HAN_ORDER_SCRIPT,
        `<script ${attribute} src="${PUBLIC_HAN_ORDER_SCRIPT_URL}"></script>`,
      );
      expect(publicFontLinkProblems(deferred, { rest: 'body' }), attribute).toEqual([
        'loads /han-order.js after the first paint, not as a blocking classic script',
      ]);
    }
    const inBody = without.replace('<p>Text</p>', `${HAN_ORDER_SCRIPT}<p>Text</p>`);
    expect(publicFontLinkProblems(inBody, { rest: 'body' })).toEqual([
      'loads /han-order.js outside the head',
      'loads /han-order.js after first.css',
    ]);
    const twice = GOOD_PAGE.replace('</head>', `${HAN_ORDER_SCRIPT}\n</head>`);
    expect(publicFontLinkProblems(twice, { rest: 'body' })).toEqual([
      'loads /han-order.js 2 times, not once',
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
      'loads /han-order.js 0 times, not once',
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

  it('allows a recorded literal stack composed of the app tokens only for its own selector', () => {
    const css = '.k { font-family: var(--font-primary), var(--font-cjk-ko), var(--font-system); }';
    const literals = { '.k': 'a specimen in one Han order' };
    expect(publicFontCssProblems(css, literals)).toEqual([]);
    expect(publicFontCssProblems(css.replace('.k', '.other'), literals)).toEqual([
      '.other reads var(--font-primary), var(--font-cjk-ko), var(--font-system), not a stack with the system fallback',
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
      Object.keys(PUBLIC_KOREAN_ENGLISH_COPY_RULES)
        .filter((selector) => !/policy-hero h1|policy-doc h2/u.test(selector))
        .sort(),
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

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const file = join(directory, entry);
    if (statSync(file).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(file);
    return /\.(?:ts|mts|tsx)$/u.test(entry) ? [file] : [];
  });
}

/** A stylesheet's font-family stacks by the language each rule names, read by a pattern. */
function stacksByLanguage(sheet: string, selectorPattern: RegExp): Map<string, string> {
  const stacks = new Map<string, string>();
  for (const { selectors, rule } of readFontStacks(ROOT, { sheets: [sheet] }).rules) {
    const family = rule.nodes.find((node) => node.type === 'decl' && node.prop === 'font-family');
    if (family?.type !== 'decl') continue;
    for (const selector of selectors) {
      const language = selectorPattern.exec(selector)?.[1];
      if (!language) continue;
      expect(family.value.replace(/\s+/gu, ' '), selector).toMatch(
        /^var\(--font-sans-[a-z-]+, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif\)$/u,
      );
      stacks.set(
        language.toLowerCase(),
        /^var\((--font-sans-[a-z-]+),/u.exec(family.value)?.[1] ?? family.value,
      );
    }
  }
  return stacks;
}

describe('the document pages, translate and the sitemap', () => {
  const PAGES = [
    '.workshop/privacy/privacy.html',
    '.workshop/terms/terms.html',
    '.workshop/faq/faq.html',
    '.workshop/developers/developers.html',
    '.workshop/translate/translate.html',
    '.workshop/sitemap/sitemap.html',
  ] as const;

  it.each(PAGES)(
    '%s links the shared font sheets as written, rest.css after its last script',
    (source) => {
      const html = read(source);
      expect(page(source).rest).toBe('body');
      expect(publicFontLinkProblems(html, { rest: 'body' })).toEqual([]);
      for (const href of Object.values(PUBLIC_FONT_SHEET_URLS)) {
        expect(html).toMatch(
          new RegExp(`<link rel="stylesheet" href="${href}" vite-ignore />`, 'u'),
        );
      }
      expect(html).not.toMatch(/pretendard|\/css\/fonts\//iu);
    },
  );

  it.each(PAGES)("%s reads the app's stacks, with no face or stack of its own", (source) => {
    const registered = page(source);
    expect(registered.sheets[0]).toBe('public/legal-pages.css');
    expect(registered.htmlLangs).toEqual(['en']);
    for (const sheet of registered.sheets) {
      expect(publicFontCssProblems(read(sheet)), sheet).toEqual([]);
    }
    for (const style of inlineStyles(read(source)))
      expect(publicFontCssProblems(style)).toEqual([]);
    expectAppStacks(registered);
    const splits = koreanEnglishSplits(registered.sheets);
    for (const { selector, rule } of splits) {
      expect(selector in PUBLIC_KOREAN_ENGLISH_COPY_RULES, selector).toBe(true);
      expect(
        rule.nodes.filter((node) => node.type === 'decl' && node.prop === 'letter-spacing'),
        selector,
      ).toEqual([]);
    }
  });

  it('keeps the root text of the document pages on the shared stack', () => {
    expect(read('public/legal-pages.css')).toMatch(
      /html,\nbody \{[^}]*font-family: var\(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif\);/u,
    );
  });

  it("draws each sitemap language name with the stack the app's picker gives it", () => {
    const picker = appPickerStacks();
    const expected = new Map(
      LANGUAGE_OPTIONS.flatMap(({ code }) => {
        const stack = picker.get(code);
        return stack ? [[code, stack] as const] : [];
      }),
    );
    const names = stacksByLanguage(
      '.workshop/sitemap/sitemap.css',
      /^\[data-locale='([^']+)'\] \.native-name$/u,
    );
    expect(Object.fromEntries([...names].sort())).toEqual(Object.fromEntries([...expected].sort()));
  });

  it('gives translate text in a catalog language the stack the app gives that language', () => {
    const cells = stacksByLanguage(
      '.workshop/translate/translate.css',
      /^\[lang\]:lang\(([^)]+)\)$/u,
    );
    expect(Object.fromEntries([...cells].sort())).toEqual(
      Object.fromEntries([...appPickerStacks()].sort()),
    );
  });

  it('loads no font from a page script, and the app font owner is the only stylesheet loader', () => {
    for (const file of ['.workshop/sitemap/main.ts', '.workshop/translate/main.ts']) {
      expect(read(file), file).not.toMatch(
        /static-page-fonts|locale-font-contract|loadLocaleFont|document\.fonts|new FontFace|createElement\(\s*['"]link['"]\s*\)/u,
      );
    }
    for (const retired of ['src/i18n/static-page-fonts.ts', 'src/i18n/locale-font-contract.ts']) {
      expect(existsSync(resolve(ROOT, retired)), retired).toBe(false);
    }
    const importers = ['src', '.workshop', 'browser']
      .flatMap((directory) => sourceFiles(resolve(ROOT, directory)))
      .filter((file) => !/[\\/]__tests__[\\/]/u.test(file))
      .filter((file) => /retryable-stylesheet/u.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file).replace(/\\/gu, '/'));
    expect(importers.sort()).toEqual(['src/i18n/locale-fonts.ts']);
  });
});

const DESIGN_PREVIEWS = readdirSync(resolve(ROOT, 'public/designsystem/preview'))
  .filter((name) => name.endsWith('.html'))
  .sort()
  .map((name) => `public/designsystem/preview/${name}`);

describe('the blog, history, design system, UI kit, events and 404 pages', () => {
  const EDITORIAL = 'public/editorial-base.css';
  const PAGES: readonly PublicFontPage[] = [
    {
      html: 'public/blog/index.html',
      dist: 'blog/index.html',
      rest: 'body',
      sheets: [TOKENS, EDITORIAL],
      htmlLangs: ['en'],
    },
    {
      html: 'public/history/index.html',
      dist: 'history/index.html',
      rest: 'body',
      sheets: [TOKENS, EDITORIAL, 'public/editorial-history.css'],
      htmlLangs: ['en'],
    },
    {
      html: 'public/designsystem/index.html',
      dist: 'designsystem/index.html',
      rest: 'body',
      sheets: [TOKENS, EDITORIAL, 'public/editorial-design.css'],
      htmlLangs: ['en'],
    },
    ...DESIGN_PREVIEWS.map((html) => ({
      html,
      dist: html.replace(/^public\//u, ''),
      rest: 'body' as const,
      sheets: [TOKENS],
      htmlLangs: ['en'],
    })),
    {
      // Served in development only; the production build leaves it out.
      html: 'browser/ui-kit/static/app/index.html',
      dist: null,
      rest: 'body',
      sheets: [TOKENS, 'browser/ui-kit/static/app/app.css'],
      htmlLangs: ['en'],
    },
    {
      // PRO sign-in: its deferred scripts wait for every stylesheet the
      // parser added, so it links no rest.css.
      html: 'public/events/index.html',
      dist: 'events/index.html',
      rest: 'none',
      sheets: ['public/events/event.css'],
      htmlLangs: ['ko', 'en'],
    },
    {
      html: 'public/404.html',
      dist: '404.html',
      rest: 'body',
      sheets: [],
      htmlLangs: ['en'],
    },
  ];
  const SOURCES = PAGES.map(({ html }) => html);

  it('covers every design-system preview', () => {
    expect(DESIGN_PREVIEWS).toHaveLength(21);
  });

  it.each(SOURCES)('%s is registered and links the shared font sheets', (source) => {
    const expected = PAGES.find(({ html }) => html === source);
    expect(page(source)).toEqual(expected);
    expect(publicFontLinkProblems(read(source), { rest: page(source).rest })).toEqual([]);
  });

  it.each(SOURCES)("%s reads the app's stacks, with no face or stack of its own", (source) => {
    const registered = page(source);
    for (const sheet of registered.sheets) {
      expect(publicFontCssProblems(read(sheet), PUBLIC_LITERAL_FONT_FAMILIES), sheet).toEqual([]);
    }
    for (const style of inlineStyles(read(source))) {
      expect(publicFontCssProblems(style), `${source} <style>`).toEqual([]);
    }
    expectAppStacks(registered);
    for (const { selector, rule } of koreanEnglishSplits(registered.sheets)) {
      expect(selector in PUBLIC_KOREAN_ENGLISH_COPY_RULES, selector).toBe(true);
      expect(
        rule.nodes.filter((node) => node.type === 'decl' && node.prop === 'letter-spacing'),
        selector,
      ).toEqual([]);
    }
  });

  it('keeps the root text of each page on the shared stack with the system fallback', () => {
    const shared =
      /font-family: var\(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif\);/u;
    for (const file of ['public/events/event.css', 'public/404.html', 'public/blog/index.html']) {
      expect(read(file), file).toMatch(shared);
    }
    expect(read('public/events/event.css')).toMatch(
      /\nbody \{[^}]*font-family: var\(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif\);/u,
    );
  });

  it('lets only Google sign-in and the Korean 述 specimen name their own families', () => {
    // Google's button keeps its brand families; the scripts they lack (the
    // Korean label) draw with the shared stack, not a device face. The design
    // system's Korean 述 cell composes the app's Korean-first stack
    // (src/ui/__tests__/design-system-typography-stacks.test.ts).
    expect(Object.keys(PUBLIC_LITERAL_FONT_FAMILIES)).toEqual([
      '.google-button',
      '#typography .typo-han-ko',
    ]);
    const google: string[] = [];
    postcss.parse(read('public/events/event.css')).walkRules('.google-button', (rule) => {
      rule.walkDecls('font-family', (declaration) => {
        google.push(declaration.value.replace(/\s+/gu, ' ').trim());
      });
    });
    expect(google).toEqual([
      "'Google Sans', Arial, var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)",
    ]);
  });

  it("draws the sign-in completion page with the app's faces through its script, not its links", () => {
    // public/account-complete.html belongs to the app (src/ui/account.ts and
    // the service worker's install list), and its deferred script tells the
    // app the sign-in finished, which a linked sheet would hold back. So it
    // links no shared sheet: the script adds them once its message is out
    // (src/ui/__tests__/account-complete.test.ts), and its own sheet is held
    // to the public sheets' rules and reads the app's stacks in every UI
    // language the window shows.
    expect(PUBLIC_FONT_PAGES.map(({ html }) => html)).not.toContain('public/account-complete.html');
    expect(read('public/account-complete.html')).not.toMatch(/\/web-fonts\/|\/han-order\.js/u);
    const completion = PUBLIC_FONT_PAGE_EXCLUSIONS.find(
      ({ html }) => html === 'public/account-complete.html',
    );
    expect(completion?.sheet).toBe('public/account-complete.css');
    const sheet = completion?.sheet ?? '';
    expect(publicFontCssProblems(read(sheet), PUBLIC_LITERAL_FONT_FAMILIES)).toEqual([]);
    expectAppStacks({
      html: 'public/account-complete.html',
      dist: null,
      rest: 'none',
      sheets: [sheet],
      htmlLangs: LANGUAGE_OPTIONS.map(({ htmlLang }) => htmlLang),
    });
    expect(koreanEnglishSplits([sheet])).toEqual([]);
    // The other exceptions load their own fonts and name no sheet.
    expect(
      PUBLIC_FONT_PAGE_EXCLUSIONS.filter(({ sheet: own }) => own !== undefined).map(
        ({ html }) => html,
      ),
    ).toEqual(['public/account-complete.html']);
  });
});

describe('the pages the App Worker renders', () => {
  // cloudflare/app-worker.ts renders the admin page and the blog article's
  // fallback itself; src/core/__tests__/app-worker-cors.test.ts checks their
  // links, and these cases their sheets.
  it('lists the admin page and the blog article with their sheets', () => {
    expect(
      PUBLIC_WORKER_FONT_PAGES.map(({ sheets, htmlLangs }) => ({ sheets, htmlLangs })),
    ).toEqual([
      { sheets: ['public/admin.css'], htmlLangs: ['en'] },
      { sheets: [TOKENS, 'public/editorial-base.css'], htmlLangs: ['en'] },
    ]);
  });

  it.each(PUBLIC_WORKER_FONT_PAGES.map(({ name }) => name))(
    "%s reads the app's stacks, with no face or stack of its own",
    (name) => {
      const worker = PUBLIC_WORKER_FONT_PAGES.find((candidate) => candidate.name === name);
      if (!worker) throw new Error(`${name} is not listed`);
      for (const sheet of worker.sheets) {
        expect(publicFontCssProblems(read(sheet), PUBLIC_LITERAL_FONT_FAMILIES), sheet).toEqual([]);
      }
      expectAppStacks({
        html: name,
        dist: null,
        rest: 'body',
        sheets: worker.sheets,
        htmlLangs: worker.htmlLangs,
      });
      for (const { selector, rule } of koreanEnglishSplits(worker.sheets)) {
        expect(selector in PUBLIC_KOREAN_ENGLISH_COPY_RULES, selector).toBe(true);
        expect(
          rule.nodes.filter((node) => node.type === 'decl' && node.prop === 'letter-spacing'),
          selector,
        ).toEqual([]);
      }
    },
  );

  it('keeps the admin text on the shared stack with the system fallback', () => {
    expect(read('public/admin.css')).toMatch(
      /\n:root \{[^}]*font-family: var\(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif\);/u,
    );
  });
});

describe('every page source and built page is a registered public page or a recorded exception', () => {
  // A new page outside the app must join PUBLIC_FONT_PAGES (and so load the
  // shared sheets and /han-order.js) or say in PUBLIC_FONT_PAGE_EXCLUSIONS
  // why it does not.
  it('names a page source that is neither, and accepts the registered and recorded ones', () => {
    expect(
      unlistedPageSources([
        'public/stray.html',
        '.workshop/stray/stray.html',
        'public/blog/index.html',
        '.workshop/landing/landing.html',
        'browser/ui-kit/static/app/index.html',
        'index.html',
        'public/account-complete.html',
        'public/screensaver.html',
      ]),
    ).toEqual(['public/stray.html', '.workshop/stray/stray.html']);
  });

  it('finds every page source of the repository registered or recorded', async () => {
    const sources = await listPageSources(resolve('.'));
    expect(sources).toContain('index.html');
    expect(sources).toContain('public/designsystem/preview/_shell.html');
    expect(sources).toContain('.workshop/translate/translate.html');
    expect(sources).toContain('browser/ui-kit/static/app/index.html');
    expect(unlistedPageSources(sources)).toEqual([]);
  });

  it('names a built page that comes from neither, and accepts every copy the build writes', () => {
    const copies = LANGUAGE_OPTIONS.flatMap(({ code }) =>
      code === 'en' ? ['index.html', 'about.html'] : [`${code}/index.html`, `${code}/about.html`],
    );
    expect(
      unlistedBuiltPages([
        'stray.html',
        'ko/stray.html',
        ...copies,
        'blog/index.html',
        'designsystem/preview/type-scale.html',
        'account-complete.html',
        'screensaver.html',
        '404.html',
      ]),
    ).toEqual(['stray.html', 'ko/stray.html']);
  });

  it('gives each recorded exception a reason, and none is also registered', () => {
    expect(PUBLIC_FONT_PAGE_EXCLUSIONS.map(({ html }) => html)).toEqual([
      'index.html',
      'public/account-complete.html',
      'public/screensaver.html',
    ]);
    for (const { html, dist, reason } of PUBLIC_FONT_PAGE_EXCLUSIONS) {
      expect(existsSync(html), html).toBe(true);
      expect(reason.length, html).toBeGreaterThan(20);
      expect(dist.length, html).toBeGreaterThan(0);
      expect(PUBLIC_FONT_PAGES.map((page) => page.html)).not.toContain(html);
      // None links the shared sheets or the Han order script in its HTML.
      expect(read(html), html).not.toMatch(/\/web-fonts\/|\/han-order\.js/u);
    }
  });
});
