/**
 * Korean copy on the pages outside the app is not tightened, as in the app.
 * The app has set no negative letter-spacing since 9.0.29: Inter narrows
 * Latin by its optical size axis, and the app's Hangul face (MUSIXQUARE
 * Hangul) has no such axis, so Korean keeps its own spacing there. The
 * public pages still tighten big headings in the other languages; on a
 * Korean page every text that holds Hangul is drawn at 0 or wider, at any
 * size (owner request 2026-11-06). Text without Hangul (digits, the Latin
 * YouTube title, the brand) keeps its tracking in every language, so the
 * same text looks the same on the Korean and the English page.
 *
 * Every registered public page is read in a Korean browser: About from its
 * Korean copy, the events page as it is (Korean only), the other pages with
 * whatever Korean they show there, and the sign-in completion page in
 * Korean. Text not shown yet (the events steps and the nickname dialog) is
 * read through its computed style. The static list of every negative
 * tracking is src/i18n/__tests__/public-korean-tracking.test.ts.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { PUBLIC_FONT_PAGES } from '../scripts/lib/public-font-pages.mts';

interface KoreanPage {
  readonly name: string;
  readonly path: string;
  /** Whether the page's own copy is Korean (it must show Hangul). */
  readonly korean: boolean;
  /** A selector the page matches once its text may be read (its script's mark). */
  readonly ready?: string;
}

const ABOUT_SOURCE = '.workshop/landing/landing.html';

const KOREAN_PAGES: readonly KoreanPage[] = [
  ...PUBLIC_FONT_PAGES.flatMap(({ html, dist, htmlLangs }): KoreanPage[] => {
    if (dist === null) return [];
    if (html === ABOUT_SOURCE)
      return [{ name: 'About (ko)', path: '/ko/about.html', korean: true }];
    return [{ name: dist, path: `/${dist}`, korean: htmlLangs[0] === 'ko' }];
  }),
  {
    name: 'account-complete.html (ko)',
    path: '/account-complete.html?accountAuth=cancelled&accountClient=tracking-0001',
    korean: true,
    ready: ':root[data-mxqr-fonts]',
  },
];

/** Text without Hangul on About that keeps its own tracking in every language. */
const KEPT_ON_ABOUT = [
  '.lp-sync__timecode',
  '.lp-sync__peer-tc',
  '.lp-chat-ts',
  '.lp-chat-yt__label',
  '.lp-chat-yt__title',
] as const;

async function keepLocal(context: BrowserContext, baseURL: string | undefined): Promise<string> {
  const origin = new URL(baseURL ?? '').origin;
  await context.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );
  return origin;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

/** The Hangul texts of the page, and each one drawn with a negative letter-spacing. */
function hangulTracking(): { hangul: number; tightened: string[] } {
  const hangulText = /\p{Script=Hangul}/u;
  const negative = (element: Element, pseudo?: string): string | null => {
    const spacing = getComputedStyle(element, pseudo).letterSpacing;
    return spacing !== 'normal' && Number.parseFloat(spacing) < 0 ? spacing : null;
  };
  const name = (element: Element): string =>
    `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${[...element.classList]
      .map((token) => `.${token}`)
      .join('')}`;
  let hangul = 0;
  const tightened: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    const element = node.parentElement;
    if (!element || !hangulText.test(text)) continue;
    if (element.closest('script, style, template, noscript')) continue;
    hangul += 1;
    const spacing = negative(element);
    if (spacing) tightened.push(`${name(element)} ${spacing}: ${text.trim().slice(0, 40)}`);
  }
  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input, textarea',
  )) {
    for (const [text, pseudo] of [
      [field.placeholder, '::placeholder'],
      [field.value, undefined],
    ] as const) {
      if (!hangulText.test(text)) continue;
      hangul += 1;
      const spacing = negative(field, pseudo);
      if (spacing) tightened.push(`${name(field)}${pseudo ?? ''} ${spacing}: ${text.slice(0, 40)}`);
    }
  }
  return { hangul, tightened };
}

test.describe('Korean copy on the public pages is not tightened', () => {
  test.use({ locale: 'ko-KR', serviceWorkers: 'block' });

  for (const korean of KOREAN_PAGES) {
    test(korean.name, async ({ context, page, baseURL }) => {
      await keepLocal(context, baseURL);
      const response = await page.goto(korean.path, { waitUntil: 'load' });
      expect(response?.status(), korean.path).toBeLessThan(400);
      if (korean.ready) await page.locator(korean.ready).waitFor({ state: 'attached' });
      await settle(page);

      const { hangul, tightened } = await page.evaluate(hangulTracking);
      if (korean.korean) expect(hangul, 'Hangul texts').toBeGreaterThan(0);
      expect(tightened).toEqual([]);
    });
  }
});

test('About keeps the tracking of its text without Hangul alike in Korean and English', async ({
  browser,
  baseURL,
}) => {
  const read = async (path: string, locale: string) => {
    const context = await browser.newContext({ locale, serviceWorkers: 'block' });
    try {
      await keepLocal(context, baseURL);
      const page = await context.newPage();
      await page.goto(path, { waitUntil: 'load' });
      await settle(page);
      return await page.evaluate(
        (selectors) => {
          const style = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`no ${selector}`);
            const { fontSize, letterSpacing, marginLeft } = getComputedStyle(element);
            return { fontSize, letterSpacing, marginLeft };
          };
          return {
            kept: Object.fromEntries(
              selectors.map((selector) => {
                const { fontSize, letterSpacing } = style(selector);
                return [selector, { fontSize, letterSpacing }];
              }),
            ),
            headline: style('.lp-hero .lp-h1'),
            closing: style('.lp-cta .lp-h2'),
          };
        },
        [...KEPT_ON_ABOUT],
      );
    } finally {
      await context.close();
    }
  };
  const english = await read('/about.html', 'en-US');
  const korean = await read('/ko/about.html', 'ko-KR');
  // Chromium reports a letter-spacing of 0 as 'normal'.
  const px = (value: string) => (value === 'normal' ? 0 : Number.parseFloat(value));

  for (const selector of KEPT_ON_ABOUT) {
    expect(px(english.kept[selector]?.letterSpacing ?? '0'), selector).toBeLessThan(0);
    expect(korean.kept[selector], selector).toEqual(english.kept[selector]);
  }
  // The English headings keep their tightening; the Korean ones draw at 0
  // and keep the optical left margin (-0.03em) of every language.
  for (const heading of ['headline', 'closing'] as const) {
    expect(px(english[heading].letterSpacing), heading).toBeLessThan(0);
    expect(px(korean[heading].letterSpacing), heading).toBe(0);
  }
  expect(px(korean.headline.marginLeft)).toBeCloseTo(-0.03 * px(korean.headline.fontSize), 2);
});
