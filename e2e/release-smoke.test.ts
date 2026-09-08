import { expect, test, type Page } from '@playwright/test';
import {
  cleanupContexts,
  createHostGuestContexts,
  getPageErrors,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  openChatDrawer,
  navigateToTab,
  sendChat,
  waitForChatMessage,
  waitForDeviceCount,
} from './helpers/wait.ts';

let pair: HostGuestPair | undefined;

async function expectRootSearchIdentity(page: Page): Promise<void> {
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'https://musixquare.com/',
  );
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
    'content',
    'https://musixquare.com/',
  );
  const websiteSchema = page.locator('script[data-mxqr-website-schema]');
  await expect(websiteSchema).toHaveCount(1);
  expect(
    await websiteSchema.evaluate((node) => JSON.parse(node.textContent || '{}')),
  ).toMatchObject({
    '@type': 'WebSite',
    '@id': 'https://musixquare.com/#website',
    url: 'https://musixquare.com/',
    name: 'MUSIXQUARE',
  });
}

test.describe('Production release smoke', () => {
  test.afterEach(async () => {
    if (pair) await cleanupContexts(pair);
    pair = undefined;
  });

  for (const initialView of [
    { path: '/', language: 'en', host: 'Create a Room', guest: 'Join a Room', width: 1440 },
    { path: '/ko/', language: 'ko', host: '방 만들기', guest: '방 참여하기', width: 390 },
  ]) {
    test(`shows prepared ${initialView.language} onboarding while view transitions are stalled`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: initialView.width, height: 844 });
      await page.addInitScript(() => {
        localStorage.setItem('musixquare-lang', 'en');
        const original = Object.getOwnPropertyDescriptor(document, 'startViewTransition');
        const queued: (() => void)[] = [];
        Object.defineProperty(document, 'startViewTransition', {
          configurable: true,
          value: (update: () => void) => {
            queued.push(update);
            const pending = new Promise<void>(() => {});
            return { ready: pending, finished: pending, updateCallbackDone: pending };
          },
        });
        document.addEventListener(
          'test:resume-view-transitions',
          () => {
            if (original) Object.defineProperty(document, 'startViewTransition', original);
            else Reflect.deleteProperty(document, 'startViewTransition');
            for (const update of queued) update();
          },
          { once: true },
        );
      });

      await page.goto(initialView.path);
      await waitForBootstrapReady(page);

      // Read the ready state directly: the boot failure timeout must not be
      // able to make a delayed first reveal satisfy these assertions later.
      expect(
        await page.evaluate(() => ({
          blocked: document.documentElement.classList.contains('setup-boot-block'),
          active: document.getElementById('setup-overlay')?.classList.contains('active'),
          welcome: document.getElementById('setup-welcome-area')?.style.display,
          code: document.getElementById('setup-code-area')?.style.display,
          join: document.getElementById('setup-join-area')?.style.display,
          autoJoin: document.getElementById('setup-auto-join-area')?.style.display,
          role: document.getElementById('setup-role-area')?.style.display,
        })),
      ).toEqual({
        blocked: false,
        active: true,
        welcome: 'flex',
        code: 'none',
        join: 'none',
        autoJoin: 'none',
        role: 'none',
      });
      await expect(page.locator('html')).toHaveAttribute('lang', initialView.language);
      await expect(page).toHaveURL((url) => url.pathname === initialView.path);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `https://musixquare.com${initialView.path}`,
      );
      await expect(page.locator('#setup-overlay')).toBeVisible();
      await expect(page.locator('#setup-overlay')).toHaveAttribute('aria-hidden', 'false');
      await expect(page.locator('#btn-setup-host')).toHaveText(initialView.host);
      await expect(page.locator('#btn-setup-guest')).toHaveText(initialView.guest);

      await page.evaluate(() => document.dispatchEvent(new Event('test:resume-view-transitions')));
      await page.locator('#btn-setup-guest').click();
      await expect(page.locator('#setup-join-area')).toBeVisible();
      await page.locator('#btn-setup-back').click();
      await expect(page.locator('#setup-welcome-area')).toBeVisible();
      await expect(page.locator('#btn-setup-host')).toHaveText(initialView.host);
    });
  }

  test('forces English on the explicit alias without overwriting the saved app language', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('musixquare-lang', 'ko');
    });

    await page.goto('/en/');
    await waitForBootstrapReady(page);

    await expect(page).toHaveURL(/\/en\/$/u);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#btn-setup-host')).toHaveText('Create a Room');
    await expect(page.locator('#app-manifest')).toHaveAttribute(
      'href',
      '/manifests/en.webmanifest',
    );
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('musixquare-lang')))
      .toBe('ko');
  });

  test('points default English editorial app links at the root canonical', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('musixquare-lang', 'en');
    });

    await page.goto('/blog');

    await expect(page.locator('.lp-try')).toHaveAttribute('href', '/');
    await expect(page.locator('footer a', { hasText: 'App' })).toHaveAttribute('href', '/');
  });

  test('keeps a saved non-English root at its original URL without reloading', async ({ page }) => {
    let documentRequests = 0;
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests++;
    });
    await page.addInitScript(() => {
      localStorage.setItem('musixquare-lang', 'ko');
    });

    await page.goto('/?campaign=returning#player');
    await waitForBootstrapReady(page);

    await expect(page).toHaveURL(
      (url) =>
        url.pathname === '/' && url.search === '?campaign=returning' && url.hash === '#player',
    );
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.locator('#btn-setup-host')).toHaveText('방 만들기');
    await expect(page.locator('#app-manifest')).toHaveAttribute(
      'href',
      '/manifests/ko.webmanifest',
    );
    await expect.poll(() => page.title()).toBe('MUSIXQUARE');
    await expectRootSearchIdentity(page);
    expect(documentRequests).toBe(1);
  });

  test('keeps a fresh Korean browser at root while applying its browser language', async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL, locale: 'ko-KR' });
    try {
      const page = await context.newPage();
      let documentRequests = 0;
      page.on('request', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame())
          documentRequests++;
      });

      await page.goto('/?campaign=browser#player');
      await waitForBootstrapReady(page);

      await expect(page).toHaveURL(
        (url) =>
          url.pathname === '/' && url.search === '?campaign=browser' && url.hash === '#player',
      );
      await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
      await expect(page.locator('#btn-setup-host')).toHaveText('방 만들기');
      await expectRootSearchIdentity(page);
      expect(documentRequests).toBe(1);
    } finally {
      await context.close();
    }
  });

  test('preserves the About locale across English-only editorial pages', async ({ page }) => {
    await page.goto('/ko/about');

    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    const historyLink = page.locator('.editorial-site-tab[href^="/history"]');
    await expect(historyLink).toHaveAttribute('href', '/history?lang=ko');
    await historyLink.click();

    await expect(page).toHaveURL(/\/history\?lang=ko$/u);
    const aboutLink = page.locator('.editorial-site-tab[href^="/ko/about"]');
    await expect(aboutLink).toHaveAttribute('href', '/ko/about');
    await aboutLink.click();

    await expect(page).toHaveURL(/\/ko\/about$/u);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page).toHaveTitle('MUSIXQUARE 소개');
  });

  test('keeps a host and guest connected across a manual root language change', async ({
    browser,
  }) => {
    pair = await createHostGuestContexts(browser);

    const code = await connectHostAndGuest(pair.hostPage, pair.guestPage);
    expect(code).toMatch(/^\d{6}$/);

    await Promise.all([
      waitForDeviceCount(pair.hostPage, 2),
      waitForDeviceCount(pair.guestPage, 2),
    ]);

    await pair.hostPage.evaluate((sentinel) => {
      (document as Document & { __releaseLocaleSentinel?: string }).__releaseLocaleSentinel =
        sentinel;
      window.history.replaceState(
        { ...window.history.state, releaseLocaleSentinel: sentinel },
        '',
        window.location.href,
      );
    }, code);
    await navigateToTab(pair.hostPage, 'settings');
    await pair.hostPage.locator('#btn-language-select').click();
    await expect(pair.hostPage.locator('#language-dialog-overlay')).toHaveClass(/show/);
    await pair.hostPage.locator('.language-option[data-lang="ko"]').click();
    await expect(pair.hostPage.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(pair.hostPage.locator('.section-title[data-i18n="settings.theme"]')).toHaveText(
      '테마',
    );
    await expect(pair.hostPage).toHaveURL((url) => url.pathname === '/');
    await expectRootSearchIdentity(pair.hostPage);
    expect(
      await pair.hostPage.evaluate(() => ({
        document: (document as Document & { __releaseLocaleSentinel?: string })
          .__releaseLocaleSentinel,
        history: window.history.state?.releaseLocaleSentinel,
      })),
    ).toEqual({ document: code, history: code });
    await pair.hostPage.locator('#btn-language-dialog-done').click();
    await navigateToTab(pair.hostPage, 'play');
    await Promise.all([
      waitForDeviceCount(pair.hostPage, 2),
      waitForDeviceCount(pair.guestPage, 2),
    ]);

    await Promise.all([openChatDrawer(pair.hostPage), openChatDrawer(pair.guestPage)]);

    const hostMessage = `release-smoke-host-${code}`;
    const guestMessage = `release-smoke-guest-${code}`;

    await sendChat(pair.hostPage, hostMessage);
    await waitForChatMessage(pair.guestPage, hostMessage);

    await sendChat(pair.guestPage, guestMessage);
    await waitForChatMessage(pair.hostPage, guestMessage);

    // Recheck after sustained host/guest activity so a late Worker startup
    // failure cannot pass on a transient initial `ready` observation.
    await Promise.all([
      waitForBootstrapReady(pair.hostPage),
      waitForBootstrapReady(pair.guestPage),
    ]);

    expect(getPageErrors(pair.hostPage)).toEqual([]);
    expect(getPageErrors(pair.guestPage)).toEqual([]);
  });
});
