/**
 * Two real Chromium contexts and a local PeerJS connection exercise the actual
 * room/UI synchronization code. YouTube media time advances in the fake player.
 * `mediaTime - fixedOutputDelay` is an acoustic model, NOT a speaker recording
 * or proof of Android/Bluetooth hardware latency.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  useAnonymousAccountSession,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { installFakeYt, readFakeYtLog, readFakeYtSnapshot } from './helpers/fake-yt.ts';
import { navigateToTab } from './helpers/wait.ts';

type Platform = 'android' | 'other';
type Trace = {
  commitAt: number | null;
  ordinaryHeartbeats: number;
  rendezvousCompletions: number;
  frames: Array<{ type: string; hostPlatform: unknown; isManual: unknown }>;
};
type FixtureWindow = Window & {
  __MUSIXQUARE_BUS__: {
    emit(name: string, ...args: unknown[]): void;
    on(name: string, callback: (...args: unknown[]) => void): void;
  };
  __MUSIXQUARE_GET_STATE__(path: string): unknown;
  __fakeYtLastPlayer: { getCurrentTime(): number; getPlayerState(): number; isMuted(): boolean };
  __outputDelayTrace: Trace;
};

const VIDEO_ID = 'FAKEVID0001';
const OUTPUT_MS = { android: 250, other: 0 } as const;

async function installEndpoint(page: Page, platform: Platform): Promise<void> {
  await page.addInitScript((selected) => {
    const android = selected === 'android';
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      get: () =>
        android
          ? 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36'
          : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    });
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      get: () => (android ? 'Linux aarch64' : 'Win32'),
    });
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      get: () => ({ platform: android ? 'Android' : 'Windows', mobile: android }),
    });
  }, platform);
  await installFakeYt(page, {
    autoPlayOnLoad: true,
    advanceClock: true,
    emitBuffering: true,
    playDelayMs: 20,
  });
  await page.addInitScript(() => {
    type Player = { getPlaylistIndex(): number };
    const yt = (window as unknown as { YT: { Player: new (...args: unknown[]) => Player } }).YT;
    const Original = yt.Player;
    yt.Player = function (...args: unknown[]) {
      const player = new Original(...args);
      player.getPlaylistIndex = () => -1;
      return player;
    } as unknown as typeof Original;
  });
  // Keep external metadata/network independent from the timing model.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/oembed' && url.hostname.endsWith('youtube.com')) {
      return route.fulfill({ json: { title: 'Output delay model fixture', author_name: 'E2E' } });
    }
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
}

async function observeGuest(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    w.__outputDelayTrace = {
      commitAt: null,
      ordinaryHeartbeats: 0,
      rendezvousCompletions: 0,
      frames: [],
    };
    w.__MUSIXQUARE_BUS__.on('network:data', (raw) => {
      const message = raw as {
        type?: string;
        startAtHost?: number;
        hostPlatform?: unknown;
        isManual?: boolean;
      };
      if (message.type === 'youtube-zero-start-commit')
        w.__outputDelayTrace.commitAt = message.startAtHost ?? null;
      if (message.type === 'youtube-sync' || message.type === 'youtube-state') {
        w.__outputDelayTrace.frames.push({
          type: message.type,
          hostPlatform: message.hostPlatform,
          isManual: message.isManual,
        });
        if (message.type === 'youtube-sync' && !message.isManual)
          w.__outputDelayTrace.ordinaryHeartbeats += 1;
      }
    });
    w.__MUSIXQUARE_BUS__.on('youtube:sync-loading', (busy, owner) => {
      if (busy === false && owner === 'rendezvous') w.__outputDelayTrace.rendezvousCompletions += 1;
    });
  });
}

async function playing(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const player = await readFakeYtSnapshot(page);
        return player?.videoId === VIDEO_ID && player.state === 1 && !player.muted;
      },
      { timeout: 25_000 },
    )
    .toBe(true);
}

async function sample(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as FixtureWindow;
    return {
      at: Date.now(),
      position: w.__fakeYtLastPlayer.getCurrentTime(),
      state: w.__fakeYtLastPlayer.getPlayerState(),
      muted: w.__fakeYtLastPlayer.isMuted(),
      manual: Number(w.__MUSIXQUARE_GET_STATE__('sync.youtubeLocalOffset')),
    };
  });
}

async function assertAudibleModel(
  pair: HostGuestPair,
  host: Platform,
  guest: Platform,
  phase: string,
  observations: unknown[],
  expectedHostManual = 0,
): Promise<void> {
  await Promise.all([playing(pair.hostPage), playing(pair.guestPage)]);
  for (let index = 0; index < 3; index += 1) {
    const [h, g] = await Promise.all([sample(pair.hostPage), sample(pair.guestPage)]);
    const guestMediaAtHostTime = g.position + (h.at - g.at) / 1000;
    const audibleDifferenceMs =
      (guestMediaAtHostTime - h.position + expectedHostManual) * 1000 -
      OUTPUT_MS[guest] +
      OUTPUT_MS[host];
    observations.push({ phase, host: h, guest: g, audibleDifferenceMs });
    expect(h.manual, `${phase}: host manual setting`).toBe(expectedHostManual);
    expect(g.manual, `${phase}: guest manual setting`).toBe(0);
    expect(h.state, `${phase}: host remains playing`).toBe(1);
    expect(g.state, `${phase}: guest remains playing`).toBe(1);
    // Small browser scheduling noise fits, a missing 250 ms policy does not.
    expect(Math.abs(audibleDifferenceMs), `${phase}: modeled audible delta`).toBeLessThan(120);
    if (index < 2) await pair.hostPage.waitForTimeout(250);
  }
}

async function assertHostManualIsLocal(
  pair: HostGuestPair,
  host: Platform,
  guest: Platform,
  observations: unknown[],
): Promise<void> {
  const [hostBefore, guestBefore, hostLogBefore, guestLogBefore] = await Promise.all([
    sample(pair.hostPage),
    sample(pair.guestPage),
    readFakeYtLog(pair.hostPage),
    readFakeYtLog(pair.guestPage),
  ]);
  const hostManual = 0.4;
  await pair.hostPage.evaluate((offset) => {
    (window as unknown as FixtureWindow).__MUSIXQUARE_BUS__.emit(
      'youtube:set-coordinator-manual-offset',
      offset,
      'committed',
    );
  }, hostManual);
  // Observe the real local transaction completing physical playback. Merely
  // reading the requested/applied offset would let a bookkeeping-only fix pass.
  await expect
    .poll(async () =>
      (await readFakeYtLog(pair.hostPage))
        .slice(hostLogBefore.length)
        .some((entry) => entry.op === 'playVideo'),
    )
    .toBe(true);
  await playing(pair.hostPage);
  const heartbeatsAfterResume = await pair.guestPage.evaluate(
    () => (window as unknown as FixtureWindow).__outputDelayTrace.ordinaryHeartbeats,
  );
  // Include subsequent real PeerJS heartbeats so a host-local edit cannot
  // silently move guests after the local preparation gate has been released.
  await pair.guestPage.waitForFunction(
    (previous) =>
      (window as unknown as FixtureWindow).__outputDelayTrace.ordinaryHeartbeats >= previous + 2,
    heartbeatsAfterResume,
    { timeout: 15_000 },
  );
  for (let index = 0; index < 3; index += 1) {
    const [h, g] = await Promise.all([sample(pair.hostPage), sample(pair.guestPage)]);
    const hostAdvanceMs = (h.position - hostBefore.position) * 1000 - (h.at - hostBefore.at);
    const guestAdvanceMs = (g.position - guestBefore.position) * 1000 - (g.at - guestBefore.at);
    observations.push({
      phase: 'host-manual-independent-anchor',
      hostBefore,
      guestBefore,
      host: h,
      guest: g,
      hostAdvanceMs,
      guestAdvanceMs,
    });
    expect(
      Math.abs(hostAdvanceMs - hostManual * 1000),
      'only host moves by its 400 ms nudge',
    ).toBeLessThan(120);
    expect(Math.abs(guestAdvanceMs), 'guest keeps its previous wall-clock trajectory').toBeLessThan(
      120,
    );
    expect(h.manual).toBe(hostManual);
    expect(g.manual).toBe(0);
    expect(h.state).toBe(1);
    expect(g.state).toBe(1);
    if (index < 2) await pair.hostPage.waitForTimeout(250);
  }
  const disruptiveOperations = new Set([
    'seekTo',
    'playVideo',
    'pauseVideo',
    'stopVideo',
    'loadVideoById',
    'cueVideoById',
    'loadPlaylist',
    'playVideoAt',
    'nextVideo',
    'previousVideo',
    'destroy',
  ]);
  const guestCommands = (await readFakeYtLog(pair.guestPage))
    .slice(guestLogBefore.length)
    .filter((entry) => disruptiveOperations.has(entry.op));
  expect(guestCommands, 'host manual edit does not issue a guest playback command').toEqual([]);
  await assertAudibleModel(
    pair,
    host,
    guest,
    'host-manual-canonical-model',
    observations,
    hostManual,
  );
}

async function completions(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as FixtureWindow).__outputDelayTrace.rendezvousCompletions,
  );
}

async function waitForNewRendezvous(page: Page, previous: number): Promise<void> {
  await page.waitForFunction(
    (count) =>
      (window as unknown as FixtureWindow).__outputDelayTrace.rendezvousCompletions > count,
    previous,
    { timeout: 20_000 },
  );
  await playing(page);
}

async function attachEvidence(
  pair: HostGuestPair,
  info: TestInfo,
  observations: unknown[],
): Promise<void> {
  const [hostLog, guestLog, trace] = await Promise.all([
    readFakeYtLog(pair.hostPage),
    readFakeYtLog(pair.guestPage),
    pair.guestPage.evaluate(() => (window as unknown as FixtureWindow).__outputDelayTrace),
  ]);
  await info.attach('youtube-output-delay-model', {
    body: JSON.stringify({ modelOnly: true, observations, trace, hostLog, guestLog }, null, 2),
    contentType: 'application/json',
  });
}

for (const [host, guest] of [
  ['android', 'other'],
  ['other', 'android'],
  ['android', 'android'],
] as const) {
  test(`keeps modeled YouTube output aligned for ${host} host / ${guest} guest`, async ({
    browser,
  }, info) => {
    test.setTimeout(110_000);
    const pair = await createHostGuestContexts(browser);
    const observations: unknown[] = [];
    try {
      await Promise.all([
        installEndpoint(pair.hostPage, host),
        installEndpoint(pair.guestPage, guest),
      ]);
      await useAnonymousAccountSession(pair.hostPage, pair.guestPage);
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      await observeGuest(pair.guestPage);
      await pair.hostPage.evaluate(
        (id) =>
          (window as unknown as FixtureWindow).__MUSIXQUARE_BUS__.emit(
            'youtube:load-from-chat',
            `https://www.youtube.com/watch?v=${id}`,
          ),
        VIDEO_ID,
      );
      // A warm-up PLAYING event is not the real zero-start release. Observe
      // the genuine PeerJS COMMIT and sample after its canonical start instant.
      await pair.guestPage.waitForFunction(
        () => {
          const at = (window as unknown as FixtureWindow).__outputDelayTrace.commitAt;
          return at !== null && Date.now() >= at + 350;
        },
        undefined,
        { timeout: 25_000 },
      );
      await assertAudibleModel(pair, host, guest, 'zero-start', observations);

      await pair.guestPage.waitForFunction(
        () => (window as unknown as FixtureWindow).__outputDelayTrace.ordinaryHeartbeats > 0,
        undefined,
        { timeout: 15_000 },
      );
      await navigateToTab(pair.guestPage, 'play');
      await pair.guestPage.locator('#btn-sync').click();
      await expect(pair.guestPage.locator('#manual-sync-value')).toBeVisible();
      await pair.guestPage.locator('#btn-sync-done').click();
      await assertAudibleModel(pair, host, guest, 'guest-sync-button', observations);

      await navigateToTab(pair.hostPage, 'play');
      const beforeSeek = await completions(pair.guestPage);
      await expect(pair.hostPage.locator('#seek-slider')).toHaveAttribute('aria-disabled', 'false');
      await pair.hostPage.locator('#seek-slider').fill('60');
      await expect
        .poll(async () => (await readFakeYtSnapshot(pair.hostPage))?.currentTime)
        .toBeGreaterThanOrEqual(60);
      await waitForNewRendezvous(pair.guestPage, beforeSeek);
      await assertAudibleModel(pair, host, guest, 'seek-precision-sync', observations);

      await pair.hostPage.locator('#play-btn').click();
      await expect.poll(async () => (await readFakeYtSnapshot(pair.guestPage))?.state).toBe(2);
      const beforeResume = await completions(pair.guestPage);
      await pair.hostPage.locator('#play-btn').click();
      await waitForNewRendezvous(pair.guestPage, beforeResume);
      await assertAudibleModel(pair, host, guest, 'resume-precision-sync', observations);
      await assertHostManualIsLocal(pair, host, guest, observations);
    } finally {
      try {
        await attachEvidence(pair, info, observations);
      } finally {
        await cleanupContexts(pair);
      }
    }
  });
}
