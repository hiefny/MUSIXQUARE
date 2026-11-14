import { expect, test } from '@playwright/test';

// The boot splash (index.html) paints from the page file before any script or
// stylesheet and steps aside when the app takes the screen.
test.describe('boot splash', () => {
  test('hands over to setup and leaves no animation running in the hidden splash', async ({
    page,
  }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => !document.documentElement.classList.contains('setup-boot-block'),
      null,
      { timeout: 30_000, polling: 50 },
    );
    await expect(page.locator('#setup-overlay')).toHaveClass(/\bactive\b/u);
    // The fade over the app takes 0.3 s.
    await expect(page.locator('.boot-splash')).toBeHidden();
    const running = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((animation) => {
          const target = (animation.effect as KeyframeEffect | null)?.target;
          return target instanceof Element && target.closest('.boot-splash') !== null;
        })
        .filter((animation) => animation.playState === 'running')
        .map((animation) => (animation as CSSAnimation).animationName),
    );
    expect(running).toEqual([]);
  });

  test('steps aside for the page when nothing after the page file arrives', async ({ page }) => {
    // A connection that drops right after the document: the start-up scripts,
    // the app stylesheet and the module graph never arrive, so neither
    // fouc-cleanup.js nor the stylesheet's fallback can lift the splash.
    await page.route(/\/(?:bootstrap|fouc-cleanup)\.js(?:\?.*)?$/u, (route) => route.abort());
    await page.route(/\/(?:assets|src|css)\//u, (route) => route.abort());
    await page.goto('/', { waitUntil: 'commit' });
    await page.locator('.boot-splash').waitFor({ state: 'attached' });
    await expect(page.locator('.boot-splash')).toBeVisible();
    // Shorten the shared boot-failure delay (the splash adds its 5 s margin).
    await page.addStyleTag({ content: ':root { --setup-boot-failure-delay: 0s !important; }' });

    await expect(page.locator('html')).toHaveClass(/\bsetup-boot-block\b/u);
    await expect(page.locator('.boot-splash')).toBeHidden({ timeout: 8_000 });
    // The unstyled page's own Retry form is reachable again.
    await page.locator('#bootstrap-retry').click({ trial: true, timeout: 2_000 });
  });
});
