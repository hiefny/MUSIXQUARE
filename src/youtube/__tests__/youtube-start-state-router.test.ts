/**
 * @vitest-environment jsdom
 *
 * The App iframe's state events and the YouTube start owners (pinned
 * 2026-11-01): which start owner a state event reaches, in which order, which
 * owner consumes it, and when the ordinary state path takes over, as
 * youtube/iframe.ts answers today.
 *
 * Real: initYouTube's wiring, youtube/iframe.ts behind a scripted IFrame API,
 * core/timers, the protocol dispatcher, the zero-start controller, the PRO
 * authority arm and the start ledger. The Standard rows run on the C2-0
 * boundary rig (standard-start-harness.ts), the PRO row on the start-ownership
 * table's PRO participant (pro-endpoint-harness.ts). Fakes at the edges only:
 * the iframe, the network sends, the shared and PRO server clocks, log and
 * toasts.
 *
 * Each start owner's answer is recorded where iframe.ts asks it, by a wrapper
 * that asks the real owner first: partial mocks of zero-start.ts
 * (handleYouTubeZeroStartPlayerState), the start ledger
 * (isYouTubeStartRecoveryActive) and local-offset.ts
 * (isStandardHostYouTubeLocalStartPending), and a spy on the PRO arm's
 * handlePlayerStateChange (YouTubeAuthorityArmController's prototype, which
 * iframe.ts's own arm instance calls). Answers are recorded only inside the
 * one state event a row delivers, so other readers of the same queries stay
 * out of the lines. A row that forces an owner's answer still asks the real
 * owner first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
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
import { YouTubeAuthorityArmController } from '../authority-arm.ts';
import { cancelYouTubeAuthorityPreparation, proYouTubeAuthorityOwnsHardMute } from '../iframe.ts';
import { initYouTube, stopYouTubeMode } from '../player.ts';
import { resetYouTubeModuleState } from '../_state.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import type { FakeYtPlayer } from './__helpers__/fake-yt-player.ts';
import { createProEndpointFixture } from './__helpers__/pro-endpoint-harness.ts';
import { installScriptedIframeApi, loadResidentIframe } from './__helpers__/scripted-iframe-api.ts';
import {
  appZeroStartPhase,
  createFakeClockStarter,
  predicateFlags,
  runStandardScenario,
  setUpStandardRig,
  standardScenarios,
  type StandardRig,
  type StandardRigOptions,
} from './__helpers__/standard-start-harness.ts';

/** Each start owner's answers, recorded inside the one state event a row delivers. */
const ownerAnswers = vi.hoisted(() => {
  const answers = {
    /** '<owner> <answer>' in the order iframe.ts asks, or null outside the event. */
    lines: null as string[] | null,
    /** Owners whose answer a row forces to true, after the real owner answered. */
    forced: new Set<string>(),
    /** Called as an owner is asked, before it answers. */
    onAsk: null as ((owner: string) => void) | null,
    record(owner: string, ask: () => boolean): boolean {
      const lines = answers.lines;
      if (!lines) return ask();
      answers.onAsk?.(owner);
      const index = lines.push(owner) - 1;
      const answer = ask() || answers.forced.has(owner);
      lines[index] = `${owner} ${answer}`;
      return answer;
    },
  };
  return answers;
});

vi.mock('../zero-start.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../zero-start.ts')>();
  return {
    ...actual,
    handleYouTubeZeroStartPlayerState: (state: number) =>
      ownerAnswers.record('zero-start', () => actual.handleYouTubeZeroStartPlayerState(state)),
  };
});
vi.mock('../start-ownership.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../start-ownership.ts')>();
  return {
    ...actual,
    isYouTubeStartRecoveryActive: () =>
      ownerAnswers.record('recovery', () => actual.isYouTubeStartRecoveryActive()),
  };
});
vi.mock('../local-offset.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../local-offset.ts')>();
  return {
    ...actual,
    isStandardHostYouTubeLocalStartPending: () =>
      ownerAnswers.record('legacy', () => actual.isStandardHostYouTubeLocalStartPending()),
  };
});
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
// A calibrated PRO server clock that reads this device's own time.
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

/** The state the R1 rows deliver: a PAUSED that no App command caused. */
const PAUSED = 2;
/** The state the R2 rows deliver: the reused iframe's report of its cued target. */
const CUED = 5;
/** iframe.ts's deadline for a reused iframe's first matching state (loadYouTubeVideo). */
const REUSED_FEEDBACK_TIMER = 'yt-reused-feedback-timeout';

const IDENTITY = {
  queueItemId: '72000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'stateRoute1',
  nextQueueItemId: '72000000-0000-4000-8000-000000000002' as QueueItemId,
  nextVideoId: 'stateRoute2',
};
const SCENARIOS = standardScenarios(IDENTITY);
const PRO = createProEndpointFixture({
  roomCode: '000001',
  roomEpoch: 7,
  queueItemId: '72000000-0000-4000-8000-000000000003' as QueueItemId,
  videoId: 'stateRouteP',
  transitionId: `transition_${'f'.repeat(22)}`,
});

const askArm = YouTubeAuthorityArmController.prototype.handlePlayerStateChange;
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 10, 1, 0, 0, 0));
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
  ownerAnswers.lines = null;
  ownerAnswers.forced.clear();
  ownerAnswers.onAsk = null;
  vi.spyOn(YouTubeAuthorityArmController.prototype, 'handlePlayerStateChange').mockImplementation(
    function (this: YouTubeAuthorityArmController, state: number) {
      return ownerAnswers.record('pro-arm', () => askArm.call(this, state));
    },
  );
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
});

afterEach(() => {
  ownerAnswers.lines = null;
  ownerAnswers.forced.clear();
  ownerAnswers.onAsk = null;
  rig?.dispose();
  rig = null;
  PRO.resetControllers();
  resetProPlaybackAuthorityHooks();
  registerProPlaybackMediaEndpoint(null);
  cancelYouTubeAuthorityPreparation();
  stopYouTubeMode({ silent: true });
  clearAllManagedTimers();
  resetYouTubeModuleState();
  vi.restoreAllMocks();
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

async function startRig(
  role: 'host' | 'guest',
  extra: Partial<StandardRigOptions> = {},
): Promise<StandardRig> {
  rig = await setUpStandardRig({
    role,
    sends: {
      broadcast: vi.mocked(broadcast),
      safeSend: vi.mocked(safeSend),
      sendToHost: vi.mocked(sendToHost),
    },
    roomCode: '100001',
    ...IDENTITY,
    hostPeerId: 'host-1',
    guestPeerId: 'guest-1',
    ...extra,
  });
  return rig;
}

/** The start-ownership table's PRO participant: a resident iframe ready and paused at 0:00. */
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
  const iframe = await loadResidentIframe(api, {
    queueItemId: PRO.identity.queueItemId,
    videoId: PRO.identity.videoId,
    positionSeconds: 0,
  });
  return { iframe, participant: PRO.createParticipant() };
}

interface DeliveredState {
  /** Each start owner iframe.ts asked, in order, with its answer. */
  readonly owners: string[];
  /** The ordinary state path's play-state updates (ui:update-play-state). */
  readonly playStates: boolean[];
}

/**
 * The App iframe reports one state now: the iframe takes the state, and its
 * report reaches the App's state handler at once, whatever the fake's
 * delivery delay.
 */
function deliverState(fake: FakeYtPlayer, state: number): DeliveredState {
  const owners: string[] = [];
  const playStates: boolean[] = [];
  const off = bus.on('ui:update-play-state', (playing) => {
    playStates.push(playing);
  });
  ownerAnswers.lines = owners;
  try {
    fake.__setState(state, false);
    fake.__onStateChange?.({ data: state, target: fake });
  } finally {
    ownerAnswers.lines = null;
    off();
  }
  return { owners, playStates };
}

describe('the start owners an iframe state event reaches (pinned 2026-11-01)', () => {
  it('R1a a PRO arm warm-up consumes the event: no later owner is asked and the ordinary path does not run', async () => {
    const { iframe, participant } = await setUpPro();
    participant.controller.acceptPrepare(PRO.prepareEvent(1, 0, 'zero-start'));
    await vi.advanceTimersByTimeAsync(100);
    expect(proYouTubeAuthorityOwnsHardMute()).toBe(true);
    expect(deliverState(iframe, PAUSED)).toEqual({ owners: ['pro-arm true'], playStates: [] });
  });

  it('R1b a Standard host zero-start warm-up consumes the event: the recovery and the legacy hold are not asked', async () => {
    const current = await startRig('host');
    await runStandardScenario(current, { ...SCENARIOS.hostAllReady, endAt: 200 });
    expect(appZeroStartPhase()).toBe('warming');
    expect(deliverState(current.iframe(), PAUSED)).toEqual({
      owners: ['pro-arm false', 'zero-start true'],
      playStates: [],
    });
  });

  it('R1c an active guest recovery consumes the event: the legacy hold is not asked', async () => {
    const current = await startRig('guest');
    await runStandardScenario(current, { ...SCENARIOS.guestCohortExcluded(60_000), endAt: 3_000 });
    expect(predicateFlags()).toBe('owned - - fallback');
    expect(deliverState(current.iframe(), PAUSED)).toEqual({
      owners: ['pro-arm false', 'zero-start false', 'recovery true'],
      playStates: [],
    });
  });

  it("R1d the Standard host's legacy local start hold (-5 s) consumes the event", async () => {
    const current = await startRig('host', { localOffsetSeconds: -5 });
    await current.advanceTo(100);
    // A legacy start at 0:00: this speaker waits 5 s (player.ts scheduleYtAutoSync).
    bus.emit('youtube:auto-play', { targetTime: 0, state: 1, videoId: IDENTITY.videoId });
    await current.advanceTo(200);
    expect(deliverState(current.iframe(), PAUSED)).toEqual({
      owners: ['pro-arm false', 'zero-start false', 'recovery false', 'legacy true'],
      playStates: [],
    });
  });

  it('R1e with no owner holding, each owner is asked once and the ordinary path runs once', async () => {
    const current = await startRig('host');
    await current.advanceTo(100);
    expect(deliverState(current.iframe(), PAUSED)).toEqual({
      owners: ['pro-arm false', 'zero-start false', 'recovery false', 'legacy false'],
      playStates: [false],
    });
  });
});

describe('the stale reused-feedback check runs before the start owners (pinned 2026-11-01)', () => {
  // A YouTube-to-YouTube load of the next queue item pauses the reused iframe,
  // cues the target and arms the reused iframe's feedback deadline; the first
  // state the iframe reports for that target settles it. The iframe reports
  // a task later here (the fake's delivery delay, as the real IFrame API
  // posts its events), so the deadline is still armed when the row delivers
  // the target's CUED. The check runs before any start owner is asked, so it
  // settles even when an owner consumes the event.
  it.each(['pro-arm', 'zero-start', 'recovery', 'legacy'] as const)(
    'R2 settles a pending reused selection when %s consumes the event',
    async (owner) => {
      const current = await startRig('host');
      await current.advanceTo(100);
      current.iframe().__stateNotifyDelayMs = 0;
      setState('playlist.currentQueueItemId', IDENTITY.nextQueueItemId);
      bus.emit('youtube:load', IDENTITY.nextVideoId, null, IDENTITY.nextQueueItemId, false, 0);
      const armedBefore = getManagedTimer(REUSED_FEEDBACK_TIMER) !== null;
      const deadlineWhenAsked: string[] = [];
      ownerAnswers.onAsk = (asked) => {
        deadlineWhenAsked.push(
          `${asked} ${getManagedTimer(REUSED_FEEDBACK_TIMER) === null ? 'settled' : 'armed'}`,
        );
      };
      ownerAnswers.forced.add(owner);
      const delivered = deliverState(current.iframe(), CUED);
      expect({
        armedBefore,
        ...delivered,
        deadlineWhenAsked,
        armedAfter: getManagedTimer(REUSED_FEEDBACK_TIMER) !== null,
      }).toEqual(R2_ROWS[owner]);
    },
  );
});

const R2_ROWS = {
  'pro-arm': {
    armedBefore: true,
    owners: ['pro-arm true'],
    playStates: [],
    deadlineWhenAsked: ['pro-arm settled'],
    armedAfter: false,
  },
  'zero-start': {
    armedBefore: true,
    owners: ['pro-arm false', 'zero-start true'],
    playStates: [],
    deadlineWhenAsked: ['pro-arm settled', 'zero-start settled'],
    armedAfter: false,
  },
  recovery: {
    armedBefore: true,
    owners: ['pro-arm false', 'zero-start false', 'recovery true'],
    playStates: [],
    deadlineWhenAsked: ['pro-arm settled', 'zero-start settled', 'recovery settled'],
    armedAfter: false,
  },
  legacy: {
    armedBefore: true,
    owners: ['pro-arm false', 'zero-start false', 'recovery false', 'legacy true'],
    playStates: [],
    deadlineWhenAsked: [
      'pro-arm settled',
      'zero-start settled',
      'recovery settled',
      'legacy settled',
    ],
    armedAfter: false,
  },
} as const;
