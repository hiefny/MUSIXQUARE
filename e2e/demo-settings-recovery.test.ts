import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import {
  cleanupContexts,
  createHostGuestContexts,
  useAnonymousAccountSession,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { navigateToSubtab, navigateToTab, readState } from './helpers/wait.ts';

const DEMO_URL = 'https://demo.musixquare.com/linelight/*.m4a';
const AUDIO = fileURLToPath(new URL('./fixtures/demo-track.mp3', import.meta.url));

async function emit(page: Page, event: string): Promise<void> {
  await page.evaluate((name) => {
    const bus = (window as unknown as { __MUSIXQUARE_BUS__: { emit(name: string): void } })
      .__MUSIXQUARE_BUS__;
    bus.emit(name);
  }, event);
}

for (const outcome of ['failed', 'successful'] as const) {
  test(`${outcome} guest demo entry retains newer host effects in state and settings UI`, async ({
    browser,
  }) => {
    const pair = await createHostGuestContexts(browser);
    let release!: () => void;
    const guestDownload = new Promise<void>((resolve) => {
      release = resolve;
    });
    let guestRequests = 0;
    try {
      for (const page of [pair.hostPage, pair.guestPage]) {
        await page.addInitScript(() => {
          localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
        });
        await page.route('**/*', (route) => {
          const host = new URL(route.request().url()).hostname;
          return ['localhost', '127.0.0.1'].includes(host) ? route.continue() : route.abort();
        });
      }
      await useAnonymousAccountSession(pair.hostPage, pair.guestPage);
      await pair.hostPage.route(DEMO_URL, (route) =>
        route.fulfill({ path: AUDIO, contentType: 'audio/mpeg' }),
      );
      await pair.guestPage.route(DEMO_URL, async (route) => {
        if (route.request().url().includes('/01-adventure')) {
          guestRequests += 1;
          await guestDownload;
          if (outcome === 'failed') {
            await route.fulfill({ status: 503, body: 'controlled demo CDN failure' });
            return;
          }
        }
        await route.fulfill({ path: AUDIO, contentType: 'audio/mpeg' });
      });
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      await expect.poll(() => readState(pair.guestPage, 'audio.virtualBass')).toBe(0);
      await emit(pair.hostPage, 'demo:enter');
      await expect.poll(() => guestRequests).toBe(1);
      await expect.poll(() => readState(pair.guestPage, 'demo.loading')).toBe(true);
      await expect.poll(() => readState(pair.hostPage, 'demo.loading')).toBe(false);
      // The current demo must not end or select another track while the guest
      // CDN boundary is held. Pause through the actual host control.
      await pair.hostPage.locator('#btn-demo-settings').click();
      await expect.poll(() => readState(pair.hostPage, 'playback.activity')).toBe('playing');
      await pair.hostPage.locator('[data-demo-play]').click();
      await expect.poll(() => readState(pair.hostPage, 'playback.activity')).toBe('paused');
      await pair.guestPage.evaluate(() => {
        const w = window as unknown as {
          __MUSIXQUARE_GET_STATE__(path: string): unknown;
          __demoNewEffectsEnterReceived: boolean;
        };
        w.__demoNewEffectsEnterReceived = false;
        const host = w.__MUSIXQUARE_GET_STATE__('network.hostConn') as {
          on(
            event: string,
            listener: (frame: { type: string; bassBoostOn?: boolean }) => void,
          ): void;
        };
        host.on('data', (frame) => {
          if (frame.type === 'demo-enter' && frame.bassBoostOn) {
            w.__demoNewEffectsEnterReceived = true;
          }
        });
      });
      await pair.hostPage.locator('[data-demo-step="3"]').click();
      const bass = pair.hostPage.locator('[data-demo-effect="bass"]');
      await expect(bass).toHaveAttribute('aria-pressed', 'false');
      await bass.click();
      await expect(bass).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => readState(pair.guestPage, 'audio.virtualBass')).toBe(0.6);
      // Wait for the host's debounced effect-flag message too. Delivering it
      // after the simulated outage would legitimately start a new demo attempt.
      await expect
        .poll(() =>
          pair.guestPage.evaluate(
            () =>
              (window as unknown as { __demoNewEffectsEnterReceived: boolean })
                .__demoNewEffectsEnterReceived,
          ),
        )
        .toBe(true);
      // The newer value reached the guest through the real peer connection,
      // while the entry snapshot still contains the pre-demo value of zero.
      release();
      if (outcome === 'failed') {
        await expect.poll(() => guestRequests).toBe(2); // original request + built-in retry
      } else {
        await expect.poll(() => readState(pair.guestPage, 'demo.loading')).toBe(false);
        await emit(pair.hostPage, 'demo:request-exit');
      }
      await expect.poll(() => readState(pair.guestPage, 'demo.active')).toBe(false);
      await expect(pair.guestPage.locator('#demo-overlay')).not.toHaveClass(/active/);
      await expect(pair.guestPage.locator('[data-demo-step="3"]')).toBeHidden();
      await expect.poll(() => readState(pair.guestPage, 'audio.virtualBass')).toBe(0.6);
      await navigateToTab(pair.guestPage, 'settings');
      await navigateToSubtab(pair.guestPage, 'audio');
      await expect(
        pair.guestPage.locator('#grid-virtual-effects [data-virtual-effect="bass"]'),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        pair.guestPage.locator('#grid-settings-sync [data-settings-sync="on"]'),
      ).toHaveAttribute('aria-pressed', 'true');
      expect(await readState(pair.hostPage, 'audio.virtualBass')).toBe(0.6);
    } finally {
      release();
      await cleanupContexts(pair);
    }
  });
}
