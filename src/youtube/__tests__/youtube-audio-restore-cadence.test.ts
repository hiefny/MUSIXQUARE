/**
 * @vitest-environment jsdom
 *
 * YouTube iframe audio-restore cadences (pinned 2026-10-30), tests first for
 * the increments that move the restore loops behind one iframe-audio owner.
 *
 * Six loops retry every 120 ms, up to eight attempts:
 * - zero-start's active restore (zero-start.ts:1412-1467) and its detached
 *   restore after a cancel (:1979-2052);
 * - the PRO arm's active restore (authority-arm.ts:652-687) and its
 *   detached restore after a failed prepare (:851-920);
 * - the host legacy recovery's verified cleanup (player.ts:2044-2063);
 * - the guest fallback's verified cleanup (player.ts:2512-2531).
 * The third cadence is the guest fallback's restore before its release:
 * command, immediate check, 50 ms polls, until max(deadline, now + 1 s)
 * (player.ts:2709-2721).
 *
 * Each loop is reached through its public entries (the named scenario
 * scripts of standard-start-harness.ts, and the PRO controller for the arm)
 * and runs with no fault, an ignored unMute (N = 1, 2), a delayed isMuted
 * (120 ms, one verify cycle; 250 ms, the late-unMute mimic of
 * sync-integration.test.ts) and a getVolume read fault (NaN, throw). The
 * fault is set just before the loop's first attempt. Each op is written
 * relative to that instant. None of these values comes from a device trace.
 * Rows marked "Fake-model row" never verify only because every unMute
 * restarts the fake's isMuted delay (fake-yt-player.ts __unMuteDelayMs): they
 * pin that model, and a neutral change that re-issued unMute less often could
 * flip them without any device behaviour changing.
 *
 * Today's per-loop policies these rows pin: zero-start treats a NaN volume
 * read as restored (finiteOr), the arm and player.ts do not; a desired-audio
 * change cancels zero-start's detached restore and retargets the arm's; the
 * two cleanups reissue pause and seek on every attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { resetProStartObservations } from '../../diagnostics/pro-start-observations.ts';
import { broadcast, safeSend, sendToHost } from '../../network/peer.ts';
import { initPlayback } from '../../player/playback.ts';
import { initPlaylist } from '../../player/playlist.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import type { QueueItemId } from '../../types/index.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { initYouTube, stopYouTubeMode } from '../player.ts';
import { resetYouTubeModuleState } from '../_state.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import type { FakeYtPlayer } from './__helpers__/fake-yt-player.ts';
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';
import {
  createFakeClockStarter,
  runStandardScenario,
  setUpStandardRig,
  standardScenarios,
  type StandardRig,
  type StandardScenario,
} from './__helpers__/standard-start-harness.ts';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../ui/toast.ts', () => ({
  showToast: vi.fn(),
  showLoader: vi.fn(),
  updateLoader: vi.fn(),
}));
vi.mock('../../network/peer.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/peer.ts')>()),
  broadcast: vi.fn(),
  safeSend: vi.fn(),
  sendToHost: vi.fn(),
}));
vi.mock('../../network/shared-clock.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../network/shared-clock.ts')>()),
  getHostNow: () => Date.now(),
  getClockOffset: () => 0,
  isClockCalibrated: () => true,
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

/**
 * Explicit expected logs. `attempts(times, ops)` writes each op at each
 * listed instant (ms after the loop's first attempt), in order; nothing is
 * read from the code under test.
 */
function attempts(times: readonly number[], ops: readonly string[]): string[] {
  return times.flatMap((at) => ops.map((op) => `+${at} ${op}`));
}
const RESTORE = ['setVolume(100)', 'unMute()'];
const CLEANUP = ['pauseVideo()', 'seekTo(0,true)', 'setVolume(100)', 'unMute()'];
/** Eight attempts 120 ms apart: a loop that never verifies its restore. */
const EIGHT = [0, 120, 240, 360, 480, 600, 720, 840];
/** The pre-release restore polls every 50 ms; the window ends at +1200. */
const POLLS_TO_1200 = Array.from({ length: 25 }, (_, index) => index * 50);
/** The zero-start host's release after its restore verifies (COMMIT lead 700 ms). */
const ZS_RELEASE = (at: number) => [`+${at} playVideo()`, `+${at} unMute()`];
/** A zero-start run that fails its restore: the host stops and hands off (+960). */
const ZS_RESTORE_TIMEOUT = ['+960 pauseVideo()', '+961 pauseVideo()', '+961 seekTo(0,true)'];
/** An arm whose restore fails: it pauses and starts its detached restore (+960). */
const ARM_RESTORE_TIMEOUT = [
  '+960 pauseVideo()',
  '+960 setVolume(100)',
  '+960 unMute()',
  '+1080 setVolume(100)',
  '+1080 unMute()',
];

const EXPECTED: Record<string, string[]> = {
  'zero-start active restore | none': [...attempts([0], RESTORE), ...ZS_RELEASE(822)],
  'zero-start active restore | unMute ignored x1': [
    ...attempts([0, 120], RESTORE),
    ...ZS_RELEASE(940),
  ],
  'zero-start active restore | unMute ignored x2': attempts([0, 120, 240], RESTORE),
  // The delayed unmute lands as the first check runs.
  'zero-start active restore | isMuted +120 ms': [...attempts([0], RESTORE), ...ZS_RELEASE(822)],
  // Fake-model row: each retry's unMute restarts the 250 ms delay, so it
  // never lands in time.
  'zero-start active restore | isMuted +250 ms': [
    ...attempts(EIGHT, RESTORE),
    ...ZS_RESTORE_TIMEOUT,
  ],
  // finiteOr reads a NaN volume as the captured one: restored.
  'zero-start active restore | getVolume NaN': [...attempts([0], RESTORE), ...ZS_RELEASE(822)],
  'zero-start active restore | getVolume throws': [
    ...attempts(EIGHT, RESTORE),
    ...ZS_RESTORE_TIMEOUT,
  ],
  'zero-start detached restore | none': ['+0 pauseVideo()', ...attempts([0], RESTORE)],
  'zero-start detached restore | unMute ignored x1': [
    '+0 pauseVideo()',
    ...attempts([0, 120], RESTORE),
  ],
  'zero-start detached restore | unMute ignored x2': [
    '+0 pauseVideo()',
    ...attempts([0, 120, 240], RESTORE),
  ],
  'zero-start detached restore | isMuted +120 ms': ['+0 pauseVideo()', ...attempts([0], RESTORE)],
  // Fake-model row (the restarted 250 ms delay).
  'zero-start detached restore | isMuted +250 ms': ['+0 pauseVideo()', ...attempts(EIGHT, RESTORE)],
  'zero-start detached restore | getVolume NaN': ['+0 pauseVideo()', ...attempts([0], RESTORE)],
  'zero-start detached restore | getVolume throws': [
    '+0 pauseVideo()',
    ...attempts(EIGHT, RESTORE),
  ],
  // The cleanups reissue pause and seek on every attempt.
  'host legacy cleanup | none': attempts([0], CLEANUP),
  'host legacy cleanup | unMute ignored x1': attempts([0, 120], CLEANUP),
  'host legacy cleanup | unMute ignored x2': attempts([0, 120, 240], CLEANUP),
  'host legacy cleanup | isMuted +120 ms': attempts([0, 120], CLEANUP),
  // Fake-model row (the restarted 250 ms delay).
  'host legacy cleanup | isMuted +250 ms': attempts(EIGHT, CLEANUP),
  // player.ts reads the raw volume: NaN never verifies.
  'host legacy cleanup | getVolume NaN': attempts(EIGHT, CLEANUP),
  'host legacy cleanup | getVolume throws': attempts(EIGHT, CLEANUP),
  'guest fallback cleanup | none': attempts([0], CLEANUP),
  'guest fallback cleanup | unMute ignored x1': attempts([0, 120], CLEANUP),
  'guest fallback cleanup | unMute ignored x2': attempts([0, 120, 240], CLEANUP),
  'guest fallback cleanup | isMuted +120 ms': attempts([0, 120], CLEANUP),
  // Fake-model row (the restarted 250 ms delay).
  'guest fallback cleanup | isMuted +250 ms': attempts(EIGHT, CLEANUP),
  'guest fallback cleanup | getVolume NaN': attempts(EIGHT, CLEANUP),
  'guest fallback cleanup | getVolume throws': attempts(EIGHT, CLEANUP),
  // Command, immediate check, then 50 ms polls; the release seeks the
  // elapsed room time and plays once audio verifies.
  'guest pre-release restore | none': [
    ...attempts([0], RESTORE),
    '+0 pauseVideo()',
    '+0 seekTo(0,true)',
    ...attempts([0], RESTORE),
    '+0 playVideo()',
  ],
  'guest pre-release restore | unMute ignored x1': [
    ...attempts([0, 50], RESTORE),
    '+50 pauseVideo()',
    '+50 seekTo(0.05,true)',
    ...attempts([50], RESTORE),
    '+50 playVideo()',
  ],
  'guest pre-release restore | unMute ignored x2': [
    ...attempts([0, 50, 100], RESTORE),
    '+100 pauseVideo()',
    '+100 seekTo(0.1,true)',
    ...attempts([100], RESTORE),
    '+100 playVideo()',
  ],
  // Polls until max(deadline, now + 1 s); the window ends before that.
  // Fake-model rows: every 50 ms poll re-issues unMute and restarts the
  // delay, so neither 120 ms nor 250 ms lands in the window and the release
  // does not run.
  'guest pre-release restore | isMuted +120 ms': attempts(POLLS_TO_1200, RESTORE),
  'guest pre-release restore | isMuted +250 ms': attempts(POLLS_TO_1200, RESTORE),
  'guest pre-release restore | getVolume NaN': attempts(POLLS_TO_1200, RESTORE),
  'guest pre-release restore | getVolume throws': attempts(POLLS_TO_1200, RESTORE),
  // A desired-audio change cancels zero-start's detached restore; player.ts
  // writes the new volume itself and no retry follows.
  'zs detached desired change': [
    '+0 pauseVideo()',
    ...attempts([0], RESTORE),
    '+50 setVolume(40)',
    '+50 unMute()',
  ],
  'arm active | none': attempts([0], RESTORE),
  'arm active | unMute ignored x1': attempts([0, 120], RESTORE),
  'arm active | unMute ignored x2': attempts([0, 120, 240], RESTORE),
  'arm active | isMuted +120 ms': attempts([0], RESTORE),
  // Fake-model row (the restarted 250 ms delay).
  'arm active | isMuted +250 ms': [...attempts(EIGHT, RESTORE), ...ARM_RESTORE_TIMEOUT],
  // The arm reads the raw volume: NaN never verifies.
  'arm active | getVolume NaN': [...attempts(EIGHT, RESTORE), ...ARM_RESTORE_TIMEOUT],
  'arm active | getVolume throws': [...attempts(EIGHT, RESTORE), ...ARM_RESTORE_TIMEOUT],
  'arm detached | none': ['+0 pauseVideo()', ...attempts([0], RESTORE)],
  'arm detached | unMute ignored x1': ['+0 pauseVideo()', ...attempts([0, 120], RESTORE)],
  'arm detached | unMute ignored x2': ['+0 pauseVideo()', ...attempts([0, 120, 240], RESTORE)],
  // The detached restore checks at once, before the delayed unmute lands.
  'arm detached | isMuted +120 ms': ['+0 pauseVideo()', ...attempts([0, 120], RESTORE)],
  // Fake-model row (the restarted 250 ms delay).
  'arm detached | isMuted +250 ms': ['+0 pauseVideo()', ...attempts(EIGHT, RESTORE)],
  'arm detached | getVolume NaN': ['+0 pauseVideo()', ...attempts(EIGHT, RESTORE)],
  'arm detached | getVolume throws': ['+0 pauseVideo()', ...attempts(EIGHT, RESTORE)],
  // A desired-audio change retargets the arm's detached restore.
  'arm detached desired change': [
    '+0 pauseVideo()',
    ...attempts([0], RESTORE),
    '+50 setVolume(40)',
    '+50 unMute()',
    '+120 setVolume(40)',
    '+120 unMute()',
  ],
};
function pin(name: string, actual: unknown): void {
  expect(actual, name).toEqual(EXPECTED[name]);
}
const STANDARD = {
  queueItemId: '74000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'restoreCadA',
  nextQueueItemId: '74000000-0000-4000-8000-000000000002' as QueueItemId,
  nextVideoId: 'restoreCadB',
};
const SCENARIOS = standardScenarios(STANDARD);
const PRO = createProEndpointFixture({
  roomCode: '000001',
  roomEpoch: 6,
  queueItemId: '64000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'restoreCadP',
  transitionId: `transition_${'c'.repeat(22)}`,
});
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 9, 30, 0, 0, 0));
let rig: StandardRig | null = null;

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
});

afterEach(() => {
  rig?.dispose();
  rig = null;
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

type Fault =
  | 'none'
  | 'unMute ignored x1'
  | 'unMute ignored x2'
  | 'isMuted +120 ms'
  | 'isMuted +250 ms'
  | 'getVolume NaN'
  | 'getVolume throws';
const FAULTS: readonly Fault[] = [
  'none',
  'unMute ignored x1',
  'unMute ignored x2',
  'isMuted +120 ms',
  'isMuted +250 ms',
  'getVolume NaN',
  'getVolume throws',
];

function applyFault(fake: FakeYtPlayer, fault: Fault): void {
  fake.__unMuteIgnoreCount =
    fault === 'unMute ignored x1' ? 1 : fault === 'unMute ignored x2' ? 2 : 0;
  fake.__unMuteDelayMs = fault === 'isMuted +120 ms' ? 120 : fault === 'isMuted +250 ms' ? 250 : 0;
  fake.__volumeReadFault =
    fault === 'getVolume NaN' ? 'nan' : fault === 'getVolume throws' ? 'throw' : null;
}

/** The audio-path ops from index on, relative to origin: '+<ms> <op>(<args>)'. */
function restoreOps(
  fake: FakeYtPlayer,
  origin: number,
  fromIndex: number,
  untilMs: number,
): string[] {
  return fake.__log
    .slice(fromIndex)
    .filter(({ at }) => at - origin <= untilMs)
    .map(({ op, args, at }) => `+${at - origin} ${op}(${(args ?? []).join(',')})`);
}

type Loop =
  | 'zero-start active restore'
  | 'zero-start detached restore'
  | 'host legacy cleanup'
  | 'guest fallback cleanup'
  | 'guest pre-release restore';

/**
 * Each Standard loop: the scenario that reaches it, the rig options it
 * needs before the loop, and the instant (from t0) of its first attempt.
 */
const STANDARD_LOOPS: Record<
  Loop,
  {
    scenario: StandardScenario;
    firstAttemptAt: number;
    iframeInit?: Partial<FakeYtPlayer>;
    windowMs: number;
  }
> = {
  'zero-start active restore': {
    scenario: SCENARIOS.hostAllReady,
    firstAttemptAt: 600,
    windowMs: 1_000,
  },
  // The replaced peer cancels the run at +400; zero-start's detached restore starts there.
  'zero-start detached restore': {
    scenario: SCENARIOS.hostPeerReplaced,
    firstAttemptAt: 400,
    windowMs: 1_000,
  },
  // Every unMute is ignored until the loop, so the run's own restore and
  // the legacy recovery both time out; the cleanup loop starts at +4561.
  'host legacy cleanup': {
    scenario: SCENARIOS.hostAllReady,
    firstAttemptAt: 4_561,
    iframeInit: { __unMuteIgnoreCount: 1_000 },
    windowMs: 1_000,
  },
  // The load never completes; the fallback abandons at its 7.7 s deadline (+10101).
  'guest fallback cleanup': {
    scenario: SCENARIOS.guestCohortExcluded(60_000),
    firstAttemptAt: 10_102,
    windowMs: 1_000,
  },
  // The load completes at +2701; the release restore runs at startAtHost (+3100).
  'guest pre-release restore': {
    scenario: SCENARIOS.guestCohortExcluded(2_600),
    firstAttemptAt: 3_100,
    windowMs: 1_200,
  },
};

describe('YouTube audio-restore cadences: Standard loops (pinned 2026-10-30)', () => {
  const rows = (Object.keys(STANDARD_LOOPS) as Loop[]).flatMap((loop) =>
    FAULTS.map((fault) => [loop, fault] as const),
  );

  it.each(rows)('%s with %s', async (loop, fault) => {
    const spec = STANDARD_LOOPS[loop];
    rig = await setUpStandardRig({
      role: spec.scenario.role,
      sends: {
        broadcast: vi.mocked(broadcast),
        safeSend: vi.mocked(safeSend),
        sendToHost: vi.mocked(sendToHost),
      },
      roomCode: '100001',
      ...STANDARD,
      hostPeerId: 'host-1',
      guestPeerId: 'guest-1',
      ...spec.scenario.rig,
      ...(spec.iframeInit ? { iframeInit: spec.iframeInit } : {}),
    });
    const current = rig;
    let from = 0;
    const origin = current.t0 + spec.firstAttemptAt;
    await runStandardScenario(current, {
      ...spec.scenario,
      steps: [
        ...spec.scenario.steps,
        {
          at: spec.firstAttemptAt - 5,
          run: (r) => {
            applyFault(r.iframe(), fault);
            from = r.iframe().__log.length;
          },
        },
      ],
      endAt: spec.firstAttemptAt + spec.windowMs + 100,
    });
    pin(`${loop} | ${fault}`, restoreOps(current.iframe(), origin, from, spec.windowMs));
  });

  it("cancels zero-start's detached restore when the desired audio changes", async () => {
    rig = await setUpStandardRig({
      role: 'host',
      sends: {
        broadcast: vi.mocked(broadcast),
        safeSend: vi.mocked(safeSend),
        sendToHost: vi.mocked(sendToHost),
      },
      roomCode: '100001',
      ...STANDARD,
      hostPeerId: 'host-1',
      guestPeerId: 'guest-1',
    });
    const current = rig;
    let from = 0;
    await runStandardScenario(current, {
      ...SCENARIOS.hostPeerReplaced,
      steps: [
        ...SCENARIOS.hostPeerReplaced.steps,
        {
          at: 395,
          run: (r) => {
            applyFault(r.iframe(), 'unMute ignored x2');
            from = r.iframe().__log.length;
          },
        },
        { at: 450, run: () => bus.emit('youtube:set-volume', 40) },
      ],
      endAt: 1_500,
    });
    pin('zs detached desired change', restoreOps(current.iframe(), current.t0 + 400, from, 1_000));
  });
});

describe('YouTube audio-restore cadences: PRO arm loops (pinned 2026-10-30)', () => {
  async function setUpPro(): Promise<{ fake: FakeYtPlayer; t0: number }> {
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
    const api = installScriptedIframeApi();
    const fake = await loadResidentIframe(api, {
      queueItemId: PRO.identity.queueItemId,
      videoId: PRO.identity.videoId,
      positionSeconds: 0,
    });
    return { fake, t0: Date.now() };
  }

  it.each(FAULTS)('PRO arm active restore with %s', async (fault) => {
    const { fake, t0 } = await setUpPro();
    const participant = PRO.createParticipant();
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    // The arm's restore starts at +500.
    await vi.advanceTimersByTimeAsync(495);
    applyFault(fake, fault);
    const from = fake.__log.length;
    await vi.advanceTimersByTimeAsync(1_200);
    pin(`arm active | ${fault}`, restoreOps(fake, t0 + 500, from, 1_100));
  });

  /** A warm-up that never reports PLAYING fails at the 2.3 s budget; the detached restore follows. */
  async function failedPrepare(fault: Fault) {
    const { fake, t0 } = await setUpPro();
    const play = fake.playVideo;
    fake.playVideo = () => {
      fake.__log.push({ op: 'playVideo', at: Date.now() });
      fake.__setState(3);
    };
    const participant = PRO.createParticipant();
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(2_295);
    applyFault(fake, fault);
    const from = fake.__log.length;
    return { fake, t0, from, play };
  }

  it.each(FAULTS)('PRO arm detached restore after a failed prepare with %s', async (fault) => {
    const { fake, t0, from } = await failedPrepare(fault);
    await vi.advanceTimersByTimeAsync(1_200);
    pin(`arm detached | ${fault}`, restoreOps(fake, t0 + 2_300, from, 1_100));
  });

  it("retargets the arm's detached restore when the desired audio changes", async () => {
    const { fake, t0, from } = await failedPrepare('unMute ignored x2');
    await vi.advanceTimersByTimeAsync(55);
    bus.emit('youtube:set-volume', 40);
    await vi.advanceTimersByTimeAsync(1_200);
    pin('arm detached desired change', restoreOps(fake, t0 + 2_300, from, 1_100));
  });
});
