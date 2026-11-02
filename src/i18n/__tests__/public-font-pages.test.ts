/**
 * The font contract of the pages outside the app (scripts/lib/public-font-pages.mts):
 * every page links /web-fonts/first.css and /web-fonts/stacks.css in its
 * head before its own stylesheets, and /web-fonts/rest.css after its last
 * body script (in the head for a page whose language needs those faces
 * first, and not at all where a page's scripts must not wait for it), loads
 * fonts no other way, and its stylesheets declare no face and set no stack,
 * so it reads the app's stacks. These fixtures pin each departure the checks
 * report; the page cases follow with each page group.
 */
import { describe, expect, it } from 'vitest';

import {
  PUBLIC_TEXT_FONT_FAMILY,
  publicFontCssProblems,
  publicFontLinkProblems,
} from '../../../scripts/lib/public-font-pages.mts';
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
