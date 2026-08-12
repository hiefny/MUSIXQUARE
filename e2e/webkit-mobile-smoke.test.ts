import { expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';

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
  await waitForBootstrapReady(page);
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
  test('keeps the shared language dialog seamless for pointer and keyboard input', async ({
    page,
  }) => {
    await page.route('https://static.cloudflareinsights.com/**', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }),
    );
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await waitForBootstrapReady(page);

    const trigger = page.locator('[data-setup-language-trigger]');
    await expect(trigger).toBeVisible();
    await trigger.click();

    const overlay = page.locator('#language-dialog-overlay');
    const activeLanguage = overlay.locator('.language-option.active');
    await expect(overlay).toHaveClass(/show/);
    await expect(activeLanguage).toBeFocused();
    await expect(activeLanguage).toHaveClass(/language-option-initial-pointer-focus/);
    await expect
      .poll(() => activeLanguage.evaluate((option) => getComputedStyle(option).outlineStyle))
      .toBe('none');

    const list = overlay.locator('#language-list');
    const topEdge = overlay.locator('.language-list-edge-top');
    const bottomEdge = overlay.locator('.language-list-edge-bottom');
    const bottomGeometry = await bottomEdge.evaluate((edge) => {
      const edgeRect = edge.getBoundingClientRect();
      const listRect = document.getElementById('language-list')!.getBoundingClientRect();
      const fadeSize = Number.parseFloat(
        getComputedStyle(edge.parentElement!).getPropertyValue('--language-list-fade-size'),
      );
      return {
        overscan: edgeRect.bottom - listRect.bottom,
        fadeStartDelta: edgeRect.top - (listRect.bottom - fadeSize),
      };
    });
    expect(bottomGeometry.overscan).toBeCloseTo(1, 1);
    expect(bottomGeometry.fadeStartDelta).toBeCloseTo(0, 1);

    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect.poll(() => topEdge.evaluate((edge) => getComputedStyle(edge).opacity)).toBe('1');
    const topGeometry = await topEdge.evaluate((edge) => {
      const edgeRect = edge.getBoundingClientRect();
      const listRect = document.getElementById('language-list')!.getBoundingClientRect();
      const fadeSize = Number.parseFloat(
        getComputedStyle(edge.parentElement!).getPropertyValue('--language-list-fade-size'),
      );
      return {
        overscan: listRect.top - edgeRect.top,
        fadeEndDelta: edgeRect.bottom - (listRect.top + fadeSize),
      };
    });
    expect(topGeometry.overscan).toBeCloseTo(1, 1);
    expect(topGeometry.fadeEndDelta).toBeCloseTo(0, 1);

    await page.locator('#btn-language-dialog-done').click();
    await trigger.focus();
    await trigger.press('Enter');
    await expect(activeLanguage).toBeFocused();
    await expect(activeLanguage).not.toHaveClass(/language-option-initial-pointer-focus/);
    await expect(activeLanguage).toHaveClass(/language-option-initial-keyboard-focus/);
    await expect
      .poll(() => activeLanguage.evaluate((option) => getComputedStyle(option).outlineStyle))
      .toBe('solid');
  });

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
    await expect(page.locator('#tab-play > .cscroll-track > .cscroll-thumb')).toHaveCount(1);
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
