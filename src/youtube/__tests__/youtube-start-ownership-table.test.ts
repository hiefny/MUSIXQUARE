/**
 * @vitest-environment jsdom
 *
 * YouTube start-ownership truth table, Standard rooms (pinned 2026-11-01):
 * every start owner's public query and the composites the readers build from
 * them, as they answer today at rest and inside transitions, so a later start
 * ledger that replaces those composites can be held to the same lines. Once
 * the old flags are gone, a test can no longer compute their values next to
 * the new ones; these arrays keep them.
 *
 * Real: initYouTube's wiring, youtube/iframe.ts's state dispatch behind a
 * scripted IFrame API, youtube/sync.ts, core/timers, the protocol dispatcher
 * and the zero-start controller. Fakes at the edges only: the iframe
 * (fake-yt-player.ts), the network sends (recorded), the shared clock, log and
 * toasts. The remote participant is the real zero-start controller on its own
 * fake iframe (standard-start-harness.ts), so no wire timing is retyped.
 *
 * Each row runs one script (the C2-0 boundary suite's named scenarios, some
 * with a fault knob or one more step, or the remote host's legacy frames) and
 * asserts the sampler's lines as an explicit array; start-ownership-sampler.ts
 * describes the columns, the sample points and which lines are kept. Instants
 * are milliseconds after t0, the App iframe handshake. No managed-timer name or
 * module-private flag is read.
 *
 * A row marked "Looks like a defect" pins today's behaviour, not claimed
 * right.
 *
 * The fake iframe notifies the App synchronously, inside the command that
 * caused the state; a real iframe delivers onStateChange over postMessage, a
 * task or more later. The rows run on the synchronous default, and those
 * arrays are the pins a later start ledger is held to. An 'a' row runs the
 * same script with every App notification one task later (withAsyncNotify),
 * so a line that only the synchronous ordering produces is marked "Fake
 * ordering" and its 'a' row shows what real delivery does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { broadcast, safeSend, sendToHost } from '../../network/peer.ts';
import type { QueueItemId } from '../../types/index.ts';
import { STAGE2_RENDEZVOUS_BROADCAST_MS, YT_AUTO_SYNC_MS } from '../constants.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { stopYouTubeMode } from '../player.ts';
import { resetYouTubeModuleState } from '../_state.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import {
  applyVolumeAndReadUnMute,
  probeStartOwnership,
  START_OWNERSHIP_COLUMNS,
  type StartOwnershipProbe,
} from './__helpers__/start-ownership-sampler.ts';
import {
  createFakeClockStarter,
  setUpStandardRig,
  standardScenarios,
  syntheticConnection,
  type StandardRig,
  type StandardRigOptions,
  type StandardScenario,
} from './__helpers__/standard-start-harness.ts';

const clockUnderTest = vi.hoisted(() => ({ calibrated: true }));
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
  isClockCalibrated: () => clockUnderTest.calibrated,
}));

/** A synthetic Standard room code (isActiveStandardRoomCoordinator needs a leading 1-9). */
const STANDARD_ROOM_CODE = '100001';
const HOST_PEER_ID = 'host-1';
const GUEST_PEER_ID = 'guest-1';
const NEWCOMER_PEER_ID = 'guest-2';
const IDENTITY = {
  queueItemId: '71000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'ownTableA01',
  nextQueueItemId: '71000000-0000-4000-8000-000000000002' as QueueItemId,
  nextVideoId: 'ownTableB02',
};
const SCENARIOS = standardScenarios(IDENTITY);

let rig: StandardRig | null = null;
let probe: StartOwnershipProbe | null = null;
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 10, 1, 0, 0, 0));

beforeEach(() => {
  startFakeClock();
  clearAllManagedTimers();
  // A guest rendezvous calibration may store a learned play latency, which
  // resetState() reads back; no row inherits one from an earlier row.
  localStorage.removeItem('musixquare-yt-play-latency');
  resetState();
  bus.clear();
  vi.clearAllMocks();
  resetYouTubeModuleState();
  resetYouTubeSyncState();
  clockUnderTest.calibrated = true;
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
});

afterEach(() => {
  probe?.dispose();
  probe = null;
  rig?.dispose();
  rig = null;
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

// ─── Rows ──────────────────────────────────────────────────────────

interface TableStep {
  readonly at: number;
  /** One word; its sample line is 'step:<label>'. */
  readonly label: string;
  readonly run: (rig: StandardRig) => void;
}

interface TableRow {
  readonly role: 'host' | 'guest';
  readonly rig?: Partial<StandardRigOptions>;
  readonly prepare?: (rig: StandardRig) => void;
  readonly steps: readonly TableStep[];
  readonly endAt: number;
}

/** A C2-0 scenario script as a row, its steps labelled in instant order. */
function fromScenario(scenario: StandardScenario, labels: readonly string[]): TableRow {
  const steps = [...scenario.steps].sort((a, b) => a.at - b.at);
  if (steps.length !== labels.length) throw new Error(`${scenario.name}: ${labels.length} labels`);
  return {
    role: scenario.role,
    rig: scenario.rig,
    prepare: scenario.prepare,
    steps: steps.map((step, index) => ({ at: step.at, label: labels[index]!, run: step.run })),
    endAt: scenario.endAt,
  };
}

function withStep(row: TableRow, step: TableStep): TableRow {
  return { ...row, steps: [...row.steps, step] };
}

/** The Standard host presses play at +100 ms, the App's toggle-play path. */
const HOST_PLAYS: TableStep = {
  at: 100,
  label: 'play',
  run: () => bus.emit('youtube:toggle-play'),
};
const HOST_ALL_READY = fromScenario(SCENARIOS.hostAllReady, ['play']);
const HOST_PREPARE_FAILURE = fromScenario(SCENARIOS.hostPrepareFailure, ['play']);
/** No advertised guest, so the play takes the legacy two-stage rendezvous. */
const HOST_LEGACY: TableRow = {
  role: 'host',
  rig: { remoteGuestAdvertises: false },
  steps: [HOST_PLAYS],
  endAt: 9_000,
};
const GUEST_ALL_READY = fromScenario(SCENARIOS.guestAllReady, ['begin']);
const GUEST_EXCLUDED = fromScenario(SCENARIOS.guestCohortExcluded(2_600), ['begin']);

/**
 * Stage 1 of the remote host's legacy two-stage start from 0:00 at +100: a
 * YOUTUBE_STATE whose hostPlayAt is 0 (play at once, as scheduleYtAutoSync
 * sends it) or a deadline `leadMs` ahead (play then).
 */
function legacyStage1(leadMs: number): TableStep {
  return {
    at: 100,
    label: 'stage1',
    run: (current) =>
      current.deliver({
        type: MSG.YOUTUBE_STATE,
        queueItemId: IDENTITY.queueItemId,
        videoId: IDENTITY.videoId,
        subIndex: -1,
        state: 1,
        time: 0,
        hostPlayAt: leadMs > 0 ? Date.now() + leadMs : 0,
        hostClock: Date.now(),
      }),
  };
}
/** Stage 2: the manual YOUTUBE_SYNC with the host's position then, 2 s after Stage 1. */
const LEGACY_STAGE_2: TableStep = {
  at: 100 + STAGE2_RENDEZVOUS_BROADCAST_MS,
  label: 'stage2',
  run: (current) =>
    current.deliver({
      type: MSG.YOUTUBE_SYNC,
      queueItemId: IDENTITY.queueItemId,
      videoId: IDENTITY.videoId,
      subIndex: -1,
      state: 1,
      time: STAGE2_RENDEZVOUS_BROADCAST_MS / 1_000,
      hostClock: Date.now(),
      isManual: true,
    }),
};
const legacyGuestRow = (leadMs: number): TableRow => ({
  role: 'guest',
  steps: [legacyStage1(leadMs), LEGACY_STAGE_2],
  endAt: 7_000,
});

async function runRow(row: TableRow) {
  rig = await setUpStandardRig({
    role: row.role,
    sends: {
      broadcast: vi.mocked(broadcast),
      safeSend: vi.mocked(safeSend),
      sendToHost: vi.mocked(sendToHost),
    },
    roomCode: STANDARD_ROOM_CODE,
    ...IDENTITY,
    hostPeerId: HOST_PEER_ID,
    guestPeerId: GUEST_PEER_ID,
    ...row.rig,
  });
  const current = rig;
  row.prepare?.(current);
  const started = probeStartOwnership({
    api: current.api,
    sent: current.sent,
    now: current.now,
    isHost: current.role === 'host',
  });
  probe = started;
  for (const step of [...row.steps].sort((a, b) => a.at - b.at)) {
    await started.advanceTo(step.at);
    await started.step(step.label, () => step.run(current));
  }
  await started.advanceTo(row.endAt);
  started.dispose();
  return {
    samples: started.samples,
    aux: started.aux,
    beat: started.beat,
    /** Broadcast youtube-state frames, '<ms> state <state> at <canonical time>'. */
    states: current.sent
      .filter(({ via, type }) => via === 'broadcast' && type === MSG.YOUTUBE_STATE)
      .map(({ at, frame }) => `${at} state ${String(frame.state)} at ${String(frame.time)}`),
    /** Periodic host heartbeats, '<ms> state <state> at <canonical time>'. */
    heartbeats: current.sent
      .filter(({ type, frame }) => type === MSG.YOUTUBE_SYNC && frame.isManual === false)
      .map(({ at, frame }) => `${at} state ${String(frame.state)} at ${String(frame.time)}`),
    /** Frames to the late joiner, '<ms> <type>'. */
    newcomer: current.sent
      .filter(({ to }) => to === NEWCOMER_PEER_ID)
      .map(({ at, type }) => `${at} ${type}`),
  };
}

/** A newcomer outside the frozen cohort connects at +500 ms. */
const NEWCOMER_CONNECTS: TableStep = {
  at: 500,
  label: 'connect',
  run: (current) => {
    const newcomer = syntheticConnection(NEWCOMER_PEER_ID);
    setState(
      'network.activeHostConnByPeerId',
      new Map([
        [current.remotePeerId, current.conn],
        [NEWCOMER_PEER_ID, newcomer],
      ]),
    );
    bus.emit('network:peer-connected', newcomer);
  },
};

/** The host presses play or pause (the App's toggle-play path). */
const hostToggles = (at: number, label: string): TableStep => ({
  at,
  label,
  run: () => bus.emit('youtube:toggle-play'),
});
/** H4: the iframe ignores every unMute, so the audio restore times out. */
const HOST_RESTORE_TIMEOUT: TableRow = {
  ...HOST_ALL_READY,
  rig: { iframeInit: { __unMuteIgnoreCount: 1_000 } },
  endAt: 6_000,
};
const HOST_PEER_REPLACED = fromScenario(SCENARIOS.hostPeerReplaced, ['play', 'replace']);
/** H9: the host seeks to 0:42 at +200, mid-warm-up. */
const HOST_SEEKS = withStep(HOST_ALL_READY, {
  at: 200,
  label: 'seek',
  run: () => bus.emit('youtube:seek-to', 42),
});
/** H10: the host presses pause at +200, mid-warm-up. */
const HOST_PAUSES = withStep(HOST_ALL_READY, hostToggles(200, 'pause'));
/**
 * After a zero-start (play at +100) the host pauses at +3000, resumes at
 * +4000, pauses at +7000, resumes at +7500, its iframe stalls (BUFFERING then
 * PLAYING) at +10000, and the host pauses at +11000.
 */
const HOST_PAUSE_CYCLE: TableRow = {
  role: 'host',
  steps: [
    HOST_PLAYS,
    hostToggles(3_000, 'pause'),
    hostToggles(4_000, 'resume'),
    hostToggles(7_000, 'pause2'),
    hostToggles(7_500, 'resume2'),
    {
      at: 10_000,
      label: 'stall',
      run: (current) => {
        const fake = current.iframe();
        fake.__setState(3);
        fake.__setState(1);
      },
    },
    hostToggles(11_000, 'pause3'),
  ],
  endAt: 11_500,
};
const GUEST_PREPARE_FAILURE: TableRow = {
  ...GUEST_ALL_READY,
  rig: { iframeInit: { __hardMuteFails: true } },
};
/**
 * G8 on a guest that is playing the current track (the remote host's legacy
 * start: Stage 1 at +100, Stage 2 at +2100) when the remote host starts the
 * next track at +5000, this iframe's hard mute failing from +4900.
 */
const GUEST_PREPARE_FAILURE_WHILE_PLAYING: TableRow = {
  role: 'guest',
  steps: [
    legacyStage1(0),
    LEGACY_STAGE_2,
    {
      at: 4_900,
      label: 'mutefault',
      run: (current) => {
        current.iframe().__hardMuteFails = true;
      },
    },
    {
      at: 5_000,
      label: 'next',
      run: (current) => {
        const next = { queueItemId: IDENTITY.nextQueueItemId, videoId: IDENTITY.nextVideoId };
        if (!current.remote.beginHostTransition({ ...next, subIndex: null })) {
          throw new Error('the remote host could not begin the next track');
        }
      },
    },
  ],
  endAt: 9_000,
};

/**
 * The remote host presses Sync at `at` during the legacy start (Stage 1 from
 * 0:00 at +100): a manual YOUTUBE_SYNC with its position then.
 */
function hostSyncPress(at: number): TableStep {
  return {
    at,
    label: 'sync',
    run: (current) =>
      current.deliver({
        type: MSG.YOUTUBE_SYNC,
        queueItemId: IDENTITY.queueItemId,
        videoId: IDENTITY.videoId,
        subIndex: -1,
        state: 1,
        time: (at - 100) / 1_000,
        hostClock: Date.now(),
        isManual: true,
      }),
  };
}
/**
 * G14: the remote host presses Sync at +4500, 100 ms after the guest's
 * Stage 2 rendezvous ended, inside its 3 s cooldown: the guest keeps the
 * request as a pending manual rendezvous and runs it when the cooldown ends.
 */
const GUEST_SYNC_PRESS_IN_COOLDOWN: TableRow = {
  role: 'guest',
  steps: [legacyStage1(0), LEGACY_STAGE_2, hostSyncPress(4_500)],
  endAt: 9_000,
};
/**
 * G15: after G1's zero-start (release at +1422 from 0:00) this guest commits
 * a +0.25 s manual offset at +5000. Zero-start left it no host snapshot, so
 * the apply waits for the remote host's next heartbeat, at +6000.
 */
const GUEST_OFFSET_APPLY_AWAITING_HEARTBEAT: TableRow = {
  ...GUEST_ALL_READY,
  steps: [
    ...GUEST_ALL_READY.steps,
    {
      at: 5_000,
      label: 'offset',
      run: () => {
        // network/sync.ts stores the accepted device offset before this event.
        setState('sync.youtubeLocalOffset', 0.25);
        bus.emit('youtube:apply-manual-sync');
      },
    },
    {
      at: 6_000,
      label: 'heartbeat',
      run: (current) =>
        current.deliver({
          type: MSG.YOUTUBE_SYNC,
          queueItemId: IDENTITY.queueItemId,
          videoId: IDENTITY.videoId,
          subIndex: -1,
          state: 1,
          time: (6_000 - 1_422) / 1_000,
          hostClock: Date.now(),
          isManual: false,
        }),
    },
  ],
  endAt: 12_000,
};

/**
 * The same row with every App iframe state notification delivered one task
 * later (fake-yt-player.ts __stateNotifyDelayMs 0), as the real IFrame API
 * delivers onStateChange over postMessage. The rows above run on the fake's
 * default, a notification inside the command that caused it; a line that
 * differs between a row and its 'a' variant depends on that ordering.
 */
function withAsyncNotify(row: TableRow): TableRow {
  const init = row.rig?.iframeInit;
  if (typeof init === 'function') throw new Error('withAsyncNotify takes an object iframeInit');
  return { ...row, rig: { ...row.rig, iframeInit: { ...init, __stateNotifyDelayMs: 0 } } };
}

// ─── Expected lines (today's values) ───────────────────────────────

/** One all-ready host run: play at +100, COMMIT at +722, release at +1422. */
const HOST_ALL_READY_SAMPLES = [
  '0 rest idle playing',
  '100 loading:idle:clock-action@step:play idle playing',
  '100 loading:busy:zero-start@step:play muting owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld playing',
  '100 ready@step:play muting owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld playing',
  '100 ready@timer warming owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld playing',
  '360 ready@timer settling owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld playing',
  '600 ready@timer restoring-audio owned inFlight protocol guestPending auxHeld beatHeld playing',
  '720 ready@timer armed owned inFlight protocol guestPending auxHeld beatHeld playing',
  '722 ready@timer armed owned inFlight protocol guestPending auxHeld beatHeld playing',
  '722 ready@timer scheduled owned inFlight protocol guestPending auxHeld beatHeld playing',
  '722 ready@timer scheduled owned inFlight protocol guestPending auxHeld beatHeld playing',
  // 'starting' shows only in the release timer's own emission: the release
  // PLAYING arrives inside playVideo() and moves the run to 'playing'.
  '1422 ready@timer starting owned inFlight protocol guestPending auxHeld beatHeld playing',
  '1422 loading:idle:zero-start@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
  '1422 ready@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
  // The protocol identity outlives inFlight by the 2.75 s calibration window.
  '4172 ready@timer idle playing',
];
/** The first lines every zero-start host row shares: play at +100 and the warm-up. */
const HOST_WARM_UP_SAMPLES = HOST_ALL_READY_SAMPLES.slice(0, 5);
/** The first lines every zero-start guest row shares: the remote host's PREPARE at +100. */
const GUEST_PREPARE_SAMPLES = [
  '0 rest idle playing',
  '100 ready@timer idle playing',
  '100 loading:idle:clock-action@timer idle playing',
  '100 loading:busy:zero-start@timer muting owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld playing',
  '100 ready@timer muting owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld playing',
];
const GUEST_WARM_UP_SAMPLES = [
  ...GUEST_PREPARE_SAMPLES,
  '101 ready@timer warming owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld playing',
];
/** A guest that arms in time: warming, settling, audio restored, ARMED at +721. */
const GUEST_ARMED_SAMPLES = [
  ...GUEST_WARM_UP_SAMPLES,
  '361 ready@timer settling owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld playing',
  '601 ready@timer restoring-audio owned inFlight protocol guestPending auxHeld beatHeld playing',
  // 'armed' shows only in the emission before the COMMIT schedules the start.
  '721 ready@timer armed owned inFlight protocol guestPending auxHeld beatHeld playing',
];

const H3_SAMPLES = [
  ...HOST_WARM_UP_SAMPLES.slice(0, 4),
  // The hard mute never confirms: 'error' shows only in its own emission.
  '430 loading:idle:zero-start@timer error playing',
  '430 ready@timer error playing',
  '430 ready@timer idle playing',
  // The host legacy recovery owns the iframe until its release at +481.
  '430 ready@timer-micro idle owned fallback fallbackPending guestPending beatHeld unMuteHeld playing',
  '481 ready@timer idle playing',
  // Stage 1 at +481; Stage 2 waits 4 s.
  '481 ready@timer-micro idle autoSync auxHeld beatHeld playing',
  '4490 rest idle playing',
];
const H4_SAMPLES = [
  ...HOST_ALL_READY_SAMPLES.slice(0, 7),
  // The iframe ignores every unMute: the COMMIT at +722 finds the audio unrestored.
  '722 ready@timer restoring-audio owned inFlight protocol guestPending auxHeld beatHeld playing',
  '1560 loading:idle:zero-start@timer error playing',
  '1560 ready@timer error playing',
  '1560 ready@timer idle playing',
  '1560 ready@timer-micro idle owned fallback fallbackPending guestPending beatHeld unMuteHeld playing',
  // The legacy recovery times out at +4561 and keeps its fence through eight
  // verified restore attempts.
  '4561 loading:idle:zero-start@timer idle owned fallback fallbackPending guestPending beatHeld unMuteHeld playing',
  // Fake ordering: the fence ends with the iframe paused at 0:00, and its
  // last PAUSED arrived inside the fence, so playback.activity stays
  // 'playing'. Delivered one task later (H4a) that PAUSED lands after the
  // fence and the projection turns 'paused' at +5402.
  '5401 ready@timer-micro idle playing',
];
const H5_SAMPLES = [
  ...HOST_ALL_READY_SAMPLES.slice(0, 6),
  // The replacement cancels the run inside the step.
  '400 loading:idle:zero-start@step:replace idle playing',
  '400 ready@step:replace idle playing',
  // 1.5 s with no owner, then the replacement recovery until its release.
  '1900 ready@timer-micro idle owned fallback fallbackPending guestPending beatHeld unMuteHeld playing',
  '1951 ready@timer idle playing',
  '1951 ready@timer-micro idle autoSync auxHeld beatHeld playing',
  '5960 rest idle playing',
];
const H6_SAMPLES = [
  '0 rest idle playing',
  '100 ready@step:play idle playing',
  // Stage 1 inside the step; Stage 2 2 s later.
  '100 step:play idle autoSync auxHeld beatHeld playing',
  '2100 rest idle playing',
];
const H7_SAMPLES = [
  '0 rest idle playing',
  '100 ready@step:play idle playing',
  // The hold's timeline reader is installed before its own pauseVideo.
  '100 notify:2:before idle hostHold playing',
  '100 step:play idle autoSync hostHold auxHeld beatHeld playing',
  // The hold ends before the release playVideo; Stage 2 follows 2 s later.
  '5100 notify:1:before idle autoSync auxHeld beatHeld playing',
  '7100 rest idle playing',
];
const H8_SAMPLES = [
  ...HOST_ALL_READY_SAMPLES.slice(0, 9),
  // The host holds its own speaker 5 s past the room start, reporting the
  // pending canonical position.
  '722 ready@timer scheduled owned inFlight protocol heldAt guestPending auxHeld beatHeld playing',
  '722 ready@timer scheduled owned inFlight protocol heldAt guestPending auxHeld beatHeld playing',
  '6422 ready@timer starting owned inFlight protocol heldAt guestPending auxHeld beatHeld playing',
  '6422 loading:idle:zero-start@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
  '6422 ready@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
  '9172 ready@timer idle playing',
];
const H9_SAMPLES = [
  ...HOST_WARM_UP_SAMPLES,
  // The seek cancels the run as 'superseded' and enters the legacy rendezvous.
  '200 loading:idle:zero-start@step:seek idle playing',
  '200 ready@step:seek idle playing',
  '200 step:seek idle autoSync auxHeld beatHeld playing',
  '2200 rest idle playing',
];
const H10_SAMPLES = [
  ...HOST_WARM_UP_SAMPLES,
  '200 loading:idle:zero-start@step:pause idle playing',
  '200 ready@step:pause idle playing',
  '200 loading:idle:-@step:pause idle playing',
  '200 notify:2:after idle paused',
];
const H11_SAMPLES = [
  ...HOST_WARM_UP_SAMPLES,
  // Teardown projects idle first; the warm-up's pause still arrives in 'warming'.
  '150 notify:2:before warming owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld idle',
  '150 loading:idle:zero-start@step:stop idle idle',
  '150 ready@step:stop idle idle',
  '150 loading:idle:-@step:stop idle idle',
  '150 loading:idle:clock-action@step:stop idle idle',
  '150 loading:idle:-@step:stop idle idle',
];

const G1_SAMPLES = [
  ...GUEST_ARMED_SAMPLES,
  '723 ready@timer scheduled owned inFlight protocol guestPending auxHeld beatHeld playing',
  '1422 ready@timer starting owned inFlight protocol guestPending auxHeld beatHeld playing',
  '1422 loading:idle:zero-start@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
  '1422 ready@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
  '3423 ready@timer playing owned protocol guestPending auxHeld beatHeld playing',
  '4172 ready@timer idle playing',
];
/** A guest excluded from the cohort: the fallback releases at `releaseAt`, acknowledged 1 ms later. */
const guestExcludedSamples = (releaseAt: number) => [
  ...GUEST_WARM_UP_SAMPLES,
  '2401 loading:idle:zero-start@timer error playing',
  '2401 ready@timer error playing',
  '2401 ready@timer-micro error owned fallback fallbackPending guestPending beatHeld unMuteHeld playing',
  // The fallback leaves the iframe before its release playVideo; its pending
  // claim lasts until the acknowledgement.
  `${releaseAt} notify:1:before error owned fallbackPending guestPending beatHeld playing`,
  `${releaseAt + 1} ready@timer-micro error playing`,
];
const G4_SAMPLES = [
  ...GUEST_ARMED_SAMPLES,
  // Armed without a clock, it never reports ARMED; the COMMIT excludes it.
  '2401 loading:idle:zero-start@timer error playing',
  '2401 ready@timer error playing',
  '2401 ready@timer-micro error owned fallback fallbackPending guestPending beatHeld unMuteHeld playing',
  '2452 notify:1:before error owned fallbackPending guestPending beatHeld playing',
  '2453 ready@timer-micro error playing',
];
const G5_SAMPLES = [
  ...GUEST_ARMED_SAMPLES,
  '723 ready@timer scheduled owned inFlight protocol guestPending auxHeld beatHeld playing',
  // 'starting' holds at rest while the release buffers without PLAYING.
  '1422 ready@timer starting owned inFlight protocol guestPending auxHeld beatHeld playing',
  // Fake ordering: the release-ack timeout's own pause reaches the ordinary
  // projection ('starting' passes non-PLAYING states through) for 51 ms.
  // Delivered one task later (G5a) it projects in the same instant as the
  // fallback's PLAYING.
  '3222 notify:2:after starting owned inFlight protocol guestPending auxHeld beatHeld paused',
  '3222 loading:idle:zero-start@timer error paused',
  '3222 ready@timer error paused',
  '3222 ready@timer-micro error owned fallback fallbackPending guestPending beatHeld unMuteHeld paused',
  '3273 notify:1:before error owned fallbackPending guestPending beatHeld paused',
  '3273 notify:1:after error owned fallbackPending guestPending beatHeld playing',
  '3274 ready@timer-micro error playing',
];
const G6_SAMPLES = [
  ...GUEST_ARMED_SAMPLES,
  // The COMMIT excludes this armed guest: the late fallback re-schedules it
  // 800 ms later. 'fallback' shows only in its own emission.
  '2401 ready@timer fallback owned inFlight protocol guestPending auxHeld beatHeld playing',
  '2401 ready@timer scheduled owned inFlight protocol guestPending auxHeld beatHeld playing',
  '3201 ready@timer starting owned inFlight protocol guestPending auxHeld beatHeld playing',
  '3201 loading:idle:zero-start@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
  '3201 ready@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
  '5951 ready@timer idle playing',
];
const G7_SAMPLES = [
  '0 rest idle playing',
  '50 ready@step:stop idle idle',
  '50 loading:idle:-@step:stop idle idle',
  '50 loading:idle:clock-action@step:stop idle idle',
  '50 loading:idle:-@step:stop idle idle',
  '100 ready@timer idle idle',
  '100 loading:idle:clock-action@timer idle idle',
  // No ready iframe at PREPARE; the COMMIT then hands the start to the fallback.
  '100 loading:busy:zero-start@timer waiting-ready owned inFlight protocol guestPending auxHeld beatHeld idle',
  '100 ready@timer waiting-ready owned inFlight protocol guestPending auxHeld beatHeld idle',
  '2401 loading:idle:zero-start@timer error idle',
  '2401 ready@timer error idle',
  '2401 ready@timer-micro error owned fallback fallbackPending guestPending beatHeld unMuteHeld idle',
];
const G8_SAMPLES = [
  ...GUEST_PREPARE_SAMPLES,
  // The hard mute never confirms: 'error' holds with no owner until the COMMIT.
  '431 loading:idle:zero-start@timer error playing',
  '431 ready@timer error playing',
  // Fake ordering: the warm-up's own pause at +431 arrives inside the
  // controller's command and is not projected; at the COMMIT the controller
  // pauses the iframe before the fallback claims it, and an 'error' run
  // consumes no event, so the projection shows 'paused' from +2401 until the
  // fallback release at +3100. Delivered one task later (G8a) the warm-up's
  // pause arrives in 'error' and the window runs from +432 instead. G8p and
  // G8pa start over a playing track.
  '2401 notify:2:after error paused',
  '2401 ready@timer error paused',
  '2401 ready@timer-micro error owned fallback fallbackPending guestPending beatHeld unMuteHeld paused',
  '3100 notify:1:before error owned fallbackPending guestPending beatHeld paused',
  '3100 notify:1:after error owned fallbackPending guestPending beatHeld playing',
  '3101 ready@timer-micro error playing',
];
const G9_SAMPLES = [
  ...GUEST_WARM_UP_SAMPLES,
  // The ABORT crosses the link one task later and cancels the local run only.
  '300 loading:idle:zero-start@timer idle playing',
  '300 ready@timer idle playing',
];
const G10_SAMPLES = [
  ...GUEST_WARM_UP_SAMPLES,
  '2401 loading:idle:zero-start@timer error playing',
  '2401 ready@timer error playing',
  '2401 ready@timer-micro error owned fallback fallbackPending guestPending beatHeld unMuteHeld playing',
  // The host's pause retires the recovery inside the step before it pauses.
  '2500 notify:2:before error playing',
  '2500 notify:2:after error paused',
  '2500 ready@step:pause idle paused',
  '2500 loading:idle:-@step:pause idle paused',
  '2500 loading:idle:clock-action@step:pause idle paused',
  '2500 loading:idle:-@step:pause idle paused',
  '2500 loading:idle:clock-action@step:pause idle paused',
  // The recovery's readiness change is published one microtask later.
  '2500 ready@micro idle paused',
];
const G11_SAMPLES = [
  ...GUEST_ARMED_SAMPLES,
  // A guest's hold reports no pending canonical position (heldAt is host-only).
  '723 ready@timer scheduled owned inFlight protocol guestPending auxHeld beatHeld playing',
  '11421 ready@timer starting owned inFlight protocol guestPending auxHeld beatHeld playing',
  '11421 loading:idle:zero-start@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
  '11421 ready@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
  '14171 ready@timer idle playing',
];
/**
 * The legacy Stage 2 at +2100 on a guest: the precision rendezvous owns the
 * guest (guestPending without owned) until its calibration ends at +4400. It
 * holds the iframe paused at its target until its scheduled play at +3600,
 * under its 'rendezvous' loading owner, and the projection shows that pause.
 * Intended: guestRendezvousSync seeks and pauses while the buffer fills, then
 * plays on the shared clock; that is the two-stage design's precision step.
 */
const GUEST_LEGACY_STAGE_2_SAMPLES = [
  // Admission cancels any clock action first (none is pending here).
  '2100 loading:idle:clock-action@step:stage2 idle guestPending playing',
  '2100 loading:busy:rendezvous@step:stage2 idle guestPending playing',
  '2100 notify:2:after idle guestPending paused',
  '3600 notify:1:after idle guestPending playing',
  '3600 loading:idle:rendezvous@timer idle guestPending playing',
  '4400 loading:idle:rendezvous@timer idle playing',
];
/** Stage 1 as today's host sends it (hostPlayAt 0): pause, seek, and play 150 ms later. */
const G12_SAMPLES = [
  '0 rest idle playing',
  '100 loading:idle:clock-action@step:stage1 idle playing',
  '100 notify:2:after idle paused',
  // The delayed play is a guest transition with no zero-start owner.
  '100 step:stage1 idle guestPending paused',
  '250 notify:1:before idle paused',
  '250 notify:1:after idle playing',
  ...GUEST_LEGACY_STAGE_2_SAMPLES,
];
/** Stage 1 with a hostPlayAt deadline 1 s ahead: the clock action plays at +1100. */
const G13_SAMPLES = [
  '0 rest idle playing',
  '100 loading:idle:clock-action@step:stage1 idle playing',
  '100 notify:2:after idle paused',
  '100 loading:busy:clock-action@step:stage1 idle paused',
  '100 step:stage1 idle guestPending paused',
  '1100 notify:1:before idle paused',
  '1100 notify:1:after idle playing',
  '1100 loading:idle:clock-action@timer idle playing',
  ...GUEST_LEGACY_STAGE_2_SAMPLES,
];
const G14_SAMPLES = [
  ...G12_SAMPLES,
  // The pending manual rendezvous alone keeps a guest transition pending
  // until the cooldown ends at +5110, then the rendezvous runs.
  '4500 step:sync idle guestPending playing',
  '5110 loading:idle:clock-action@timer idle guestPending playing',
  '5110 loading:busy:rendezvous@timer idle guestPending playing',
  '5110 notify:2:after idle guestPending paused',
  '6610 notify:1:after idle guestPending playing',
  '6610 loading:idle:rendezvous@timer idle guestPending playing',
  '7410 loading:idle:rendezvous@timer idle playing',
];
const G15_SAMPLES = [
  ...G1_SAMPLES,
  // The pending offset apply alone keeps a guest transition pending until the
  // first retry after the heartbeat (+6250) starts its rendezvous.
  '5000 step:offset idle guestPending playing',
  '6250 loading:idle:clock-action@timer idle guestPending playing',
  '6250 loading:busy:rendezvous@timer idle guestPending playing',
  '6250 notify:2:after idle guestPending paused',
  '7750 notify:1:after idle guestPending playing',
  '7750 loading:idle:rendezvous@timer idle guestPending playing',
  '8550 loading:idle:rendezvous@timer idle playing',
];
const G5A_SAMPLES = [
  ...GUEST_ARMED_SAMPLES,
  '723 ready@timer scheduled owned inFlight protocol guestPending auxHeld beatHeld playing',
  '1422 ready@timer starting owned inFlight protocol guestPending auxHeld beatHeld playing',
  '3222 loading:idle:zero-start@timer error playing',
  '3222 ready@timer error playing',
  '3222 ready@timer-micro error owned fallback fallbackPending guestPending beatHeld unMuteHeld playing',
  // The timeout's pause and the fallback's PLAYING project in one instant.
  '3274 notify:2:before error owned fallbackPending guestPending beatHeld playing',
  '3274 notify:2:after error owned fallbackPending guestPending beatHeld paused',
  '3274 notify:1:after error owned fallbackPending guestPending beatHeld playing',
  '3274 ready@timer-micro error playing',
];
const G8A_SAMPLES = [
  ...GUEST_PREPARE_SAMPLES,
  '431 loading:idle:zero-start@timer error playing',
  '431 ready@timer error playing',
  // The warm-up error's own pause arrives in 'error', which consumes nothing:
  // 'paused' from +432 to the release; the COMMIT's pause at +2401 arrives
  // inside the fallback's fence.
  '432 notify:2:after error paused',
  '2401 ready@timer error paused',
  '2401 ready@timer-micro error owned fallback fallbackPending guestPending beatHeld unMuteHeld paused',
  '3100 rest error owned fallbackPending guestPending beatHeld paused',
  '3101 notify:1:after error owned fallbackPending guestPending beatHeld playing',
  '3101 ready@timer-micro error playing',
];
/** The next track's PREPARE at +5000 over the playing current track, as G8 at +100. */
const G8_NEXT_PREPARE_SAMPLES = [
  '5000 ready@timer idle playing',
  '5000 loading:idle:clock-action@timer idle playing',
  '5000 loading:busy:zero-start@timer muting owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld playing',
  '5000 ready@timer muting owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld playing',
  '5331 loading:idle:zero-start@timer error playing',
  '5331 ready@timer error playing',
];
const G8P_SAMPLES = [
  ...G12_SAMPLES,
  ...G8_NEXT_PREPARE_SAMPLES,
  // As in G8: 'paused' from the COMMIT (+7301) to the release (+8000).
  '7301 notify:2:after error paused',
  '7301 ready@timer error paused',
  '7301 ready@timer-micro error owned fallback fallbackPending guestPending beatHeld unMuteHeld paused',
  '8000 notify:1:before error owned fallbackPending guestPending beatHeld paused',
  '8000 notify:1:after error owned fallbackPending guestPending beatHeld playing',
  '8001 ready@timer-micro error playing',
];
const G8PA_SAMPLES = [
  // The legacy start of the current track, each state one task later.
  '0 rest idle playing',
  '100 loading:idle:clock-action@step:stage1 idle playing',
  '100 step:stage1 idle guestPending playing',
  '100 notify:2:after idle guestPending paused',
  '250 rest idle paused',
  '251 notify:1:after idle playing',
  '2100 loading:idle:clock-action@step:stage2 idle guestPending playing',
  '2100 loading:busy:rendezvous@step:stage2 idle guestPending playing',
  '2100 notify:2:after idle guestPending paused',
  '3600 loading:idle:rendezvous@timer idle guestPending paused',
  '3601 notify:1:after idle guestPending playing',
  '4400 loading:idle:rendezvous@timer idle playing',
  ...G8_NEXT_PREPARE_SAMPLES,
  // Looks like a defect: the warm-up error pauses the playing track at +5331
  // and its PAUSED is projected at +5332. No loading owner is busy after
  // +5331, and the projection stays 'paused' until the new track's release at
  // +8001 (2.67 s); the fallback claims the iframe only at the COMMIT (+7301).
  '5332 notify:2:after error paused',
  '7301 ready@timer error paused',
  '7301 ready@timer-micro error owned fallback fallbackPending guestPending beatHeld unMuteHeld paused',
  '8000 rest error owned fallbackPending guestPending beatHeld paused',
  '8001 notify:1:after error owned fallbackPending guestPending beatHeld playing',
  '8001 ready@timer-micro error playing',
];

// Wire effects on an App host (sampler 'aux' and 'beat' lines).

/**
 * The run consumes its warm-up states; the protocol query holds the release
 * PLAYING's auxiliary state. The +3000 heartbeat lands in the calibration window.
 */
const HOST_ALL_READY_AUX = [
  '100 notify:1 warming held',
  '360 notify:2 warming held',
  '1422 notify:1 starting held',
];
const HOST_ALL_READY_BEAT = [
  '3000 beat playing held',
  '6000 beat idle sent',
  '9000 beat idle sent',
];
const H2_AUX = [
  '100 notify:1 warming held',
  '360 notify:2 warming held',
  // The settle seek's synchronous BUFFERING and PAUSED, consumed by the run.
  '440 notify:3 settling held',
  '440 notify:2 settling held',
  '1422 notify:1 starting held',
];
const H3_AUX = [
  '430 notify:2 muting held',
  // The recovery owns its reload's pause.
  '431 notify:2 idle held',
  // Fake ordering, as in H9: the recovery release's own PLAYING leaves before
  // Stage 1; delivered one task later (H3a) it is held.
  '481 notify:1 idle sent',
];
/** The Stage 2 wait holds +3000. */
const H3_BEAT = ['3000 beat idle held', '6000 beat idle sent', '9000 beat idle sent'];
const H4_AUX = [
  '100 notify:1 warming held',
  '360 notify:2 warming held',
  '1560 notify:2 restoring-audio held',
  // The legacy recovery owns its pauses, then the timed-out restore attempts'.
  '1561 notify:2 idle held',
  '4561 notify:2 idle held',
  '4681 notify:2 idle held',
  '4801 notify:2 idle held',
  '4921 notify:2 idle held',
  '5041 notify:2 idle held',
  '5161 notify:2 idle held',
  '5281 notify:2 idle held',
  '5401 notify:2 idle held',
];
const H5_AUX = [
  '100 notify:1 warming held',
  '360 notify:2 warming held',
  // The cancel's own pause arrives while the run is still set.
  '400 notify:2 settling held',
  '1901 notify:2 idle held',
  // Fake ordering, as in H9: the replacement recovery's release PLAYING leaves
  // before Stage 1; delivered one task later (H5a) it is held.
  '1951 notify:1 idle sent',
];
/** Stage 2 at +5951 holds +6000 through the 500 ms manual-broadcast dedupe, another owner. */
const H5_BEAT = ['3000 beat idle held', '6000 beat idle held', '9000 beat idle sent'];
/**
 * Fake ordering, as in H9: the legacy playVideo's own PLAYING leaves before
 * Stage 1; delivered one task later (H6a) it is held.
 */
const H6_AUX = ['100 notify:1 idle sent'];
const ALL_BEATS_SENT = ['3000 beat idle sent', '6000 beat idle sent', '9000 beat idle sent'];
const H7_AUX = [
  // The hold returns before the auxiliary broadcast; then the Stage 2 wait holds it.
  '100 notify:2 idle held',
  '5100 notify:1 idle held',
];
const H7_BEAT = ['3000 beat idle held', '6000 beat idle held', '9000 beat idle sent'];
const H8_AUX = [
  '100 notify:1 warming held',
  '360 notify:2 warming held',
  '6422 notify:1 starting held',
];
const H8_BEAT = ['3000 beat scheduled held', '6000 beat scheduled held', '9000 beat playing held'];
const H9_AUX = [
  '100 notify:1 warming held',
  // The cancel's own pause, consumed by the run.
  '200 notify:2 warming held',
  // Fake ordering, not a production defect: player.ts scheduleYtAutoSync
  // calls playVideo, broadcasts Stage 1 and arms 'yt-auto-sync' (which holds
  // auxiliary states) in one synchronous pass, and only a notification inside
  // playVideo gets in before the timer. H3, H5 and H6 show the same; their 'a'
  // rows, and H9a, hold that PLAYING and send Stage 1 alone.
  '200 notify:1 idle sent',
];
// Looks like a defect, a different one: the pause path broadcasts its formal
// PAUSED first; the iframe's own PAUSED follows and is not deduped, because
// markYtStateBroadcast() stamps only the time while the 300 ms dedupe also
// compares the last auxiliary state (reset to none by every load). Real
// delivery keeps this pair (H10a). How often it happens is H10c's: the first
// pause after a load, and a pause after another auxiliary state left (a
// stall's BUFFERING and PLAYING); a pause after a resume sends one PAUSED.
// Under synchronous notifications every legacy resume's own PLAYING also
// leaves (H9's fake ordering), so there every pause sends the pair.
const H10_AUX = [
  '100 notify:1 warming held',
  '200 notify:2 warming held',
  '200 notify:2 idle sent',
];
/** Teardown leaves YouTube mode first, and stops the heartbeat. */
const H11_AUX = [
  '100 notify:1 warming held',
  '150 notify:2 warming held',
  '150 notify:2 idle held',
  '150 notify:0 idle held',
];

// Rows with every App iframe notification one task later ('a' rows).

/** H3, H6 and H9 send Stage 1 alone: the auxiliary PLAYING is held. */
const H3A_AUX = ['431 notify:2 idle held', '432 notify:2 idle held', '482 notify:1 idle held'];
const H4A_SAMPLES = [
  ...H4_SAMPLES,
  // The recovery's last PAUSED lands after its fence and is projected.
  '5402 notify:2:after idle paused',
];
const H4A_AUX = [
  '101 notify:1 warming held',
  '361 notify:2 settling held',
  '1561 notify:2 idle held',
  '1562 notify:2 idle held',
  '4562 notify:2 idle held',
  '4682 notify:2 idle held',
  '4802 notify:2 idle held',
  '4922 notify:2 idle held',
  '5042 notify:2 idle held',
  '5162 notify:2 idle held',
  '5282 notify:2 idle held',
  // That PAUSED also leaves as an auxiliary state, the room's truth: the host
  // never sent a COMMIT, so no guest started.
  '5402 notify:2 idle sent',
];
const H5A_SAMPLES = [
  ...HOST_ALL_READY_SAMPLES.slice(0, 6),
  '400 loading:idle:zero-start@step:replace idle playing',
  '400 ready@step:replace idle playing',
  // The cancel's own PAUSED arrives after the run is gone: projected, and
  // sent as an auxiliary state at 0:00.26 after this guest's ABORT. Nothing
  // plays until the replacement recovery's release.
  '400 notify:2:after idle paused',
  '1900 ready@timer-micro idle owned fallback fallbackPending guestPending beatHeld unMuteHeld paused',
  '1951 ready@timer idle paused',
  '1951 ready@timer-micro idle autoSync auxHeld beatHeld paused',
  '1952 notify:1:after idle autoSync auxHeld beatHeld playing',
  '5960 rest idle playing',
];
const H5A_AUX = [
  '101 notify:1 warming held',
  '361 notify:2 settling held',
  '400 notify:2 idle sent',
  '1902 notify:2 idle held',
  '1952 notify:1 idle held',
];
const H9A_SAMPLES = [
  ...HOST_WARM_UP_SAMPLES,
  '200 loading:idle:zero-start@step:seek idle playing',
  '200 ready@step:seek idle playing',
  '200 step:seek idle autoSync auxHeld beatHeld playing',
  // The cancel's pause and the legacy play arrive after Stage 1 is armed.
  '200 notify:2:after idle autoSync auxHeld beatHeld paused',
  '200 notify:1:after idle autoSync auxHeld beatHeld playing',
  '2200 rest idle playing',
];
const H9A_AUX = ['101 notify:1 warming held', '200 notify:2 idle held', '200 notify:1 idle held'];
/** The formal PAUSED and the iframe's own PAUSED, at 0:00.1. */
const H10_STATES = ['200 state 2 at 0.1', '200 state 2 at 0.1'];
const H10A_AUX = ['101 notify:1 warming held', '200 notify:2 idle sent', '200 notify:2 idle held'];
const H10C_SAMPLES = [
  ...HOST_ALL_READY_SAMPLES.slice(0, 12),
  '1423 loading:idle:zero-start@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
  '1423 ready@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
  '3000 ready@step:pause idle playing',
  '3000 loading:idle:-@step:pause idle playing',
  '3000 notify:2:after idle paused',
  '4000 ready@step:resume idle paused',
  '4000 step:resume idle autoSync auxHeld beatHeld paused',
  '4000 notify:1:after idle autoSync auxHeld beatHeld playing',
  '6000 rest idle playing',
  '7000 ready@step:pause2 idle playing',
  '7000 loading:idle:-@step:pause2 idle playing',
  '7000 notify:2:after idle paused',
  '7500 ready@step:resume2 idle paused',
  '7500 step:resume2 idle autoSync auxHeld beatHeld paused',
  '7500 notify:1:after idle autoSync auxHeld beatHeld playing',
  '9500 rest idle playing',
  '11000 ready@step:pause3 idle playing',
  '11000 loading:idle:-@step:pause3 idle playing',
  '11000 notify:2:after idle paused',
];
const H10C_AUX = [
  '101 notify:1 warming held',
  '361 notify:2 settling held',
  '1423 notify:1 starting held',
  '3000 notify:2 idle sent',
  // Each resume is a legacy rendezvous, whose Stage 2 wait holds its PLAYING.
  '4000 notify:1 idle held',
  '7000 notify:2 idle held',
  '7500 notify:1 idle held',
  '10000 notify:3 idle sent',
  '10000 notify:1 idle sent',
  '11000 notify:2 idle sent',
];
/** Stage 2 at +6000 and the Stage 2 wait at +9000 hold those heartbeats. */
const H10C_BEAT = ['3000 beat playing held', '6000 beat idle held', '9000 beat idle held'];
const H10C_STATES = [
  // The first pause after the load: the pair.
  '3000 state 2 at 1.578',
  '3000 state 2 at 1.578',
  '4000 state 1 at 1.578',
  // A pause after a resume: one PAUSED.
  '7000 state 2 at 4.578',
  '7500 state 1 at 4.578',
  '10000 state 3 at 7.078',
  '10000 state 1 at 7.078',
  // A pause after the stall's auxiliary states: the pair again.
  '11000 state 2 at 8.078',
  '11000 state 2 at 8.078',
];

describe('start-ownership table: Standard host (pinned 2026-11-01)', () => {
  it('H1 all-ready zero-start', async () => {
    const result = await runRow(HOST_ALL_READY);
    expect(result.samples).toEqual(HOST_ALL_READY_SAMPLES);
    expect(result.aux).toEqual(HOST_ALL_READY_AUX);
    expect(result.beat).toEqual(HOST_ALL_READY_BEAT);
  });

  it('H2 all-ready zero-start with a synchronous BUFFERING then PAUSED inside every seek', async () => {
    const row = { ...HOST_ALL_READY, rig: { iframeInit: { __seekStateSequence: [3, 2] } } };
    const result = await runRow(row);
    expect(result.samples).toEqual(HOST_ALL_READY_SAMPLES);
    expect(result.aux).toEqual(H2_AUX);
    expect(result.beat).toEqual(HOST_ALL_READY_BEAT);
  });

  it('H3 prepare failure, then the host legacy recovery', async () => {
    const result = await runRow(HOST_PREPARE_FAILURE);
    expect(result.samples).toEqual(H3_SAMPLES);
    expect(result.aux).toEqual(H3_AUX);
    expect(result.beat).toEqual(H3_BEAT);
  });

  it('H4 audio restore timeout, then a legacy recovery that times out', async () => {
    const result = await runRow(HOST_RESTORE_TIMEOUT);
    expect(result.samples).toEqual(H4_SAMPLES);
    expect(result.aux).toEqual(H4_AUX);
    expect(result.beat).toEqual(['3000 beat idle held', '6000 beat idle sent']);
    // The first heartbeat after the timeout reports the room paused at 0:00,
    // where the iframe is: the host sent PREPARE and ABORT, never a COMMIT.
    expect(result.heartbeats).toEqual(['6000 state 2 at 0']);
  });

  it('H5 peer connection replaced mid-warm-up, then the replacement recovery', async () => {
    const result = await runRow(HOST_PEER_REPLACED);
    expect(result.samples).toEqual(H5_SAMPLES);
    expect(result.aux).toEqual(H5_AUX);
    expect(result.beat).toEqual(H5_BEAT);
  });

  it('H6 legacy two-stage rendezvous', async () => {
    const result = await runRow(HOST_LEGACY);
    expect(result.samples).toEqual(H6_SAMPLES);
    expect(result.aux).toEqual(H6_AUX);
    expect(result.beat).toEqual(ALL_BEATS_SENT);
  });

  it('H7 legacy rendezvous at a -5 s offset', async () => {
    const row = { ...HOST_LEGACY, rig: { remoteGuestAdvertises: false, localOffsetSeconds: -5 } };
    const result = await runRow(row);
    expect(result.samples).toEqual(H7_SAMPLES);
    expect(result.aux).toEqual(H7_AUX);
    expect(result.beat).toEqual(H7_BEAT);
  });

  it('H8 zero-start at a -5 s offset', async () => {
    const row: TableRow = {
      role: 'host',
      rig: { localOffsetSeconds: -5 },
      steps: [HOST_PLAYS],
      endAt: 11_000,
    };
    const result = await runRow(row);
    expect(result.samples).toEqual(H8_SAMPLES);
    expect(result.aux).toEqual(H8_AUX);
    expect(result.beat).toEqual(H8_BEAT);
  });

  it('H9 host seek mid-warm-up', async () => {
    const result = await runRow(HOST_SEEKS);
    expect(result.samples).toEqual(H9_SAMPLES);
    expect(result.aux).toEqual(H9_AUX);
    expect(result.beat).toEqual(ALL_BEATS_SENT);
  });

  it('H10 host pause mid-warm-up', async () => {
    const result = await runRow(HOST_PAUSES);
    expect(result.samples).toEqual(H10_SAMPLES);
    expect(result.aux).toEqual(H10_AUX);
    expect(result.beat).toEqual(ALL_BEATS_SENT);
    expect(result.states).toEqual(H10_STATES);
  });

  it('H11 stopYouTubeMode mid-warm-up', async () => {
    const row = {
      ...withStep(HOST_ALL_READY, { at: 150, label: 'stop', run: () => stopYouTubeMode() }),
      endAt: 3_000,
    };
    const result = await runRow(row);
    expect(result.samples).toEqual(H11_SAMPLES);
    expect(result.aux).toEqual(H11_AUX);
    expect(result.beat).toEqual(['3000 beat idle held']);
  });
});

describe('start-ownership table: Standard late joiner (pinned 2026-11-01)', () => {
  it('H12 defers a newcomer outside the frozen cohort until the zero-start owner clears', async () => {
    const result = await runRow(withStep(HOST_ALL_READY, NEWCOMER_CONNECTS));
    // The newcomer changes no column and no wire effect of H1.
    expect(result.samples).toEqual(HOST_ALL_READY_SAMPLES);
    expect(result.aux).toEqual(HOST_ALL_READY_AUX);
    expect(result.beat).toEqual(HOST_ALL_READY_BEAT);
    // Re-checked every 100 ms: the first check after the owner clears (+4172).
    expect(result.newcomer).toEqual([
      '4200 youtube-play',
      '4200 youtube-state',
      '6200 youtube-sync',
    ]);
  });

  it('H12b bootstraps the same newcomer at once during the legacy rendezvous', async () => {
    const result = await runRow(withStep(HOST_LEGACY, NEWCOMER_CONNECTS));
    expect(result.samples).toEqual(H6_SAMPLES);
    expect(result.aux).toEqual(H6_AUX);
    expect(result.beat).toEqual(ALL_BEATS_SENT);
    expect(result.newcomer).toEqual(['500 youtube-play', '500 youtube-state', '2500 youtube-sync']);
  });
});

describe('start-ownership table: Standard host, notifications one task later (pinned 2026-11-01)', () => {
  it('H3a prepare failure, then the host legacy recovery', async () => {
    const result = await runRow(withAsyncNotify(HOST_PREPARE_FAILURE));
    expect(result.samples).toEqual(H3_SAMPLES);
    expect(result.aux).toEqual(H3A_AUX);
    expect(result.beat).toEqual(H3_BEAT);
    expect(result.states).toEqual(['481 state 1 at 0']);
  });

  it('H4a audio restore timeout, then a legacy recovery that times out', async () => {
    const result = await runRow(withAsyncNotify(HOST_RESTORE_TIMEOUT));
    expect(result.samples).toEqual(H4A_SAMPLES);
    expect(result.aux).toEqual(H4A_AUX);
    expect(result.beat).toEqual(['3000 beat idle held', '6000 beat idle sent']);
    expect(result.states).toEqual(['5402 state 2 at 0']);
    expect(result.heartbeats).toEqual(['6000 state 2 at 0']);
  });

  it('H5a peer connection replaced mid-warm-up, then the replacement recovery', async () => {
    const result = await runRow(withAsyncNotify(HOST_PEER_REPLACED));
    expect(result.samples).toEqual(H5A_SAMPLES);
    expect(result.aux).toEqual(H5A_AUX);
    expect(result.beat).toEqual(H5_BEAT);
    expect(result.states).toEqual(['400 state 2 at 0.26', '1951 state 1 at 0']);
  });

  it('H6a legacy two-stage rendezvous', async () => {
    const result = await runRow(withAsyncNotify(HOST_LEGACY));
    expect(result.samples).toEqual(H6_SAMPLES);
    expect(result.aux).toEqual(['100 notify:1 idle held']);
    expect(result.beat).toEqual(ALL_BEATS_SENT);
    expect(result.states).toEqual(['100 state 1 at 0']);
  });

  it('H9a host seek mid-warm-up', async () => {
    const result = await runRow(withAsyncNotify(HOST_SEEKS));
    expect(result.samples).toEqual(H9A_SAMPLES);
    expect(result.aux).toEqual(H9A_AUX);
    expect(result.beat).toEqual(ALL_BEATS_SENT);
    expect(result.states).toEqual(['200 state 1 at 42']);
  });

  it('H10a host pause mid-warm-up', async () => {
    const result = await runRow(withAsyncNotify(HOST_PAUSES));
    expect(result.samples).toEqual(H10_SAMPLES);
    expect(result.aux).toEqual(H10A_AUX);
    expect(result.beat).toEqual(ALL_BEATS_SENT);
    expect(result.states).toEqual(H10_STATES);
  });

  it('H10c pauses after a zero-start: after the load, after a resume, after a stall', async () => {
    const result = await runRow(withAsyncNotify(HOST_PAUSE_CYCLE));
    expect(result.samples).toEqual(H10C_SAMPLES);
    expect(result.aux).toEqual(H10C_AUX);
    expect(result.beat).toEqual(H10C_BEAT);
    expect(result.states).toEqual(H10C_STATES);
  });
});

describe('start-ownership table: Standard unMute guard (pinned 2026-11-01)', () => {
  /**
   * The row plus the App's own volume change at `at`, the run ending 10 ms
   * later; returns the change's line (applyVolumeAndReadUnMute).
   */
  async function volumeAt(row: TableRow, at: number): Promise<string[]> {
    const lines: string[] = [];
    await runRow({
      ...withStep(row, {
        at,
        label: 'volume',
        run: (current) => {
          lines.push(applyVolumeAndReadUnMute(current.iframe(), current.now()));
        },
      }),
      endAt: at + 10,
    });
    return lines;
  }

  // player.ts holds a volume unMute while a zero-start hard-mute phase, the
  // external fallback or the PRO arm owns the iframe's mute. The unMuteHeld
  // column retypes that guard; these rows read the guard itself, by whether
  // the iframe received unMute(). The PRO arm's row is in the PRO table (U8).
  it.each([
    ['U1 zero-start muting', HOST_ALL_READY, 100, '100 muting column:held iframe:none'],
    ['U2 zero-start warming', HOST_ALL_READY, 200, '200 warming column:held iframe:none'],
    ['U3 zero-start settling', HOST_ALL_READY, 400, '400 settling column:held iframe:none'],
    [
      // Not a hard-mute phase: the restore loop verifies the change.
      'U4 zero-start restoring-audio',
      HOST_ALL_READY,
      650,
      '650 restoring-audio column:free iframe:unMute',
    ],
    ['U5 the host legacy recovery', HOST_PREPARE_FAILURE, 450, '450 idle column:held iframe:none'],
    ['U6 the guest fallback', GUEST_EXCLUDED, 2_500, '2500 error column:held iframe:none'],
    [
      'U7 after the start, no owner (control)',
      HOST_ALL_READY,
      5_000,
      '5000 idle column:free iframe:unMute',
    ],
  ] as const)('%s', async (_row, row, at, line) => {
    expect(await volumeAt(row, at)).toEqual([line]);
  });
});

describe('start-ownership table: Standard heartbeat landing (pinned 2026-11-01)', () => {
  /** Play at `at` instead of +100; the run ends at the +3000 heartbeat. */
  const playAt = (row: TableRow, at: number): TableRow => ({
    ...row,
    steps: [{ ...HOST_PLAYS, at }],
    endAt: 3_000,
  });

  // Each play instant puts +3000 inside one phase of the H1 run (offsets from
  // the play: warming +0, settling +260, restoring-audio +500, scheduled
  // +622, playing +1322 to +4072), the host recovery (H3: +330 to +381) or
  // the legacy Stage 2 wait (H6: 2 s).
  it.each([
    [
      'warming',
      playAt(HOST_ALL_READY, 2_850),
      '3000 beat warming held',
      '2850 ready@timer warming owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld playing',
    ],
    [
      'settling',
      playAt(HOST_ALL_READY, 2_600),
      '3000 beat settling held',
      '2860 ready@timer settling owned inFlight protocol guestPending auxHeld beatHeld unMuteHeld playing',
    ],
    [
      'restoring-audio',
      playAt(HOST_ALL_READY, 2_440),
      '3000 beat restoring-audio held',
      '2940 ready@timer restoring-audio owned inFlight protocol guestPending auxHeld beatHeld playing',
    ],
    [
      'scheduled',
      playAt(HOST_ALL_READY, 2_000),
      '3000 beat scheduled held',
      '2622 ready@timer scheduled owned inFlight protocol guestPending auxHeld beatHeld playing',
    ],
    [
      'playing',
      playAt(HOST_ALL_READY, 100),
      '3000 beat playing held',
      '1422 ready@notify:1 playing owned protocol guestPending auxHeld beatHeld playing',
    ],
    [
      'the host legacy recovery',
      playAt(HOST_PREPARE_FAILURE, 2_650),
      '3000 beat idle held',
      '2980 ready@timer-micro idle owned fallback fallbackPending guestPending beatHeld unMuteHeld playing',
    ],
    [
      'the legacy Stage 2 wait',
      playAt(HOST_LEGACY, 2_000),
      '3000 beat idle held',
      '2000 step:play idle autoSync auxHeld beatHeld playing',
    ],
  ] as const)('H13 holds the +3000 heartbeat in %s', async (_window, row, beat, lastSample) => {
    const result = await runRow(row);
    expect(result.beat).toEqual([beat]);
    expect(result.samples.at(-1)).toBe(lastSample);
  });
});

describe('start-ownership table: Standard guest (pinned 2026-11-01)', () => {
  it('G1 all-ready zero-start', async () => {
    expect((await runRow(GUEST_ALL_READY)).samples).toEqual(G1_SAMPLES);
  });

  it('G2 cohort-excluded, released before startAtHost', async () => {
    expect((await runRow(GUEST_EXCLUDED)).samples).toEqual(guestExcludedSamples(3_100));
  });

  it('G3 cohort-excluded, released after startAtHost', async () => {
    const row = fromScenario(SCENARIOS.guestCohortExcluded(4_000), ['begin']);
    expect((await runRow(row)).samples).toEqual(guestExcludedSamples(4_152));
  });

  it('G4 clock uncalibrated', async () => {
    const scenario = SCENARIOS.guestClockUncalibrated((calibrated) => {
      clockUnderTest.calibrated = calibrated;
    });
    expect((await runRow(fromScenario(scenario, ['begin']))).samples).toEqual(G4_SAMPLES);
  });

  it('G5 release-ack timeout', async () => {
    const row = fromScenario(SCENARIOS.guestReleaseAckTimeout, ['begin']);
    expect((await runRow(row)).samples).toEqual(G5_SAMPLES);
  });

  it("G6 an armed guest outside the COMMIT's cohort takes the late fallback", async () => {
    const row: TableRow = {
      ...GUEST_ALL_READY,
      // The remote host never records this guest's ARMED.
      prepare: (current) => {
        current.remote.handleArmed = () => false;
      },
    };
    expect((await runRow(row)).samples).toEqual(G6_SAMPLES);
  });

  it('G7 no ready iframe at PREPARE (waiting-ready)', async () => {
    const row = {
      ...withStep(GUEST_ALL_READY, { at: 50, label: 'stop', run: () => stopYouTubeMode() }),
      endAt: 3_500,
    };
    expect((await runRow(row)).samples).toEqual(G7_SAMPLES);
  });

  it('G8 prepare failure, then the fallback at the COMMIT', async () => {
    expect((await runRow(GUEST_PREPARE_FAILURE)).samples).toEqual(G8_SAMPLES);
  });

  it('G8p the same over a playing track, the remote host starting the next one', async () => {
    expect((await runRow(GUEST_PREPARE_FAILURE_WHILE_PLAYING)).samples).toEqual(G8P_SAMPLES);
  });

  it('G9 the remote host aborts mid-warm-up', async () => {
    const row = withStep(GUEST_ALL_READY, {
      at: 300,
      label: 'abort',
      run: (current) => current.remote.cancel('cancelled', true),
    });
    expect((await runRow(row)).samples).toEqual(G9_SAMPLES);
  });

  it("G10 an explicit host pause during the excluded guest's recovery", async () => {
    const row = withStep(GUEST_EXCLUDED, {
      at: 2_500,
      label: 'pause',
      run: (current) =>
        current.deliver({
          type: MSG.YOUTUBE_STATE,
          queueItemId: IDENTITY.nextQueueItemId,
          videoId: IDENTITY.nextVideoId,
          subIndex: -1,
          state: 2,
          time: 0,
          hostClock: Date.now(),
        }),
    });
    expect((await runRow(row)).samples).toEqual(G10_SAMPLES);
  });

  it('G11 a long local hold at a -9.999 s offset', async () => {
    const row = { ...GUEST_ALL_READY, rig: { localOffsetSeconds: -9.999 }, endAt: 15_000 };
    expect((await runRow(row)).samples).toEqual(G11_SAMPLES);
  });

  // The guest side of a legacy host start as H6 sends it. H3, H5 and H9 send
  // the same Stage 1 (H3 and H5 send their Stage 2 after 4 s).
  it('G12 legacy two-stage start from the remote host', async () => {
    expect((await runRow(legacyGuestRow(0))).samples).toEqual(G12_SAMPLES);
  });

  // Today only the late-join bootstrap sends a Stage 1 deadline, this far ahead.
  it('G13 legacy two-stage start whose Stage 1 carries a hostPlayAt deadline', async () => {
    expect((await runRow(legacyGuestRow(YT_AUTO_SYNC_MS))).samples).toEqual(G13_SAMPLES);
  });

  it('G14 a host Sync press inside the rendezvous cooldown waits as a pending manual rendezvous', async () => {
    expect((await runRow(GUEST_SYNC_PRESS_IN_COOLDOWN)).samples).toEqual(G14_SAMPLES);
  });

  it('G15 a manual offset apply waits for the first heartbeat after a zero-start', async () => {
    expect((await runRow(GUEST_OFFSET_APPLY_AWAITING_HEARTBEAT)).samples).toEqual(G15_SAMPLES);
  });
});

describe('start-ownership table: Standard guest, notifications one task later (pinned 2026-11-01)', () => {
  it('G5a release-ack timeout', async () => {
    const row = withAsyncNotify(fromScenario(SCENARIOS.guestReleaseAckTimeout, ['begin']));
    expect((await runRow(row)).samples).toEqual(G5A_SAMPLES);
  });

  it('G8a prepare failure, then the fallback at the COMMIT', async () => {
    expect((await runRow(withAsyncNotify(GUEST_PREPARE_FAILURE))).samples).toEqual(G8A_SAMPLES);
  });

  it('G8pa the same over a playing track, the remote host starting the next one', async () => {
    const row = withAsyncNotify(GUEST_PREPARE_FAILURE_WHILE_PLAYING);
    expect((await runRow(row)).samples).toEqual(G8PA_SAMPLES);
  });
});

describe('start-ownership table: Standard coverage (pinned 2026-11-01)', () => {
  /**
   * Each Standard row's lines, by row (H2 and H12 assert H1's, H12b H6's, and
   * H3a, H6a and H10a H3's, H6's and H10's; H13 asserts last lines only).
   */
  const STANDARD_ROWS: ReadonlyArray<readonly [row: string, samples: readonly string[]]> = [
    ['H1', HOST_ALL_READY_SAMPLES],
    ['H3', H3_SAMPLES],
    ['H4', H4_SAMPLES],
    ['H5', H5_SAMPLES],
    ['H6', H6_SAMPLES],
    ['H7', H7_SAMPLES],
    ['H8', H8_SAMPLES],
    ['H9', H9_SAMPLES],
    ['H10', H10_SAMPLES],
    ['H11', H11_SAMPLES],
    ['H4a', H4A_SAMPLES],
    ['H5a', H5A_SAMPLES],
    ['H9a', H9A_SAMPLES],
    ['H10c', H10C_SAMPLES],
    ['G1', G1_SAMPLES],
    ['G2', guestExcludedSamples(3_100)],
    ['G3', guestExcludedSamples(4_152)],
    ['G4', G4_SAMPLES],
    ['G5', G5_SAMPLES],
    ['G6', G6_SAMPLES],
    ['G7', G7_SAMPLES],
    ['G8', G8_SAMPLES],
    ['G8p', G8P_SAMPLES],
    ['G9', G9_SAMPLES],
    ['G10', G10_SAMPLES],
    ['G11', G11_SAMPLES],
    ['G12', G12_SAMPLES],
    ['G13', G13_SAMPLES],
    ['G14', G14_SAMPLES],
    ['G15', G15_SAMPLES],
    ['G5a', G5A_SAMPLES],
    ['G8a', G8A_SAMPLES],
    ['G8pa', G8PA_SAMPLES],
  ];
  /** '<ms> <label> <phase> <tokens…> <activity>' */
  const parse = (line: string) => {
    const words = line.split(' ');
    return { phase: words[2]!, tokens: words.slice(3, -1) };
  };
  const parsed = STANDARD_ROWS.flatMap(([, samples]) => samples.map(parse));
  const ALL_TOKENS = [
    'owned',
    'inFlight',
    'protocol',
    'fallback',
    'fallbackPending',
    'autoSync',
    'hostHold',
    'heldAt',
    'guestPending',
    'proMute',
    'pauseGate',
    'auxHeld',
    'beatHeld',
    'unMuteHeld',
  ];

  it('samples the fourteen columns in this order', () => {
    expect(START_OWNERSHIP_COLUMNS.map(([token]) => token)).toEqual(ALL_TOKENS);
  });

  it('reaches every zero-start phase in some Standard row', () => {
    expect([...new Set(parsed.map(({ phase }) => phase))].sort()).toEqual([
      'armed',
      'error',
      'fallback',
      'idle',
      'muting',
      'playing',
      'restoring-audio',
      'scheduled',
      'settling',
      'starting',
      'waiting-ready',
      'warming',
    ]);
  });

  it('shows every Standard column both on and off (the PRO table covers proMute and pauseGate)', () => {
    const on = ALL_TOKENS.filter((token) => parsed.some(({ tokens }) => tokens.includes(token)));
    const off = ALL_TOKENS.filter((token) => parsed.some(({ tokens }) => !tokens.includes(token)));
    expect(on).toEqual([
      'owned',
      'inFlight',
      'protocol',
      'fallback',
      'fallbackPending',
      'autoSync',
      'hostHold',
      'heldAt',
      'guestPending',
      'auxHeld',
      'beatHeld',
      'unMuteHeld',
    ]);
    expect(off).toEqual(ALL_TOKENS);
  });

  // guestPending is isGuestYouTubeTransitionPending(): a precision rendezvous,
  // the zero-start owner, a pending manual rendezvous, a pending manual offset
  // apply, a delayed clock action or a seek-play. Rows with it on and the
  // owner off: the rendezvous and the seek-play in G12 (G8p and G8pa open with
  // the same legacy start), the clock action in G13, the pending manual
  // rendezvous in G14 and the pending offset apply in G15. The column cannot
  // show which condition holds it; each of those rows fails when its
  // condition is dropped from the query.
  it('shows a guest transition pending without the zero-start owner only in the legacy and manual guest rows', () => {
    const rows = STANDARD_ROWS.filter(([, samples]) =>
      samples
        .map(parse)
        .some(({ tokens }) => tokens.includes('guestPending') && !tokens.includes('owned')),
    ).map(([row]) => row);
    expect(rows).toEqual(['G8p', 'G12', 'G13', 'G14', 'G15', 'G8pa']);
  });
});
