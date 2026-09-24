import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import type { LargeAudioTrack } from '../src/player/file-playback-resource.ts';

const PREFIX = '/__large-audio-aac-probe/';
const assets = new Map<string, string | Buffer>();
const fixtures = ['lc-stereo', 'lc-mono', 'he-stereo', 'hev2-stereo']
  .flatMap((profile) => ['m4a', 'aac'].map((container) => `${profile}.${container}`))
  .concat([
    'lc-itunes.m4a',
    'he-itunes.m4a',
    'lc-surround.m4a',
    'lc-leading-edit.m4a',
    'he-explicit.m4a',
    'hev2-explicit.m4a',
  ]);

// All fixtures contain our synthetic two-channel chirp, not recorded music.
// Their exact encoder commands and verified profiles are in fixtures/large-audio-aac.md.
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'error',
    build: {
      target: 'chrome79',
      write: false,
      minify: true,
      lib: {
        entry: resolve('src/player/large-audio/index.ts'),
        formats: ['es'],
        fileName: () => 'bounded-audio.js',
      },
    },
  });
  for (const output of Array.isArray(result) ? result : [result]) {
    if (!('output' in output)) throw new Error('Expected an in-memory AAC build');
    for (const item of output.output) {
      assets.set(item.fileName, item.type === 'chunk' ? item.code : Buffer.from(item.source));
    }
  }
  for (const name of fixtures)
    assets.set(name, await readFile(resolve(`e2e/fixtures/large-audio-chirp-${name}`)));
});

async function openProbe(page: Page): Promise<void> {
  await page.route(`**${PREFIX}**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice(PREFIX.length);
    if (name === 'index.html') {
      await route.fulfill({
        contentType: 'text/html',
        headers: {
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob:; media-src 'self' blob:",
        },
        body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
      });
      return;
    }
    const asset = assets.get(name);
    await route.fulfill({
      status: asset === undefined ? 404 : 200,
      contentType: name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream',
      body: asset ?? '',
    });
  });
  await page.goto(`${PREFIX}index.html`);
}

for (const fixture of fixtures.filter((name) => name !== 'lc-leading-edit.m4a')) {
  test(`bounded AAC ${fixture} keeps native timing across start, seek and tail`, async ({
    page,
  }) => {
    await openProbe(page);
    const rows = await page.evaluate(
      async ({ prefix, fixture }) => {
        Object.defineProperty(globalThis, 'AudioDecoder', { value: undefined, configurable: true });
        const { openLargeAudioTrack } = (await import(`${prefix}bounded-audio.js`)) as {
          openLargeAudioTrack(blob: Blob): Promise<LargeAudioTrack>;
        };
        const blob = await (await fetch(`${prefix}${fixture}`)).blob();
        const nativeContext = new OfflineAudioContext(2, 1, 48_000);
        const native = await nativeContext.decodeAudioData(await blob.arrayBuffer());
        const track = await openLargeAudioTrack(blob);
        const results: Array<{
          offset: number;
          rms: number;
          seekRms: number;
          correlation: number;
          monoDifference: number;
          lag: number;
          channel: number;
          nativeDuration: number;
          duration: number;
          sampleRate: number;
          channels: number;
          nativeChannels: number;
          errors: string[];
        }> = [];
        try {
          let continuousReference: AudioBuffer | null = null;
          for (const offset of [
            0,
            0.03125,
            2.125,
            Math.min(native.duration, track.duration) - 0.05,
          ]) {
            await track.prepare(offset);
            const frames = Math.ceil((track.duration - offset) * 48_000);
            const context = new OfflineAudioContext(track.numberOfChannels, frames, 48_000);
            let scheduledEnd = 0;
            const createSource = context.createBufferSource.bind(context);
            context.createBufferSource = () => {
              const source = createSource();
              const start = source.start.bind(source);
              const stop = source.stop.bind(source);
              source.start = (when = 0, at = 0, seconds?: number) => {
                scheduledEnd = Math.max(scheduledEnd, when + (seconds ?? 0));
                start(when, at, seconds);
              };
              source.stop = (when?: number) => {
                if (when !== undefined) scheduledEnd = Math.max(scheduledEnd, when);
                stop(when);
              };
              return source;
            };
            const errors: string[] = [];
            const playback = track.createPlayback({
              context: context as unknown as AudioContext,
              destination: context.destination,
              when: 0,
              offset,
              onended() {},
              onerror(error) {
                errors.push(String(error));
              },
            });
            try {
              const deadline = performance.now() + 10_000;
              while (scheduledEnd < track.duration - offset - 1 / 48_000 && !errors.length) {
                if (performance.now() > deadline)
                  throw new Error(
                    `AAC scheduling stalled for ${fixture} at ${offset}: end=${scheduledEnd}, duration=${track.duration}`,
                  );
                await new Promise<void>((resolve) => setTimeout(resolve, 10));
              }
              const actualBuffer = await context.startRendering();
              continuousReference ??= actualBuffer;
              const referenceContext = new OfflineAudioContext(
                track.numberOfChannels,
                frames,
                48_000,
              );
              const source = referenceContext.createBufferSource();
              source.buffer = native;
              source.connect(referenceContext.destination);
              source.start(0, offset);
              const reference = await referenceContext.startRendering();
              // Parametric stereo decorrelation differs between FAAD2 and
              // Chromium's native decoder. Independently compare each seek
              // with continuous FAAD2 playback so that a permissive cross-
              // decoder waveform tolerance cannot hide seek-state defects.
              const seekContext = new OfflineAudioContext(track.numberOfChannels, frames, 48_000);
              const seekSource = seekContext.createBufferSource();
              seekSource.buffer = continuousReference;
              seekSource.connect(seekContext.destination);
              seekSource.start(0, offset);
              const seekReference = await seekContext.startRendering();
              let monoDifference = 0;
              if (native.numberOfChannels === 1 && actualBuffer.numberOfChannels === 2) {
                const left = actualBuffer.getChannelData(0);
                const right = actualBuffer.getChannelData(1);
                for (let i = 0; i < frames; i++)
                  monoDifference = Math.max(monoDifference, Math.abs(left[i] - right[i]));
              }
              for (let channel = 0; channel < track.numberOfChannels; channel++) {
                const actual = actualBuffer.getChannelData(channel);
                const expected = reference.getChannelData(channel);
                const expectedSeek = seekReference.getChannelData(channel);
                let sum = 0;
                let seekSum = 0;
                let dot = 0;
                let actualEnergy = 0;
                let expectedEnergy = 0;
                for (let i = 0; i < frames; i++) {
                  sum += (actual[i] - expected[i]) ** 2;
                  // Native AudioBufferSource resampling can have a different
                  // filter edge when starting inside an already-rendered
                  // buffer. Compare the interior waveform independently of
                  // those first/last 64 output samples (about 1.3 ms).
                  if (i >= 64 && i < frames - 64) seekSum += (actual[i] - expectedSeek[i]) ** 2;
                  dot += actual[i] * expected[i];
                  actualEnergy += actual[i] ** 2;
                  expectedEnergy += expected[i] ** 2;
                }
                let lag = 0;
                let best = Infinity;
                for (let shift = -32; shift <= 32; shift++) {
                  let error = 0;
                  for (let i = 64; i < frames - 64; i += 7)
                    error += (actual[i] - expected[i + shift]) ** 2;
                  if (error < best) {
                    best = error;
                    lag = shift;
                  }
                }
                results.push({
                  offset,
                  rms: Math.sqrt(sum / frames),
                  seekRms: Math.sqrt(seekSum / (frames - 128)),
                  correlation: dot / Math.sqrt(actualEnergy * expectedEnergy),
                  monoDifference,
                  lag,
                  channel,
                  nativeDuration: native.duration,
                  duration: track.duration,
                  sampleRate: track.sampleRate,
                  channels: track.numberOfChannels,
                  nativeChannels: native.numberOfChannels,
                  errors,
                });
              }
            } finally {
              playback.stop();
            }
          }
        } finally {
          track.dispose();
        }
        return results;
      },
      { prefix: PREFIX, fixture },
    );
    await test.info().attach('aac-pcm-comparison', {
      body: JSON.stringify({ fixture, rows }, null, 2),
      contentType: 'application/json',
    });
    expect(rows).toHaveLength(fixture.includes('surround') ? 24 : 8);
    for (const row of rows) {
      expect(row.nativeChannels).toBe(
        fixture.includes('mono') ? 1 : fixture.includes('surround') ? 6 : 2,
      );
      expect(row.channels).toBe(fixture.includes('surround') ? 6 : 2);
      expect(row.monoDifference).toBeLessThan(1e-7);
      expect(row.errors, `${fixture} at ${row.offset}`).toEqual([]);
      expect(Math.abs(row.duration - row.nativeDuration), fixture).toBeLessThan(1 / 48_000);
      expect(
        Math.abs(row.lag),
        `${fixture} at ${row.offset}, channel ${row.channel}`,
      ).toBeLessThanOrEqual(1);
      expect(row.rms, `${fixture} at ${row.offset}, channel ${row.channel}`).toBeLessThan(
        fixture.includes('hev2') ? 0.1 : 0.003,
      );
      expect(
        row.correlation,
        `${fixture} at ${row.offset}, channel ${row.channel}`,
      ).toBeGreaterThan(fixture.includes('hev2') ? 0.9 : 0.999);
      expect(row.seekRms, `${fixture} seek at ${row.offset}, channel ${row.channel}`).toBeLessThan(
        0.003,
      );
    }
  });
}

test('large AAC rejects unverified leading empty edits without a whole-file fallback', async ({
  page,
}) => {
  await openProbe(page);
  const result = await page.evaluate(async (prefix) => {
    Object.defineProperty(globalThis, 'AudioDecoder', { value: undefined, configurable: true });
    const { openLargeAudioTrack } = (await import(`${prefix}bounded-audio.js`)) as {
      openLargeAudioTrack(blob: Blob): Promise<LargeAudioTrack>;
    };
    const blob = await (await fetch(`${prefix}lc-leading-edit.m4a`)).blob();
    const native = await new OfflineAudioContext(2, 1, 48_000).decodeAudioData(
      await blob.arrayBuffer(),
    );
    let fullDecodeCalls = 0;
    BaseAudioContext.prototype.decodeAudioData = async () => {
      fullDecodeCalls++;
      throw new Error('Large unsupported AAC must not silently decode the whole file');
    };
    try {
      const track = await openLargeAudioTrack(blob);
      track.dispose();
      return { nativeDuration: native.duration, rejected: false, fullDecodeCalls };
    } catch (error) {
      return {
        nativeDuration: native.duration,
        rejected: true,
        error: String(error),
        fullDecodeCalls,
      };
    }
  }, PREFIX);
  expect(result.nativeDuration).toBeGreaterThan(5);
  expect(result.rejected).toBe(true);
  expect(result.error).toMatch(/edit/i);
  expect(result.fullDecodeCalls).toBe(0);
});

test('long ADTS stays bounded through rapid seeks and a ten-minute suspension', async ({
  page,
}) => {
  await openProbe(page);
  const observed = await page.evaluate(async (prefix) => {
    Object.defineProperty(globalThis, 'AudioDecoder', { value: undefined, configurable: true });
    const { openLargeAudioTrack } = (await import(`${prefix}bounded-audio.js`)) as {
      openLargeAudioTrack(blob: Blob): Promise<LargeAudioTrack>;
    };
    let fullDecodeCalls = 0;
    BaseAudioContext.prototype.decodeAudioData = async () => {
      fullDecodeCalls++;
      throw new Error('A bounded AAC track must never decode the entire file');
    };
    const encoded = await (await fetch(`${prefix}lc-mono.aac`)).blob();
    // ADTS contains independently framed packets, so concatenating this own
    // synthetic recording gives a genuinely long encoded stream without
    // committing a large fixture or requiring an encoder on CI.
    const track = await openLargeAudioTrack(new Blob(Array.from({ length: 180 }, () => encoded)));
    const errors: string[] = [];
    const seeks = await Promise.allSettled([
      track.prepare(100),
      track.prepare(400),
      track.prepare(track.duration - 0.3),
    ]);
    await track.prepare(0);
    const scheduled: number[] = [];
    const context = {
      currentTime: 0,
      createBufferSource: () => ({
        buffer: null,
        onended: null,
        connect() {},
        disconnect() {},
        stop() {},
        start(when: number) {
          scheduled.push(when);
        },
      }),
    };
    const playback = track.createPlayback({
      context: context as unknown as AudioContext,
      destination: {} as AudioNode,
      when: 0,
      offset: 0,
      onended() {},
      onerror(error) {
        errors.push(String(error));
      },
    });
    const waitFor = async (condition: () => boolean): Promise<void> => {
      const deadline = performance.now() + 15_000;
      while (!condition()) {
        if (errors.length || performance.now() > deadline)
          throw new Error(`Bounded AAC clock jump stalled: ${errors}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      await waitFor(() => scheduled.some((value) => value >= 7.9));
      const initialBytes = track.bufferedPcmBytes;
      const previousCount = scheduled.length;
      context.currentTime = 600;
      await waitFor(() => scheduled.slice(previousCount).some((value) => value >= 607.9));
      const resumedBytes = track.bufferedPcmBytes;
      playback.stop();
      track.dispose();
      return {
        duration: track.duration,
        statuses: seeks.map((result) => result.status),
        reasons: seeks.map((result) =>
          result.status === 'rejected' ? String(result.reason.name) : '',
        ),
        initialBytes,
        resumedBytes,
        disposedBytes: track.bufferedPcmBytes,
        firstResumedStart: scheduled[previousCount],
        fullDecodeCalls,
        errors,
      };
    } finally {
      playback.stop();
      track.dispose();
    }
  }, PREFIX);
  expect(observed.duration).toBeGreaterThan(900);
  expect(observed.statuses).toEqual(['rejected', 'rejected', 'fulfilled']);
  expect(observed.reasons).toEqual(['AbortError', 'AbortError', '']);
  expect(observed.fullDecodeCalls).toBe(0);
  expect(observed.errors).toEqual([]);
  expect(observed.firstResumedStart).toBeCloseTo(600, 5);
  expect(observed.initialBytes).toBeGreaterThan(0);
  expect(observed.initialBytes).toBeLessThan(8 * 1024 * 1024);
  expect(observed.resumedBytes).toBeLessThan(8 * 1024 * 1024);
  expect(observed.disposedBytes).toBe(0);
});
