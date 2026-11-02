/**
 * The font contract of every page outside the app (the public pages): About
 * and its sibling pages, the blog and its articles, history, the design
 * system with its previews and UI kit, events, admin and 404. They draw text
 * with the app's faces (Inter, MUSIXQUARE Hangul and Noto) and the app's
 * stacks, and load them one way:
 * - in the head, before the page's own stylesheets and <style> elements:
 *   /web-fonts/first.css (the faces of Inter, MUSIXQUARE Hangul and Noto Sans
 *   KR) and /web-fonts/stacks.css (the app's stack properties,
 *   public/web-fonts/stacks.css);
 * - /web-fonts/rest.css (every other app face) after the last body script,
 *   in the head where the page's language needs those faces on the first
 *   paint, or not at all where the page's own scripts must not wait for it
 *   (deferred and module scripts wait for the stylesheets the parser added
 *   before them);
 * - no other font sheet, no font preload, no script that loads fonts;
 * - /han-order.js, a blocking classic script in the head before first.css,
 *   which marks the app's Han order on the root from the browser's
 *   languages (browser/classic-runtime/han-order.ts), as the app does;
 * - page CSS declares no @font-face and sets no font stack property; text
 *   reads a stack (var(--font-sans...), with the system fallback when one is
 *   given) or inherits it, and only device monospace for code and the
 *   recorded literals name a family; nothing that loads or names a font
 *   names Pretendard (a comment may credit it).
 * The URLs are src/i18n/public-font-urls.ts. The pure checks and the page
 * list live here; scripts/check-app-font.mts runs them over the source and
 * the build, and the page tests run them over each page.
 */
import postcss, { type Rule } from 'postcss';

import { LANGUAGE_OPTIONS } from '../../src/i18n/locales.ts';
import {
  PUBLIC_FONT_SHEET_URLS,
  PUBLIC_HAN_ORDER_SCRIPT_URL,
} from '../../src/i18n/public-font-urls.ts';

/** The system fallback a stack reference names, should stacks.css fail to load. */
const SYSTEM_FONT_FALLBACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

/** A public page's root text declaration: the shared stack, then the system fonts. */
export const PUBLIC_TEXT_FONT_FAMILY = `var(--font-sans, ${SYSTEM_FONT_FALLBACK})`;

/**
 * Font links that a public page may no longer carry: Pretendard, the
 * original Google sheets, the app's own hashed sheets by name, and About's
 * retired locale links.
 */
const RETIRED_FONT_LINK =
  /pretendard|\/css\/fonts\/|\/assets\/(?:font-)?noto-[a-z]+-|\/assets\/font-(?:inter|hangul)-|data-static-lang-font/iu;

function mask(html: string): string {
  // Comments, scripts and styles keep their length so indexes stay valid.
  return html.replace(
    /<!--[\s\S]*?-->|(<(script|style|noscript|template)\b[^>]*>)([\s\S]*?)(<\/\2>)/giu,
    (match, open?: string, _name?: string, body?: string, close?: string) =>
      open === undefined
        ? ' '.repeat(match.length)
        : `${open}${' '.repeat(body?.length ?? 0)}${close ?? ''}`,
  );
}

function attribute(tag: string, name: string): string | null {
  return (
    new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu')
      .exec(tag)
      ?.slice(1)
      .find((value) => value !== undefined) ?? null
  );
}

function relTokens(tag: string): string[] {
  return (attribute(tag, 'rel') ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
}

interface PublicFontLinkOptions {
  /**
   * Where the page links rest.css: after its last body script, in the head
   * (its language needs those faces on the first paint), or nowhere (its own
   * scripts must not wait for the sheet).
   */
  readonly rest: 'body' | 'head' | 'none';
}

/** What is wrong with a public page's font links, or an empty list. */
export function publicFontLinkProblems(html: string, options: PublicFontLinkOptions): string[] {
  const problems: string[] = [];
  const masked = mask(html);
  const headEnd = masked.search(/<\/head\s*>|<body\b/iu);
  if (headEnd < 0) return ['the page has no head'];
  const links = [...masked.matchAll(/<link\b[^>]*>/giu)].map((match) => ({
    tag: match[0],
    index: match.index,
    href: attribute(match[0], 'href') ?? '',
    rel: relTokens(match[0]),
  }));
  const stylesheets = links.filter(({ rel }) => rel.includes('stylesheet'));
  const firstStyle = masked.search(/<style\b/iu);

  for (const { tag, href, rel } of links) {
    if (rel.includes('preload') && (attribute(tag, 'as') ?? '').toLowerCase() === 'font') {
      problems.push(`preloads a font: ${href}`);
    }
    if (RETIRED_FONT_LINK.test(tag)) problems.push(`links a retired font sheet: ${tag}`);
  }
  const named = (target: string) => stylesheets.filter(({ href }) => href === target);
  const first = named(PUBLIC_FONT_SHEET_URLS.first);
  const stacks = named(PUBLIC_FONT_SHEET_URLS.stacks);
  const rest = named(PUBLIC_FONT_SHEET_URLS.rest);
  for (const [label, found] of [
    ['first.css', first],
    ['stacks.css', stacks],
  ] as const) {
    if (found.length !== 1) problems.push(`links ${label} ${found.length} times, not once`);
  }
  if (options.rest === 'none') {
    if (rest.length > 0) problems.push('links rest.css, which this page must not');
  } else if (rest.length !== 1) {
    problems.push(`links rest.css ${rest.length} times, not once`);
  }
  const shared: readonly string[] = Object.values(PUBLIC_FONT_SHEET_URLS);
  const ownSheets = stylesheets.filter(({ href }) => !shared.includes(href));
  for (const [label, found] of [
    ['first.css', first[0]],
    ['stacks.css', stacks[0]],
  ] as const) {
    if (!found) continue;
    if (found.index > headEnd) problems.push(`links ${label} outside the head`);
    const before = ownSheets.find(({ index }) => index < found.index);
    if (before) problems.push(`links ${label} after the page stylesheet ${before.href}`);
    if (firstStyle >= 0 && firstStyle < found.index) {
      problems.push(`links ${label} after a <style> element`);
    }
  }
  if (first[0] && stacks[0] && first[0].index > stacks[0].index) {
    problems.push('links stacks.css before first.css');
  }
  const restLink = rest[0];
  if (restLink && options.rest === 'head' && restLink.index > headEnd) {
    problems.push('links rest.css in the body, not the head');
  }
  if (restLink && options.rest === 'body') {
    if (restLink.index < headEnd) {
      problems.push('links rest.css in the head, not the body');
    } else if (masked.slice(restLink.index).search(/<script\b/iu) >= 0) {
      problems.push('links rest.css before a body script');
    }
  }

  const hanOrder = [...masked.matchAll(/<script\b[^>]*>/giu)].filter(
    (match) => attribute(match[0], 'src') === PUBLIC_HAN_ORDER_SCRIPT_URL,
  );
  if (hanOrder.length !== 1) {
    problems.push(`loads ${PUBLIC_HAN_ORDER_SCRIPT_URL} ${hanOrder.length} times, not once`);
  } else if (hanOrder[0]) {
    const { 0: tag, index } = hanOrder[0];
    if (index > headEnd) problems.push(`loads ${PUBLIC_HAN_ORDER_SCRIPT_URL} outside the head`);
    if (
      /\s(?:defer|async)(?=[\s=>/])/iu.test(tag) ||
      (attribute(tag, 'type') ?? '').toLowerCase() === 'module'
    ) {
      problems.push(
        `loads ${PUBLIC_HAN_ORDER_SCRIPT_URL} after the first paint, not as a blocking classic script`,
      );
    }
    if (first[0] && first[0].index < index) {
      problems.push(`loads ${PUBLIC_HAN_ORDER_SCRIPT_URL} after first.css`);
    }
  }
  return problems;
}

/** A literal family list that names only device monospace fonts, for code. */
function isDeviceMonospace(families: readonly string[]): boolean {
  return (
    families.at(-1) === 'monospace' &&
    families.every(
      (family) => !/^(?:Inter|MUSIXQUARE Hangul|Noto Sans.*|Pretendard.*)$/iu.test(family),
    )
  );
}

function familiesOf(value: string): string[] {
  return value
    .split(',')
    .map((family) => family.trim().replace(/^(['"])(.*)\1$/su, '$2'))
    .filter(Boolean);
}

const normalize = (value: string): string =>
  value
    .replace(/\s+/gu, ' ')
    .replace(/"/gu, "'")
    .replace(/\(\s+/gu, '(')
    .replace(/\s+\)/gu, ')')
    .trim();

const STACK_REFERENCE = new RegExp(
  `^var\\(--font-sans(?:-[a-z-]+)?(?:, ${normalize(SYSTEM_FONT_FALLBACK).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')})?\\)$`,
  'u',
);

/** Literal font families a public page may set, by selector, with the reason. */
type LiteralFontFamilies = Readonly<Record<string, string>>;

/**
 * The recorded literal families of the public pages: a brand's own font,
 * never the pages' text, and each ends with the shared stack for the
 * scripts the brand font lacks.
 */
export const PUBLIC_LITERAL_FONT_FAMILIES: LiteralFontFamilies = {
  '.google-button': "Google's sign-in button follows Google's branding rules",
};

/**
 * What is wrong with the font rules of a public page's stylesheet (or of an
 * inline <style> block), or an empty list. Literal families are allowed for
 * device monospace and for the selectors in `literals`.
 */
export function publicFontCssProblems(css: string, literals: LiteralFontFamilies = {}): string[] {
  const problems: string[] = [];
  let namesPretendard = false;
  const root = postcss.parse(css);
  root.walkAtRules((atRule) => {
    if (atRule.name.toLowerCase() === 'font-face') problems.push('declares @font-face');
    if (/pretendard/iu.test(atRule.params)) namesPretendard = true;
  });
  root.walkDecls((declaration) => {
    if (/pretendard/iu.test(declaration.value)) namesPretendard = true;
    const parent = declaration.parent;
    if (parent?.type === 'atrule') return;
    const selector =
      parent?.type === 'rule' ? (parent as Rule).selectors.map(normalize).join(', ') : '(root)';
    const value = normalize(declaration.value);
    if (/^--font-(?!weight-)/u.test(declaration.prop)) {
      problems.push(`${selector} sets the stack property ${declaration.prop}`);
      return;
    }
    if (declaration.prop === 'font') {
      if (value !== 'inherit') problems.push(`${selector} sets a family through 'font: ${value}'`);
      return;
    }
    if (declaration.prop !== 'font-family' || value === 'inherit') return;
    if (STACK_REFERENCE.test(value)) return;
    if (/^var\(/u.test(value)) {
      problems.push(`${selector} reads ${value}, not a stack with the system fallback`);
      return;
    }
    if (isDeviceMonospace(familiesOf(value))) return;
    if (selector in literals) return;
    problems.push(`${selector} names its own families (${value})`);
  });
  if (namesPretendard) problems.push('names Pretendard');
  return problems;
}

/**
 * Public rules that test the document language to set a page's own
 * translated copy, never user content, so they may apply in only one of the
 * Korean and English pages. Korean keeps its line breaking (keep-all) and
 * About's Korean heading sizes and line heights, each with its reason. No
 * such rule sets tracking: the app draws Korean and English alike (9.0.29),
 * so the pages do too.
 */
export const PUBLIC_KOREAN_ENGLISH_COPY_RULES: Readonly<Record<string, string>> = {
  ':lang(ko) .lp-h1': "About's translated headline: Korean size, line height and keep-all",
  ':lang(ko) .lp-h2': "About's translated section titles: Korean size, line height and keep-all",
  ':lang(ko) .lp-cta .lp-h2': "About's translated closing title: Korean size and line height",
  ':lang(ko) .lp-room-count__copy': "About's translated room count line: keep-all",
  ':lang(ko) .policy-doc p': 'translated document paragraphs: keep-all',
  ':lang(ko) .policy-doc dd': 'translated document definitions: keep-all',
  ':lang(ko) .policy-hero h1': 'translated document titles: keep-all',
  ':lang(ko) .policy-doc h2': 'translated document headings: keep-all',
};

/** The text of every inline <style> element of a page. */
export function inlineStyles(html: string): string[] {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)].map((match) => match[1] ?? '');
}

/** A page outside the app whose source HTML the repository holds. */
export interface PublicFontPage {
  /** The source HTML, repository-relative. */
  readonly html: string;
  /** Where the build writes it, dist-relative, or null when the build leaves it out. */
  readonly dist: string | null;
  /** Where the source links rest.css (publicFontLinkProblems). */
  readonly rest: PublicFontLinkOptions['rest'];
  /** Its stylesheets after /web-fonts/stacks.css, repository-relative, in cascade order. */
  readonly sheets: readonly string[];
  /** The html lang values it is shown in. */
  readonly htmlLangs: readonly string[];
}

const TOKENS = 'public/designsystem/colors_and_type.css';
const DOCUMENT = 'public/legal-pages.css';
const EDITORIAL = 'public/editorial-base.css';

/** The design system's component previews, public/designsystem/preview/. */
const DESIGN_PREVIEWS = [
  '_shell',
  'buttons-icon',
  'buttons-primary',
  'channel-grid',
  'colors-dark',
  'colors-light',
  'colors-text',
  'glass',
  'iconography',
  'invite-code',
  'logo',
  'motion',
  'nav-pill',
  'playlist',
  'radii',
  'section-group',
  'spacing',
  'toast-dialog',
  'type-family',
  'type-scale',
  'type-weights',
] as const;

/**
 * Every page outside the app that has switched to the shared sheets, by its
 * source HTML. About is one source in every language: the build writes a
 * copy per language, with rest.css in the head where the language needs it
 * (src/i18n/public-font-contract.ts restFontSheetInHead); the build guard
 * checks every copy and every other built page. The sign-in completion page
 * (public/account-complete.html) is the app's, not one of these: it draws
 * with the device's system fonts and links none of the shared sheets.
 */
export const PUBLIC_FONT_PAGES: readonly PublicFontPage[] = [
  {
    html: '.workshop/landing/landing.html',
    dist: 'about.html',
    rest: 'body',
    sheets: [
      TOKENS,
      'public/editorial-base.css',
      'public/static-language.css',
      'public/editorial-about.css',
      'public/editorial-rtl.css',
    ],
    htmlLangs: LANGUAGE_OPTIONS.map(({ htmlLang }) => htmlLang),
  },
  ...['privacy', 'terms', 'faq', 'developers'].map((name) => ({
    html: `.workshop/${name}/${name}.html`,
    dist: `${name}.html`,
    rest: 'body' as const,
    sheets: [DOCUMENT],
    htmlLangs: ['en'],
  })),
  {
    html: '.workshop/translate/translate.html',
    dist: 'translate.html',
    rest: 'body',
    sheets: [DOCUMENT, '.workshop/translate/translate.css'],
    htmlLangs: ['en'],
  },
  {
    html: '.workshop/sitemap/sitemap.html',
    dist: 'sitemap.html',
    rest: 'body',
    sheets: [DOCUMENT, '.workshop/sitemap/sitemap.css'],
    htmlLangs: ['en'],
  },
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
  ...DESIGN_PREVIEWS.map((name) => ({
    html: `public/designsystem/preview/${name}.html`,
    dist: `designsystem/preview/${name}.html`,
    rest: 'body' as const,
    sheets: [TOKENS],
    htmlLangs: ['en'],
  })),
  {
    // The UI kit is served in development only (scripts/ui-kit-asset.ts).
    html: 'browser/ui-kit/static/app/index.html',
    dist: null,
    rest: 'body',
    sheets: [TOKENS, 'browser/ui-kit/static/app/app.css'],
    htmlLangs: ['en'],
  },
  {
    // PRO sign-in: its deferred scripts wait for every stylesheet the parser
    // added, so it links no rest.css and draws the scripts that sheet holds
    // with the device fonts.
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

/** A page the App Worker renders itself, so no source HTML holds its links. */
interface PublicWorkerFontPage {
  /** Which page, and where cloudflare/app-worker.ts renders it. */
  readonly name: string;
  /** Its stylesheets after /web-fonts/stacks.css, repository-relative, in cascade order. */
  readonly sheets: readonly string[];
  /** The html lang values it is shown in. */
  readonly htmlLangs: readonly string[];
}

/**
 * The pages the App Worker renders from its own markup, with the links of
 * src/i18n/public-font-urls.ts (src/core/__tests__/app-worker-cors.test.ts
 * checks those links): the admin page, and the blog article when the built
 * blog page is not there to hold it. The guard checks their sheets.
 */
export const PUBLIC_WORKER_FONT_PAGES: readonly PublicWorkerFontPage[] = [
  {
    name: 'the admin page (cloudflare/app-worker.ts renderAdminPage)',
    sheets: ['public/admin.css'],
    htmlLangs: ['en'],
  },
  {
    name: 'the blog article fallback (cloudflare/app-worker.ts renderSoroArticleHtml)',
    sheets: [TOKENS, EDITORIAL],
    htmlLangs: ['en'],
  },
];
