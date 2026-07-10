import { test, expect } from '@playwright/test';
import {
  isVisible,
} from './helpers/wait.ts';

/** Wait for the app to fully initialize, then dismiss the setup overlay if present. */
async function waitForAppReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Wait for app bootstrap to finish — setup overlay button is rendered by JS
  await page.waitForSelector('#btn-setup-host', { state: 'visible', timeout: 5_000 });

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

    await expect(page.locator('body')).toBeVisible();

    await expect(page.locator('#tab-play')).toBeVisible();

    await expect(page.locator('.bottom-nav')).toBeAttached();
  });

  test('tab navigation works', async ({ page }) => {
    await waitForAppReady(page);

    const settingsNav = page.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
      await expect(page.locator('#tab-settings')).toHaveClass(/active/);
    }

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

    const settingsNav = page.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await settingsNav.click();
    }

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

    await expect(page.locator('.nav-item[data-tab="play"]')).toBeAttached();
    await expect(page.locator('.nav-item[data-tab="connect"]')).toBeAttached();
    await expect(page.locator('.nav-item[data-tab="settings"]')).toBeAttached();

    await expect(page.locator('#tab-connect')).toBeAttached();
  });

  test('mobile tab switching works', async ({ page }) => {
    await waitForAppReady(page);

    await page.locator('.nav-item[data-tab="settings"]').click();
    await expect(page.locator('#tab-settings')).toHaveClass(/active/);

    await page.locator('.nav-item[data-tab="play"]').click();
    await expect(page.locator('#tab-play')).toHaveClass(/active/);
  });
});
