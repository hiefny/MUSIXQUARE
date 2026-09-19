import { expect, test, type Page } from '@playwright/test';
import {
  cleanupContexts,
  createHostGuestContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { clickPlayButton, readState, waitForFilePlaybackReady } from './helpers/wait.ts';

interface NativeFileStart {
  id: number;
  calledAtWallMs: number;
  audioNow: number;
  when: number;
  offset: number;
  duration: number;
  deadlineWallMs: number;
}

interface FileStartProbe {
  starts: NativeFileStart[];
  stops: Array<{ id: number; calledAtWallMs: number; audioNow: number }>;
  live: Set<AudioBufferSourceNode>;
  pauseAfterNextStartMs: number | null;
}

type ProbeWindow = Window & {
  __fileStartProbe: FileStartProbe;
  __MUSIXQUARE_GET_STATE__: (path: string) => unknown;
  __MUSIXQUARE_BUS__: { emit(name: string): void };
};

async function observeNativeSources(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: FileStartProbe = {
      starts: [],
      stops: [],
      live: new Set(),
      pauseAfterNextStartMs: null,
    };
    (window as unknown as ProbeWindow).__fileStartProbe = probe;
    const identities = new WeakMap<AudioBufferSourceNode, number>();
    let nextId = 0;
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args) {
      const calledAtWallMs = Date.now();
      const audioNow = this.context.currentTime;
      // Observe the real engine after the browser accepts its source start.
      start.apply(this, args);
      if ((this.buffer?.duration ?? 0) <= 1) return;
      const id = ++nextId;
      const when = args[0] ?? 0;
      identities.set(this, id);
      probe.starts.push({
        id,
        calledAtWallMs,
        audioNow,
        when,
        offset: args[1] ?? 0,
        duration: this.buffer!.duration,
        deadlineWallMs: calledAtWallMs + Math.max(0, when - audioNow) * 1_000,
      });
      probe.live.add(this);
      this.addEventListener('ended', () => probe.live.delete(this), { once: true });
      if (probe.pauseAfterNextStartMs !== null) {
        const pauseAfterMs = probe.pauseAfterNextStartMs;
        probe.pauseAfterNextStartMs = null;
        setTimeout(() => document.getElementById('play-btn')?.click(), pauseAfterMs);
      }
    };
    AudioBufferSourceNode.prototype.stop = function (...args) {
      stop.apply(this, args);
      const id = identities.get(this);
      if (id !== undefined) {
        probe.stops.push({ id, calledAtWallMs: Date.now(), audioNow: this.context.currentTime });
        probe.live.delete(this);
      }
    };
  });
}

async function resetProbe(page: Page, pauseAfterNextStartMs: number | null = null): Promise<void> {
  await page.evaluate((pauseAfterMs) => {
    const probe = (window as unknown as ProbeWindow).__fileStartProbe;
    probe.starts = [];
    probe.stops = [];
    probe.pauseAfterNextStartMs = pauseAfterMs;
  }, pauseAfterNextStartMs);
}

async function waitForFirstFileStart(page: Page): Promise<NativeFileStart> {
  await page.waitForFunction(
    () => (window as unknown as ProbeWindow).__fileStartProbe.starts.length > 0,
    undefined,
    { timeout: 10_000 },
  );
  return page.evaluate(() => (window as unknown as ProbeWindow).__fileStartProbe.starts[0]!);
}

let pair: HostGuestPair;

test.describe('Local file common start', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
    await Promise.all([observeNativeSources(pair.hostPage), observeNativeSources(pair.guestPage)]);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('aligns prepared native source deadlines and cancels a start paused during its lead', async ({}, testInfo) => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await uploadFixture(pair.hostPage, 'test01');
    await Promise.all([
      waitForFilePlaybackReady(pair.hostPage, 25_000),
      waitForFilePlaybackReady(pair.guestPage, 25_000),
    ]);
    if ((await readState(pair.hostPage, 'playback.activity')) !== 'playing') {
      await clickPlayButton(pair.hostPage);
    }
    await waitForFirstFileStart(pair.guestPage);
    await expect.poll(() => readState(pair.guestPage, 'playback.activity')).toBe('playing');

    // Warm the real shared clock; no clock or AudioContext implementation is replaced.
    await pair.guestPage.evaluate(() => {
      (window as unknown as ProbeWindow).__MUSIXQUARE_BUS__.emit('sync:request-immediate-ping');
    });
    await expect
      .poll(
        async () => ((await readState(pair.guestPage, 'sync.latencyHistory')) as number[]).length,
      )
      .toBeGreaterThanOrEqual(3);
    await clickPlayButton(pair.hostPage);
    await Promise.all(
      [pair.hostPage, pair.guestPage].map((page) =>
        expect.poll(() => readState(page, 'playback.activity')).toBe('paused'),
      ),
    );

    await Promise.all([resetProbe(pair.hostPage), resetProbe(pair.guestPage)]);
    await clickPlayButton(pair.hostPage);
    const [hostStart, guestStart] = await Promise.all([
      waitForFirstFileStart(pair.hostPage),
      waitForFirstFileStart(pair.guestPage),
    ]);
    await testInfo.attach('native-source-deadlines', {
      body: JSON.stringify({ hostStart, guestStart }, null, 2),
      contentType: 'application/json',
    });

    const hostLeadMs = (hostStart.when - hostStart.audioNow) * 1_000;
    expect(hostLeadMs).toBeGreaterThanOrEqual(180);
    expect(hostLeadMs).toBeLessThanOrEqual(500);
    expect(Math.abs(hostLeadMs - 200)).toBeLessThanOrEqual(20);
    expect(Math.abs(guestStart.deadlineWallMs - hostStart.deadlineWallMs)).toBeLessThanOrEqual(40);
    expect(Math.abs(guestStart.offset - hostStart.offset)).toBeLessThanOrEqual(0.04);
    // These are browser scheduling measurements, not physical speaker latency.

    await clickPlayButton(pair.hostPage);
    await Promise.all(
      [pair.hostPage, pair.guestPage].map((page) =>
        expect.poll(() => readState(page, 'playback.activity')).toBe('paused'),
      ),
    );
    await Promise.all([resetProbe(pair.hostPage, 100), resetProbe(pair.guestPage)]);
    await clickPlayButton(pair.hostPage);
    const cancelledStart = await waitForFirstFileStart(pair.hostPage);
    await Promise.all(
      [pair.hostPage, pair.guestPage].map((page) =>
        page.waitForFunction(
          (deadline) => {
            const runtime = window as unknown as ProbeWindow;
            return (
              Date.now() >= deadline + 300 &&
              runtime.__MUSIXQUARE_GET_STATE__('playback.activity') === 'paused' &&
              runtime.__fileStartProbe.live.size === 0
            );
          },
          cancelledStart.deadlineWallMs,
          { timeout: 10_000 },
        ),
      ),
    );
    const stop = await pair.hostPage.evaluate(
      (id) =>
        (window as unknown as ProbeWindow).__fileStartProbe.stops.find((entry) => entry.id === id),
      cancelledStart.id,
    );
    expect(stop).toBeDefined();
    expect(stop!.audioNow).toBeLessThan(cancelledStart.when);
    expect(stop!.calledAtWallMs - cancelledStart.calledAtWallMs).toBeLessThan(200);
  });
});
