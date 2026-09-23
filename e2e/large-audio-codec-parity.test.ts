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

test('bounded MP3/FLAC/WAV matches native PCM at start, seek and end without WebCodecs audio', async ({
  page,
}) => {
  await openProbe(page);
  const rows = await page.evaluate(async (prefix) => {
    // Models the missing AudioDecoder API on older Safari while exercising
    // actual minified WASM workers and native Web Audio, not a decoder mock.
    Object.defineProperty(globalThis, 'AudioDecoder', { value: undefined, configurable: true });
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
        const value = Math.round(Math.sin(2 * Math.PI * (220 * time + 40 * time * time)) * 30_000);
        view.setInt16(44 + frame * 4, value, true);
        view.setInt16(46 + frame * 4, value, true);
      }
      return new Blob([bytes], { type: 'audio/wav' });
    };
    const results: Array<{
      codec: string;
      offset: number;
      rms: number;
      lag: number;
      nativeDuration: number;
      duration: number;
      errors: string[];
    }> = [];
    for (const codec of ['wav', 'mp3', 'flac']) {
      const blob =
        codec === 'wav' ? makeWave() : await (await fetch(`${prefix}chirp.${codec}`)).blob();
      const nativeContext = new OfflineAudioContext(2, 1, 48_000);
      const native = await nativeContext.decodeAudioData(await blob.arrayBuffer());
      const track = await openLargeAudioTrack(blob);
      try {
        for (const offset of [0, 2.125, 4.95]) {
          await track.prepare(offset);
          const frames = Math.ceil((track.duration - offset) * 48_000);
          const context = new OfflineAudioContext(2, frames, 48_000);
          let scheduledEnd = 0;
          const createSource = context.createBufferSource.bind(context);
          context.createBufferSource = () => {
            const source = createSource();
            const start = source.start.bind(source);
            source.start = (when = 0, at = 0, seconds?: number) => {
              scheduledEnd = Math.max(scheduledEnd, when + (seconds ?? 0));
              start(when, at, seconds);
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
            while (scheduledEnd < track.duration - offset - 1 / 48_000 && errors.length === 0) {
              if (performance.now() > deadline)
                throw new Error(`PCM scheduling stalled for ${codec}`);
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
            }
            const rendered = await context.startRendering();
            const referenceContext = new OfflineAudioContext(2, frames, 48_000);
            const referenceSource = referenceContext.createBufferSource();
            referenceSource.buffer = native;
            referenceSource.connect(referenceContext.destination);
            referenceSource.start(0, offset);
            const reference = await referenceContext.startRendering();
            const actual = rendered.getChannelData(0);
            const expected = reference.getChannelData(0);
            let sum = 0;
            for (let i = 0; i < frames; i++) sum += (actual[i] - expected[i]) ** 2;
            let lag = 0;
            let best = Infinity;
            for (let shift = -8; shift <= 8; shift++) {
              let error = 0;
              for (let i = 32; i < frames - 32; i += 7)
                error += (actual[i] - expected[i + shift]) ** 2;
              if (error < best) {
                best = error;
                lag = shift;
              }
            }
            results.push({
              codec,
              offset,
              rms: Math.sqrt(sum / frames),
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
  }, PREFIX);
  expect(rows).toHaveLength(9);
  for (const row of rows) {
    expect(row.errors, `${row.codec} at ${row.offset}`).toEqual([]);
    expect(Math.abs(row.duration - row.nativeDuration)).toBeLessThan(1 / 48_000);
    expect(Math.abs(row.lag), `${row.codec} at ${row.offset}`).toBeLessThanOrEqual(1);
    expect(row.rms, `${row.codec} at ${row.offset}`).toBeLessThan(0.003);
  }
});

test('rapid seeks and a ten-minute clock jump keep a long track bounded without full decode', async ({
  page,
}) => {
  await openProbe(page);
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
