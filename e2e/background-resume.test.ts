/**
 * E2E: Mobile background resume behavior.
 *
 * Exercises the browser-level visibilitychange path in a mobile guest context:
 * a long hidden interval should silently request playback recovery and then
 * surface the user-facing resume warning.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { setupHostAndStart, setupGuest } from './helpers/setup-flow.ts';
import { injectPeerServer } from './helpers/peer-server.ts';

async function createMobileResumePages(browser: Browser): Promise<{
  hostContext: BrowserContext;
  guestContext: BrowserContext;
  hostPage: Page;
  guestPage: Page;
}> {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  await injectPeerServer(hostPage);
  await injectPeerServer(guestPage);
  return { hostContext, guestContext, hostPage, guestPage };
}

async function installResumeSignalProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const bus = w.__MUSIXQUARE_BUS__ as
      | { on: (type: string, callback: () => void) => void }
      | undefined;
    if (!bus) throw new Error('E2E bus hook unavailable');

    const signals = { forceResync: 0, refreshPosition: 0 };
    w.__backgroundResumeSignals = signals;
    bus.on('sync:force-resync', () => {
      signals.forceResync += 1;
    });
    bus.on('playback:refresh-current-position', () => {
      signals.refreshPosition += 1;
    });
  });
}

async function simulateLongBackgroundBounce(page: Page): Promise<void> {
  await page.evaluate(() => {
    const realNow = Date.now;
    const start = realNow();
    let now = start;

    const setVisibility = (value: DocumentVisibilityState): void => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => value,
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => value === 'hidden',
      });
    };

    Date.now = () => now;
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    now = start + 61_000;
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    Date.now = realNow;
  });
}

async function forceGuestIntoPlayingFileState(page: Page): Promise<void> {
  await page.evaluate(() => {
    const set = (window as unknown as Record<string, unknown>).__MUSIXQUARE_SET_STATE__ as
      | ((path: string, value: unknown) => void)
      | undefined;
    if (!set) throw new Error('E2E state hook unavailable');

    set('player.currentTrackMeta', {
      type: 'file',
      name: 'background-resume.mp3',
      title: 'Background Resume',
    });
    set('playback.mode', 'file');
    set('playback.activity', 'playing');
    set('playback.lifecycle', 'PLAYING');
  });
}

test.describe('Mobile Background Resume', () => {
  test('mobile guest requests resync and shows warning after long background resume', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { hostContext, guestContext, hostPage, guestPage } =
      await createMobileResumePages(browser);

    try {
      const code = await setupHostAndStart(hostPage);
      await setupGuest(guestPage, code);
      await forceGuestIntoPlayingFileState(guestPage);

      await installResumeSignalProbe(guestPage);
      await simulateLongBackgroundBounce(guestPage);

      await guestPage.waitForFunction(
        () => {
          const signals = (window as unknown as Record<string, unknown>)
            .__backgroundResumeSignals as
            | { forceResync?: number; refreshPosition?: number }
            | undefined;
          return (signals?.forceResync ?? 0) + (signals?.refreshPosition ?? 0) > 0;
        },
        undefined,
        { timeout: 10_000 },
      );

      await guestPage.waitForFunction(
        () => {
          const overlay = document.getElementById('dialog-overlay');
          const title = document.getElementById('dialog-title')?.textContent || '';
          return (
            overlay?.classList.contains('show') === true &&
            (title.length > 0 || document.getElementById('dialog-message')?.textContent)
          );
        },
        undefined,
        { timeout: 10_000 },
      );

      const signals = await guestPage.evaluate(() => {
        return (window as unknown as Record<string, unknown>).__backgroundResumeSignals;
      });
      expect(signals).toMatchObject({ forceResync: 1 });

      await guestPage.locator('#btn-dialog-ok').click();
    } finally {
      await guestContext.close().catch(() => {});
      await hostContext.close().catch(() => {});
    }
  });
});
