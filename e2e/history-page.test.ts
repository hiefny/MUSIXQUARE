import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  { height: 844, width: 390 },
  { height: 800, width: 1280 },
] as const;

test('keeps the History timeline visually consistent across compact and desktop layouts', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto('/history');
    await expect(page.locator('h1')).toContainText('From prototype');

    const contract = await page.evaluate(() => {
      const cards = [...document.querySelectorAll<HTMLElement>('.history-stat-card, .log li')];

      return {
        cardStyles: cards.map((card) => {
          const style = getComputedStyle(card);
          return {
            borderRadius: style.borderRadius,
            borderWidth: style.borderWidth,
            boxShadow: style.boxShadow,
          };
        }),
        horizontalOverflow:
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
        statusDecorationCount: document.querySelectorAll(
          '.section-head .phase, .phase-tag, .a-tag, .w-tag',
        ).length,
        legacyLayoutCount: document.querySelectorAll(
          '.history-card, .phase-meta, .infra-card, .ahead-item, .wall-item',
        ).length,
      };
    });

    expect(contract.horizontalOverflow).toBe(0);
    expect(contract.statusDecorationCount).toBe(0);
    expect(contract.legacyLayoutCount).toBe(0);
    expect(contract.cardStyles.length).toBeGreaterThan(20);
    expect(
      contract.cardStyles.every(
        ({ borderRadius, borderWidth, boxShadow }) =>
          borderRadius === '20px' && borderWidth === '0px' && boxShadow === 'none',
      ),
    ).toBe(true);
  }

  expect(consoleErrors).toEqual([]);
});
