import { test, expect, type Page } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { configureFakeYt, installFakeYt, readFakeYtSnapshot } from './helpers/fake-yt.ts';
import type { ProtocolMsg } from '../src/types/index.ts';

type ZeroStartCommit = ProtocolMsg<'youtube-zero-start-commit'>;

type AuditWindow = Window & {
  __MUSIXQUARE_BUS__: { emit(name: string, ...args: unknown[]): void };
  __MUSIXQUARE_GET_STATE__(key: string): unknown;
  __fakeYtLastPlayer: { getCurrentTime(): number };
  __zeroStartCommits: ZeroStartCommit[];
};

async function installStandalonePlayer(page: Page): Promise<void> {
  await installFakeYt(page, {
    autoPlayOnLoad: true,
    advanceClock: true,
    emitBuffering: true,
    playDelayMs: 20,
  });
  // Standalone videos detach from the iframe playlist. The legacy fake's
  // default index 0 otherwise describes a different playback mode.
  await page.addInitScript(() => {
    type Player = { getPlaylistIndex(): number };
    const yt = (window as unknown as { YT: { Player: new (...args: unknown[]) => Player } }).YT;
    const Original = yt.Player;
    yt.Player = function (...args: unknown[]) {
      const player = new Original(...args);
      player.getPlaylistIndex = () => -1;
      return player;
    } as unknown as typeof Original;
  });
}

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
  ['guest minimum', 0, -9999],
  ['host minimum', -9999, 0],
  ['opposite limits', 9999, -9999],
  ['both negative', -250, -250],
  ['guest positive control', 0, 250],
  ['host positive control', 250, 0],
] as const) {
  test(`preserves ${label} manual sync across the next YouTube start`, async ({ browser }) => {
    test.setTimeout(110000);
    const pair = await createHostGuestContexts(browser);
    try {
      for (const page of [pair.hostPage, pair.guestPage]) {
        await installStandalonePlayer(page);
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
      // A minimum offset must be tested away from the beginning of the current
      // video, before checking its separate start-at-zero scheduling contract.
      await pair.hostPage.waitForTimeout(Math.min(hostMs, guestMs) < -7000 ? 15000 : 7000);
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

test('keeps a slow guest fallback as the sole start owner when Sync is clicked', async ({
  browser,
}) => {
  test.setTimeout(110000);
  const pair = await createHostGuestContexts(browser);
  try {
    await installStandalonePlayer(pair.hostPage);
    await installStandalonePlayer(pair.guestPage);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await pair.guestPage.evaluate(() => {
      const w = window as unknown as AuditWindow;
      w.__zeroStartCommits = [];
      const connection = w.__MUSIXQUARE_GET_STATE__('network.hostConn') as {
        on(event: 'data', callback: (data: unknown) => void): void;
      };
      connection.on('data', (data) => {
        if (
          data !== null &&
          typeof data === 'object' &&
          'type' in data &&
          data.type === 'youtube-zero-start-commit'
        ) {
          w.__zeroStartCommits.push(data as ZeroStartCommit);
        }
      });
    });
    await emit(
      pair.hostPage,
      'youtube:load-from-chat',
      'https://www.youtube.com/watch?v=FAKEVID0001',
    );
    await Promise.all([
      playing(pair.hostPage, 'FAKEVID0001'),
      playing(pair.guestPage, 'FAKEVID0001'),
    ]);
    // Apply the minimum offset away from the track boundary through the real editor.
    await pair.hostPage.waitForTimeout(15000);
    await editOffset(pair.guestPage, -9999);
    await pair.guestPage.waitForTimeout(4500);

    // Miss the real PREPARE cohort through player response latency alone.
    // Do not inject controller phase, fallback ownership, or requested offset.
    await configureFakeYt(pair.guestPage, { loadDelayMs: 3500, playDelayMs: 3500 });
    await emit(
      pair.hostPage,
      'youtube:load-from-chat',
      'https://www.youtube.com/watch?v=FAKEVID0002',
    );
    const nextId = await pair.hostPage.evaluate(() => {
      const items = (window as unknown as AuditWindow).__MUSIXQUARE_GET_STATE__(
        'playlist.items',
      ) as Array<{ queueItemId: string }>;
      return items.at(-1)?.queueItemId;
    });
    expect(nextId).toBeTruthy();
    await emit(pair.hostPage, 'playlist:play-track', nextId);
    await pair.guestPage.waitForFunction(() =>
      (window as unknown as AuditWindow).__zeroStartCommits.some(
        (message) => message.videoId === 'FAKEVID0002',
      ),
    );
    const { commit, guestId } = await pair.guestPage.evaluate(() => {
      const w = window as unknown as AuditWindow;
      return {
        commit: w.__zeroStartCommits.find((message) => message.videoId === 'FAKEVID0002')!,
        guestId: w.__MUSIXQUARE_GET_STATE__('network.myId'),
      };
    });
    expect(commit.cohort).not.toContain(guestId);
    expect(commit.reason).toBe('guest-timeout');
    await configureFakeYt(pair.guestPage, { loadDelayMs: 20, playDelayMs: 20 });

    // Click one second before the guest's -9999 ms delayed release. A real
    // pointer click is used because locator.click waits for aria-disabled to
    // clear, which would silently test after the race window instead.
    const remaining = commit.startAtHost + 9000 - Date.now();
    expect(remaining).toBeGreaterThan(0);
    await pair.guestPage.waitForTimeout(remaining);
    const sync = pair.guestPage.locator('#btn-sync');
    await expect(sync).toHaveAttribute('aria-disabled', 'true');
    const beforeClick = await readFakeYtSnapshot(pair.guestPage);
    expect(beforeClick?.videoId).toBe('FAKEVID0002');
    expect(beforeClick?.state).toBe(2);
    expect(beforeClick?.muted).toBe(true);
    const bounds = await sync.boundingBox();
    expect(bounds).not.toBeNull();
    await pair.guestPage.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await expect(pair.guestPage.locator('#manual-sync-value')).not.toBeVisible();

    await playing(pair.guestPage, 'FAKEVID0002');
    await expect(sync).toHaveAttribute('aria-disabled', 'false');
    // Assert promptly and across later heartbeats, so eventual correction
    // cannot hide a wrong first start or a second writer's leftover timer.
    for (let sample = 0; sample < 4; sample += 1) {
      const [host, guest] = await Promise.all([clock(pair.hostPage), clock(pair.guestPage)]);
      expect(guest.requested).toBe(-9.999);
      const relative = guest.position + (host.at - guest.at) / 1000 - host.position;
      expect(Math.abs(relative + 9.999)).toBeLessThan(0.15);
      if (sample < 3) await pair.guestPage.waitForTimeout(2000);
    }
    // The gate must also reopen after recovery; otherwise simply disabling
    // Sync forever could satisfy all of the race assertions above.
    await sync.click();
    await expect(pair.guestPage.locator('#manual-sync-value')).toBeVisible();
    await pair.guestPage.locator('#btn-sync-done').click();
  } finally {
    await cleanupContexts(pair);
  }
});
