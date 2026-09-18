/** Real host/guest transport with a controlled YouTube backend. These tests
 * check final media ownership across an end/rendezvous race, not acoustic sync. */
import { test, expect, type Page } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { readState, waitForFilePlaybackReady } from './helpers/wait.ts';
import { STAGE2_RENDEZVOUS_BROADCAST_MS } from '../src/youtube/constants.ts';
import {
  installFakeYt,
  controlFakeYt,
  readFakeYtSnapshot,
  readFakeYtLog,
  clearFakeYtLog,
} from './helpers/fake-yt.ts';

const VIDEO_ID = 'FAKEVID0001';

async function emit(page: Page, event: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(
    ({ event, args }) => {
      const bus = (window as unknown as Record<string, unknown>).__MUSIXQUARE_BUS__ as {
        emit: (event: string, ...args: unknown[]) => void;
      };
      bus.emit(event, ...args);
    },
    { event, args },
  );
}

async function expectPlayingYouTube(page: Page, queueItemId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const player = await readFakeYtSnapshot(page);
        return {
          queueItemId: await readState(page, 'playlist.currentQueueItemId'),
          mode: await readState(page, 'playback.mode'),
          videoId: player?.videoId,
          state: player?.state,
          destroyed: player?.destroyed,
        };
      },
      { timeout: 25_000 },
    )
    .toEqual({ queueItemId, mode: 'youtube', videoId: VIDEO_ID, state: 1, destroyed: false });
}

for (const guestDelayMs of [0, 240]) {
  for (const successor of ['repeat', 'seek', 'file'] as const) {
    test(`near-end rendezvous then ${successor}, guest player delay ${guestDelayMs}ms`, async ({
      browser,
    }, testInfo) => {
      test.setTimeout(75_000);
      const pair = await createHostGuestContexts(browser);
      const browserLog: string[] = [];
      try {
        for (const [page, delay] of [
          [pair.hostPage, 0],
          [pair.guestPage, guestDelayMs],
        ] as const) {
          const label = page === pair.hostPage ? 'host' : 'guest';
          page.on('console', (message) =>
            browserLog.push(`${label} ${message.type()}: ${message.text()}`),
          );
          await installFakeYt(page, {
            autoPlayOnLoad: true,
            advanceClock: true,
            emitBuffering: true,
            loadDelayMs: delay,
            playDelayMs: delay,
          });
          await page.route(/youtube\.com\/oembed/, (route) =>
            route.fulfill({ json: { title: 'End transition fixture' } }),
          );
        }
        await connectHostAndGuest(pair.hostPage, pair.guestPage);
        let fileQueueItemId: string | undefined;
        if (successor === 'file') {
          // Upload before the race so the later selection is immediate.
          await uploadFixture(pair.hostPage, 'test01');
          await expect
            .poll(async () => {
              const items = (await readState(pair.hostPage, 'playlist.items')) as Array<{
                type: string;
                queueItemId: string;
              }>;
              fileQueueItemId = items.find((item) => item.type === 'file')?.queueItemId;
              return fileQueueItemId;
            })
            .toBeTruthy();
          await Promise.all([
            waitForFilePlaybackReady(pair.hostPage, 20_000),
            waitForFilePlaybackReady(pair.guestPage, 20_000),
          ]);
        }
        await emit(
          pair.hostPage,
          'youtube:load-from-chat',
          `https://www.youtube.com/watch?v=${VIDEO_ID}`,
        );
        let queueItemId = '';
        await expect
          .poll(async () => {
            const items = (await readState(pair.hostPage, 'playlist.items')) as Array<{
              type: string;
              queueItemId: string;
              videoId?: string;
            }>;
            queueItemId =
              items.find((item) => item.type === 'youtube' && item.videoId === VIDEO_ID)
                ?.queueItemId ?? '';
            return queueItemId;
          })
          .toBeTruthy();
        // Adding to a nonempty queue intentionally does not replace its song.
        if ((await readState(pair.hostPage, 'playlist.currentQueueItemId')) !== queueItemId) {
          await emit(pair.hostPage, 'playlist:play-track', queueItemId);
        }
        await expectPlayingYouTube(pair.hostPage, queueItemId);
        await expectPlayingYouTube(pair.guestPage, queueItemId);
        // Exercise the production repeat control rather than writing app state.
        await pair.hostPage.locator('#btn-repeat').click();
        await pair.hostPage.locator('#btn-repeat').click();
        await expect.poll(() => readState(pair.hostPage, 'playlist.repeatMode')).toBe(2);
        await clearFakeYtLog(pair.guestPage);
        const duration = (await readFakeYtSnapshot(pair.hostPage))!.duration;
        const seekStartedAt = Date.now();
        await emit(pair.hostPage, 'youtube:seek-to', duration - 0.2);
        // The outgoing position must actually reach the guest before its owner
        // ends. A fixed sleep would not establish this causal overlap.
        await expect
          .poll(
            async () =>
              (await readFakeYtLog(pair.guestPage)).some(
                (entry) => entry.op === 'seekTo' && Number(entry.args?.[0]) > duration - 1,
              ),
            { timeout: 15_000 },
          )
          .toBe(true);
        // FakeYT clamps its clock at duration but never synthesizes ENDED.
        // Explicitly arm the guest's end handling before host takeover.
        await controlFakeYt(pair.guestPage, { currentTime: duration, state: 0 });
        expect(Date.now() - seekStartedAt).toBeLessThan(STAGE2_RENDEZVOUS_BROADCAST_MS);
        await controlFakeYt(pair.hostPage, { currentTime: duration, state: 0 });
        if (successor === 'seek') await emit(pair.hostPage, 'youtube:seek-to', 15);
        if (successor === 'file') {
          await emit(pair.hostPage, 'playlist:play-track', fileQueueItemId);
          for (const page of [pair.hostPage, pair.guestPage]) {
            await expect
              .poll(
                async () => ({
                  mode: await readState(page, 'playback.mode'),
                  activity: await readState(page, 'playback.activity'),
                  queueItemId: await readState(page, 'playlist.currentQueueItemId'),
                }),
                { timeout: 25_000 },
              )
              .toEqual({ mode: 'file', activity: 'playing', queueItemId: fileQueueItemId });
          }
        } else {
          if (successor === 'seek') {
            await expect
              .poll(
                async () =>
                  (await readFakeYtLog(pair.guestPage)).some(
                    (entry) =>
                      entry.op === 'seekTo' &&
                      Number(entry.args?.[0]) >= 15 &&
                      Number(entry.args?.[0]) < 20,
                  ),
                { timeout: 15_000 },
              )
              .toBe(true);
          }
          for (const page of [pair.hostPage, pair.guestPage]) {
            await expectPlayingYouTube(page, queueItemId);
            await expect
              .poll(async () => (await readFakeYtSnapshot(page))!.currentTime, { timeout: 20_000 })
              .toBeLessThan(duration / 2);
          }
        }
        // Cross the outgoing rendezvous and guest end-fallback windows. Old
        // timers must not retire or jump the already settled successor.
        await pair.hostPage.waitForTimeout(5_500);
        if (successor === 'file') {
          for (const page of [pair.hostPage, pair.guestPage]) {
            expect(await readState(page, 'playback.mode')).toBe('file');
            expect(await readState(page, 'playback.activity')).toBe('playing');
            expect(await readState(page, 'playlist.currentQueueItemId')).toBe(fileQueueItemId);
            expect((await readFakeYtSnapshot(page))?.state).not.toBe(1);
          }
        } else {
          await expectPlayingYouTube(pair.hostPage, queueItemId);
          await expectPlayingYouTube(pair.guestPage, queueItemId);
          const host = (await readFakeYtSnapshot(pair.hostPage))!;
          const guest = (await readFakeYtSnapshot(pair.guestPage))!;
          expect(Math.abs(host.currentTime - guest.currentTime)).toBeLessThan(1);
          expect(guest.currentTime).toBeLessThan(duration / 2);
          if (successor === 'seek') expect(guest.currentTime).toBeGreaterThanOrEqual(15);
          expect(guest.currentTime).toBeLessThan((successor === 'seek' ? 15 : 0) + 30);
        }
      } catch (error) {
        await testInfo.attach('host-guest-console', {
          body: browserLog.join('\n'),
          contentType: 'text/plain',
        });
        throw error;
      } finally {
        await cleanupContexts(pair);
      }
    });
  }
}
