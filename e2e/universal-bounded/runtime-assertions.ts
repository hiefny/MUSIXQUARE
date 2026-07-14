import { expect, type Page } from '@playwright/test';

interface UniversalConsoleDiagnostic {
  readonly type: 'error' | 'warning';
  readonly text: string;
  readonly location: Readonly<{ url: string; lineNumber: number; columnNumber: number }>;
  args: readonly unknown[];
}

const consoleDiagnostics = new WeakMap<Page, UniversalConsoleDiagnostic[]>();
const MAX_CONSOLE_DIAGNOSTICS = 64;

export function captureUniversalConsole(page: Page, role: 'host' | 'guest'): void {
  const entries: UniversalConsoleDiagnostic[] = [];
  consoleDiagnostics.set(page, entries);
  page.on('console', (message) => {
    const type = message.type();
    if (type !== 'error' && type !== 'warning') return;
    const entry: UniversalConsoleDiagnostic = {
      type,
      text: message.text(),
      location: message.location(),
      args: [],
    };
    entries.push(entry);
    if (entries.length > MAX_CONSOLE_DIAGNOSTICS) entries.shift();
    console.log(`[universal-e2e:${role}:${type}] ${entry.text}`);
    void Promise.all(
      message.args().map(async (handle) => {
        try {
          return await handle.evaluate((value) => {
            const describeError = (error: Error, depth: number): unknown => ({
              name: error.name,
              message: error.message,
              stack: error.stack ?? null,
              cause:
                depth < 5 && error.cause instanceof Error
                  ? describeError(error.cause, depth + 1)
                  : error.cause === undefined
                    ? null
                    : String(error.cause),
            });
            return value instanceof Error ? describeError(value, 0) : value;
          });
        } catch {
          return '[unserializable console argument]';
        }
      }),
    ).then((args) => {
      entry.args = args;
    });
  });
}

export interface UniversalRendererSnapshot {
  readonly queueItemId: string;
  readonly backend: 'audio-buffer' | 'bounded-stream';
  readonly phase: string;
  readonly revision: number;
  readonly durationSeconds: number | null;
  readonly positionSeconds: number;
  readonly bufferedAheadSeconds: number;
  readonly underrunCount: number;
  readonly errorCode: string | null;
}

export interface UniversalControllerSnapshot {
  readonly roomRole: 'host' | 'guest' | null;
  readonly activeConnectionCount: number;
  readonly timeline: {
    readonly phase: 'stopped' | 'playing' | 'paused';
    readonly revision: number;
    readonly positionSeconds: number;
    readonly run: { readonly queueItemId: string; readonly runId: string } | null;
  };
}

export interface UniversalPeerRangePhysicalReadDiagnostics {
  readonly schemaVersion: 1;
  readonly readByteLimit: number;
  readonly readCount: number;
  readonly settledReadCount: number;
  readonly requestedByteCount: number;
  readonly maxRequestByteLength: number;
  readonly pendingReadCount: number;
  readonly maxConcurrentReadCount: number;
}

export interface UniversalRuntimeSnapshot {
  readonly schemaVersion: number;
  readonly profileId: string;
  readonly policyMode: string;
  readonly semanticPlaybackCohortId: string;
  readonly enabled: boolean;
  readonly hostRoom: unknown;
  readonly renderer: UniversalRendererSnapshot | null;
  readonly controller: UniversalControllerSnapshot | null;
  readonly peerRangePhysicalReads: UniversalPeerRangePhysicalReadDiagnostics;
  readonly transportEvents: readonly unknown[];
}

interface UniversalObservationHookStatus {
  readonly stateHook: boolean;
  readonly stateReadable: boolean;
  readonly busHook: boolean;
  readonly projectionHook: boolean;
}

async function readObservationHookStatus(page: Page): Promise<UniversalObservationHookStatus> {
  return page.evaluate(() => {
    const root = window as unknown as Record<string, unknown>;
    const get = root.__MUSIXQUARE_GET_STATE__;
    let stateReadable = false;
    if (typeof get === 'function') {
      try {
        stateReadable = typeof get('playback.lifecycle') === 'string';
      } catch {
        stateReadable = false;
      }
    }
    return {
      stateHook: typeof get === 'function',
      stateReadable,
      busHook: typeof root.__MUSIXQUARE_BUS__ === 'object' && root.__MUSIXQUARE_BUS__ !== null,
      projectionHook: typeof root.__MUSIXQUARE_GET_PLAYBACK_PROJECTION__ === 'function',
    };
  });
}

export async function expectUniversalObservationHooks(page: Page): Promise<void> {
  await expect
    .poll(() => readObservationHookStatus(page), {
      message: 'Universal bounded candidate did not install its E2E observation hooks',
    })
    .toEqual({
      stateHook: true,
      stateReadable: true,
      busHook: true,
      projectionHook: true,
    });
}

export async function readUniversalRuntime(page: Page): Promise<UniversalRuntimeSnapshot> {
  return page.evaluate(() => {
    const bridge = (
      window as unknown as Record<
        string,
        | {
            schemaVersion: number;
            profileId: string;
            policyMode: string;
            semanticPlaybackCohortId: string;
            enabled: () => boolean;
            hostRoomSnapshot: () => unknown;
            hostRendererSnapshot: () => unknown;
            controllerSnapshot: () => unknown;
            peerRangePhysicalReads: () => UniversalPeerRangePhysicalReadDiagnostics;
            transportEvents: () => readonly unknown[];
          }
        | undefined
      >
    ).__MUSIXQUARE_FILE_PLAYBACK_E2E__;
    if (!bridge) throw new Error('Universal bounded runtime bridge is unavailable');
    return {
      schemaVersion: bridge.schemaVersion,
      profileId: bridge.profileId,
      policyMode: bridge.policyMode,
      semanticPlaybackCohortId: bridge.semanticPlaybackCohortId,
      enabled: bridge.enabled(),
      hostRoom: bridge.hostRoomSnapshot(),
      renderer: bridge.hostRendererSnapshot(),
      controller: bridge.controllerSnapshot(),
      peerRangePhysicalReads: bridge.peerRangePhysicalReads(),
      transportEvents: bridge.transportEvents(),
    } as UniversalRuntimeSnapshot;
  });
}

export async function expectUniversalRoom(page: Page, role: 'host' | 'guest'): Promise<void> {
  await expectUniversalObservationHooks(page);
  await expect
    .poll(async () => readUniversalRuntime(page), {
      message: `${role} did not establish the universal bounded runtime`,
    })
    .toMatchObject({
      schemaVersion: 1,
      profileId: 'v2-universal-v1',
      policyMode: 'universal-v1',
      semanticPlaybackCohortId:
        'file-playback;session=v2;route=universal-v1;flac=wasm-0.2.10;linear-pcm=worker-v1;mp3=mpg123-1.0.3;adts-aac=webcodecs-v1;m4a-aac=webcodecs-v1',
      enabled: true,
      controller: {
        roomRole: role,
        activeConnectionCount: 1,
      },
    });
}

export async function waitForBoundedPlayback(
  hostPage: Page,
  guestPage: Page,
  options: Readonly<{ timeout?: number }> = {},
): Promise<Readonly<{ host: UniversalRuntimeSnapshot; guest: UniversalRuntimeSnapshot }>> {
  try {
    await expect
      .poll(async () => {
        const [host, guest] = await Promise.all([
          readUniversalRuntime(hostPage),
          readUniversalRuntime(guestPage),
        ]);
        return {
          hostBackend: host.renderer?.backend ?? null,
          hostPhase: host.renderer?.phase ?? null,
          guestPhase: guest.controller?.timeline.phase ?? null,
          hostRevision: host.renderer?.revision ?? null,
          guestRevision: guest.controller?.timeline.revision ?? null,
        };
      }, options)
      .toMatchObject({
        hostBackend: 'bounded-stream',
        hostPhase: 'playing',
        guestPhase: 'playing',
      });
  } catch (error) {
    await logUniversalDiagnostics('playback-timeout', hostPage, guestPage);
    throw error;
  }

  const [host, guest] = await Promise.all([
    readUniversalRuntime(hostPage),
    readUniversalRuntime(guestPage),
  ]);
  expect(host.renderer?.queueItemId).toBeTruthy();
  expect(host.renderer?.queueItemId).toBe(guest.controller?.timeline.run?.queueItemId);
  expect(host.renderer?.revision).toBe(guest.controller?.timeline.revision);
  expect(host.renderer?.errorCode).toBeNull();
  expect(host.peerRangePhysicalReads).toMatchObject({
    schemaVersion: 1,
    readByteLimit: expect.any(Number),
    readCount: expect.any(Number),
    settledReadCount: expect.any(Number),
    requestedByteCount: expect.any(Number),
    maxRequestByteLength: expect.any(Number),
    pendingReadCount: expect.any(Number),
    maxConcurrentReadCount: expect.any(Number),
  });
  expect(host.peerRangePhysicalReads.readCount).toBeGreaterThan(0);
  expect(host.peerRangePhysicalReads.requestedByteCount).toBeGreaterThanOrEqual(
    host.peerRangePhysicalReads.readCount,
  );
  expect(host.peerRangePhysicalReads.maxRequestByteLength).toBeGreaterThan(0);
  expect(host.peerRangePhysicalReads.maxRequestByteLength).toBeLessThanOrEqual(
    host.peerRangePhysicalReads.readByteLimit,
  );
  expect(host.peerRangePhysicalReads.pendingReadCount).toBeGreaterThanOrEqual(0);
  expect(host.peerRangePhysicalReads.pendingReadCount).toBeLessThanOrEqual(
    host.peerRangePhysicalReads.maxConcurrentReadCount,
  );
  expect(host.peerRangePhysicalReads.maxConcurrentReadCount).toBeGreaterThan(0);
  expect(
    host.peerRangePhysicalReads.settledReadCount + host.peerRangePhysicalReads.pendingReadCount,
  ).toBe(host.peerRangePhysicalReads.readCount);
  expect(guest.transportEvents, 'guest did not report exact physical renderer evidence').toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        direction: 'required-sent',
        frame: expect.objectContaining({
          kind: 'renderer-health',
          queueItemId: guest.controller?.timeline.run?.queueItemId,
          runId: guest.controller?.timeline.run?.runId,
          revision: guest.controller?.timeline.revision,
          renderedFrame: expect.any(Number),
        }),
      }),
    ]),
  );
  return Object.freeze({ host, guest });
}

export async function expectPeerRangePhysicalReadsRetired(hostPage: Page): Promise<void> {
  await expect
    .poll(async () => {
      const diagnostics = (await readUniversalRuntime(hostPage)).peerRangePhysicalReads;
      return {
        readCount: diagnostics.readCount,
        pendingReadCount: diagnostics.pendingReadCount,
        allReadsAccountedFor:
          diagnostics.settledReadCount + diagnostics.pendingReadCount === diagnostics.readCount,
      };
    })
    .toMatchObject({
      readCount: expect.any(Number),
      pendingReadCount: 0,
      allReadsAccountedFor: true,
    });

  const diagnostics = (await readUniversalRuntime(hostPage)).peerRangePhysicalReads;
  expect(diagnostics.readCount).toBeGreaterThan(0);
}

async function readUniversalUiDiagnostics(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const root = window as unknown as Record<string, unknown>;
    const get = root.__MUSIXQUARE_GET_STATE__ as ((path: string) => unknown) | undefined;
    const project = root.__MUSIXQUARE_GET_PLAYBACK_PROJECTION__ as (() => unknown) | undefined;
    const readState = (path: string): unknown => {
      try {
        return typeof get === 'function' ? get(path) : null;
      } catch (error) {
        return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
    };
    const toast = document.querySelector('#toast');
    const toastMessage = document.querySelector<HTMLElement>('#toast-msg');
    return {
      lifecycle: readState('playback.lifecycle'),
      filesCurrent: readState('files.current'),
      projection: typeof project === 'function' ? project() : null,
      trackTitle: document.querySelector('#track-title')?.textContent ?? null,
      loadingText: document.querySelector('#header-loading-text')?.textContent ?? null,
      toast: {
        visible: toast?.classList.contains('show') ?? false,
        text: toastMessage?.textContent ?? null,
        title: toastMessage?.title ?? null,
      },
      systemMessages: [...document.querySelectorAll('.system-message')].map(
        (element) => element.textContent,
      ),
    };
  });
}

export async function logUniversalDiagnostics(
  label: string,
  hostPage: Page,
  guestPage: Page,
): Promise<void> {
  const [host, guest, hostUi, guestUi] = await Promise.all([
    readUniversalRuntime(hostPage),
    readUniversalRuntime(guestPage),
    readUniversalUiDiagnostics(hostPage),
    readUniversalUiDiagnostics(guestPage),
  ]);
  console.log(
    `[universal-e2e:${label}] ${JSON.stringify({
      host,
      guest,
      hostUi,
      guestUi,
      hostConsole: consoleDiagnostics.get(hostPage) ?? [],
      guestConsole: consoleDiagnostics.get(guestPage) ?? [],
    })}`,
  );
}

export async function expectNoLegacyResident(hostPage: Page, guestPage: Page): Promise<void> {
  const values = await Promise.all(
    [hostPage, guestPage].map((page) =>
      page.evaluate(() => {
        const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
          | ((path: string) => unknown)
          | undefined;
        if (typeof get !== 'function' || typeof get('playback.lifecycle') !== 'string') {
          throw new Error('Universal E2E state observation hook is unavailable');
        }
        return get('files.current');
      }),
    ),
  );
  expect(values).toEqual([null, null]);
}

export async function expectExactPlayingProjection(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const project = (window as unknown as Record<string, unknown>)
          .__MUSIXQUARE_GET_PLAYBACK_PROJECTION__ as (() => unknown) | undefined;
        if (typeof project !== 'function') {
          throw new Error('Universal E2E playback projection hook is unavailable');
        }
        return project();
      }),
    )
    .toBe('PLAYING_AUDIO');
}
