import { expect, test, type Page } from '@playwright/test';
import { serviceMaintenancePreviewResponse } from '../cloudflare/service-maintenance.js';

const KOREAN_MAINTENANCE_COPY = '안전한 서비스 점검을 진행 중이에요. 잠시 후 다시 시도해 주세요.';
const ACCESSIBLE_HEADLINE = 'MUSIXQUARE is temporarily unavailable.';
const WORDMARK_ASPECT_RATIO = 214 / 26;
const EDGE_TOLERANCE_PX = 1;

const VIEWPORTS = [
  { name: 'mobile portrait', width: 390, height: 844 },
  { name: 'desktop', width: 1_440, height: 900 },
  { name: 'short landscape', width: 844, height: 390 },
] as const;

interface RectGeometry {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface MaintenanceGeometry {
  viewport: { width: number; height: number };
  document: { scrollWidth: number; scrollHeight: number };
  body: { scrollWidth: number; scrollHeight: number };
  main: RectGeometry;
  heading: RectGeometry;
  headline: RectGeometry;
  wordmark: RectGeometry;
  description: RectGeometry;
  headingFontSize: number;
}

async function openMaintenancePreview(page: Page): Promise<void> {
  const response = serviceMaintenancePreviewResponse(
    new Request('https://musixquare.com/admin/maintenance-preview', {
      headers: { Accept: 'text/html', 'Accept-Language': 'ko-KR, en;q=0.8' },
    }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Language')).toBe('ko');
  await page.setContent(await response.text(), { waitUntil: 'domcontentloaded' });
}

function expectRectInsideViewport(
  name: string,
  rect: RectGeometry,
  viewport: { width: number; height: number },
): void {
  expect(rect.width, `${name} width`).toBeGreaterThan(0);
  expect(rect.height, `${name} height`).toBeGreaterThan(0);
  expect(rect.left, `${name} left edge`).toBeGreaterThanOrEqual(-EDGE_TOLERANCE_PX);
  expect(rect.top, `${name} top edge`).toBeGreaterThanOrEqual(-EDGE_TOLERANCE_PX);
  expect(rect.right, `${name} right edge`).toBeLessThanOrEqual(viewport.width + EDGE_TOLERANCE_PX);
  expect(rect.bottom, `${name} bottom edge`).toBeLessThanOrEqual(
    viewport.height + EDGE_TOLERANCE_PX,
  );
}

test.describe('maintenance inline wordmark', () => {
  for (const viewport of VIEWPORTS) {
    test(`keeps the branded headline accessible and unclipped in ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openMaintenancePreview(page);

      const heading = page.getByRole('heading', { level: 1, name: ACCESSIBLE_HEADLINE });
      const headline = heading.locator('.headline');
      const wordmark = headline.locator('svg.wordmark');
      const description = page.locator('main > p');

      await expect(heading).toBeVisible();
      await expect(heading).toHaveAttribute('lang', 'en');
      await expect(headline).toBeVisible();
      await expect(headline).toContainText('is temporarily unavailable.');
      await expect(wordmark).toBeVisible();
      await expect(wordmark).toHaveAttribute('viewBox', '43 12 214 26');
      await expect(description).toBeVisible();
      await expect(description).toHaveText(KOREAN_MAINTENANCE_COPY);
      await expect(page.locator('html')).toHaveAttribute('lang', 'ko');

      // The custom wordmark replaces only the brand text inside the English
      // headline. It must not return as a separate masthead above the heading.
      await expect(page.locator('svg.wordmark')).toHaveCount(1);
      await expect(page.locator('h1 svg.wordmark')).toHaveCount(1);
      await expect(page.locator('main > svg.wordmark')).toHaveCount(0);
      await expect(heading.locator('.sr-only')).toContainText('MUSIXQUARE');

      const geometry = await page.evaluate<MaintenanceGeometry>(() => {
        const rect = (selector: string): RectGeometry => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) throw new Error(`Missing maintenance layout target: ${selector}`);
          const box = element.getBoundingClientRect();
          return {
            top: box.top,
            right: box.right,
            bottom: box.bottom,
            left: box.left,
            width: box.width,
            height: box.height,
          };
        };

        const headlineElement = document.querySelector<HTMLElement>('h1 .headline');
        if (!headlineElement) throw new Error('Missing maintenance headline');

        return {
          viewport: {
            width: document.documentElement.clientWidth,
            height: document.documentElement.clientHeight,
          },
          document: {
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
          },
          body: {
            scrollWidth: document.body.scrollWidth,
            scrollHeight: document.body.scrollHeight,
          },
          main: rect('main'),
          heading: rect('h1'),
          headline: rect('h1 .headline'),
          wordmark: rect('h1 .wordmark'),
          description: rect('main > p'),
          headingFontSize: Number.parseFloat(getComputedStyle(headlineElement).fontSize),
        };
      });

      expect(geometry.viewport).toEqual({ width: viewport.width, height: viewport.height });
      expect(geometry.document.scrollWidth).toBeLessThanOrEqual(viewport.width + EDGE_TOLERANCE_PX);
      expect(geometry.body.scrollWidth).toBeLessThanOrEqual(viewport.width + EDGE_TOLERANCE_PX);
      expect(geometry.document.scrollHeight).toBeLessThanOrEqual(
        viewport.height + EDGE_TOLERANCE_PX,
      );
      expect(geometry.body.scrollHeight).toBeLessThanOrEqual(viewport.height + EDGE_TOLERANCE_PX);

      for (const [name, rect] of Object.entries({
        main: geometry.main,
        heading: geometry.heading,
        headline: geometry.headline,
        wordmark: geometry.wordmark,
        description: geometry.description,
      })) {
        expectRectInsideViewport(name, rect, geometry.viewport);
      }

      expect(geometry.wordmark.width / geometry.wordmark.height).toBeCloseTo(
        WORDMARK_ASPECT_RATIO,
        2,
      );
      expect(geometry.wordmark.height / geometry.headingFontSize).toBeGreaterThan(0.68);
      expect(geometry.wordmark.height / geometry.headingFontSize).toBeLessThan(0.8);
      expect(geometry.wordmark.left).toBeGreaterThanOrEqual(
        geometry.headline.left - EDGE_TOLERANCE_PX,
      );
      expect(geometry.wordmark.right).toBeLessThanOrEqual(
        geometry.headline.right + EDGE_TOLERANCE_PX,
      );
      expect(geometry.wordmark.top).toBeGreaterThanOrEqual(
        geometry.headline.top - EDGE_TOLERANCE_PX,
      );
      expect(geometry.wordmark.bottom).toBeLessThanOrEqual(
        geometry.headline.bottom + EDGE_TOLERANCE_PX,
      );
    });
  }
});
