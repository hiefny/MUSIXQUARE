import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const VIEWPORTS = [
  { name: 'mobile portrait', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
  { name: 'short landscape', width: 844, height: 390 },
] as const;
const EDGE_TOLERANCE_PX = 1;

test.describe('custom not-found page', () => {
  for (const viewport of VIEWPORTS) {
    test(`keeps its approved CTA centered and unclipped in ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.setContent(await readFile('public/404.html', 'utf8'), {
        waitUntil: 'domcontentloaded',
      });

      const heading = page.getByRole('heading', { level: 1, name: 'Invalid URL.' });
      const cta = page.getByRole('link', { name: 'Go to MUSIXQUARE' });
      await expect(heading).toBeVisible();
      await expect(cta).toBeVisible();
      await expect(cta).toHaveAttribute('href', 'https://musixquare.com/');

      const geometry = await page.evaluate(() => {
        const box = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) throw new Error(`Missing not-found layout target: ${selector}`);
          const rect = element.getBoundingClientRect();
          return {
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          };
        };
        const use = document.querySelector<SVGGraphicsElement>('.cta-wordmark use');
        if (!use) throw new Error('Missing CTA wordmark use element');
        const glyph = use.getBBox();

        return {
          viewport: {
            width: document.documentElement.clientWidth,
            height: document.documentElement.clientHeight,
          },
          document: {
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
          },
          main: box('main'),
          heading: box('h1'),
          cta: box('.cta'),
          wordmark: box('.cta-wordmark'),
          glyph: { x: glyph.x, y: glyph.y, width: glyph.width, height: glyph.height },
        };
      });

      expect(geometry.document.scrollWidth).toBeLessThanOrEqual(viewport.width + EDGE_TOLERANCE_PX);
      expect(geometry.document.scrollHeight).toBeLessThanOrEqual(
        viewport.height + EDGE_TOLERANCE_PX,
      );
      expect(
        Math.abs((geometry.main.top + geometry.main.bottom) / 2 - viewport.height / 2),
      ).toBeLessThanOrEqual(EDGE_TOLERANCE_PX);
      expect(geometry.cta.top - geometry.heading.bottom).toBeCloseTo(40, 0);
      expect(geometry.wordmark.left).toBeGreaterThanOrEqual(geometry.cta.left - EDGE_TOLERANCE_PX);
      expect(geometry.wordmark.right).toBeLessThanOrEqual(geometry.cta.right + EDGE_TOLERANCE_PX);
      expect(geometry.wordmark.top).toBeGreaterThanOrEqual(geometry.cta.top - EDGE_TOLERANCE_PX);
      expect(geometry.wordmark.bottom).toBeLessThanOrEqual(geometry.cta.bottom + EDGE_TOLERANCE_PX);
      expect(geometry.glyph.x).toBeGreaterThanOrEqual(43);
      expect(geometry.glyph.y).toBeGreaterThanOrEqual(12);
      expect(geometry.glyph.x + geometry.glyph.width).toBeLessThanOrEqual(257);
      expect(geometry.glyph.y + geometry.glyph.height).toBeLessThanOrEqual(38);
    });
  }
});
