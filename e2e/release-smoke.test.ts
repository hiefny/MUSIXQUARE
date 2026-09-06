import { expect, test } from '@playwright/test';
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
  sendChat,
  waitForChatMessage,
  waitForDeviceCount,
} from './helpers/wait.ts';

let pair: HostGuestPair | undefined;

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

  test('projects a saved non-English root onto its locale URL without reloading', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('musixquare-lang', 'ko');
    });

    await page.goto('/?campaign=returning#player');
    await waitForBootstrapReady(page);

    await expect(page).toHaveURL(/\/ko\/\?campaign=returning#player$/u);
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.locator('#btn-setup-host')).toHaveText('방 만들기');
    await expect(page.locator('#app-manifest')).toHaveAttribute(
      'href',
      '/manifests/ko.webmanifest',
    );
    await expect.poll(() => page.title()).toBe('MUSIXQUARE');
    expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
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

  test('boots, joins a host and guest, and exchanges chat both ways', async ({ browser }) => {
    pair = await createHostGuestContexts(browser);

    const code = await connectHostAndGuest(pair.hostPage, pair.guestPage);
    expect(code).toMatch(/^\d{6}$/);

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
