import { expect, test, type Page } from '@playwright/test';

async function openReadyApp(page: Page): Promise<void> {
  // Cloudflare Browser Insights accepts the production origin, but its RUM
  // endpoint intentionally rejects localhost preview origins in WebKit. Stub
  // only that third-party script so page errors still represent app/runtime
  // failures rather than an analytics CORS policy.
  await page.route('https://static.cloudflareinsights.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: '' }),
  );
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#btn-setup-host').waitFor({ state: 'visible', timeout: 15_000 });

  // These checks exercise the initialized application rather than the
  // first-run choice overlay. Session creation and PeerJS transport remain in
  // the serial Chromium suite; this lane is deliberately a stable WebKit
  // compatibility sentinel.
  await page.evaluate(() => {
    document.getElementById('setup-overlay')?.classList.remove('active');
    document.body.classList.remove('overlay-open');
  });
}

test.describe('iPhone WebKit compatibility smoke', () => {
  test('loads the initialized mobile surface without JavaScript errors', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openReadyApp(page);

    await expect(page.locator('#tab-play')).toBeVisible();
    await expect(page.locator('.bottom-nav')).toBeVisible();
    await expect(page.locator('.nav-item[data-tab="play"]')).toBeVisible();
    await expect(page.locator('.nav-item[data-tab="playlist"]')).toBeVisible();
    await expect(page.locator('.nav-item[data-tab="connect"]')).toBeVisible();
    await expect(page.locator('.nav-item[data-tab="settings"]')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('switches between mobile tabs with the expected ARIA state', async ({ page }) => {
    await openReadyApp(page);

    const settings = page.locator('.nav-item[data-tab="settings"]');
    await settings.click();
    await expect(page.locator('#tab-settings')).toHaveClass(/active/);
    await expect(settings).toHaveAttribute('aria-selected', 'true');

    const play = page.locator('.nav-item[data-tab="play"]');
    await play.click();
    await expect(page.locator('#tab-play')).toHaveClass(/active/);
    await expect(play).toHaveAttribute('aria-selected', 'true');
  });
});
