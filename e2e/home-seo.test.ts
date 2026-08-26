import { expect, test } from '@playwright/test';

const KOREAN_PROMPT = '뮤직스퀘어에서 방을 만들거나 참여해 주세요.';

test.describe('homepage bilingual search identity', () => {
  for (const viewport of [
    { label: 'mobile', width: 390, height: 844 },
    { label: 'desktop', width: 1440, height: 900 },
  ] as const) {
    test(`renders the Korean brand alias in visible ${viewport.label} onboarding copy`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.addInitScript(() => localStorage.setItem('musixquare-lang', 'ko'));
      await page.goto('/');

      await expect(page.locator('#setup-overlay')).toHaveClass(/\bactive\b/u);
      const prompt = page.locator('.setup-role-prompt:visible');
      await expect(prompt).toHaveCount(1);
      await expect(prompt).toHaveText(KOREAN_PROMPT);
      await expect(prompt).toHaveCSS('visibility', 'visible');
      await expect(prompt).not.toHaveAttribute('aria-hidden', 'true');
      await expect(prompt).not.toHaveAttribute('inert', '');
    });
  }

  test('keeps international onboarding English while preserving the Korean search alias', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('musixquare-lang', 'en'));
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('.setup-role-prompt:visible')).toHaveText(
      'Create a room or join one.',
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      'content',
      'MUSIXQUARE | Listen Together, In Sync',
    );
    const structuredData = await page.locator('script[type="application/ld+json"]').textContent();
    expect(JSON.parse(structuredData ?? '').alternateName).toContain('뮤직스퀘어');
  });
});
