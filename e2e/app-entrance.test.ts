import { expect, test, type Page } from '@playwright/test';
import { setupHost } from './helpers/setup-flow.ts';

interface EntranceExpectation {
  selector: string;
  direction: 'up' | 'left';
  delay: string;
}

async function entranceDelay(page: Page, selector: string): Promise<string> {
  return page
    .locator(selector)
    .evaluate((element) =>
      (element as HTMLElement).style.getPropertyValue('--entrance-delay').trim(),
    );
}

test.describe('app entrance choreography', () => {
  for (const viewport of [
    { label: 'portrait', width: 390, height: 844 },
    { label: 'compact landscape', width: 844, height: 390 },
  ] as const) {
    test(`never paints ${viewport.label} navigation while cold-start setup is still loading`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      let releaseAppModule: (() => void) | undefined;
      let appModuleRouteHit = false;
      const appModuleGate = new Promise<void>((resolve) => {
        releaseAppModule = resolve;
      });
      await page.route(/\/(?:src\/app\.ts|assets\/main-[^/?]+\.js)(?:\?.*)?$/u, async (route) => {
        appModuleRouteHit = true;
        await appModuleGate;
        await route.continue();
      });

      try {
        await page.goto('/', { waitUntil: 'commit' });
        await page.locator('.bottom-nav').waitFor({ state: 'attached' });
        await expect.poll(() => appModuleRouteHit).toBe(true);
        await expect(page.locator('body')).toHaveClass(/\bfouc-loaded\b/u);

        expect(
          await page.locator('.bottom-nav').evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              opacity: style.opacity,
              visibility: style.visibility,
              pointerEvents: style.pointerEvents,
              transitionDuration: style.transitionDuration,
            };
          }),
        ).toEqual({
          opacity: '0',
          visibility: 'hidden',
          pointerEvents: 'none',
          transitionDuration: '0s',
        });
      } finally {
        releaseAppModule?.();
      }

      await expect(page.locator('#setup-overlay')).toHaveClass(/\bactive\b/u);
      await expect(page.locator('html')).not.toHaveClass(/\bsetup-boot-block\b/u);
      await expect(page.locator('.bottom-nav')).toHaveCSS('opacity', '0');
    });
  }

  test('shows a reloadable failure surface if the app entry module cannot start', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route(/\/(?:src\/app\.ts|assets\/main-[^/?]+\.js)(?:\?.*)?$/u, async (route) =>
      route.abort('failed'),
    );

    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('html')).toHaveClass(/\bsetup-boot-failed\b/u);
    await expect(page.locator('html')).not.toHaveClass(/\bsetup-boot-block\b/u);
    await expect(page.locator('#bootstrap-failure')).toBeVisible();
    await expect(page.locator('#bootstrap-retry')).toHaveAttribute('type', 'submit');
    await expect(page.locator('.skip-link')).not.toBeVisible();
    await expect(page.locator('header')).not.toBeVisible();
    await expect(page.locator('.chat-drawer')).not.toBeVisible();
    await expect(page.locator('.bottom-nav')).not.toBeVisible();
    await expect(page.locator('#setup-overlay')).not.toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator('#bootstrap-retry')).toBeFocused();
  });

  test('keeps the no-script recovery message visible without the cleanup runtime', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      javaScriptEnabled: false,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    try {
      await page.goto('/');
      await expect(page.locator('.noscript-fallback')).toBeVisible();
      await expect(page.locator('body')).toHaveCSS('opacity', '1');
      await expect(page.locator('.bottom-nav')).toHaveCSS('visibility', 'hidden');
    } finally {
      await context.close();
    }
  });

  test('keeps CSS recovery authoritative when an older cached runtime resumes the app late', async ({
    page,
  }) => {
    let releaseAppModule: (() => void) | undefined;
    let appModuleRouteHit = false;
    const appModuleGate = new Promise<void>((resolve) => {
      releaseAppModule = resolve;
    });
    await page.route('**/fouc-cleanup.js', async (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `document.addEventListener('DOMContentLoaded', () => document.body.classList.add('fouc-loaded'), { once: true });`,
      }),
    );
    await page.route(/\/assets\/main-[^/?]+\.js(?:\?.*)?$/u, async (route) => {
      appModuleRouteHit = true;
      await appModuleGate;
      await route.continue();
    });

    try {
      await page.goto('/', { waitUntil: 'commit' });
      await page.locator('#bootstrap-failure').waitFor({ state: 'attached' });
      await expect.poll(() => appModuleRouteHit).toBe(true);
      await page.addStyleTag({
        content: ':root { --setup-boot-failure-delay: 0s !important; }',
      });

      await expect(page.locator('html')).toHaveClass(/\bsetup-boot-block\b/u);
      await expect(page.locator('#bootstrap-failure')).toBeVisible();
      await expect(page.locator('.bottom-nav')).not.toBeVisible();
    } finally {
      releaseAppModule?.();
    }

    await expect(page.locator('html')).toHaveClass(/\bsetup-boot-failed\b/u);
    await expect(page.locator('#setup-overlay')).not.toHaveClass(/\bactive\b/u);
    await expect(page.locator('#bootstrap-failure')).not.toHaveAttribute('inert', '');
    await page.keyboard.press('Tab');
    await expect(page.locator('#bootstrap-retry')).toBeFocused();
  });

  test('reveals metadata and desktop settings as separate 1200ms cascades', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'Desktop entrance timing is covered by the Chromium lane.');
    await page.setViewportSize({ width: 1440, height: 900 });
    await setupHost(page);

    const expectations: EntranceExpectation[] = [
      { selector: '.track-title-wrapper', direction: 'up', delay: '100ms' },
      { selector: '#track-artist', direction: 'up', delay: '150ms' },
      { selector: '#tab-settings > .tab-header', direction: 'left', delay: '100ms' },
      { selector: '#tab-settings > .settings-subtab-nav', direction: 'left', delay: '125ms' },
      { selector: '#settings-language-section', direction: 'left', delay: '150ms' },
      { selector: '#theme-section', direction: 'left', delay: '230ms' },
      { selector: '#ui-sounds-section', direction: 'left', delay: '310ms' },
      { selector: '#settings-sync-section', direction: 'left', delay: '400ms' },
    ];

    for (const { selector, direction, delay } of expectations) {
      await expect(page.locator(selector)).toHaveClass(
        new RegExp(`\\bapp-entrance-${direction}\\b`, 'u'),
      );
      expect(await entranceDelay(page, selector), selector).toBe(delay);
    }
    await expect(page.locator('.track-box')).not.toHaveClass(/\bapp-entrance\b/u);
    await expect(page.locator('#tab-settings')).not.toHaveClass(/\bapp-entrance\b/u);

    await page.click('#btn-setup-confirm');
    await expect(page.locator('#setup-overlay')).not.toHaveClass(/\bactive\b/u);
    await expect(page.locator('#settings-sync-section')).toHaveClass(/\bapp-entered\b/u);

    await expect(page.locator('#settings-sync-section')).not.toHaveClass(/\bapp-entrance\b/u, {
      timeout: 2_000,
    });
    for (const { selector } of expectations) {
      await expect(page.locator(selector)).not.toHaveClass(/\bapp-entrance\b/u);
      expect(await entranceDelay(page, selector), selector).toBe('');
    }

    expect(
      await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
    ).toEqual({ clientWidth: 1440, scrollWidth: 1440 });
  });
});
