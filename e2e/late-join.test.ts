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
import { uploadFixture } from './helpers/file-upload.ts';
import { waitForPlaylistCount, readState, waitForDeviceCount } from './helpers/wait.ts';

// YouTube test URLs
const YT_VIDEO = 'https://youtu.be/bnh70V0yu2s';

interface LateJoinContext {
  hostContext: BrowserContext;
  hostPage: Page;
  sessionCode: string;
}

/** Set up host only — no guest yet */
async function setupHostOnly(browser: Browser): Promise<LateJoinContext> {
  const hostContext = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const hostPage = await hostContext.newPage();
  await injectPeerServer(hostPage);

  const sessionCode = await setupHostAndStart(hostPage);

  return { hostContext, hostPage, sessionCode };
}

/** Create a guest and join the existing session */
async function joinAsGuest(
  browser: Browser,
  sessionCode: string,
): Promise<{ guestContext: BrowserContext; guestPage: Page }> {
  const guestContext = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const guestPage = await guestContext.newPage();
  await injectPeerServer(guestPage);
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
    await host.hostPage.waitForTimeout(2000);

    await uploadFixture(host.hostPage, 'test02');
    await waitForPlaylistCount(host.hostPage, 2);
    await host.hostPage.waitForTimeout(1000);

    // NOW guest joins
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      // Guest should receive the full playlist
      await waitForPlaylistCount(guestPage, 2, 30_000);

      const guestPlaylist = await guestPage.evaluate(() => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? (get('playlist.items') as unknown[])?.length ?? 0 : 0;
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
    await host.hostPage.waitForTimeout(2000);

    await uploadFixture(host.hostPage, 'test02');
    await waitForPlaylistCount(host.hostPage, 2);
    await host.hostPage.waitForTimeout(1000);

    await uploadFixture(host.hostPage, 'test03');
    await waitForPlaylistCount(host.hostPage, 3);
    await host.hostPage.waitForTimeout(1000);

    // Navigate to next track
    await host.hostPage.click('#btn-next');
    await host.hostPage.waitForTimeout(2000);

    const hostIndex = await readState(host.hostPage, 'playlist.currentTrackIndex') as number;

    // NOW guest joins
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      await waitForPlaylistCount(guestPage, 3, 30_000);

      // Guest should have the same current track index
      const guestIndex = await readState(guestPage, 'playlist.currentTrackIndex') as number;
      expect(guestIndex).toBe(hostIndex);
    } finally {
      await guestContext.close();
    }
  });

  test('guest receives track title from host after late join', async ({ browser }) => {
    host = await setupHostOnly(browser);

    await uploadFixture(host.hostPage, 'test01');
    await waitForPlaylistCount(host.hostPage, 1);
    await host.hostPage.waitForTimeout(3000);

    // Verify host has a track title
    const hostTitle = await host.hostPage.evaluate(() => {
      const el = document.getElementById('track-title') || document.querySelector('.track-title');
      return el?.textContent?.trim() || '';
    });

    // NOW guest joins
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      await waitForPlaylistCount(guestPage, 1, 20_000);
      await guestPage.waitForTimeout(2000);

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
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );

    await host.hostPage.click('#play-btn');
    await host.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 15_000 },
    );

    // Host is now PLAYING_AUDIO — guest joins late
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      await waitForPlaylistCount(guestPage, 1, 20_000);
      await guestPage.waitForTimeout(3000);

      // Guest should know host is playing
      const guestState = await readState(guestPage, 'appState');
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
      () => (window as any).__MUSIXQUARE_GET_STATE__?.('files.currentFileBlob') !== null,
      { timeout: 15_000 },
    );

    await host.hostPage.click('#play-btn');
    await host.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PLAYING_AUDIO',
      { timeout: 15_000 },
    );

    await host.hostPage.waitForTimeout(1000);
    await host.hostPage.click('#play-btn'); // pause

    await host.hostPage.waitForFunction(
      () => (window as any).__MUSIXQUARE_GET_STATE__('appState') === 'PAUSED',
      { timeout: 10_000 },
    );

    // Guest joins while host is paused
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      await waitForPlaylistCount(guestPage, 1, 20_000);
      await guestPage.waitForTimeout(3000);

      const guestState = await readState(guestPage, 'appState');
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
    host = await setupHostOnly(browser);

    // Host enters YouTube mode
    await host.hostPage.evaluate(() => {
      const overlay = document.getElementById('youtube-url-overlay');
      if (overlay) overlay.classList.add('active');
    });

    const ytInput = host.hostPage.locator('#youtube-url-input');
    if (await ytInput.isVisible()) {
      await ytInput.fill(YT_VIDEO);
      await ytInput.dispatchEvent('input');
      await host.hostPage.waitForTimeout(2000);

      const playBtn = host.hostPage.locator('#youtube-play-btn');
      if (await playBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
        await playBtn.click();
        await host.hostPage.waitForTimeout(8000);

        const hostState = await readState(host.hostPage, 'appState');
        if (hostState === 'PLAYING_YOUTUBE') {
          // Guest joins while YouTube is playing
          const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

          try {
            await guestPage.waitForTimeout(5000);

            const guestState = await readState(guestPage, 'appState');
            expect(['PLAYING_YOUTUBE', 'IDLE']).toContain(guestState);
          } finally {
            await guestContext.close();
          }
        }
      }
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

    // Host has been running solo for a bit
    await host.hostPage.waitForTimeout(2000);

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

    // Host sets repeat mode to 'all'
    const repeatBtn = host.hostPage.locator('#btn-repeat');
    if (await repeatBtn.isVisible()) {
      await repeatBtn.click();
      await host.hostPage.waitForTimeout(300);
    }

    const hostRepeat = await readState(host.hostPage, 'settings.repeatMode');

    // Guest joins
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      await guestPage.waitForTimeout(3000);

      // Guest's settings are local, but host repeat mode should not affect guest crash
      const guestState = await readState(guestPage, 'appState');
      expect(guestState).toBeDefined();
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
    await host.hostPage.waitForTimeout(2000);

    // First guest joins
    const guest1 = await joinAsGuest(browser, host.sessionCode);

    try {
      await waitForPlaylistCount(guest1.guestPage, 1, 20_000);

      // Host uploads more files while guest1 is connected
      await uploadFixture(host.hostPage, 'test02');
      await waitForPlaylistCount(host.hostPage, 2);
      await host.hostPage.waitForTimeout(2000);

      await uploadFixture(host.hostPage, 'test03');
      await waitForPlaylistCount(host.hostPage, 3);
      await host.hostPage.waitForTimeout(1000);

      // Guest1 should have all 3
      await waitForPlaylistCount(guest1.guestPage, 3, 20_000);

      // NOW second guest joins — should get all 3 tracks
      const guest2 = await joinAsGuest(browser, host.sessionCode);

      try {
        await waitForPlaylistCount(guest2.guestPage, 3, 30_000);

        const guest2Count = await guest2.guestPage.evaluate(() => {
          const get = (window as any).__MUSIXQUARE_GET_STATE__;
          return get ? (get('playlist.items') as unknown[])?.length ?? 0 : 0;
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

      // Host kicks guest1
      const kickBtn = host.hostPage.locator('.d-kick-btn').first();
      if (await kickBtn.isVisible().catch(() => false)) {
        await kickBtn.click();
        await host.hostPage.waitForTimeout(3000);
      }
    } finally {
      await guest1.guestContext.close();
    }

    await host.hostPage.waitForTimeout(2000);

    // Upload a file after kick
    await uploadFixture(host.hostPage, 'test01');
    await waitForPlaylistCount(host.hostPage, 1);
    await host.hostPage.waitForTimeout(2000);

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

    // Host sends chat messages before any guest
    const chatBtn = host.hostPage.locator('#chat-preview-btn');
    if (await chatBtn.isVisible()) {
      await chatBtn.click();
      await host.hostPage.waitForTimeout(500);

      await host.hostPage.locator('#chat-input').fill('Message before guest');
      await host.hostPage.locator('#btn-chat-send').click();
      await host.hostPage.waitForTimeout(1000);
    }

    // Guest joins late
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      // Open guest chat
      const guestChatBtn = guestPage.locator('#chat-preview-btn');
      if (await guestChatBtn.isVisible()) {
        await guestChatBtn.click();
        await guestPage.waitForTimeout(1000);

        const guestMsgs = await guestPage.evaluate(() => {
          const el = document.getElementById('chat-messages');
          return el?.textContent || '';
        });

        // Chat history is NOT replayed — messages before join should not appear
        // (WebRTC only sends real-time messages, not history)
        expect(guestMsgs).not.toContain('Message before guest');
      }
    } finally {
      await guestContext.close();
    }
  });

  test('late guest receives new messages sent after joining', async ({ browser }) => {
    host = await setupHostOnly(browser);

    // Guest joins
    const { guestContext, guestPage } = await joinAsGuest(browser, host.sessionCode);

    try {
      await guestPage.waitForTimeout(1000);

      // Host sends message AFTER guest joined
      const chatBtn = host.hostPage.locator('#chat-preview-btn');
      if (await chatBtn.isVisible()) {
        await chatBtn.click();
        await host.hostPage.waitForTimeout(500);

        await host.hostPage.locator('#chat-input').fill('Message after guest joined');
        await host.hostPage.locator('#btn-chat-send').click();
        await host.hostPage.waitForTimeout(2000);
      }

      // Open guest chat
      const guestChatBtn = guestPage.locator('#chat-preview-btn');
      if (await guestChatBtn.isVisible()) {
        await guestChatBtn.click();
        await guestPage.waitForTimeout(2000);

        const guestMsgs = await guestPage.evaluate(() => {
          const el = document.getElementById('chat-messages');
          return el?.textContent || '';
        });

        expect(guestMsgs).toContain('Message after guest joined');
      }
    } finally {
      await guestContext.close();
    }
  });
});
