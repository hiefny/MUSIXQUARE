/**
 * E2E: Chat System Tests
 *
 * Tests bidirectional chat between host and guest:
 * - Host sends message → guest receives
 * - Guest replies → host receives
 * - Chat drawer UI interaction
 */
import { test, expect } from '@playwright/test';
import type { DataConnection } from '../src/types/index.ts';
import {
  createHostGuestContexts,
  cleanupContexts,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import { openChatDrawer, sendChat, waitForChatMessage } from './helpers/wait.ts';

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

    await openChatDrawer(pair.hostPage);

    await sendChat(pair.hostPage, 'Hello from host!');

    await waitForChatMessage(pair.hostPage, 'Hello from host!');

    await openChatDrawer(pair.guestPage);
    await waitForChatMessage(pair.guestPage, 'Hello from host!');
  });

  test('guest sends reply and host receives it', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    await sendChat(pair.guestPage, 'Reply from guest!');

    await waitForChatMessage(pair.guestPage, 'Reply from guest!');

    await waitForChatMessage(pair.hostPage, 'Reply from guest!');
  });

  test('known local send refusals retain ordinary and whisper drafts for an exact retry', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await openChatDrawer(pair.guestPage);
    for (const draft of ['Retained ordinary draft', '/w #0 Retained private draft']) {
      await pair.guestPage.locator('#chat-input').fill(draft);
      const before = await pair.guestPage.locator('.chat-bubble.mine').count();
      const rejected = await pair.guestPage.evaluate(() => {
        const getState = (
          window as unknown as {
            __MUSIXQUARE_GET_STATE__: (path: string) => DataConnection;
          }
        ).__MUSIXQUARE_GET_STATE__;
        const connection = getState('network.hostConn');
        const original = connection.send;
        let refusals = 0;
        connection.send = () => {
          refusals += 1;
          throw new DOMException('Controlled local send refusal', 'InvalidStateError');
        };
        try {
          document.getElementById('btn-chat-send')!.click();
        } finally {
          connection.send = original;
        }
        return refusals;
      });
      expect(rejected).toBe(1);
      await expect(pair.guestPage.locator('#chat-input')).toHaveText(draft);
      await expect(pair.guestPage.locator('.chat-bubble.mine')).toHaveCount(before);
      const text = draft.replace('/w #0 ', '');
      await expect(pair.hostPage.locator('#chat-messages')).not.toContainText(text);
      await pair.guestPage.locator('#btn-chat-send').click();
      await expect(pair.guestPage.locator('#chat-input')).toBeEmpty();
      await expect(pair.guestPage.locator('.chat-bubble.mine')).toHaveCount(before + 1);
      await waitForChatMessage(pair.hostPage, text);
    }
  });

  test('bidirectional chat exchange', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);

    await openChatDrawer(pair.hostPage);
    await openChatDrawer(pair.guestPage);

    await sendChat(pair.hostPage, 'Message 1 from host');
    await waitForChatMessage(pair.guestPage, 'Message 1 from host');

    await sendChat(pair.guestPage, 'Message 2 from guest');
    await waitForChatMessage(pair.hostPage, 'Message 2 from guest');

    await sendChat(pair.hostPage, 'Message 3 from host');
    await waitForChatMessage(pair.guestPage, 'Message 3 from host');

    const hostMessages = await pair.hostPage.evaluate(() => {
      const container = document.getElementById('chat-messages');
      return container?.textContent || '';
    });
    expect(hostMessages).toContain('Message 1 from host');
    expect(hostMessages).toContain('Message 2 from guest');
    expect(hostMessages).toContain('Message 3 from host');
  });

  for (const language of ['he', 'en']) {
    test(`${language} chat remains inside its drawer after sending mixed-direction text`, async ({}, testInfo) => {
      const { hostPage: host, guestPage: guest } = pair;
      await connectHostAndGuest(host, guest);
      await guest.locator('#btn-language-select').click();
      await guest.locator(`.language-option[data-lang="${language}"]`).click();
      await guest.locator('#btn-language-dialog-done').click();
      await openChatDrawer(host);
      await openChatDrawer(guest);
      const received = 'שלום חברים, מוזיקה טובה היום 🎵';
      const sent = 'مرحبا שלום — hello!';
      await sendChat(host, received);
      await waitForChatMessage(guest, received);
      await sendChat(guest, sent);
      await waitForChatMessage(host, sent);
      await expect(guest.locator('#chat-input')).toBeFocused();
      await expect
        .poll(() =>
          guest.locator('#chat-drawer').evaluate((drawer) => {
            const bounds = drawer.getBoundingClientRect();
            const content = [
              document.getElementById('chat-input')!,
              ...drawer.querySelectorAll('.chat-text'),
            ];
            return Math.max(
              ...content.map((element) => {
                const rect = element.getBoundingClientRect();
                return Math.max(bounds.left - rect.left, rect.right - bounds.right, 0);
              }),
            );
          }),
        )
        .toBeLessThanOrEqual(1);
      expect(await guest.locator('#chat-drawer').evaluate((drawer) => drawer.scrollLeft)).toBe(0);
      await guest.screenshot({
        path: testInfo.outputPath(`chat-${language}-after-send.png`),
        animations: 'disabled',
      });
    });
  }
});
