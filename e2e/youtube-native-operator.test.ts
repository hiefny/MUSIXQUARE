/** Real host/guest transport; deterministic iframe callbacks, not physical YouTube keys. */
import { test, expect, type Page } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  navigateToSubtab,
  navigateToTab,
  waitForDeviceCount,
  waitForState,
} from './helpers/wait.ts';
import {
  installFakeYt,
  controlFakeYt,
  readFakeYtSnapshot,
  clearFakeYtLog,
  readFakeYtLog,
} from './helpers/fake-yt.ts';

let pair: HostGuestPair;

async function waitForPlaying(page: Page): Promise<void> {
  await waitForState(page, 'playback.activity', 'playing');
  await expect.poll(async () => (await readFakeYtSnapshot(page))?.state).toBe(1);
}

async function prepareRoom(): Promise<void> {
  await connectHostAndGuest(pair.hostPage, pair.guestPage);
  await pair.hostPage.evaluate(() => {
    const bus = (
      window as unknown as {
        __MUSIXQUARE_BUS__: { emit: (type: string, ...args: unknown[]) => void };
      }
    ).__MUSIXQUARE_BUS__;
    bus.emit('youtube:load-from-chat', 'https://www.youtube.com/watch?v=FAKEVID0001');
  });
  await Promise.all([waitForPlaying(pair.hostPage), waitForPlaying(pair.guestPage)]);
  // Let the initial rendezvous finish through actual advancing media, rather
  // than clearing its ownership timers to manufacture an eligible native input.
  await expect
    .poll(async () => (await readFakeYtSnapshot(pair.guestPage))?.currentTime ?? 0)
    .toBeGreaterThan(6);
}

test.describe('YouTube iframe administrator controls', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
    await installFakeYt(pair.hostPage, { advanceClock: true });
    await installFakeYt(pair.guestPage, { advanceClock: true });
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      const snapshots = await Promise.allSettled(
        [pair.hostPage, pair.guestPage].map((page) =>
          page.evaluate(() => {
            const w = window as unknown as {
              __MUSIXQUARE_GET_STATE__: (key: string) => unknown;
              __fakeYtLog: unknown[];
              __fakeYtLastPlayer: Record<string, unknown>;
            };
            return {
              state: Object.fromEntries(
                [
                  'playback.activity',
                  'network.isOperator',
                  'network.standardRoomCapabilities',
                  'playlist.currentQueueItemId',
                  'youtube.currentSubIndex',
                  'room.context',
                ].map((key) => [key, w.__MUSIXQUARE_GET_STATE__(key)]),
              ),
              playerLog: w.__fakeYtLog,
            };
          }),
        ),
      );
      await testInfo.attach('native-control-diagnostics', {
        body: JSON.stringify({ snapshots }),
        contentType: 'application/json',
      });
    }
    await cleanupContexts(pair);
  });

  test('administrator native pause, resume and seek reach the host once and settle', async () => {
    await prepareRoom();
    await navigateToTab(pair.hostPage, 'settings');
    await navigateToSubtab(pair.hostPage, 'connect');
    await waitForDeviceCount(pair.hostPage, 2);
    await pair.hostPage.locator('.d-op-btn:visible').first().click();
    await waitForState(pair.guestPage, 'network.isOperator', true);

    await controlFakeYt(pair.guestPage, { state: 2 });
    await waitForState(pair.hostPage, 'playback.activity', 'paused');
    await expect.poll(async () => (await readFakeYtSnapshot(pair.hostPage))?.state).toBe(2);
    await waitForState(pair.guestPage, 'playback.activity', 'paused');

    await controlFakeYt(pair.guestPage, { state: 1 });
    await Promise.all([waitForPlaying(pair.hostPage), waitForPlaying(pair.guestPage)]);
    const resumedAt = (await readFakeYtSnapshot(pair.guestPage))!.currentTime;
    await expect
      .poll(async () => (await readFakeYtSnapshot(pair.guestPage))?.currentTime ?? 0)
      .toBeGreaterThan(resumedAt + 4);

    await navigateToTab(pair.guestPage, 'play');
    await pair.guestPage.evaluate(() => {
      // Model focus entering the provider frame; media callbacks remain the
      // deterministic fixture, so this does not claim to test YouTube keys.
      const frame = document.createElement('iframe');
      frame.id = 'native-control-fixture';
      frame.title = 'Deterministic provider focus';
      frame.srcdoc = '<button>Player controls</button>';
      document.getElementById('youtube-player-container')!.append(frame);
    });
    await pair.guestPage.frameLocator('#native-control-fixture').locator('button').waitFor();
    await pair.guestPage.evaluate(() => {
      const frame = document.getElementById('native-control-fixture') as HTMLIFrameElement;
      frame.contentDocument!.querySelector('button')!.addEventListener('click', () => {
        const w = window as unknown as {
          __fakeYtLastPlayer: {
            getCurrentTime(): number;
            __setCurrentTime(time: number): void;
            __setState(state: number): void;
          };
          __nativeFirstSeek?: { before: number; focused: boolean };
        };
        const player = w.__fakeYtLastPlayer;
        w.__nativeFirstSeek = {
          before: player.getCurrentTime(),
          focused: document.hasFocus() && document.activeElement === frame,
        };
        // First pointer interaction both enters the iframe and changes media
        // position. There is no focused warm-up sample before the raw callback.
        player.__setCurrentTime(w.__nativeFirstSeek.before + 10);
        player.__setState(3);
        player.__setState(1);
      });
    });
    await expect(pair.guestPage.locator('#native-control-fixture')).not.toBeFocused();
    await clearFakeYtLog(pair.hostPage);
    await pair.guestPage.frameLocator('#native-control-fixture').locator('button').click();
    const firstSeek = await pair.guestPage.evaluate(
      () =>
        (window as unknown as { __nativeFirstSeek: { before: number; focused: boolean } })
          .__nativeFirstSeek,
    );
    expect(firstSeek.focused).toBe(true);
    const beforeSeek = firstSeek.before;
    await expect
      .poll(async () => (await readFakeYtSnapshot(pair.hostPage))?.currentTime ?? 0)
      .toBeGreaterThan(beforeSeek + 8);
    await Promise.all([waitForPlaying(pair.hostPage), waitForPlaying(pair.guestPage)]);
    const settledAt = (await readFakeYtSnapshot(pair.hostPage))!.currentTime;
    await expect
      .poll(async () => (await readFakeYtSnapshot(pair.hostPage))?.currentTime ?? 0)
      .toBeGreaterThan(settledAt + 3);
    const [host, guest] = await Promise.all([
      readFakeYtSnapshot(pair.hostPage),
      readFakeYtSnapshot(pair.guestPage),
    ]);
    expect(host?.state).toBe(1);
    expect(guest?.state).toBe(1);
    expect(Math.abs(host!.currentTime - guest!.currentTime)).toBeLessThan(1);
    const seeks = (await readFakeYtLog(pair.hostPage)).filter((entry) => entry.op === 'seekTo');
    expect(seeks).toHaveLength(1);
  });

  test('ordinary guest native pause cannot pause the host', async () => {
    await prepareRoom();
    await waitForState(pair.guestPage, 'network.isOperator', false);
    const before = (await readFakeYtSnapshot(pair.hostPage))!.currentTime;
    await clearFakeYtLog(pair.hostPage);
    await controlFakeYt(pair.guestPage, { state: 2 });
    await expect.poll(async () => (await readFakeYtSnapshot(pair.guestPage))?.state).toBe(2);
    await expect
      .poll(async () => (await readFakeYtSnapshot(pair.hostPage))?.currentTime ?? 0)
      .toBeGreaterThan(before + 3);
    await waitForPlaying(pair.hostPage);
    expect(
      (await readFakeYtLog(pair.hostPage)).filter((entry) => entry.op === 'pauseVideo'),
    ).toEqual([]);
  });
});
