import { test, expect, type Page } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { installFakeYt, readFakeYtSnapshot } from './helpers/fake-yt.ts';

type AuditWindow = Window & {
  __MUSIXQUARE_BUS__: { emit(name: string, ...args: unknown[]): void };
  __MUSIXQUARE_GET_STATE__(key: string): unknown;
  __fakeYtLastPlayer: { getCurrentTime(): number };
};

async function emit(page: Page, name: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(
    ({ name, args }) => {
      (window as unknown as AuditWindow).__MUSIXQUARE_BUS__.emit(name, ...args);
    },
    { name, args },
  );
}

async function playing(page: Page, videoId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const p = await readFakeYtSnapshot(page);
        return p?.videoId === videoId && p.state === 1 && !p.muted && p.currentTime > 0.03;
      },
      { timeout: 25000 },
    )
    .toBe(true);
}

async function editOffset(page: Page, ms: number): Promise<void> {
  await expect(page.locator('#btn-sync')).toHaveAttribute('aria-disabled', 'false');
  await page.locator('#btn-sync').click();
  const editor = page.locator('#manual-sync-value');
  await expect(editor).toBeVisible();
  await editor.fill(String(ms));
  await editor.press('Enter');
  await page.locator('#btn-sync-done').click();
}

async function clock(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as AuditWindow;
    return {
      at: Date.now(),
      position: w.__fakeYtLastPlayer.getCurrentTime(),
      requested: Number(w.__MUSIXQUARE_GET_STATE__('sync.youtubeLocalOffset')),
    };
  });
}

for (const [label, hostMs, guestMs] of [
  ['guest negative', 0, -250],
  ['host negative', -250, 0],
  ['host long negative', -5000, 0],
  ['both negative', -250, -250],
  ['guest positive control', 0, 250],
  ['host positive control', 250, 0],
] as const) {
  test(`preserves ${label} manual sync across the next YouTube start`, async ({ browser }) => {
    test.setTimeout(90000);
    const pair = await createHostGuestContexts(browser);
    try {
      for (const page of [pair.hostPage, pair.guestPage]) {
        await installFakeYt(page, {
          autoPlayOnLoad: true,
          advanceClock: true,
          emitBuffering: true,
          playDelayMs: 20,
        });
        // These tests use standalone videos. Model IFrame API playlist
        // detachment accurately; the shared legacy fake defaults to index 0.
        await page.addInitScript(() => {
          type Player = { getPlaylistIndex(): number };
          const yt = (window as unknown as { YT: { Player: new (...args: unknown[]) => Player } })
            .YT;
          const Original = yt.Player;
          yt.Player = function (...args: unknown[]) {
            const p = new Original(...args);
            p.getPlaylistIndex = () => -1;
            return p;
          } as unknown as typeof Original;
        });
      }
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
      // Allow the initial protocol and a fresh ordinary host heartbeat to settle.
      await pair.hostPage.waitForTimeout(7000);
      if (hostMs) {
        await editOffset(pair.hostPage, hostMs);
        await pair.hostPage.waitForTimeout(4500);
      }
      if (guestMs) {
        await editOffset(pair.guestPage, guestMs);
        await pair.guestPage.waitForTimeout(4500);
      }

      const assertOffset = async () => {
        const [host, guest] = await Promise.all([clock(pair.hostPage), clock(pair.guestPage)]);
        expect(host.requested).toBe(hostMs / 1000);
        expect(guest.requested).toBe(guestMs / 1000);
        const difference = guest.position + (host.at - guest.at) / 1000 - host.position;
        // Browser scheduling and the deterministic 20 ms PLAYING acknowledgement
        // are allowed; losing a 250 ms setting cannot pass this tolerance.
        expect(Math.abs(difference - (guestMs - hostMs) / 1000)).toBeLessThan(0.12);
      };
      await assertOffset();
      await emit(
        pair.hostPage,
        'youtube:load-from-chat',
        'https://www.youtube.com/watch?v=FAKEVID0002',
      );
      const queueItemId = await pair.hostPage.evaluate(() => {
        const items = (window as unknown as AuditWindow).__MUSIXQUARE_GET_STATE__(
          'playlist.items',
        ) as Array<{
          queueItemId: string;
        }>;
        return items.at(-1)?.queueItemId;
      });
      await emit(pair.hostPage, 'playlist:play-track', queueItemId);
      await Promise.all([
        playing(pair.hostPage, 'FAKEVID0002'),
        playing(pair.guestPage, 'FAKEVID0002'),
      ]);
      await assertOffset();
      await pair.hostPage.waitForTimeout(6000);
      await assertOffset();
    } finally {
      await cleanupContexts(pair);
    }
  });
}
