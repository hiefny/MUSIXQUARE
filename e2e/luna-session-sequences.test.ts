import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { injectPeerServer } from './helpers/peer-server.ts';
import { setupGuest, setupHostAndStart } from './helpers/setup-flow.ts';
import { uploadFixtures } from './helpers/file-upload.ts';
import { readCurrentQueueItemId, readQueueSnapshot } from './helpers/queue-state.ts';
import {
  navigateToSubtab,
  navigateToTab,
  readPlaybackProjection,
  readState,
  waitForDeviceCount,
  waitForFilePlaybackReady,
  waitForPlaybackProjection,
  waitForPlaybackProjectionIn,
  waitForPlaylistCount,
  waitForState,
} from './helpers/wait.ts';
import { getPageErrors, trackPageErrors } from './helpers/context-factory.ts';

type PlaybackAction = 'pause-toggle' | 'seek' | 'next' | 'remove' | 'permissions';
type LifecycleAction = 'reconnect' | 'late-join' | 'leave-rejoin';

interface SeedPlan {
  seed: number;
  lifecycle: LifecycleAction;
  playback: [PlaybackAction, PlaybackAction];
  playbackFirst: boolean;
}

const PLANS = [
  ...(['reconnect', 'late-join', 'leave-rejoin'] as const).flatMap((lifecycle, lifecycleIndex) =>
    ([0, 1] as const).flatMap((playbackFirst) =>
      (
        [
          ['seek', 'pause-toggle'],
          ['next', 'remove'],
          ['permissions', 'seek'],
          ['permissions', 'next'],
        ] as const
      ).map((playback, pairIndex) => ({
        seed: 470_000 + lifecycleIndex * 8 + pairIndex * 2 + playbackFirst,
        lifecycle,
        playback: [...playback] as [PlaybackAction, PlaybackAction],
        playbackFirst: playbackFirst === 0,
      })),
    ),
  ),
];
const planSignatures = PLANS.map(
  ({ lifecycle, playback, playbackFirst }) => `${lifecycle}|${playbackFirst}|${playback.join(',')}`,
);
if (new Set(planSignatures).size !== PLANS.length) {
  throw new Error('Luna browser session plans contain duplicate execution signatures');
}

interface SessionPages {
  context: BrowserContext;
  page: Page;
}

async function newGuest(browser: Browser, code: string): Promise<SessionPages> {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  trackPageErrors(page);
  await injectPeerServer(page);
  await setupGuest(page, code);
  return { context, page };
}

async function createHost(browser: Browser): Promise<SessionPages> {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  trackPageErrors(page);
  await injectPeerServer(page);
  return { context, page };
}

async function waitForGuestToMatchHost(host: Page, guests: Page[], diagnostic: string) {
  for (const guest of guests) {
    await expect
      .poll(
        async () => {
          const [hostQueue, guestQueue, hostProjection, guestProjection] = await Promise.all([
            readQueueSnapshot(host),
            readQueueSnapshot(guest),
            readPlaybackProjection(host),
            readPlaybackProjection(guest),
          ]);
          const sameQueue =
            hostQueue.currentQueueItemId === guestQueue.currentQueueItemId &&
            hostQueue.revision === guestQueue.revision &&
            hostQueue.items.map((item) => item.queueItemId).join(',') ===
              guestQueue.items.map((item) => item.queueItemId).join(',');
          const stablePlayback = hostProjection === 'PLAYING_AUDIO' || hostProjection === 'PAUSED';
          return JSON.stringify({
            converged: sameQueue && stablePlayback && hostProjection === guestProjection,
            host: { queue: hostQueue, projection: hostProjection },
            guest: { queue: guestQueue, projection: guestProjection },
          });
        },
        { message: diagnostic, timeout: 15_000 },
      )
      .toContain('"converged":true');
  }
}

async function captureRuntimeSnapshot(page: Page) {
  const [projection, state] = await Promise.all([
    readPlaybackProjection(page),
    page.evaluate(() => {
      const get = (window as unknown as Record<string, unknown>).__MUSIXQUARE_GET_STATE__ as
        ((path: string) => unknown) | undefined;
      if (!get) return { unavailable: true };
      const queue = get('playlist.items');
      const file = get('files.current') as {
        queueItemId?: unknown;
        sessionId?: unknown;
        name?: unknown;
        size?: unknown;
      } | null;
      const track = get('player.currentTrackMeta') as {
        name?: unknown;
        queueItemId?: unknown;
      } | null;
      return {
        activity: get('playback.activity'),
        lifecycle: get('playback.lifecycle'),
        pausedAt: get('player.pausedAt'),
        filesCurrent: file
          ? {
              queueItemId: file.queueItemId ?? null,
              sessionId: file.sessionId ?? null,
              name: typeof file.name === 'string' ? file.name : null,
              size: typeof file.size === 'number' ? file.size : null,
            }
          : null,
        track: track ? { name: track.name ?? null, queueItemId: track.queueItemId ?? null } : null,
        queue: Array.isArray(queue)
          ? queue.map((item) => (item as { queueItemId?: unknown }).queueItemId)
          : [],
        currentQueueItemId: get('playlist.currentQueueItemId'),
        revision: get('playlist.revision'),
      };
    }),
  ]);
  return { projection, ...state };
}

async function persistSequenceArtifact(
  testInfo: TestInfo,
  fileName: string,
  value: Record<string, unknown>,
): Promise<string> {
  const filePath = testInfo.outputPath(fileName);
  await mkdir(dirname(filePath), { recursive: true });
  const body = JSON.stringify(
    { artifactPath: relative(process.cwd(), filePath), ...value },
    null,
    2,
  );
  await writeFile(filePath, body, 'utf8');
  await testInfo.attach(fileName, { body, contentType: 'application/json' });
  return filePath;
}

async function captureHostLossDiagnostics(page: Page) {
  return page.evaluate(() => {
    const win = window as unknown as Record<string, unknown>;
    const get = win.__MUSIXQUARE_GET_STATE__ as ((path: string) => unknown) | undefined;
    const conn = get?.('network.hostConn') as
      | {
          open?: boolean;
          peerConnection?: RTCPeerConnection;
          peer?: { disconnected?: boolean };
          dataChannel?: RTCDataChannel;
        }
      | null
      | undefined;
    return {
      hostConnPresent: Boolean(conn),
      hostConnOpen: conn?.open ?? null,
      connectionState: conn?.peerConnection?.connectionState ?? null,
      iceConnectionState: conn?.peerConnection?.iceConnectionState ?? null,
      signalingState: conn?.peerConnection?.signalingState ?? null,
      peerDisconnected: conn?.peer?.disconnected ?? null,
      dataChannelState: conn?.dataChannel?.readyState ?? null,
      hostLossEvents: win.__lunaHostLossEvents ?? [],
      dialogVisible: Boolean(document.querySelector('#dialog-overlay.show')),
      appBanner: document.querySelector('#app-status-banner')?.textContent?.trim() ?? null,
      media: Array.from(document.querySelectorAll('audio,video')).map((element) => {
        const media = element as HTMLMediaElement;
        return {
          tag: media.tagName,
          paused: media.paused,
          currentTime: Number.isFinite(media.currentTime) ? media.currentTime : null,
          readyState: media.readyState,
          src: media.currentSrc ? new URL(media.currentSrc).pathname : null,
        };
      }),
    };
  });
}

async function seekHost(page: Page): Promise<number> {
  await waitForFilePlaybackReady(page);
  const slider = page.locator('#seek-slider');
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute('aria-disabled', 'false');
  const positionBeforeSeek = Number(await readState(page, 'player.pausedAt'));
  const target = await slider.evaluate((element) => {
    const input = element as HTMLInputElement;
    const duration = Number(input.max);
    const targetSeconds = Math.min(duration * 0.4, duration - 5);
    if (targetSeconds <= 5)
      throw new Error(`fixture duration too short for a meaningful seek: ${duration}`);
    input.value = String(targetSeconds);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return targetSeconds;
  });
  expect(
    target,
    `seek target must differ from previous offset ${positionBeforeSeek}`,
  ).toBeGreaterThan(5);
  expect(Math.abs(target - positionBeforeSeek)).toBeGreaterThan(5);
  await expect
    .poll(() => readState(page, 'player.pausedAt'), { timeout: 5_000 })
    .toBeCloseTo(target, 1);
  return target;
}

async function removeLastTrack(page: Page, remaining: number): Promise<void> {
  await navigateToTab(page, 'playlist');
  await page.locator('.btn-playlist-remove').last().click();
  await page.locator('.playlist-selection-delete').click();
  await waitForPlaylistCount(page, remaining);
}

async function exercisePlaybackAction(
  action: PlaybackAction,
  host: Page,
  currentGuest: Page,
  history: string[],
  seed: number,
): Promise<void> {
  switch (action) {
    case 'pause-toggle': {
      const before = await readPlaybackProjection(host);
      await host.click('#play-btn');
      const expected = before === 'PLAYING_AUDIO' ? 'PAUSED' : 'PLAYING_AUDIO';
      await waitForPlaybackProjection(host, expected, 12_000);
      await waitForPlaybackProjection(currentGuest, expected, 12_000);
      history.push(`pause-toggle -> ${expected}`);
      return;
    }
    case 'seek': {
      const target = await seekHost(host);
      await expect
        .poll(
          async () => {
            const hostPosition = Number(await readState(host, 'player.pausedAt'));
            const guestPosition = Number(await readState(currentGuest, 'player.pausedAt'));
            return {
              hostReachedTarget: Math.abs(hostPosition - target) <= 1.5,
              guestTracksHost: Math.abs(guestPosition - hostPosition) <= 2.5,
            };
          },
          { timeout: 10_000 },
        )
        .toEqual({ hostReachedTarget: true, guestTracksHost: true });
      history.push(`seek -> target ${target}s applied on host; guest offset follows within 2.5s`);
      return;
    }
    case 'next': {
      const queueBefore = await readQueueSnapshot(host);
      const currentIndex = queueBefore.items.findIndex(
        (item) => item.queueItemId === queueBefore.currentQueueItemId,
      );
      expect(
        currentIndex,
        `current queue occurrence ${queueBefore.currentQueueItemId}`,
      ).toBeGreaterThanOrEqual(0);
      const expectedNext = queueBefore.items[currentIndex + 1]?.queueItemId;
      expect(expectedNext, 'next action requires a following queued occurrence').toBeTruthy();
      await host.click('#btn-next');
      await expect.poll(() => readCurrentQueueItemId(host), { timeout: 12_000 }).toBe(expectedNext);
      await expect
        .poll(() => readCurrentQueueItemId(currentGuest), { timeout: 12_000 })
        .toBe(expectedNext);
      await waitForPlaybackProjectionIn(host, ['PLAYING_AUDIO', 'PAUSED'], 12_000);
      await waitForPlaybackProjectionIn(currentGuest, ['PLAYING_AUDIO', 'PAUSED'], 12_000);
      history.push('next -> #btn-next');
      return;
    }
    case 'remove': {
      const count = (await readQueueSnapshot(host)).items.length;
      if (count < 2) throw new Error(`seed ${seed}: cannot remove without queue headroom`);
      await removeLastTrack(host, count - 1);
      history.push(`remove -> queue count ${count - 1}`);
      return;
    }
    case 'permissions': {
      await navigateToTab(host, 'settings');
      await navigateToSubtab(host, 'connect');
      const peerId = String(await readState(currentGuest, 'network.myId'));
      const grant = host.locator(
        `#connect-device-list .device-entry[data-member-key="device:${peerId}"] .d-op-btn:visible, ` +
          `#desktop-device-list .device-entry[data-member-key="device:${peerId}"] .d-op-btn:visible`,
      );
      await expect(grant).toBeVisible();
      await grant.click();
      await waitForState(currentGuest, 'network.isOperator', true);
      const revoke = host.locator(
        `#connect-administrator-list .administrator-row[data-member-id="peer:${peerId}"] .administrator-action-button.revoke:visible, ` +
          `#desktop-administrator-list .administrator-row[data-member-id="peer:${peerId}"] .administrator-action-button.revoke:visible`,
      );
      await expect(revoke).toBeVisible();
      await revoke.click();
      await expect(host.locator('#dialog-overlay.show')).toBeVisible();
      await host.locator('#btn-dialog-ok').click();
      await waitForState(currentGuest, 'network.isOperator', false);
      history.push('permissions -> grant then revoke to the current guest');
      return;
    }
  }
}

async function leaveThroughUi(page: Page): Promise<void> {
  const leaveButton = page
    .locator('#desktop-btn-leave-session:visible, #btn-leave-session:visible')
    .first();
  if (!(await leaveButton.isVisible())) {
    const settingsConnect = page.locator(
      '.settings-subtab-nav .subtab-pill[data-subtab="connect"]',
    );
    if (await settingsConnect.isVisible()) await settingsConnect.click();
    else await page.locator('.nav-item[data-tab="connect"]:visible').click();
  }
  await expect(leaveButton).toBeVisible();
  await leaveButton.click();
  await expect(page.locator('#dialog-overlay.show')).toBeVisible();
  await page.locator('#btn-dialog-ok').click();
  await expect(page.locator('#setup-overlay.active')).toBeVisible();
}

async function performLifecycle(
  browser: Browser,
  code: string,
  lifecycle: LifecycleAction,
  host: Page,
  current: SessionPages,
  contexts: BrowserContext[],
  guests: Page[],
  history: string[],
): Promise<SessionPages> {
  await waitForPlaybackProjectionIn(host, ['PLAYING_AUDIO', 'PAUSED'], 12_000);
  const playbackBeforeDisconnect = await readPlaybackProjection(host);
  const hostQueueBeforeDisconnect = await readQueueSnapshot(host);
  const snapshotBeforeDisconnect = await captureRuntimeSnapshot(host);
  if (lifecycle === 'late-join') {
    const newcomer = await newGuest(browser, code);
    contexts.push(newcomer.context);
    guests.push(newcomer.page);
    await waitForDeviceCount(host, guests.length + 1);
    history.push('late-join -> newcomer joined during host playback');
    return current;
  }

  if (lifecycle === 'leave-rejoin') {
    await leaveThroughUi(current.page);
    await waitForDeviceCount(host, guests.length);
    await setupGuest(current.page, code);
    history.push('leave-rejoin -> confirmed leave, then joined same room again');
  } else {
    await current.context.close();
    await waitForDeviceCount(host, guests.length);
    guests.splice(guests.indexOf(current.page), 1);
    const replacement = await newGuest(browser, code);
    contexts.push(replacement.context);
    guests.push(replacement.page);
    history.push('reconnect -> transport lost, fresh guest context rejoined');
    current = replacement;
  }
  await waitForDeviceCount(host, guests.length + 1);
  const snapshotAfterDisconnect = await captureRuntimeSnapshot(host);
  const hostQueueAfterDisconnect = await readQueueSnapshot(host);
  const diagnostic = JSON.stringify({
    actions: history,
    beforeDisconnect: snapshotBeforeDisconnect,
    afterDisconnect: snapshotAfterDisconnect,
  });
  history.push(`before guest departure host snapshot: ${JSON.stringify(snapshotBeforeDisconnect)}`);
  history.push(`after guest departure host snapshot: ${JSON.stringify(snapshotAfterDisconnect)}`);
  expect(
    hostQueueAfterDisconnect.items.map((item) => item.queueItemId),
    diagnostic,
  ).toEqual(hostQueueBeforeDisconnect.items.map((item) => item.queueItemId));
  expect(['PLAYING_AUDIO', 'PAUSED'], diagnostic).toContain(snapshotAfterDisconnect.projection);
  expect(snapshotAfterDisconnect.projection, diagnostic).toBe(playbackBeforeDisconnect);
  history.push(`host retained ${playbackBeforeDisconnect} after guest departure`);
  return current;
}

async function runSeededSequence(
  browser: Browser,
  plan: SeedPlan,
  testInfo: TestInfo,
): Promise<void> {
  const contexts: BrowserContext[] = [];
  const guests: Page[] = [];
  const history: string[] = [`seed=${plan.seed}`, `plan=${JSON.stringify(plan)}`];
  let hostContext: BrowserContext | undefined;
  let hostPage: Page | undefined;
  try {
    const hostSession = await createHost(browser);
    hostContext = hostSession.context;
    hostPage = hostSession.page;
    const code = await setupHostAndStart(hostSession.page);
    await uploadFixtures(hostSession.page, ['test01', 'test02', 'test03']);
    await waitForPlaylistCount(hostSession.page, 3);
    await waitForFilePlaybackReady(hostSession.page);
    await hostSession.page.click('#play-btn');
    await waitForPlaybackProjection(hostSession.page, 'PLAYING_AUDIO', 15_000);
    history.push('host started local fixture playback before guest admission');

    let current = await newGuest(browser, code);
    contexts.push(current.context);
    guests.push(current.page);
    await waitForDeviceCount(hostSession.page, 2);
    await waitForPlaylistCount(current.page, 3, 15_000);
    await waitForPlaybackProjection(current.page, 'PLAYING_AUDIO', 15_000);
    history.push('guest completed late join while host was playing');
    await waitForGuestToMatchHost(hostSession.page, guests, JSON.stringify(history));

    const operations = plan.playbackFirst
      ? [...plan.playback, plan.lifecycle]
      : [plan.lifecycle, ...plan.playback];
    for (const operation of operations) {
      if (operation === 'reconnect' || operation === 'late-join' || operation === 'leave-rejoin') {
        current = await performLifecycle(
          browser,
          code,
          operation,
          hostSession.page,
          current,
          contexts,
          guests,
          history,
        );
      } else {
        await exercisePlaybackAction(operation, hostSession.page, current.page, history, plan.seed);
      }
      await waitForGuestToMatchHost(hostSession.page, guests, JSON.stringify(history));
    }

    await waitForGuestToMatchHost(hostSession.page, guests, JSON.stringify(history));
    await persistSequenceArtifact(testInfo, `luna-seed-${plan.seed}.json`, {
      ...plan,
      actions: history,
    });
  } catch (error) {
    await persistSequenceArtifact(testInfo, `luna-seed-${plan.seed}-failure.json`, {
      ...plan,
      actions: history,
      error: String(error),
    }).catch(() => {});
    throw error;
  } finally {
    const errors = [
      ...(hostPage ? getPageErrors(hostPage) : []),
      ...guests.flatMap((page) => getPageErrors(page)),
    ].map((error) => error.message);
    await Promise.all(
      [...contexts, ...(hostContext ? [hostContext] : [])].map((context) =>
        context.close().catch(() => {}),
      ),
    );
    if (errors.length > 0)
      throw new Error(`seed ${plan.seed} browser errors: ${errors.join(' | ')}`);
  }
}

test.describe('Luna standard-room seeded browser sequences', () => {
  test.setTimeout(120_000);

  for (const plan of PLANS) {
    test(`seed ${plan.seed}: ${plan.lifecycle} with ${plan.playback.join(' and ')} in a real local room`, async ({
      browser,
    }, testInfo) => runSeededSequence(browser, plan, testInfo));
  }

  test('host loss while playing releases the guest playback session', async ({
    browser,
  }, testInfo) => {
    const hostSession = await createHost(browser);
    const guestSessions: SessionPages[] = [];
    try {
      const code = await setupHostAndStart(hostSession.page);
      await uploadFixtures(hostSession.page, ['test01']);
      await waitForPlaylistCount(hostSession.page, 1);
      await waitForFilePlaybackReady(hostSession.page);
      await hostSession.page.click('#play-btn');
      await waitForPlaybackProjection(hostSession.page, 'PLAYING_AUDIO', 15_000);
      const guest = await newGuest(browser, code);
      guestSessions.push(guest);
      await waitForPlaybackProjection(guest.page, 'PLAYING_AUDIO', 15_000);
      await guest.page.evaluate(() => {
        const win = window as unknown as Record<string, unknown>;
        const bus = win.__MUSIXQUARE_BUS__ as
          { on?: (event: string, callback: (value: unknown) => void) => void } | undefined;
        const events: unknown[] = [];
        win.__lunaHostLossEvents = events;
        bus?.on?.('network:error', (error) => {
          const candidate = error as { message?: unknown; type?: unknown } | null;
          events.push({
            at: Date.now(),
            message: candidate?.message ?? null,
            type: candidate?.type ?? null,
          });
        });
      });
      const closedAt = Date.now();
      await hostSession.context.close();
      const timeline: Array<{ elapsedMs: number; transport: unknown; runtime: unknown }> = [];
      let terminal = false;
      for (let second = 0; second < 90; second += 1) {
        await guest.page.waitForTimeout(1_000);
        const [transport, runtime] = await Promise.all([
          captureHostLossDiagnostics(guest.page),
          captureRuntimeSnapshot(guest.page),
        ]);
        timeline.push({ elapsedMs: Date.now() - closedAt, transport, runtime });
        if ((transport as { dialogVisible?: boolean }).dialogVisible) {
          terminal = true;
          break;
        }
      }
      const terminalSnapshot = timeline.at(-1);
      const terminalRuntime = terminalSnapshot?.runtime as
        Awaited<ReturnType<typeof captureRuntimeSnapshot>> | undefined;
      const firstFailedTransport = timeline.find(
        ({ transport }) => (transport as { connectionState?: string }).connectionState === 'failed',
      );
      await persistSequenceArtifact(testInfo, 'luna-host-loss-timeline.json', {
        terminal,
        timeline,
      });
      expect(
        terminal,
        JSON.stringify({
          firstFailedTransport,
          last: terminalSnapshot,
          sampleCount: timeline.length,
        }),
      ).toBe(true);
      await expect
        .poll(() => captureHostLossDiagnostics(guest.page), { timeout: 5_000 })
        .toMatchObject({ hostConnPresent: false, dialogVisible: true });
      await waitForPlaybackProjectionIn(guest.page, ['PAUSED', 'IDLE'], 5_000);
      await expect.poll(() => readState(guest.page, 'player.pausedAt'), { timeout: 5_000 }).toBe(0);
      expect(terminalRuntime?.projection).toMatch(/^(PAUSED|IDLE)$/);
      expect(terminalRuntime?.pausedAt).toBe(0);
    } finally {
      await Promise.all(guestSessions.map(({ context }) => context.close().catch(() => {})));
      if (!hostSession.page.isClosed()) await hostSession.context.close().catch(() => {});
    }
  });
});
