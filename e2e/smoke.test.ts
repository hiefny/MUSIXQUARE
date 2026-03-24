import { test, expect } from '@playwright/test';

/** Wait for the app to fully initialize, then dismiss the setup overlay if present. */
async function waitForAppReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Wait for app bootstrap to finish — setup overlay button is rendered by JS
  await page.waitForSelector('#btn-setup-host', { state: 'visible', timeout: 5_000 });

  // Dismiss setup overlay if present
  await page.evaluate(() => {
    const el = document.getElementById('setup-overlay');
    if (el) el.classList.remove('active');
    document.body.classList.remove('overlay-open');
  });
}

test.describe('MUSIXQUARE Smoke Test', () => {
  test('page loads and shows main UI', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // App body is visible
    await expect(page.locator('body')).toBeVisible();

    // Main tab content area exists
    await expect(page.locator('#tab-play')).toBeVisible();

    // Bottom navigation exists in DOM (hidden on desktop, visible on mobile)
    await expect(page.locator('.bottom-nav')).toBeAttached();
  });

  test('tab navigation works', async ({ page }) => {
    await waitForAppReady(page);

    // Click settings tab
    const settingsNav = page.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
      await expect(page.locator('#tab-settings')).toHaveClass(/active/);
    }

    // Click back to play tab
    const playNav = page.locator('.nav-item[data-tab="play"]');
    if (await playNav.isVisible()) {
      await playNav.click();
      await expect(page.locator('#tab-play')).toHaveClass(/active/);
    }
  });

  test('no JavaScript errors on load', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 5_000 });

    // Filter out known non-critical errors (e.g. service worker in preview mode)
    const critical = errors.filter(
      (e) => !e.includes('service-worker') && !e.includes('ServiceWorker'),
    );
    expect(critical).toHaveLength(0);
  });

  test('theme toggle exists', async ({ page }) => {
    await waitForAppReady(page);

    // Navigate to settings
    const settingsNav = page.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
    }

    // Theme grid and options should exist (data-theme attributes, no IDs)
    await expect(page.locator('#grid-theme')).toBeAttached();
    await expect(page.locator('.ch-opt[data-theme="light"]')).toBeAttached();
    await expect(page.locator('.ch-opt[data-theme="dark"]')).toBeAttached();
  });
});

test.describe('MUSIXQUARE Mobile Viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('bottom navigation is visible on mobile', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('.bottom-nav')).toBeVisible();

    // Nav items should be present in DOM (5-tab layout)
    await expect(page.locator('.nav-item[data-tab="play"]')).toBeAttached();
    await expect(page.locator('.nav-item[data-tab="connect"]')).toBeAttached();
    await expect(page.locator('.nav-item[data-tab="settings"]')).toBeAttached();

    // Connect tab panel should exist
    await expect(page.locator('#tab-connect')).toBeAttached();
  });

  test('mobile tab switching works', async ({ page }) => {
    await waitForAppReady(page);

    // Tap settings tab
    await page.locator('.nav-item[data-tab="settings"]').click();
    await expect(page.locator('#tab-settings')).toHaveClass(/active/);

    // Tap back to play
    await page.locator('.nav-item[data-tab="play"]').click();
    await expect(page.locator('#tab-play')).toHaveClass(/active/);
  });
});
