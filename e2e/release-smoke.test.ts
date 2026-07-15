import { expect, test } from '@playwright/test';
import {
  cleanupContexts,
  createHostGuestContexts,
  getPageErrors,
  type HostGuestPair,
} from './helpers/context-factory.ts';
import { connectHostAndGuest } from './helpers/setup-flow.ts';
import {
  openChatDrawer,
  sendChat,
  waitForChatMessage,
  waitForDeviceCount,
} from './helpers/wait.ts';

let pair: HostGuestPair | undefined;

test.describe('Production release smoke', () => {
  test.afterEach(async () => {
    if (pair) await cleanupContexts(pair);
    pair = undefined;
  });

  test('boots, joins a host and guest, and exchanges chat both ways', async ({ browser }) => {
    pair = await createHostGuestContexts(browser);

    const code = await connectHostAndGuest(pair.hostPage, pair.guestPage);
    expect(code).toMatch(/^\d{6}$/);

    await Promise.all([
      waitForDeviceCount(pair.hostPage, 2),
      waitForDeviceCount(pair.guestPage, 2),
    ]);

    await Promise.all([openChatDrawer(pair.hostPage), openChatDrawer(pair.guestPage)]);

    const hostMessage = `release-smoke-host-${code}`;
    const guestMessage = `release-smoke-guest-${code}`;

    await sendChat(pair.hostPage, hostMessage);
    await waitForChatMessage(pair.guestPage, hostMessage);

    await sendChat(pair.guestPage, guestMessage);
    await waitForChatMessage(pair.hostPage, guestMessage);

    expect(getPageErrors(pair.hostPage)).toEqual([]);
    expect(getPageErrors(pair.guestPage)).toEqual([]);
  });
});
