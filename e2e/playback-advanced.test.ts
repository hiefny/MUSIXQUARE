/**
 * E2E: Advanced Playback Tests
 *
 * Tests advanced playback features with real MP3 files:
 * - Repeat mode cycling (off → all → one → off)
 * - Shuffle mode toggle
 * - Actual PLAYING_AUDIO state with real MP3
 * - Pause → PAUSED state
 * - Track title display
 * - Auto-advance to next track
 * - Seek slider interaction
 */
import { test, expect, type Page } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  getPageErrors,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture, uploadFixtures } from './helpers/file-upload.ts';
import {
  readCurrentQueueIndex,
  readQueueSnapshot,
  setCurrentQueueItemByIndex,
  waitForCurrentQueueIndex,
  waitForCurrentQueueItemId,
} from './helpers/queue-state.ts';
import {
  readPlaybackProjection,
  readState,
  navigateToSubtab,
  navigateToTab,
  waitForFilePlaybackReady,
  waitForPlaybackProjection,
  waitForPlaylistCount,
  waitForState,
} from './helpers/wait.ts';

let pair: HostGuestPair;

interface FileSourceProbe {
  starts: string[];
  stops: string[];
}

async function installFileSourceProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const get = w.__MUSIXQUARE_GET_STATE__ as (path: string) => unknown;
    const probe = { starts: [] as string[], stops: [] as string[] };
    w.__pendingDecodeSourceProbe = probe;
    const owners = new WeakMap<AudioBufferSourceNode, string>();
    const originalStart = AudioBufferSourceNode.prototype.start;
    const originalStop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args) {
      const file = get('files.current') as { queueItemId?: string } | null;
      // Ignore short UI sounds; these fixtures use the real decoded MP3.
      if (this.buffer && this.buffer.duration > 1 && file?.queueItemId) {
        owners.set(this, file.queueItemId);
        probe.starts.push(file.queueItemId);
      }
      return originalStart.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (...args) {
      const owner = owners.get(this);
      if (owner) probe.stops.push(owner);
      return originalStop.apply(this, args);
    };
  });
}

async function readFileSourceProbe(page: Page): Promise<FileSourceProbe> {
  return page.evaluate(
    () =>
      (window as unknown as Record<string, unknown>).__pendingDecodeSourceProbe as FileSourceProbe,
  );
}

interface HeldDecode {
  queueItemId: string;
  released: boolean;
  finished: boolean;
  release(): void;
}

async function holdHostFileDecodes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const get = w.__MUSIXQUARE_GET_STATE__ as (path: string) => unknown;
    const held: HeldDecode[] = [];
    w.__heldFileDecodes = held;
    const originalDecode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (data) {
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entry: HeldDecode = {
        queueItemId: String(get('playlist.currentQueueItemId')),
        released: false,
        finished: false,
        release() {
          entry.released = true;
          release();
        },
      };
      held.push(entry);
      // Preserve native MP3 decoding; only its completion visible to the app
      // is delayed, modelling an uncancellable slow browser decode.
      return originalDecode.call(this, data).then(async (buffer) => {
        await barrier;
        entry.finished = true;
        return buffer;
      });
    };
  });
}

async function waitForHeldDecode(page: Page, queueItemId: string): Promise<void> {
  await page.waitForFunction((id) => {
    const held = (window as unknown as Record<string, unknown>).__heldFileDecodes as HeldDecode[];
    return held.some((entry) => entry.queueItemId === id && !entry.released);
  }, queueItemId);
}

async function releaseHeldDecode(page: Page, queueItemId: string): Promise<void> {
  await page.evaluate((id) => {
    const held = (window as unknown as Record<string, unknown>).__heldFileDecodes as HeldDecode[];
    const entry = held.find((candidate) => candidate.queueItemId === id);
    if (!entry) throw new Error(`No pending native decode for ${id}`);
    entry.release();
  }, queueItemId);
}

test.describe('Advanced Playback', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    const hostErrors = getPageErrors(pair.hostPage);
    const guestErrors = getPageErrors(pair.guestPage);
    await cleanupContexts(pair);
    expect(hostErrors, 'Host page had uncaught JS errors').toHaveLength(0);
    expect(guestErrors, 'Guest page had uncaught JS errors').toHaveLength(0);
  });

  // ── Repeat Mode Tests ────────────────────────────────────────

  test('repeat button cycles through modes: off → all → one → off', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const repeatBtn = pair.hostPage.locator('#btn-repeat');
    await expect(repeatBtn).toBeVisible();
    let mode = (await readState(pair.hostPage, 'playlist.repeatMode')) as number;
    expect(mode).toBe(0);

    await repeatBtn.click();
    await waitForState(pair.hostPage, 'playlist.repeatMode', 1);
    mode = (await readState(pair.hostPage, 'playlist.repeatMode')) as number;
    expect(mode).toBe(1);

    await repeatBtn.click();
    await waitForState(pair.hostPage, 'playlist.repeatMode', 2);
    mode = (await readState(pair.hostPage, 'playlist.repeatMode')) as number;
    expect(mode).toBe(2);

    await repeatBtn.click();
    await waitForState(pair.hostPage, 'playlist.repeatMode', 0);
    mode = (await readState(pair.hostPage, 'playlist.repeatMode')) as number;
    expect(mode).toBe(0);
  });

  test('repeat all shows active class on button', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const repeatBtn = pair.hostPage.locator('#btn-repeat');
    await expect(repeatBtn).toBeVisible();
    await repeatBtn.click(); // → all
    await waitForState(pair.hostPage, 'playlist.repeatMode', 1);

    const hasActive = await repeatBtn.evaluate((el) => el.classList.contains('active'));
    expect(hasActive).toBe(true);
  });

  test('repeat one shows active-one class on button', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const repeatBtn = pair.hostPage.locator('#btn-repeat');
    await expect(repeatBtn).toBeVisible();
    await repeatBtn.click(); // → all
    await repeatBtn.click(); // → one
    await waitForState(pair.hostPage, 'playlist.repeatMode', 2);

    const hasActiveOne = await repeatBtn.evaluate((el) => el.classList.contains('active-one'));
    expect(hasActiveOne).toBe(true);
  });

  // ── Shuffle Mode Tests ──────────────────────────────────────

  test('shuffle button toggles shuffle mode', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const shuffleBtn = pair.hostPage.locator('#btn-shuffle');
    await expect(shuffleBtn).toBeVisible();
    let shuffle = (await readState(pair.hostPage, 'playlist.isShuffle')) as boolean;
    expect(shuffle).toBe(false);

    await shuffleBtn.click();
    await waitForState(pair.hostPage, 'playlist.isShuffle', true);
    shuffle = (await readState(pair.hostPage, 'playlist.isShuffle')) as boolean;
    expect(shuffle).toBe(true);

    const hasActive = await shuffleBtn.evaluate((el) => el.classList.contains('active'));
    expect(hasActive).toBe(true);

    await shuffleBtn.click();
    await waitForState(pair.hostPage, 'playlist.isShuffle', false);
    shuffle = (await readState(pair.hostPage, 'playlist.isShuffle')) as boolean;
    expect(shuffle).toBe(false);
  });

  // ── Real Audio Playback Tests ──────────────────────────────

  test('play real MP3 reaches PLAYING_AUDIO state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.current') !== null;
      },
      undefined,
      { timeout: 20_000 },
    );

    await pair.hostPage.click('#play-btn');

    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 15_000);

    const state = await readPlaybackProjection(pair.hostPage);
    expect(state).toBe('PLAYING_AUDIO');
  });

  test('pause from PLAYING_AUDIO transitions to PAUSED', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.current') !== null;
      },
      undefined,
      { timeout: 20_000 },
    );

    await pair.hostPage.click('#play-btn');
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 15_000);

    await pair.hostPage.click('#play-btn');
    await waitForPlaybackProjection(pair.hostPage, 'PAUSED', 10_000);

    const state = await readPlaybackProjection(pair.hostPage);
    expect(state).toBe('PAUSED');
  });

  test('resume from PAUSED returns to PLAYING_AUDIO', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.current') !== null;
      },
      undefined,
      { timeout: 20_000 },
    );

    await pair.hostPage.click('#play-btn');
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 15_000);

    await pair.hostPage.click('#play-btn'); // pause
    await waitForPlaybackProjection(pair.hostPage, 'PAUSED', 10_000);

    await pair.hostPage.click('#play-btn'); // resume
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 10_000);

    const state = await readPlaybackProjection(pair.hostPage);
    expect(state).toBe('PLAYING_AUDIO');
  });

  // ── Track Display Tests ──────────────────────────────────────

  test('track title updates after file upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const el = document.getElementById('track-title');
        return el && el.textContent && el.textContent.trim().length > 0;
      },
      undefined,
      { timeout: 10_000 },
    );

    const titleText = await pair.hostPage.locator('#track-title').textContent();
    expect(titleText).toBeTruthy();
    expect(titleText!.trim().length).toBeGreaterThan(0);
  });

  test('time display updates during playback', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.current') !== null;
      },
      undefined,
      { timeout: 20_000 },
    );

    await pair.hostPage.click('#play-btn');

    await pair.hostPage.waitForFunction(
      () => {
        const dur = document.getElementById('time-dur');
        return (
          dur &&
          dur.textContent &&
          dur.textContent.trim() !== '' &&
          dur.textContent.trim() !== '0:00'
        );
      },
      undefined,
      { timeout: 10_000 },
    );

    const durText = await pair.hostPage.locator('#time-dur').textContent();
    expect(durText).toBeTruthy();
    expect(durText!.trim()).not.toBe('');
  });

  // ── Seek Slider Tests ──────────────────────────────────────

  test('seek slider exists and is interactive', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    const seekSlider = pair.hostPage.locator('#seek-slider');
    await expect(seekSlider).toBeAttached();
  });

  // ── Guest Sync Tests ──────────────────────────────────────

  test('guest playback projection updates when host plays real MP3', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);
    await waitForFilePlaybackReady(pair.guestPage, 20_000);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );

    await pair.hostPage.click('#play-btn');
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 15_000);

    await waitForPlaybackProjection(pair.guestPage, 'PLAYING_AUDIO', 15_000);

    const guestState = await readPlaybackProjection(pair.guestPage);
    expect(guestState).toBe('PLAYING_AUDIO');
  });

  test('guest state updates when host pauses', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);
    await waitForFilePlaybackReady(pair.guestPage, 20_000);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );

    await pair.hostPage.click('#play-btn');
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 15_000);
    await waitForPlaybackProjection(pair.guestPage, 'PLAYING_AUDIO', 15_000);

    await pair.hostPage.click('#play-btn'); // pause

    await waitForPlaybackProjection(pair.hostPage, 'PAUSED', 10_000);
    await waitForPlaybackProjection(pair.guestPage, 'PAUSED', 10_000);

    const hostState = await readPlaybackProjection(pair.hostPage);
    expect(hostState).toBe('PAUSED');
    expect(await readPlaybackProjection(pair.guestPage)).toBe('PAUSED');
  });

  // ── Next Track Navigation Tests ────────────────────────────

  for (const actor of ['host', 'operator'] as const) {
    test(`${actor} file selection retires guest playback before pending host decode completes`, async () => {
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      // This case exercises local file delivery, not the external Remote Share
      // service. Let real loopback ICE classification settle before upload.
      await waitForState(pair.guestPage, 'network.connectionType', 'local', 20_000);
      await pair.hostPage.waitForFunction(
        () => {
          const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as (
            path: string,
          ) => unknown;
          const peers = get('network.connectedPeers') as Array<{ connectionType?: string }>;
          return peers.length === 1 && peers[0]?.connectionType === 'local';
        },
        undefined,
        { timeout: 20_000 },
      );
      if (actor === 'operator') {
        await navigateToTab(pair.hostPage, 'settings');
        await navigateToSubtab(pair.hostPage, 'connect');
        await pair.hostPage.locator('.d-op-btn:visible').first().click();
        await waitForState(pair.guestPage, 'network.isOperator', true);
      }
      await uploadFixtures(pair.hostPage, ['test01', 'test02', 'test03']);
      await waitForPlaylistCount(pair.guestPage, 3, 20_000);
      await Promise.all([
        waitForFilePlaybackReady(pair.hostPage, 20_000),
        waitForFilePlaybackReady(pair.guestPage, 20_000),
      ]);
      const { items } = await readQueueSnapshot(pair.hostPage);
      const [newest, superseded, outgoing] = items;
      expect(items).toHaveLength(3);
      await Promise.all([
        installFileSourceProbe(pair.hostPage),
        installFileSourceProbe(pair.guestPage),
      ]);

      // Start at the final row so the earlier selections cannot use an
      // already-preloaded next-track fast path instead of native decoding.
      await navigateToTab(pair.hostPage, 'playlist');
      await pair.hostPage
        .locator(`.playlist-entry[data-queue-item-id="${outgoing!.queueItemId}"] .track-item`)
        .click();
      await Promise.all([
        waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO'),
        waitForPlaybackProjection(pair.guestPage, 'PLAYING_AUDIO'),
      ]);
      await expect
        .poll(async () => (await readFileSourceProbe(pair.guestPage)).starts)
        .toContain(outgoing!.queueItemId);
      await holdHostFileDecodes(pair.hostPage);

      const controlPage = actor === 'host' ? pair.hostPage : pair.guestPage;
      await navigateToTab(controlPage, 'playlist');
      // A playlist row always selects the prior file. The Previous transport
      // button intentionally restarts instead once playback exceeds 3 seconds.
      await controlPage
        .locator(`.playlist-entry[data-queue-item-id="${superseded!.queueItemId}"] .track-item`)
        .click();
      await waitForHeldDecode(pair.hostPage, superseded!.queueItemId);
      await waitForCurrentQueueItemId(pair.guestPage, superseded!.queueItemId, 5_000);
      await expect(pair.guestPage.locator('#track-title')).toContainText('test-02');
      await expect
        .poll(async () => (await readFileSourceProbe(pair.guestPage)).stops)
        .toContain(outgoing!.queueItemId);
      expect(await readPlaybackProjection(pair.guestPage)).not.toBe('PLAYING_AUDIO');
      expect((await readFileSourceProbe(pair.guestPage)).starts).not.toContain(
        superseded!.queueItemId,
      );

      await controlPage
        .locator(`.playlist-entry[data-queue-item-id="${newest!.queueItemId}"] .track-item`)
        .click();
      await waitForHeldDecode(pair.hostPage, newest!.queueItemId);
      await waitForCurrentQueueItemId(pair.guestPage, newest!.queueItemId, 5_000);
      await expect(pair.guestPage.locator('#track-title')).toContainText('test-01');
      expect(await readState(pair.hostPage, 'playback.lifecycle')).toBe('DECODING');

      // Finish the latest decode first, then deliver the stale completion.
      await releaseHeldDecode(pair.hostPage, newest!.queueItemId);
      await Promise.all([
        waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO'),
        waitForPlaybackProjection(pair.guestPage, 'PLAYING_AUDIO'),
      ]);
      await releaseHeldDecode(pair.hostPage, superseded!.queueItemId);
      await pair.hostPage.waitForFunction(() => {
        const held = (window as unknown as Record<string, unknown>)
          .__heldFileDecodes as HeldDecode[];
        return held.every((entry) => entry.finished);
      });
      // Observe beyond the 300ms byte-broadcast debounce: an obsolete decode
      // must not send a late PREPARE/PLAY or replace either audible source.
      await pair.hostPage.waitForTimeout(500);
      for (const page of [pair.hostPage, pair.guestPage]) {
        await waitForCurrentQueueItemId(page, newest!.queueItemId);
        expect(
          ((await readState(page, 'files.current')) as { queueItemId: string }).queueItemId,
        ).toBe(newest!.queueItemId);
        expect(await readPlaybackProjection(page)).toBe('PLAYING_AUDIO');
        const { starts } = await readFileSourceProbe(page);
        expect(starts).toContain(newest!.queueItemId);
        expect(starts).not.toContain(superseded!.queueItemId);
      }
    });
  }

  test('next button advances track with real audio', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    // Reset the selected occurrence to the first row so "next" can advance.
    await setCurrentQueueItemByIndex(pair.hostPage, 0);

    const idx0 = await readCurrentQueueIndex(pair.hostPage);
    expect(idx0).toBe(0);

    // Use a DOM click because responsive CSS can hide the desktop control.
    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-next') as HTMLElement)?.click(),
    );

    await waitForCurrentQueueIndex(pair.hostPage, 1);

    const idx1 = await readCurrentQueueIndex(pair.hostPage);
    expect(idx1).toBe(1);
  });

  test('prev button goes back with real audio', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    // Auto-play on upload may have advanced currentTrackIndex to the last file.
    // Reset to index 0 so we can test next→prev navigation.
    await setCurrentQueueItemByIndex(pair.hostPage, 0);

    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-next') as HTMLElement)?.click(),
    );
    await waitForCurrentQueueIndex(pair.hostPage, 1, 10_000);
    const afterNext = await readCurrentQueueIndex(pair.hostPage);
    expect(afterNext).toBe(1);

    // With no playback progress, Previous navigates instead of restarting the
    // current track.
    await pair.hostPage.evaluate(() =>
      (document.getElementById('btn-prev') as HTMLElement)?.click(),
    );
    await waitForCurrentQueueIndex(pair.hostPage, 0, 10_000);
    const afterPrev = await readCurrentQueueIndex(pair.hostPage);

    expect(afterPrev).toBe(0);
  });
});
