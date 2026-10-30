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
import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  getPageErrors,
  trackPageErrors,
  useAnonymousAccountSession,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { injectPeerServer } from './helpers/peer-server.ts';
import { connectHostAndGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import {
  isVisible,
  navigateToTab,
  openChatDrawer,
  readState,
  sendChat,
  waitForChatMessage,
  waitForClass,
} from './helpers/wait.ts';

let pair: HostGuestPair;

const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function useMobileHostViewport(): Promise<void> {
  await pair.hostPage.setViewportSize(MOBILE_VIEWPORT);
}

type BusWindow = { __MUSIXQUARE_BUS__: { emit: (...args: unknown[]) => void } };

/** Sends a message, then reaches it from the input with Shift+Tab. */
async function focusSentMessage(page: Page, text: string): Promise<Locator> {
  await sendChat(page, text);
  await waitForChatMessage(page, text);
  await expect(page.locator('#chat-input')).toBeFocused();
  // The input's clear button leaves with the sent text on a later frame.
  await expect(page.locator('#chat-drawer .clearable-editor-button')).toHaveCount(0);
  await page.keyboard.press('Shift+Tab');
  const message = page.locator('#chat-messages .chat-bubble', { hasText: text });
  await expect(message).toBeFocused();
  return message;
}

/** The room-wide clear that a moderator's /clear sends to every member. */
async function clearRoomChat(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as BusWindow).__MUSIXQUARE_BUS__.emit('chat:clear-all');
  });
}

/** System notices take no focus; past the 200-row cap they prune the oldest rows. */
async function addRoomNotices(page: Page, count: number): Promise<void> {
  await page.evaluate((total) => {
    const bus = (window as unknown as BusWindow).__MUSIXQUARE_BUS__;
    for (let index = 1; index <= total; index += 1) {
      bus.emit('chat:system-message', `Room notice ${index}`);
    }
  }, count);
}

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
      await navigateToTab(pair.hostPage, tab);

      const panel = pair.hostPage.locator(`#tab-${tab}`);
      await expect(panel).toHaveClass(/active/);
      await expect(navItem).toHaveAttribute('aria-selected', 'true');
      await expect(navItem).toHaveAttribute('tabindex', '0');
    }
  });

  test('tab content changes when switching tabs', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await navigateToTab(pair.hostPage, 'settings');

    await expect(pair.hostPage.locator('#tab-play')).not.toHaveClass(/active/);
    await expect(pair.hostPage.locator('#tab-settings')).toHaveClass(/active/);
    await expect(pair.hostPage.locator('#nav-settings')).toHaveAttribute('aria-selected', 'true');
    await expect(pair.hostPage.locator('#nav-play')).toHaveAttribute('aria-selected', 'false');
  });

  // ── Media Source Popup ──────────────────────────────────────

  test('media source button opens popup', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const mediaBtn = pair.hostPage.locator('#btn-media-source');
    await expect(mediaBtn).toBeVisible();
    await mediaBtn.click();
    await waitForClass(pair.hostPage, '#media-source-overlay', 'active');

    const overlayVisible = await isVisible(pair.hostPage, '#media-source-overlay');
    expect(overlayVisible).toBe(true);
  });

  test('media source popup has local file and YouTube options', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const mediaBtn = pair.hostPage.locator('#btn-media-source');
    await expect(mediaBtn).toBeVisible();
    await mediaBtn.click();
    await waitForClass(pair.hostPage, '#media-source-overlay', 'active');

    await expect(pair.hostPage.locator('#btn-youtube-source')).toBeVisible();
  });

  // ── Chat Drawer ──────────────────────────────────────────────

  test('chat preview button opens drawer', async () => {
    await useMobileHostViewport();
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const chatBtn = pair.hostPage.locator('#chat-preview-btn');
    await expect(chatBtn).toBeVisible();
    await openChatDrawer(pair.hostPage);

    const isOpen = await pair.hostPage
      .locator('#chat-drawer')
      .evaluate((el) => el.classList.contains('open'));
    expect(isOpen).toBe(true);
  });

  test('chat backdrop closes the mobile drawer', async () => {
    await useMobileHostViewport();
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const chatBtn = pair.hostPage.locator('#chat-preview-btn');
    await expect(chatBtn).toBeVisible();
    await openChatDrawer(pair.hostPage);

    // A bottom sheet keeps its outside-tap close (owner decision 2026-10-28).
    const backdrop = pair.hostPage.locator('#chat-backdrop');
    await expect(backdrop).toBeVisible();
    const backdropPoint = await pair.hostPage.evaluate(() => {
      const headerBottom = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;
      const drawerTop = document.getElementById('chat-drawer')?.getBoundingClientRect().top ?? 0;
      return { x: 8, y: headerBottom + (drawerTop - headerBottom) / 2 };
    });
    const hitTarget = await pair.hostPage.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.id,
      backdropPoint,
    );
    expect(hitTarget).toBe('chat-backdrop');
    await pair.hostPage.mouse.click(backdropPoint.x, backdropPoint.y);
    await waitForClass(pair.hostPage, '#chat-drawer', 'open', false);

    const isOpen = await pair.hostPage
      .locator('#chat-drawer')
      .evaluate((el) => el.classList.contains('open'));
    expect(isOpen).toBe(false);
  });

  test('chat sheet shows no Close and its handle closes it by tap and keyboard', async () => {
    // Owner decision (2026-10-30): the phone sheet shows no Close (9.0.20 put
    // one at the top start of its handle row). As before 9.0.20, its drag
    // handle, an outside tap (above) and Escape close it.
    await useMobileHostViewport();
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await expect
      .poll(() =>
        pair.hostPage
          .locator('#chat-drawer')
          .evaluate((drawer) => getComputedStyle(drawer).transform),
      )
      .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/u);

    const drawer = pair.hostPage.locator('#chat-drawer');
    const handle = drawer.locator('.chat-drawer-header');
    await expect(drawer.getByRole('button', { name: 'Close chat' })).toHaveCount(0);
    await expect(handle).toHaveAttribute('role', 'separator');
    await expect(handle).toHaveAccessibleName('Chat');
    const geometry = await pair.hostPage.evaluate(() => {
      const sheet = document.getElementById('chat-drawer')!.getBoundingClientRect();
      const header = document.querySelector('.chat-drawer-header')!.getBoundingClientRect();
      const topStart = document.elementFromPoint(sheet.left + 26, header.top + header.height / 2);
      return {
        headerOffset: header.top - sheet.top,
        headerHeight: header.height,
        topStartIsHandle: topStart?.classList.contains('chat-drawer-header') ?? false,
      };
    });
    // The 36px handle row is the top of the sheet, and its start, where the
    // Close was, is the handle itself.
    expect(geometry.headerOffset).toBeCloseTo(0, 0);
    expect(geometry.headerHeight).toBeCloseTo(36, 0);
    expect(geometry.topStartIsHandle).toBe(true);

    // The first Tab in the sheet reaches the handle, and Enter on it closes.
    await pair.hostPage.keyboard.press('Tab');
    await expect(handle).toBeFocused();
    await pair.hostPage.keyboard.press('Enter');
    await waitForClass(pair.hostPage, '#chat-drawer', 'open', false);

    await openChatDrawer(pair.hostPage);
    await handle.click();
    await waitForClass(pair.hostPage, '#chat-drawer', 'open', false);

    await openChatDrawer(pair.hostPage);
    await pair.hostPage.keyboard.press('Escape');
    await waitForClass(pair.hostPage, '#chat-drawer', 'open', false);
  });

  test('chat input field and send button exist', async () => {
    await useMobileHostViewport();
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const chatBtn = pair.hostPage.locator('#chat-preview-btn');
    await expect(chatBtn).toBeVisible();
    await openChatDrawer(pair.hostPage);

    await expect(pair.hostPage.locator('#chat-input')).toBeVisible();
    await expect(pair.hostPage.locator('#btn-chat-send')).toBeVisible();
  });

  test('chat message appears in own message list', async () => {
    await useMobileHostViewport();
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    const chatBtn = pair.hostPage.locator('#chat-preview-btn');
    await expect(chatBtn).toBeVisible();
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
  });

  // ── Visualizer Canvas ──────────────────────────────────────

  test('visualizer canvas exists in DOM', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await expect(pair.hostPage.locator('#visualizerCanvas')).toBeAttached();
  });

  // ── Account Entry Point ────────────────────────────────────────

  test('anonymous host shows LOGIN account entry point', async () => {
    await useAnonymousAccountSession(pair.hostPage);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await expect(pair.hostPage.locator('#role-text')).toHaveText('LOGIN');
    await expect(pair.hostPage.locator('#role-badge')).toHaveAttribute(
      'aria-controls',
      'account-dialog',
    );
  });

  test('anonymous guest shows LOGIN account entry point', async () => {
    await useAnonymousAccountSession(pair.guestPage);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await expect(pair.guestPage.locator('#role-text')).toHaveText('LOGIN');
    await expect(pair.guestPage.locator('#role-badge')).toHaveAttribute(
      'aria-controls',
      'account-dialog',
    );
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
      return get ? get('network.hostConn') !== null : false;
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

      for (let i = 0; i < count; i++) {
        const tabName = await navItems.nth(i).getAttribute('data-tab');
        await navItems.nth(i).click();
        if (tabName) {
          await pair.hostPage
            .locator(`#tab-${tabName}`)
            .waitFor({ state: 'visible', timeout: 5_000 });
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
      await expect(chatBtn).toBeVisible();
      await openChatDrawer(pair.hostPage);

      const isOpen = await pair.hostPage
        .locator('#chat-drawer')
        .evaluate((el) => el.classList.contains('open'));
      expect(isOpen).toBe(true);
    } finally {
      await cleanupContexts(pair);
    }
  });

  test('chat sheet Tab and Shift+Tab reach only the controls it shows', async ({ page }) => {
    // The pinned notice stays in the sheet while hidden. A Tab cycle that still
    // counted its two buttons left Tab on the handle; they join the cycle only
    // while the notice shows.
    trackPageErrors(page);
    await page.route('**/api/announcement/current', (route) =>
      route.fulfill({ json: { enabled: false } }),
    );
    await injectPeerServer(page);
    await setupHostAndStart(page);
    await openChatDrawer(page);
    await expect(page.locator('#chat-drawer')).toHaveAttribute('aria-modal', 'true');
    const notice = page.locator('#chat-pinned-notice');
    await expect(notice).toBeHidden();
    await sendChat(page, 'Tab reaches this message');
    await waitForChatMessage(page, 'Tab reaches this message');
    await expect(page.locator('#chat-input')).toBeFocused();
    // The input's clear button leaves with the sent text on a later frame.
    await expect(page.locator('#chat-drawer .clearable-editor-button')).toHaveCount(0);

    const press = async (key: 'Tab' | 'Shift+Tab', count: number): Promise<string[]> => {
      const reached: string[] = [];
      for (let step = 0; step < count; step += 1) {
        await page.keyboard.press(key);
        reached.push(
          await page.evaluate(() => {
            const active = document.activeElement;
            if (active?.classList.contains('chat-drawer-header')) return 'handle';
            if (active?.classList.contains('chat-bubble')) return 'message';
            return active?.id ?? '';
          }),
        );
      }
      return reached;
    };

    // With the notice hidden, the cycle is the handle, the message, the input
    // and Send.
    expect(await press('Tab', 4)).toEqual(['btn-chat-send', 'handle', 'message', 'chat-input']);
    expect(await press('Shift+Tab', 4)).toEqual([
      'message',
      'handle',
      'btn-chat-send',
      'chat-input',
    ]);

    await page.evaluate(() => {
      const bus = (
        window as unknown as { __MUSIXQUARE_BUS__: { emit: (...args: unknown[]) => void } }
      ).__MUSIXQUARE_BUS__;
      bus.emit('chat:notice-message', 'HOST', 'Tab reaches this notice', Date.now());
    });
    await expect(notice).toBeVisible();
    // The shown notice's open and dismiss buttons follow the handle.
    expect(await press('Tab', 6)).toEqual([
      'btn-chat-send',
      'handle',
      'btn-chat-notice-open',
      'btn-chat-notice-close',
      'message',
      'chat-input',
    ]);
    expect(await press('Shift+Tab', 6)).toEqual([
      'message',
      'btn-chat-notice-close',
      'btn-chat-notice-open',
      'handle',
      'btn-chat-send',
      'chat-input',
    ]);

    // Enter on the notice's X dismisses it. Focus moves to the sheet itself
    // rather than the page, so a screen reader stays in the Chat dialog, and the
    // cycle skips the notice again.
    expect(await press('Shift+Tab', 2)).toEqual(['message', 'btn-chat-notice-close']);
    await page.keyboard.press('Enter');
    await expect(notice).toBeHidden();
    await expect(page.locator('#chat-drawer')).toBeFocused();
    expect(await press('Tab', 3)).toEqual(['handle', 'message', 'chat-input']);
    expect(getPageErrors(page).map((error) => error.message)).toEqual([]);
  });

  test('chat sheet keeps focus when a pinned notice is withdrawn under it', async ({ page }) => {
    // A notice withdrawn while its open button had focus hid that button under
    // focus, and the browser then moved focus to the page itself.
    trackPageErrors(page);
    await page.route('**/api/announcement/current', (route) =>
      route.fulfill({ json: { enabled: false } }),
    );
    await injectPeerServer(page);
    await setupHostAndStart(page);
    await openChatDrawer(page);
    const drawer = page.locator('#chat-drawer');
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    const notice = page.locator('#chat-pinned-notice');
    const open = page.locator('#btn-chat-notice-open');
    const dialog = page.locator('#dialog-overlay');
    const emit = (...args: unknown[]): Promise<void> =>
      page.evaluate((busArgs) => {
        const bus = (
          window as unknown as { __MUSIXQUARE_BUS__: { emit: (...args: unknown[]) => void } }
        ).__MUSIXQUARE_BUS__;
        bus.emit(...busArgs);
      }, args);
    const showServiceNotice = (id: string): Promise<void> =>
      emit('chat:notice-message', 'MUSIXQUARE', 'A service notice', Date.now(), {
        source: 'service',
        id,
      });

    // Escape from the reading dialog returns focus to the open button.
    await showServiceNotice('withdrawn-under-focus');
    await expect(notice).toBeVisible();
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveClass(/show/);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toHaveClass(/show/);
    await expect(open).toBeFocused();
    // Withdrawn while its open button has focus.
    await emit('chat:service-notice-withdrawn', 'withdrawn-under-focus');
    await expect(notice).toBeHidden();
    await expect(drawer).toBeFocused();

    // Withdrawn while its reading dialog is open: the closing dialog returns
    // focus to the open button, which the withdrawn notice then hides.
    await showServiceNotice('withdrawn-while-reading');
    await expect(notice).toBeVisible();
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveClass(/show/);
    await emit('chat:service-notice-withdrawn', 'withdrawn-while-reading');
    await expect(dialog).not.toHaveClass(/show/);
    await expect(notice).toBeHidden();
    await expect(drawer).toBeFocused();
    await expect(drawer).toHaveClass(/\bopen\b/);
    expect(getPageErrors(page).map((error) => error.message)).toEqual([]);
  });

  test('chat sheet keeps focus when the message under it is cleared or pruned', async ({
    page,
  }) => {
    // A focused message that a cleared room history or the 200-row cap removed
    // took focus to the page with it, out of the Chat dialog.
    trackPageErrors(page);
    await page.route('**/api/announcement/current', (route) =>
      route.fulfill({ json: { enabled: false } }),
    );
    await injectPeerServer(page);
    await setupHostAndStart(page);
    await openChatDrawer(page);
    const drawer = page.locator('#chat-drawer');
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    const handle = page.locator('#chat-drawer .chat-drawer-header');

    const cleared = await focusSentMessage(page, 'A message the room clears');
    await clearRoomChat(page);
    await expect(cleared).toHaveCount(0);
    await expect(drawer).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(handle).toBeFocused();

    const pruned = await focusSentMessage(page, 'A message the cap prunes');
    await addRoomNotices(page, 200);
    await expect(pruned).toHaveCount(0);
    await expect(drawer).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(handle).toBeFocused();
    await expect(drawer).toHaveClass(/\bopen\b/);
    expect(getPageErrors(page).map((error) => error.message)).toEqual([]);
  });
});

test.describe('Desktop chat panel', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Enter on the pinned notice X leaves focus in the chat panel', async ({ page }) => {
    // The desktop panel is a region, not a modal sheet, and the dismissed X
    // left focus on the page there too.
    trackPageErrors(page);
    await page.route('**/api/announcement/current', (route) =>
      route.fulfill({ json: { enabled: false } }),
    );
    await injectPeerServer(page);
    await setupHostAndStart(page);
    const drawer = page.locator('#chat-drawer');
    await expect(drawer).toHaveAttribute('role', 'region');
    await sendChat(page, 'Tab reaches this message');
    await waitForChatMessage(page, 'Tab reaches this message');
    await page.evaluate(() => {
      const bus = (
        window as unknown as { __MUSIXQUARE_BUS__: { emit: (...args: unknown[]) => void } }
      ).__MUSIXQUARE_BUS__;
      bus.emit('chat:notice-message', 'HOST', 'A pinned room notice', Date.now());
    });
    const notice = page.locator('#chat-pinned-notice');
    await expect(notice).toBeVisible();
    await page.locator('#btn-chat-notice-open').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#btn-chat-notice-close')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(notice).toBeHidden();
    await expect(drawer).toBeFocused();
    // The next Tab continues inside the panel, at its message.
    await page.keyboard.press('Tab');
    await expect(
      page.locator('#chat-messages .chat-bubble', { hasText: 'Tab reaches this message' }),
    ).toBeFocused();
    expect(getPageErrors(page).map((error) => error.message)).toEqual([]);
  });

  test('a message cleared or pruned under focus leaves focus in the chat panel', async ({
    page,
  }) => {
    trackPageErrors(page);
    await page.route('**/api/announcement/current', (route) =>
      route.fulfill({ json: { enabled: false } }),
    );
    await injectPeerServer(page);
    await setupHostAndStart(page);
    const drawer = page.locator('#chat-drawer');
    await expect(drawer).toHaveAttribute('role', 'region');
    const input = page.locator('#chat-input');

    const cleared = await focusSentMessage(page, 'A message the room clears');
    await clearRoomChat(page);
    await expect(cleared).toHaveCount(0);
    await expect(drawer).toBeFocused();
    // The next Tab continues inside the panel; its notices take no focus.
    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();

    const pruned = await focusSentMessage(page, 'A message the cap prunes');
    await addRoomNotices(page, 200);
    await expect(pruned).toHaveCount(0);
    await expect(drawer).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();
    expect(getPageErrors(page).map((error) => error.message)).toEqual([]);
  });
});
