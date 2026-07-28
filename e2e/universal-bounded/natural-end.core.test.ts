import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

import {
  cleanupContexts,
  createHostGuestContexts,
  getPageErrors,
  type HostGuestPair,
} from '../helpers/context-factory.ts';
import { connectHostAndGuest } from '../helpers/setup-flow.ts';
import { installUniversalNetworkStubs } from './network-stubs.ts';
import {
  captureUniversalConsole,
  expectUniversalLifecycleOccupancy,
  expectUniversalRoom,
  logUniversalDiagnostics,
  readUniversalRuntime,
  universalLifecycleOccupancy,
  waitForBoundedPlayback,
  type UniversalLifecycleOccupancy,
} from './runtime-assertions.ts';

const FLAC_FIXTURE = resolve('.vite/universal-fixtures/bounded-tone.flac');
const SEEK_NEAR_END_SECONDS = 57;

let pair: HostGuestPair;

function withOneRetainedEncodedAsset(
  baseline: UniversalLifecycleOccupancy,
): UniversalLifecycleOccupancy {
  return Object.freeze({
    ...baseline,
    encodedSources: Object.freeze({
      ...baseline.encodedSources,
      live: baseline.encodedSources.live + 1,
    }),
  });
}

test.describe('universal bounded natural end reconciliation', () => {
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

  test('retires both physical renderers before publishing the shared stopped timeline', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await Promise.all([
      expectUniversalRoom(pair.hostPage, 'host'),
      expectUniversalRoom(pair.guestPage, 'guest'),
    ]);
    const [hostRoom, guestRoom] = await Promise.all([
      readUniversalRuntime(pair.hostPage),
      readUniversalRuntime(pair.guestPage),
    ]);
    const hostRoomBaseline = universalLifecycleOccupancy(hostRoom.lifecycle);
    const guestRoomBaseline = universalLifecycleOccupancy(guestRoom.lifecycle);

    await pair.hostPage.locator('#file-input').setInputFiles(FLAC_FIXTURE);
    const initial = await waitForBoundedPlayback(pair.hostPage, pair.guestPage, {
      timeout: 45_000,
    });
    const initialRevision = initial.host.renderer!.revision;

    await pair.hostPage.locator('#seek-slider').evaluate((element, seconds) => {
      const slider = element as HTMLInputElement;
      slider.value = String(seconds);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }, SEEK_NEAR_END_SECONDS);

    try {
      await expect
        .poll(
          async () => {
            const [host, guest] = await Promise.all([
              readUniversalRuntime(pair.hostPage),
              readUniversalRuntime(pair.guestPage),
            ]);
            return {
              hostPhase: host.controller?.timeline.phase,
              hostRevision: host.controller?.timeline.revision,
              hostRun: host.controller?.timeline.run,
              guestPhase: guest.controller?.timeline.phase,
              guestRevision: guest.controller?.timeline.revision,
              guestRun: guest.controller?.timeline.run,
            };
          },
          { timeout: 30_000 },
        )
        .toEqual({
          hostPhase: 'stopped',
          hostRevision: initialRevision + 2,
          hostRun: null,
          guestPhase: 'stopped',
          guestRevision: initialRevision + 2,
          guestRun: null,
        });

      await Promise.all([
        expectUniversalLifecycleOccupancy(
          pair.hostPage,
          withOneRetainedEncodedAsset(hostRoomBaseline),
        ),
        expectUniversalLifecycleOccupancy(
          pair.guestPage,
          withOneRetainedEncodedAsset(guestRoomBaseline),
        ),
      ]);
    } catch (error) {
      await logUniversalDiagnostics('natural-end-failure', pair.hostPage, pair.guestPage);
      throw error;
    }

    const [hostStopped, guestStopped] = await Promise.all([
      readUniversalRuntime(pair.hostPage),
      readUniversalRuntime(pair.guestPage),
    ]);
    expect(hostStopped.transportEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'wire-sent',
          frame: expect.objectContaining({
            kind: 'file-playback-ended',
            revision: initialRevision + 2,
          }),
        }),
        expect.objectContaining({
          direction: 'required-sent',
          frame: expect.objectContaining({
            type: 'FILE_PLAYBACK_TIMELINE_UPDATE_V2',
            revision: initialRevision + 2,
          }),
        }),
      ]),
    );
    const endedWireIndex = hostStopped.transportEvents.findIndex((event) => {
      if (!event || typeof event !== 'object') return false;
      const record = event as Readonly<Record<string, unknown>>;
      if (!record.frame || typeof record.frame !== 'object') return false;
      const frame = record.frame as Readonly<Record<string, unknown>>;
      return (
        record.direction === 'wire-sent' &&
        frame.kind === 'file-playback-ended' &&
        frame.revision === initialRevision + 2
      );
    });
    const stoppedTimelineIndex = hostStopped.transportEvents.findIndex((event) => {
      if (!event || typeof event !== 'object') return false;
      const record = event as Readonly<Record<string, unknown>>;
      if (!record.frame || typeof record.frame !== 'object') return false;
      const frame = record.frame as Readonly<Record<string, unknown>>;
      return (
        record.direction === 'required-sent' &&
        frame.type === 'FILE_PLAYBACK_TIMELINE_UPDATE_V2' &&
        frame.revision === initialRevision + 2
      );
    });
    expect(endedWireIndex).toBeGreaterThanOrEqual(0);
    expect(stoppedTimelineIndex).toBeGreaterThan(endedWireIndex);
    expect(guestStopped.lifecycle.invariantFaults).toBe(0);
    expect(guestStopped.lifecycle.forcedRetirements).toBe(0);
  });
});
