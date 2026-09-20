import { devices, expect, test, type Page } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import {
  controlFakeYt,
  installFakeYt,
  readFakeYtLog,
  releaseFakeYtReadiness,
} from './helpers/fake-yt.ts';

type JoinObservationWindow = Window & {
  __setupJoinStarted?: boolean[];
  __MUSIXQUARE_BUS__?: {
    on: (event: string, callback: (value: boolean) => void) => void;
  };
};

async function observeNetworkJoin(page: Page): Promise<void> {
  await page.evaluate(() => {
    const observations: boolean[] = [];
    const observedWindow = window as JoinObservationWindow;
    observedWindow.__setupJoinStarted = observations;
    observedWindow.__MUSIXQUARE_BUS__!.on('state:network.isConnecting', (connecting) => {
      observations.push(connecting);
    });
  });
}

async function readJoinObservations(page: Page): Promise<boolean[]> {
  return page.evaluate(() => (window as JoinObservationWindow).__setupJoinStarted ?? []);
}

async function openGuestSetup(page: Page, entry: 'invite' | 'code'): Promise<void> {
  await page.goto(entry === 'invite' ? '/123456' : '/');
  await waitForBootstrapReady(page);
  if (entry === 'code') {
    await page.locator('#btn-setup-guest').click();
    await page.locator('#setup-join-code').fill('123456');
  }
  await expect(page.locator('#btn-setup-confirm')).toBeVisible();
  await observeNetworkJoin(page);
}

test.describe('iPhone guest setup YouTube activation ordering', () => {
  test.use({
    userAgent: devices['iPhone 13'].userAgent,
    viewport: devices['iPhone 13'].viewport,
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });

  for (const entry of ['invite', 'code'] as const) {
    test(`${entry} entry preserves the real Start click until the iframe is ready and waits for its playback proof`, async ({
      page,
    }) => {
      // These tests validate production wiring and event ordering. A fake
      // player cannot prove Safari's real cross-origin audio permission.
      await installFakeYt(page, {
        manualApiReady: true,
        manualPlayerReady: true,
        trackClickHandler: true,
        playDelayMs: 60_000,
      });
      await openGuestSetup(page, entry);
      const start = page.locator('#btn-setup-confirm');
      await expect(start).toBeDisabled();
      expect(await readJoinObservations(page)).not.toContain(true);

      await releaseFakeYtReadiness(page, 'api');
      await page.waitForFunction(
        () => !!(window as unknown as { __fakeYtLastPlayer?: unknown }).__fakeYtLastPlayer,
      );
      // Downloading the API is not enough: onReady must reach the silent
      // resident iframe before the only admission gesture can be spent.
      await expect(start).toBeDisabled();
      expect((await readFakeYtLog(page)).filter(({ op }) => op === 'playVideo')).toEqual([]);
      await releaseFakeYtReadiness(page, 'player');
      await expect(start).toBeEnabled();
      expect((await readFakeYtLog(page)).filter(({ op }) => op === 'playVideo')).toEqual([]);

      await start.click();
      const plays = (await readFakeYtLog(page)).filter(({ op }) => op === 'playVideo');
      expect(plays).toHaveLength(1);
      expect(plays[0]?.clickHandlerId).toBe('btn-setup-confirm');
      await expect(start).toBeDisabled();
      // Remain pending across animation frames, not just the click's microtask.
      await page.waitForTimeout(80);
      expect(await readJoinObservations(page)).not.toContain(true);

      await controlFakeYt(page, { state: 1, emitStateChange: true });
      await expect.poll(() => readJoinObservations(page)).toContain(true);
      expect((await readFakeYtLog(page)).filter(({ op }) => op === 'playVideo')).toHaveLength(1);
    });
  }

  test('the built-in scanner primes from the camera button click before camera startup', async ({
    page,
  }) => {
    await installFakeYt(page, {
      manualPlayerReady: true,
      trackClickHandler: true,
      playDelayMs: 60_000,
    });
    // Keep acquisition pending so the test covers admission gesture wiring
    // without depending on camera devices or pretending a decoded QR is a tap.
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        configurable: true,
        value: () => new Promise<MediaStream>(() => {}),
      });
    });
    await openGuestSetup(page, 'code');
    const scan = page.locator('#btn-setup-qr-scan');
    await expect(scan).toBeDisabled();
    await releaseFakeYtReadiness(page, 'player');
    await expect(scan).toBeEnabled();
    await scan.click();
    const plays = (await readFakeYtLog(page)).filter(({ op }) => op === 'playVideo');
    expect(plays).toHaveLength(1);
    expect(plays[0]?.clickHandlerId).toBe('btn-setup-qr-scan');
    expect(await readJoinObservations(page)).not.toContain(true);
  });

  test('unavailable YouTube readiness cannot permanently prevent joining a room', async ({
    page,
  }) => {
    await installFakeYt(page, {
      manualApiReady: true,
      manualPlayerReady: true,
      trackClickHandler: true,
    });
    await openGuestSetup(page, 'invite');
    const start = page.locator('#btn-setup-confirm');
    await expect(start).toBeDisabled();
    await expect(start).toBeEnabled({ timeout: 8_000 });
    expect(await readJoinObservations(page)).not.toContain(true);
    await start.click();
    await expect.poll(() => readJoinObservations(page)).toContain(true);
    expect((await readFakeYtLog(page)).filter(({ op }) => op === 'playVideo')).toEqual([]);
  });
});
