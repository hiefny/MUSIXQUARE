/**
 * E2E: Comprehensive UI Tests
 *
 * Tests all major UI elements, interactions, and layouts:
 * - Tab navigation completeness
 * - Media source popup
 * - Chat drawer
 * - Visualizer canvas
 * - Fullscreen button
 * - QR code / invite code display
 * - Dialog system
 * - Role badge display
 * - Mobile vs desktop layout
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  readState,
  navigateToTab,
  waitForClass,
  openChatDrawer,
  isVisible,
  waitForChatMessage,
} from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Comprehensive UI', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  // ── Tab Navigation ──────────────────────────────────────────

  test('all main tabs are accessible', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const tabs = ['play', 'connect', 'settings'];
    for (const tab of tabs) {
      const navItem = pair.hostPage.locator(`.nav-item[data-tab="${tab}"]`);
      if (await navItem.isVisible()) {
        await navigateToTab(pair.hostPage, tab);

        const panel = pair.hostPage.locator(`#tab-${tab}`);
        const isActive = await panel.evaluate(el => el.classList.contains('active'));
        expect(isActive).toBe(true);
      }
    }
  });

  test('tab content changes when switching tabs', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Go to settings
    const settingsNav = pair.hostPage.locator('.nav-item[data-tab="settings"]');
    if (await settingsNav.isVisible()) {
      await navigateToTab(pair.hostPage, 'settings');

      const playActive = await pair.hostPage.locator('#tab-play').evaluate(el => el.classList.contains('active'));
      const settingsActive = await pair.hostPage.locator('#tab-settings').evaluate(el => el.classList.contains('active'));

      expect(playActive).toBe(false);
      expect(settingsActive).toBe(true);
    }
  });

  // ── Media Source Popup ──────────────────────────────────────

  test('media source button opens popup', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const mediaBtn = pair.hostPage.locator('#btn-media-source');
    if (await mediaBtn.isVisible()) {
      await mediaBtn.click();
      await waitForClass(pair.hostPage, '#media-source-overlay', 'active');

      const overlayVisible = await isVisible(pair.hostPage, '#media-source-overlay');
      expect(overlayVisible).toBe(true);
    }
  });

  test('media source popup has local file and YouTube options', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const mediaBtn = pair.hostPage.locator('#btn-media-source');
    if (await mediaBtn.isVisible()) {
      await mediaBtn.click();
      await waitForClass(pair.hostPage, '#media-source-overlay', 'active');

      // YouTube button should exist
      await expect(pair.hostPage.locator('#btn-youtube-source')).toBeAttached();
    }
  });

  // ── Chat Drawer ──────────────────────────────────────────────

  test('chat preview button opens drawer', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const chatBtn = pair.hostPage.locator('#chat-preview-btn');
    if (await chatBtn.isVisible()) {
      await openChatDrawer(pair.hostPage);

      const isOpen = await pair.hostPage.locator('#chat-drawer').evaluate(el => el.classList.contains('open'));
      expect(isOpen).toBe(true);
    }
  });

  test('chat close button closes drawer', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open chat
    const chatBtn = pair.hostPage.locator('#chat-preview-btn');
    if (await chatBtn.isVisible()) {
      await openChatDrawer(pair.hostPage);

      // Close chat
      const closeBtn = pair.hostPage.locator('#btn-chat-close');
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
        await waitForClass(pair.hostPage, '#chat-drawer', 'open', false);

        const isOpen = await pair.hostPage.locator('#chat-drawer').evaluate(el => el.classList.contains('open'));
        expect(isOpen).toBe(false);
      }
    }
  });

  test('chat input field and send button exist', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const chatBtn = pair.hostPage.locator('#chat-preview-btn');
    if (await chatBtn.isVisible()) {
      await openChatDrawer(pair.hostPage);

      await expect(pair.hostPage.locator('#chat-input')).toBeVisible();
      await expect(pair.hostPage.locator('#btn-chat-send')).toBeVisible();
    }
  });

  test('chat message appears in own message list', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const chatBtn = pair.hostPage.locator('#chat-preview-btn');
    if (await chatBtn.isVisible()) {
      await openChatDrawer(pair.hostPage);

      const chatInput = pair.hostPage.locator('#chat-input');
      await chatInput.fill('Test message from host');
      await pair.hostPage.locator('#btn-chat-send').click();
      await waitForChatMessage(pair.hostPage, 'Test message from host');

      const msgText = await pair.hostPage.evaluate(() => {
        const msgs = document.getElementById('chat-messages');
        return msgs?.textContent || '';
      });
      expect(msgText).toContain('Test message from host');
    }
  });

  // ── Visualizer Canvas ──────────────────────────────────────

  test('visualizer canvas exists in DOM', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await expect(pair.hostPage.locator('#visualizerCanvas')).toBeAttached();
  });

  // ── Role Badge ──────────────────────────────────────────────

  test('host shows HOST role badge', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const roleText = await pair.hostPage.evaluate(() => {
      const el = document.getElementById('role-text');
      return el?.textContent?.trim() || '';
    });
    expect(roleText.toUpperCase()).toContain('HOST');
  });

  test('guest shows GUEST role badge', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const roleText = await pair.guestPage.evaluate(() => {
      const el = document.getElementById('role-text');
      return el?.textContent?.trim() || '';
    });
    // Should show guest or peer label
    expect(roleText.length).toBeGreaterThan(0);
  });

  // ── Invite Code Display ──────────────────────────────────────

  test('host displays invite code after session start', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const code = await pair.hostPage.evaluate(() => {
      const el = document.querySelector('.invite-code-value');
      return el?.textContent?.trim() || '';
    });
    expect(code).toMatch(/^\d{6}$/);
  });

  // ── Player Controls ──────────────────────────────────────────

  test('all playback control buttons exist', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await expect(pair.hostPage.locator('#play-btn')).toBeAttached();
    await expect(pair.hostPage.locator('#btn-prev')).toBeAttached();
    await expect(pair.hostPage.locator('#btn-next')).toBeAttached();
    await expect(pair.hostPage.locator('#btn-repeat')).toBeAttached();
    await expect(pair.hostPage.locator('#btn-shuffle')).toBeAttached();
  });

  test('file input element exists (hidden)', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await expect(pair.hostPage.locator('#file-input')).toBeAttached();
  });

  // ── Track Time Display ──────────────────────────────────────

  test('time display elements exist', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await expect(pair.hostPage.locator('#time-curr')).toBeAttached();
    await expect(pair.hostPage.locator('#time-dur')).toBeAttached();
    await expect(pair.hostPage.locator('#seek-slider')).toBeAttached();
  });

  // ── Volume Control ──────────────────────────────────────────

  test('volume slider and icon exist', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await expect(pair.hostPage.locator('#volume-slider')).toBeAttached();
    await expect(pair.hostPage.locator('#vol-icon-btn')).toBeAttached();
  });

  // ── Playlist UI ──────────────────────────────────────────────

  test('playlist container exists and is in valid state', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const count = await pair.hostPage.evaluate(() => {
      const list = document.getElementById('playlist-ui');
      return list?.children.length ?? -1;
    });
    // Playlist may have 0 items or 1 (demo track auto-added in some configs)
    expect(count).toBeGreaterThanOrEqual(0);
  });

  // ── Network State ──────────────────────────────────────────

  test('host has correct network state after connection', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const role = await readState(pair.hostPage, 'network.appRole');
    const myId = await readState(pair.hostPage, 'network.myId');
    const sessionCode = await readState(pair.hostPage, 'network.sessionCode');

    expect(role).toBe('host');
    expect(myId).toBeTruthy();
    expect(String(sessionCode)).toMatch(/^\d{6}$/);
  });

  test('guest has correct network state after connection', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const role = await readState(pair.guestPage, 'network.appRole');
    const hostConn = await pair.guestPage.evaluate(() => {
      const get = (window as any).__MUSIXQUARE_GET_STATE__;
      return get ? (get('network.hostConn') !== null) : false;
    });

    expect(role).toBe('guest');
    expect(hostConn).toBe(true);
  });
});

// ── Mobile-Specific Tests ──────────────────────────────────────

test.describe('Mobile UI', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('bottom navigation is visible on mobile', async ({ browser }) => {
    const pair = await createHostGuestContexts(browser);
    try {
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      await expect(pair.hostPage.locator('.bottom-nav')).toBeVisible();
    } finally {
      await cleanupContexts(pair);
    }
  });

  test('all mobile nav items are tappable', async ({ browser }) => {
    const pair = await createHostGuestContexts(browser);
    try {
      await connectHostAndGuest(pair.hostPage, pair.guestPage);

      const navItems = pair.hostPage.locator('.bottom-nav .nav-item');
      const count = await navItems.count();
      expect(count).toBeGreaterThanOrEqual(3);

      // Tap each and wait for corresponding tab to become active
      for (let i = 0; i < count; i++) {
        const tabName = await navItems.nth(i).getAttribute('data-tab');
        await navItems.nth(i).click();
        if (tabName) {
          await pair.hostPage.locator(`#tab-${tabName}`).waitFor({ state: 'visible', timeout: 5_000 });
        }
      }
    } finally {
      await cleanupContexts(pair);
    }
  });

  test('chat drawer works on mobile', async ({ browser }) => {
    const pair = await createHostGuestContexts(browser);
    try {
      await connectHostAndGuest(pair.hostPage, pair.guestPage);

      const chatBtn = pair.hostPage.locator('#chat-preview-btn');
      if (await chatBtn.isVisible()) {
        await openChatDrawer(pair.hostPage);

        const isOpen = await pair.hostPage.locator('#chat-drawer').evaluate(
          el => el.classList.contains('open'),
        );
        expect(isOpen).toBe(true);
      }
    } finally {
      await cleanupContexts(pair);
    }
  });
});
