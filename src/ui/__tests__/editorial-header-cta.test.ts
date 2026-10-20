/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Owner decision (2026-10-20): every editorial page header offers the same
// "Try it now" call to action. The History page said "Open app" after its
// 2026-08-23 rebuild. Other About languages keep their own translations.
const STATIC_EDITORIAL_PAGES = [
  'public/blog/index.html',
  'public/history/index.html',
  'public/designsystem/index.html',
];

function headerCallToAction(path: string) {
  const document = new DOMParser().parseFromString(
    readFileSync(resolve(path), 'utf8'),
    'text/html',
  );
  const link = document.querySelector<HTMLAnchorElement>('header .lp-try');
  return {
    label: link?.textContent?.trim(),
    ariaLabel: link?.getAttribute('aria-label'),
  };
}

describe('editorial header call to action', () => {
  it.each(STATIC_EDITORIAL_PAGES)('%s offers Try it now', (path) => {
    expect(headerCallToAction(path)).toEqual({
      label: 'Try it now',
      ariaLabel: 'Try MUSIXQUARE now',
    });
  });

  it('matches the Soro article header and the English About page', () => {
    const worker = readFileSync(resolve('cloudflare/app-worker.ts'), 'utf8');
    const aboutDictionary = readFileSync(
      resolve('browser/classic-runtime/landing-i18n.ts'),
      'utf8',
    );

    expect(worker).toMatch(
      /<a class="lp-try"[^>]*aria-label="Try MUSIXQUARE now">\s*<span>Try it now<\/span>/u,
    );
    expect(aboutDictionary).toContain("'header.try': 'Try it now'");
    expect(aboutDictionary).toContain("'header.try_aria': 'Try MUSIXQUARE now'");
  });
});
