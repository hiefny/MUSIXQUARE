import { expect, test, type CDPSession, type Page } from '@playwright/test';
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
const BACKGROUND_HOLD_MS = 3_100;
const VISIBILITY_PROBE_KEY = '__MUSIXQUARE_HOST_BACKGROUND_VISIBILITY__';

interface VisibilityProbeEvent {
  readonly state: DocumentVisibilityState;
  readonly hidden: boolean;
  readonly atEpochMs: number;
}

interface PlaybackView {
  readonly activity: unknown;
  readonly lifecycle: unknown;
  readonly mode: unknown;
  readonly seekSeconds: number | null;
  readonly hostConnectionOpen: boolean;
}

interface UniversalTransportEvent {
  readonly direction?: unknown;
}

let pair: HostGuestPair;

function hasConnectionClosed(events: readonly unknown[]): boolean {
  return (events as readonly UniversalTransportEvent[]).some(
    (event) => event.direction === 'connection-closed',
  );
}

async function readPlaybackView(page: Page): Promise<PlaybackView> {
  return page.evaluate(() => {
    const root = window as unknown as Record<string, unknown>;
    const get = root.__MUSIXQUARE_GET_STATE__ as ((path: string) => unknown) | undefined;
    if (typeof get !== 'function') {
      throw new Error('Universal E2E state observation hook is unavailable');
    }
    const seekValue = Number(
      (document.getElementById('seek-slider') as HTMLInputElement | null)?.value,
    );
    const hostConnection = get('network.hostConn') as { open?: unknown } | null;
    return {
      activity: get('playback.activity'),
      lifecycle: get('playback.lifecycle'),
      mode: get('playback.mode'),
      seekSeconds: Number.isFinite(seekValue) ? seekValue : null,
      hostConnectionOpen: hostConnection?.open === true,
    };
  });
}

async function installVisibilityProbe(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const root = window as unknown as Record<string, unknown>;
    if (root[key] !== undefined) {
      throw new Error('Host background visibility probe is already installed');
    }
    const probe: {
      state: DocumentVisibilityState;
      readonly events: VisibilityProbeEvent[];
    } = {
      state: 'visible',
      events: [],
    };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => probe.state,
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => probe.state === 'hidden',
    });
    document.addEventListener('visibilitychange', () => {
      probe.events.push({
        state: document.visibilityState,
        hidden: document.hidden,
        atEpochMs: Date.now(),
      });
    });
    Object.defineProperty(root, key, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: probe,
    });
  }, VISIBILITY_PROBE_KEY);
}

async function setProbedVisibility(
  page: Page,
  state: Extract<DocumentVisibilityState, 'hidden' | 'visible'>,
): Promise<void> {
  await page.evaluate(
    ({ key, nextState }) => {
      const probe = (window as unknown as Record<string, unknown>)[key] as
        | { state: DocumentVisibilityState }
        | undefined;
      if (!probe) throw new Error('Host background visibility probe is unavailable');
      probe.state = nextState;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    { key: VISIBILITY_PROBE_KEY, nextState: state },
  );
}

async function readVisibilityProbe(page: Page): Promise<readonly VisibilityProbeEvent[]> {
  return page.evaluate((key) => {
    const probe = (window as unknown as Record<string, unknown>)[key] as
      | { readonly events?: unknown }
      | undefined;
    if (!Array.isArray(probe?.events)) {
      throw new Error('Host background visibility probe is unavailable');
    }
    return probe.events.map((event) => ({ ...event })) as VisibilityProbeEvent[];
  }, VISIBILITY_PROBE_KEY);
}

async function bounceHostThroughBackground(
  page: Page,
  cdp: CDPSession,
): Promise<readonly VisibilityProbeEvent[]> {
  expect(
    await page.evaluate(() => ({
      state: document.visibilityState,
      hidden: document.hidden,
    })),
  ).toEqual({ state: 'visible', hidden: false });
  await installVisibilityProbe(page);
  let frozen = false;
  let hidden = false;
  try {
    await setProbedVisibility(page, 'hidden');
    hidden = true;
    await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
    frozen = true;
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, BACKGROUND_HOLD_MS);
    });
  } finally {
    if (frozen) {
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    }
    if (hidden) {
      await setProbedVisibility(page, 'visible');
    }
  }

  await expect
    .poll(() => readVisibilityProbe(page), {
      message: 'Chromium did not expose the expected hidden-to-visible lifecycle bounce',
      timeout: 10_000,
    })
    .toEqual([
      {
        state: 'hidden',
        hidden: true,
        atEpochMs: expect.any(Number),
      },
      {
        state: 'visible',
        hidden: false,
        atEpochMs: expect.any(Number),
      },
    ]);
  return readVisibilityProbe(page);
}

test.describe('universal MP3 host background resume', () => {
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

  test('keeps the V2 MP3 session connected and playing after a three-second host background bounce', async () => {
    test.setTimeout(180_000);
    await connectHostAndGuest(pair.hostPage, pair.guestPage);
    await Promise.all([
      expectUniversalRoom(pair.hostPage, 'host'),
      expectUniversalRoom(pair.guestPage, 'guest'),
    ]);

    await pair.hostPage.locator('#file-input').setInputFiles(MP3_FIXTURE);
    await waitForBoundedPlayback(pair.hostPage, pair.guestPage, { timeout: 45_000 });
    await expectNoLegacyResident(pair.hostPage, pair.guestPage);

    await expect
      .poll(async () => {
        const [host, guest] = await Promise.all([
          readUniversalRuntime(pair.hostPage),
          readPlaybackView(pair.guestPage),
        ]);
        return {
          hostAdvanced: (host.renderer?.positionSeconds ?? 0) > 0.2,
          guestAdvanced: (guest.seekSeconds ?? 0) > 0.2,
          guestConnectionOpen: guest.hostConnectionOpen,
        };
      })
      .toEqual({
        hostAdvanced: true,
        guestAdvanced: true,
        guestConnectionOpen: true,
      });

    const [beforeHost, beforeGuest] = await Promise.all([
      readUniversalRuntime(pair.hostPage),
      readPlaybackView(pair.guestPage),
    ]);
    expect(beforeHost.renderer?.positionSeconds ?? 0).toBeGreaterThan(0);
    expect(beforeGuest.seekSeconds ?? 0).toBeGreaterThan(0);

    const cdp = await pair.hostContext.newCDPSession(pair.hostPage);
    let visibilityEvents: readonly VisibilityProbeEvent[];
    try {
      visibilityEvents = await bounceHostThroughBackground(pair.hostPage, cdp);
    } finally {
      await cdp.detach().catch(() => undefined);
    }

    expect(visibilityEvents[1]!.atEpochMs - visibilityEvents[0]!.atEpochMs).toBeGreaterThanOrEqual(
      2_900,
    );
    expect(visibilityEvents[1]!.atEpochMs - visibilityEvents[0]!.atEpochMs).toBeLessThan(15_000);

    try {
      await expect
        .poll(
          async () => {
            const [host, guest, hostView, guestView] = await Promise.all([
              readUniversalRuntime(pair.hostPage),
              readUniversalRuntime(pair.guestPage),
              readPlaybackView(pair.hostPage),
              readPlaybackView(pair.guestPage),
            ]);
            return {
              hostConnectionCount: host.controller?.activeConnectionCount ?? null,
              guestConnectionCount: guest.controller?.activeConnectionCount ?? null,
              hostRendererPhase: host.renderer?.phase ?? null,
              hostTimelinePhase: host.controller?.timeline.phase ?? null,
              guestTimelinePhase: guest.controller?.timeline.phase ?? null,
              hostActivity: hostView.activity,
              hostMode: hostView.mode,
              guestActivity: guestView.activity,
              guestLifecycle: guestView.lifecycle,
              guestMode: guestView.mode,
              guestConnectionOpen: guestView.hostConnectionOpen,
              connectionClosed:
                hasConnectionClosed(host.transportEvents) ||
                hasConnectionClosed(guest.transportEvents),
            };
          },
          { timeout: 25_000 },
        )
        .toEqual({
          hostConnectionCount: 1,
          guestConnectionCount: 1,
          hostRendererPhase: 'playing',
          hostTimelinePhase: 'playing',
          guestTimelinePhase: 'playing',
          hostActivity: 'playing',
          hostMode: 'file',
          guestActivity: 'playing',
          guestLifecycle: 'PLAYING',
          guestMode: 'file',
          guestConnectionOpen: true,
          connectionClosed: false,
        });

      await expect
        .poll(
          async () => {
            const [host, guest] = await Promise.all([
              readUniversalRuntime(pair.hostPage),
              readPlaybackView(pair.guestPage),
            ]);
            return {
              hostAdvanced:
                (host.renderer?.positionSeconds ?? 0) >
                (beforeHost.renderer?.positionSeconds ?? 0) + 0.25,
              guestAdvanced: (guest.seekSeconds ?? 0) > (beforeGuest.seekSeconds ?? 0) + 0.25,
            };
          },
          { timeout: 20_000 },
        )
        .toEqual({ hostAdvanced: true, guestAdvanced: true });

      const [movingHost, movingGuest] = await Promise.all([
        readUniversalRuntime(pair.hostPage),
        readPlaybackView(pair.guestPage),
      ]);
      await pair.hostPage.waitForTimeout(1_000);
      const [laterHost, laterGuest, laterGuestRuntime] = await Promise.all([
        readUniversalRuntime(pair.hostPage),
        readPlaybackView(pair.guestPage),
        readUniversalRuntime(pair.guestPage),
      ]);
      expect(laterHost.renderer?.positionSeconds ?? 0).toBeGreaterThan(
        (movingHost.renderer?.positionSeconds ?? 0) + 0.2,
      );
      expect(laterGuest.seekSeconds ?? 0).toBeGreaterThan((movingGuest.seekSeconds ?? 0) + 0.2);
      expect(hasConnectionClosed(laterHost.transportEvents)).toBe(false);
      expect(hasConnectionClosed(laterGuestRuntime.transportEvents)).toBe(false);
    } catch (error) {
      await logUniversalDiagnostics(
        'mp3-host-background-resume-failure',
        pair.hostPage,
        pair.guestPage,
      );
      throw error;
    }
  });
});
