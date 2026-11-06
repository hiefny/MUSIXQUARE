/**
 * Korean copy on the pages outside the app is not tightened, as in the app.
 * The app has set no negative letter-spacing since 9.0.29: Inter narrows
 * Latin by its optical size axis, and the app's Hangul face (MUSIXQUARE
 * Hangul) has no such axis, so Korean keeps its own spacing there. The
 * public pages still tighten some text in the other languages (owner
 * request 2026-11-06: only the Korean copy changes).
 *
 * Every negative letter-spacing of the public pages' sheets and inline
 * styles, the App Worker pages' sheets and the sign-in completion page's
 * sheet is listed here, one of two ways:
 * - text that never holds Hangul (digits, Latin names, the English-only
 *   pages) keeps its tracking in every language, Korean included, so the
 *   same text looks the same on the Korean and the English page;
 * - text that holds Hangul in Korean has, for each of its selectors, a
 *   :lang(ko) copy at 0, which outranks it by that class wherever the
 *   sheets sit, so Korean copy draws at 0 and the other languages as before.
 * A new negative tracking fails here until it is listed. The rendered pages
 * are e2e/public-korean-tracking.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

import {
  PUBLIC_FONT_PAGE_EXCLUSIONS,
  PUBLIC_FONT_PAGES,
  PUBLIC_WORKER_FONT_PAGES,
  inlineStyles,
} from '../../../scripts/lib/public-font-pages.mts';

const read = (file: string): string => readFileSync(resolve(file), 'utf8');

/** Each served public stylesheet and inline <style>, by name. */
const SOURCES = new Map<string, string>();
for (const { html, dist, sheets } of PUBLIC_FONT_PAGES) {
  // The UI kit is served in development only.
  if (dist === null) continue;
  for (const sheet of sheets) SOURCES.set(sheet, read(sheet));
  inlineStyles(read(html)).forEach((css, index) => {
    SOURCES.set(`${html} <style>${index > 0 ? ` ${index + 1}` : ''}`, css);
  });
}
for (const { sheets } of PUBLIC_WORKER_FONT_PAGES) {
  for (const sheet of sheets) SOURCES.set(sheet, read(sheet));
}
for (const { sheet } of PUBLIC_FONT_PAGE_EXCLUSIONS) {
  if (sheet) SOURCES.set(sheet, read(sheet));
}

interface Tracking {
  readonly source: string;
  readonly selectors: readonly string[];
  readonly value: string;
}

const TRACKING: readonly Tracking[] = [...SOURCES].flatMap(([source, css]) => {
  const found: Tracking[] = [];
  postcss.parse(css).walkDecls('letter-spacing', (declaration) => {
    const rule = declaration.parent;
    if (rule?.type !== 'rule') return;
    found.push({
      source,
      selectors: (rule as Rule).selectors.map((selector) => selector.replace(/\s+/gu, ' ').trim()),
      value: declaration.value.trim(),
    });
  });
  return found;
});

const key = ({ source, selectors }: Tracking): string => `${source} ${selectors.join(', ')}`;

/** Negative tracking on text that never holds Hangul: the same in every language. */
const KEPT_IN_EVERY_LANGUAGE: Readonly<Record<string, string>> = {
  'public/editorial-about.css .lp-sync__timecode': "About's sync timecode: digits",
  'public/editorial-about.css .lp-sync__peer-tc': "About's peer timecodes: digits",
  'public/editorial-about.css .lp-chat-ts':
    "the timestamp in About's chat bubble: digits, at the bubble's tracking in every language",
  'public/editorial-about.css .lp-chat-yt__label': "the chat's YouTube label: the brand",
  '.workshop/sitemap/sitemap.css .hero h1': 'the sitemap title: an English-only page',
  '.workshop/sitemap/sitemap.css .sitemap-shell h2': 'the sitemap groups: an English-only page',
  'public/blog/index.html <style> .blog-hero-line strong':
    "the blog's hero lines: an English-only page",
  'public/editorial-history.css .history-stat-value': 'the history figures: an English-only page',
  'public/editorial-history.css .log .lead': 'the history headlines: an English-only page',
  'public/editorial-design.css .theme-palette-title':
    "the design system's palette titles: an English-only page",
  'public/editorial-design.css .palette-text strong, .palette-text code':
    'token names and hex values',
  'public/editorial-design.css .palette-band strong': 'token names',
  'public/editorial-design.css .embed h3':
    'the design system (an English-only page); no markup uses it',
  'public/designsystem/preview/type-weights.html <style> .sp': 'the weight specimens: Aa',
  'public/404.html <style> .headline': 'the not-found headline: an English-only page',
  'public/account-complete.css .brand': 'the MUSIXQUARE wordmark: the Latin brand',
};

/**
 * Negative tracking on text that holds Hangul in Korean, with the :lang(ko)
 * copy of each of its selectors that draws the Korean copy at 0.
 */
const KOREAN_AT_ZERO: Readonly<Record<string, readonly string[]>> = {
  'public/editorial-base.css .lp-h1': [':lang(ko) .lp-h1'],
  'public/editorial-base.css .lp-h2': [':lang(ko) .lp-h2'],
  'public/editorial-about.css .lp-cta .lp-h2': [':lang(ko) .lp-cta .lp-h2'],
  // The YouTube bubble holds only its Latin title, the same in every language.
  'public/editorial-about.css .lp-chat-bubble': [
    ':lang(ko) .lp-chat-bubble:not(.lp-chat-bubble--yt)',
  ],
};

describe('Korean copy on the public pages', () => {
  it('lists every negative tracking as kept in every language or drawn at 0 in Korean', () => {
    const negative = TRACKING.filter(({ value }) => value.startsWith('-')).map(key);
    expect(negative.sort()).toEqual(
      [...Object.keys(KEPT_IN_EVERY_LANGUAGE), ...Object.keys(KOREAN_AT_ZERO)].sort(),
    );
  });

  it.each(Object.entries(KOREAN_AT_ZERO))(
    '%s draws Korean copy at 0 with a :lang(ko) copy of each selector',
    (tightened, copies) => {
      const rule = TRACKING.find((tracking) => key(tracking) === tightened);
      expect(rule, tightened).toBeDefined();
      for (const selector of rule?.selectors ?? []) {
        const copy = copies.find((candidate) => candidate.startsWith(`:lang(ko) ${selector}`));
        expect(copy, selector).toBeDefined();
        // The copy's last tracking, in whichever served sheet holds it, is 0.
        const values = TRACKING.filter(({ selectors }) => selectors.includes(copy ?? '')).map(
          ({ value }) => value,
        );
        expect(values.at(-1), copy).toBe('0');
      }
    },
  );
});
