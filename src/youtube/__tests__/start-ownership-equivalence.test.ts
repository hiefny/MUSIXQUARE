/**
 * @vitest-environment jsdom
 *
 * The YouTube start ledger against the composites it replaces (Phase 6
 * 6B-1). Transitional: while both exist, every sample point reads
 * - isYouTubeStartSyncOwned() next to isYouTubeZeroStartSyncOwned()
 *   (zero-start-ownership.ts: the run's protocol, then the recovery's pending
 *   claim through the player runtime bridge), and
 * - isYouTubeStartHardMuteOwned() next to the guard player.ts applied before
 *   an unMute, composed from public queries: a zero-start hard-mute phase
 *   (muting, warming, settling, through the public snapshot) || the
 *   recovery's active claim (isYouTubeZeroStartExternalFallbackActiveFromIframe)
 *   || proYouTubeAuthorityOwnsHardMute().
 * Readers outside player.ts still read the old composite, so this file goes
 * when they move to the ledger and the composite is deleted; the truth tables
 * (youtube-start-ownership-table*.test.ts) then carry the proof.
 *
 * Real wiring as in the truth tables: initYouTube, iframe.ts's state dispatch
 * and PRO authority arm behind a scripted IFrame API, youtube/sync.ts,
 * core/timers, the protocol dispatcher, the zero-start controller and, in the
 * PRO rows, the ProRoomPlaybackController with the playlist media endpoint.
 * The Standard rows run the App as the guest of a scripted remote host
 * (standard-start-harness.ts), the PRO rows as a participant
 * (pro-endpoint-harness.ts), both in the synthetic room 000001.
 *
 * The sample points are the truth-table sampler's: after every 10 ms step of
 * fake time, right after each scripted step and again after its microtasks,
 * before and after every App iframe notification, and inside every
 * youtube:zero-start-readiness-changed and youtube:sync-loading emission. A
 * row lists every point where a pair disagrees (none expected) and, as
 * positive controls, the answers it saw: each derived query both ways, and
 * the ledger inputs that turned true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { resetProStartObservations } from '../../diagnostics/pro-start-observations.ts';
import { broadcast, safeSend, sendToHost } from '../../network/peer.ts';
import { initProtocol } from '../../network/protocol.ts';
import { initPlayback } from '../../player/playback.ts';
import { initPlaylist } from '../../player/playlist.ts';
import {
  registerProPlaybackMediaEndpoint,
  resetProPlaybackAuthorityHooks,
} from '../../pro-room/playback-authority-hooks.ts';
import type { QueueItemId } from '../../types/index.ts';
import { cancelYouTubeAuthorityPreparation, proYouTubeAuthorityOwnsHardMute } from '../iframe.ts';
import { initYouTube, stopYouTubeMode } from '../player.ts';
import {
  isYouTubeZeroStartExternalFallbackActiveFromIframe,
  isYouTubeZeroStartExternalFallbackPendingFromSync,
} from '../player-runtime-bridge.ts';
import { isYouTubeStartHardMuteOwned, isYouTubeStartSyncOwned } from '../start-ownership.ts';
import { resetYouTubeModuleState } from '../_state.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import {
  getYouTubeZeroStartSnapshot,
  isYouTubeZeroStartInFlight,
  isYouTubeZeroStartProtocolActive,
} from '../zero-start.ts';
import { isYouTubeZeroStartSyncOwned } from '../zero-start-ownership.ts';
import type { FakeYtPlayer } from './__helpers__/fake-yt-player.ts';
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import {
  installScriptedIframeApi,
  loadResidentIframe,
  type ScriptedIframeApi,
} from './__helpers__/scripted-iframe-api.ts';
import {
  createFakeClockStarter,
  setUpStandardRig,
  standardScenarios,
  type StandardRig,
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
// A calibrated PRO server clock that reads this device's own time (PRO rows).
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

/** Synthetic room code. A Standard host rig needs a leading 1-9, so these rows run the App as a guest. */
const ROOM_CODE = '000001';
const IDENTITY = {
  queueItemId: '72000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'ledgerEqA01',
  nextQueueItemId: '72000000-0000-4000-8000-000000000002' as QueueItemId,
  nextVideoId: 'ledgerEqB02',
};
const SCENARIOS = standardScenarios(IDENTITY);
const PRO = createProEndpointFixture({
  roomCode: ROOM_CODE,
  roomEpoch: 6,
  queueItemId: '62000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'ledgerEqP01',
  transitionId: `transition_${'f'.repeat(22)}`,
});
const SUPERSEDING_TRANSITION_ID = `transition_${'g'.repeat(22)}`;

// ─── The equivalence probe ─────────────────────────────────────────

/** The zero-start phases in which player.ts's guard held an unMute. */
const HARD_MUTE_PHASES: ReadonlySet<string> = new Set(['muting', 'warming', 'settling']);

function hardMutePhase(): boolean {
  return HARD_MUTE_PHASES.has(getYouTubeZeroStartSnapshot()?.phase ?? 'none');
}

/** The ledger's registered inputs, each read through its public query. */
const LEDGER_INPUTS: ReadonlyArray<readonly [string, () => boolean]> = [
  ['run.inFlight', () => isYouTubeZeroStartInFlight()],
  ['run.protocolActive', () => isYouTubeZeroStartProtocolActive()],
  ['run.hardMuted', hardMutePhase],
  ['recovery.active', () => isYouTubeZeroStartExternalFallbackActiveFromIframe()],
  ['recovery.pending', () => isYouTubeZeroStartExternalFallbackPendingFromSync()],
  ['arm.hardMuted', () => proYouTubeAuthorityOwnsHardMute()],
];
const DERIVED_ANSWERS = ['syncOwned', '!syncOwned', 'hardMuteOwned', '!hardMuteOwned'];
/** Every kind of sample point, by the first word of its label. */
const POINT_KINDS = ['rest', 'step', 'micro', 'notify', 'ready', 'loading'];

interface EquivalenceResult {
  /** How many points compared both pairs. */
  readonly points: number;
  /** The kinds of sample point reached, in POINT_KINDS order. */
  readonly pointKinds: readonly string[];
  /** '<ms> <point> ledger <sync>/<mute> composite <sync>/<mute>' for each disagreement. */
  readonly mismatches: readonly string[];
  /** The derived answers seen, in DERIVED_ANSWERS order ('!' for false). */
  readonly derived: readonly string[];
  /** The ledger inputs seen true, in LEDGER_INPUTS order. */
  readonly inputs: readonly string[];
}

interface EquivalenceProbe {
  /** Run one scripted action synchronously, then flush five microtasks. */
  step(label: string, run: () => void): Promise<void>;
  /** Advance fake time to t0 + relativeMs in 10 ms steps. */
  advanceTo(relativeMs: number): Promise<void>;
  result(): EquivalenceResult;
  dispose(): void;
}

/** Start comparing now; register it after the App's own listeners (after the rig is set up). */
function probeEquivalence(api: ScriptedIframeApi, now: () => number): EquivalenceProbe {
  const mismatches: string[] = [];
  const seenKinds = new Set<string>();
  const seenDerived = new Set<string>();
  const seenInputs = new Set<string>();
  const contexts: string[] = [];
  const restorers: Array<() => void> = [];
  const wrapped = new WeakSet<FakeYtPlayer>();
  let ambient = 'micro';
  let points = 0;

  const compare = (point: string) => {
    wrapNewIframes();
    points += 1;
    seenKinds.add(/^[a-z]+/u.exec(point)?.[0] ?? point);
    const ledgerSync = isYouTubeStartSyncOwned();
    const ledgerMute = isYouTubeStartHardMuteOwned();
    const compositeSync = isYouTubeZeroStartSyncOwned();
    const compositeMute =
      hardMutePhase() ||
      isYouTubeZeroStartExternalFallbackActiveFromIframe() ||
      proYouTubeAuthorityOwnsHardMute();
    if (ledgerSync !== compositeSync || ledgerMute !== compositeMute) {
      mismatches.push(
        `${now()} ${point} ledger ${ledgerSync}/${ledgerMute} composite ${compositeSync}/${compositeMute}`,
      );
    }
    seenDerived.add(ledgerSync ? 'syncOwned' : '!syncOwned');
    seenDerived.add(ledgerMute ? 'hardMuteOwned' : '!hardMuteOwned');
    for (const [name, read] of LEDGER_INPUTS) if (read()) seenInputs.add(name);
  };

  function wrapNewIframes(): void {
    for (const { fake } of api.iframes) {
      if (wrapped.has(fake)) continue;
      wrapped.add(fake);
      const original = fake.__onStateChange;
      restorers.push(() => {
        fake.__onStateChange = original;
      });
      fake.__onStateChange = (event) => {
        const label = `notify:${event.data}`;
        compare(`${label}:before`);
        contexts.push(label);
        try {
          original?.(event);
        } finally {
          contexts.pop();
        }
        compare(`${label}:after`);
      };
    }
  }

  const context = () => contexts.at(-1) ?? ambient;
  const offReady = bus.on('youtube:zero-start-readiness-changed', () => {
    compare(`ready@${context()}`);
  });
  const offLoading = bus.on('youtube:sync-loading', (busy) => {
    compare(`loading:${busy ? 'busy' : 'idle'}@${context()}`);
  });
  compare('rest');

  return {
    async step(label, run) {
      contexts.push(`step:${label}`);
      try {
        run();
      } finally {
        contexts.pop();
      }
      compare(`step:${label}`);
      for (let flush = 0; flush < 5; flush += 1) await Promise.resolve();
      compare('micro');
    },
    async advanceTo(relativeMs) {
      while (now() < relativeMs) {
        ambient = 'timer';
        try {
          await vi.advanceTimersByTimeAsync(Math.min(10, relativeMs - now()));
        } finally {
          ambient = 'micro';
        }
        compare('rest');
      }
    },
    result: () => ({
      points,
      pointKinds: POINT_KINDS.filter((kind) => seenKinds.has(kind)),
      mismatches: [...mismatches],
      derived: DERIVED_ANSWERS.filter((answer) => seenDerived.has(answer)),
      inputs: LEDGER_INPUTS.map(([name]) => name).filter((name) => seenInputs.has(name)),
    }),
    dispose() {
      offReady();
      offLoading();
      for (const restore of restorers.splice(0)) restore();
    },
  };
}

// ─── Lifecycle ─────────────────────────────────────────────────────

let rig: StandardRig | null = null;
let probe: EquivalenceProbe | null = null;
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
  resetProPlaybackAuthorityHooks();
  resetProStartObservations();
  registerProPlaybackMediaEndpoint(null);
  clockUnderTest.calibrated = true;
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
});

afterEach(() => {
  probe?.dispose();
  probe = null;
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

// ─── Standard guest rows ───────────────────────────────────────────

interface GuestRow {
  readonly scenario: StandardScenario;
  /** One more scripted step after the scenario's own. */
  readonly extra?: { readonly at: number; readonly run: (rig: StandardRig) => void };
}

async function runGuestRow({ scenario, extra }: GuestRow): Promise<EquivalenceResult> {
  rig = await setUpStandardRig({
    role: 'guest',
    sends: {
      broadcast: vi.mocked(broadcast),
      safeSend: vi.mocked(safeSend),
      sendToHost: vi.mocked(sendToHost),
    },
    roomCode: ROOM_CODE,
    ...IDENTITY,
    hostPeerId: 'host-1',
    guestPeerId: 'guest-1',
    ...scenario.rig,
  });
  const current = rig;
  scenario.prepare?.(current);
  const started = probeEquivalence(current.api, current.now);
  probe = started;
  const steps = [...scenario.steps, ...(extra ? [extra] : [])].sort((a, b) => a.at - b.at);
  for (const [index, step] of steps.entries()) {
    await started.advanceTo(step.at);
    await started.step(String(index + 1), () => step.run(current));
  }
  await started.advanceTo(scenario.endAt);
  return started.result();
}

/** The positive controls of one row: the derived answers and the ledger inputs it saw. */
interface SeenAnswers {
  readonly derived: readonly string[];
  readonly inputs: readonly string[];
}

/** A run that arms and releases, or is cancelled: the run's claim alone. */
const RUN_ONLY: SeenAnswers = {
  derived: DERIVED_ANSWERS,
  inputs: ['run.inFlight', 'run.protocolActive', 'run.hardMuted'],
};
/** A run that hands the start to the guest recovery. */
const RUN_THEN_RECOVERY: SeenAnswers = {
  derived: DERIVED_ANSWERS,
  inputs: [...RUN_ONLY.inputs, 'recovery.active', 'recovery.pending'],
};
/** The PRO arm's claim alone: no Standard owner, so syncOwned never holds. */
const ARM_ONLY: SeenAnswers = {
  derived: ['!syncOwned', 'hardMuteOwned', '!hardMuteOwned'],
  inputs: ['arm.hardMuted'],
};

function expectEquivalent(result: EquivalenceResult, seen: SeenAnswers, endAt: number): void {
  expect(result.mismatches).toEqual([]);
  expect(result.pointKinds).toEqual(POINT_KINDS);
  expect({ derived: result.derived, inputs: result.inputs }).toEqual(seen);
  // At least one point per 10 ms step of fake time.
  expect(result.points).toBeGreaterThan(endAt / 10);
}

describe('start ledger equals the pre-ledger composites: Standard guest', () => {
  it.each([
    ['all-ready zero-start', { scenario: SCENARIOS.guestAllReady }, RUN_ONLY],
    [
      'cohort-excluded, then the guest recovery',
      { scenario: SCENARIOS.guestCohortExcluded(2_600) },
      RUN_THEN_RECOVERY,
    ],
    [
      "an armed guest outside the COMMIT's cohort takes the late fallback",
      {
        scenario: {
          ...SCENARIOS.guestAllReady,
          // The remote host never records this guest's ARMED.
          prepare: (current: StandardRig) => {
            current.remote.handleArmed = () => false;
          },
        },
      },
      RUN_ONLY,
    ],
    [
      'a hard mute that never confirms, then the guest recovery at the COMMIT',
      {
        scenario: { ...SCENARIOS.guestAllReady, rig: { iframeInit: { __hardMuteFails: true } } },
      },
      RUN_THEN_RECOVERY,
    ],
    [
      'the remote host aborts mid-warm-up',
      {
        scenario: SCENARIOS.guestAllReady,
        extra: { at: 300, run: (current: StandardRig) => current.remote.cancel('cancelled', true) },
      },
      RUN_ONLY,
    ],
    [
      "an explicit host pause during the excluded guest's recovery",
      {
        scenario: SCENARIOS.guestCohortExcluded(2_600),
        extra: {
          at: 2_500,
          run: (current: StandardRig) =>
            current.deliver({
              type: MSG.YOUTUBE_STATE,
              queueItemId: IDENTITY.nextQueueItemId,
              videoId: IDENTITY.nextVideoId,
              subIndex: -1,
              state: 2,
              time: 0,
              hostClock: Date.now(),
            }),
        },
      },
      RUN_THEN_RECOVERY,
    ],
  ] as const)('%s', async (_name, row, seen) => {
    expectEquivalent(await runGuestRow(row), seen, row.scenario.endAt);
  });
});

// ─── PRO participant rows ──────────────────────────────────────────

/** The C2-0 boundary suite's PRO participant: a resident iframe ready and paused at 0:00. */
async function setUpPro() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ title: 'Synthetic video' })),
  );
  initPlayback();
  initYouTube();
  initPlaylist();
  initProtocol();
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
  await loadResidentIframe(api, {
    queueItemId: PRO.identity.queueItemId,
    videoId: PRO.identity.videoId,
    positionSeconds: 0,
  });
  const t0 = Date.now();
  const started = probeEquivalence(api, () => Date.now() - t0);
  probe = started;
  return { probe: started, participant: PRO.createParticipant() };
}

describe('start ledger equals the pre-ledger composites: PRO participant', () => {
  it('PREPARE (zero-start) then COMMIT', async () => {
    const { probe: started, participant } = await setUpPro();
    await started.step('prepare', () =>
      participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start')),
    );
    await started.advanceTo(1_000);
    await started.step('commit', () =>
      participant.controller.acceptCommit(PRO.commitEvent(2, 0, 'zero-start')),
    );
    await started.advanceTo(4_000);
    expectEquivalent(started.result(), ARM_ONLY, 4_000);
  });

  it('a superseding PREPARE at +100, then its COMMIT', async () => {
    const { probe: started, participant } = await setUpPro();
    await started.step('prepare', () =>
      participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start')),
    );
    await started.advanceTo(100);
    await started.step('supersede', () =>
      participant.controller.acceptPrepare(
        PRO.prepareEvent(1, 0, 'zero-start', SUPERSEDING_TRANSITION_ID),
      ),
    );
    await started.advanceTo(1_000);
    await started.step('commit', () =>
      participant.controller.acceptCommit(
        PRO.commitEvent(2, 0, 'zero-start', SUPERSEDING_TRANSITION_ID),
      ),
    );
    await started.advanceTo(4_000);
    expectEquivalent(started.result(), ARM_ONLY, 4_000);
  });

  it('cancelYouTubeAuthorityPreparation() at +100', async () => {
    const { probe: started, participant } = await setUpPro();
    await started.step('prepare', () =>
      participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start')),
    );
    await started.advanceTo(100);
    await started.step('cancel', () => cancelYouTubeAuthorityPreparation());
    await started.advanceTo(2_000);
    expectEquivalent(started.result(), ARM_ONLY, 2_000);
  });
});

describe('start ledger equivalence: positive controls across the rows', () => {
  it('sees every registered ledger input true and each derived query both ways', () => {
    const rows = [RUN_ONLY, RUN_THEN_RECOVERY, ARM_ONLY];
    const inputs = new Set(rows.flatMap((row) => row.inputs));
    const derived = new Set(rows.flatMap((row) => row.derived));
    expect(LEDGER_INPUTS.map(([name]) => name).filter((name) => !inputs.has(name))).toEqual([]);
    expect(DERIVED_ANSWERS.filter((answer) => !derived.has(answer))).toEqual([]);
  });
});
