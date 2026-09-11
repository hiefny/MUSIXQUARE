// @vitest-environment node

import { readFile, readdir } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const PAGE_IMAGES = [
  ['index.html', 'og-image.png'],
  ['.workshop/landing/landing.html', 'og-about.png'],
  ['.workshop/faq/faq.html', 'og-faq.png'],
  ['.workshop/privacy/privacy.html', 'og-privacy.png'],
  ['.workshop/terms/terms.html', 'og-terms.png'],
  ['.workshop/developers/developers.html', 'og-developers.png'],
  ['.workshop/translate/translate.html', 'og-translate.png'],
  ['.workshop/sitemap/sitemap.html', 'og-sitemap.png'],
  ['public/history/index.html', 'og-history.png'],
  ['public/designsystem/index.html', 'og-designsystem.png'],
  ['public/blog/index.html', 'og-blog.png'],
  ['public/events/index.html', 'og-events.png'],
  ['public/404.html', 'og-404.png'],
  ['public/account-complete.html', 'og-account.png'],
] as const;

async function expectPageImage(file: string, image: string): Promise<void> {
  const dom = new JSDOM(await readFile(file, 'utf8'));
  try {
    const document = dom.window.document;
    for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
      const elements = document.querySelectorAll<HTMLMetaElement>(selector);
      expect(elements, `${file}: ${selector}`).toHaveLength(1);
      expect(elements[0]?.content).toBe(`https://musixquare.com/${image}`);
    }
    expect(
      document.querySelector<HTMLMetaElement>('meta[property="og:image:width"]')?.content,
    ).toBe('1200');
    expect(
      document.querySelector<HTMLMetaElement>('meta[property="og:image:height"]')?.content,
    ).toBe('630');
  } finally {
    dom.window.close();
  }
}

describe('page sharing images', () => {
  it.each(PAGE_IMAGES)('%s declares its page image for OG and Twitter', expectPageImage);

  it('ships real 1200×630 PNG files for every static and dynamic page image', async () => {
    const names = new Set([
      ...PAGE_IMAGES.map(([, name]) => name),
      'og-invite.png',
      'og-admin.png',
      'og-maintenance.png',
    ]);
    for (const name of names) {
      const png = await readFile(`public/${name}`);
      expect(png.subarray(0, 8).toString('hex'), name).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16), `${name}: width`).toBe(1200);
      expect(png.readUInt32BE(20), `${name}: height`).toBe(630);
    }
  });

  it('uses the Design System image for every embedded component preview', async () => {
    const directory = 'public/designsystem/preview';
    const files = (await readdir(directory)).filter((file) => file.endsWith('.html'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) await expectPageImage(`${directory}/${file}`, 'og-designsystem.png');
  });
});
