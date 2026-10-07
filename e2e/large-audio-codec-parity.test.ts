import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import type { LargeAudioTrack } from '../src/player/file-playback-resource.ts';

const PREFIX = '/__large-audio-codec-probe/';
const assets = new Map<string, string | Buffer>();

// The two compressed fixtures encode this same synthetic, copyright-free
// chirp: aevalsrc=sin(2*PI*(220*t+40*t*t)):s=44100:d=5, stereo. MP3 uses
// libmp3lame -q:a 2; FLAC uses the default lossless encoder. No external
// encoder or network service is required to execute this regression test.
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
    if (!('output' in output)) throw new Error('Expected an in-memory codec build');
    for (const item of output.output) {
      assets.set(item.fileName, item.type === 'chunk' ? item.code : Buffer.from(item.source));
    }
  }
  for (const codec of ['mp3', 'flac']) {
    assets.set(
      `chirp.${codec}`,
      await readFile(resolve(`e2e/fixtures/large-audio-chirp.${codec}`)),
    );
  }
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

for (const outputSampleRate of [44_100, 48_000, 96_000]) {
  for (const scheduledStart of [0, 0.12345]) {
    test(`bounded audio matches native PCM at ${outputSampleRate} Hz from ${scheduledStart}s across start, seek and end`, async ({
      page,
      browserName,
    }) => {
      await openProbe(page);
      test.skip(
        !(await page.evaluate(() => typeof OfflineAudioContext !== 'undefined')),
        'This browser build has no OfflineAudioContext; rendered audio parity remains unverified.',
      );
      const rows = await page.evaluate(
        async ({ prefix, outputSampleRate, scheduledStart, codecs }) => {
          // Models the missing AudioDecoder API on older Safari while exercising
          // actual minified WASM workers and native Web Audio, not a decoder mock.
          Object.defineProperty(globalThis, 'AudioDecoder', {
            value: undefined,
            configurable: true,
          });
          const { openLargeAudioTrack } = (await import(`${prefix}bounded-audio.js`)) as {
            openLargeAudioTrack(blob: Blob): Promise<LargeAudioTrack>;
          };
          const makeWave = (): Blob => {
            const frames = 44_100 * 5;
            const bytes = new ArrayBuffer(44 + frames * 4);
            const view = new DataView(bytes);
            const word = (offset: number, text: string): void => {
              for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
            };
            word(0, 'RIFF');
            view.setUint32(4, bytes.byteLength - 8, true);
            word(8, 'WAVE');
            word(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, 2, true);
            view.setUint32(24, 44_100, true);
            view.setUint32(28, 44_100 * 4, true);
            view.setUint16(32, 4, true);
            view.setUint16(34, 16, true);
            word(36, 'data');
            view.setUint32(40, frames * 4, true);
            for (let frame = 0; frame < frames; frame++) {
              const time = frame / 44_100;
              const value = Math.round(
                Math.sin(2 * Math.PI * (220 * time + 40 * time * time)) * 30_000,
              );
              view.setInt16(44 + frame * 4, value, true);
              view.setInt16(46 + frame * 4, value, true);
            }
            return new Blob([bytes], { type: 'audio/wav' });
          };
          const results: Array<{
            codec: string;
            offset: number;
            rms: number;
            maxInteriorError: number;
            fractionalLag: number;
            alignedRms: number;
            maxAlignedError: number;
            sampleStepLimit: number;
            peakErrorFrame: number;
            peakActual: number[];
            peakExpected: number[];
            peakSources: Array<{
              when: number;
              at: number;
              seconds: number;
              sourceRate: number;
              length: number;
            }>;
            lag: number;
            nativeDuration: number;
            duration: number;
            errors: string[];
          }> = [];
          for (const codec of codecs) {
            const blob =
              codec === 'wav' ? makeWave() : await (await fetch(`${prefix}chirp.${codec}`)).blob();
            const nativeContext = new OfflineAudioContext(2, 1, outputSampleRate);
            const native = await nativeContext.decodeAudioData(await blob.arrayBuffer());
            const track = await openLargeAudioTrack(blob);
            try {
              // Include fractional source-frame positions alongside whole-track,
              // middle and tail playback.
              // These expose output resampling at fractional chunk starts.
              for (const offset of [0, 1 / 44_100, 1025 / 44_100, 2.125, 4.95]) {
                await track.prepare(offset);
                const frames = Math.ceil(
                  (scheduledStart + track.duration - offset) * outputSampleRate,
                );
                const firstComparedFrame = Math.ceil(scheduledStart * outputSampleRate) + 64;
                const context = new OfflineAudioContext(2, frames, outputSampleRate);
                let scheduledEnd = 0;
                const scheduledSources: Array<{
                  when: number;
                  at: number;
                  seconds: number;
                  sourceRate: number;
                  length: number;
                }> = [];
                const createSource = context.createBufferSource.bind(context);
                context.createBufferSource = () => {
                  const source = createSource();
                  const start = source.start.bind(source);
                  const stop = source.stop.bind(source);
                  let scheduled: (typeof scheduledSources)[number] | undefined;
                  source.start = (when = 0, at = 0, seconds?: number) => {
                    if (seconds !== undefined)
                      scheduledEnd = Math.max(scheduledEnd, when + seconds);
                    scheduled = {
                      when,
                      at,
                      seconds: seconds ?? 0,
                      sourceRate: source.buffer!.sampleRate,
                      length: source.buffer!.length,
                    };
                    scheduledSources.push(scheduled);
                    start(when, at, seconds);
                  };
                  source.stop = (when?: number) => {
                    if (when !== undefined) {
                      scheduledEnd = Math.max(scheduledEnd, when);
                      if (scheduled) scheduled.seconds = when - scheduled.when;
                    }
                    stop(when);
                  };
                  return source;
                };
                const errors: string[] = [];
                const playback = track.createPlayback({
                  context: context as unknown as AudioContext,
                  destination: context.destination,
                  when: scheduledStart,
                  offset,
                  onended() {},
                  onerror(error) {
                    errors.push(String(error));
                  },
                });
                try {
                  const deadline = performance.now() + 10_000;
                  while (
                    scheduledEnd <
                      scheduledStart + track.duration - offset - 1 / outputSampleRate &&
                    errors.length === 0
                  ) {
                    if (performance.now() > deadline)
                      throw new Error(`PCM scheduling stalled for ${codec}`);
                    await new Promise<void>((resolve) => setTimeout(resolve, 10));
                  }
                  const rendered = await context.startRendering();
                  const referenceContext = new OfflineAudioContext(2, frames, outputSampleRate);
                  const referenceSource = referenceContext.createBufferSource();
                  referenceSource.buffer = native;
                  referenceSource.connect(referenceContext.destination);
                  referenceSource.start(scheduledStart, offset);
                  const reference = await referenceContext.startRendering();
                  const actual = rendered.getChannelData(0);
                  const expected = reference.getChannelData(0);
                  let sum = 0;
                  let maxInteriorError = 0;
                  let peakErrorFrame = 0;
                  let maxReferenceStep = 0;
                  for (let i = 0; i < frames; i++) {
                    const difference = Math.abs(actual[i] - expected[i]);
                    sum += difference ** 2;
                    // Native resampling has different outer filter edges for an
                    // already-resampled AudioBuffer. Keep internal chunk boundaries
                    // in this diagnostic while excluding those two outer edges.
                    if (i >= firstComparedFrame && i < frames - 64) {
                      maxReferenceStep = Math.max(
                        maxReferenceStep,
                        Math.abs(expected[i] - expected[i - 1]),
                      );
                      if (difference > maxInteriorError) {
                        maxInteriorError = difference;
                        peakErrorFrame = i;
                      }
                    }
                  }
                  let lag = 0;
                  let best = Infinity;
                  for (let shift = -8; shift <= 8; shift++) {
                    let error = 0;
                    for (let i = firstComparedFrame; i < frames - 64; i += 7)
                      error += (actual[i] - expected[i + shift]) ** 2;
                    if (error < best) {
                      best = error;
                      lag = shift;
                    }
                  }
                  // A whole buffer is resampled before the native seek; bounded
                  // chunks are resampled after it. Measure the constant sub-frame
                  // phase separately without excluding any internal chunk joins.
                  let fractionalLag = 0;
                  let fractionalBest = Infinity;
                  for (let step = -32; step <= 32; step++) {
                    const shift = step / 32;
                    let error = 0;
                    for (let i = firstComparedFrame; i < frames - 64; i += 7) {
                      const position = i + shift;
                      const left = Math.floor(position);
                      const fraction = position - left;
                      const sample =
                        expected[left] * (1 - fraction) + expected[left + 1] * fraction;
                      error += (actual[i] - sample) ** 2;
                    }
                    if (error < fractionalBest) {
                      fractionalBest = error;
                      fractionalLag = shift;
                    }
                  }
                  let alignedSum = 0;
                  let maxAlignedError = 0;
                  for (let i = firstComparedFrame; i < frames - 64; i++) {
                    const position = i + fractionalLag;
                    const left = Math.floor(position);
                    const fraction = position - left;
                    const sample = expected[left] * (1 - fraction) + expected[left + 1] * fraction;
                    const difference = Math.abs(actual[i] - sample);
                    alignedSum += difference ** 2;
                    maxAlignedError = Math.max(maxAlignedError, difference);
                  }
                  results.push({
                    codec,
                    offset,
                    rms: Math.sqrt(sum / frames),
                    maxInteriorError,
                    fractionalLag,
                    alignedRms: Math.sqrt(alignedSum / (frames - firstComparedFrame - 64)),
                    maxAlignedError,
                    // At most one source-frame and one output-frame of local
                    // phase quantization, plus the existing decoder RMS budget.
                    // Derive the amplitude bound from this chirp's actual slope:
                    // a zero/doubled boundary sample cannot hide in a long RMS.
                    sampleStepLimit:
                      maxReferenceStep * (outputSampleRate / track.sampleRate + 1) + 0.003,
                    peakErrorFrame,
                    peakActual: Array.from(actual.slice(peakErrorFrame - 3, peakErrorFrame + 4)),
                    peakExpected: Array.from(
                      expected.slice(peakErrorFrame - 3, peakErrorFrame + 4),
                    ),
                    peakSources: scheduledSources.filter(
                      (entry) =>
                        Math.abs(entry.when * outputSampleRate - peakErrorFrame) < 5 ||
                        Math.abs((entry.when + entry.seconds) * outputSampleRate - peakErrorFrame) <
                          5,
                    ),
                    lag,
                    nativeDuration: native.duration,
                    duration: track.duration,
                    errors,
                  });
                } finally {
                  playback.stop();
                }
              }
            } finally {
              track.dispose();
            }
          }
          return results;
        },
        {
          prefix: PREFIX,
          outputSampleRate,
          scheduledStart,
          codecs: browserName === 'webkit' ? ['wav'] : ['wav', 'mp3', 'flac'],
        },
      );
      await test.info().attach('codec-pcm-comparison', {
        body: JSON.stringify({ outputSampleRate, scheduledStart, rows }, null, 2),
        contentType: 'application/json',
      });
      expect(rows).toHaveLength(browserName === 'webkit' ? 5 : 15);
      for (const row of rows) {
        expect(row.errors, `${row.codec} at ${row.offset}`).toEqual([]);
        expect(Math.abs(row.duration - row.nativeDuration)).toBeLessThan(1 / outputSampleRate);
        expect(Math.abs(row.lag), `${row.codec} at ${row.offset}`).toBeLessThanOrEqual(1);
        if (
          outputSampleRate === 48_000 &&
          scheduledStart === 0 &&
          [0, 2.125, 4.95].includes(row.offset)
        ) {
          expect(row.rms, `${row.codec} at ${row.offset}`).toBeLessThan(0.003);
        }
        expect(row.alignedRms, `${row.codec} at ${row.offset}`).toBeLessThan(0.003);
        expect(row.maxAlignedError, `${row.codec} at ${row.offset}`).toBeLessThan(
          row.sampleStepLimit,
        );
      }
    });
  }
}

test('rapid seeks and a ten-minute clock jump keep a long track bounded without full decode', async ({
  page,
}) => {
  await openProbe(page);
  test.skip(
    !(await page.evaluate(
      () => typeof BaseAudioContext !== 'undefined' && typeof AudioBuffer !== 'undefined',
    )),
    'This browser build has no Web Audio buffer runtime; bounded clock recovery remains unverified.',
  );
  const observed = await page.evaluate(async (prefix) => {
    const { openLargeAudioTrack } = (await import(`${prefix}bounded-audio.js`)) as {
      openLargeAudioTrack(blob: Blob): Promise<LargeAudioTrack>;
    };
    let fullDecodeCalls = 0;
    BaseAudioContext.prototype.decodeAudioData = async () => {
      fullDecodeCalls++;
      throw new Error('A bounded track must never invoke whole-file decodeAudioData');
    };
    const duration = 900;
    const sampleRate = 48_000;
    const bytes = new ArrayBuffer(44 + duration * sampleRate * 2);
    const view = new DataView(bytes);
    const word = (offset: number, text: string): void => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    word(0, 'RIFF');
    view.setUint32(4, bytes.byteLength - 8, true);
    word(8, 'WAVE');
    word(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    word(36, 'data');
    view.setUint32(40, bytes.byteLength - 44, true);
    const track = await openLargeAudioTrack(new Blob([bytes], { type: 'audio/wav' }));
    const errors: string[] = [];
    const seeks = await Promise.allSettled([
      track.prepare(100),
      track.prepare(400),
      track.prepare(899.7),
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
      const deadline = performance.now() + 10_000;
      while (!condition()) {
        if (errors.length || performance.now() > deadline)
          throw new Error(`Bounded clock jump stalled: ${errors}`);
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
  expect(observed.statuses).toEqual(['rejected', 'rejected', 'fulfilled']);
  expect(observed.reasons).toEqual(['AbortError', 'AbortError', '']);
  expect(observed.fullDecodeCalls).toBe(0);
  expect(observed.errors).toEqual([]);
  expect(observed.firstResumedStart).toBeCloseTo(600, 5);
  expect(observed.initialBytes).toBeGreaterThan(0);
  expect(observed.initialBytes).toBeLessThan(4 * 1024 * 1024);
  expect(observed.resumedBytes).toBeLessThan(4 * 1024 * 1024);
  expect(observed.disposedBytes).toBe(0);
});
