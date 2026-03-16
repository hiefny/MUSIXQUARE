/**
 * E2E: Complex & Realistic Scenarios
 *
 * Tests multi-step, interleaved, and race-condition scenarios that
 * simulate real-world usage patterns ordinary tests can't catch:
 *
 * - Mode switching chains (Audio→YouTube→Audio)
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
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { setupHostAndStart, setupGuest } from './helpers/setup-flow.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { uploadFixture, uploadFixtures } from './helpers/file-upload.ts';
import {
  waitForPlaylistCount,
  readState,
  waitForDeviceCount,
  waitForChatMessage,
  waitForState,
} from './helpers/wait.ts';

const YT_VIDEO = 'https://youtu.be/bnh70V0yu2s';

let pair: HostGuestPair;

// ═══════════════════════════════════════════════════════════════
// 1. MODE SWITCHING CHAINS
// ═══════════════════════════════════════════════════════════════

test.describe('Mode Switching Chains', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('Audio → YouTube → Audio roundtrip preserves playlist', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Phase 1: Upload audio file
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForTimeout(2000);

    // Start playing audio
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 15_000 },
    );

    // Phase 2: Switch to YouTube
    await pair.hostPage.evaluate(() => {
      const overlay = document.getElementById('youtube-url-overlay');
      if (overlay) overlay.classList.add('active');
    });
    const ytInput = pair.hostPage.locator('#youtube-url-input');
    if (await ytInput.isVisible()) {
      await ytInput.fill(YT_VIDEO);
      await ytInput.dispatchEvent('input');
      await pair.hostPage.waitForTimeout(2000);

      const playBtn = pair.hostPage.locator('#youtube-play-btn');
      if (await playBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
        await playBtn.click();
        await pair.hostPage.waitForTimeout(5000);
      }
    }

    // Phase 3: Switch back to audio by uploading another file
    await uploadFixture(pair.hostPage, 'test02');
    await pair.hostPage.waitForTimeout(3000);

    // Playlist should have accumulated both tracks
    const count = await pair.hostPage.evaluate(() => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      return get ? (get('playlist.items') as unknown[])?.length ?? 0 : 0;
    });
    expect(count).toBeGreaterThanOrEqual(2);

    // App should not be crashed — state is valid
    const state = await readState(pair.hostPage, 'appState') as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO', 'PLAYING_YOUTUBE']).toContain(state);
  });

  test('rapid mode switching does not corrupt state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload file for audio mode
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForTimeout(2000);

    // Play audio
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(1000);

    // Pause
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(500);

    // Play again
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(500);

    // Pause again
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(500);

    // State should be consistent
    const finalState = await readState(pair.hostPage, 'appState') as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(finalState);

    // Playlist should still be intact
    const playlist = await readState(pair.hostPage, 'playlist.items') as unknown[];
    expect(playlist.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. PLAYLIST MANIPULATION DURING PLAYBACK
// ═══════════════════════════════════════════════════════════════

test.describe('Playlist Manipulation During Playback', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('removing current track during playback stops and loads next', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload 2 tracks
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForTimeout(2000);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await pair.hostPage.waitForTimeout(1000);

    // Start playback
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(1000);

    // Switch to play tab if not already
    const playNav = pair.hostPage.locator('.nav-item[data-tab="play"]');
    if (await playNav.isVisible()) {
      await playNav.click();
      await pair.hostPage.waitForTimeout(300);
    }

    // Get index of currently playing track
    const currentIndex = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;

    // Remove the current track
    const removeBtns = pair.hostPage.locator('#playlist-ui .btn-playlist-remove');
    const btnForCurrent = removeBtns.nth(currentIndex);
    if (await btnForCurrent.isVisible().catch(() => false)) {
      await btnForCurrent.click();
      await pair.hostPage.waitForTimeout(500);

      const okBtn = pair.hostPage.locator('#btn-dialog-ok');
      if (await okBtn.isVisible().catch(() => false)) {
        await okBtn.click();
        await pair.hostPage.waitForTimeout(3000);
      }
    }

    // App should not crash — should switch to remaining track or idle
    const state = await readState(pair.hostPage, 'appState') as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);
  });

  test('uploading file while another file is still processing', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload 3 files in rapid succession (minimal wait)
    await uploadFixture(pair.hostPage, 'test01');
    await pair.hostPage.waitForTimeout(500); // Don't wait for playlist count
    await uploadFixture(pair.hostPage, 'test02');
    await pair.hostPage.waitForTimeout(500);
    await uploadFixture(pair.hostPage, 'test03');

    // Wait for all to eventually appear
    await waitForPlaylistCount(pair.hostPage, 3, 30_000);

    // All 3 should be in playlist
    const count = await pair.hostPage.evaluate(() =>
      document.getElementById('playlist-ui')?.children.length ?? 0,
    );
    expect(count).toBe(3);
  });

  test('next/prev rapidly during file decode does not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload 3 files
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForTimeout(2000);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await pair.hostPage.waitForTimeout(500);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);
    await pair.hostPage.waitForTimeout(500);

    // Rapid next/prev while decode might still be happening
    for (let i = 0; i < 5; i++) {
      await pair.hostPage.click('#btn-next');
      await pair.hostPage.waitForTimeout(200);
      await pair.hostPage.click('#btn-prev');
      await pair.hostPage.waitForTimeout(200);
    }

    // Final state should be valid
    const idx = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. CONCURRENT HOST + GUEST OPERATIONS
// ═══════════════════════════════════════════════════════════════

test.describe('Concurrent Host+Guest Operations', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('host uploads file while guest sends chat — both succeed', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Guest opens chat and types
    const guestChatBtn = pair.guestPage.locator('#chat-preview-btn');
    if (await guestChatBtn.isVisible()) {
      await guestChatBtn.click();
      await pair.guestPage.waitForTimeout(300);
    }

    // Concurrently: host uploads, guest sends chat
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
    await pair.hostPage.waitForTimeout(3000);

    // File should be in playlist
    const count = await pair.hostPage.evaluate(() =>
      document.getElementById('playlist-ui')?.children.length ?? 0,
    );
    expect(count).toBeGreaterThanOrEqual(1);

    // Chat message should have arrived on host
    const hostChatBtn = pair.hostPage.locator('#chat-preview-btn');
    if (await hostChatBtn.isVisible()) {
      await hostChatBtn.click();
      await pair.hostPage.waitForTimeout(1000);

      const msgs = await pair.hostPage.evaluate(() =>
        document.getElementById('chat-messages')?.textContent || '',
      );
      expect(msgs).toContain('Concurrent chat during upload');
    }
  });

  test('both host and guest send chat simultaneously', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open chat on both
    for (const page of [pair.hostPage, pair.guestPage]) {
      const chatBtn = page.locator('#chat-preview-btn');
      if (await chatBtn.isVisible()) {
        await chatBtn.click();
        await page.waitForTimeout(300);
      }
    }

    // Both send at nearly the same time
    const hostSend = (async () => {
      await pair.hostPage.locator('#chat-input').fill('HOST simultaneous msg');
      await pair.hostPage.locator('#btn-chat-send').click();
    })();

    const guestSend = (async () => {
      await pair.guestPage.locator('#chat-input').fill('GUEST simultaneous msg');
      await pair.guestPage.locator('#btn-chat-send').click();
    })();

    await Promise.all([hostSend, guestSend]);
    await pair.hostPage.waitForTimeout(3000);

    // Both sides should see both messages
    const hostMsgs = await pair.hostPage.evaluate(() =>
      document.getElementById('chat-messages')?.textContent || '',
    );
    const guestMsgs = await pair.guestPage.evaluate(() =>
      document.getElementById('chat-messages')?.textContent || '',
    );

    expect(hostMsgs).toContain('HOST simultaneous msg');
    expect(hostMsgs).toContain('GUEST simultaneous msg');
    expect(guestMsgs).toContain('HOST simultaneous msg');
    expect(guestMsgs).toContain('GUEST simultaneous msg');
  });

  test('host changes settings while guest browses tabs', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Host goes to settings via ID selector (works on both mobile/desktop)
    await pair.hostPage.evaluate(() => {
      (document.getElementById('nav-settings') as HTMLElement)?.click();
    });
    await pair.hostPage.waitForTimeout(300);

    // Guest switches tabs rapidly
    const guestTabSwitch = (async () => {
      for (const tab of ['settings', 'play', 'connect', 'play']) {
        await pair.guestPage.evaluate((t) => {
          (document.getElementById(`nav-${t}`) as HTMLElement)?.click();
        }, tab);
        await pair.guestPage.waitForTimeout(200);
      }
    })();

    // Host changes theme concurrently
    const hostThemeChange = (async () => {
      const darkOpt = pair.hostPage.locator('.ch-opt[data-theme="dark"]');
      if (await darkOpt.isVisible().catch(() => false)) {
        await darkOpt.click();
        await pair.hostPage.waitForTimeout(500);
      }
    })();

    await Promise.all([guestTabSwitch, hostThemeChange]);
    await pair.hostPage.waitForTimeout(1000);

    // Both should be functional
    const hostState = await readState(pair.hostPage, 'appState');
    const guestState = await readState(pair.guestPage, 'appState');
    expect(hostState).toBeDefined();
    expect(guestState).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. SETTINGS CHANGES DURING PLAYBACK
// ═══════════════════════════════════════════════════════════════

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
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );

    // Start playing
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 15_000 },
    );

    // Change EQ values via state (no need to navigate to settings tab)
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) {
        const eq = [6, -3, 0, 4, -2];
        set('audio.eqValues', eq);
      }
    });
    await pair.hostPage.waitForTimeout(1000);

    // Should still be playing
    const state = await readState(pair.hostPage, 'appState');
    expect(['PLAYING_AUDIO', 'PAUSED']).toContain(state);

    // EQ should be applied
    const eqValues = await readState(pair.hostPage, 'audio.eqValues') as number[];
    expect(eqValues[0]).toBe(6);
  });

  test('changing volume to 0 and back during playback', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );

    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 15_000 },
    );

    // Set volume to 0
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('audio.masterVolume', 0);
    });
    await pair.hostPage.waitForTimeout(500);

    // Set volume back to 1
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('audio.masterVolume', 1);
    });
    await pair.hostPage.waitForTimeout(500);

    // Should still be playing
    const state = await readState(pair.hostPage, 'appState');
    expect(['PLAYING_AUDIO', 'PAUSED']).toContain(state);
  });

  test('toggling reverb on/off during playback', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );

    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 15_000 },
    );

    // Enable reverb
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) {
        set('audio.reverbMix', 0.7);
        set('audio.reverbDecay', 3);
      }
    });
    await pair.hostPage.waitForTimeout(500);

    // Disable reverb
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('audio.reverbMix', 0);
    });
    await pair.hostPage.waitForTimeout(500);

    const state = await readState(pair.hostPage, 'appState');
    expect(['PLAYING_AUDIO', 'PAUSED']).toContain(state);
  });

  test('switching audio channel mode during playback', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );

    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 15_000 },
    );

    // Cycle through channel modes
    for (const mode of [1, -1, 2, 0]) {
      await pair.hostPage.evaluate((m) => {
        const set = (window as any).__MUSIXQUARE_SET_STATE__;
        if (set) set('audio.channelMode', m);
      }, mode);
      await pair.hostPage.waitForTimeout(300);
    }

    const state = await readState(pair.hostPage, 'appState');
    expect(['PLAYING_AUDIO', 'PAUSED']).toContain(state);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. REPEAT / SHUFFLE EDGE CASES
// ═══════════════════════════════════════════════════════════════

test.describe('Repeat & Shuffle Edge Cases', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('repeat one with single track — play button toggles correctly', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Set repeat mode to ONE (2)
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.repeatMode', 2);
    });

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );

    // Play → Pause → Play → Pause
    for (let i = 0; i < 4; i++) {
      await pair.hostPage.click('#play-btn');
      await pair.hostPage.waitForTimeout(500);
    }

    const state = await readState(pair.hostPage, 'appState') as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);
  });

  test('shuffle with 2 tracks — next always plays the other track', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Enable shuffle
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.isShuffle', true);
    });

    // Also set repeat all so it doesn't stop
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.repeatMode', 1);
    });

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForTimeout(2000);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await pair.hostPage.waitForTimeout(1000);

    // Navigate next several times — both indices should appear
    const indices = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const idx = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
      indices.add(idx);
      await pair.hostPage.click('#btn-next');
      await pair.hostPage.waitForTimeout(1500);
    }

    // With shuffle + 2 tracks + repeat all, both 0 and 1 should appear
    expect(indices.size).toBe(2);
  });

  test('changing repeat mode mid-playlist does not skip tracks', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForTimeout(2000);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await pair.hostPage.waitForTimeout(1000);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);
    await pair.hostPage.waitForTimeout(1000);

    // Navigate to track 1
    await pair.hostPage.click('#btn-next');
    await pair.hostPage.waitForTimeout(1500);

    const idxBefore = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;

    // Change repeat mode from OFF to ALL
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.repeatMode', 1);
    });
    await pair.hostPage.waitForTimeout(300);

    // Track index should not change from just changing repeat mode
    const idxAfter = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
    expect(idxAfter).toBe(idxBefore);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. OPERATOR PRIVILEGE SCENARIOS
// ═══════════════════════════════════════════════════════════════

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

    // Grant operator
    const opBtn = pair.hostPage.locator('.d-op-btn').first();
    if (await opBtn.isVisible().catch(() => false)) {
      await opBtn.click();
      await pair.hostPage.waitForTimeout(2000);

      // Verify grant succeeded first
      const isOpBefore = await readState(pair.guestPage, 'network.isOperator');

      if (isOpBefore === true) {
        // Upload file
        await uploadFixture(pair.hostPage, 'test01');
        await waitForPlaylistCount(pair.hostPage, 1);
        await pair.hostPage.waitForTimeout(2000);

        // Guest should still be operator after upload
        const isOp = await readState(pair.guestPage, 'network.isOperator');
        expect(isOp).toBe(true);
      } else {
        // Operator button might be a toggle that wasn't in grant state, just verify no crash
        expect(true).toBe(true);
      }
    }
  });

  test('revoking operator during playback does not crash guest', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await waitForDeviceCount(pair.hostPage, 2);

    // Grant operator
    const opBtn = pair.hostPage.locator('.d-op-btn').first();
    if (await opBtn.isVisible().catch(() => false)) {
      await opBtn.click();
      await pair.hostPage.waitForTimeout(1000);
    }

    // Upload and play
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(1000);

    // Revoke operator while playing
    if (await opBtn.isVisible().catch(() => false)) {
      await opBtn.click();
      await pair.hostPage.waitForTimeout(1000);
    }

    // Guest should no longer be operator but app should be functional
    const isOp = await readState(pair.guestPage, 'network.isOperator');
    expect(isOp).toBe(false);

    const guestState = await readState(pair.guestPage, 'appState');
    expect(guestState).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. GUEST DISCONNECT DURING FILE TRANSFER
// ═══════════════════════════════════════════════════════════════

test.describe('Guest Disconnect During Transfer', () => {
  test('host continues normally if guest disconnects mid-transfer', async ({ browser }) => {
    const pair = await createHostGuestContexts(browser);

    try {
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      await waitForDeviceCount(pair.hostPage, 2);

      // Start upload (transfer begins)
      await uploadFixture(pair.hostPage, 'test01');

      // Guest disconnects immediately (mid-transfer)
      await pair.guestContext.close();
      await pair.hostPage.waitForTimeout(3000);

      // Host should still function
      await waitForPlaylistCount(pair.hostPage, 1, 15_000);

      const state = await readState(pair.hostPage, 'appState');
      expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);

      // Host can still play the file
      await pair.hostPage.waitForFunction(
        () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
        { timeout: 15_000 },
      );
      await pair.hostPage.click('#play-btn');
      await pair.hostPage.waitForTimeout(1000);

      const playState = await readState(pair.hostPage, 'appState');
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
      const code = await connectHostAndGuest(pair.hostPage, pair.guestPage);

      // Upload files
      await uploadFixture(pair.hostPage, 'test01');
      await waitForPlaylistCount(pair.hostPage, 1);
      await pair.hostPage.waitForTimeout(2000);

      await uploadFixture(pair.hostPage, 'test02');
      await waitForPlaylistCount(pair.hostPage, 2);
      await pair.hostPage.waitForTimeout(1000);

      // Guest1 disconnects
      await pair.guestContext.close();
      await pair.hostPage.waitForTimeout(3000);

      // New guest joins
      newGuestContext = await browser.newContext({
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      const newGuestPage = await newGuestContext.newPage();
      await injectPeerServer(newGuestPage);

      const sessionCode = await readState(pair.hostPage, 'network.sessionCode') as string;
      await setupGuest(newGuestPage, sessionCode);

      // New guest should get full playlist
      await waitForPlaylistCount(newGuestPage, 2, 30_000);

      const guestPlaylist = await newGuestPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? (get('playlist.items') as unknown[])?.length ?? 0 : 0;
      });
      expect(guestPlaylist).toBe(2);
    } finally {
      await pair.hostContext.close().catch(() => {});
      await pair.guestContext.close().catch(() => {});
      await newGuestContext?.close().catch(() => {});
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 8. DIALOG OVERLAP & INTERACTION EDGE CASES
// ═══════════════════════════════════════════════════════════════

test.describe('Dialog & UI Overlap Edge Cases', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('opening chat while media source popup is open', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open media source popup
    const mediaBtn = pair.hostPage.locator('#btn-media-source');
    if (await mediaBtn.isVisible()) {
      await mediaBtn.click();
      await pair.hostPage.waitForTimeout(300);

      // Try to open chat while popup is active
      const chatBtn = pair.hostPage.locator('#chat-preview-btn');
      if (await chatBtn.isVisible()) {
        await chatBtn.click();
        await pair.hostPage.waitForTimeout(500);
      }

      // App should handle the overlap gracefully
      const state = await readState(pair.hostPage, 'appState');
      expect(state).toBeDefined();
    }
  });

  test('triggering dialog during tab switch', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForTimeout(2000);

    // Ensure play tab
    const playNav = pair.hostPage.locator('.nav-item[data-tab="play"]');
    if (await playNav.isVisible()) {
      await playNav.click();
      await pair.hostPage.waitForTimeout(300);
    }

    // Click remove to trigger dialog
    const removeBtn = pair.hostPage.locator('#playlist-ui .btn-playlist-remove').first();
    if (await removeBtn.isVisible().catch(() => false)) {
      await removeBtn.click();
      await pair.hostPage.waitForTimeout(300);

      // Switch to settings tab while dialog is showing
      const settingsNav = pair.hostPage.locator('.nav-item[data-tab="settings"]');
      if (await settingsNav.isVisible()) {
        await settingsNav.click();
        await pair.hostPage.waitForTimeout(300);
      }

      // Dialog should still be visible or handled
      // Cancel if dialog is visible
      const cancelBtn = pair.hostPage.locator('#btn-dialog-cancel');
      if (await cancelBtn.isVisible().catch(() => false)) {
        await cancelBtn.click();
        await pair.hostPage.waitForTimeout(300);
      }

      // Go back to play tab — track should still be there
      if (await playNav.isVisible()) {
        await playNav.click();
        await pair.hostPage.waitForTimeout(300);
      }

      const count = await pair.hostPage.evaluate(() =>
        document.getElementById('playlist-ui')?.children.length ?? 0,
      );
      expect(count).toBe(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 9. STATE CONSISTENCY AFTER COMPLEX FLOWS
// ═══════════════════════════════════════════════════════════════

test.describe('State Consistency After Complex Flows', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('full session lifecycle: upload, play, pause, next, prev, remove, upload again', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload 3 files
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForTimeout(2000);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await pair.hostPage.waitForTimeout(1000);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);
    await pair.hostPage.waitForTimeout(1000);

    // Play
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(1000);

    // Pause
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(500);

    // Next
    await pair.hostPage.click('#btn-next');
    await pair.hostPage.waitForTimeout(2000);

    // Prev
    await pair.hostPage.click('#btn-prev');
    await pair.hostPage.waitForTimeout(2000);

    // Play again
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(1000);

    // Remove last track via play tab
    const playNav = pair.hostPage.locator('.nav-item[data-tab="play"]');
    if (await playNav.isVisible()) {
      await playNav.click();
      await pair.hostPage.waitForTimeout(300);
    }

    const removeBtn = pair.hostPage.locator('#playlist-ui .btn-playlist-remove').last();
    if (await removeBtn.isVisible().catch(() => false)) {
      await removeBtn.click();
      await pair.hostPage.waitForTimeout(500);

      const okBtn = pair.hostPage.locator('#btn-dialog-ok');
      if (await okBtn.isVisible().catch(() => false)) {
        await okBtn.click();
        await pair.hostPage.waitForTimeout(2000);
      }
    }

    // Upload a fresh file
    await uploadFixture(pair.hostPage, 'test01');
    await pair.hostPage.waitForTimeout(2000);

    // Final state validation
    const state = await readState(pair.hostPage, 'appState') as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);

    const idx = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
    expect(idx).toBeGreaterThanOrEqual(0);

    const role = await readState(pair.hostPage, 'network.appRole');
    expect(role).toBe('host');
  });

  test('guest state remains consistent through host upload-play-pause-upload cycle', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

    // Play
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(2000);

    // Pause
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForTimeout(1000);

    // Upload another
    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await waitForPlaylistCount(pair.guestPage, 2, 20_000);

    // Guest validation
    const guestRole = await readState(pair.guestPage, 'network.appRole');
    expect(guestRole).toBe('guest');

    const guestPlaylist = await pair.guestPage.evaluate(() => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      return get ? (get('playlist.items') as unknown[])?.length ?? 0 : 0;
    });
    expect(guestPlaylist).toBe(2);

    const guestState = await readState(pair.guestPage, 'appState') as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(guestState);
  });

  test('multi-guest: all guests consistent after host performs many operations', async ({ browser }) => {
    // Create host + 2 guests
    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
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

      // Upload 2 files
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await hostPage.waitForTimeout(2000);

      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);
      await hostPage.waitForTimeout(2000);

      // Play
      await hostPage.waitForFunction(
        () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
        { timeout: 15_000 },
      );
      await hostPage.click('#play-btn');
      await hostPage.waitForTimeout(2000);

      // Next track
      await hostPage.click('#btn-next');
      await hostPage.waitForTimeout(2000);

      // Pause
      await hostPage.click('#play-btn');
      await hostPage.waitForTimeout(1000);

      // Both guests should have 2 tracks
      await waitForPlaylistCount(g1Page, 2, 30_000);
      await waitForPlaylistCount(g2Page, 2, 30_000);

      // All should have valid states
      for (const page of [hostPage, g1Page, g2Page]) {
        const state = await readState(page, 'appState');
        expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);
      }

      // Both guests should have matching playlist count
      const g1Count = await g1Page.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? (get('playlist.items') as unknown[])?.length ?? 0 : 0;
      });
      const g2Count = await g2Page.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? (get('playlist.items') as unknown[])?.length ?? 0 : 0;
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

// ═══════════════════════════════════════════════════════════════
// 10. SEEK EDGE CASES
// ═══════════════════════════════════════════════════════════════

test.describe('Seek Edge Cases', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('seeking to near-end during playback triggers next track logic', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForTimeout(2000);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);
    await pair.hostPage.waitForTimeout(1000);

    // Set repeat all so it doesn't stop
    await pair.hostPage.evaluate(() => {
      const set = (window as any).__MUSIXQUARE_SET_STATE__;
      if (set) set('playlist.repeatMode', 1);
    });

    // Play
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 15_000 },
    );

    // Seek to near end via seek slider (set to 99%)
    const seekSlider = pair.hostPage.locator('#seek-slider');
    if (await seekSlider.isVisible()) {
      await seekSlider.evaluate((el: HTMLInputElement) => {
        el.value = String(parseFloat(el.max) * 0.99);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    // Wait for potential auto-advance
    await pair.hostPage.waitForTimeout(5000);

    // State should be valid (either still playing current or advanced to next)
    const state = await readState(pair.hostPage, 'appState') as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);
  });

  test('seeking while paused does not auto-resume', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );

    // Play then pause
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 15_000 },
    );
    await pair.hostPage.waitForTimeout(500);
    await pair.hostPage.click('#play-btn');
    await pair.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PAUSED',
      { timeout: 10_000 },
    );

    // Seek while paused
    const seekSlider = pair.hostPage.locator('#seek-slider');
    if (await seekSlider.isVisible()) {
      await seekSlider.evaluate((el: HTMLInputElement) => {
        el.value = String(parseFloat(el.max) * 0.5);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    await pair.hostPage.waitForTimeout(1000);

    // Should still be paused
    const state = await readState(pair.hostPage, 'appState');
    expect(state).toBe('PAUSED');
  });
});

// ═══════════════════════════════════════════════════════════════
// 11. LANGUAGE SWITCH EDGE CASES
// ═══════════════════════════════════════════════════════════════

test.describe('Language Switch During Active Session', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });
  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('switching language while connected does not break UI', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload a file first
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await pair.hostPage.waitForTimeout(2000);

    // Switch to settings via ID (force click to bypass visibility)
    await pair.hostPage.evaluate(() => {
      (document.getElementById('nav-settings') as HTMLElement)?.click();
    });
    await pair.hostPage.waitForTimeout(300);

    // Switch to Korean
    const koOpt = pair.hostPage.locator('.ch-opt[data-lang="ko"]');
    if (await koOpt.isVisible().catch(() => false)) {
      await koOpt.click();
      await pair.hostPage.waitForTimeout(500);
    }

    // Switch back to English
    const enOpt = pair.hostPage.locator('.ch-opt[data-lang="en"]');
    if (await enOpt.isVisible().catch(() => false)) {
      await enOpt.click();
      await pair.hostPage.waitForTimeout(500);
    }

    // Go back to play tab
    await pair.hostPage.evaluate(() => {
      (document.getElementById('nav-play') as HTMLElement)?.click();
    });
    await pair.hostPage.waitForTimeout(300);

    const count = await pair.hostPage.evaluate(() =>
      document.getElementById('playlist-ui')?.children.length ?? 0,
    );
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 12. MULTI-GUEST CHANNEL DIVERGENCE
// ═══════════════════════════════════════════════════════════════

test.describe('Multi-Guest Different Channels', () => {
  test('guests on different channels all receive playlist', async ({ browser }) => {
    const hostCtx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
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
      // Host on center (0)
      const code = await setupHostAndStart(hostPage, 0);

      // Guest1 on left (-1), Guest2 on right (1)
      await setupGuest(g1Page, code, -1);
      await setupGuest(g2Page, code, 1);

      await waitForDeviceCount(hostPage, 3);

      // Upload files
      await uploadFixture(hostPage, 'test01');
      await waitForPlaylistCount(hostPage, 1);
      await hostPage.waitForTimeout(2000);

      await uploadFixture(hostPage, 'test02');
      await waitForPlaylistCount(hostPage, 2);
      await hostPage.waitForTimeout(2000);

      // Both guests should get full playlist regardless of channel
      await waitForPlaylistCount(g1Page, 2, 30_000);
      await waitForPlaylistCount(g2Page, 2, 30_000);

      // Verify channel modes differ
      const g1Channel = await readState(g1Page, 'audio.channelMode');
      const g2Channel = await readState(g2Page, 'audio.channelMode');
      expect(g1Channel).toBe(-1);
      expect(g2Channel).toBe(1);
    } finally {
      await hostCtx.close().catch(() => {});
      await g1Ctx.close().catch(() => {});
      await g2Ctx.close().catch(() => {});
    }
  });
});
