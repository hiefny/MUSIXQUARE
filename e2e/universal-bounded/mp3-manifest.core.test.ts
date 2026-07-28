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
  readUniversalRuntime,
  waitForBoundedPlayback,
} from './runtime-assertions.ts';
import { installUniversalNetworkStubs } from './network-stubs.ts';

const MP3_MANIFEST_FIXTURE = resolve('.vite/universal-fixtures/bounded-tone-no-count.mp3');
const SEEK_SECONDS = 42;

let pair: HostGuestPair;

test.describe('universal bounded no-frame-count MP3 manifest lane', () => {
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

  test('sealed MP3 manifest reconstructs, seeks, and retires cleanly', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await Promise.all([
      expectUniversalRoom(pair.hostPage, 'host'),
      expectUniversalRoom(pair.guestPage, 'guest'),
    ]);

    await pair.hostPage.locator('#file-input').setInputFiles(MP3_MANIFEST_FIXTURE);
    const initial = await waitForBoundedPlayback(pair.hostPage, pair.guestPage, {
      timeout: 60_000,
    });
    await Promise.all([
      expectExactPlayingProjection(pair.hostPage),
      expectExactPlayingProjection(pair.guestPage),
      expectNoLegacyResident(pair.hostPage, pair.guestPage),
    ]);

    expect(initial.host.renderer).toMatchObject({
      backend: 'bounded-stream',
      phase: 'playing',
      outputSampleRateHz: 48_000,
      channelCount: 2,
      errorCode: null,
    });
    expect(initial.host.renderer?.durationSeconds).toBeCloseTo(87.48, 3);
    expect(initial.host.transportEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'required-sent',
          frame: expect.objectContaining({
            type: 'FILE_MEDIA_SOURCE_OFFER_V2',
            transport: 'peer-range-manifest',
            manifestByteLength: expect.any(Number),
          }),
        }),
      ]),
    );
    expect(initial.guest.transportEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'required-sent',
          frame: expect.objectContaining({
            backend: 'bounded-stream',
            kind: 'source-ready',
          }),
        }),
      ]),
    );

    const initialRevision = initial.host.renderer!.revision;
    await pair.hostPage.locator('#seek-slider').evaluate((element, seconds) => {
      const slider = element as HTMLInputElement;
      slider.value = String(seconds);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }, SEEK_SECONDS);
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
        hostRevision: initialRevision + 1,
        hostPosition: SEEK_SECONDS,
        guestRevision: initialRevision + 1,
        guestPosition: SEEK_SECONDS,
      });
    await waitForBoundedPlayback(pair.hostPage, pair.guestPage);

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
