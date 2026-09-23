import { expect, test, type Page } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { readQueueSnapshot, waitForCurrentQueueIndex } from './helpers/queue-state.ts';
import { waitForPlaybackProjection, waitForPlaylistCount } from './helpers/wait.ts';

// A real, independently decodable MPEG-1 Layer III silence frame (48 kHz,
// stereo, 32 kbps, reservoir disabled). Repeating it creates a valid long CBR
// file without a multi-megabyte checked-in fixture or an ffmpeg dependency.
const SILENCE_FRAME = Buffer.from(
  '//sUZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'base64',
);

function mp3(seconds: number): Buffer {
  const frames = Math.ceil((seconds * 48_000) / 1152);
  const bytes = Buffer.alloc(frames * SILENCE_FRAME.length);
  for (let i = 0; i < frames; i++) SILENCE_FRAME.copy(bytes, i * SILENCE_FRAME.length);
  return bytes;
}

interface AudioProbe {
  nativeDecodes: number;
  wholeStarts: number;
  chunkStarts: number;
}

async function observeEngine(page: Page, memoryGiB: number): Promise<void> {
  await page.addInitScript((memory) => {
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: memory });
    // Exercise the codec fallback required on browsers without AudioDecoder.
    Object.defineProperty(window, 'AudioDecoder', { configurable: true, value: undefined });
    const probe = { nativeDecodes: 0, wholeStarts: 0, chunkStarts: 0 };
    Object.assign(window, { __HYBRID_AUDIO_PROBE__: probe });
    const decode = BaseAudioContext.prototype.decodeAudioData;
    BaseAudioContext.prototype.decodeAudioData = function (...args) {
      probe.nativeDecodes++;
      return decode.apply(this, args);
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer && this.buffer.duration >= 1) probe.wholeStarts++;
      else if (this.buffer && this.buffer.duration > 0) probe.chunkStarts++;
      return start.apply(this, args);
    };
  }, memoryGiB);
}

async function readProbe(page: Page): Promise<AudioProbe> {
  return page.evaluate(() => Reflect.get(window, '__HYBRID_AUDIO_PROBE__') as AudioProbe);
}

async function selectTrack(page: Page, index: number): Promise<void> {
  const queue = await readQueueSnapshot(page);
  await page.evaluate((id) => {
    const bus = Reflect.get(window, '__MUSIXQUARE_BUS__') as {
      emit(event: string, ...args: unknown[]): void;
    };
    bus.emit('playlist:play-track', id, undefined, { explicitPlaybackIntent: true });
  }, queue.items[index].queueItemId);
}

for (const mixed of [false, true]) {
  test(`hybrid MP3: small → large → small with ${mixed ? 'mixed' : 'bounded'} host/guest engines`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const pair = await createHostGuestContexts(browser);
    const logs: string[] = [];
    for (const [name, page] of [
      ['host', pair.hostPage],
      ['guest', pair.guestPage],
    ] as const) {
      page.on('console', (message) => logs.push(`${name}: ${message.text()}`));
    }
    try {
      // 600 s stereo expands to ~275 MiB including estimator headroom: the
      // constrained guest selects bounded PCM, while an 8 GiB host stays native.
      await observeEngine(pair.hostPage, mixed ? 8 : 2);
      await observeEngine(pair.guestPage, 2);
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      await pair.hostPage.locator('#file-input').setInputFiles([
        { name: 'small-before.mp3', mimeType: 'audio/mpeg', buffer: mp3(30) },
        { name: 'large-ten-minutes.mp3', mimeType: 'audio/mpeg', buffer: mp3(600) },
        { name: 'small-after.mp3', mimeType: 'audio/mpeg', buffer: mp3(30) },
      ]);
      await waitForPlaylistCount(pair.hostPage, 3);
      await waitForPlaylistCount(pair.guestPage, 3);
      await selectTrack(pair.hostPage, 0);
      await Promise.all(
        [pair.hostPage, pair.guestPage].map((page) =>
          waitForPlaybackProjection(page, 'PLAYING_AUDIO', 30_000),
        ),
      );
      const hostBefore = await readProbe(pair.hostPage);
      const guestBefore = await readProbe(pair.guestPage);
      expect(hostBefore.wholeStarts).toBeGreaterThan(0);
      expect(guestBefore.wholeStarts).toBeGreaterThan(0);

      await selectTrack(pair.hostPage, 1);
      await Promise.all(
        [pair.hostPage, pair.guestPage].map(async (page) => {
          await waitForCurrentQueueIndex(page, 1);
          await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 40_000);
        }),
      );
      await expect
        .poll(async () => (await readProbe(pair.guestPage)).chunkStarts)
        .toBeGreaterThan(10);
      const guestLarge = await readProbe(pair.guestPage);
      const hostLarge = await readProbe(pair.hostPage);
      expect(guestLarge.nativeDecodes).toBe(guestBefore.nativeDecodes);
      if (mixed) expect(hostLarge.nativeDecodes).toBe(hostBefore.nativeDecodes + 1);
      else {
        expect(hostLarge.nativeDecodes).toBe(hostBefore.nativeDecodes);
        expect(hostLarge.chunkStarts).toBeGreaterThan(0);
      }

      // Drive the real seekbar event path while a decoder may still be warming.
      // The last edit must win on both engine combinations.
      await pair.hostPage.locator('#seek-slider').evaluate((element) => {
        const slider = element as HTMLInputElement;
        for (const seconds of [590, 120, 450]) {
          slider.value = String(seconds);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      for (const page of [pair.hostPage, pair.guestPage]) {
        await expect
          .poll(
            async () => {
              const position = Number(await page.locator('#seek-slider').inputValue());
              return position >= 449.9 && position < 480;
            },
            {
              timeout: 30_000,
            },
          )
          .toBe(true);
        await waitForPlaybackProjection(page, 'PLAYING_AUDIO');
      }

      await selectTrack(pair.hostPage, 2);
      await Promise.all(
        [pair.hostPage, pair.guestPage].map(async (page) => {
          await waitForCurrentQueueIndex(page, 2);
          await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 30_000);
        }),
      );
      await expect
        .poll(async () => (await readProbe(pair.guestPage)).nativeDecodes)
        .toBe(guestLarge.nativeDecodes + 1);
      expect((await readProbe(pair.hostPage)).nativeDecodes).toBe(hostLarge.nativeDecodes + 1);
      expect((await readProbe(pair.guestPage)).wholeStarts).toBeGreaterThan(guestLarge.wholeStarts);
    } catch (error) {
      await test.info().attach('browser-log', { body: logs.join('\n'), contentType: 'text/plain' });
      for (const [name, page] of [
        ['host', pair.hostPage],
        ['guest', pair.guestPage],
      ] as const) {
        await test.info().attach(`${name}-state`, {
          body: JSON.stringify(
            await page.evaluate(() => {
              const get = Reflect.get(window, '__MUSIXQUARE_GET_STATE__') as (
                path: string,
              ) => unknown;
              return {
                playback: get('playback'),
                player: get('player'),
                probe: Reflect.get(window, '__HYBRID_AUDIO_PROBE__'),
              };
            }),
          ),
          contentType: 'application/json',
        });
      }
      throw error;
    } finally {
      await cleanupContexts(pair);
    }
  });
}
