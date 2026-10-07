import { expect, test } from '@playwright/test';
import { waitForBootstrapReady } from './helpers/bootstrap.ts';
import { cleanupContexts, createHostGuestContexts } from './helpers/context-factory.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { readQueueSnapshot, waitForCurrentQueueIndex } from './helpers/queue-state.ts';
import { setupGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import {
  clickPlayButton,
  waitForDeviceCount,
  waitForFilePlaybackReady,
  waitForPlaybackProjection,
  waitForPlaylistCount,
  waitForState,
} from './helpers/wait.ts';

type BootstrapWindow = Window & {
  __releaseBootstrapAck?: () => void;
  __MUSIXQUARE_BUS__?: {
    on(event: string, callback: (connection: { send(data: unknown): void } | null) => void): void;
  };
};

for (const scenario of ['added track', 'paused existing track'] as const) {
  test(`joining guest catches ${scenario} while its bootstrap acknowledgement is in flight`, async ({
    browser,
  }) => {
    const pair = await createHostGuestContexts(browser);
    const lateContext = await browser.newContext();
    const lateGuest = await lateContext.newPage();
    const host = pair.hostPage;
    const existingGuest = pair.guestPage;
    try {
      const code = await setupHostAndStart(host);
      await uploadFixture(host, 'test01');
      await waitForFilePlaybackReady(host);
      if (scenario === 'paused existing track') {
        await uploadFixture(host, 'test02');
        await waitForPlaylistCount(host, 2);
      }
      await clickPlayButton(host);
      await waitForPlaybackProjection(host, 'PLAYING_AUDIO');
      await setupGuest(existingGuest, code);
      await waitForPlaybackProjection(existingGuest, 'PLAYING_AUDIO');

      await injectPeerServer(lateGuest);
      await lateGuest.goto('/');
      await waitForBootstrapReady(lateGuest);
      await lateGuest.evaluate(() => {
        const root = window as BootstrapWindow;
        if (!root.__MUSIXQUARE_BUS__) throw new Error('Missing test bus');
        root.__MUSIXQUARE_BUS__.on('state:network.hostConn', (connection) => {
          if (!connection) return;
          const send = connection.send.bind(connection);
          const pending: unknown[] = [];
          let holding = false;
          connection.send = (frame) => {
            if (
              holding ||
              (frame &&
                typeof frame === 'object' &&
                (frame as { type?: string }).type === 'join-bootstrap-applied')
            ) {
              holding = true;
              pending.push(frame);
              root.__releaseBootstrapAck = () => {
                connection.send = send;
                // Preserve data-channel ordering behind the delayed ACK.
                for (const message of pending) send(message);
                pending.length = 0;
              };
              return;
            }
            send(frame);
          };
        });
      });
      await lateGuest.locator('#btn-setup-guest').click();
      await lateGuest.locator('#setup-join-code').fill(code);
      await lateGuest.locator('#btn-setup-confirm').click();
      await lateGuest.waitForFunction(
        () => typeof (window as BootstrapWindow).__releaseBootstrapAck === 'function',
      );
      await waitForPlaylistCount(lateGuest, scenario === 'added track' ? 1 : 2);

      // Mutate through the real host UI during the actual ACK transport gap.
      // Existing participants must keep following the new queue normally.
      if (scenario === 'added track') {
        await uploadFixture(host, 'test02');
        await waitForPlaylistCount(host, 2);
      }
      await host.locator('#btn-next').click();
      await waitForCurrentQueueIndex(host, 1);
      await waitForPlaybackProjection(host, 'PLAYING_AUDIO');
      if (scenario === 'added track') {
        await host.locator('#btn-repeat').click();
        await waitForState(host, 'playlist.repeatMode', 1);
      } else {
        await clickPlayButton(host);
        await waitForPlaybackProjection(host, 'PAUSED');
      }
      await waitForPlaylistCount(existingGuest, 2);
      const expectedQueue = await readQueueSnapshot(host);

      await lateGuest.evaluate(() => (window as BootstrapWindow).__releaseBootstrapAck?.());
      await waitForDeviceCount(host, 3);
      for (const guest of [existingGuest, lateGuest]) {
        await waitForPlaylistCount(guest, 2);
        await waitForCurrentQueueIndex(guest, 1);
        await waitForState(guest, 'playlist.repeatMode', scenario === 'added track' ? 1 : 0);
        await waitForPlaybackProjection(
          guest,
          scenario === 'added track' ? 'PLAYING_AUDIO' : 'PAUSED',
        );
        const queue = await readQueueSnapshot(guest);
        expect(queue.items.map((item) => item.queueItemId)).toEqual(
          expectedQueue.items.map((item) => item.queueItemId),
        );
        expect(queue.currentQueueItemId).toBe(expectedQueue.currentQueueItemId);
        expect(queue.revision).toBe(expectedQueue.revision);
      }
    } finally {
      await lateContext.close();
      await cleanupContexts(pair);
    }
  });
}
