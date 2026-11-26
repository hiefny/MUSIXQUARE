import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const STATUS_LINK = '<a href="/status">Status</a>';
const DOCUMENT_FOOTER = 'footer.policy-footer nav[aria-label="Footer"]';
const EDITORIAL_FOOTER = 'footer > span:last-of-type';

// Each static public footer, the element that holds its links, and the link
// Status follows: FAQ's place on the document pages (Terms on FAQ itself), and
// right after Sitemap on About and the editorial pages.
const FOOTERS = [
  ['.workshop/developers/developers.html', DOCUMENT_FOOTER, '/faq'],
  ['.workshop/privacy/privacy.html', DOCUMENT_FOOTER, '/faq'],
  ['.workshop/terms/terms.html', DOCUMENT_FOOTER, '/faq'],
  ['.workshop/translate/translate.html', DOCUMENT_FOOTER, '/faq'],
  ['.workshop/faq/faq.html', DOCUMENT_FOOTER, '/terms'],
  ['.workshop/landing/landing.html', 'footer.lp-footer nav.lp-footer__nav', '/sitemap'],
  ['public/blog/index.html', EDITORIAL_FOOTER, '/sitemap'],
  ['public/designsystem/index.html', EDITORIAL_FOOTER, '/sitemap'],
  ['public/history/index.html', EDITORIAL_FOOTER, '/sitemap'],
] as const;

async function withDocument<T>(file: string, read: (document: Document) => T): Promise<T> {
  const dom = new JSDOM(await readFile(file, 'utf8'));
  try {
    return read(dom.window.document);
  } finally {
    dom.window.close();
  }
}

describe('the Status link in public footers', () => {
  it.each(FOOTERS)(
    '%s links to /status once, inside its footer links',
    async (file, group, after) => {
      const source = await readFile(file, 'utf8');
      expect(source.split(STATUS_LINK)).toHaveLength(2);

      await withDocument(file, (document) => {
        const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href="/status"]')];
        expect(links).toHaveLength(1);
        const [link] = links;
        expect(link?.textContent).toBe('Status');
        expect(link?.parentElement).toBe(document.querySelector(group));
        expect(link?.closest('footer')).not.toBeNull();
        expect(link?.previousElementSibling?.getAttribute('href')).toBe(after);
        expect(link?.hasAttribute('target')).toBe(false);
      });
    },
  );

  it("keeps Sitemap as About's first footer link", async () => {
    await withDocument('.workshop/landing/landing.html', (document) => {
      const first = document.querySelector<HTMLAnchorElement>('.lp-footer__nav a');
      expect(first?.getAttribute('href')).toBe('/sitemap');
      expect(first?.textContent).toBe('Sitemap');
    });
  });

  it('does not link the status page to itself', async () => {
    await withDocument('.workshop/status/status.html', (document) => {
      const footer = document.querySelector(DOCUMENT_FOOTER);
      expect(footer).not.toBeNull();
      expect(footer?.querySelectorAll('a').length).toBeGreaterThan(0);
      expect(
        document.querySelectorAll('a[href="/status"], a[href="https://musixquare.com/status"]'),
      ).toHaveLength(0);
    });
  });
});
