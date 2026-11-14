import { expect, test, type Page } from '@playwright/test';

// The boot splash (index.html) paints from the page file before any script or
// stylesheet and steps aside when the app takes the screen.

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(
    () => !document.documentElement.classList.contains('setup-boot-block'),
    null,
    { timeout: 30_000, polling: 50 },
  );
  await expect(page.locator('#setup-overlay')).toHaveClass(/\bactive\b/u);
}

/** The animations still running on anything inside the splash. */
function runningInsideSplash(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return target instanceof Element && target.closest('.boot-splash') !== null;
      })
      .filter((animation) => animation.playState === 'running')
      .map((animation) => (animation as CSSAnimation).animationName),
  );
}

test.describe('boot splash', () => {
  test('hands over to setup and leaves no animation running in the hidden splash', async ({
    page,
  }) => {
    await openApp(page);
    // The loader turns through the 0.3 s fade; then the runtime takes the
    // splash out of rendering.
    await expect(page.locator('.boot-splash')).toBeHidden();
    await expect(page.locator('.boot-splash')).toHaveAttribute('hidden', '');
    expect(await runningInsideSplash(page)).toEqual([]);
  });

  test('hands over without the drawing runtime too, frozen where it was', async ({ page }) => {
    await page.route('**/wordmark-anim.js', (route) => route.abort('failed'));
    await openApp(page);
    await expect(page.locator('.boot-splash')).toBeHidden();
    // Nothing can hide it without the runtime, so it freezes at release.
    await expect(page.locator('.boot-splash')).not.toHaveAttribute('hidden', /.*/u);
    await expect.poll(() => runningInsideSplash(page)).toEqual([]);
  });

  test('greets with a working language button from the first frame', async ({ page }) => {
    // The phone layout shows the welcome header itself (wide screens copy it).
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    const greeting = page.locator('#setup-welcome-header .setup-greeting-row');
    await expect(greeting).toHaveClass(/\bis-visible\b/u);
    await expect(greeting).toHaveCSS('opacity', '1');
    await expect(greeting).not.toHaveAttribute('aria-hidden', /.*/u);
    // The wordmark drew on the splash; the start screen has none.
    await expect(page.locator('#setup-welcome-header .logo-welcome')).toHaveCSS(
      'visibility',
      'hidden',
    );
    await page.locator('#setup-welcome-header [data-setup-language-trigger]').click();
    await expect(page.locator('#language-dialog-overlay')).toBeVisible();
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
