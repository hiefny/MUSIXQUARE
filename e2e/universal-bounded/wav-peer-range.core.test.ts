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
  expectPeerRangePhysicalReadsRetired,
  expectUniversalRoom,
  logUniversalDiagnostics,
  readUniversalRuntime,
  waitForBoundedPlayback,
} from './runtime-assertions.ts';
import { installUniversalNetworkStubs } from './network-stubs.ts';

const WAVE_FIXTURE = resolve('.vite/universal-fixtures/bounded-tone.wav');

let pair: HostGuestPair;

test.describe('universal bounded direct PCM over a real host/guest room', () => {
  test.beforeEach(async ({ browser }) => {
    pair = await createHostGuestContexts(browser);
    for (const [role, page] of [
      ['host', pair.hostPage],
      ['guest', pair.guestPage],
    ] as const) {
      captureUniversalConsole(page, role);
    }
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

  test('WAV acquires, becomes ready, seeks, replays, and retires the connection', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await Promise.all([
      expectUniversalRoom(pair.hostPage, 'host'),
      expectUniversalRoom(pair.guestPage, 'guest'),
    ]);

    await pair.hostPage.locator('#file-input').setInputFiles(WAVE_FIXTURE);
    const initial = await waitForBoundedPlayback(pair.hostPage, pair.guestPage);
    await Promise.all([
      expectExactPlayingProjection(pair.hostPage),
      expectExactPlayingProjection(pair.guestPage),
      expectNoLegacyResident(pair.hostPage, pair.guestPage),
    ]);
    expect(initial.host.renderer?.durationSeconds).toBeCloseTo(60, 3);

    const initialRevision = initial.host.renderer!.revision;
    await pair.hostPage.locator('#seek-slider').evaluate((element) => {
      const slider = element as HTMLInputElement;
      slider.value = '12';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect
      .poll(async () => {
        const [host, guest] = await Promise.all([
          readUniversalRuntime(pair.hostPage),
          readUniversalRuntime(pair.guestPage),
        ]);
        return {
          hostPhase: host.renderer?.phase,
          hostRevision: host.renderer?.revision,
          guestPhase: guest.controller?.timeline.phase,
          guestRevision: guest.controller?.timeline.revision,
          guestPosition: guest.controller?.timeline.positionSeconds,
        };
      })
      .toEqual({
        hostPhase: 'playing',
        hostRevision: initialRevision + 1,
        guestPhase: 'playing',
        guestRevision: initialRevision + 1,
        guestPosition: 12,
      });

    const queueItemId = initial.host.renderer!.queueItemId;
    await pair.hostPage.evaluate((id) => {
      const bus = (window as unknown as Record<string, unknown>).__MUSIXQUARE_BUS__ as
        | { emit: (type: string, ...args: unknown[]) => void }
        | undefined;
      if (!bus) throw new Error('E2E event bridge unavailable');
      bus.emit('playlist:play-track', id);
    }, queueItemId);
    try {
      await expect
        .poll(async () => {
          const [host, guest] = await Promise.all([
            readUniversalRuntime(pair.hostPage),
            readUniversalRuntime(pair.guestPage),
          ]);
          return {
            hostRevision: host.renderer?.revision,
            hostPosition: host.controller?.timeline.positionSeconds,
            guestRevision: guest.controller?.timeline.revision,
            guestPosition: guest.controller?.timeline.positionSeconds,
          };
        })
        .toEqual({
          hostRevision: initialRevision + 2,
          hostPosition: 0,
          guestRevision: initialRevision + 2,
          guestPosition: 0,
        });
    } catch (error) {
      await logUniversalDiagnostics('replay-timeout', pair.hostPage, pair.guestPage);
      throw error;
    }

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
    await expectPeerRangePhysicalReadsRetired(pair.hostPage);
  });
});
