import { test, expect, type Page } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  useAnonymousAccountSession,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { installFakeYt, readFakeYtSnapshot, readFakeYtLog } from './helpers/fake-yt.ts';
import { navigateToTab } from './helpers/wait.ts';
async function emit(page: Page, name: string, ...args: unknown[]) {
  await page.evaluate(({ name, args }) => (window as any).__MUSIXQUARE_BUS__.emit(name, ...args), {
    name,
    args,
  });
}
async function playing(page: Page, id: string) {
  await expect
    .poll(
      async () => {
        const p = await readFakeYtSnapshot(page);
        return p?.videoId === id && p.state === 1 && !p.muted;
      },
      { timeout: 20000 },
    )
    .toBe(true);
}
for (const scenario of ['no-seek', 'pending-seek', 'repeated-pending-seek', 'settled-seek'])
  test(`FIFO delayed cue, ${scenario}`, async ({ browser }, testInfo) => {
    test.setTimeout(60000);
    const pair = await createHostGuestContexts(browser);
    try {
      for (const p of [pair.hostPage, pair.guestPage]) {
        await p.route('**/*', (route) => {
          const u = new URL(route.request().url());
          if (['127.0.0.1', 'localhost'].includes(u.hostname)) return route.continue();
          return route.abort();
        });
        await installFakeYt(p, {
          autoPlayOnLoad: true,
          advanceClock: true,
          emitBuffering: true,
          playDelayMs: 20,
        });
        await p.addInitScript(() => {
          const yt = (window as any).YT;
          const Original = yt.Player;
          yt.Player = function (...args: any[]) {
            const p = new Original(...args);
            p.getPlaylistIndex = () => -1;
            return p;
          };
        });
      }
      await useAnonymousAccountSession(pair.hostPage, pair.guestPage);
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      await emit(
        pair.hostPage,
        'youtube:load-from-chat',
        'https://www.youtube.com/watch?v=FAKEVID0001',
      );
      await Promise.all([
        playing(pair.hostPage, 'FAKEVID0001'),
        playing(pair.guestPage, 'FAKEVID0001'),
      ]);
      await expect(pair.hostPage.locator('#btn-sync')).toHaveAttribute('aria-disabled', 'false');
      await emit(
        pair.hostPage,
        'youtube:load-from-chat',
        'https://www.youtube.com/watch?v=FAKEVID0002',
      );
      const queueId = await pair.hostPage.evaluate(
        () => (window as any).__MUSIXQUARE_GET_STATE__('playlist.items').at(-1).queueItemId,
      );
      await pair.hostPage.evaluate(() => {
        const w = window as any,
          p = w.__fakeYtLastPlayer;
        const cue = p.cueVideoById.bind(p),
          seek = p.seekTo.bind(p);
        let pending: any[] | null = null,
          queuedSeeks: any[][] = [];
        p.cueVideoById = (...args: any[]) => {
          pending = args;
          w.__qaCuePending = true;
        };
        p.seekTo = (...args: any[]) => {
          if (pending) queuedSeeks.push(args);
          else seek(...args);
        };
        w.__qaReleaseCue = () => {
          if (!pending) throw new Error('No pending native cue');
          const args = pending;
          pending = null;
          cue(...args);
          for (const s of queuedSeeks) seek(...s);
          queuedSeeks = [];
          p.cueVideoById = cue;
          p.seekTo = seek;
          w.__qaCuePending = false;
        };
      });
      await navigateToTab(pair.hostPage, 'playlist');
      await pair.hostPage.locator(`[data-action="play"][data-queue-item-id="${queueId}"]`).click();
      await expect
        .poll(() => pair.hostPage.evaluate(() => (window as any).__qaCuePending))
        .toBe(true);
      await navigateToTab(pair.hostPage, 'play');
      const slider = pair.hostPage.locator('#seek-slider');
      await expect(slider).toHaveAttribute('aria-disabled', 'false');
      if (scenario === 'pending-seek' || scenario === 'repeated-pending-seek') {
        await slider.fill('70');
      }
      if (scenario === 'repeated-pending-seek') {
        await slider.fill('95');
      }
      await pair.hostPage.evaluate(() => (window as any).__qaReleaseCue());
      await Promise.all([
        playing(pair.hostPage, 'FAKEVID0002'),
        playing(pair.guestPage, 'FAKEVID0002'),
      ]);
      if (scenario === 'settled-seek') {
        await expect(slider).toHaveAttribute('aria-disabled', 'false');
        await slider.fill('70');
        await expect
          .poll(async () => (await readFakeYtSnapshot(pair.hostPage))?.currentTime)
          .toBeGreaterThanOrEqual(70);
      }
      const target = scenario === 'repeated-pending-seek' ? 95 : 70;
      if (scenario !== 'no-seek') {
        await expect
          .poll(async () => (await readFakeYtSnapshot(pair.guestPage))?.currentTime)
          .toBeGreaterThanOrEqual(target);
      }
      const result = {
        host: await readFakeYtSnapshot(pair.hostPage),
        guest: await readFakeYtSnapshot(pair.guestPage),
        hostLog: await readFakeYtLog(pair.hostPage),
      };
      await testInfo.attach('final-observation', {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
      });
      if (scenario !== 'no-seek') {
        expect(result.host?.currentTime).toBeGreaterThanOrEqual(target);
        expect(result.guest?.currentTime).toBeGreaterThanOrEqual(target);
      } else expect(result.host?.currentTime).toBeLessThan(6);
    } finally {
      await cleanupContexts(pair);
    }
  });
