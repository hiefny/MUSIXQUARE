/**
 * E2E: Chat System Tests
 *
 * Tests bidirectional chat between host and guest:
 * - Host sends message → guest receives
 * - Guest replies → host receives
 * - Chat drawer UI interaction
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { waitForChatMessage } from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Chat System', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  async function openChatDrawer(page: import('@playwright/test').Page): Promise<void> {
    // Look for chat preview button or chat tab
    const chatBtn = page.locator('#chat-preview-btn, .nav-item[data-tab="chat"]').first();
    if (await chatBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await chatBtn.click();
      await page.waitForTimeout(300);
    }
    // If chat drawer is not open, try clicking the chat nav item
    const drawer = page.locator('#chat-drawer');
    if (!(await drawer.evaluate(el => el.classList.contains('open')).catch(() => false))) {
      const navChat = page.locator('.nav-item[data-tab="chat"]');
      if (await navChat.isVisible({ timeout: 2000 }).catch(() => false)) {
        await navChat.click();
      }
    }
  }

  async function sendChatMessage(page: import('@playwright/test').Page, text: string): Promise<void> {
    const chatInput = page.locator('#chat-input');
    await chatInput.fill(text);
    await page.click('#btn-chat-send');
  }

  test('host sends chat message and guest receives it', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open chat on host
    await openChatDrawer(pair.hostPage);

    // Send message from host
    await sendChatMessage(pair.hostPage, 'Hello from host!');

    // Verify message appears on host side
    await waitForChatMessage(pair.hostPage, 'Hello from host!');

    // Open chat on guest and check for message
    await openChatDrawer(pair.guestPage);
    await waitForChatMessage(pair.guestPage, 'Hello from host!');
  });

  test('guest sends reply and host receives it', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open chat on both sides
    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    // Guest sends message
    await sendChatMessage(pair.guestPage, 'Reply from guest!');

    // Verify on guest side
    await waitForChatMessage(pair.guestPage, 'Reply from guest!');

    // Verify on host side
    await waitForChatMessage(pair.hostPage, 'Reply from guest!');
  });

  test('bidirectional chat exchange', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    // Host sends
    await sendChatMessage(pair.hostPage, 'Message 1 from host');
    await waitForChatMessage(pair.guestPage, 'Message 1 from host');

    // Guest replies
    await sendChatMessage(pair.guestPage, 'Message 2 from guest');
    await waitForChatMessage(pair.hostPage, 'Message 2 from guest');

    // Host sends again
    await sendChatMessage(pair.hostPage, 'Message 3 from host');
    await waitForChatMessage(pair.guestPage, 'Message 3 from host');

    // Verify all messages are present
    const hostMessages = await pair.hostPage.evaluate(() => {
      const container = document.getElementById('chat-messages');
      return container?.textContent || '';
    });
    expect(hostMessages).toContain('Message 1 from host');
    expect(hostMessages).toContain('Message 2 from guest');
    expect(hostMessages).toContain('Message 3 from host');
  });
});
