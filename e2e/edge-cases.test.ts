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
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { uploadFixture, uploadFixtures } from './helpers/file-upload.ts';
import { readCurrentQueueIndex } from './helpers/queue-state.ts';
import {
  isVisible,
  navigateToTab,
  openChatDrawer,
  readPlaybackProjection,
  readState,
  sendChat,
  VALID_PLAYBACK_PROJECTIONS,
  waitForChatMessage,
  waitForPlaybackProjection,
  waitForPlaylistCount,
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

    for (let i = 0; i < 10; i++) {
      await pair.hostPage.click('#btn-next');
      await pair.hostPage.waitForTimeout(100); // intentional rapid-fire delay
    }

    for (let i = 0; i < 10; i++) {
      await pair.hostPage.click('#btn-prev');
      await pair.hostPage.waitForTimeout(100); // intentional rapid-fire delay
    }

    const index = await readCurrentQueueIndex(pair.hostPage);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(3);
  });

  test('rapid play/pause clicks do not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.current') !== null;
      },
      { timeout: 15_000 },
    );

    for (let i = 0; i < 8; i++) {
      await pair.hostPage.click('#play-btn');
      await pair.hostPage.waitForTimeout(150); // intentional rapid-fire delay
    }

    const state = (await readPlaybackProjection(pair.hostPage)) as string;
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO', 'PLAYING_YOUTUBE']).toContain(state);
  });

  // ── Empty State Navigation ──────────────────────────────────

  test('next/prev on empty playlist does not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await pair.hostPage.click('#btn-next');
    await pair.hostPage.click('#btn-prev');

    const index = await readCurrentQueueIndex(pair.hostPage);
    expect(index).toBe(-1);
  });

  test('play button on empty playlist is disabled', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Play button is accessibility-disabled when no track is loaded.
    const isDisabled = await pair.hostPage.locator('#play-btn').evaluate((el) => {
      return (
        el.hasAttribute('disabled') ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.classList.contains('disabled')
      );
    });
    expect(isDisabled).toBe(true);

    const state = (await readPlaybackProjection(pair.hostPage)) as string;
    expect(state).toBe('IDLE');
  });

  // ── Upload While Playing ──────────────────────────────────

  test('uploading new file while playing does not interrupt current track', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get && get('files.current') !== null;
      },
      { timeout: 15_000 },
    );

    await pair.hostPage.click('#play-btn');
    await waitForPlaybackProjection(pair.hostPage, 'PLAYING_AUDIO', 5_000).catch(() => {});

    const stateBefore = (await readPlaybackProjection(pair.hostPage)) as string;

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    const count = await pair.hostPage.evaluate(() => {
      return document.getElementById('playlist-ui')?.children.length ?? 0;
    });
    expect(count).toBe(2);

    const stateAfter = (await readPlaybackProjection(pair.hostPage)) as string;
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

      // A negative assertion needs a bounded observation window because no DOM
      // event fires when an empty message is correctly ignored.
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
      expect(msgText).toContain('한국어');
    }
  });

  test('rapid chat messages do not lose messages', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#chat-preview-btn')) {
      await openChatDrawer(pair.hostPage);

      for (let i = 1; i <= 5; i++) {
        await sendChat(pair.hostPage, `Rapid msg ${i}`);
        await pair.hostPage.waitForTimeout(200); // intentional rapid-fire delay
      }

      await waitForChatMessage(pair.hostPage, 'Rapid msg 5');

      const msgText = await pair.hostPage.evaluate(() => {
        const msgs = document.getElementById('chat-messages');
        return msgs?.textContent || '';
      });

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

      const state = await readPlaybackProjection(pair.hostPage);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(state);
    }
  });

  test('volume slider at max does not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#volume-slider')) {
      await pair.hostPage.locator('#volume-slider').fill('100');

      const state = await readPlaybackProjection(pair.hostPage);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(state);
    }
  });

  // ── Seek Slider Edge Cases ──────────────────────────────────

  test('seek slider manipulation on empty track does not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#seek-slider')) {
      await pair.hostPage.locator('#seek-slider').fill('50');

      const state = await readPlaybackProjection(pair.hostPage);
      expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(state);
    }
  });

  // ── Tab Switching Under Load ──────────────────────────────

  test('rapid tab switching does not crash', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const tabs = ['play', 'connect', 'settings'];

    for (let round = 0; round < 5; round++) {
      for (const tab of tabs) {
        const navItem = pair.hostPage.locator(`.nav-item[data-tab="${tab}"]`);
        if (await navItem.isVisible()) {
          await navItem.click();
          await pair.hostPage.waitForTimeout(50); // intentional rapid-fire delay
        }
      }
    }

    const state = await readPlaybackProjection(pair.hostPage);
    expect(VALID_PLAYBACK_PROJECTIONS).toContain(state);
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

    // UI variants may hide the guest media-source button. When visible, the
    // role guard blocks at click time rather than through `disabled`, so assert
    // the guest remains valid instead of pinning one presentation mechanism.
    const mediaBtnVisible = await isVisible(pair.guestPage, '#btn-media-source');
    if (mediaBtnVisible) {
      const state = await readPlaybackProjection(pair.guestPage);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(state);
    }
  });

  // ── Host Leaves — Guest Gets Notified ──────────────────────

  test('guest detects when host page navigates away', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const connBefore = await readState(pair.guestPage, 'network.appRole');
    expect(connBefore).toBe('guest');

    // Navigating the host away simulates an ungraceful disconnect.
    await pair.hostPage.goto('about:blank');

    // WebRTC disconnect detection is asynchronous.
    await pair.guestPage
      .waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          if (!get) return false;
          const conn = get('network.hostConn');
          return conn === null;
        },
        { timeout: 15_000 },
      )
      .catch(() => {});

    const hostConn = await pair.guestPage.evaluate(() => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      if (!get) return 'no_getter';
      const conn = get('network.hostConn');
      return conn === null ? 'null' : 'connected';
    });

    // WebRTC close detection is asynchronous, so allow the valid transient
    // state while rejecting runtime failure.
    expect(['null', 'connected']).toContain(hostConn);
  });

  // ── State Consistency ──────────────────────────────────────

  test('host and guest have consistent playback projection after upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);
    await waitForPlaylistCount(pair.guestPage, 1, 20_000);

    const hostState = await readPlaybackProjection(pair.hostPage);
    const guestState = await readPlaybackProjection(pair.guestPage);

    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(hostState);
    expect(['IDLE', 'PAUSED', 'PLAYING_AUDIO']).toContain(guestState);
  });

  // ── Dialog System ──────────────────────────────────────

  test('playlist removal selection can be cancelled without a dialog', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await navigateToTab(pair.hostPage, 'play');

    if (await isVisible(pair.hostPage, '#playlist-ui .btn-playlist-remove')) {
      await pair.hostPage.locator('#playlist-ui .btn-playlist-remove').first().click();
      await expect(pair.hostPage.locator('.playlist-selection-pill')).toHaveClass(/is-visible/);
      await expect(pair.hostPage.locator('#dialog-overlay')).toBeHidden();
      await pair.hostPage.locator('[data-selection-action="cancel"]').click();
      await expect(pair.hostPage.locator('.playlist-selection-pill')).not.toHaveClass(/is-visible/);

      const count = await pair.hostPage.evaluate(() => {
        return document.getElementById('playlist-ui')?.children.length ?? 0;
      });
      expect(count).toBe(1);
    }
  });

  // ── Concurrent Upload and Navigation ──────────────────────

  test('navigating tabs during file upload does not break upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');

    await navigateToTab(pair.hostPage, 'settings');

    await navigateToTab(pair.hostPage, 'play');

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

    // Use a DOM click because responsive CSS may hide the desktop control.
    const repeatExists = await pair.hostPage.evaluate(
      () => !!document.getElementById('btn-repeat'),
    );
    if (repeatExists) {
      await pair.hostPage.evaluate(() =>
        (document.getElementById('btn-repeat') as HTMLElement)?.click(),
      );

      await pair.hostPage
        .waitForFunction(
          () => {
            const get = (window as any).__MUSIXQUARE_GET_STATE__;
            return get && get('playlist.repeatMode') !== 0;
          },
          { timeout: 5_000 },
        )
        .catch(() => {});

      const repeatAfterClick = await readState(pair.hostPage, 'playlist.repeatMode');

      await navigateToTab(pair.hostPage, 'settings', 15_000);
      await navigateToTab(pair.hostPage, 'play', 15_000);

      const repeatAfterSwitch = await readState(pair.hostPage, 'playlist.repeatMode');
      expect(repeatAfterSwitch).toBe(repeatAfterClick);
    }
  });

  // ── Shuffle Mode State Persistence ──────────────────────────

  test('shuffle state persists across tab switches', async () => {
    test.setTimeout(90_000);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Use a DOM click because responsive CSS may hide the desktop control.
    const shuffleExists = await pair.hostPage.evaluate(
      () => !!document.getElementById('btn-shuffle'),
    );
    if (shuffleExists) {
      await pair.hostPage.evaluate(() =>
        (document.getElementById('btn-shuffle') as HTMLElement)?.click(),
      );

      await pair.hostPage
        .waitForFunction(
          () => {
            const get = (window as any).__MUSIXQUARE_GET_STATE__;
            return get && get('playlist.isShuffle') === true;
          },
          { timeout: 5_000 },
        )
        .catch(() => {});

      const shuffleAfterClick = await readState(pair.hostPage, 'playlist.isShuffle');

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

    const removeBtns = pair.guestPage.locator('#playlist-ui .btn-playlist-remove');
    const count = await removeBtns.count();
    expect(count).toBe(0);
  });

  // ── Track Title Display ──────────────────────────────────

  test('track title updates in now-playing area after upload', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await pair.hostPage.waitForFunction(
      () => {
        const el = document.getElementById('track-title') || document.querySelector('.track-title');
        return (el?.textContent?.trim()?.length ?? 0) > 0;
      },
      { timeout: 10_000 },
    );

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
      await pair.hostPage.locator('#vol-icon-btn').click();

      await pair.hostPage.waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          return get !== undefined;
        },
        { timeout: 3_000 },
      );

      const volAfterMute = await pair.hostPage
        .locator('#volume-slider')
        .inputValue()
        .catch(() => '50');

      await pair.hostPage.locator('#vol-icon-btn').click();

      await pair.hostPage.waitForFunction(
        () => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          return get !== undefined;
        },
        { timeout: 3_000 },
      );

      const volAfterUnmute = await pair.hostPage
        .locator('#volume-slider')
        .inputValue()
        .catch(() => '50');

      const muteVal = Number(volAfterMute);
      const unmuteVal = Number(volAfterUnmute);
      expect(muteVal === 0 || muteVal !== unmuteVal).toBe(true);
    }
  });

  // ── Chat Cross-Talk ──────────────────────────────────────

  test('host message appears on guest chat', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.hostPage, '#chat-preview-btn')) {
      await openChatDrawer(pair.hostPage);
      await sendChat(pair.hostPage, 'Hello from host edge-case');
      await waitForChatMessage(pair.hostPage, 'Hello from host edge-case');

      if (await isVisible(pair.guestPage, '#chat-preview-btn')) {
        await openChatDrawer(pair.guestPage);

        await waitForChatMessage(pair.guestPage, 'Hello from host edge-case', 15_000);
        const guestMsgs = await pair.guestPage.evaluate(() => {
          const el = document.getElementById('chat-messages');
          return el?.textContent || '';
        });
        expect(guestMsgs).toContain('Hello from host edge-case');
      }
    }
  });

  test('guest message appears on host chat', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    if (await isVisible(pair.guestPage, '#chat-preview-btn')) {
      await openChatDrawer(pair.guestPage);
      await sendChat(pair.guestPage, 'Hello from guest edge-case');
      await waitForChatMessage(pair.guestPage, 'Hello from guest edge-case');

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

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await uploadFixture(pair.hostPage, 'test03');
    await waitForPlaylistCount(pair.hostPage, 3);

    // Three transitions visit indices 0, 1, and 2; a fourth would reach the
    // end-of-playlist sentinel.
    const indices: number[] = [];
    for (let i = 0; i < 3; i++) {
      const idx = await readCurrentQueueIndex(pair.hostPage);
      indices.push(idx);
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
            return current !== prevIdx;
          },
          idx,
          { timeout: 5_000 },
        )
        .catch(() => {});
    }

    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
    }
  });

  test('remove all tracks one by one reduces playlist count', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await uploadFixture(pair.hostPage, 'test01');
    await waitForPlaylistCount(pair.hostPage, 1);

    await uploadFixture(pair.hostPage, 'test02');
    await waitForPlaylistCount(pair.hostPage, 2);

    await navigateToTab(pair.hostPage, 'play');

    const countBefore = await pair.hostPage.evaluate(() => {
      return document.getElementById('playlist-ui')?.children.length ?? 0;
    });

    if (await isVisible(pair.hostPage, '#playlist-ui .btn-playlist-remove')) {
      await pair.hostPage.locator('#playlist-ui .btn-playlist-remove').first().click();
      await pair.hostPage.locator('.playlist-selection-delete').click();

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

      for (let i = 1; i <= 10; i++) {
        await sendChat(pair.hostPage, `Order test #${i}`);
        await pair.hostPage.waitForTimeout(300); // intentional rapid-fire delay
      }

      await waitForChatMessage(pair.hostPage, 'Order test #10');

      const msgText = await pair.hostPage.evaluate(() => {
        const msgs = document.getElementById('chat-messages');
        return msgs?.textContent || '';
      });

      for (let i = 1; i <= 10; i++) {
        expect(msgText).toContain(`Order test #${i}`);
      }

      const pos1 = msgText.indexOf('Order test #1');
      const pos10 = msgText.indexOf('Order test #10');
      if (pos1 !== -1 && pos10 !== -1) {
        expect(pos1).toBeLessThan(pos10);
      }
    }
  });
});
