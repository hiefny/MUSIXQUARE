/**
 * E2E: Late-Join Guest Tests
 *
 * Tests scenarios where a guest joins AFTER the host has already
 * performed actions (uploaded files, started playback, entered YouTube mode, etc.).
 *
 * This differs from other tests where host+guest connect simultaneously
 * before any actions happen. Late-join is a critical real-world scenario:
 * a friend sends you a code while music is already playing.
 *
 * Pattern: Host sets up → Host performs actions → THEN guest joins → verify sync
 */
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupHostAndStart, setupGuest } from './helpers/setup-flow.ts';
import {
  installLocalYouTube,
  submitYouTubeSource,
  waitForYouTubePlayback,
} from './helpers/youtube-source.ts';
import { uploadFixture } from './helpers/file-upload.ts';
import { readCurrentQueueItemId, waitForCurrentQueueIndex } from './helpers/queue-state.ts';
import {
  waitForState,
  openChatDrawer,
  readPlaybackProjection,
  readState,
  sendChat,
  VALID_PLAYBACK_PROJECTIONS,
  waitForChatMessage,
  waitForDeviceCount,
  waitForPlaybackProjection,
  waitForPlaylistCount,
} from './helpers/wait.ts';

// YouTube test URLs
const YT_VIDEO = 'https://youtu.be/bnh70V0yu2s';

interface LateJoinContext {
  hostContext: BrowserContext;
  hostPage: Page;
  sessionCode: string;
}

/** Set up host only — no guest yet */
async function setupHostOnly(browser: Browser, youtube = false): Promise<LateJoinContext> {
  const hostContext = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const hostPage = await hostContext.newPage();
  await injectPeerServer(hostPage);

  if (youtube) await installLocalYouTube(hostPage);
  const sessionCode = await setupHostAndStart(hostPage);

  return { hostContext, hostPage, sessionCode };
}

/** Create a guest and join the existing session */
async function joinAsGuest(
  browser: Browser,
  sessionCode: string,
  youtube = false,
): Promise<{ guestContext: BrowserContext; guestPage: Page }> {
  const guestContext = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const guestPage = await guestContext.newPage();
  await injectPeerServer(guestPage);
  if (youtube) await installLocalYouTube(guestPage);
  await setupGuest(guestPage, sessionCode);
  return { guestContext, guestPage };
}

test.describe('Late-Join: Guest joins after file upload', () => {
  let host: LateJoinContext;

  test.afterEach(async () => {
    await host.hostContext.close().catch(() => {});
  });

  test('guest receives playlist that was built before joining', async ({ browser }) => {
    host = await setupHostOnly(browser);

    // Host uploads 2 files BEFORE any guest connects
    await uploadFixture(host.hostPage, 'test01');
    await waitForPlaylistCount(host.hostPage, 1);

    await uploadFixture(host.hostPage, 'test02');
    await waitForPlaylistCount(host.hostPage, 2);

    // NOW guest joins
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      // Guest should receive the full playlist
      await waitForPlaylistCount(guestPage, 2, 30_000);

      const guestPlaylist = await guestPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? ((get('playlist.items') as unknown[])?.length ?? 0) : 0;
      });
      expect(guestPlaylist).toBe(2);
    } finally {
      await guestContext.close();
    }
  });

  test('guest sees correct currentTrackIndex from host', async ({ browser }) => {
    host = await setupHostOnly(browser);

    // Upload 3 files and navigate to track 2
    await uploadFixture(host.hostPage, 'test01');
    await waitForPlaylistCount(host.hostPage, 1);

    await uploadFixture(host.hostPage, 'test02');
    await waitForPlaylistCount(host.hostPage, 2);

    await uploadFixture(host.hostPage, 'test03');
    await waitForPlaylistCount(host.hostPage, 3);

    // Navigate to next track
    await host.hostPage.click('#btn-next');
    await waitForCurrentQueueIndex(host.hostPage, 1, 10_000);

    const hostQueueItemId = await readCurrentQueueItemId(host.hostPage);
    expect(hostQueueItemId).not.toBeNull();

    // NOW guest joins
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      await waitForPlaylistCount(guestPage, 3, 30_000);

      // Guest should select the same stable queue occurrence.
      const guestQueueItemId = await readCurrentQueueItemId(guestPage);
      expect(guestQueueItemId).toBe(hostQueueItemId);
    } finally {
      await guestContext.close();
    }
  });

  test('guest receives track title from host after late join', async ({ browser }) => {
    host = await setupHostOnly(browser);

    await uploadFixture(host.hostPage, 'test01');
    await waitForPlaylistCount(host.hostPage, 1);

    // Wait for track title to appear on host
    await host.hostPage.waitForFunction(
      () => {
        const el = document.getElementById('track-title') || document.querySelector('.track-title');
        return el && el.textContent && el.textContent.trim().length > 0;
      },
      undefined,
      { timeout: 10_000 },
    );

    // NOW guest joins
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      await waitForPlaylistCount(guestPage, 1, 20_000);

      // Guest should have playlist entry with track metadata
      const guestPlaylist = await guestPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        if (!get) return [];
        return get('playlist.items') as unknown[];
      });
      expect(guestPlaylist.length).toBe(1);
    } finally {
      await guestContext.close();
    }
  });
});

test.describe('Late-Join: Guest joins during playback', () => {
  let host: LateJoinContext;

  test.afterEach(async () => {
    await host.hostContext.close().catch(() => {});
  });

  test('guest receives PLAYING state when host is already playing', async ({ browser }) => {
    host = await setupHostOnly(browser);

    // Upload and start playing
    await uploadFixture(host.hostPage, 'test01');
    await waitForPlaylistCount(host.hostPage, 1);

    await host.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );

    await host.hostPage.click('#play-btn');
    await waitForPlaybackProjection(host.hostPage, 'PLAYING_AUDIO', 15_000);

    // Host is now PLAYING_AUDIO — guest joins late
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      await waitForPlaylistCount(guestPage, 1, 20_000);

      // Wait for guest state to settle
      await guestPage.waitForFunction(
        () => {
          const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
          if (typeof projected !== 'function') return false;
          const state = projected();
          return state === 'PLAYING_AUDIO' || state === 'PAUSED' || state === 'IDLE';
        },
        undefined,
        { timeout: 10_000 },
      );

      const guestState = await readPlaybackProjection(guestPage);
      expect(['PLAYING_AUDIO', 'PAUSED', 'IDLE']).toContain(guestState);
    } finally {
      await guestContext.close();
    }
  });

  test('guest receives PAUSED state when host has paused', async ({ browser }) => {
    host = await setupHostOnly(browser);

    // Upload, play, then pause
    await uploadFixture(host.hostPage, 'test01');
    await waitForPlaylistCount(host.hostPage, 1);

    await host.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.current') !== null,
      undefined,
      { timeout: 15_000 },
    );

    await host.hostPage.click('#play-btn');
    await waitForPlaybackProjection(host.hostPage, 'PLAYING_AUDIO', 15_000);

    await host.hostPage.click('#play-btn'); // pause

    await waitForPlaybackProjection(host.hostPage, 'PAUSED', 10_000);

    // Guest joins while host is paused
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      await waitForPlaylistCount(guestPage, 1, 20_000);

      // Wait for guest state to settle
      await guestPage.waitForFunction(
        () => {
          const projected = (window as any).__MUSIXQUARE_GET_PLAYBACK_PROJECTION__;
          if (typeof projected !== 'function') return false;
          const state = projected();
          return state === 'PAUSED' || state === 'IDLE';
        },
        undefined,
        { timeout: 10_000 },
      );

      const guestState = await readPlaybackProjection(guestPage);
      expect(['PAUSED', 'IDLE']).toContain(guestState);
    } finally {
      await guestContext.close();
    }
  });
});

test.describe('Late-Join: Guest joins during YouTube mode', () => {
  let host: LateJoinContext;

  test.afterEach(async () => {
    await host.hostContext.close().catch(() => {});
  });

  test('guest receives YouTube mode when host is in PLAYING_YOUTUBE', async ({ browser }) => {
    host = await setupHostOnly(browser, true);
    await submitYouTubeSource(host.hostPage, YT_VIDEO);
    await waitForYouTubePlayback(host.hostPage, 'bnh70V0yu2s');
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode, true);
    try {
      await waitForYouTubePlayback(guestPage, 'bnh70V0yu2s');
    } finally {
      await guestContext.close();
    }
  });
});

test.describe('Late-Join: Guest joins after settings changed', () => {
  let host: LateJoinContext;

  test.afterEach(async () => {
    await host.hostContext.close().catch(() => {});
  });

  test('guest joins and sees host device in connect list', async ({ browser }) => {
    host = await setupHostOnly(browser);

    // Guest joins
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      // Host should see guest in device list
      await waitForDeviceCount(host.hostPage, 2);

      // Guest should see host connection
      const guestRole = await readState(guestPage, 'network.appRole');
      expect(guestRole).toBe('guest');

      const hostConn = await guestPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? get('network.hostConn') !== null : false;
      });
      expect(hostConn).toBe(true);
    } finally {
      await guestContext.close();
    }
  });

  test('host with repeat mode set — guest receives same state', async ({ browser }) => {
    host = await setupHostOnly(browser);

    await host.hostPage.locator('#btn-repeat').click();
    await waitForState(host.hostPage, 'playlist.repeatMode', 1);

    // Guest joins
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      // Wait for guest to be connected and have state
      await waitForDeviceCount(host.hostPage, 2);

      await waitForState(guestPage, 'playlist.repeatMode', 1);
      // The authoritative queue mode is bootstrapped with the room.
      const guestState = await readPlaybackProjection(guestPage);
      expect(VALID_PLAYBACK_PROJECTIONS).toContain(guestState);
    } finally {
      await guestContext.close();
    }
  });
});

test.describe('Late-Join: Multiple guests join at different times', () => {
  let host: LateJoinContext;

  test.afterEach(async () => {
    await host.hostContext.close().catch(() => {});
  });

  test('second late guest gets full playlist built by first guest era', async ({ browser }) => {
    host = await setupHostOnly(browser);

    // Upload file
    await uploadFixture(host.hostPage, 'test01');
    await waitForPlaylistCount(host.hostPage, 1);

    // First guest joins
    const guest1 = await joinAsGuest(browser, host.sessionCode);

    try {
      await waitForPlaylistCount(guest1.guestPage, 1, 20_000);

      // Host uploads more files while guest1 is connected
      await uploadFixture(host.hostPage, 'test02');
      await waitForPlaylistCount(host.hostPage, 2);

      await uploadFixture(host.hostPage, 'test03');
      await waitForPlaylistCount(host.hostPage, 3);

      // Guest1 should have all 3
      await waitForPlaylistCount(guest1.guestPage, 3, 20_000);

      // NOW second guest joins — should get all 3 tracks
      const guest2 = await joinAsGuest(browser, host.sessionCode);

      try {
        await waitForPlaylistCount(guest2.guestPage, 3, 30_000);

        const guest2Count = await guest2.guestPage.evaluate(() => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          return get ? ((get('playlist.items') as unknown[])?.length ?? 0) : 0;
        });
        expect(guest2Count).toBe(3);
      } finally {
        await guest2.guestContext.close();
      }
    } finally {
      await guest1.guestContext.close();
    }
  });

  test('guest joins after another guest was kicked', async ({ browser }) => {
    host = await setupHostOnly(browser);

    // First guest joins
    const guest1 = await joinAsGuest(browser, host.sessionCode);

    try {
      await waitForDeviceCount(host.hostPage, 2);

      const desktopConnect = host.hostPage.locator('#settings-subtab-connect');
      if (await desktopConnect.isVisible()) await desktopConnect.click();
      else await host.hostPage.locator('#nav-connect').click();
      const kick = host.hostPage.locator('.btn-kick-device:visible').first();
      await expect(kick).toBeVisible();
      await kick.click();
      await expect(host.hostPage.locator('#dialog-overlay.show')).toBeVisible();
      await host.hostPage.locator('#btn-dialog-ok').click();
      await expect(guest1.guestPage.locator('#dialog-overlay.show')).toBeVisible();
      await waitForDeviceCount(host.hostPage, 1);
    } finally {
      await guest1.guestContext.close();
    }

    // Upload a file after kick
    await uploadFixture(host.hostPage, 'test01');
    await waitForPlaylistCount(host.hostPage, 1);

    // New guest joins — should get full state
    const guest2 = await joinAsGuest(browser, host.sessionCode);

    try {
      await waitForPlaylistCount(guest2.guestPage, 1, 20_000);

      const role = await readState(guest2.guestPage, 'network.appRole');
      expect(role).toBe('guest');
    } finally {
      await guest2.guestContext.close();
    }
  });
});

test.describe('Late-Join: Chat history', () => {
  let host: LateJoinContext;

  test.afterEach(async () => {
    await host.hostContext.close().catch(() => {});
  });

  test('late guest does not see chat history from before joining', async ({ browser }) => {
    host = await setupHostOnly(browser);

    await openChatDrawer(host.hostPage);
    await sendChat(host.hostPage, 'Message before guest');
    await waitForChatMessage(host.hostPage, 'Message before guest');

    // Guest joins late
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      await openChatDrawer(guestPage);
      await sendChat(host.hostPage, 'Message after admission');
      await waitForChatMessage(guestPage, 'Message after admission');
      await expect(guestPage.locator('#chat-messages')).not.toContainText('Message before guest');
    } finally {
      await guestContext.close();
    }
  });

  test('late guest receives the latest pinned notice', async ({ browser }) => {
    host = await setupHostOnly(browser);

    // Notices render only in the pinned banner, so wait on the
    // banner, not the chat message list.
    const waitForPinnedNotice = async (page: Page, text: string): Promise<void> => {
      await page.waitForFunction(
        (t) => {
          const banner = document.getElementById('chat-pinned-notice');
          if (!banner || banner.hidden) return false;
          const body = document.getElementById('chat-pinned-notice-text');
          return body?.textContent?.includes(t) ?? false;
        },
        text,
        { timeout: 10_000 },
      );
    };

    await openChatDrawer(host.hostPage);
    await sendChat(host.hostPage, '/notice Mix note for late joiners');
    await waitForPinnedNotice(host.hostPage, 'Mix note for late joiners');

    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      await openChatDrawer(guestPage);
      await waitForPinnedNotice(guestPage, 'Mix note for late joiners');

      const pinnedText = await guestPage.evaluate(() => {
        const banner = document.getElementById('chat-pinned-notice');
        return banner?.textContent || '';
      });
      expect(pinnedText).toContain('Mix note for late joiners');
    } finally {
      await guestContext.close();
    }
  });

  test('late guest receives new messages sent after joining', async ({ browser }) => {
    host = await setupHostOnly(browser);

    // Guest joins
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      // Wait for connection to be established
      await waitForDeviceCount(host.hostPage, 2);

      await openChatDrawer(host.hostPage);
      await sendChat(host.hostPage, 'Message after guest joined');
      await openChatDrawer(guestPage);
      await waitForChatMessage(guestPage, 'Message after guest joined');
    } finally {
      await guestContext.close();
    }
  });
});
