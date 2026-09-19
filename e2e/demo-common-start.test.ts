import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { cleanupContexts, createHostGuestContexts } from './helpers/context-factory.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { clickPlayButton, readState, waitForFilePlaybackReady } from './helpers/wait.ts';

const DEMO_URL = 'https://demo.musixquare.com/linelight/*.m4a';
const DEMO_AUDIO = fileURLToPath(new URL('./fixtures/demo-track.mp3', import.meta.url));

interface DemoSourceStart {
  calledAt: number;
  when: number;
  audioNow: number;
  offset: number;
  deadline: number;
}

interface DemoSourceProbe {
  starts: DemoSourceStart[];
  pongs: number;
}

type DemoProbeWindow = Window & {
  __demoSourceProbe: DemoSourceProbe;
  __MUSIXQUARE_BUS__: { emit(event: string): void; on(event: string, handler: () => void): void };
};

async function observeOutput(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('musixquare-demo-prompt-seen-v1', '1');
    const probe: DemoSourceProbe = { starts: [], pongs: 0 };
    (window as unknown as DemoProbeWindow).__demoSourceProbe = probe;
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      const calledAt = Date.now();
      const audioNow = this.context.currentTime;
      original.apply(this, args);
      if ((this.buffer?.duration ?? 0) <= 1) return;
      const when = args[0] ?? 0;
      probe.starts.push({
        calledAt,
        when,
        audioNow,
        offset: args[1] ?? 0,
        deadline: calledAt + Math.max(0, when - audioNow) * 1_000,
      });
    };
  });
}

async function emit(page: Page, event: string): Promise<void> {
  await page.evaluate((name) => {
    (window as unknown as DemoProbeWindow).__MUSIXQUARE_BUS__.emit(name);
  }, event);
}

async function firstStart(page: Page): Promise<DemoSourceStart> {
  await page.waitForFunction(
    () => (window as unknown as DemoProbeWindow).__demoSourceProbe.starts.length > 0,
    undefined,
    { timeout: 15_000 },
  );
  return page.evaluate(() => (window as unknown as DemoProbeWindow).__demoSourceProbe.starts[0]!);
}

test('a faster demo guest waits for the host download and shares its native 200ms start', async ({
  browser,
}, testInfo) => {
  const pair = await createHostGuestContexts(browser);
  let releaseHost!: () => void;
  const hostDownload = new Promise<void>((resolve) => {
    releaseHost = resolve;
  });
  let hostDownloadPending = false;
  try {
    await Promise.all([observeOutput(pair.hostPage), observeOutput(pair.guestPage)]);
    await pair.hostPage.route(DEMO_URL, async (route) => {
      if (route.request().url().includes('/01-adventure')) {
        hostDownloadPending = true;
        await hostDownload;
      }
      await route.fulfill({ path: DEMO_AUDIO, contentType: 'audio/mpeg' });
    });
    await pair.guestPage.route(DEMO_URL, (route) =>
      route.fulfill({ path: DEMO_AUDIO, contentType: 'audio/mpeg' }),
    );
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    // Exercise entry from an already playing file, where silent teardown used
    // to leave the host's playing activity attached to its new demo identity.
    await uploadFixture(pair.hostPage, 'test01');
    await Promise.all([
      waitForFilePlaybackReady(pair.hostPage),
      waitForFilePlaybackReady(pair.guestPage),
    ]);
    if ((await readState(pair.hostPage, 'playback.activity')) !== 'playing') {
      await clickPlayButton(pair.hostPage);
    }
    await expect.poll(() => readState(pair.guestPage, 'playback.activity')).toBe('playing');
    await expect
      .poll(
        async () => ((await readState(pair.guestPage, 'sync.latencyHistory')) as number[]).length,
      )
      .toBeGreaterThanOrEqual(3);
    await Promise.all(
      [pair.hostPage, pair.guestPage].map((page) =>
        page.evaluate(() => {
          const runtime = window as unknown as DemoProbeWindow;
          runtime.__demoSourceProbe.starts = [];
          runtime.__MUSIXQUARE_BUS__.on('sync:diagnostic-standard-pong', () => {
            runtime.__demoSourceProbe.pongs += 1;
          });
        }),
      ),
    );
    await emit(pair.hostPage, 'demo:enter');
    await expect.poll(() => hostDownloadPending).toBe(true);
    await expect.poll(() => readState(pair.guestPage, 'demo.active')).toBe(true);
    await expect.poll(() => readState(pair.guestPage, 'demo.loading')).toBe(false);
    // Native decode publishes READY with pending activity until PLAY arrives.
    await expect.poll(() => readState(pair.guestPage, 'playback.lifecycle')).toBe('READY');
    expect(await readState(pair.guestPage, 'playback.activity')).not.toBe('playing');

    const pongsBefore = await pair.guestPage.evaluate(
      () => (window as unknown as DemoProbeWindow).__demoSourceProbe.pongs,
    );
    await emit(pair.guestPage, 'sync:request-immediate-ping');
    await expect
      .poll(() =>
        pair.guestPage.evaluate(
          () => (window as unknown as DemoProbeWindow).__demoSourceProbe.pongs,
        ),
      )
      .toBeGreaterThan(pongsBefore);
    expect(await readState(pair.hostPage, 'demo.loading')).toBe(true);
    expect(await readState(pair.hostPage, 'playback.activity')).toBe('paused');
    expect(
      await pair.guestPage.evaluate(
        () => (window as unknown as DemoProbeWindow).__demoSourceProbe.starts,
      ),
    ).toEqual([]);

    releaseHost();
    const [host, guest] = await Promise.all([
      firstStart(pair.hostPage),
      firstStart(pair.guestPage),
    ]);
    await testInfo.attach('native-demo-starts', {
      body: JSON.stringify({ host, guest }, null, 2),
      contentType: 'application/json',
    });
    expect((host.when - host.audioNow) * 1_000).toBeGreaterThanOrEqual(180);
    expect((host.when - host.audioNow) * 1_000).toBeLessThanOrEqual(220);
    expect(Math.abs(host.deadline - guest.deadline)).toBeLessThanOrEqual(40);
    expect(Math.abs(host.offset - guest.offset)).toBeLessThanOrEqual(0.04);
    // Native scheduling is measurable here; physical speaker latency is not.
    await expect.poll(() => readState(pair.guestPage, 'playback.activity')).toBe('playing');
  } finally {
    releaseHost();
    await cleanupContexts(pair);
  }
});
