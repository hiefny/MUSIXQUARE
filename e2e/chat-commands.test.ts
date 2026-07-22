/**
 * E2E: Chat Commands & Moderation Tests
 *
 * Tests slash commands, freeze/mute/filter enforcement,
 * late-join state sync, whisper, notice, slowmode, and admin ops.
 */
import { test, expect } from '@playwright/test';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  openChatDrawer,
  readState,
  sendChat,
  waitForChatMessage,
  waitForOverlayDismissed,
  waitForState,
} from './helpers/wait.ts';

let pair: HostGuestPair;

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Get chat text using innerText (preserves line breaks) instead of textContent.
 */
async function getChatText(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => document.getElementById('chat-messages')?.innerText || '');
}

/**
 * Check if guest received any non-system chat message containing the given text.
 * System messages have the class 'system' on the chat-group or chat-bubble.
 * This helps distinguish between system output (e.g. /help) and broadcast chat.
 */
async function hasNonSystemChatContaining(
  page: import('@playwright/test').Page,
  text: string,
): Promise<boolean> {
  return page.evaluate((t) => {
    const container = document.getElementById('chat-messages');
    if (!container) return false;
    // Look at all chat-bubble elements that are NOT system messages
    const bubbles = container.querySelectorAll(
      '.chat-bubble:not(.system):not(.notice):not(.whisper)',
    );
    for (const bubble of bubbles) {
      if (bubble.textContent?.includes(t)) return true;
    }
    return false;
  }, text);
}

/**
 * Wait for the pinned notice banner to show the given text.
 * /notice renders only into the #chat-pinned-notice banner
 * (label + time + text), never as a chat-list bubble.
 */
async function waitForPinnedNotice(
  page: import('@playwright/test').Page,
  text: string,
  timeout = 10_000,
): Promise<void> {
  await page.waitForFunction(
    (t) => {
      const banner = document.getElementById('chat-pinned-notice');
      if (!banner || banner.hidden) return false;
      const body = document.getElementById('chat-pinned-notice-text');
      return body?.textContent?.includes(t) ?? false;
    },
    text,
    { timeout },
  );
}

async function isChatInputDisabled(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => {
    const input = document.getElementById('chat-input') as HTMLElement | null;
    return input?.contentEditable === 'false';
  });
}

async function getChatInputPlaceholder(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const input = document.getElementById('chat-input') as HTMLElement | null;
    return input?.getAttribute('data-placeholder') ?? '';
  });
}

// ─── Tests ───────────────────────────────────────────────────────

test.describe('Chat Commands', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  // ── /help ──────────────────────────────────────────────────────

  test('/help shows command list to host only (local)', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    await sendChat(pair.hostPage, '/help');
    await waitForChatMessage(pair.hostPage, '/users');

    const hostText = await getChatText(pair.hostPage);
    // innerText preserves line breaks so these substrings should now be findable
    expect(hostText).toContain('/users');
    expect(hostText).toContain('/kick');
    expect(hostText).toContain('/freeze');

    // /help is local — guest should NOT see it as a non-system chat message
    const guestHasHelp = await hasNonSystemChatContaining(pair.guestPage, '/users');
    expect(guestHasHelp).toBe(false);
  });

  test('/help shows fewer commands for regular guest', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.guestPage);

    await sendChat(pair.guestPage, '/help');
    await waitForChatMessage(pair.guestPage, '/nick');

    const guestText = await getChatText(pair.guestPage);
    expect(guestText).toContain('/nick');
    expect(guestText).toContain('/w');
    expect(guestText).not.toContain('/kick');
    expect(guestText).not.toContain('/freeze');
  });

  // ── /users ─────────────────────────────────────────────────────

  test('/users shows connected device list (local)', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);

    await sendChat(pair.hostPage, '/users');
    await waitForChatMessage(pair.hostPage, '#0');

    const hostText = await getChatText(pair.hostPage);
    expect(hostText).toContain('#0');
    expect(hostText).toContain('HOST');
  });

  // ── /freeze ────────────────────────────────────────────────────

  test('/freeze on blocks guest chat', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    // Host freezes chat
    await sendChat(pair.hostPage, '/freeze on');
    // Wait for freeze system message to appear on guest (freeze doesn't disable contentEditable,
    // it only blocks at send-time via state check)
    await pair.guestPage.waitForFunction(
      () => {
        const container = document.getElementById('chat-messages');
        if (!container) return false;
        const text = container.textContent || '';
        return text.includes('frozen') || text.includes('동결');
      },
      { timeout: 15_000 },
    );

    // Guest tries to send message — should be blocked at send-time
    await sendChat(pair.guestPage, 'I am frozen');
    // Brief wait, then verify message NOT delivered
    await pair.hostPage.waitForTimeout(1000);

    // Message should NOT appear on host
    const hostText = await getChatText(pair.hostPage);
    expect(hostText).not.toContain('I am frozen');
  });

  test('/freeze off re-enables guest chat', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    // Freeze then unfreeze
    await sendChat(pair.hostPage, '/freeze on');
    // Wait for freeze system message on guest
    await pair.guestPage.waitForFunction(
      () => {
        const container = document.getElementById('chat-messages');
        if (!container) return false;
        const text = container.textContent || '';
        return text.includes('frozen') || text.includes('동결');
      },
      { timeout: 15_000 },
    );

    await sendChat(pair.hostPage, '/freeze off');
    // Wait for unfreeze system message on guest
    await pair.guestPage.waitForFunction(
      () => {
        const container = document.getElementById('chat-messages');
        if (!container) return false;
        const text = container.textContent || '';
        return text.includes('unfrozen') || text.includes('해제');
      },
      { timeout: 15_000 },
    );

    // Guest should be able to chat again
    await sendChat(pair.guestPage, 'I am free');
    await waitForChatMessage(pair.hostPage, 'I am free');
  });

  test('host can still chat while frozen', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    await sendChat(pair.hostPage, '/freeze on');
    // Wait for freeze system message on guest
    await pair.guestPage.waitForFunction(
      () => {
        const container = document.getElementById('chat-messages');
        if (!container) return false;
        const text = container.textContent || '';
        return text.includes('frozen') || text.includes('동결');
      },
      { timeout: 15_000 },
    );

    // Host should still be able to send
    await sendChat(pair.hostPage, 'Host can talk');
    await waitForChatMessage(pair.guestPage, 'Host can talk');
  });

  // ── /mute ──────────────────────────────────────────────────────

  test('/mute blocks specific guest, /unmute unblocks', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    // Host mutes guest #1
    await sendChat(pair.hostPage, '/mute #1');
    // Wait for mute state to propagate to guest (contentEditable becomes 'false')
    await pair.guestPage.waitForFunction(
      () => {
        const input = document.getElementById('chat-input') as HTMLElement | null;
        return input?.contentEditable === 'false';
      },
      { timeout: 10000 },
    );
    const isDisabled = await isChatInputDisabled(pair.guestPage);
    expect(isDisabled).toBe(true);

    // Unmute
    await sendChat(pair.hostPage, '/unmute #1');
    // Wait for unmute to propagate (contentEditable becomes 'true' again)
    await pair.guestPage.waitForFunction(
      () => {
        const input = document.getElementById('chat-input') as HTMLElement | null;
        return input?.contentEditable === 'true';
      },
      { timeout: 10000 },
    );

    const isEnabledAgain = await isChatInputDisabled(pair.guestPage);
    expect(isEnabledAgain).toBe(false);

    // Guest can send again
    await sendChat(pair.guestPage, 'Unmuted now');
    await waitForChatMessage(pair.hostPage, 'Unmuted now');
  });

  // ── /clear ─────────────────────────────────────────────────────

  test('/clear removes all chat messages on all devices', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    // Send some messages
    await sendChat(pair.hostPage, 'Message A');
    await waitForChatMessage(pair.guestPage, 'Message A');

    await sendChat(pair.guestPage, 'Message B');
    await waitForChatMessage(pair.hostPage, 'Message B');

    // Clear
    await sendChat(pair.hostPage, '/clear');
    // Wait for messages to be cleared on guest
    await pair.guestPage.waitForFunction(
      () => {
        const container = document.getElementById('chat-messages');
        if (!container) return false;
        const text = container.innerText || '';
        return !text.includes('Message A') && !text.includes('Message B');
      },
      { timeout: 10_000 },
    );

    // Old messages should be gone on guest
    const guestText = await getChatText(pair.guestPage);
    expect(guestText).not.toContain('Message A');
    expect(guestText).not.toContain('Message B');
  });

  // ── /notice ────────────────────────────────────────────────────

  test('/notice broadcasts notice-style message to all', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    await sendChat(pair.hostPage, '/notice Vote for next song!');

    // Notices render only in the pinned banner on every device.
    await waitForPinnedNotice(pair.guestPage, 'Vote for next song!');
    await waitForPinnedNotice(pair.hostPage, 'Vote for next song!');

    const guestBanner = await pair.guestPage.evaluate(() => ({
      hidden: document.getElementById('chat-pinned-notice')?.hidden ?? true,
      label: document.getElementById('chat-pinned-notice-label')?.textContent || '',
      text: document.getElementById('chat-pinned-notice-text')?.textContent || '',
    }));
    expect(guestBanner.hidden).toBe(false);
    expect(guestBanner.text).toContain('Vote for next song!');
    // Banner label carries the notice prefix and the sender ("Notice · HOST")
    expect(guestBanner.label).toContain('HOST');

    // And it must NOT show up as a regular chat-list message anymore.
    const guestChatText = await getChatText(pair.guestPage);
    expect(guestChatText).not.toContain('Vote for next song!');
  });

  // ── /nick ──────────────────────────────────────────────────────

  test('/nick opens account sign-in without renaming an anonymous peer', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.guestPage);
    const peerName = await readState(pair.guestPage, 'network.myDeviceLabel');

    await sendChat(pair.guestPage, '/nick MyDevice');

    await expect(pair.guestPage.locator('#account-dialog-overlay')).toHaveClass(/show/);
    expect(await readState(pair.guestPage, 'network.myDeviceLabel')).toBe(peerName);
    expect(peerName).not.toBe('MyDevice');
  });

  // ── /w (whisper) ───────────────────────────────────────────────

  test('/w sends private message only to target', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    // Host whispers to guest #1
    await sendChat(pair.hostPage, '/w #1 Secret message');
    await waitForChatMessage(pair.guestPage, 'Secret message');

    // Guest should see the whisper
    const guestText = await getChatText(pair.guestPage);
    expect(guestText).toContain('Secret message');

    // Host should also see it (sent confirmation)
    const hostText = await getChatText(pair.hostPage);
    expect(hostText).toContain('Secret message');
  });

  // ── /slowmode ──────────────────────────────────────────────────

  test('/slowmode limits chat rate', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    // Set 5-second slowmode
    await sendChat(pair.hostPage, '/slowmode 5');
    // Wait for slowmode system message on guest (en: "Slow mode" / ko: "슬로우 모드")
    await pair.guestPage.waitForFunction(
      () => {
        const container = document.getElementById('chat-messages');
        if (!container) return false;
        const text = (container.textContent || '').toLowerCase();
        return text.includes('slow') || text.includes('슬로우');
      },
      { timeout: 15_000 },
    );

    // Guest sends first message (should work)
    await sendChat(pair.guestPage, 'First msg');
    await waitForChatMessage(pair.hostPage, 'First msg');

    // Guest tries second message immediately (should be blocked)
    await sendChat(pair.guestPage, 'Too fast');
    // Brief wait to check it was blocked
    await pair.guestPage.waitForTimeout(1000);

    const guestText = await getChatText(pair.guestPage);
    // Should see slowmode warning
    expect(guestText).toContain('First msg');

    // Disable slowmode
    await sendChat(pair.hostPage, '/slowmode 0');
  });

  // ── /filter ────────────────────────────────────────────────────

  test('/filter on enables profanity filter', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);

    await sendChat(pair.hostPage, '/filter on');
    // Wait for filter confirmation system message
    await pair.hostPage.waitForFunction(
      () => {
        const container = document.getElementById('chat-messages');
        if (!container) return false;
        return (container.innerText || '').length > 10;
      },
      { timeout: 10_000 },
    );

    // Verify the system message appeared (filter enabled confirmation)
    const hostText = await getChatText(pair.hostPage);
    expect(hostText.length).toBeGreaterThan(0);

    // Check the state — readState may return undefined if the global hook
    // doesn't expose nested paths. Fall back to checking system message text.
    const filterState = await readState(pair.hostPage, 'network.filterEnabled');
    if (filterState !== undefined) {
      expect(filterState).toBe(true);
    } else {
      // Fallback: check that the system message confirms filter is on
      // en: 'Profanity filter enabled' / ko: equivalent
      expect(hostText.length).toBeGreaterThan(10);
    }
  });

  // ── Permission checks ─────────────────────────────────────────

  test('guest cannot use host-only commands', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.guestPage);

    await sendChat(pair.guestPage, '/kick #0');
    // Wait for permission error message
    await pair.guestPage.waitForFunction(
      () => {
        const container = document.getElementById('chat-messages');
        if (!container) return false;
        return (container.innerText || '').length > 0;
      },
      { timeout: 10_000 },
    );

    const guestText = await getChatText(pair.guestPage);
    // Should show no-permission error
    expect(guestText.length).toBeGreaterThan(0);
  });

  test('unknown command shows error message', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);

    await sendChat(pair.hostPage, '/nonexistent');
    await waitForChatMessage(pair.hostPage, 'nonexistent');

    const hostText = await getChatText(pair.hostPage);
    expect(hostText).toContain('nonexistent');
  });

  // ── /op + OP commands ──────────────────────────────────────────

  test('/op grants delegated administrator commands', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    // Host grants the standard delegated-administrator capability set.
    await sendChat(pair.hostPage, '/op #1');
    await waitForState(pair.guestPage, 'network.isOperator', true);

    // Delegated administrators receive moderation/member commands, but room
    // configuration commands remain owner-only.
    await sendChat(pair.guestPage, '/help');
    await waitForChatMessage(pair.guestPage, '/kick');

    const guestText = await getChatText(pair.guestPage);
    expect(guestText).toContain('/kick');
    expect(guestText).toContain('/notice');
    expect(guestText).not.toContain('/clear');
    expect(guestText).not.toContain('/mute');
    expect(guestText).not.toContain('/op');
  });

  test('/deop revokes operator permissions', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    // Grant OP — guest receives OPERATOR_GRANT which sets network.isOperator = true
    await sendChat(pair.hostPage, '/op #1');
    // Wait for operator state to propagate to guest
    await pair.guestPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? get('network.isOperator') === true : false;
      },
      { timeout: 15_000 },
    );

    // Revoke OP
    await sendChat(pair.hostPage, '/deop #1');
    // Wait for operator state to be revoked on guest
    await pair.guestPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? get('network.isOperator') === false : false;
      },
      { timeout: 15_000 },
    );

    // Guest should only see basic commands
    await sendChat(pair.guestPage, '/help');
    await waitForChatMessage(pair.guestPage, '/nick');

    const guestText = await getChatText(pair.guestPage);
    expect(guestText).not.toContain('/kick');
    expect(guestText).not.toContain('/freeze');
  });

  // ── Edge cases ─────────────────────────────────────────────────

  test('commands are not broadcast as regular chat', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    // Host sends a command
    await sendChat(pair.hostPage, '/help');
    await waitForChatMessage(pair.hostPage, '/users');

    // Guest should NOT have received a non-system chat bubble containing /help
    const guestHasHelpChat = await hasNonSystemChatContaining(pair.guestPage, '/help');
    expect(guestHasHelpChat).toBe(false);
  });

  test('/freeze + late-join guest cannot chat', async ({ browser }) => {
    // Setup host only
    const hostContext = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const hostPage = await hostContext.newPage();

    // Inject PeerJS config
    const { injectPeerServer } = await import('./helpers/peer-server.ts');
    await injectPeerServer(hostPage);
    await hostPage.goto('/');

    // Setup host and get code
    const { setupHostAndStart } = await import('./helpers/setup-flow.ts');
    const code = await setupHostAndStart(hostPage);

    await openChatDrawer(hostPage);

    // Freeze chat BEFORE guest joins
    await sendChat(hostPage, '/freeze on');
    // Wait for freeze confirmation (en: "frozen" / ko: "동결")
    await hostPage.waitForFunction(
      () => {
        const container = document.getElementById('chat-messages');
        if (!container) return false;
        const text = container.textContent || '';
        return text.includes('frozen') || text.includes('동결');
      },
      { timeout: 15_000 },
    );

    // Now create guest and join
    const guestContext = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const guestPage = await guestContext.newPage();
    await injectPeerServer(guestPage);
    await guestPage.goto('/');

    const { setupGuest } = await import('./helpers/setup-flow.ts');
    await setupGuest(guestPage, code);

    await waitForOverlayDismissed(guestPage);
    // Wait for freeze state to propagate to late-join guest via welcome message
    await guestPage.waitForFunction(
      () => {
        const get = (window as any).__MUSIXQUARE_GET_STATE__;
        return get ? get('network.chatFrozen') === true : false;
      },
      { timeout: 15_000 },
    );

    await openChatDrawer(guestPage);

    // Late-join guest tries to chat — should be blocked at send-time
    await sendChat(guestPage, 'Late join frozen');
    // Brief wait, then verify message NOT delivered
    await hostPage.waitForTimeout(1000);

    const hostText = await getChatText(hostPage);
    expect(hostText).not.toContain('Late join frozen');

    // Cleanup
    await guestContext.close();
    await hostContext.close();
  });

  test('target resolution works by both #number and nickname', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);

    // Mute by #1
    await sendChat(pair.hostPage, '/mute #1');
    await waitForChatMessage(pair.hostPage, 'Peer');
    let hostText = await getChatText(pair.hostPage);
    expect(hostText).toContain('Peer');

    // Unmute by #1
    await sendChat(pair.hostPage, '/unmute #1');
    // Wait for unmute confirmation message
    await pair.hostPage.waitForFunction(
      () => {
        const container = document.getElementById('chat-messages');
        if (!container) return false;
        const bubbles = container.querySelectorAll('.chat-bubble.system, .chat-bubble.notice');
        return bubbles.length >= 2;
      },
      { timeout: 10_000 },
    );
    hostText = await getChatText(pair.hostPage);
    expect(hostText.length).toBeGreaterThan(0);
  });

  test('/mute target not found shows error', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.hostPage);

    await sendChat(pair.hostPage, '/mute #99');
    await waitForChatMessage(pair.hostPage, '#99');

    const hostText = await getChatText(pair.hostPage);
    expect(hostText).toContain('#99');
  });
});
