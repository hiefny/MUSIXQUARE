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
import { waitForChatMessage, openChatDrawer, sendChat } from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Chat System', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  test('host sends chat message and guest receives it', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    // Open chat on host
    await openChatDrawer(pair.hostPage);

    // Send message from host
    await sendChat(pair.hostPage, 'Hello from host!');

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
    await sendChat(pair.guestPage, 'Reply from guest!');

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
    await sendChat(pair.hostPage, 'Message 1 from host');
    await waitForChatMessage(pair.guestPage, 'Message 1 from host');

    // Guest replies
    await sendChat(pair.guestPage, 'Message 2 from guest');
    await waitForChatMessage(pair.hostPage, 'Message 2 from guest');

    // Host sends again
    await sendChat(pair.hostPage, 'Message 3 from host');
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
