import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const DEVELOPER_DOC_PATH = '.workshop/developers/developers.html';
const FAQ_PATH = '.workshop/faq/faq.html';
const PRIVACY_PATH = '.workshop/privacy/privacy.html';
const TERMS_PATH = '.workshop/terms/terms.html';
const SCRIPT_PATH = 'public/policy-accordion.js';
const STYLE_PATH = 'public/legal-pages.css';

async function readDocument(path: string, url: string): Promise<JSDOM> {
  return new JSDOM(await readFile(path, 'utf8'), {
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    url,
  });
}

describe('policy-page accordions', () => {
  it.each([
    [DEVELOPER_DOC_PATH, 'https://musixquare.com/developers', 11],
    [FAQ_PATH, 'https://musixquare.com/faq', 7],
  ])('uses accessible section-level disclosures in %s', async (path, url, expectedCount) => {
    const dom = await readDocument(path, url);
    const { document } = dom.window;
    const accordions = Array.from(
      document.querySelectorAll<HTMLDetailsElement>('article.policy-doc > details.policy-accordion'),
    );

    expect(accordions).toHaveLength(expectedCount);
    expect(accordions[0]?.open).toBe(true);
    expect(accordions.slice(1).every((accordion) => !accordion.open)).toBe(true);
    expect(new Set(accordions.map((accordion) => accordion.id)).size).toBe(expectedCount);
    expect(accordions.every((accordion) => accordion.id.length > 0)).toBe(true);
    expect(document.querySelector('script[src="/policy-accordion.js"]')).not.toBeNull();

    for (const accordion of accordions) {
      const summary = accordion.firstElementChild;
      expect(summary?.matches('summary.policy-accordion__summary')).toBe(true);
      expect(summary?.querySelector(':scope > h2')).not.toBeNull();
      expect(summary?.querySelector('button')).toBeNull();
      expect(accordion.children.length).toBeGreaterThan(1);
    }
  });

  it('preserves the public errors deep link without changing privacy or terms', async () => {
    const [developers, privacy, terms] = await Promise.all([
      readDocument(DEVELOPER_DOC_PATH, 'https://musixquare.com/developers'),
      readDocument(PRIVACY_PATH, 'https://musixquare.com/privacy'),
      readDocument(TERMS_PATH, 'https://musixquare.com/terms'),
    ]);

    expect(developers.window.document.querySelector('details#errors.policy-accordion')).not.toBeNull();
    for (const document of [privacy.window.document, terms.window.document]) {
      expect(document.querySelector('.policy-accordion')).toBeNull();
      expect(document.querySelector('script[src="/policy-accordion.js"]')).toBeNull();
    }
  });

  it('opens a hash target, preserves other open sections, and keeps the URL shareable', async () => {
    const dom = await readDocument(
      DEVELOPER_DOC_PATH,
      'https://musixquare.com/developers#errors',
    );
    const scrollIntoView = vi.fn();
    dom.window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    dom.window.eval(await readFile(SCRIPT_PATH, 'utf8'));

    const overview = dom.window.document.querySelector<HTMLDetailsElement>('#overview');
    const errors = dom.window.document.querySelector<HTMLDetailsElement>('#errors');
    expect(overview?.open).toBe(true);
    expect(errors?.open).toBe(true);

    const authentication = dom.window.document.querySelector<HTMLDetailsElement>('#authentication');
    expect(authentication).not.toBeNull();
    if (!authentication || !errors) throw new Error('Expected policy accordions');

    authentication.open = true;
    authentication.dispatchEvent(new dom.window.Event('toggle'));
    expect(dom.window.location.hash).toBe('#authentication');
    expect(errors.open).toBe(true);

    authentication.open = false;
    authentication.dispatchEvent(new dom.window.Event('toggle'));
    expect(dom.window.location.hash).toBe('');
  });

  it('keeps sticky, focus, reduced-motion, and print behavior scoped to accordions', async () => {
    const css = await readFile(STYLE_PATH, 'utf8');

    expect(css).toContain('.policy-accordion[open] > .policy-accordion__summary');
    expect(css).toContain('position: sticky;');
    expect(css).toContain('top: env(safe-area-inset-top, 0px);');
    expect(css).toContain('.policy-accordion__summary:focus-visible');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media print');
    expect(css).toContain(
      '.policy-accordion:not([open]) > :not(.policy-accordion__summary)',
    );
  });
});
