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
  test('covers a cold standalone landscape shell and keeps the side navigation reachable', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'webkit', 'This regression targets installed iOS WebKit geometry');
    await page.setViewportSize({ width: 844, height: 390 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', {
        configurable: true,
        get: () => true,
      });

      const nativeMatchMedia = window.matchMedia.bind(window);
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: (query: string): MediaQueryList => {
          const result = nativeMatchMedia(query);
          if (query !== '(orientation: landscape)') return result;
          return new Proxy(result, {
            get(target, property) {
              if (property === 'matches') return false;
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      });

      try {
        if (window.visualViewport) {
          Object.defineProperty(window.visualViewport, 'height', {
            configurable: true,
            get: () => Math.max(1, window.innerHeight - 21),
          });
        }
      } catch {
        // Some WebKit builds expose a non-configurable getter. The real value
        // still exercises the cold landscape/MQL mismatch path.
      }
    });

    await openReadyApp(page);
    await page.locator('.bottom-nav').evaluate((element) => element.classList.add('app-entered'));

    const root = page.locator('html');
    const nav = page.locator('.bottom-nav');
    await expect(root).toHaveClass(/ios-standalone/);
    await expect(root).not.toHaveClass(/keyboard-open/);
    await expect.poll(() => nav.evaluate((element) => getComputedStyle(element).opacity)).toBe('1');
    await expect(nav).toBeInViewport();

    const geometry = await page.evaluate(() => {
      const nav = document.querySelector<HTMLElement>('.bottom-nav')!;
      const navRect = nav.getBoundingClientRect();
      const bodyRect = document.body.getBoundingClientRect();
      return {
        innerHeight: window.innerHeight,
        visualHeight: window.visualViewport?.height ?? null,
        appHeight: Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--app-height'),
        ),
        rootInlineHeight: document.documentElement.style.height,
        bodyBottom: bodyRect.bottom,
        navTop: navRect.top,
        navBottom: navRect.bottom,
        navPointerEvents: getComputedStyle(nav).pointerEvents,
      };
    });

    expect(geometry.appHeight).toBeCloseTo(geometry.innerHeight, 0);
    expect(geometry.bodyBottom).toBeCloseTo(geometry.innerHeight, 0);
    expect(geometry.rootInlineHeight).toBe('');
    expect(geometry.navTop).toBeGreaterThanOrEqual(0);
    expect(geometry.navBottom).toBeLessThanOrEqual(geometry.innerHeight + 1);
    expect(geometry.navPointerEvents).not.toBe('none');
    if (geometry.visualHeight !== null && geometry.visualHeight < geometry.innerHeight) {
      expect(geometry.appHeight).toBeGreaterThan(geometry.visualHeight);
    }
  });

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
