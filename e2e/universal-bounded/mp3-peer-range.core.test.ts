import { expect, test, type Page } from '@playwright/test';
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

const MP3_FIXTURE = resolve('e2e/fixtures/test-01.mp3');
const SEEK_SECONDS = 42;
const LATE_ARM_PATCH_KEY = '__MUSIXQUARE_MP3_LATE_ARM_RECEIPT_PATCH__';
const LATE_ARM_MARGIN_MS = 30;
const MIN_RENDERER_HEALTH_SPAN_MS = 10_000;
const MIN_RENDERER_HEALTH_EVENT_COUNT = 5;

interface UniversalTransportEvent {
  readonly direction: string;
  readonly atMonotonicMs: number;
  readonly frame: Readonly<{
    type: string | null;
    kind: string | null;
    revision: number | null;
    queueItemId: string | null;
    runId: string | null;
    rendezvousId: string | null;
    reasonCode: string | null;
  }>;
}

interface LateArmPatchSnapshot {
  readonly targetRevision: number;
  readonly rendezvousId: string | null;
  readonly finalizeByRoomTimeMs: number | null;
  readonly observedAtRoomTimeMs: number | null;
  readonly delayMs: number | null;
  readonly dispatched: boolean;
  readonly dispatchError: string | null;
}

function transportEvents(events: readonly unknown[]): readonly UniversalTransportEvent[] {
  return events as readonly UniversalTransportEvent[];
}

function targetWireEvents(
  events: readonly unknown[],
  kind: string,
  revision: number,
): readonly UniversalTransportEvent[] {
  return transportEvents(events).filter(
    (event) => event.frame.kind === kind && event.frame.revision === revision,
  );
}

async function installLateArmReceiptDelay(page: Page, targetRevision: number): Promise<void> {
  await page.evaluate(
    ({ key, marginMs, revision }) => {
      interface ArmFrame {
        readonly kind: 'rendezvous-arm';
        readonly revision: number;
        readonly rendezvousId: string;
        readonly finalizeByRoomTimeMs: number;
      }

      interface ArmedFrame {
        readonly kind: 'rendezvous-armed';
        readonly revision: number;
        readonly rendezvousId: string;
        readonly observedAtRoomTimeMs: number;
      }

      interface GuestConnection {
        send(data: unknown, chunked?: boolean): void | Promise<void>;
        on(event: 'data', listener: (data: unknown) => void): GuestConnection;
        off(event: 'data', listener: (data: unknown) => void): GuestConnection;
      }

      interface BrowserPatch {
        readonly snapshot: LateArmPatchSnapshot;
        restore(): void;
      }

      const root = window as unknown as Record<string, unknown>;
      if (root[key] !== undefined) throw new Error('Late ARM receipt patch is already installed');
      const get = root.__MUSIXQUARE_GET_STATE__ as ((path: string) => unknown) | undefined;
      const connection = get?.('network.hostConn') as GuestConnection | null | undefined;
      if (
        !connection ||
        typeof connection.send !== 'function' ||
        typeof connection.on !== 'function' ||
        typeof connection.off !== 'function'
      ) {
        throw new Error('E2E guest connection cannot install a late ARM receipt patch');
      }

      const originalOwnSend = Object.getOwnPropertyDescriptor(connection, 'send');
      const originalSend = connection.send;
      let targetArm: ArmFrame | null = null;
      let pendingTimer: number | null = null;
      let restored = false;
      const snapshot: {
        targetRevision: number;
        rendezvousId: string | null;
        finalizeByRoomTimeMs: number | null;
        observedAtRoomTimeMs: number | null;
        delayMs: number | null;
        dispatched: boolean;
        dispatchError: string | null;
      } = {
        targetRevision: revision,
        rendezvousId: null,
        finalizeByRoomTimeMs: null,
        observedAtRoomTimeMs: null,
        delayMs: null,
        dispatched: false,
        dispatchError: null,
      };

      const onData = (data: unknown): void => {
        if (targetArm || data === null || typeof data !== 'object') return;
        const frame = data as Partial<ArmFrame>;
        if (
          frame.kind === 'rendezvous-arm' &&
          frame.revision === revision &&
          typeof frame.rendezvousId === 'string' &&
          Number.isFinite(frame.finalizeByRoomTimeMs)
        ) {
          targetArm = {
            kind: 'rendezvous-arm',
            revision,
            rendezvousId: frame.rendezvousId,
            finalizeByRoomTimeMs: frame.finalizeByRoomTimeMs as number,
          };
        }
      };

      const patchedSend = function (
        this: GuestConnection,
        data: unknown,
        chunked?: boolean,
      ): void | Promise<void> {
        if (
          !snapshot.dispatched &&
          pendingTimer === null &&
          targetArm &&
          data !== null &&
          typeof data === 'object'
        ) {
          const frame = data as Partial<ArmedFrame>;
          if (
            frame.kind === 'rendezvous-armed' &&
            frame.revision === revision &&
            frame.rendezvousId === targetArm.rendezvousId &&
            Number.isFinite(frame.observedAtRoomTimeMs)
          ) {
            const observedAtRoomTimeMs = frame.observedAtRoomTimeMs as number;
            const delayMs = Math.max(
              0,
              targetArm.finalizeByRoomTimeMs + marginMs - observedAtRoomTimeMs,
            );
            snapshot.rendezvousId = targetArm.rendezvousId;
            snapshot.finalizeByRoomTimeMs = targetArm.finalizeByRoomTimeMs;
            snapshot.observedAtRoomTimeMs = observedAtRoomTimeMs;
            snapshot.delayMs = delayMs;
            pendingTimer = window.setTimeout(() => {
              pendingTimer = null;
              snapshot.dispatched = true;
              try {
                const sent = Reflect.apply(originalSend, connection, [data, chunked]);
                void Promise.resolve(sent).catch((error: unknown) => {
                  snapshot.dispatchError = error instanceof Error ? error.message : String(error);
                });
              } catch (error) {
                snapshot.dispatchError = error instanceof Error ? error.message : String(error);
              }
            }, delayMs);
            return;
          }
        }
        return Reflect.apply(originalSend, connection, [data, chunked]);
      };

      connection.on('data', onData);
      Object.defineProperty(connection, 'send', {
        configurable: true,
        enumerable: originalOwnSend?.enumerable ?? false,
        writable: true,
        value: patchedSend,
      });

      const patch: BrowserPatch = {
        snapshot,
        restore: () => {
          if (restored) return;
          restored = true;
          connection.off('data', onData);
          if (pendingTimer !== null) {
            window.clearTimeout(pendingTimer);
            pendingTimer = null;
          }
          if (connection.send === patchedSend) {
            if (originalOwnSend) Object.defineProperty(connection, 'send', originalOwnSend);
            else Reflect.deleteProperty(connection, 'send');
          }
          Reflect.deleteProperty(root, key);
        },
      };
      Object.defineProperty(root, key, {
        configurable: true,
        enumerable: false,
        writable: false,
        value: patch,
      });
    },
    { key: LATE_ARM_PATCH_KEY, marginMs: LATE_ARM_MARGIN_MS, revision: targetRevision },
  );
}

async function readLateArmPatch(page: Page): Promise<LateArmPatchSnapshot | null> {
  return page.evaluate((key) => {
    const patch = (window as unknown as Record<string, unknown>)[key] as
      | { readonly snapshot?: LateArmPatchSnapshot }
      | undefined;
    return patch?.snapshot ? { ...patch.snapshot } : null;
  }, LATE_ARM_PATCH_KEY);
}

async function restoreLateArmReceiptDelay(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const patch = (window as unknown as Record<string, unknown>)[key] as
      | { restore?: () => void }
      | undefined;
    patch?.restore?.();
  }, LATE_ARM_PATCH_KEY);
}

let pair: HostGuestPair;

test.describe('universal bounded MP3 over a real host/guest room', () => {
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

  test('MP3 recovers a late ARM, renews health, replays, and retires cleanly', async () => {
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await Promise.all([
      expectUniversalRoom(pair.hostPage, 'host'),
      expectUniversalRoom(pair.guestPage, 'guest'),
    ]);

    await pair.hostPage.locator('#file-input').setInputFiles(MP3_FIXTURE);
    const initial = await waitForBoundedPlayback(pair.hostPage, pair.guestPage, {
      timeout: 45_000,
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
    expect(initial.host.renderer?.durationSeconds).toBeCloseTo(87.448354, 3);
    expect(initial.host.transportEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'required-sent',
          frame: expect.objectContaining({
            type: 'FILE_MEDIA_SOURCE_OFFER_V2',
            transport: 'peer-range',
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
    const seekRevision = initialRevision + 1;
    let recoveredRendezvousId: string | null = null;
    await installLateArmReceiptDelay(pair.guestPage, seekRevision);
    try {
      await pair.hostPage.locator('#seek-slider').evaluate((element, seconds) => {
        const slider = element as HTMLInputElement;
        slider.value = String(seconds);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }, SEEK_SECONDS);

      await expect
        .poll(
          async () => {
            const [host, guest, fault] = await Promise.all([
              readUniversalRuntime(pair.hostPage),
              readUniversalRuntime(pair.guestPage),
              readLateArmPatch(pair.guestPage),
            ]);
            const hostEvents = transportEvents(host.transportEvents);
            const guestEvents = transportEvents(guest.transportEvents);
            const firstArmIndex = hostEvents.findIndex(
              (event) =>
                event.direction === 'wire-sent' &&
                event.frame.kind === 'rendezvous-arm' &&
                event.frame.revision === seekRevision,
            );
            const firstArm = firstArmIndex >= 0 ? hostEvents[firstArmIndex] : null;
            const firstRendezvousId = firstArm?.frame.rendezvousId ?? null;
            const cancelIndex = hostEvents.findIndex(
              (event, index) =>
                index > firstArmIndex &&
                event.direction === 'wire-sent' &&
                event.frame.kind === 'file-playback-cancel' &&
                event.frame.revision === seekRevision &&
                event.frame.rendezvousId === firstRendezvousId &&
                event.frame.reasonCode === 'remote-arm-receipt-late',
            );
            const recoveryArmIndex = hostEvents.findIndex(
              (event, index) =>
                index > cancelIndex &&
                event.direction === 'wire-sent' &&
                event.frame.kind === 'rendezvous-arm' &&
                event.frame.revision === seekRevision &&
                event.frame.rendezvousId !== firstRendezvousId,
            );
            const recoveryArm = recoveryArmIndex >= 0 ? hostEvents[recoveryArmIndex] : null;
            const recoveryRendezvousId = recoveryArm?.frame.rendezvousId ?? null;
            const targetArms = targetWireEvents(
              host.transportEvents,
              'rendezvous-arm',
              seekRevision,
            );
            const targetSourceReady = targetWireEvents(
              guest.transportEvents,
              'source-ready',
              seekRevision,
            );
            const targetPrepare = targetWireEvents(
              host.transportEvents,
              'file-playback-prepare',
              seekRevision,
            );
            const sourceOfferCount = hostEvents.filter(
              (event) => event.frame.type === 'FILE_MEDIA_SOURCE_OFFER_V2',
            ).length;
            const runBindingCount = hostEvents.filter(
              (event) => event.frame.type === 'FILE_PLAYBACK_RUN_BINDING_V2',
            ).length;
            const recoveredHealth = targetWireEvents(
              guest.transportEvents,
              'renderer-health',
              seekRevision,
            ).filter((event) => event.frame.rendezvousId === recoveryRendezvousId);
            const samePreparedState = Boolean(
              firstArm &&
              recoveryArm &&
              firstArm.frame.queueItemId !== null &&
              firstArm.frame.runId !== null &&
              firstArm.frame.queueItemId === recoveryArm.frame.queueItemId &&
              firstArm.frame.runId === recoveryArm.frame.runId &&
              firstArm.frame.revision === recoveryArm.frame.revision,
            );
            const samePreparedReady = Boolean(
              firstArm &&
              targetSourceReady.length === 2 &&
              targetSourceReady.every(
                (event) =>
                  event.frame.queueItemId === firstArm.frame.queueItemId &&
                  event.frame.runId === firstArm.frame.runId &&
                  event.frame.revision === firstArm.frame.revision,
              ),
            );
            const exactLateDispatch = Boolean(
              fault?.dispatched &&
              fault.dispatchError === null &&
              fault.rendezvousId === firstRendezvousId &&
              fault.finalizeByRoomTimeMs !== null &&
              fault.observedAtRoomTimeMs !== null &&
              fault.delayMs !== null &&
              Math.abs(
                fault.observedAtRoomTimeMs +
                  fault.delayMs -
                  (fault.finalizeByRoomTimeMs + LATE_ARM_MARGIN_MS),
              ) < 0.001,
            );
            return {
              exactLateDispatch,
              lateCancelOrdered: firstArmIndex >= 0 && cancelIndex > firstArmIndex,
              recoveryArmOrdered: recoveryArmIndex > cancelIndex,
              samePreparedState,
              samePreparedReady,
              targetArmCount: targetArms.length,
              prepareCount: targetPrepare.length,
              sourceReadyCount: targetSourceReady.length,
              sourceOfferCount,
              runBindingCount,
              recoveredHealthPublished: recoveredHealth.length > 0,
              hostRevision: host.renderer?.revision,
              hostPosition: host.controller?.timeline.positionSeconds,
              hostConnectionCount: host.controller?.activeConnectionCount,
              guestRevision: guest.controller?.timeline.revision,
              guestPosition: guest.controller?.timeline.positionSeconds,
              guestConnectionCount: guest.controller?.activeConnectionCount,
              connectionClosed:
                hostEvents.some((event) => event.direction === 'connection-closed') ||
                guestEvents.some((event) => event.direction === 'connection-closed'),
            };
          },
          { timeout: 45_000 },
        )
        .toEqual({
          exactLateDispatch: true,
          lateCancelOrdered: true,
          recoveryArmOrdered: true,
          samePreparedState: true,
          samePreparedReady: true,
          targetArmCount: 2,
          prepareCount: 1,
          sourceReadyCount: 2,
          sourceOfferCount: 1,
          runBindingCount: 1,
          recoveredHealthPublished: true,
          hostRevision: seekRevision,
          hostPosition: SEEK_SECONDS,
          hostConnectionCount: 1,
          guestRevision: seekRevision,
          guestPosition: SEEK_SECONDS,
          guestConnectionCount: 1,
          connectionClosed: false,
        });

      const recovered = await readUniversalRuntime(pair.hostPage);
      const recoveredArms = targetWireEvents(
        recovered.transportEvents,
        'rendezvous-arm',
        seekRevision,
      );
      recoveredRendezvousId = recoveredArms[1]?.frame.rendezvousId ?? null;
      if (!recoveredRendezvousId) {
        throw new Error('MP3 recovery did not expose its fresh rendezvous ID');
      }
      await waitForBoundedPlayback(pair.hostPage, pair.guestPage);
    } catch (error) {
      await logUniversalDiagnostics('mp3-seek-failure', pair.hostPage, pair.guestPage);
      throw error;
    } finally {
      await restoreLateArmReceiptDelay(pair.guestPage);
    }
    expect(await readLateArmPatch(pair.guestPage)).toBeNull();

    try {
      await expect
        .poll(
          async () => {
            const [host, guest] = await Promise.all([
              readUniversalRuntime(pair.hostPage),
              readUniversalRuntime(pair.guestPage),
            ]);
            const hostEvents = transportEvents(host.transportEvents);
            const guestEvents = transportEvents(guest.transportEvents);
            const targetArms = targetWireEvents(
              host.transportEvents,
              'rendezvous-arm',
              seekRevision,
            );
            const healthEvents = targetWireEvents(
              guest.transportEvents,
              'renderer-health',
              seekRevision,
            ).filter((event) => event.frame.rendezvousId === recoveredRendezvousId);
            const firstHealth = healthEvents[0];
            const lastHealth = healthEvents.at(-1);
            const healthSpanMs =
              firstHealth && lastHealth ? lastHealth.atMonotonicMs - firstHealth.atMonotonicMs : 0;
            return {
              healthCountReached: healthEvents.length >= MIN_RENDERER_HEALTH_EVENT_COUNT,
              healthSpanPassedOriginalLease: healthSpanMs > MIN_RENDERER_HEALTH_SPAN_MS,
              targetArmCount: targetArms.length,
              distinctTargetArmCount: new Set(targetArms.map((event) => event.frame.rendezvousId))
                .size,
              hostPhase: host.controller?.timeline.phase,
              hostRevision: host.controller?.timeline.revision,
              hostConnectionCount: host.controller?.activeConnectionCount,
              guestPhase: guest.controller?.timeline.phase,
              guestRevision: guest.controller?.timeline.revision,
              guestConnectionCount: guest.controller?.activeConnectionCount,
              connectionClosed:
                hostEvents.some((event) => event.direction === 'connection-closed') ||
                guestEvents.some((event) => event.direction === 'connection-closed'),
            };
          },
          { timeout: 25_000 },
        )
        .toEqual({
          healthCountReached: true,
          healthSpanPassedOriginalLease: true,
          targetArmCount: 2,
          distinctTargetArmCount: 2,
          hostPhase: 'playing',
          hostRevision: seekRevision,
          hostConnectionCount: 1,
          guestPhase: 'playing',
          guestRevision: seekRevision,
          guestConnectionCount: 1,
          connectionClosed: false,
        });
    } catch (error) {
      await logUniversalDiagnostics('mp3-renderer-health-failure', pair.hostPage, pair.guestPage);
      throw error;
    }

    const queueItemId = initial.host.renderer!.queueItemId;
    await pair.hostPage.evaluate((id) => {
      const bus = (window as unknown as Record<string, unknown>).__MUSIXQUARE_BUS__ as
        | { emit: (type: string, ...args: unknown[]) => void }
        | undefined;
      if (!bus) throw new Error('E2E event bridge unavailable');
      bus.emit('playlist:play-track', id);
    }, queueItemId);
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
