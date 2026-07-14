import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import {
  cleanupContexts,
  createHostGuestContexts,
  getPageErrors,
  type HostGuestPair,
} from '../helpers/context-factory.ts';
import { connectHostAndGuest } from '../helpers/setup-flow.ts';
import {
  captureUniversalConsole,
  expectExactPlayingProjection,
  expectNoLegacyResident,
  expectUniversalRoom,
  readUniversalRuntime,
  waitForBoundedPlayback,
} from './runtime-assertions.ts';
import { installUniversalNetworkStubs } from './network-stubs.ts';

const FIXTURES = [
  { label: 'AIFF', path: resolve('.vite/universal-fixtures/bounded-tone.aiff') },
  { label: 'CAF', path: resolve('.vite/universal-fixtures/bounded-tone.caf') },
] as const;

let pair: HostGuestPair;

test.describe('universal bounded linear PCM over a real host/guest room', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
    captureUniversalConsole(pair.hostPage, 'host');
    captureUniversalConsole(pair.guestPage, 'guest');
    await Promise.all([
      installUniversalNetworkStubs(pair.hostContext),
      installUniversalNetworkStubs(pair.guestContext),
    ]);
  });

  test.afterEach(async () => {
    const hostErrors = getPageErrors(pair.hostPage);
    const guestErrors = getPageErrors(pair.guestPage);
    await cleanupContexts(pair);
    expect(hostErrors, 'host page had an uncaught error').toHaveLength(0);
    expect(guestErrors, 'guest page had an uncaught error').toHaveLength(0);
  });

  for (const fixture of FIXTURES) {
    test(`${fixture.label} parses, streams by peer range, and retires cleanly`, async () => {
      await connectHostAndGuest(pair.hostPage, pair.guestPage);
      await Promise.all([
        expectUniversalRoom(pair.hostPage, 'host'),
        expectUniversalRoom(pair.guestPage, 'guest'),
      ]);

      await pair.hostPage.locator('#file-input').setInputFiles(fixture.path);
      const snapshots = await waitForBoundedPlayback(pair.hostPage, pair.guestPage, {
        timeout: 30_000,
      });
      await Promise.all([
        expectExactPlayingProjection(pair.hostPage),
        expectExactPlayingProjection(pair.guestPage),
        expectNoLegacyResident(pair.hostPage, pair.guestPage),
      ]);

      expect(snapshots.host.renderer).toMatchObject({
        backend: 'bounded-stream',
        phase: 'playing',
        durationSeconds: 60,
        outputSampleRateHz: 48_000,
        channelCount: 2,
        errorCode: null,
      });
      expect(snapshots.host.renderer?.queueItemId).toBe(
        snapshots.guest.controller?.timeline.run?.queueItemId,
      );

      await pair.guestPage.evaluate(() => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((path: string) => unknown)
          | undefined;
        const connection = get?.('network.hostConn') as { close?: () => void } | null | undefined;
        if (typeof connection?.close !== 'function') {
          throw new Error('E2E guest connection is unavailable for retirement');
        }
        connection.close();
      });
      await expect
        .poll(
          async () => (await readUniversalRuntime(pair.hostPage)).controller?.activeConnectionCount,
        )
        .toBe(0);
    });
  }
});
