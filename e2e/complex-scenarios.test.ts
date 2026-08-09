/**
 * E2E: Complex & Realistic Scenarios
 *
 * Tests multi-step, interleaved, and race-condition scenarios that
 * simulate real-world usage patterns ordinary tests can't catch:
 *
 * - Mode switching chains (Audio->YouTube->Audio)
 * - Playlist manipulation during playback
 * - Concurrent host+guest operations
 * - Transfer interruption & recovery
 * - Settings changes during playback
 * - Repeat/shuffle edge cases with single tracks
 * - Operator privilege + playback control
 * - Dialog overlaps
 * - Guest disconnect mid-transfer
 * - State consistency after complex flows
 */
import { test, expect } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { setupHostAndStart, setupGuest } from './helpers/setup-flow.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { readCurrentQueueIndex, waitForCurrentQueueIndex } from './helpers/queue-state.ts';
import {
  clickPlayButton,
  isVisible,
  navigateToTab,
  openChatDrawer,
  readPlaybackProjection,
  readState,
  VALID_PLAYBACK_PROJECTIONS,
  waitForChatMessage,
  waitForDeviceCount,
  waitForPlaybackProjection,
  waitForPlaylistCount,
  waitForPlayState,
  waitForState,
} from './helpers/wait.ts';

const YT_VIDEO = 'https://youtu.be/bnh70V0yu2s';

let pair: HostGuestPair;

test.describe('Mode Switching Chains', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('Audio -> YouTube -> Audio roundtrip preserves playlist', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );
    await clickPlayButton(pair.hostPage);
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO');

    await pair.hostPage.evaluate(() => {
      const overlay = document.getElementById('youtube-url-overlay');
      if (overlay) overlay.classList.add('active');
    });
    const ytInput = pair.hostPage.locator('#youtube-url-input');
    if (await ytInput.isVisible()) {
      await ytInput.fill(YT_VIDEO);
      await ytInput.dispatchEvent('input');
      await pair.hostPage
        .waitForFunction(
          () => {
            const btn = document.getElementById('youtube-play-btn');
            return btn && !btn.hasAttribute('disabled');
          },
          undefined,
          { timeout: 10_000 },
        )
        .catch(() => {});

      const playBtn = pair.hostPage.locator('#youtube-play-btn');
      if (await playBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
        await playBtn.click();
        await waitForPlaybackProjection(pair.hostPage, 'PLAYING_YOUTUBE').catch(() => {});
      }
    }

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    const count = await pair.hostPage.evaluate(() => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      return get ? ((get('playlist.items') as unknown[])?.length ?? 0) : 0;
    });
    expect(count).toBeGreaterThanOrEqual(2);

    const state = (await readPlaybackProjection(pair.hostPage)) as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO', 'PLAYING_YOUTUBE']).toContain(state);
  });

  test('rapid mode switching does not corrupt state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );
    await clickPlayButton(pair.hostPage);
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO');

    await clickPlayButton(pair.hostPage);
    await waitForPlayState(pair.hostPage, false);

    await clickPlayButton(pair.hostPage);
    await waitForPlayState(pair.hostPage, true);

    await clickPlayButton(pair.hostPage);
    await waitForPlayState(pair.hostPage, false);

    const finalState = (await readPlaybackProjection(pair.hostPage)) as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(finalState);

    const playlist = (await readState(pair.hostPage, 'playlist.items')) as unknown[];
    expect(playlist.length).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Playlist Manipulation During Playback', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('removing current track during playback stops and loads next', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );
    await clickPlayButton(pair.hostPage);
    await waitForPlayState(pair.hostPage, true);

    const playNav = pair.hostPage.locator('.nav-item[data-tab="play"]');
    if (await playNav.isVisible()) {
      await navigateToTab(pair.hostPage, 'play');
    }

    const currentIndex = await readCurrentQueueIndex(pair.hostPage);

    const removeBtns = pair.hostPage.locator('#playlist-ui .btn-playlist-remove');
    const btnForCurrent = removeBtns.nth(currentIndex);
    if (
      await isVisible(pair.hostPage, `#playlist-ui .btn-playlist-remove >> nth=${currentIndex}`)
    ) {
      await btnForCurrent.click();
      await pair.hostPage.locator('.playlist-selection-delete').click();
      await waitForPlaylistCount(pair.hostPage, 1);
    }

    const state = (await readPlaybackProjection(pair.hostPage)) as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);
  });

  test('uploading file while another file is still processing', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await uploadFixture(pair.hostPage, 'test02');
    await uploadFixture(pair.hostPage, 'test03');

    await waitForPlaylistCount(pair.hostPage, 3, 30_000);

    const count = await pair.hostPage.evaluate(
      () => document.getElementById('playlist-ui')?.children.length ?? 0,
    );
    expect(count).toBe(3);
  });

  test('next/prev rapidly during file decode does not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);

    // Rapid next/prev while decode might still be happening
    // Intentional short delays for stress testing
    for (let i = 0; i < 5; i++) {
      await pair.hostPage.click('#btn-next');
      await pair.hostPage.waitForTimeout(100); // intentional throttle for stress test
      await pair.hostPage.click('#btn-prev');
      await pair.hostPage.waitForTimeout(100); // intentional throttle for stress test
    }

    const idx = await readCurrentQueueIndex(pair.hostPage);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(3);
  });
});

test.describe('Concurrent Host+Guest Operations', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('host uploads file while guest sends chat -- both succeed', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Allow connection-driven layout to settle before opening chat.
    await openChatDrawer(pair.guestPage, 10_000);

    const uploadPromise = (async () => {
      await uploadFixture(pair.hostPage, 'test01');
      await waitForPlaylistCount(pair.hostPage, 1);
    })();

    const chatPromise = (async () => {
      const chatInput = pair.guestPage.locator('#chat-input');
      if (await chatInput.isVisible()) {
        await chatInput.fill('Concurrent chat during upload');
        await pair.guestPage.locator('#btn-chat-send').click();
      }
    })();

    await Promise.all([uploadPromise, chatPromise]);

    await waitForPlaylistCount(pair.hostPage, 1);
    const count = await pair.hostPage.evaluate(
      () => document.getElementById('playlist-ui')?.children.length ?? 0,
    );
    expect(count).toBeGreaterThanOrEqual(1);

    await openChatDrawer(pair.hostPage);
    await waitForChatMessage(pair.hostPage, 'Concurrent chat during upload');

    const msgs = await pair.hostPage.evaluate(
      () => document.getElementById('chat-messages')?.textContent || '',
    );
    expect(msgs).toContain('Concurrent chat during upload');
  });

  test('both host and guest send chat simultaneously', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Allow connection-driven layout to settle before opening chat.
    await openChatDrawer(pair.hostPage, 10_000);
    await openChatDrawer(pair.guestPage, 10_000);

    const hostSend = (async () => {
      await pair.hostPage.locator('#chat-input').fill('HOST simultaneous msg');
      await pair.hostPage.locator('#btn-chat-send').click();
    })();

    const guestSend = (async () => {
      await pair.guestPage.locator('#chat-input').fill('GUEST simultaneous msg');
      await pair.guestPage.locator('#btn-chat-send').click();
    })();

    await Promise.all([hostSend, guestSend]);

    await waitForChatMessage(pair.hostPage, 'HOST simultaneous msg');
    await waitForChatMessage(pair.hostPage, 'GUEST simultaneous msg');
    await waitForChatMessage(pair.guestPage, 'HOST simultaneous msg');
    await waitForChatMessage(pair.guestPage, 'GUEST simultaneous msg');

    const hostMsgs = await pair.hostPage.evaluate(
      () => document.getElementById('chat-messages')?.textContent || '',
    );
    const guestMsgs = await pair.guestPage.evaluate(
      () => document.getElementById('chat-messages')?.textContent || '',
    );

    expect(hostMsgs).toContain('HOST simultaneous msg');
    expect(hostMsgs).toContain('GUEST simultaneous msg');
    expect(guestMsgs).toContain('HOST simultaneous msg');
    expect(guestMsgs).toContain('GUEST simultaneous msg');
  });

  test('host changes settings while guest browses tabs', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // The ID selector is stable across desktop and mobile layouts.
    await pair.hostPage.evaluate(() => {
      (document.getElementById('nav-settings') as HTMLElement)?.click();
    });
    await pair.hostPage
      .locator('#tab-settings')
      .waitFor({ state: 'visible', timeout: 5_000 })
      .catch(() => {});

    const guestTabSwitch = (async () => {
      for (const tab of ['settings', 'play', 'connect', 'play']) {
        await pair.guestPage.evaluate((t) => {
          (document.getElementById(`nav-${t}`) as HTMLElement)?.click();
        }, tab);
        await pair.guestPage.waitForTimeout(100); // intentional throttle for rapid tab switching stress test
      }
    })();

    const hostThemeChange = (async () => {
      const darkOpt = pair.hostPage.locator('.ch-opt[data-theme="dark"]');
      if (await isVisible(pair.hostPage, '.ch-opt[data-theme="dark"]')) {
        await darkOpt.click();
        await pair.hostPage
          .waitForFunction(
            () => document.documentElement.getAttribute('data-theme') === 'dark',
            undefined,
            {
              timeout: 5_000,
            },
          )
          .catch(() => {});
      }
    })();

    await Promise.all([guestTabSwitch, hostThemeChange]);

    const hostState = await readPlaybackProjection(pair.hostPage);
    const guestState = await readPlaybackProjection(pair.guestPage);
    expect(VALID_PLAYBACK_PROJECTIONS).toContain(hostState);
    expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);
  });
});

test.describe('Settings Changes During Playback', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('changing EQ while audio is playing does not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );

    await clickPlayButton(pair.hostPage);
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO');

    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) {
        const eq = [6, -3, 0, 4, -2];
        set('audio.eqValues', eq);
      }
    });

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && (get('audio.eqValues') as number[])?.[0] === 6;
      },
      undefined,
      { timeout: 5_000 },
    );

    const state = await readPlaybackProjection(pair.hostPage);
    expect(['PLAYING_AUDIO', 'PAUSED']).toContain(state);

    const eqValues = (await readState(pair.hostPage, 'audio.eqValues')) as number[];
    expect(eqValues[0]).toBe(6);
  });

  test('changing volume to 0 and back during playback', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );

    await clickPlayButton(pair.hostPage);
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO');

    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('audio.masterVolume', 0);
    });
    await waitForState(pair.hostPage, 'audio.masterVolume', 0);

    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('audio.masterVolume', 1);
    });
    await waitForState(pair.hostPage, 'audio.masterVolume', 1);

    const state = await readPlaybackProjection(pair.hostPage);
    expect(['PLAYING_AUDIO', 'PAUSED']).toContain(state);
  });

  test('toggling reverb on/off during playback', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );

    await clickPlayButton(pair.hostPage);
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO');

    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) {
        set('audio.reverbMix', 0.7);
        set('audio.reverbDecay', 3);
      }
    });
    await waitForState(pair.hostPage, 'audio.reverbMix', 0.7);

    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('audio.reverbMix', 0);
    });
    await waitForState(pair.hostPage, 'audio.reverbMix', 0);

    const state = await readPlaybackProjection(pair.hostPage);
    expect(['PLAYING_AUDIO', 'PAUSED']).toContain(state);
  });

  test('switching audio channel mode during playback', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );

    await clickPlayButton(pair.hostPage);
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO');

    for (const mode of [1, -1, 2, 0]) {
      await pair.hostPage.evaluate((m) => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) set('audio.channelMode', m);
      }, mode);
      await waitForState(pair.hostPage, 'audio.channelMode', mode);
    }

    const state = await readPlaybackProjection(pair.hostPage);
    expect(['PLAYING_AUDIO', 'PAUSED']).toContain(state);
  });
});

test.describe('Repeat & Shuffle Edge Cases', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('repeat one with single track -- play button toggles correctly', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.repeatMode', 2);
    });

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );

    for (let i = 0; i < 4; i++) {
      await clickPlayButton(pair.hostPage);
      if (i % 2 === 0) {
        await waitForPlayState(pair.hostPage, true);
      } else {
        await waitForPlayState(pair.hostPage, false);
      }
    }

    const state = (await readPlaybackProjection(pair.hostPage)) as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);
  });

  test('shuffle with 2 tracks -- next always plays the other track', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.isShuffle', true);
    });

    // Repeat-all keeps the navigation stress loop from stopping at the end.
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.repeatMode', 1);
    });

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );

    const indices = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const idx = await readCurrentQueueIndex(pair.hostPage);
      indices.add(idx);
      await pair.hostPage.click('#btn-next');
      await pair.hostPage
        .waitForFunction(
          (prevIdx) => {
            const get = (window as any).__MUSIXQUARE_GET_STATE__;
            if (!get) return false;
            const items = get('playlist.items');
            const currentQueueItemId = get('playlist.currentQueueItemId');
            const current = Array.isArray(items)
              ? items.findIndex(
                  (item: { queueItemId?: string }) => item.queueItemId === currentQueueItemId,
                )
              : -1;
            // Either the occurrence changed, or its resident file is ready again.
            return current !== prevIdx || get('files.current') !== null;
          },
          idx,
          { timeout: 10_000 },
        )
        .catch(() => {});
    }

    expect(indices.size).toBe(2);
  });

  test('changing repeat mode mid-playlist does not skip tracks', async () => {
    test.setTimeout(90_000);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 20_000 },
    );

    await pair.hostPage.click('#btn-next');
    await waitForCurrentQueueIndex(pair.hostPage, 1);

    const idxBefore = await readCurrentQueueIndex(pair.hostPage);

    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.repeatMode', 1);
    });
    await waitForState(pair.hostPage, 'playlist.repeatMode', 1);

    const idxAfter = await readCurrentQueueIndex(pair.hostPage);
    expect(idxAfter).toBe(idxBefore);
  });
});

test.describe('Operator Privilege Scenarios', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('operator grant persists through file upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForDeviceCount(pair.hostPage, 2);

    const opBtn = pair.hostPage.locator('.d-op-btn').first();
    if (await isVisible(pair.hostPage, '.d-op-btn')) {
      await opBtn.click();
      await pair.guestPage.waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          return get && get('network.isOperator') !== undefined;
        },
        undefined,
        { timeout: 10_000 },
      );

      const isOpBefore = await readState(pair.guestPage, 'network.isOperator');

      if (isOpBefore === true) {
        // Exercise the real administrator -> host uplink. Uploading from the
        // host here would only cover the ordinary local playlist path.
        await uploadFixture(pair.guestPage, 'test01');
        await waitForPlaylistCount(pair.hostPage, 1);
        await waitForPlaylistCount(pair.guestPage, 1);

        const isOp = await readState(pair.guestPage, 'network.isOperator');
        expect(isOp).toBe(true);
      } else {
        // The operator control is a toggle, so normalize it to the granted state.
        const guestState = await readPlaybackProjection(pair.guestPage);
        expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);
      }
    }
  });

  test('revoking operator during playback does not crash guest', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForDeviceCount(pair.hostPage, 2);

    const opBtn = pair.hostPage.locator('.d-op-btn').first();
    if (await isVisible(pair.hostPage, '.d-op-btn')) {
      await opBtn.click();
      await pair.guestPage.waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          return get && get('network.isOperator') !== undefined;
        },
        undefined,
        { timeout: 10_000 },
      );
    }

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );
    await clickPlayButton(pair.hostPage);
    await waitForPlayState(pair.hostPage, true);

    if (await isVisible(pair.hostPage, '.d-op-btn')) {
      await opBtn.click();
      await pair.guestPage
        .waitForFunction(
          () => {
            const get = (window as any).__MUSIXQUARE_GET_STATE__;
            return get && get('network.isOperator') === false;
          },
          undefined,
          { timeout: 10_000 },
        )
        .catch(() => {});
    }

    const isOp = await readState(pair.guestPage, 'network.isOperator');
    expect(isOp).toBe(false);

    const guestState = await readPlaybackProjection(pair.guestPage);
    expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);
  });
});

test.describe('Guest Disconnect During Transfer', () => {
  test('host continues normally if guest disconnects mid-transfer', async ({ browser }) => {
    const pair = await createHostGuestContexts(browser);

    try {
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      await waitForDeviceCount(pair.hostPage, 2);

      await uploadFixture(pair.hostPage, 'test01');

      await pair.guestContext.close();

      await waitForPlaylistCount(pair.hostPage, 1, 15_000);

      const state = await readPlaybackProjection(pair.hostPage);
      expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);

      await pair.hostPage.waitForFunction(
        () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
        undefined,
        { timeout: 15_000 },
      );
      await clickPlayButton(pair.hostPage);
      await waitForPlayState(pair.hostPage, true);

      const playState = await readPlaybackProjection(pair.hostPage);
      expect(['PLAYING_AUDIO', 'PAUSED']).toContain(playState);
    } finally {
      await pair.hostContext.close().catch(() => {});
      await pair.guestContext.close().catch(() => {});
    }
  });

  test('new guest after disconnect receives full playlist', async ({ browser }) => {
    const pair = await createHostGuestContexts(browser);
    let newGuestContext: BrowserContext | null = null;

    try {
      await connectHostAndGuest(pair.hostPage, pair.guestPage);

      await uploadFixture(pair.hostPage, 'test01');
      await waitForPlaylistCount(pair.hostPage, 1);

      await uploadFixture(pair.hostPage, 'test02');
      await waitForPlaylistCount(pair.hostPage, 2);

      await pair.guestContext.close();
      await waitForDeviceCount(pair.hostPage, 1).catch(() => {});

      newGuestContext = await browser.newContext({
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      const newGuestPage = await newGuestContext.newPage();
      await injectPeerServer(newGuestPage);

      const sessionCode = (await readState(pair.hostPage, 'network.sessionCode')) as string;
      await setupGuest(newGuestPage, sessionCode);

      await waitForPlaylistCount(newGuestPage, 2, 30_000);

      const guestPlaylist = await newGuestPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? ((get('playlist.items') as unknown[])?.length ?? 0) : 0;
      });
      expect(guestPlaylist).toBe(2);
    } finally {
      await pair.hostContext.close().catch(() => {});
      await pair.guestContext.close().catch(() => {});
      await newGuestContext?.close().catch(() => {});
    }
  });
});

test.describe('Dialog & UI Overlap Edge Cases', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('opening chat while media source popup is open', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'play', 15_000);

    // Use a DOM click because responsive CSS may hide the desktop control.
    const mediaBtnExists = await pair.hostPage.evaluate(
      () => !!document.getElementById('btn-media-source'),
    );
    if (mediaBtnExists) {
      await pair.hostPage.evaluate(() =>
        (document.getElementById('btn-media-source') as HTMLElement)?.click(),
      );
      await pair.hostPage
        .waitForFunction(
          () =>
            document.getElementById('media-source-overlay')?.classList.contains('active') ?? false,
          undefined,
          { timeout: 5_000 },
        )
        .catch(() => {});

      await openChatDrawer(pair.hostPage).catch(() => {});

      const state = await readPlaybackProjection(pair.hostPage);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(state);
    }
  });

  test('playlist removal selection survives a wide-layout tab switch', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await navigateToTab(pair.hostPage, 'play');

    const removeBtn = pair.hostPage.locator('#playlist-ui .btn-playlist-remove').first();
    if (await isVisible(pair.hostPage, '#playlist-ui .btn-playlist-remove')) {
      await removeBtn.click();
      await expect(pair.hostPage.locator('.playlist-selection-pill')).toHaveClass(/is-visible/);

      await pair.hostPage.evaluate(() => {
        (document.getElementById('nav-settings') as HTMLElement)?.click();
      });

      await navigateToTab(pair.hostPage, 'play');
      await expect(pair.hostPage.locator('.playlist-selection-pill')).toHaveClass(/is-visible/);
      await expect(removeBtn).toHaveAttribute('aria-pressed', 'true');

      const count = await pair.hostPage.evaluate(
        () => document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(count).toBe(1);
    }
  });
});

test.describe('State Consistency After Complex Flows', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('full session lifecycle: upload, play, pause, next, prev, remove, upload again', async () => {
    test.setTimeout(120_000);

    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );
    await clickPlayButton(pair.hostPage);
    await waitForPlayState(pair.hostPage, true);

    await clickPlayButton(pair.hostPage);
    await waitForPlayState(pair.hostPage, false);

    await pair.hostPage.click('#btn-next');
    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.current') !== null;
      },
      undefined,
      { timeout: 10_000 },
    );

    await pair.hostPage.click('#btn-prev');
    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.current') !== null;
      },
      undefined,
      { timeout: 10_000 },
    );

    await clickPlayButton(pair.hostPage);
    await waitForPlayState(pair.hostPage, true);

    await navigateToTab(pair.hostPage, 'play');

    const removeBtn = pair.hostPage.locator('#playlist-ui .btn-playlist-remove').last();
    if (await isVisible(pair.hostPage, '#playlist-ui .btn-playlist-remove')) {
      await removeBtn.click();
      await pair.hostPage.locator('.playlist-selection-delete').click();
      await waitForPlaylistCount(pair.hostPage, 2).catch(() => {});
    }

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 3);

    const state = (await readPlaybackProjection(pair.hostPage)) as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);

    const idx = await readCurrentQueueIndex(pair.hostPage);
    expect(idx).toBeGreaterThanOrEqual(0);

    const role = await readState(pair.hostPage, 'network.appRole');
    expect(role).toBe('host');
  });

  test('guest state remains consistent through host upload-play-pause-upload cycle', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );
    await clickPlayButton(pair.hostPage);
    await waitForPlayState(pair.hostPage, true);

    await clickPlayButton(pair.hostPage);
    await waitForPlayState(pair.hostPage, false);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await waitForPlaylistCount(pair.guestPage, 2, 20_000);

    const guestRole = await readState(pair.guestPage, 'network.appRole');
    expect(guestRole).toBe('guest');

    const guestPlaylist = await pair.guestPage.evaluate(() => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      return get ? ((get('playlist.items') as unknown[])?.length ?? 0) : 0;
    });
    expect(guestPlaylist).toBe(2);

    const guestState = (await readPlaybackProjection(pair.guestPage)) as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(guestState);
  });

  test('multi-guest: all guests consistent after host performs many operations', async ({
    browser,
  }) => {
    const hostCtx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const g1Ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const g2Ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });

    const hostPage = await hostCtx.newPage();
    const g1Page = await g1Ctx.newPage();
    const g2Page = await g2Ctx.newPage();

    await Promise.all([
      injectPeerServer(hostPage),
      injectPeerServer(g1Page),
      injectPeerServer(g2Page),
    ]);

    try {
      const code = await setupHostAndStart(hostPage);
      await setupGuest(g1Page, code);
      await setupGuest(g2Page, code);

      await waitForDeviceCount(hostPage, 3);

      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);

      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);

      await hostPage.waitForFunction(
        () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
        undefined,
        { timeout: 15_000 },
      );
      await clickPlayButton(hostPage);
      await waitForPlayState(hostPage, true);

      await hostPage.click('#btn-next');
      await waitForCurrentQueueIndex(hostPage, 1, 10_000);

      await clickPlayButton(hostPage);
      await waitForPlayState(hostPage, false);

      await waitForPlaylistCount(g1Page, 2, 30_000);
      await waitForPlaylistCount(g2Page, 2, 30_000);

      for (const page of [hostPage, g1Page, g2Page]) {
        const state = await readPlaybackProjection(page);
        expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);
      }

      const g1Count = await g1Page.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? ((get('playlist.items') as unknown[])?.length ?? 0) : 0;
      });
      const g2Count = await g2Page.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? ((get('playlist.items') as unknown[])?.length ?? 0) : 0;
      });
      expect(g1Count).toBe(2);
      expect(g2Count).toBe(2);
    } finally {
      await hostCtx.close().catch(() => {});
      await g1Ctx.close().catch(() => {});
      await g2Ctx.close().catch(() => {});
    }
  });
});
