import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setupGuest, setupHostAndStart } from '../helpers/setup-flow.ts';
import { waitForDeviceCount, waitForPlaylistCount } from '../helpers/wait.ts';

const GUEST_COUNT = 9;
const REMOTE_SHARE_HOST = 'share.musixquare.com';
const R2_HOST_SUFFIX = '.r2.cloudflarestorage.com';
const RTC_PROBE_KEY = '__MXQR_PRODUCTION_LIVE_RTCPCS__';
const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/test-01.mp3', import.meta.url));
const FIRST_TRACK = 'r2-live-current.mp3';
const SECOND_TRACK = 'r2-live-preload.mp3';
const FIRST_TRACK_TITLE = 'r2-live-current';
const SECOND_TRACK_TITLE = 'r2-live-preload';

interface LiveRoom {
  hostContext: BrowserContext;
  hostPage: Page;
  guestContexts: BrowserContext[];
  guestPages: Page[];
  successfulR2Puts: Set<string>;
  successfulDownloads: Array<Set<string>>;
  downloadRequestCounts: number[];
}

interface CandidatePairObservation {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  localType: RTCIceCandidateType | null;
  remoteType: RTCIceCandidateType | null;
}

function isSuccessful(status: number): boolean {
  return status >= 200 && status < 300;
}

async function instrumentPeerConnections(context: BrowserContext): Promise<void> {
  await context.addInitScript((key) => {
    const NativePeerConnection = window.RTCPeerConnection;
    const instances: RTCPeerConnection[] = [];
    const WrappedPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, args, newTarget) {
        const connection = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
        instances.push(connection);
        return connection;
      },
    });

    Object.defineProperty(window, 'RTCPeerConnection', {
      configurable: true,
      writable: true,
      value: WrappedPeerConnection,
    });
    Object.defineProperty(window, key, {
      configurable: false,
      writable: false,
      value: instances,
    });
  }, RTC_PROBE_KEY);
}

function observeHostR2(context: BrowserContext, successfulR2Puts: Set<string>): void {
  context.on('response', (response) => {
    if (response.request().method() !== 'PUT') return;
    try {
      const url = new URL(response.url());
      if (!url.hostname.endsWith(R2_HOST_SUFFIX)) return;
      console.log(`[production-live] R2 PUT ${response.status()} ${url.pathname}`);
      if (isSuccessful(response.status())) successfulR2Puts.add(url.pathname);
    } catch {
      // Ignore unrelated malformed/devtools URLs.
    }
  });
}

function observeGuestDownloads(
  context: BrowserContext,
  successfulDownloads: Set<string>,
  onRequest: () => void,
  guestNumber: number,
): void {
  context.on('request', (request) => {
    if (request.method() !== 'GET') return;
    try {
      const url = new URL(request.url());
      if (url.hostname === REMOTE_SHARE_HOST && url.pathname.startsWith('/download/')) {
        onRequest();
      }
    } catch {
      // Ignore unrelated malformed/devtools URLs.
    }
  });

  context.on('response', (response) => {
    if (response.request().method() !== 'GET') return;
    try {
      const url = new URL(response.url());
      if (url.hostname !== REMOTE_SHARE_HOST || !url.pathname.startsWith('/download/')) return;
      console.log(
        `[production-live] guest ${guestNumber} GET ${response.status()} ${url.pathname}`,
      );
      if (isSuccessful(response.status())) successfulDownloads.add(url.pathname);
    } catch {
      // Ignore unrelated malformed/devtools URLs.
    }
  });
}

async function createLiveRoom(browser: Browser): Promise<LiveRoom> {
  const hostContext = await browser.newContext();
  await instrumentPeerConnections(hostContext);
  const successfulR2Puts = new Set<string>();
  observeHostR2(hostContext, successfulR2Puts);
  const hostPage = await hostContext.newPage();

  const guestContexts: BrowserContext[] = [];
  const guestPages: Page[] = [];
  const successfulDownloads: Array<Set<string>> = [];
  const downloadRequestCounts = Array.from({ length: GUEST_COUNT }, () => 0);

  for (let index = 0; index < GUEST_COUNT; index += 1) {
    const context = await browser.newContext();
    const downloads = new Set<string>();
    observeGuestDownloads(
      context,
      downloads,
      () => {
        downloadRequestCounts[index] += 1;
      },
      index + 1,
    );
    guestContexts.push(context);
    guestPages.push(await context.newPage());
    successfulDownloads.push(downloads);
  }

  return {
    hostContext,
    hostPage,
    guestContexts,
    guestPages,
    successfulR2Puts,
    successfulDownloads,
    downloadRequestCounts,
  };
}

async function closeLiveRoom(room: LiveRoom | null): Promise<void> {
  if (!room) return;
  await Promise.all(room.guestContexts.map((context) => context.close().catch(() => undefined)));
  await room.hostContext.close().catch(() => undefined);
}

async function dismissFirstRunDialogIfPresent(page: Page): Promise<void> {
  const dialog = page.locator('#dialog-overlay');
  if (!(await dialog.evaluate((element) => element.classList.contains('show')))) return;

  const text = ((await dialog.textContent()) ?? '').trim().replace(/\s+/gu, ' ');
  const secondary = page.locator('#btn-dialog-secondary');
  if (!(await secondary.isVisible())) {
    throw new Error(`Unexpected pre-existing production dialog: ${text}`);
  }
  console.log(`[production-live] dismissing first-run dialog: ${text}`);
  await secondary.click();
  await expect(dialog).not.toHaveClass(/show/u, { timeout: 10_000 });
}

async function uploadProbeFiles(page: Page): Promise<void> {
  await dismissFirstRunDialogIfPresent(page);

  const bytes = await readFile(FIXTURE_PATH);
  await page.locator('#file-input').setInputFiles([
    { name: FIRST_TRACK, mimeType: 'audio/mpeg', buffer: bytes },
    { name: SECOND_TRACK, mimeType: 'audio/mpeg', buffer: bytes },
  ]);

  // The ninth confirmed-local guest must cross the product's direct-transfer
  // boundary and surface the real Cloudflare R2 consent dialog.
  const dialog = page.locator('#dialog-overlay');
  await expect(dialog).toHaveClass(/show/u, { timeout: 10_000 });
  const text = ((await dialog.textContent()) ?? '').trim().replace(/\s+/gu, ' ');
  if (!text.includes('Cloudflare R2') || !/(^|\D)8(\D|$)/u.test(text)) {
    throw new Error(`Expected the large-room Cloudflare R2 consent dialog, got: ${text}`);
  }
  console.log(`[production-live] large-room consent: ${text}`);
  await page.locator('#btn-dialog-ok').click();
  await expect(dialog).not.toHaveClass(/show/u, { timeout: 10_000 });
}

async function waitForTrackTitle(page: Page, fragment: string, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const element =
        document.getElementById('track-title') || document.querySelector('.track-title');
      return element?.textContent?.includes(expected) ?? false;
    },
    fragment,
    { timeout },
  );
}

async function readCandidatePairs(hostPage: Page): Promise<CandidatePairObservation[]> {
  return hostPage.evaluate(async (key): Promise<CandidatePairObservation[]> => {
    const connections =
      ((window as unknown as Record<string, unknown>)[key] as RTCPeerConnection[] | undefined) ??
      [];
    const observations: CandidatePairObservation[] = [];

    const candidateType = (
      stats: RTCStatsReport,
      candidateId: unknown,
    ): RTCIceCandidateType | null => {
      if (typeof candidateId !== 'string') return null;
      const candidate = stats.get(candidateId) as { candidateType?: unknown } | undefined;
      return typeof candidate?.candidateType === 'string'
        ? (candidate.candidateType as RTCIceCandidateType)
        : null;
    };

    for (const connection of connections) {
      if (connection.connectionState === 'closed') continue;
      let localType: RTCIceCandidateType | null = null;
      let remoteType: RTCIceCandidateType | null = null;

      try {
        const transport = connection.sctp?.transport as unknown as {
          iceTransport?: {
            getSelectedCandidatePair?: () => {
              local?: { type?: RTCIceCandidateType };
              remote?: { type?: RTCIceCandidateType };
            } | null;
          };
        };
        const selected = transport?.iceTransport?.getSelectedCandidatePair?.();
        localType = selected?.local?.type ?? null;
        remoteType = selected?.remote?.type ?? null;
      } catch {
        // Fall back to getStats below.
      }

      if (!localType || !remoteType) {
        try {
          const stats = await connection.getStats();
          let pair:
            | {
                localCandidateId?: unknown;
                remoteCandidateId?: unknown;
                selected?: unknown;
                nominated?: unknown;
                state?: unknown;
              }
            | undefined;
          for (const report of stats.values()) {
            if (report.type !== 'candidate-pair' || report.state !== 'succeeded') continue;
            if (report.selected === true) {
              pair = report;
              break;
            }
            if (!pair && report.nominated === true) pair = report;
          }
          if (pair) {
            localType = candidateType(stats, pair.localCandidateId);
            remoteType = candidateType(stats, pair.remoteCandidateId);
          }
        } catch {
          // A still-settling connection will be retried by expect.poll.
        }
      }

      observations.push({
        connectionState: connection.connectionState,
        iceConnectionState: connection.iceConnectionState,
        localType,
        remoteType,
      });
    }
    return observations;
  }, RTC_PROBE_KEY);
}

async function requireNineLocalPeerConnections(
  hostPage: Page,
): Promise<CandidatePairObservation[]> {
  let latest: CandidatePairObservation[] = [];
  await expect
    .poll(
      async () => {
        latest = await readCandidatePairs(hostPage);
        return latest.filter(
          (pair) =>
            pair.connectionState === 'connected' &&
            pair.localType === 'host' &&
            pair.remoteType === 'host',
        ).length;
      },
      {
        timeout: 30_000,
        message: 'All nine production host→guest connections must settle on host/host ICE pairs.',
      },
    )
    .toBe(GUEST_COUNT);

  const connected = latest.filter((pair) => pair.connectionState === 'connected');
  expect(connected).toHaveLength(GUEST_COUNT);
  expect(connected.every((pair) => pair.localType === 'host' && pair.remoteType === 'host')).toBe(
    true,
  );
  console.log(`[production-live] topology confirmed: ${JSON.stringify(connected)}`);
  return connected;
}

test('9 local guests use R2 fanout and promote the preloaded successor without another GET', async ({
  browser,
}) => {
  let room: LiveRoom | null = null;

  try {
    room = await createLiveRoom(browser);
    const code = await setupHostAndStart(room.hostPage);

    // Join in small batches so this smoke measures the delivery boundary rather
    // than room-admission burst behavior.
    for (let start = 0; start < room.guestPages.length; start += 3) {
      await Promise.all(
        room.guestPages.slice(start, start + 3).map((page) => setupGuest(page, code)),
      );
    }

    await waitForDeviceCount(room.hostPage, GUEST_COUNT + 1, 45_000);
    const topology = await requireNineLocalPeerConnections(room.hostPage);
    test.info().annotations.push({ type: 'topology', description: JSON.stringify(topology) });

    await uploadProbeFiles(room.hostPage);
    await waitForPlaylistCount(room.hostPage, 2, 30_000);
    await Promise.all(room.guestPages.map((page) => waitForPlaylistCount(page, 2, 90_000)));
    await Promise.all(
      room.guestPages.map((page) => waitForTrackTitle(page, FIRST_TRACK_TITLE, 90_000)),
    );

    await expect
      .poll(() => room!.successfulR2Puts.size, {
        timeout: 120_000,
        message: 'The production host should upload exactly current + preload R2 objects.',
      })
      .toBe(2);

    await Promise.all(
      room.successfulDownloads.map(async (downloads, index) => {
        await expect
          .poll(() => downloads.size, {
            timeout: 120_000,
            message: `Guest ${index + 1} did not complete current + preload R2 downloads.`,
          })
          .toBe(2);
      }),
    );

    const requestsBeforeNext = [...room.downloadRequestCounts];
    await room.hostPage.locator('#btn-next').click();
    await Promise.all(
      room.guestPages.map((page) => waitForTrackTitle(page, SECOND_TRACK_TITLE, 60_000)),
    );

    // Promotion must consume the resident preload rather than downloading the
    // selected successor again.
    await room.hostPage.waitForTimeout(3_000);
    expect(room.downloadRequestCounts).toEqual(requestsBeforeNext);
    expect(room.successfulR2Puts.size).toBe(2);
    for (const downloads of room.successfulDownloads) expect(downloads.size).toBe(2);
  } finally {
    await closeLiveRoom(room);
  }
});
