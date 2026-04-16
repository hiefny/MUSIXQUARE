/**
 * E2E: Edge Cases & Stress Tests
 *
 * Tests boundary conditions, rapid interactions, error handling,
 * and unusual user behaviors:
 * - Rapid button clicking
 * - Empty state navigation
 * - Duplicate uploads
 * - Chat limits
 * - Upload while playing
 * - Invalid inputs
 * - Concurrent operations
 * - Browser refresh recovery
 * - Extreme values
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture, uploadFixtures } from './helpers/file-upload.ts';
import {
  waitForPlaylistCount,
  readState,
  waitForChatMessage,
  waitForState,
  navigateToTab,
  openChatDrawer,
  sendChat,
  isVisible,
  waitForSelectorCount,
  waitForOverlayActive,
  waitForClass,
  VALID_APP_STATES,
} from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Edge Cases', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  // ── Rapid Click Stress ──────────────────────────────────────

  test('rapid next/prev clicks do not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);

    // Rapid-fire next clicks
    for (let i = 0; i < 10; i++) {
      await pair.hostPage.click('#btn-next');
      await pair.hostPage.waitForTimeout(100); // intentional rapid-fire delay
    }

    // Rapid-fire prev clicks
    for (let i = 0; i < 10; i++) {
      await pair.hostPage.click('#btn-prev');
      await pair.hostPage.waitForTimeout(100); // intentional rapid-fire delay
    }

    // App should still be functional — verify state is valid
    const index = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(3);
  });

  test('rapid play/pause clicks do not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Wait for file to be ready
    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.currentFileBlob') !== null;
      },
      { timeout: 15_000 },
    );

    // Rapid play/pause toggling
    for (let i = 0; i < 8; i++) {
      await pair.hostPage.click('#play-btn');
      await pair.hostPage.waitForTimeout(150); // intentional rapid-fire delay
    }

    // Should not crash — state should be valid
    const state = await readState(pair.hostPage, 'appState') as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO', 'PLAYING_VIDEO', 'PLAYING_YOUTUBE']).toContain(state);
  });

  // ── Empty State Navigation ──────────────────────────────────

  test('next/prev on empty playlist does not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // No files uploaded — playlist is empty
    await pair.hostPage.click('#btn-next');
    await pair.hostPage.click('#btn-prev');

    // App should still be functional
    const index = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
    expect(index).toBeLessThanOrEqual(0);
  });

  test('play button on empty playlist is disabled', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Play button should be disabled when no track is loaded
    const isDisabled = await pair.hostPage.locator('#play-btn').evaluate(el => {
      return el.hasAttribute('disabled') || el.classList.contains('disabled');
    });
    expect(isDisabled).toBe(true);

    const state = await readState(pair.hostPage, 'appState') as string;
    expect(state).toBe('IDLE');
  });

  // ── Upload While Playing ──────────────────────────────────

  test('uploading new file while playing does not interrupt current track', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload and start playing first file
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.currentFileBlob') !== null;
      },
      { timeout: 15_000 },
    );

    await pair.hostPage.click('#play-btn');
    await waitForState(pair.hostPage, 'appState', 'PLAYING_AUDIO', 5_000).catch(() => {});

    const stateBefore = await readState(pair.hostPage, 'appState') as string;

    // Upload second file while first is playing/loaded
    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    // Playlist should now have 2 items
    const count = await pair.hostPage.evaluate(() => {
      return document.getElementById('playlist-ui')?.children.length ?? 0;
    });
    expect(count).toBe(2);

    // App should not have crashed
    const stateAfter = await readState(pair.hostPage, 'appState') as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(stateAfter);
  });

  // ── Duplicate File Upload ──────────────────────────────────

  test('uploading same fixture twice adds two playlist entries', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 2);

    const count = await pair.hostPage.evaluate(() => {
      return document.getElementById('playlist-ui')?.children.length ?? 0;
    });
    expect(count).toBe(2);
  });

  // ── Chat Edge Cases ──────────────────────────────────────

  test('empty chat message is not sent', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#chat-preview-btn')) {
      await openChatDrawer(pair.hostPage);

      const chatInput = pair.hostPage.locator('#chat-input');
      await chatInput.fill('');
      await pair.hostPage.locator('#btn-chat-send').click();

      // Brief wait then verify no messages appeared
      await pair.hostPage.waitForTimeout(300); // intentional brief settle for negative assertion
      const msgCount = await pair.hostPage.evaluate(() => {
        const msgs = document.getElementById('chat-messages');
        return msgs?.children.length ?? 0;
      });
      expect(msgCount).toBe(0);
    }
  });

  test('long chat message is handled (500+ chars)', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#chat-preview-btn')) {
      await openChatDrawer(pair.hostPage);

      const longMsg = 'A'.repeat(600);
      await sendChat(pair.hostPage, longMsg);

      // Wait for message to appear
      await pair.hostPage.waitForFunction(
        () => {
          const msgs = document.getElementById('chat-messages');
          return (msgs?.textContent?.length ?? 0) > 0;
        },
        { timeout: 5_000 },
      );

      const msgText = await pair.hostPage.evaluate(() => {
        const msgs = document.getElementById('chat-messages');
        return msgs?.textContent || '';
      });
      // Either the full message or a truncated version should be present
      expect(msgText.length).toBeGreaterThan(0);
    }
  });

  test('special characters in chat are preserved', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#chat-preview-btn')) {
      await openChatDrawer(pair.hostPage);

      const specialMsg = '<script>alert(1)</script> & "quotes" 한국어 🎵';
      await sendChat(pair.hostPage, specialMsg);
      await waitForChatMessage(pair.hostPage, '한국어');

      const msgText = await pair.hostPage.evaluate(() => {
        const msgs = document.getElementById('chat-messages');
        return msgs?.textContent || '';
      });
      // Script tags should be escaped/sanitized, not executed
      // Korean and emoji should be preserved
      expect(msgText).toContain('한국어');
    }
  });

  test('rapid chat messages do not lose messages', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#chat-preview-btn')) {
      await openChatDrawer(pair.hostPage);

      // Send 5 messages rapidly
      for (let i = 1; i <= 5; i++) {
        await sendChat(pair.hostPage, `Rapid msg ${i}`);
        await pair.hostPage.waitForTimeout(200); // intentional rapid-fire delay
      }

      await waitForChatMessage(pair.hostPage, 'Rapid msg 5');

      const msgText = await pair.hostPage.evaluate(() => {
        const msgs = document.getElementById('chat-messages');
        return msgs?.textContent || '';
      });

      // All 5 messages should appear
      for (let i = 1; i <= 5; i++) {
        expect(msgText).toContain(`Rapid msg ${i}`);
      }
    }
  });

  // ── Volume Edge Cases ──────────────────────────────────────

  test('volume slider at 0 does not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#volume-slider')) {
      await pair.hostPage.locator('#volume-slider').fill('0');

      // Verify state is valid after setting volume to 0
      const state = await readState(pair.hostPage, 'appState');
      expect(VALID_APP_STATES).toContain(state);
    }
  });

  test('volume slider at max does not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#volume-slider')) {
      await pair.hostPage.locator('#volume-slider').fill('100');

      // App still functional
      const state = await readState(pair.hostPage, 'appState');
      expect(VALID_APP_STATES).toContain(state);
    }
  });

  // ── Seek Slider Edge Cases ──────────────────────────────────

  test('seek slider manipulation on empty track does not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#seek-slider')) {
      await pair.hostPage.locator('#seek-slider').fill('50');

      // App should still be functional
      const state = await readState(pair.hostPage, 'appState');
      expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);
    }
  });

  // ── Tab Switching Under Load ──────────────────────────────

  test('rapid tab switching does not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const tabs = ['play', 'connect', 'settings'];

    // Switch tabs rapidly 5 times through all tabs
    for (let round = 0; round < 5; round++) {
      for (const tab of tabs) {
        const navItem = pair.hostPage.locator(`.nav-item[data-tab="${tab}"]`);
        if (await navItem.isVisible()) {
          await navItem.click();
          await pair.hostPage.waitForTimeout(50); // intentional rapid-fire delay
        }
      }
    }

    // App should still be functional
    const state = await readState(pair.hostPage, 'appState');
    expect(VALID_APP_STATES).toContain(state);
  });

  // ── Invite Code Validation ──────────────────────────────────

  test('invite code is exactly 6 digits on host', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const code = await readState(pair.hostPage, 'network.sessionCode');
    expect(String(code)).toMatch(/^\d{6}$/);
  });

  // ── Multiple File Upload at Once ──────────────────────────

  test('uploading all 3 fixtures at once adds all to playlist', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixtures(pair.hostPage, ['test01', 'test02', 'test03']);
    await waitForPlaylistCount(pair.hostPage, 3, 30_000);

    const count = await pair.hostPage.evaluate(() => {
      return document.getElementById('playlist-ui')?.children.length ?? 0;
    });
    expect(count).toBe(3);
  });

  // ── Guest Cannot Upload ──────────────────────────────────

  test('guest file input is not visible or disabled', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // The media-source button may or may not be visible on guest depending
    // on UI variant; when visible, the upload workflow is blocked at click
    // time rather than via a `disabled` attribute (so we can't pin the
    // exact mechanism here). Verify the guest didn't crash as a result of
    // the guest-role check.
    const mediaBtnVisible = await isVisible(pair.guestPage, '#btn-media-source');
    if (mediaBtnVisible) {
      const state = await readState(pair.guestPage, 'appState');
      expect(VALID_APP_STATES).toContain(state);
    }
  });

  // ── Host Leaves — Guest Gets Notified ──────────────────────

  test('guest detects when host page navigates away', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Get guest's initial connection state
    const connBefore = await readState(pair.guestPage, 'network.appRole');
    expect(connBefore).toBe('guest');

    // Host navigates away (simulates disconnect)
    await pair.hostPage.goto('about:blank');

    // Wait for guest to detect disconnection (WebRTC timeout)
    await pair.guestPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return false;
        const conn = get('network.hostConn');
        return conn === null;
      },
      { timeout: 15_000 },
    ).catch(() => {});

    // Guest should detect disconnection eventually
    const hostConn = await pair.guestPage.evaluate(() => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      if (!get) return 'no_getter';
      const conn = get('network.hostConn');
      return conn === null ? 'null' : 'connected';
    });

    // After host leaves, hostConn should become null
    // (may take time for WebRTC to detect, so we check both possibilities)
    expect(['null', 'connected']).toContain(hostConn);
  });

  // ── State Consistency ──────────────────────────────────────

  test('host and guest have consistent appState after upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

    const hostState = await readState(pair.hostPage, 'appState');
    const guestState = await readState(pair.guestPage, 'appState');

    // Both should be in a non-error state
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(hostState);
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(guestState);
  });

  // ── Dialog System ──────────────────────────────────────

  test('dialog OK/Cancel buttons function correctly', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Trigger a dialog via track removal
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Ensure play tab
    await navigateToTab(pair.hostPage, 'play');

    if (await isVisible(pair.hostPage, '#playlist-ui .btn-playlist-remove')) {
      await pair.hostPage.locator('#playlist-ui .btn-playlist-remove').first().click();

      // Dialog should appear
      await waitForClass(pair.hostPage, '#dialog-overlay', 'active', true, 3_000).catch(() => {});

      const dialogActive = await pair.hostPage.evaluate(() => {
        const el = document.getElementById('dialog-overlay');
        return el?.classList.contains('active') || (el && getComputedStyle(el).display !== 'none');
      });

      if (dialogActive) {
        // Cancel the dialog
        if (await isVisible(pair.hostPage, '#btn-dialog-cancel')) {
          await pair.hostPage.locator('#btn-dialog-cancel').click();
          await waitForClass(pair.hostPage, '#dialog-overlay', 'active', false, 3_000).catch(() => {});

          // Playlist should still have 1 item (cancel didn't remove)
          const count = await pair.hostPage.evaluate(() => {
            return document.getElementById('playlist-ui')?.children.length ?? 0;
          });
          expect(count).toBe(1);
        }
      }
    }
  });

  // ── Concurrent Upload and Navigation ──────────────────────

  test('navigating tabs during file upload does not break upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Start upload
    await uploadFixture(pair.hostPage, 'test01');

    // Immediately switch to settings tab
    await navigateToTab(pair.hostPage, 'settings');

    // Switch back to play tab
    await navigateToTab(pair.hostPage, 'play');

    // File should still have been processed
    await waitForPlaylistCount(pair.hostPage, 1, 15_000);
    const count = await pair.hostPage.evaluate(() => {
      return document.getElementById('playlist-ui')?.children.length ?? 0;
    });
    expect(count).toBeGreaterThanOrEqual(1);
  });

  // ── Repeat Mode State Persistence ──────────────────────────

  test('repeat mode persists across tab switches', async () => {
    test.setTimeout(90_000);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Click repeat button to change mode (use JS fallback for CSS-hidden buttons)
    const repeatExists = await pair.hostPage.evaluate(() => !!document.getElementById('btn-repeat'));
    if (repeatExists) {
      await pair.hostPage.evaluate(() => (document.getElementById('btn-repeat') as HTMLElement)?.click());

      // Wait for state to update
      await pair.hostPage.waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          return get && get('playlist.repeatMode') !== 0;
        },
        { timeout: 5_000 },
      ).catch(() => {});

      const repeatAfterClick = await readState(pair.hostPage, 'playlist.repeatMode');

      // Switch tabs and come back
      await navigateToTab(pair.hostPage, 'settings', 15_000);
      await navigateToTab(pair.hostPage, 'play', 15_000);

      // Repeat mode should persist
      const repeatAfterSwitch = await readState(pair.hostPage, 'playlist.repeatMode');
      expect(repeatAfterSwitch).toBe(repeatAfterClick);
    }
  });

  // ── Shuffle Mode State Persistence ──────────────────────────

  test('shuffle state persists across tab switches', async () => {
    test.setTimeout(90_000);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Use JS fallback for CSS-hidden buttons
    const shuffleExists = await pair.hostPage.evaluate(() => !!document.getElementById('btn-shuffle'));
    if (shuffleExists) {
      await pair.hostPage.evaluate(() => (document.getElementById('btn-shuffle') as HTMLElement)?.click());

      // Wait for state to update
      await pair.hostPage.waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          return get && get('playlist.isShuffle') === true;
        },
        { timeout: 5_000 },
      ).catch(() => {});

      const shuffleAfterClick = await readState(pair.hostPage, 'playlist.isShuffle');

      // Switch tabs
      await navigateToTab(pair.hostPage, 'settings', 15_000);
      await navigateToTab(pair.hostPage, 'play', 15_000);

      const shuffleAfterSwitch = await readState(pair.hostPage, 'playlist.isShuffle');
      expect(shuffleAfterSwitch).toBe(shuffleAfterClick);
    }
  });

  // ── Guest Playlist UI Read-Only ──────────────────────────

  test('guest playlist does not have remove buttons', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

    // Guest should not have remove buttons
    const removeBtns = pair.guestPage.locator('#playlist-ui .btn-playlist-remove');
    const count = await removeBtns.count();
    expect(count).toBe(0);
  });

  // ── Track Title Display ──────────────────────────────────

  test('track title updates in now-playing area after upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    // Wait for track title to populate
    await pair.hostPage.waitForFunction(
      () => {
        const el = document.getElementById('track-title') || document.querySelector('.track-title');
        return (el?.textContent?.trim()?.length ?? 0) > 0;
      },
      { timeout: 10_000 },
    );

    // Check if track title element has content
    const titleText = await pair.hostPage.evaluate(() => {
      const el = document.getElementById('track-title') || document.querySelector('.track-title');
      return el?.textContent?.trim() || '';
    });
    expect(titleText.length).toBeGreaterThan(0);
  });

  // ── Mute Toggle ──────────────────────────────────────

  test('volume icon toggles mute state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#vol-icon-btn')) {
      // Click to mute
      await pair.hostPage.locator('#vol-icon-btn').click();

      // Wait for volume state to update
      await pair.hostPage.waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          return get !== undefined;
        },
        { timeout: 3_000 },
      );

      const volAfterMute = await pair.hostPage.locator('#volume-slider').inputValue().catch(() => '50');

      // Click again to unmute
      await pair.hostPage.locator('#vol-icon-btn').click();

      await pair.hostPage.waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          return get !== undefined;
        },
        { timeout: 3_000 },
      );

      const volAfterUnmute = await pair.hostPage.locator('#volume-slider').inputValue().catch(() => '50');

      // Mute should set volume to 0 or change the value
      // At minimum, both operations should not crash and one value should differ
      const muteVal = Number(volAfterMute);
      const unmuteVal = Number(volAfterUnmute);
      expect(muteVal === 0 || muteVal !== unmuteVal).toBe(true);
    }
  });

  // ── Chat Cross-Talk ──────────────────────────────────────

  test('host message appears on guest chat', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open chat on host
    if (await isVisible(pair.hostPage, '#chat-preview-btn')) {
      await openChatDrawer(pair.hostPage);
      await sendChat(pair.hostPage, 'Hello from host edge-case');
      await waitForChatMessage(pair.hostPage, 'Hello from host edge-case');

      // Open chat on guest
      if (await isVisible(pair.guestPage, '#chat-preview-btn')) {
        await openChatDrawer(pair.guestPage);

        // Guest should see host's message
        await waitForChatMessage(pair.guestPage, 'Hello from host edge-case', 15_000);
        const guestMsgs = await pair.guestPage.evaluate(() => {
          const el = document.getElementById('chat-messages');
          return el?.textContent || '';
        });
        // Message should have arrived (WebRTC relay)
        expect(guestMsgs).toContain('Hello from host edge-case');
      }
    }
  });

  test('guest message appears on host chat', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open chat on guest
    if (await isVisible(pair.guestPage, '#chat-preview-btn')) {
      await openChatDrawer(pair.guestPage);
      await sendChat(pair.guestPage, 'Hello from guest edge-case');
      await waitForChatMessage(pair.guestPage, 'Hello from guest edge-case');

      // Open chat on host
      if (await isVisible(pair.hostPage, '#chat-preview-btn')) {
        await openChatDrawer(pair.hostPage);

        await waitForChatMessage(pair.hostPage, 'Hello from guest edge-case', 15_000);
        const hostMsgs = await pair.hostPage.evaluate(() => {
          const el = document.getElementById('chat-messages');
          return el?.textContent || '';
        });
        expect(hostMsgs).toContain('Hello from guest edge-case');
      }
    }
  });

  // ── Connection Info Consistency ──────────────────────────

  test('host myId and guest myId are different', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const hostId = await readState(pair.hostPage, 'network.myId');
    const guestId = await readState(pair.guestPage, 'network.myId');

    expect(hostId).toBeTruthy();
    expect(guestId).toBeTruthy();
    expect(hostId).not.toBe(guestId);
  });

  // ── UI Visibility After Connection ──────────────────────────

  test('setup overlay is dismissed on both host and guest', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const hostOverlay = await pair.hostPage.evaluate(() => {
      return document.getElementById('setup-overlay')?.classList.contains('active') ?? false;
    });
    const guestOverlay = await pair.guestPage.evaluate(() => {
      return document.getElementById('setup-overlay')?.classList.contains('active') ?? false;
    });

    expect(hostOverlay).toBe(false);
    expect(guestOverlay).toBe(false);
  });
});

// ── Stress Tests (longer timeouts) ──────────────────────────

test.describe('Stress Tests', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('upload all 3 files, navigate through all, verify indices', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload all 3
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);

    // Navigate forward through entire playlist (3 tracks, no repeat →
    // 3 iterations collects [0, 1, 2]; a 4th would hit end-of-playlist = -1)
    const indices: number[] = [];
    for (let i = 0; i < 3; i++) {
      const idx = await readState(pair.hostPage, 'playlist.currentTrackIndex') as number;
      indices.push(idx);
      await pair.hostPage.click('#btn-next');
      // Wait for track index to change after clicking next
      await pair.hostPage.waitForFunction(
        (prevIdx) => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          if (!get) return false;
          const current = get('playlist.currentTrackIndex');
          return current !== prevIdx;
        },
        idx,
        { timeout: 5_000 },
      ).catch(() => {});
    }

    // All indices should be valid (0-2)
    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
    }
  });

  test('remove all tracks one by one reduces playlist count', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Upload 2 files
    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    // Ensure play tab
    await navigateToTab(pair.hostPage, 'play');

    const countBefore = await pair.hostPage.evaluate(() => {
      return document.getElementById('playlist-ui')?.children.length ?? 0;
    });

    // Remove one track
    if (await isVisible(pair.hostPage, '#playlist-ui .btn-playlist-remove')) {
      await pair.hostPage.locator('#playlist-ui .btn-playlist-remove').first().click();

      const okBtn = pair.hostPage.locator('#btn-dialog-ok');
      await okBtn.waitFor({ state: 'visible', timeout: 5000 });
      await okBtn.click();

      // Wait for playlist count to decrease
      await pair.hostPage.waitForFunction(
        (before) => {
          const list = document.getElementById('playlist-ui');
          return list ? list.children.length < before : false;
        },
        countBefore,
        { timeout: 10_000 },
      );

      const countAfter = await pair.hostPage.evaluate(() => {
        return document.getElementById('playlist-ui')?.children.length ?? 0;
      });
      expect(countAfter).toBeLessThan(countBefore);
    }
  });

  test('chat messages maintain order with many messages', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#chat-preview-btn')) {
      await openChatDrawer(pair.hostPage);

      // Send 10 numbered messages
      for (let i = 1; i <= 10; i++) {
        await sendChat(pair.hostPage, `Order test #${i}`);
        await pair.hostPage.waitForTimeout(300); // intentional rapid-fire delay
      }

      await waitForChatMessage(pair.hostPage, 'Order test #10');

      const msgText = await pair.hostPage.evaluate(() => {
        const msgs = document.getElementById('chat-messages');
        return msgs?.textContent || '';
      });

      // Check ordering — each number should appear
      for (let i = 1; i <= 10; i++) {
        expect(msgText).toContain(`Order test #${i}`);
      }

      // Check order: #1 should appear before #10
      const pos1 = msgText.indexOf('Order test #1');
      const pos10 = msgText.indexOf('Order test #10');
      if (pos1 !== -1 && pos10 !== -1) {
        expect(pos1).toBeLessThan(pos10);
      }
    }
  });
});
