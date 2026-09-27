import { test, expect, type Page } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { installFakeYt, readFakeYtSnapshot, controlFakeYt } from './helpers/fake-yt.ts';

type WireFrame = { type?: string };
type RepeatWindow = Window & {
  __MUSIXQUARE_BUS__: { emit(name: string, ...args: unknown[]): void };
  __MUSIXQUARE_GET_STATE__(key: string): unknown;
  __fakeYtLastPlayer: { getCurrentTime(): number; getPlayerState(): number };
  __releaseRepeatHeartbeat?: () => void;
};

async function emit(page: Page, name: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(
    ({ name, args }) => (window as unknown as RepeatWindow).__MUSIXQUARE_BUS__.emit(name, ...args),
    { name, args },
  );
}

async function playing(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const player = await readFakeYtSnapshot(page);
        return (
          player?.videoId === 'FAKEVID0001' &&
          player.state === 1 &&
          !player.muted &&
          player.currentTime > 0.03 &&
          player.currentTime < 5
        );
      },
      { timeout: 25000 },
    )
    .toBe(true);
}

test('applies an edit from the open Sync panel after repeat-one retires its old heartbeat', async ({
  browser,
}) => {
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
      await page.addInitScript(() => {
        type Player = { getPlaylistIndex(): number };
        const yt = (window as unknown as { YT: { Player: new (...args: unknown[]) => Player } }).YT;
        const Original = yt.Player;
        yt.Player = function (...args: unknown[]) {
          const player = new Original(...args);
          // A standalone video is detached from any iframe playlist.
          player.getPlaylistIndex = () => -1;
          return player;
        } as unknown as typeof Original;
      });
    }
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await emit(
      pair.hostPage,
      'youtube:load-from-chat',
      'https://www.youtube.com/watch?v=FAKEVID0001',
    );
    await Promise.all([playing(pair.hostPage), playing(pair.guestPage)]);
    await pair.hostPage.waitForTimeout(7000);
    await pair.guestPage.locator('#btn-sync').click();
    const editor = pair.guestPage.locator('#manual-sync-value');
    await expect(editor).toBeVisible();

    // Explicit scheduling fault injection: delay only ordinary host snapshots
    // during the next start. The real zero-start protocol, guest connection,
    // Sync panel, input commit and rendezvous handlers remain active.
    await pair.hostPage.evaluate(() => {
      const root = window as unknown as RepeatWindow;
      const peers = root.__MUSIXQUARE_GET_STATE__('network.connectedPeers') as Array<{
        conn: { send(frame: WireFrame, ...args: unknown[]): unknown };
      }>;
      const connection = peers[0].conn;
      const send = connection.send.bind(connection);
      let holding = false;
      let latest: { frame: WireFrame; args: unknown[] } | undefined;
      connection.send = (frame, ...args) => {
        if (frame.type === 'youtube-zero-start-prepare') holding = true;
        if (holding && frame.type === 'youtube-sync') {
          latest = { frame, args };
          return;
        }
        return send(frame, ...args);
      };
      root.__releaseRepeatHeartbeat = () => {
        connection.send = send;
        if (latest) send(latest.frame, ...latest.args);
      };
    });
    await emit(pair.hostPage, 'playlist:toggle-repeat');
    await emit(pair.hostPage, 'playlist:toggle-repeat');
    expect(
      await pair.hostPage.evaluate(() =>
        (window as unknown as RepeatWindow).__MUSIXQUARE_GET_STATE__('playlist.repeatMode'),
      ),
    ).toBe(2);
    await controlFakeYt(pair.hostPage, { state: 0, currentTime: 300 });
    await Promise.all([playing(pair.hostPage), playing(pair.guestPage)]);
    await expect(pair.guestPage.locator('#btn-sync')).toHaveAttribute('aria-disabled', 'false');
    await expect(editor).toBeVisible();
    await editor.fill('250');
    await editor.press('Enter');
    await expect
      .poll(() =>
        pair.guestPage.evaluate(() =>
          (window as unknown as RepeatWindow).__MUSIXQUARE_GET_STATE__('sync.youtubeLocalOffset'),
        ),
      )
      .toBe(0.25);
    await pair.hostPage.evaluate(() =>
      (window as unknown as RepeatWindow).__releaseRepeatHeartbeat?.(),
    );

    // An unapplied 250 ms preference stays nearly aligned at zero and cannot
    // pass this tolerance. Compare positions at a shared wall-clock instant.
    const offsetError = async () => {
      const [host, guest] = await Promise.all(
        [pair.hostPage, pair.guestPage].map((page) =>
          page.evaluate(() => ({
            at: Date.now(),
            position: (window as unknown as RepeatWindow).__fakeYtLastPlayer.getCurrentTime(),
            state: (window as unknown as RepeatWindow).__fakeYtLastPlayer.getPlayerState(),
          })),
        ),
      );
      if (host.state !== 1 || guest.state !== 1) return 1;
      return Math.abs(guest.position + (host.at - guest.at) / 1000 - host.position - 0.25);
    };
    await expect.poll(offsetError, { timeout: 15000 }).toBeLessThan(0.1);
    await pair.hostPage.waitForTimeout(3000);
    expect(await offsetError()).toBeLessThan(0.1);
  } finally {
    await cleanupContexts(pair);
  }
});
