import { test, expect } from '@playwright/test';
import { cleanupContexts, createHostGuestContexts } from './helpers/context-factory.ts';
import { uploadFixtures } from './helpers/file-upload.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  navigateToTab,
  readState,
  waitForFilePlaybackReady,
  waitForPlaybackProjection,
  waitForState,
} from './helpers/wait.ts';

type WireFrame = { type?: string; queueItemId?: string; sessionId?: number };
type PreloadReadWindow = Window & {
  __releasePreloadRead?: () => void;
  __preloadFrames?: WireFrame[];
  __MUSIXQUARE_GET_STATE__?: (key: string) => unknown;
};

test('repeat changes preserve the guest transfer after a preload becomes the current track', async ({
  browser,
}, testInfo) => {
  const pair = await createHostGuestContexts(browser);
  const { hostPage: host, guestPage: guest } = pair;
  const messages: string[] = [];
  for (const [name, page] of [
    ['host', host],
    ['guest', guest],
  ] as const) {
    await page.addInitScript(() => localStorage.setItem('mxqr:logLevel', 'DEBUG'));
    page.on('console', (message) => messages.push(`${name}: ${message.text()}`));
  }
  try {
    await connectHostAndGuest(host, guest);
    await host.evaluate(() => {
      const root = window as PreloadReadWindow;
      const peers = root.__MUSIXQUARE_GET_STATE__?.('network.connectedPeers') as Array<{
        conn: { send: (frame: WireFrame, ...args: unknown[]) => unknown };
      }>;
      if (!peers?.[0]) throw new Error('Connected guest is missing');
      const connection = peers[0].conn;
      const send = connection.send.bind(connection);
      root.__preloadFrames = [];
      connection.send = (frame, ...args) => {
        root.__preloadFrames!.push({
          type: frame.type,
          queueItemId: frame.queueItemId,
          sessionId: frame.sessionId,
        });
        return send(frame, ...args);
      };

      // Keep native decoding and transport. Only delay the first transfer
      // chunk's file read, as a slow disk/cloud-backed source could do.
      const originalSlice = File.prototype.slice;
      File.prototype.slice = function (this: File, ...args: Parameters<Blob['slice']>) {
        const chunk = originalSlice.apply(this, args);
        if (this.name === 'test-02.mp3' && chunk.size === 64 * 1024) {
          File.prototype.slice = originalSlice;
          const read = chunk.arrayBuffer.bind(chunk);
          Object.defineProperty(chunk, 'arrayBuffer', {
            value: async () => {
              const bytes = await read();
              await new Promise<void>((resolve) => {
                root.__releasePreloadRead = resolve;
              });
              return bytes;
            },
          });
        }
        return chunk;
      };
    });
    await uploadFixtures(host, ['test01', 'test02', 'test03']);
    await host.waitForFunction(
      () => typeof (window as PreloadReadWindow).__releasePreloadRead === 'function',
    );
    const items = (await readState(host, 'playlist.items')) as Array<{ queueItemId: string }>;
    const selected = items[1]?.queueItemId;
    if (!selected) throw new Error('Second queue occurrence is missing');
    await expect
      .poll(
        async () => ((await readState(guest, 'preload.activeTarget')) as WireFrame)?.queueItemId,
      )
      .toBe(selected);
    const preload = (await readState(guest, 'preload.activeTarget')) as WireFrame;

    await navigateToTab(host, 'playlist');
    await host.locator(`.track-name[data-action="play"][data-queue-item-id="${selected}"]`).click();
    await waitForState(host, 'playlist.currentQueueItemId', selected);
    await waitForFilePlaybackReady(host);
    await waitForPlaybackProjection(host, 'PLAYING_AUDIO');
    await waitForState(guest, 'playlist.currentQueueItemId', selected);
    await navigateToTab(host, 'playlist');
    await host.locator('#btn-repeat').click();
    await waitForState(host, 'playlist.repeatMode', 1);
    await host.locator('#btn-repeat').click();
    await waitForState(host, 'playlist.repeatMode', 2);

    const frames = await host.evaluate(() => (window as PreloadReadWindow).__preloadFrames);
    expect(
      frames?.filter(
        (frame) =>
          frame.type === 'preload-abort' &&
          frame.queueItemId === selected &&
          frame.sessionId === preload.sessionId,
      ),
    ).toEqual([]);
    await host.evaluate(() => (window as PreloadReadWindow).__releasePreloadRead?.());
    await expect
      .poll(async () => ((await readState(guest, 'files.current')) as WireFrame)?.queueItemId)
      .toBe(selected);
    await waitForFilePlaybackReady(guest);
    await waitForPlaybackProjection(guest, 'PLAYING_AUDIO');
    await waitForState(guest, 'playlist.repeatMode', 2);
  } finally {
    await testInfo.attach('preload-console', {
      body: messages.join('\n'),
      contentType: 'text/plain',
    });
    await testInfo.attach('preload-frames', {
      body: JSON.stringify(
        await host.evaluate(() => (window as PreloadReadWindow).__preloadFrames),
      ),
      contentType: 'application/json',
    });
    for (const [name, page] of [
      ['host', host],
      ['guest', guest],
    ] as const) {
      const state: Record<string, unknown> = {};
      for (const key of [
        'files.current',
        'playback.lifecycle',
        'playback.activity',
        'preload.activeTarget',
        'preload.ready',
        'preload.sessionId',
        'transfer.currentSessionId',
        'transfer.meta',
        'playlist.currentQueueItemId',
      ]) {
        state[key] = await readState(page, key);
      }
      await testInfo.attach(`${name}-state`, {
        body: JSON.stringify(state),
        contentType: 'application/json',
      });
    }
    await cleanupContexts(pair);
  }
});
