import { expect, test, type Page } from '@playwright/test';
import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';
import { createHostGuestContexts, cleanupContexts } from './helpers/context-factory.ts';
import { connectHostAndGuest, setupGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import { readQueueSnapshot, waitForCurrentQueueIndex } from './helpers/queue-state.ts';
import {
  clickPlayButton,
  waitForPlaybackProjection,
  waitForPlaylistCount,
} from './helpers/wait.ts';

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

for (const nativeParticipant of [null, 'host', 'guest'] as const) {
  test(`hybrid MP3 paused late join, seek and resume with ${nativeParticipant ? `native ${nativeParticipant}` : 'bounded host and guest'}`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const pair = await createHostGuestContexts(browser);
    try {
      await observeEngine(pair.hostPage, nativeParticipant === 'host' ? 8 : 2);
      await observeEngine(pair.guestPage, nativeParticipant === 'guest' ? 8 : 2);
      const code = await setupHostAndStart(pair.hostPage);
      await pair.hostPage.locator('#file-input').setInputFiles([
        { name: 'small.mp3', mimeType: 'audio/mpeg', buffer: mp3(30) },
        { name: 'large.mp3', mimeType: 'audio/mpeg', buffer: mp3(600) },
      ]);
      await waitForPlaylistCount(pair.hostPage, 2);
      await selectTrack(pair.hostPage, 1);
      await waitForCurrentQueueIndex(pair.hostPage, 1);
      await expect
        .poll(async () => Number(await pair.hostPage.locator('#seek-slider').getAttribute('max')))
        .toBeGreaterThan(590);
      await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 40_000);
      await clickPlayButton(pair.hostPage);
      await waitForPlaybackProjection(pair.hostPage, 'PAUSED');

      // A paused seek must become the late joiner's prepared position without
      // starting its output, including when the participants use different engines.
      const seek = async (position: number): Promise<void> => {
        await pair.hostPage.locator('#seek-slider').evaluate((element, seconds) => {
          const slider = element as HTMLInputElement;
          slider.value = String(seconds);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        }, position);
      };
      await seek(240);
      await expect
        .poll(async () => Number(await pair.hostPage.locator('#seek-slider').inputValue()))
        .toBeCloseTo(240, 0);
      await setupGuest(pair.guestPage, code);
      await waitForPlaylistCount(pair.guestPage, 2);
      await waitForCurrentQueueIndex(pair.guestPage, 1);
      await waitForPlaybackProjection(pair.guestPage, 'PAUSED', 40_000);
      await expect
        .poll(async () => Number(await pair.guestPage.locator('#seek-slider').inputValue()))
        .toBeCloseTo(240, 0);
      expect((await readProbe(pair.guestPage)).chunkStarts).toBe(0);
      expect((await readProbe(pair.guestPage)).wholeStarts).toBe(0);

      // Supersede the paused target several times before resuming. Only the
      // final target may win; the old near-end position must not finish the track.
      for (const position of [599, 90, 450, 60]) await seek(position);
      await clickPlayButton(pair.hostPage);
      await Promise.all(
        [pair.hostPage, pair.guestPage].map((page) =>
          waitForPlaybackProjection(page, 'PLAYING_AUDIO', 40_000),
        ),
      );
      await expect
        .poll(async () => {
          const positions = await Promise.all(
            [pair.hostPage, pair.guestPage].map(async (page) =>
              Number(await page.locator('#seek-slider').inputValue()),
            ),
          );
          return (
            positions.every((position) => position >= 59.9 && position < 90) &&
            Math.abs(positions[0]! - positions[1]!) < 1
          );
        })
        .toBe(true);
      for (const [name, page] of [
        ['host', pair.hostPage],
        ['guest', pair.guestPage],
      ] as const) {
        if (name !== nativeParticipant) {
          await expect.poll(async () => (await readProbe(page)).chunkStarts).toBeGreaterThan(10);
        }
      }

      const beforeSmall = await Promise.all([readProbe(pair.hostPage), readProbe(pair.guestPage)]);
      await selectTrack(pair.hostPage, 0);
      await Promise.all(
        [pair.hostPage, pair.guestPage].map(async (page, index) => {
          await waitForCurrentQueueIndex(page, 0);
          await waitForPlaybackProjection(page, 'PLAYING_AUDIO', 30_000);
          await expect
            .poll(async () => (await readProbe(page)).wholeStarts)
            .toBeGreaterThan(beforeSmall[index]!.wholeStarts);
        }),
      );
    } finally {
      for (const [name, page] of [
        ['host', pair.hostPage],
        ['guest', pair.guestPage],
      ] as const) {
        const snapshot = await page
          .evaluate(() => {
            const get = Reflect.get(window, '__MUSIXQUARE_GET_STATE__') as
              ((path: string) => unknown) | undefined;
            if (!get) return { unavailable: true };
            const slider = document.getElementById('seek-slider') as HTMLInputElement | null;
            return {
              activity: get('playback.activity'),
              pausedAt: get('player.pausedAt'),
              current: get('playlist.currentQueueItemId'),
              resident: get('files.current'),
              slider: slider && { value: slider.value, max: slider.max },
              probe: Reflect.get(window, '__HYBRID_AUDIO_PROBE__'),
            };
          })
          .catch((error: unknown) => ({ diagnosticError: String(error) }));
        await test.info().attach(`${name}-hybrid-lifecycle`, {
          body: JSON.stringify(snapshot),
          contentType: 'application/json',
        });
      }
      await cleanupContexts(pair);
    }
  });
}

// Independently decodable AAC-LC silence: ffmpeg's native AAC encoder,
// 48 kHz stereo. Keep both the ADTS header and its raw payload so the same
// frames exercise elementary-stream and indexed M4A container admission.
const AAC_FRAME = Buffer.from('//FMgAG//CEQBGCMHA==', 'base64');
type TestContainer = 'mp3' | 'm4a' | 'aac';

async function audioFile(container: TestContainer, seconds: number): Promise<Buffer> {
  if (container === 'mp3') return mp3(seconds);
  const frames = Math.ceil((seconds * 48_000) / 1024);
  if (container === 'aac') {
    return Buffer.concat(Array.from({ length: frames }, () => AAC_FRAME));
  }
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new EncodedAudioPacketSource('aac');
  output.addAudioTrack(source);
  await output.start();
  for (let frame = 0; frame < frames; frame++) {
    await source.add(
      new EncodedPacket(AAC_FRAME.subarray(7), 'key', (frame * 1024) / 48_000, 1024 / 48_000),
      frame === 0
        ? {
            decoderConfig: {
              codec: 'mp4a.40.2',
              sampleRate: 48_000,
              numberOfChannels: 2,
              description: Uint8Array.of(0x11, 0x90),
            },
          }
        : undefined,
    );
  }
  await output.finalize();
  if (!target.buffer) throw new Error('AAC fixture muxing did not produce a file');
  return Buffer.from(target.buffer);
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

for (const container of ['mp3', 'm4a', 'aac'] as const) {
  for (const nativeParticipant of [null, 'host', 'guest'] as const) {
    test(`hybrid ${container}: small → large → small with ${nativeParticipant ? `native ${nativeParticipant}` : 'bounded host and guest'}`, async ({
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
        // The admission probe conservatively reserves eight channels for ADTS
        // (whose later frames can change layout), and two for the other fixtures.
        // Both produce ~275 MiB estimates: each constrained participant selects
        // bounded PCM, while an 8 GiB participant stays native. Exercise both
        // directions because a bounded host must publish the same timeline too.
        const duration = container === 'aac' ? 150 : 600;
        const mimeType =
          container === 'mp3' ? 'audio/mpeg' : container === 'm4a' ? 'audio/mp4' : 'audio/aac';
        const small = await audioFile(container, 30);
        const large = await audioFile(container, duration);
        await observeEngine(pair.hostPage, nativeParticipant === 'host' ? 8 : 2);
        await observeEngine(pair.guestPage, nativeParticipant === 'guest' ? 8 : 2);
        await connectHostAndGuest(pair.hostPage, pair.guestPage);
        await pair.hostPage.locator('#file-input').setInputFiles([
          { name: `small-before.${container}`, mimeType, buffer: small },
          { name: `large.${container}`, mimeType, buffer: large },
          { name: `small-after.${container}`, mimeType, buffer: small },
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
        for (const [name, page, before] of [
          ['host', pair.hostPage, hostBefore],
          ['guest', pair.guestPage, guestBefore],
        ] as const) {
          if (nativeParticipant === name) {
            await expect
              .poll(async () => (await readProbe(page)).nativeDecodes)
              .toBe(before.nativeDecodes + 1);
          } else {
            await expect
              .poll(async () => (await readProbe(page)).chunkStarts)
              .toBeGreaterThan(before.chunkStarts + 10);
            expect((await readProbe(page)).nativeDecodes).toBe(before.nativeDecodes);
          }
        }
        const guestLarge = await readProbe(pair.guestPage);
        const hostLarge = await readProbe(pair.hostPage);

        // Drive the real seekbar event path while a decoder may still be warming.
        // The last edit must win on every engine combination.
        const seekStartedAt = Date.now();
        await pair.hostPage.locator('#seek-slider').evaluate((element, seconds) => {
          const slider = element as HTMLInputElement;
          for (const position of [seconds - 2, seconds * 0.2, seconds * 0.75]) {
            slider.value = String(position);
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            slider.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, duration);
        await Promise.all(
          [pair.hostPage, pair.guestPage].map((page) =>
            waitForPlaybackProjection(page, 'PLAYING_AUDIO'),
          ),
        );
        await expect
          .poll(
            async () => {
              // Read concurrently so protocol/UI convergence is measured at
              // approximately the same instant. This checks the room timeline,
              // not acoustic latency or sample-accurate device synchronization.
              const positions = await Promise.all(
                [pair.hostPage, pair.guestPage].map(async (page) =>
                  Number(await page.locator('#seek-slider').inputValue()),
                ),
              );
              const elapsed = (Date.now() - seekStartedAt) / 1000;
              const target = duration * 0.75;
              return (
                positions.every(
                  (position) => position >= target - 0.1 && position <= target + elapsed + 1,
                ) && Math.abs(positions[0]! - positions[1]!) < 1
              );
            },
            { timeout: 30_000 },
          )
          .toBe(true);

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
        expect((await readProbe(pair.guestPage)).wholeStarts).toBeGreaterThan(
          guestLarge.wholeStarts,
        );
      } catch (error) {
        await test
          .info()
          .attach('browser-log', { body: logs.join('\n'), contentType: 'text/plain' });
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
}
