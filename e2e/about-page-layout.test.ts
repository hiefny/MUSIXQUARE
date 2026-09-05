import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile portrait', width: 390, height: 844 },
  { name: 'short landscape', width: 844, height: 390 },
  { name: 'wide desktop', width: 1_920, height: 1_080 },
] as const;

const EDGE_TOLERANCE_PX = 1;

test.describe('About page closing divider', () => {
  for (const viewport of VIEWPORTS) {
    test(`matches the full-width footer rule without overflow in ${viewport.name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/about.html');

      const cta = page.locator('.lp-cta');
      const divider = page.locator('hr.lp-divider.lp-divider--full');
      const footer = page.locator('.lp-footer');

      await expect(cta).toBeVisible();
      await expect(divider).toHaveCount(1);
      await expect(footer).toBeVisible();

      const geometry = await page.evaluate(() => {
        const ctaElement = document.querySelector<HTMLElement>('.lp-cta');
        const dividerElement = document.querySelector<HTMLElement>(
          'hr.lp-divider.lp-divider--full',
        );
        const footerElement = document.querySelector<HTMLElement>('.lp-footer');
        if (!ctaElement || !dividerElement || !footerElement) {
          throw new Error('Missing About closing geometry target');
        }
        if (ctaElement.previousElementSibling !== dividerElement) {
          throw new Error('The full-width divider must immediately precede the CTA');
        }

        const dividerRect = dividerElement.getBoundingClientRect();
        const footerRuleWidth = Number.parseFloat(
          getComputedStyle(footerElement, '::before').width,
        );

        return {
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          bodyScrollWidth: document.body.scrollWidth,
          divider: {
            left: dividerRect.left,
            right: dividerRect.right,
            width: dividerRect.width,
          },
          footerRuleWidth,
        };
      });

      expect(geometry.clientWidth).toBe(viewport.width);
      expect(geometry.divider.left).toBeGreaterThanOrEqual(-EDGE_TOLERANCE_PX);
      expect(geometry.divider.right).toBeLessThanOrEqual(geometry.clientWidth + EDGE_TOLERANCE_PX);
      expect(Math.abs(geometry.divider.width - geometry.clientWidth)).toBeLessThanOrEqual(
        EDGE_TOLERANCE_PX,
      );
      expect(Math.abs(geometry.divider.width - geometry.footerRuleWidth)).toBeLessThanOrEqual(
        EDGE_TOLERANCE_PX,
      );
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + EDGE_TOLERANCE_PX);
      expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(
        geometry.clientWidth + EDGE_TOLERANCE_PX,
      );
    });
  }
});
