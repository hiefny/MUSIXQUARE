import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { cleanupContexts, createHostGuestContexts } from './helpers/context-factory.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { connectHostAndGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import { readState } from './helpers/wait.ts';

const DEMO_TRACK_PATH = fileURLToPath(new URL('./fixtures/demo-track.mp3', import.meta.url));

interface DemoOutputProbe {
  context: AudioContext | null;
  rejectResume: boolean;
  rejectedResumes: number;
  decodedBuffers: number;
  starts: number;
  liveSources: Set<AudioBufferSourceNode>;
}

type ProbeWindow = Window & { __demoOutputProbe: DemoOutputProbe };

async function instrumentNativeOutput(page: Page): Promise<void> {
  await page.route('https://demo.musixquare.com/linelight/*.m4a', (route) =>
    route.fulfill({ path: DEMO_TRACK_PATH, contentType: 'audio/mpeg' }),
  );
  await page.addInitScript(() => {
    const probe: DemoOutputProbe = {
      context: null,
      rejectResume: false,
      rejectedResumes: 0,
      decodedBuffers: 0,
      starts: 0,
      liveSources: new Set(),
    };
    (window as unknown as ProbeWindow).__demoOutputProbe = probe;
    const contexts = new WeakSet<AudioContext>();
    function observe(context: AudioContext): void {
      probe.context = context;
      if (contexts.has(context)) return;
      contexts.add(context);
      const resume = context.resume.bind(context);
      context.resume = () => {
        if (!probe.rejectResume) return resume();
        probe.rejectedResumes += 1;
        return Promise.reject(new DOMException('Test: audio gesture required', 'NotAllowedError'));
      };
      const decode = context.decodeAudioData.bind(context);
      context.decodeAudioData = (bytes, success, failure) =>
        decode(bytes, success, failure).then((buffer) => {
          probe.decodedBuffers += 1;
          return buffer;
        });
    }
    const createGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () {
      observe(this);
      return createGain.call(this);
    };
    const createBufferSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      observe(this);
      const source = createBufferSource.call(this);
      const start = source.start.bind(source);
      const stop = source.stop.bind(source);
      source.start = (...args) => {
        start(...args);
        // Ignore the engine's silent unlock/warmup buffers.
        if ((source.buffer?.duration ?? 0) > 1) {
          probe.starts += 1;
          probe.liveSources.add(source);
        }
      };
      source.stop = (...args) => {
        stop(...args);
        probe.liveSources.delete(source);
      };
      source.addEventListener('ended', () => probe.liveSources.delete(source));
      return source;
    };
  });
}

async function enterDemo(page: Page): Promise<void> {
  // Use the same entry seam as the existing connected-demo E2E fixture.
  await page.evaluate(() => {
    const bus = (window as unknown as { __MUSIXQUARE_BUS__: { emit: (name: string) => void } })
      .__MUSIXQUARE_BUS__;
    bus.emit('demo:enter');
  });
  await expect(page.locator('#demo-overlay')).toHaveClass(/active/);
}

async function waitForDemoAudio(page: Page): Promise<void> {
  await expect.poll(() => readState(page, 'demo.active')).toBe(true);
  await expect.poll(() => readState(page, 'playback.activity')).toBe('playing');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const probe = (window as unknown as ProbeWindow).__demoOutputProbe;
        return probe.context?.state === 'running' && probe.liveSources.size > 0;
      }),
    )
    .toBe(true);
}

async function suspendAndRejectResume(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const probe = (window as unknown as ProbeWindow).__demoOutputProbe;
    if (!probe.context) throw new Error('App has not initialized its native AudioContext');
    probe.rejectResume = true;
    await probe.context.suspend();
  });
}

async function foregroundPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // Exercise the real visibility listeners; Chromium automation does not
    // reproduce a physical iOS background interruption by itself.
    for (const visibility of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => visibility === 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      if (visibility === 'hidden') await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
  });
}

async function expectRecoveryPrompt(page: Page): Promise<void> {
  await expect(page.locator('#dialog-overlay.show')).toBeVisible();
  await expect(page.locator('#dialog-title')).toHaveText('Audio paused unexpectedly');
  await expect(page.locator('#btn-dialog-ok')).toHaveText('Restore audio');
  const output = await page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).__demoOutputProbe;
    return { state: probe.context?.state, rejected: probe.rejectedResumes };
  });
  expect(output.state).toBe('suspended');
  expect(output.rejected).toBeGreaterThan(0);
  expect(await readState(page, 'files.current')).toBeNull();
}

async function allowNativeResume(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__demoOutputProbe.rejectResume = false;
  });
}

async function restoreThroughPrompt(page: Page): Promise<void> {
  await allowNativeResume(page);
  // Only the application's trusted click handler may resume the native context.
  await page.locator('#btn-dialog-ok').click();
  await expect(page.locator('#dialog-overlay.show')).toHaveCount(0);
  await waitForDemoAudio(page);
  const startedAt = await page.evaluate(
    () => (window as unknown as ProbeWindow).__demoOutputProbe.context!.currentTime,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as ProbeWindow).__demoOutputProbe.context!.currentTime,
      ),
    )
    .toBeGreaterThan(startedAt + 0.1);
}

test.describe('Demo output recovery', () => {
  test('guest automatic resume failure offers a trusted local recovery without stopping the host', async ({
    browser,
  }) => {
    const pair = await createHostGuestContexts(browser);
    try {
      await Promise.all([
        instrumentNativeOutput(pair.hostPage),
        instrumentNativeOutput(pair.guestPage),
      ]);
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      await enterDemo(pair.hostPage);
      await Promise.all([waitForDemoAudio(pair.hostPage), waitForDemoAudio(pair.guestPage)]);
      await suspendAndRejectResume(pair.guestPage);
      await foregroundPage(pair.guestPage);
      await expectRecoveryPrompt(pair.guestPage);
      await waitForDemoAudio(pair.hostPage);
      await expect(pair.hostPage.locator('#dialog-overlay.show')).toHaveCount(0);

      await restoreThroughPrompt(pair.guestPage);
      await expect.poll(() => readState(pair.guestPage, 'network.hostConn.open')).toBe(true);
      await waitForDemoAudio(pair.hostPage);
    } finally {
      await cleanupContexts(pair);
    }
  });

  test('host exit dismisses a guest recovery prompt and retired output cannot restart', async ({
    browser,
  }) => {
    const pair = await createHostGuestContexts(browser);
    try {
      await Promise.all([
        instrumentNativeOutput(pair.hostPage),
        instrumentNativeOutput(pair.guestPage),
      ]);
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      await enterDemo(pair.hostPage);
      await Promise.all([waitForDemoAudio(pair.hostPage), waitForDemoAudio(pair.guestPage)]);
      await suspendAndRejectResume(pair.guestPage);
      await foregroundPage(pair.guestPage);
      await expectRecoveryPrompt(pair.guestPage);

      await pair.hostPage.locator('[data-demo-step="3"]').click();
      await pair.hostPage.locator('[data-demo-next]').click();
      await pair.hostPage.locator('[data-demo-exit]').click();
      await expect.poll(() => readState(pair.guestPage, 'demo.active')).toBe(false);
      await expect(pair.guestPage.locator('#dialog-overlay.show')).toHaveCount(0);
      const startsAfterExit = await pair.guestPage.evaluate(
        () => (window as unknown as ProbeWindow).__demoOutputProbe.starts,
      );
      await allowNativeResume(pair.guestPage);
      await foregroundPage(pair.guestPage);
      // Covers the automatic resume/health check settlement after the old
      // demo's prompt and source have been retired by the host's exit.
      await pair.guestPage.waitForTimeout(1_000);
      expect(await readState(pair.guestPage, 'demo.active')).toBe(false);
      expect(await readState(pair.guestPage, 'playback.activity')).toBe('idle');
      expect(
        await pair.guestPage.evaluate(() => {
          const probe = (window as unknown as ProbeWindow).__demoOutputProbe;
          return { starts: probe.starts, live: probe.liveSources.size };
        }),
      ).toEqual({ starts: startsAfterExit, live: 0 });
      await expect(pair.guestPage.locator('#dialog-overlay.show')).toHaveCount(0);
    } finally {
      await cleanupContexts(pair);
    }
  });

  test('initial demo decodes while output is locked and retries that decoded track on the user gesture', async ({
    page,
  }) => {
    await injectPeerServer(page);
    await instrumentNativeOutput(page);
    await setupHostAndStart(page);
    await suspendAndRejectResume(page);
    await enterDemo(page);
    await expectRecoveryPrompt(page);
    await expect.poll(() => readState(page, 'demo.loading')).toBe(false);
    const decodedBeforeRecovery = await page.evaluate(
      () => (window as unknown as ProbeWindow).__demoOutputProbe.decodedBuffers,
    );
    expect(decodedBeforeRecovery).toBeGreaterThan(0);
    expect(await readState(page, 'demo.active')).toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as ProbeWindow).__demoOutputProbe.starts),
    ).toBe(0);

    await restoreThroughPrompt(page);
    expect(
      await page.evaluate(
        () => (window as unknown as ProbeWindow).__demoOutputProbe.decodedBuffers,
      ),
    ).toBe(decodedBeforeRecovery);
    expect(await readState(page, 'demo.currentTrackIndex')).toBe(0);
  });
});
