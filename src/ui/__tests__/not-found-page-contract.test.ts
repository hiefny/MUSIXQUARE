/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

let document: Document;
let source: string;
let styles: string;

beforeAll(() => {
  source = readFileSync(resolve('public/404.html'), 'utf8');
  document = new DOMParser().parseFromString(source, 'text/html');
  styles = document.querySelector('style')?.textContent || '';
});

describe('custom not-found page contract', () => {
  it('keeps an accessible English error heading and a crawl-safe document boundary', () => {
    expect(document.documentElement.lang).toBe('en');
    expect(document.title).toBe('Invalid URL · MUSIXQUARE');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, nofollow',
    );
    expect(document.querySelector('h1 .sr-only')?.textContent).toBe('Invalid URL.');
    expect(document.querySelector('h1 .headline')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('h1 .headline-lead > span')?.textContent).toBe('Invalid URL.');
  });

  it('uses the unclipped wordmark-only CTA to return to the app', () => {
    const cta = document.querySelector<HTMLAnchorElement>('a.cta');
    const wordmark = cta?.querySelector<SVGElement>('svg.cta-wordmark');

    expect(cta?.href).toBe('https://musixquare.com/');
    expect(cta?.getAttribute('aria-label')).toBe('Go to MUSIXQUARE');
    expect(wordmark?.getAttribute('viewBox')).toBe('43 12 214 26');
    expect(wordmark?.querySelector('use')?.getAttribute('href')).toBe('#brand-wordmark');
    expect(document.querySelector('#brand-wordmark')).not.toBeNull();
    expect(document.querySelector('symbol')).toBeNull();
    expect(cta?.querySelector('.cta-arrow')?.textContent).toBe('→');
  });

  it('matches the approved centered maintenance shell and About CTA geometry', () => {
    expect(styles).toMatch(
      /body\s*\{[^}]*min-height:\s*100svh;[^}]*display:\s*grid;[^}]*place-items:\s*center;[^}]*background:\s*var\(--bg\);/su,
    );
    expect(styles).toMatch(/p\s*\{[^}]*margin:\s*40px 0 0;/su);
    expect(styles).toMatch(
      /\.cta\s*\{[^}]*height:\s*56px;[^}]*padding:\s*0 28px 0 36px;[^}]*border-radius:\s*999px;/su,
    );
    expect(styles).toMatch(
      /\.cta-wordmark\s*\{[^}]*width:\s*142px;[^}]*height:\s*18px;[^}]*transform:\s*translateY\(0\.6px\);/su,
    );
    expect(styles).not.toMatch(
      /@media\s*\(max-width:\s*520px\)[^{]*\{[^}]*body\s*\{[^}]*place-items:\s*start/su,
    );
  });

  it('has no executable or external page dependencies', () => {
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('link[rel="stylesheet"]')).toBeNull();
    expect(source).not.toMatch(/<(?:img|iframe)\b/iu);
  });
});
