/**
 * E2E: Audio Channel Selection Tests
 *
 * Tests per-peer Left/Right/Center/Subwoofer channel state after connection.
 */
import { test, expect } from '@playwright/test';
import { createHostGuestContexts, cleanupContexts, type HostGuestPair } from './helpers/context-factory.ts';
import { setupHostAndStart, setupGuest } from './helpers/setup-flow.ts';
import {
  readState,
} from './helpers/wait.ts';

let pair: HostGuestPair;

test.describe('Audio Channel Selection', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
  });

  test.afterEach(async () => {
    await cleanupContexts(pair);
  });

  const channelModes = [
    { name: 'Left', mode: -1 },
    { name: 'Center', mode: 0 },
    { name: 'Right', mode: 1 },
    { name: 'Subwoofer', mode: 2 },
  ];

  for (const { name, mode } of channelModes) {
    test(`guest connects with ${name} channel (mode=${mode})`, async () => {
      const code = await setupHostAndStart(pair.hostPage, 0); // Host on center
      await setupGuest(pair.guestPage, code, mode);

      const guestChannel = await readState(pair.guestPage, 'audio.channelMode');
      expect(guestChannel).toBe(mode);
    });
  }

  test('host and guest have different channels', async () => {
    const code = await setupHostAndStart(pair.hostPage, -1); // Host on Left
    await setupGuest(pair.guestPage, code, 1); // Guest on Right

    const [hostChannel, guestChannel] = await Promise.all([
      readState(pair.hostPage, 'audio.channelMode'),
      readState(pair.guestPage, 'audio.channelMode'),
    ]);

    expect(hostChannel).toBe(-1);
    expect(guestChannel).toBe(1);
  });
});
