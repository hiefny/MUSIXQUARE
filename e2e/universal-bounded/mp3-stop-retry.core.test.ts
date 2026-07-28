import { expect, test, type Page } from '@playwright/test';
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
  expectNoLegacyResident,
  expectUniversalRoom,
  logUniversalDiagnostics,
  readUniversalRuntime,
  waitForBoundedPlayback,
} from './runtime-assertions.ts';

const MP3_FIXTURE = resolve('e2e/fixtures/test-01.mp3');
const WORKER_FAULT_KEY = '__MUSIXQUARE_MP3_PRECOMMIT_WORKER_FAULT__';

interface AppPlaybackSnapshot {
  readonly mode: unknown;
  readonly activity: unknown;
  readonly queueItemId: unknown;
  readonly buttonAriaDisabled: string | null;
  readonly buttonDisabled: boolean;
  readonly buttonBusy: boolean;
  readonly buttonLoading: boolean;
  readonly durationText: string;
  readonly seekValue: number | null;
}

interface WorkerFaultSnapshot {
  readonly fired: boolean;
  readonly restored: boolean;
  readonly targetUrl: string | null;
}

interface UniversalTransportEvent {
  readonly direction?: unknown;
}

let pair: HostGuestPair;

async function readAppPlayback(page: Page): Promise<AppPlaybackSnapshot> {
  return page.evaluate(() => {
    const root = window as unknown as Record<string, unknown>;
    const get = root.__MUSIXQUARE_GET_STATE__ as ((path: string) => unknown) | undefined;
    if (typeof get !== 'function') {
      throw new Error('Universal E2E state observation hook is unavailable');
    }
    const button = document.getElementById('play-btn');
    const rawSeekValue = Number(
      (document.getElementById('seek-slider') as HTMLInputElement | null)?.value,
    );
    return {
      mode: get('playback.mode'),
      activity: get('playback.activity'),
      queueItemId: get('playlist.currentQueueItemId'),
      buttonAriaDisabled: button?.getAttribute('aria-disabled') ?? null,
      buttonDisabled: (button as HTMLButtonElement | null)?.disabled ?? false,
      buttonBusy: button?.getAttribute('aria-busy') === 'true',
      buttonLoading: button?.classList.contains('yt-syncing') ?? false,
      durationText: document.getElementById('time-dur')?.textContent?.trim() ?? '',
      seekValue: Number.isFinite(rawSeekValue) ? rawSeekValue : null,
    };
  });
}

function hasConnectionClosed(events: readonly unknown[]): boolean {
  return (events as readonly UniversalTransportEvent[]).some(
    (event) => event.direction === 'connection-closed',
  );
}

async function stopThroughApplication(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bus = (window as unknown as Record<string, unknown>).__MUSIXQUARE_BUS__ as
      | { emit: (type: string, ...args: unknown[]) => void }
      | undefined;
    if (!bus) throw new Error('Universal E2E event bridge is unavailable');
    bus.emit('player:stop-all-media', { cancelInFlight: true });
  });
}

async function waitForApplicationStopped(
  hostPage: Page,
  guestPage: Page,
  queueItemId: string,
): Promise<Readonly<{ hostRevision: number; guestRevision: number }>> {
  try {
    await expect
      .poll(
        async () => {
          const [host, guest, app] = await Promise.all([
            readUniversalRuntime(hostPage),
            readUniversalRuntime(guestPage),
            readAppPlayback(hostPage),
          ]);
          return {
            hostRenderer: host.renderer,
            hostPhase: host.controller?.timeline.phase ?? null,
            guestPhase: guest.controller?.timeline.phase ?? null,
            hostConnectionCount: host.controller?.activeConnectionCount ?? null,
            guestConnectionCount: guest.controller?.activeConnectionCount ?? null,
            appMode: app.mode,
            appActivity: app.activity,
            queueItemId: app.queueItemId,
            buttonAriaDisabled: app.buttonAriaDisabled,
            buttonDisabled: app.buttonDisabled,
            buttonBusy: app.buttonBusy,
            buttonLoading: app.buttonLoading,
          };
        },
        { timeout: 25_000 },
      )
      .toEqual({
        hostRenderer: null,
        hostPhase: 'stopped',
        guestPhase: 'stopped',
        hostConnectionCount: 1,
        guestConnectionCount: 1,
        appMode: null,
        appActivity: 'idle',
        queueItemId,
        buttonAriaDisabled: 'false',
        buttonDisabled: false,
        buttonBusy: false,
        buttonLoading: false,
      });
  } catch (error) {
    await logUniversalDiagnostics('application-stop-timeout', hostPage, guestPage);
    throw error;
  }

  const [host, guest] = await Promise.all([
    readUniversalRuntime(hostPage),
    readUniversalRuntime(guestPage),
  ]);
  expect(host.controller).not.toBeNull();
  expect(guest.controller).not.toBeNull();
  return Object.freeze({
    hostRevision: host.controller!.timeline.revision,
    guestRevision: guest.controller!.timeline.revision,
  });
}

async function expectConnectedAndOpen(hostPage: Page, guestPage: Page): Promise<void> {
  const [host, guest] = await Promise.all([
    readUniversalRuntime(hostPage),
    readUniversalRuntime(guestPage),
  ]);
  expect(host.controller?.activeConnectionCount).toBe(1);
  expect(guest.controller?.activeConnectionCount).toBe(1);
  expect(hasConnectionClosed(host.transportEvents)).toBe(false);
  expect(hasConnectionClosed(guest.transportEvents)).toBe(false);
}

async function expectPlayableUi(page: Page): Promise<void> {
  await expect
    .poll(() => readAppPlayback(page))
    .toMatchObject({
      mode: 'file',
      activity: 'playing',
      buttonAriaDisabled: 'false',
      buttonDisabled: false,
      buttonBusy: false,
      buttonLoading: false,
    });
  const app = await readAppPlayback(page);
  expect(app.durationText).not.toBe('');
  expect(app.durationText).not.toBe('0:00');
}

async function installOneShotMp3WorkerFailure(page: Page): Promise<void> {
  await page.evaluate((key) => {
    interface MutableWorkerFaultSnapshot {
      fired: boolean;
      restored: boolean;
      targetUrl: string | null;
    }

    interface BrowserPatch {
      readonly snapshot: MutableWorkerFaultSnapshot;
      restore(): void;
    }

    const root = window as unknown as Record<string, unknown>;
    if (root[key] !== undefined) throw new Error('MP3 Worker fault is already installed');

    const OriginalWorker = window.Worker;
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'Worker');
    const snapshot: MutableWorkerFaultSnapshot = {
      fired: false,
      restored: false,
      targetUrl: null,
    };
    let restored = false;

    const restoreWorker = (): void => {
      if (restored) return;
      restored = true;
      snapshot.restored = true;
      if (originalDescriptor) {
        Object.defineProperty(window, 'Worker', originalDescriptor);
      } else {
        Reflect.deleteProperty(window, 'Worker');
      }
    };

    const PatchedWorker = function (
      this: Worker,
      scriptURL: string | URL,
      options?: WorkerOptions,
    ): Worker {
      if (!new.target) throw new TypeError('Worker constructor requires new');
      const targetUrl = String(scriptURL);
      if (!snapshot.fired && /mp3-stream(?:\.worker)?/iu.test(targetUrl)) {
        snapshot.fired = true;
        snapshot.targetUrl = targetUrl;
        restoreWorker();
        throw new DOMException('Universal E2E one-shot MP3 Worker failure', 'OperationError');
      }
      return Reflect.construct(
        OriginalWorker,
        options === undefined ? [scriptURL] : [scriptURL, options],
        OriginalWorker,
      ) as Worker;
    } as unknown as typeof Worker;
    Object.setPrototypeOf(PatchedWorker, OriginalWorker);
    Object.defineProperty(PatchedWorker, 'prototype', {
      value: OriginalWorker.prototype,
    });
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      enumerable: originalDescriptor?.enumerable ?? false,
      writable: true,
      value: PatchedWorker,
    });

    const patch: BrowserPatch = {
      snapshot,
      restore: () => {
        restoreWorker();
        Reflect.deleteProperty(root, key);
      },
    };
    Object.defineProperty(root, key, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: patch,
    });
  }, WORKER_FAULT_KEY);
}

async function readWorkerFault(page: Page): Promise<WorkerFaultSnapshot | null> {
  return page.evaluate((key) => {
    const patch = (window as unknown as Record<string, unknown>)[key] as
      | { readonly snapshot?: WorkerFaultSnapshot }
      | undefined;
    return patch?.snapshot ? { ...patch.snapshot } : null;
  }, WORKER_FAULT_KEY);
}

async function restoreWorkerFault(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const patch = (window as unknown as Record<string, unknown>)[key] as
      | { restore?: () => void }
      | undefined;
    patch?.restore?.();
  }, WORKER_FAULT_KEY);
}

test.describe('universal MP3 application controls and retry', () => {
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
    await restoreWorkerFault(pair.hostPage).catch(() => undefined);
    const hostErrors = getPageErrors(pair.hostPage);
    const guestErrors = getPageErrors(pair.guestPage);
    await cleanupContexts(pair);
    expect(hostErrors, 'host page had an uncaught error').toHaveLength(0);
    expect(guestErrors, 'guest page had an uncaught error').toHaveLength(0);
  });

  test('fresh-starts the selected occurrence after application STOP and keeps pause stable', async () => {
    test.setTimeout(180_000);
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
      expectPlayableUi(pair.hostPage),
      expectNoLegacyResident(pair.hostPage, pair.guestPage),
      expectConnectedAndOpen(pair.hostPage, pair.guestPage),
    ]);
    expect(initial.host.renderer?.durationSeconds).toBeGreaterThan(0);
    const queueItemId = initial.host.renderer!.queueItemId;
    const initialRunId = initial.host.controller?.timeline.run?.runId;

    await stopThroughApplication(pair.hostPage);
    const stopped = await waitForApplicationStopped(pair.hostPage, pair.guestPage, queueItemId);
    expect(stopped.hostRevision).toBe(stopped.guestRevision);

    await pair.hostPage.locator('#play-btn').click();
    const restarted = await waitForBoundedPlayback(pair.hostPage, pair.guestPage, {
      timeout: 45_000,
    });
    await Promise.all([
      expectPlayableUi(pair.hostPage),
      expectNoLegacyResident(pair.hostPage, pair.guestPage),
      expectConnectedAndOpen(pair.hostPage, pair.guestPage),
    ]);
    expect(restarted.host.renderer?.queueItemId).toBe(queueItemId);
    expect(restarted.host.renderer?.durationSeconds).toBeGreaterThan(0);
    expect(restarted.host.renderer!.revision).toBeGreaterThan(stopped.hostRevision);
    expect(restarted.host.controller?.timeline.run?.runId).not.toBe(initialRunId);

    await pair.hostPage.locator('#play-btn').click();
    await expect
      .poll(async () => {
        const [host, guest, app] = await Promise.all([
          readUniversalRuntime(pair.hostPage),
          readUniversalRuntime(pair.guestPage),
          readAppPlayback(pair.hostPage),
        ]);
        return {
          hostRendererPhase: host.renderer?.phase ?? null,
          hostControllerPhase: host.controller?.timeline.phase ?? null,
          guestControllerPhase: guest.controller?.timeline.phase ?? null,
          appActivity: app.activity,
          buttonAriaDisabled: app.buttonAriaDisabled,
          buttonDisabled: app.buttonDisabled,
          buttonBusy: app.buttonBusy,
          buttonLoading: app.buttonLoading,
        };
      })
      .toEqual({
        hostRendererPhase: 'paused',
        hostControllerPhase: 'paused',
        guestControllerPhase: 'paused',
        appActivity: 'paused',
        buttonAriaDisabled: 'false',
        buttonDisabled: false,
        buttonBusy: false,
        buttonLoading: false,
      });

    const [pausedHost, pausedApp] = await Promise.all([
      readUniversalRuntime(pair.hostPage),
      readAppPlayback(pair.hostPage),
    ]);
    const pausedPosition = pausedHost.renderer!.positionSeconds;
    const pausedTimelinePosition = pausedHost.controller!.timeline.positionSeconds;
    const pausedSeekValue = pausedApp.seekValue;
    await pair.hostPage.waitForTimeout(1_200);
    const [heldHost, heldApp] = await Promise.all([
      readUniversalRuntime(pair.hostPage),
      readAppPlayback(pair.hostPage),
    ]);
    expect(heldHost.renderer?.phase).toBe('paused');
    expect(heldHost.renderer?.positionSeconds).toBeCloseTo(pausedPosition, 2);
    expect(heldHost.controller?.timeline.positionSeconds).toBeCloseTo(pausedTimelinePosition, 3);
    if (pausedSeekValue !== null && heldApp.seekValue !== null) {
      expect(heldApp.seekValue).toBeCloseTo(pausedSeekValue, 1);
    }

    await pair.hostPage.locator('#play-btn').click();
    await waitForBoundedPlayback(pair.hostPage, pair.guestPage, { timeout: 45_000 });
    await expect
      .poll(
        async () => (await readUniversalRuntime(pair.hostPage)).renderer?.positionSeconds ?? 0,
        { timeout: 15_000 },
      )
      .toBeGreaterThan(pausedPosition + 0.2);
    await Promise.all([
      expectPlayableUi(pair.hostPage),
      expectConnectedAndOpen(pair.hostPage, pair.guestPage),
    ]);
  });

  test('fails one stopped MP3 start before commit and succeeds on the next explicit Play', async () => {
    test.setTimeout(180_000);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await Promise.all([
      expectUniversalRoom(pair.hostPage, 'host'),
      expectUniversalRoom(pair.guestPage, 'guest'),
    ]);

    await pair.hostPage.locator('#file-input').setInputFiles(MP3_FIXTURE);
    const initial = await waitForBoundedPlayback(pair.hostPage, pair.guestPage, {
      timeout: 45_000,
    });
    const queueItemId = initial.host.renderer!.queueItemId;
    await stopThroughApplication(pair.hostPage);
    const stopped = await waitForApplicationStopped(pair.hostPage, pair.guestPage, queueItemId);

    await installOneShotMp3WorkerFailure(pair.hostPage);
    try {
      await pair.hostPage.locator('#play-btn').click();
      await expect
        .poll(() => readWorkerFault(pair.hostPage), { timeout: 20_000 })
        .toMatchObject({
          fired: true,
          restored: true,
          targetUrl: expect.stringMatching(/mp3-stream/iu),
        });
      const afterFailure = await waitForApplicationStopped(
        pair.hostPage,
        pair.guestPage,
        queueItemId,
      );
      expect(afterFailure.hostRevision).toBe(stopped.hostRevision);
      expect(afterFailure.guestRevision).toBe(stopped.guestRevision);
      await expectConnectedAndOpen(pair.hostPage, pair.guestPage);
    } catch (error) {
      await logUniversalDiagnostics('mp3-precommit-failure-timeout', pair.hostPage, pair.guestPage);
      throw error;
    } finally {
      await restoreWorkerFault(pair.hostPage);
    }

    await pair.hostPage.locator('#play-btn').click();
    const retried = await waitForBoundedPlayback(pair.hostPage, pair.guestPage, {
      timeout: 45_000,
    });
    expect(retried.host.renderer?.queueItemId).toBe(queueItemId);
    expect(retried.host.renderer?.durationSeconds).toBeGreaterThan(0);
    expect(retried.host.renderer!.revision).toBeGreaterThan(stopped.hostRevision);
    await Promise.all([
      expectPlayableUi(pair.hostPage),
      expectNoLegacyResident(pair.hostPage, pair.guestPage),
      expectConnectedAndOpen(pair.hostPage, pair.guestPage),
    ]);
  });
});
