/**
 * @vitest-environment jsdom
 *
 * PRO READY timing golden (pinned 2026-10-30).
 *
 * The PRO Worker commits when every cohort member has reported (ready or
 * failed) or at its barrier, whichever is first, and plays one COMMIT lead
 * later (cloudflare/pro-room-worker.ts), so a device's PREPARE to READY time
 * is the start time the owner accepted on 2026-10-30 (about 3 s at most).
 * This table records, for a resident iframe and for a new iframe whose
 * handshake completes after a fixed scripted delay, the instant and status
 * of reportPlaybackTransitionReady after acceptPrepare, with no fault and
 * with WebKit-like faults (an ignored unMute, a delayed isMuted). Neutral
 * Phase 6 increments must leave it unchanged.
 *
 * Real: ProRoomPlaybackController.acceptPrepare, the playlist media endpoint,
 * the iframe module and its PRO arm behind a scripted IFrame API, core/timers.
 * The server clock reads Date.now() and its acquisition is immediate, so the
 * table measures only the device's PREPARE to READY path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { resetProStartObservations } from '../../diagnostics/pro-start-observations.ts';
import { initPlayback } from '../../player/playback.ts';
import { initPlaylist } from '../../player/playlist.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import { PRO_ROOM_PLAYBACK_TRANSITION_DEADLINE_MS as BARRIER_MS } from '../../pro-room/__tests__/__helpers__/pro-room-playback-timing-copy.ts';
import type { QueueItemId } from '../../types/index.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { initYouTube, stopYouTubeMode } from '../player.ts';
import { resetYouTubeModuleState } from '../_state.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import type { FakeYtPlayer } from './__helpers__/fake-yt-player.ts';
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';
import { createFakeClockStarter } from './__helpers__/standard-start-harness.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));
vi.mock('../../network/peer.ts', () => ({
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));
vi.mock('../../pro-room/network-bridge.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pro-room/network-bridge.ts')>();
  const snapshot = () => ({
    generation: 1,
    sampleId: 1,
    offsetMs: 0,
    rttMs: 10,
    sampledAtMs: performance.now(),
    roundId: 1,
    source: 'ready' as const,
  });
  return {
    ...actual,
    getProRoomServerNow: () => Date.now(),
    isProRoomServerClockCalibrated: () => true,
    captureProRoomServerClockSnapshot: () => snapshot(),
    isProRoomClockSnapshotCurrent: () => true,
    acquireProRoomServerClock: async (options: {
      serverDeadlineAtMs?: number;
      signal?: AbortSignal;
    }) =>
      !options.signal?.aborted && Date.now() <= (options.serverDeadlineAtMs ?? Infinity)
        ? snapshot()
        : null,
  };
});

const PRO = createProEndpointFixture({
  roomCode: '000001',
  roomEpoch: 6,
  queueItemId: '65000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'readyTimeA1',
  transitionId: `transition_${'g'.repeat(22)}`,
});
/** The new iframe's scripted handshake delay after the PREPARE builds it. */
const NEW_IFRAME_HANDSHAKE_MS = 400;
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 9, 30, 0, 0, 0));

type Knob =
  'none' | 'unMute ignored x1' | 'unMute ignored x2' | 'isMuted +120 ms' | 'isMuted +250 ms';
function knobInit(knob: Knob): Partial<FakeYtPlayer> {
  return {
    __unMuteIgnoreCount: knob === 'unMute ignored x1' ? 1 : knob === 'unMute ignored x2' ? 2 : 0,
    __unMuteDelayMs: knob === 'isMuted +120 ms' ? 120 : knob === 'isMuted +250 ms' ? 250 : 0,
  };
}

beforeEach(() => {
  startFakeClock();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  resetYouTubeModuleState();
  resetYouTubeSyncState();
  resetProPlaybackAuthorityHooks();
  resetProStartObservations();
  registerProPlaybackMediaEndpoint(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ title: 'Synthetic video' })),
  );
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
  initPlayback();
  initYouTube();
  initPlaylist();
  setState('room.context', {
    kind: 'pro',
    roomId: PRO.identity.roomCode,
    role: 'member',
    coordinatorId: null,
    epoch: PRO.identity.roomEpoch,
    snapshotRevision: 1,
    capabilities: [],
  });
  setState('setup.sessionStarted', true);
  setState('audio.masterVolume', 1);
  setState('playlist.items', [
    {
      queueItemId: PRO.identity.queueItemId,
      type: 'youtube',
      name: 'Synthetic video',
      videoId: PRO.identity.videoId,
      playlistId: null,
    },
  ]);
});

afterEach(() => {
  PRO.resetControllers();
  resetProPlaybackAuthorityHooks();
  registerProPlaybackMediaEndpoint(null);
  cancelYouTubeAuthorityPreparation();
  stopYouTubeMode({ silent: true });
  clearAllManagedTimers();
  resetYouTubeModuleState();
  vi.clearAllTimers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  bus.clear();
  resetState();
  document.body.innerHTML = '';
  document
    .querySelectorAll('script[src*="youtube.com/iframe_api"]')
    .forEach((script) => script.remove());
  delete window.onYouTubeIframeAPIReady;
});

interface ReadyRow {
  iframe: 'resident' | 'new';
  knob: Knob;
  readyAtMs: number | null;
  status: string | null;
}

async function measure(iframe: 'resident' | 'new', knob: Knob): Promise<ReadyRow> {
  const api = installScriptedIframeApi(iframe === 'new' ? knobInit(knob) : {});
  if (iframe === 'resident') {
    const fake = await loadResidentIframe(api, {
      queueItemId: PRO.identity.queueItemId,
      videoId: PRO.identity.videoId,
      positionSeconds: 0,
    });
    Object.assign(fake, knobInit(knob));
  }
  const participant = PRO.createParticipant();
  const reports: Array<{ at: number; status: string }> = [];
  const preparedAt = Date.now();
  participant.reportReady.mockImplementation(async (report: { status: string }) => {
    reports.push({ at: Date.now() - preparedAt, status: report.status });
    return 'waiting';
  });
  participant.controller.acceptPrepare(
    PRO.prepareEvent(iframe === 'resident' ? 1 : 0, 0, 'zero-start'),
  );
  if (iframe === 'new') {
    await vi.advanceTimersByTimeAsync(NEW_IFRAME_HANDSHAKE_MS);
    api.iframes.at(-1)?.ready();
  }
  await vi.advanceTimersByTimeAsync(BARRIER_MS);
  const first = reports[0] ?? null;
  return { iframe, knob, readyAtMs: first?.at ?? null, status: first?.status ?? null };
}

/**
 * Today's PREPARE to READY instants, one explicit row per iframe and fault.
 * A 250 ms isMuted delay never verifies inside the arm's 120 ms restore
 * cycle (each retry's unMute restarts the fake's delay), so the arm fails
 * after eight attempts and READY reports failed: with no device trace, this
 * pins the fake's model, not a measured WebKit device.
 */
const READY_TABLE: ReadyRow[] = [
  { iframe: 'resident', knob: 'none', readyAtMs: 620, status: 'ready' },
  { iframe: 'resident', knob: 'unMute ignored x1', readyAtMs: 740, status: 'ready' },
  { iframe: 'resident', knob: 'unMute ignored x2', readyAtMs: 860, status: 'ready' },
  { iframe: 'resident', knob: 'isMuted +120 ms', readyAtMs: 620, status: 'ready' },
  { iframe: 'resident', knob: 'isMuted +250 ms', readyAtMs: 1_460, status: 'failed' },
  // The PREPARE builds the iframe; its handshake completes 400 ms later.
  { iframe: 'new', knob: 'none', readyAtMs: 1_061, status: 'ready' },
  { iframe: 'new', knob: 'unMute ignored x1', readyAtMs: 1_181, status: 'ready' },
  { iframe: 'new', knob: 'unMute ignored x2', readyAtMs: 1_301, status: 'ready' },
  { iframe: 'new', knob: 'isMuted +120 ms', readyAtMs: 1_061, status: 'ready' },
  { iframe: 'new', knob: 'isMuted +250 ms', readyAtMs: 1_901, status: 'failed' },
];

describe('PRO READY timing golden (pinned 2026-10-30)', () => {
  it.each(READY_TABLE)('$iframe iframe, $knob: READY at $readyAtMs ms ($status)', async (row) => {
    const measured = await measure(row.iframe, row.knob);
    expect(measured).toEqual(row);
    // Every READY lands inside the Worker's barrier.
    if (measured.status === 'ready') expect(measured.readyAtMs).toBeLessThan(BARRIER_MS);
  });
});
