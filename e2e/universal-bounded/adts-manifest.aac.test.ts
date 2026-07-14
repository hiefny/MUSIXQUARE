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

const ADTS_FIXTURE = resolve('.vite/universal-fixtures/bounded-tone.aac');

let pair: HostGuestPair;

test.describe('universal bounded ADTS manifest lane', () => {
  test.beforeEach(async ({ browser, context }) => {
    pair = await createHostGuestContexts(browser);
    captureUniversalConsole(pair.hostPage, 'host');
    captureUniversalConsole(pair.guestPage, 'guest');
    await Promise.all([
      installUniversalNetworkStubs(context),
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

  test('environment provides AAC-LC WebCodecs', async ({ page }) => {
    await page.goto('/');
    const capability = await page.evaluate(async () => {
      if (typeof AudioDecoder !== 'function') {
        return { available: false, supported: false };
      }
      const result = await AudioDecoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: 48_000,
        numberOfChannels: 2,
      });
      return { available: true, supported: result.supported === true };
    });
    expect(
      capability,
      'Raw ADTS/M4A candidate tests require system Chrome with AAC-LC WebCodecs support',
    ).toEqual({ available: true, supported: true });
  });

  test('ADTS offer, authenticated manifest, peer ranges, and ready lead to exact playback', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await Promise.all([
      expectUniversalRoom(pair.hostPage, 'host'),
      expectUniversalRoom(pair.guestPage, 'guest'),
    ]);

    await pair.hostPage.locator('#file-input').setInputFiles(ADTS_FIXTURE);
    const snapshots = await waitForBoundedPlayback(pair.hostPage, pair.guestPage, {
      timeout: 90_000,
    });
    await Promise.all([
      expectExactPlayingProjection(pair.hostPage),
      expectExactPlayingProjection(pair.guestPage),
      expectNoLegacyResident(pair.hostPage, pair.guestPage),
    ]);

    expect(snapshots.host.renderer).toMatchObject({
      backend: 'bounded-stream',
      phase: 'playing',
      channelCount: 2,
      outputSampleRateHz: 48_000,
      errorCode: null,
    });
    expect(snapshots.guest.controller?.timeline.run).not.toBeNull();
    expect(snapshots.host.transportEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'required-sent',
          frame: expect.objectContaining({ type: 'FILE_MEDIA_SOURCE_OFFER_V2' }),
        }),
        expect.objectContaining({
          direction: 'required-sent',
          frame: expect.objectContaining({ type: 'FILE_PLAYBACK_RUN_BINDING_V2' }),
        }),
      ]),
    );
    expect(snapshots.guest.transportEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'required-sent',
          frame: expect.objectContaining({
            kind: 'source-ready',
            revision: snapshots.guest.controller?.timeline.revision,
          }),
        }),
      ]),
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
    await expectPeerRangePhysicalReadsRetired(pair.hostPage);
  });
});
