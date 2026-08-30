import { test, expect } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { isBenignPageError } from './helpers/page-errors.ts';
import { navigateToTab } from './helpers/wait.ts';

/** Wait for the app to fully initialize, then dismiss the setup overlay if present. */
async function waitForAppReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await waitForBootstrapReady(page, 5_000);
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
    await page.waitForLoadState('domcontentloaded');
    await waitForBootstrapReady(page, 5_000);

    await expect(page.locator('body')).toBeVisible();

    await expect(page.locator('#tab-play')).toBeVisible();

    await expect(page.locator('.bottom-nav')).toBeAttached();
  });

  test('tab navigation works', async ({ page }) => {
    await waitForAppReady(page);

    const settingsNav = page.locator('.nav-item[data-tab="settings"]');
    await navigateToTab(page, 'settings');
    await expect(page.locator('#tab-settings')).toHaveClass(/active/);
    await expect(settingsNav).toHaveAttribute('aria-selected', 'true');

    const playNav = page.locator('.nav-item[data-tab="play"]');
    await navigateToTab(page, 'play');
    await expect(page.locator('#tab-play')).toHaveClass(/active/);
    await expect(playNav).toHaveAttribute('aria-selected', 'true');
  });

  test('no JavaScript errors on load', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await waitForBootstrapReady(page, 5_000);
    await page.waitForFunction(() => document.readyState === 'complete', undefined, {
      timeout: 5_000,
    });

    const critical = errors.filter((error) => !isBenignPageError(error));
    expect(critical).toHaveLength(0);
  });

  test('theme toggle exists', async ({ page }) => {
    await waitForAppReady(page);

    await navigateToTab(page, 'settings');

    await expect(page.locator('#grid-theme')).toBeVisible();
    await expect(page.locator('.ch-opt[data-theme="light"]')).toBeVisible();
    await expect(page.locator('.ch-opt[data-theme="dark"]')).toBeVisible();
  });
});

test.describe('MUSIXQUARE Mobile Viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('bottom navigation is visible on mobile', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await waitForBootstrapReady(page, 5_000);

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
