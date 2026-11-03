/**
 * @vitest-environment jsdom
 *
 * Standard zero-start recovery golden (pinned 2026-11-02), tests first for
 * the move of the guest local recovery out of player.ts into its own class
 * (Phase 6 6D-1, plan step C2-9; registry RO-02 and RO-33), and of the host's
 * legacy recovery into a stage beside it (Phase 6 6D-2, plan step C2-11;
 * RO-02).
 *
 * One App device on the real wiring (standard-start-harness.ts): initYouTube's
 * recoveries, the iframe module behind a scripted IFrame API, core/timers on
 * fake time, the protocol dispatcher and the zero-start controller. The
 * remote participant is the real controller on its own fake iframe. The
 * guest rows (G): the run hands this guest's start to its recovery when the
 * host commits without it (cohort-excluded) or when its clock is
 * uncalibrated. The host rows (H): the run hands the host's start to the
 * legacy recovery when its prepare fails (a hard mute or audio restore that
 * never confirms, a COMMIT it cannot send, its prepare budget), and the
 * replacement fallback does when a cohort guest's connection is replaced; the
 * recovery hands the start to the legacy two-stage rendezvous. Inside its
 * recording windows each row writes one line per event, in the order the
 * events happen, at milliseconds since the rig's t0 (the iframe handshake):
 * - '#<n> <op>(<args>)': a command an App iframe received (#1 the scripted
 *   iframe, #2 an iframe a row puts in its place), positions to the
 *   millisecond;
 * - 'set <timer> <ms>' and 'clear <timer>': the managed timers of the
 *   zero-start recoveries (the guest's 'yt-zero-start-external-fallback', the
 *   host's 'yt-zero-start-host-fallback' and 'yt-zero-start-replacement-fallback';
 *   a guest only clears the host's two), and in the host rows the legacy
 *   rendezvous's Stage-2 timer 'yt-auto-sync';
 * - 'autoplay <true|false>': the App's autoplay intent (setYtAutoplayIntent);
 * - 'ready', or 'ready in-recovery-timer' when it fires inside a recovery
 *   timer's callback: a youtube:zero-start-readiness-changed event;
 * - 'loading <busy> <owner>': a youtube:sync-loading event;
 * - 'log <message> <detail>': a '[YouTube ZeroStart]' warning;
 * - 'frame <route> <type>': a frame the App sent, in the host rows with the
 *   state, time and manual flag of a youtube-state or youtube-sync frame;
 * - 'claims <recovery> <owned> <hard-mute> <in-flight> <protocol>': the start
 *   ledger's isYouTubeStartRecoveryActive, isYouTubeStartSyncOwned and
 *   isYouTubeStartHardMuteOwned, then the run's facades
 *   isYouTubeZeroStartInFlight and isYouTubeZeroStartProtocolActive ('-' for
 *   false), at a window's start and before any event they changed for.
 *
 * A neutral move of a recovery passes every array byte for byte: the same
 * iframe commands at the same instants, the same timer sets and clears with
 * the same delays, the same claim changes and readiness events, the same
 * log lines and the same autoplay intents. Instants a row chooses are written
 * next to its step or come from the scenario scripts; none is read from the
 * code under test. Regular runs are written with every() (the same lines at
 * each instant of a series) and once().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { broadcast, safeSend, sendToHost } from '../../network/peer.ts';
import type { QueueItemId } from '../../types/index.ts';
import { cancelYouTubeAuthorityPreparation } from '../iframe.ts';
import { stopYouTubeMode } from '../player.ts';
import {
  incrementSessionId,
  markYtPlayerReady,
  resetYouTubeModuleState,
  setYouTubePlayer,
  type YouTubePlayerInstance,
} from '../_state.ts';
import {
  isYouTubeStartHardMuteOwned,
  isYouTubeStartRecoveryActive,
  isYouTubeStartSyncOwned,
} from '../start-ownership.ts';
import { resetYouTubeSyncState } from '../sync.ts';
import {
  getYouTubeZeroStartSnapshot,
  isYouTubeZeroStartInFlight,
  isYouTubeZeroStartProtocolActive,
  resetYouTubeZeroStart,
} from '../zero-start.ts';
import {
  makeFakeYtPlayer,
  type FakeYtPlayer,
  type FakeYtPlayerCall,
} from './__helpers__/fake-yt-player.ts';
import {
  createFakeClockStarter,
  makeMediaCommandsSlow,
  runStandardScenario,
  setUpStandardRig,
  standardScenarios,
  type ScenarioStep,
  type StandardRig,
  type StandardRigOptions,
  type StandardScenario,
} from './__helpers__/standard-start-harness.ts';

/** The row's line writer while a window records; the timer, log and intent mocks write through it. */
const sink = vi.hoisted(() => ({
  write: null as ((text: string) => void) | null,
  /** Depth of recovery timer callbacks running now. */
  recoveryTimerDepth: 0,
  /** When set and true for a recovery timer, setting that timer throws. */
  failSet: null as ((name: string, delayMs: number) => boolean) | null,
  calibrated: true,
  /** Timers a row records besides the recoveries' (the host rows: the legacy Stage-2 timer). */
  alsoTimers: new Set<string>(),
}));
const isRecoveryTimer = vi.hoisted(() => (name: string) => name.startsWith('yt-zero-start-'));

vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn((message: unknown, ...details: unknown[]) => {
      if (typeof message !== 'string' || !message.startsWith('[YouTube ZeroStart]')) return;
      sink.write?.(['log', message, ...details.map((detail) => String(detail))].join(' '));
    }),
  },
}));
// Real managed timers; the recoveries' timers are written as they are set and
// cleared, and their callbacks mark the depth the readiness lines read.
vi.mock('../../core/timers.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/timers.ts')>();
  return {
    ...actual,
    setManagedTimer: (
      ...[name, callback, delayMs, options]: Parameters<typeof actual.setManagedTimer>
    ) => {
      if (!isRecoveryTimer(name)) {
        if (sink.alsoTimers.has(name)) sink.write?.(`set ${name} ${delayMs}`);
        return actual.setManagedTimer(name, callback, delayMs, options);
      }
      sink.write?.(`set ${name} ${delayMs}`);
      if (sink.failSet?.(name, delayMs)) throw new Error('synthetic managed-timer failure');
      return actual.setManagedTimer(
        name,
        () => {
          sink.recoveryTimerDepth += 1;
          try {
            return callback();
          } finally {
            sink.recoveryTimerDepth -= 1;
          }
        },
        delayMs,
        options,
      );
    },
    clearManagedTimer: (name: string) => {
      if (isRecoveryTimer(name) || sink.alsoTimers.has(name)) sink.write?.(`clear ${name}`);
      actual.clearManagedTimer(name);
    },
  };
});
vi.mock('../_state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_state.ts')>();
  return {
    ...actual,
    setYtAutoplayIntent: (autoplay: boolean) => {
      sink.write?.(`autoplay ${autoplay}`);
      actual.setYtAutoplayIntent(autoplay);
    },
  };
});
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
  isClockCalibrated: () => sink.calibrated,
}));

const IDENTITY = {
  queueItemId: '76000000-0000-4000-8000-000000000001' as QueueItemId,
  videoId: 'recoverGldA',
  nextQueueItemId: '76000000-0000-4000-8000-000000000002' as QueueItemId,
  nextVideoId: 'recoverGldB',
};
const SCENARIOS = standardScenarios(IDENTITY);
const startFakeClock = createFakeClockStarter(Date.UTC(2026, 10, 2, 0, 0, 0));
let rig: StandardRig | null = null;

beforeEach(() => {
  startFakeClock();
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  resetYouTubeModuleState();
  resetYouTubeSyncState();
  sink.write = null;
  sink.recoveryTimerDepth = 0;
  sink.failSet = null;
  sink.calibrated = true;
  sink.alsoTimers = new Set();
  document.body.innerHTML =
    '<div class="video-wrapper"><div id="youtube-player-container"><div id="youtube-player"></div></div></div>';
});

afterEach(() => {
  sink.write = null;
  sink.failSet = null;
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

// ─── Recording ─────────────────────────────────────────────────────

function formatArg(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 1_000) / 1_000);
  return String(value);
}

/** The five claim reads, '-' for false. */
function claimsNow(): string {
  return [
    isYouTubeStartRecoveryActive() ? 'recovery' : '-',
    isYouTubeStartSyncOwned() ? 'owned' : '-',
    isYouTubeStartHardMuteOwned() ? 'hard-mute' : '-',
    isYouTubeZeroStartInFlight() ? 'in-flight' : '-',
    isYouTubeZeroStartProtocolActive() ? 'protocol' : '-',
  ].join(' ');
}

/** Write each command `fake` receives as '#<n> <op>(<args>)', while a window records. */
function tapIframe(fake: FakeYtPlayer, n: number): void {
  const calls = fake.__log;
  const push = calls.push.bind(calls);
  calls.push = (...entries: FakeYtPlayerCall[]) => {
    for (const { op, args } of entries) {
      sink.write?.(`#${n} ${op}(${(args ?? []).map(formatArg).join(',')})`);
    }
    return push(...entries);
  };
}

interface RecoveryRow {
  readonly scenario: StandardScenario;
  /** Rig options beyond the scenario's own (a local offset). */
  readonly rig?: Partial<StandardRigOptions>;
  /** The row's own steps, at instants relative to t0. */
  readonly steps?: readonly ScenarioStep[];
  /** Recording windows [from, to], relative to t0, in order. */
  readonly windows: ReadonlyArray<readonly [number, number]>;
  /** The host rows: also the legacy rendezvous's Stage-2 timer and the room state frames' fields. */
  readonly legacy?: true;
}

/** A frame's line: its route and type, and for a host row the room state it carries. */
function frameLine(
  type: string,
  frame: Readonly<Record<string, unknown>>,
  legacy: boolean,
): string {
  if (!legacy || (type !== MSG.YOUTUBE_STATE && type !== MSG.YOUTUBE_SYNC)) return type;
  return `${type} state=${formatArg(frame.state)} time=${formatArg(frame.time)}${frame.isManual ? ' manual' : ''}`;
}

async function startRig(
  scenario: StandardScenario,
  options: Partial<StandardRigOptions> = {},
): Promise<StandardRig> {
  rig = await setUpStandardRig({
    role: scenario.role,
    sends: {
      broadcast: vi.mocked(broadcast),
      safeSend: vi.mocked(safeSend),
      sendToHost: vi.mocked(sendToHost),
    },
    roomCode: '100001',
    ...IDENTITY,
    hostPeerId: 'host-1',
    guestPeerId: 'guest-1',
    ...scenario.rig,
    ...options,
  });
  return rig;
}

/** Run the row's scenario and return the lines its windows recorded. */
async function record(row: RecoveryRow): Promise<string[]> {
  const current = await startRig(row.scenario, row.rig);
  tapIframe(current.iframe(), 1);
  if (row.legacy) sink.alsoTimers = new Set([LEGACY_STAGE_2]);
  const lines: string[] = [];
  let framesSeen = current.sent.length;
  let lastClaims = '';
  // A frame is written before the next event, at its own send instant.
  const flushFrames = () => {
    for (; framesSeen < current.sent.length; framesSeen += 1) {
      const { at, via, to, type, frame } = current.sent[framesSeen]!;
      lines.push(`${at} frame ${via}:${to ?? '*'} ${frameLine(type, frame, !!row.legacy)}`);
    }
  };
  const write = (text: string) => {
    flushFrames();
    const at = current.now();
    const claims = claimsNow();
    if (claims !== lastClaims) {
      lastClaims = claims;
      lines.push(`${at} claims ${claims}`);
    }
    lines.push(`${at} ${text}`);
  };
  const offReady = bus.on('youtube:zero-start-readiness-changed', () => {
    sink.write?.(sink.recoveryTimerDepth > 0 ? 'ready in-recovery-timer' : 'ready');
  });
  const offLoading = bus.on('youtube:sync-loading', (busy: boolean, owner?: string) => {
    sink.write?.(`loading ${busy} ${owner ?? '-'}`);
  });
  const starts = row.windows.map(([from]) => ({
    at: from,
    run: () => {
      framesSeen = current.sent.length;
      lastClaims = claimsNow();
      lines.push(`${current.now()} claims ${lastClaims}`);
      sink.write = write;
    },
  }));
  const stops = row.windows.map(([, to]) => ({
    at: to,
    run: () => {
      flushFrames();
      sink.write = null;
    },
  }));
  try {
    await runStandardScenario(current, {
      ...row.scenario,
      steps: [...starts, ...row.scenario.steps, ...(row.steps ?? []), ...stops],
      endAt: row.windows.at(-1)![1],
    });
  } finally {
    sink.write = null;
    offReady();
    offLoading();
  }
  return lines;
}

// ─── Expected lines ────────────────────────────────────────────────

/** `lines` at each instant from `from` to `to` (inclusive), `step` ms apart. */
function every(from: number, to: number, step: number, lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let instant = from; instant <= to; instant += step) {
    out.push(...lines.map((line) => `${instant} ${line}`));
  }
  return out;
}

/** `lines` at one instant. */
function once(instant: number, lines: readonly string[]): string[] {
  return every(instant, instant, 1, lines);
}

const EXTERNAL = 'yt-zero-start-external-fallback';
const HOST = 'yt-zero-start-host-fallback';
const REPLACEMENT = 'yt-zero-start-replacement-fallback';
const LEGACY_STAGE_2 = 'yt-auto-sync';
/** The run gives up its start at +2401 (it stops its warm-up and its claims end); the recovery takes its claim and schedules its first attempt. */
const HAND_OFF = (reason: string) => [
  '#1 pauseVideo()',
  'claims - - - - -',
  'loading false zero-start',
  'ready',
  `clear ${EXTERNAL}`,
  `log [YouTube ZeroStart] Falling back locally: ${reason}`,
  'claims recovery owned hard-mute - -',
  `set ${EXTERNAL} 0`,
];
/** An attempt that finds no ready target before the deadline: it keeps the iframe's events and polls again. */
const NOT_READY = ['autoplay false', `set ${EXTERNAL} 50`];
/** A ready target settles: paused and sought to the local zero, checked one poll later. */
const SETTLE = ['autoplay false', '#1 pauseVideo()', '#1 seekTo(0,true)', `set ${EXTERNAL} 50`];
/** A settled target before the release: muted, paused and sought, until the release instant. */
const HOLD = (waitMs: number, n = 1) => [
  'autoplay false',
  `#${n} mute()`,
  `#${n} pauseVideo()`,
  `#${n} seekTo(0,true)`,
  `set ${EXTERNAL} ${waitMs}`,
];
/** The restore before a release: the desired audio written, then checked. */
const RESTORE = (volume = 100, n = 1) => [
  'autoplay false',
  `#${n} setVolume(${volume})`,
  `#${n} unMute()`,
];
/** A verified restore, then the release: paused, sought, the audio again, the events given back, play. */
const RELEASE = (seekSec: number, volume = 100, n = 1) => [
  ...RESTORE(volume, n),
  `#${n} pauseVideo()`,
  `#${n} seekTo(${seekSec},true)`,
  `#${n} setVolume(${volume})`,
  `#${n} unMute()`,
  'autoplay true',
  'claims - owned - - -',
  `#${n} playVideo()`,
];
/** The first acknowledgement poll sees PLAYING: the recovery ends. */
const ACKNOWLEDGED = (reason: string) => [
  `clear ${EXTERNAL}`,
  'claims - - - - -',
  `log [YouTube ZeroStart] Recovered locally: ${reason}`,
  'ready',
];
/** One cleanup of the exact iframe: paused and sought to the local zero, its audio written. */
const CLEANUP = [
  'autoplay false',
  '#1 pauseVideo()',
  '#1 seekTo(0,true)',
  '#1 setVolume(100)',
  '#1 unMute()',
];
/** A fence failed at an attempt: abandoned with one unverified cleanup. */
const ABANDONED_AT_ATTEMPT = [
  `clear ${EXTERNAL}`,
  'autoplay false',
  'claims - - - - -',
  'autoplay false',
  ...CLEANUP,
  'ready',
];
/** Abandoned at an attempt with the verified cleanup, which the iframe confirms at once. */
const ABANDONED_VERIFIED = [
  `clear ${EXTERNAL}`,
  'autoplay false',
  ...CLEANUP,
  'claims - - - - -',
  `clear ${EXTERNAL}`,
  'ready',
];

// ─── Scripted iframe faults ────────────────────────────────────────

/**
 * Like makeMediaCommandsSlow, but the load ends cued (state 5, notified) at
 * `positionSec` instead of playing: cueVideoById never completes, and
 * loadVideoById reports the new video readyAfterMs later.
 */
function makeLoadCueAt(fake: FakeYtPlayer, readyAfterMs: number, positionSec: number): void {
  fake.cueVideoById = (videoId: string, startSeconds = 0) => {
    fake.__log.push({ op: 'cueVideoById', args: [videoId, startSeconds], at: Date.now() });
  };
  fake.loadVideoById = (videoId: string, startSeconds?: number) => {
    fake.__log.push({
      op: 'loadVideoById',
      args: startSeconds === undefined ? [videoId] : [videoId, startSeconds],
      at: Date.now(),
    });
    setTimeout(() => {
      fake.__videoId = videoId;
      fake.__currentTime = positionSec;
      fake.__setState(5);
    }, readyAfterMs);
  };
}

/** Every seekTo lands `landingSec` past its target from now on (0 restores it). */
function landSeeksLate(fake: FakeYtPlayer): (landingSec: number) => void {
  const seek = fake.seekTo;
  let landing = 0;
  fake.seekTo = (seconds: number, allowAhead?: boolean) => {
    seek(seconds, allowAhead);
    fake.__currentTime = seconds + landing;
  };
  return (landingSec) => {
    landing = landingSec;
  };
}

function step(instant: number, run: (current: StandardRig) => void): ScenarioStep {
  return { at: instant, run };
}

/** The host commits at +2400 without this guest, whose load is ready `readyAfterMs` after it began (about +100). */
const cohortExcluded = (readyAfterMs: number) => SCENARIOS.guestCohortExcluded(readyAfterMs);
const uncalibrated = () =>
  SCENARIOS.guestClockUncalibrated((calibrated) => {
    sink.calibrated = calibrated;
  });

/** The rows that more than one test reads. */
const ROWS = {
  releasedBeforeStart: { scenario: cohortExcluded(2_600), windows: [[2_400, 3_400]] },
  abandonedUnready: {
    scenario: uncalibrated(),
    steps: [
      // The controller stops its warm-up at +2401; from then on the iframe
      // reports no cueable target, so the recovery never finds it ready.
      step(2_401, (current) => current.iframe().__setState(-1, false)),
      // The iframe reports muted and ignores every unmute (the WebKit knob), so
      // the verified cleanup runs all its attempts.
      step(5_300, (current) => {
        current.iframe().__muted = true;
        current.iframe().__unMuteIgnoreCount = 1_000;
      }),
    ],
    windows: [
      [2_400, 2_460],
      [5_300, 6_400],
    ],
  },
} satisfies Record<string, RecoveryRow>;

/** The lines of ROWS.releasedBeforeStart. */
const RELEASED_BEFORE_START = [
  '2400 claims - owned hard-mute in-flight protocol',
  ...once(2_401, [...HAND_OFF('cohort-excluded'), 'ready']),
  // The load is ready at +2701: settled at the next attempt, held until
  // startAtHost (+3100).
  ...every(2_402, 2_652, 50, NOT_READY),
  ...once(2_702, SETTLE),
  ...once(2_752, HOLD(348)),
  ...once(3_100, [...RELEASE(0), `set ${EXTERNAL} 0`]),
  ...once(3_101, ACKNOWLEDGED('cohort-excluded')),
];

/** The lines of ROWS.abandonedUnready. */
const ABANDONED_UNREADY = [
  '2400 claims - owned - in-flight protocol',
  ...once(2_401, [...HAND_OFF('clock-uncalibrated'), 'ready']),
  ...every(2_402, 2_452, 50, NOT_READY),
  '5300 claims recovery owned hard-mute - -',
  // The 3 s window ends at +5401: the attempt at +5402 abandons, and the
  // verified cleanup tries eight times 120 ms apart, reissuing the pause and
  // the seek with the audio each time.
  ...every(5_302, 5_352, 50, NOT_READY),
  ...once(5_402, ['autoplay false', `clear ${EXTERNAL}`, 'autoplay false']),
  ...every(5_402, 6_122, 120, [...CLEANUP, `set ${EXTERNAL} 120`]),
  ...once(6_242, [...CLEANUP, 'claims - - - - -', `clear ${EXTERNAL}`, 'ready']),
];

describe('Standard guest zero-start recovery golden (pinned 2026-11-02)', () => {
  it('G1 cohort-excluded with its load issued: adopts the load and releases at startAtHost', async () => {
    expect(await record(ROWS.releasedBeforeStart)).toEqual(RELEASED_BEFORE_START);
  });

  it('G1 cohort-excluded, its load ready after startAtHost: released at once at the room position', async () => {
    expect(await record({ scenario: cohortExcluded(4_000), windows: [[2_400, 4_400]] })).toEqual([
      '2400 claims - owned hard-mute in-flight protocol',
      ...once(2_401, [...HAND_OFF('cohort-excluded'), 'ready']),
      // Ready at +4101, a second after startAtHost: settled, then released
      // at the room position, 1.052 s.
      ...every(2_402, 4_052, 50, NOT_READY),
      ...once(4_102, SETTLE),
      ...once(4_152, [...RELEASE(1.052), `set ${EXTERNAL} 0`]),
      ...once(4_153, ACKNOWLEDGED('cohort-excluded')),
    ]);
  });

  it('G2 a recovery it cannot adopt: its 3 s window ends unready, then the verified cleanup tries eight times', async () => {
    expect(await record(ROWS.abandonedUnready)).toEqual(ABANDONED_UNREADY);
  });

  it.each([
    [
      0.35,
      // Within the tolerance: the target at the first attempt after its load.
      [...once(2_702, SETTLE), ...once(2_752, HOLD(348))],
    ],
    [
      0.351,
      // Past it: not the target until it returns to 0:00 at +2800.
      [...every(2_702, 2_752, 50, NOT_READY), ...once(2_802, SETTLE), ...once(2_852, HOLD(248))],
    ],
  ] as const)(
    'G3 the identity check: a load cued %s s from the local zero',
    async (positionSec, settled) => {
      const lines = await record({
        scenario: {
          ...cohortExcluded(2_600),
          prepare: (current) => makeLoadCueAt(current.iframe(), 2_600, positionSec),
        },
        steps: [
          step(2_800, (current) => {
            current.iframe().__currentTime = 0;
          }),
        ],
        windows: [[2_690, 3_250]],
      });
      expect(lines).toEqual([
        '2690 claims recovery owned hard-mute - -',
        ...settled,
        ...once(3_100, [...RELEASE(0), `set ${EXTERNAL} 0`]),
        ...once(3_101, ACKNOWLEDGED('cohort-excluded')),
      ]);
    },
  );

  it.each([
    [
      0.35,
      // Within the tolerance: settled at the attempt after the seek, and
      // released at once (an uncalibrated recovery has no future start).
      [...once(2_402, SETTLE), ...once(2_452, [...RELEASE(0), `set ${EXTERNAL} 0`])],
      2_453,
    ],
    [
      0.351,
      // Past it: paused and sought again at each attempt until a seek lands
      // on target (from +2501).
      [...every(2_402, 2_502, 50, SETTLE), ...once(2_552, [...RELEASE(0), `set ${EXTERNAL} 0`])],
      2_553,
    ],
  ] as const)(
    'G3 the settled check: every seek lands %s s past its target',
    async (landingSec, released, acknowledgedAt) => {
      let land: (landing: number) => void = () => {};
      const lines = await record({
        scenario: uncalibrated(),
        steps: [
          step(2_400, (current) => {
            land = landSeeksLate(current.iframe());
            land(landingSec);
          }),
          step(2_501, () => land(0)),
        ],
        windows: [[2_400, 2_700]],
      });
      expect(lines).toEqual([
        '2400 claims - owned - in-flight protocol',
        ...once(2_401, [...HAND_OFF('clock-uncalibrated'), 'ready']),
        ...released,
        ...once(acknowledgedAt, ACKNOWLEDGED('clock-uncalibrated')),
      ]);
    },
  );

  it('G4 an attempt one millisecond before the deadline polls again; the next attempt abandons', async () => {
    // A -7 s local offset holds the settled target until startAtHost + 7 s
    // (+10100), one millisecond before the adopted 7.7 s window ends
    // (+10101). The iframe stops reporting its target at +10000.
    const lines = await record({
      scenario: cohortExcluded(2_600),
      rig: { localOffsetSeconds: -7 },
      steps: [step(10_000, (current) => current.iframe().__setState(-1, false))],
      windows: [
        [2_745, 2_760],
        [9_990, 10_400],
      ],
    });
    expect(lines).toEqual([
      '2745 claims recovery owned hard-mute - -',
      ...once(2_752, HOLD(7_348)),
      '9990 claims recovery owned hard-mute - -',
      ...once(10_100, NOT_READY),
      ...once(10_150, ['autoplay false', ...ABANDONED_VERIFIED]),
    ]);
  });

  it('G5 an iframe that ignores three unmutes: the restore before the release polls until it reports the audio', async () => {
    const lines = await record({
      scenario: cohortExcluded(2_600),
      steps: [
        step(3_090, (current) => {
          current.iframe().__unMuteIgnoreCount = 3;
        }),
      ],
      windows: [[3_090, 3_500]],
    });
    expect(lines).toEqual([
      '3090 claims recovery owned hard-mute - -',
      // The third cadence: command, check, then a 50 ms poll.
      ...every(3_100, 3_200, 50, [...RESTORE(), `set ${EXTERNAL} 50`]),
      ...once(3_250, [...RELEASE(0.15), `set ${EXTERNAL} 0`]),
      ...once(3_251, ACKNOWLEDGED('cohort-excluded')),
    ]);
  });

  it('G5 at a -9.999 s offset the restore before the release ends at max(deadline, now + 1 s), then the verified cleanup', async () => {
    // The release waits until startAtHost + 9.999 s (+13099), past the 7.7 s
    // window (+10101), so the restore gets one second.
    const lines = await record({
      scenario: cohortExcluded(2_600),
      rig: { localOffsetSeconds: -9.999 },
      steps: [
        step(13_000, (current) => {
          current.iframe().__unMuteIgnoreCount = 1_000;
        }),
      ],
      windows: [[13_000, 15_300]],
    });
    expect(lines).toEqual([
      '13000 claims recovery owned hard-mute - -',
      ...every(13_099, 14_049, 50, [...RESTORE(), `set ${EXTERNAL} 50`]),
      ...once(14_099, [...RESTORE(), `clear ${EXTERNAL}`, 'autoplay false']),
      ...every(14_099, 14_819, 120, [...CLEANUP, `set ${EXTERNAL} 120`]),
      ...once(14_939, [...CLEANUP, 'claims - - - - -', `clear ${EXTERNAL}`, 'ready']),
    ]);
  });

  it('G6 an iframe rebuilt mid-recovery: the previous one is cleaned up and the new one loads the target itself', async () => {
    const lines = await record({
      scenario: cohortExcluded(60_000),
      steps: [
        step(3_000, () => {
          const rebuilt = makeFakeYtPlayer({
            __videoId: IDENTITY.videoId,
            __state: 5,
            __duration: 240,
            __advanceClock: true,
            __autoPlayOnLoad: true,
          });
          tapIframe(rebuilt, 2);
          setYouTubePlayer(rebuilt as unknown as YouTubePlayerInstance);
          markYtPlayerReady(rebuilt as unknown as YouTubePlayerInstance);
        }),
      ],
      windows: [[2_990, 3_300]],
    });
    expect(lines).toEqual([
      '2990 claims recovery owned hard-mute - -',
      ...once(3_002, [
        // The previous iframe: one cleanup, never verified.
        ...CLEANUP,
        // The rebuilt one inherits no load: hard-muted, loaded, settled.
        'autoplay false',
        '#2 mute()',
        '#2 loadVideoById(recoverGldB,0)',
        '#2 pauseVideo()',
        '#2 seekTo(0,true)',
        `set ${EXTERNAL} 50`,
      ]),
      ...once(3_052, HOLD(48, 2)),
      ...once(3_100, [...RELEASE(0, 100, 2), `set ${EXTERNAL} 0`]),
      ...once(3_101, ACKNOWLEDGED('cohort-excluded')),
    ]);
  });

  it('G7 a release playVideo() that throws: logged, then the verified cleanup', async () => {
    const lines = await record({
      scenario: cohortExcluded(2_600),
      steps: [
        step(3_050, (current) => {
          const fake = current.iframe();
          fake.playVideo = () => {
            fake.__log.push({ op: 'playVideo', at: Date.now() });
            throw new Error('synthetic playVideo failure');
          };
        }),
      ],
      windows: [[3_090, 3_400]],
    });
    expect(lines).toEqual([
      '3090 claims recovery owned hard-mute - -',
      ...once(3_100, [
        ...RELEASE(0),
        'claims recovery owned hard-mute - -',
        'autoplay false',
        'log [YouTube ZeroStart] Local fallback release failed: Error: synthetic playVideo failure',
        ...ABANDONED_VERIFIED,
      ]),
    ]);
  });

  it('G8 a release the iframe never acknowledges: after 1.8 s, the verified cleanup', async () => {
    const lines = await record({
      scenario: cohortExcluded(2_600),
      steps: [
        step(3_050, (current) => {
          const fake = current.iframe();
          fake.playVideo = () => {
            fake.__log.push({ op: 'playVideo', at: Date.now() });
            fake.__setState(3);
          };
        }),
      ],
      windows: [[3_090, 5_100]],
    });
    expect(lines).toEqual([
      '3090 claims recovery owned hard-mute - -',
      ...once(3_100, [...RELEASE(0), `set ${EXTERNAL} 0`]),
      // The ordinary path keeps the iframe's events while the recovery polls.
      ...every(3_101, 4_851, 50, ['autoplay true', `set ${EXTERNAL} 50`]),
      ...once(4_901, [
        'log [YouTube ZeroStart] Local fallback release was not acknowledged',
        'claims recovery owned hard-mute - -',
        'autoplay false',
        ...ABANDONED_VERIFIED,
      ]),
    ]);
  });

  // Each fence acts at +3000, between two attempts of a recovery whose load
  // never completes.
  const FENCES: ReadonlyArray<readonly [string, (current: StandardRig) => void, string[]]> = [
    [
      'a newer PREPARE takes the iframe over, with no recovery command',
      (current) => {
        current.cutLink();
        current.deliver({
          type: MSG.YOUTUBE_ZERO_START_PREPARE,
          version: 1,
          runId: 'recovery-golden-run-2',
          sequence: 2,
          queueItemId: IDENTITY.nextQueueItemId,
          videoId: IDENTITY.nextVideoId,
          subIndex: null,
          prepareAtHost: Date.now(),
          decisionAtHost: Date.now() + 2_300,
          startDeadlineAtHost: Date.now() + 3_000,
          hostPlatform: 'other',
        });
      },
      once(3_000, [
        // The controller stops the old run, then the selection transfers the
        // recovery's player state to the new run.
        '#1 pauseVideo()',
        'ready',
        'loading false clock-action',
        `clear ${EXTERNAL}`,
        'claims - - - - -',
        'clear yt-zero-start-replacement-fallback',
        'clear yt-zero-start-host-fallback',
        'autoplay true',
        'claims - owned hard-mute in-flight protocol',
        'loading true zero-start',
        'ready',
        '#1 mute()',
        'ready',
        '#1 setVolume(100)',
        '#1 mute()',
        'ready',
        '#1 loadVideoById(recoverGldB,0)',
      ]),
    ],
    [
      'a matching ABORT',
      (current) => {
        const snapshot = getYouTubeZeroStartSnapshot();
        current.deliver({
          type: MSG.YOUTUBE_ZERO_START_ABORT,
          version: 1,
          runId: snapshot?.runId,
          sequence: snapshot?.sequence,
          queueItemId: IDENTITY.nextQueueItemId,
          reason: 'cancelled',
        });
      },
      once(3_000, [
        // The controller stops and restores the old run, then the recovery is
        // cleared with one cleanup.
        '#1 pauseVideo()',
        'ready',
        '#1 setVolume(100)',
        '#1 unMute()',
        `clear ${EXTERNAL}`,
        'claims - - - - -',
        'autoplay false',
        ...CLEANUP,
        'ready',
      ]),
    ],
    [
      'the host connection closes',
      (current) => {
        (current.conn as { open: boolean }).open = false;
      },
      once(3_002, ABANDONED_AT_ATTEMPT),
    ],
    [
      'the host disconnects',
      () => bus.emit('network:peer-disconnected', 'host-1'),
      once(3_000, [
        `clear ${EXTERNAL}`,
        'claims - - - - -',
        'autoplay false',
        ...CLEANUP,
        // The run's cancel (authority-changed).
        'ready',
        '#1 setVolume(100)',
        '#1 unMute()',
        'ready',
      ]),
    ],
    ['a new YouTube session', () => incrementSessionId(), once(3_002, ABANDONED_AT_ATTEMPT)],
    [
      'another queue item',
      () => setState('playlist.currentQueueItemId', IDENTITY.queueItemId),
      once(3_002, ABANDONED_AT_ATTEMPT),
    ],
    [
      'the run is reset',
      () => resetYouTubeZeroStart(),
      [
        ...once(3_000, ['ready', '#1 setVolume(100)', '#1 unMute()']),
        ...once(3_002, [
          ...ABANDONED_AT_ATTEMPT.slice(0, -1),
          'frame peer:host-1 youtube-zero-start-capability',
          'ready',
        ]),
      ],
    ],
  ];

  it.each(FENCES)('G9 a fence ends the recovery: %s', async (_name, fence, ended) => {
    const lines = await record({
      scenario: cohortExcluded(60_000),
      steps: [step(3_000, fence)],
      windows: [[2_990, 3_300]],
    });
    expect(lines).toEqual(['2990 claims recovery owned hard-mute - -', ...ended]);
  });

  it('G10 a youtube:set-volume during the recovery retargets its release audio', async () => {
    const lines = await record({
      scenario: cohortExcluded(2_600),
      steps: [step(2_900, () => bus.emit('youtube:set-volume', 40))],
      windows: [[2_890, 3_300]],
    });
    expect(lines).toEqual([
      '2890 claims recovery owned hard-mute - -',
      // The volume write itself: the recovery holds the hard mute, so no unMute.
      '2900 #1 setVolume(40)',
      ...once(3_100, [...RELEASE(0, 40), `set ${EXTERNAL} 0`]),
      ...once(3_101, ACKNOWLEDGED('cohort-excluded')),
    ]);
  });

  it('G11 a first schedule that throws: logged, and both recovery flags end false', async () => {
    let failed = false;
    const lines = await record({
      scenario: cohortExcluded(60_000),
      steps: [
        step(2_390, () => {
          sink.failSet = (name, delayMs) => {
            if (failed || name !== EXTERNAL || delayMs !== 0) return false;
            failed = true;
            return true;
          };
        }),
      ],
      windows: [[2_390, 2_600]],
    });
    expect(lines).toEqual([
      '2390 claims - owned hard-mute in-flight protocol',
      ...once(2_401, [
        ...HAND_OFF('cohort-excluded'),
        'claims - - - - -',
        'log [YouTube ZeroStart] Local fallback failed: Error: synthetic managed-timer failure',
        'ready',
      ]),
    ]);
  });

  // The recovery's claim (recovery: active; owned: pending) holds while the
  // run's facades read false: the run has left its start (phase 'error').
  it.each([
    [
      'releasedBeforeStart',
      [
        '2400 claims - owned hard-mute in-flight protocol',
        '2401 claims - - - - -',
        '2401 claims recovery owned hard-mute - -',
        '3100 claims - owned - - -',
        '3101 claims - - - - -',
      ],
    ],
    [
      'abandonedUnready',
      [
        '2400 claims - owned - in-flight protocol',
        '2401 claims - - - - -',
        '2401 claims recovery owned hard-mute - -',
        '5300 claims recovery owned hard-mute - -',
        '6242 claims - - - - -',
      ],
    ],
  ] as const)(
    "G12 the run's facades read false whenever the recovery holds its claim (%s)",
    async (row, claims) => {
      const lines = await record(ROWS[row]);
      expect(lines.filter((line) => line.includes(' claims '))).toEqual(claims);
    },
  );

  // The run's own phase event at +2401 comes first, synchronously; the
  // recovery's comes after the change that caused it has returned, never
  // inside a recovery timer's callback, one per change of its pending claim.
  it.each([
    [
      'releasedBeforeStart',
      [
        '2400 claims - owned hard-mute in-flight protocol',
        '2401 claims - - - - -',
        '2401 ready',
        '2401 claims recovery owned hard-mute - -',
        '2401 ready',
        '3100 claims - owned - - -',
        '3101 claims - - - - -',
        '3101 ready',
      ],
    ],
    [
      'abandonedUnready',
      [
        '2400 claims - owned - in-flight protocol',
        '2401 claims - - - - -',
        '2401 ready',
        '2401 claims recovery owned hard-mute - -',
        '2401 ready',
        '5300 claims recovery owned hard-mute - -',
        '6242 claims - - - - -',
        '6242 ready',
      ],
    ],
  ] as const)(
    'G13 the readiness events: their number, instants and claims (%s)',
    async (row, events) => {
      const lines = await record(ROWS[row]);
      expect(lines.filter((line) => / (claims|ready)( |$)/u.test(line))).toEqual(events);
    },
  );
});

// ─── The host's legacy recovery ────────────────────────────────────

/** The run gives the host's start up: it pauses the iframe, leaves its claims and aborts the guest's run. */
const RUN_GIVES_UP = (logged: string) => [
  `log [YouTube ZeroStart] ${logged}`,
  '#1 pauseVideo()',
  'claims - - - - -',
  'loading false zero-start',
  'ready',
  'frame peer:guest-1 youtube-zero-start-abort',
  'ready',
];
/** The recovery takes the start: its own timer cleared, the recovery claim, the first attempt scheduled. */
const HOST_TAKES_OVER = [
  `clear ${HOST}`,
  'claims recovery owned hard-mute - -',
  `set ${HOST} 0`,
  'ready',
];
/** An iframe the recovery cannot adopt: hard-muted, reloaded at 0:00, then settled there. */
const HOST_RELOAD = [
  'autoplay false',
  '#1 mute()',
  '#1 loadVideoById(recoverGldA,0)',
  '#1 pauseVideo()',
  '#1 seekTo(0,true)',
  `set ${HOST} 50`,
];
/** The audio written, then checked. */
const HOST_RESTORE = (n = 1) => ['autoplay false', `#${n} setVolume(100)`, `#${n} unMute()`];
/**
 * invalidateYouTubeZeroStartPendingIntegration: the guest recovery's timer and
 * claim, the replacement fallback's timer, then the host recovery's own timer.
 */
const RECOVERIES_RETIRED = [
  `clear ${EXTERNAL}`,
  'claims - - - - -',
  `clear ${REPLACEMENT}`,
  `clear ${HOST}`,
];
/**
 * The hand-off, inside the attempt that found the audio restored:
 * scheduleYtAutoSync retires every recovery, this one too, and the run, plays
 * the iframe and sends Stage 1 (after the iframe's own PLAYING broadcast,
 * when the App hears that iframe), and arms Stage 2; the recovery logs after
 * it returns.
 */
const LEGACY_HAND_OFF = (reason: string, n = 1, ownPlayingBroadcast = true) => [
  ...RECOVERIES_RETIRED,
  'ready in-recovery-timer',
  `clear ${LEGACY_STAGE_2}`,
  'autoplay true',
  `#${n} playVideo()`,
  ...(ownPlayingBroadcast ? ['frame broadcast:* youtube-state state=1 time=0'] : []),
  'frame broadcast:* youtube-state state=1 time=0',
  `set ${LEGACY_STAGE_2} 4000`,
  `log [YouTube ZeroStart] Falling back to legacy rendezvous: ${reason}`,
  'ready',
];
/** cancelYtAutoSync: the legacy timer, every recovery, the three recovery timers again, the run. */
const CANCEL_YT_AUTO_SYNC = [
  `clear ${LEGACY_STAGE_2}`,
  ...RECOVERIES_RETIRED,
  `clear ${EXTERNAL}`,
  `clear ${HOST}`,
  `clear ${REPLACEMENT}`,
  'ready',
  'loading false -',
];

/**
 * The recovery's reload never reports a cueable target: UNSTARTED until it
 * lands, a minute later. The recovery polls from +431 until a row acts at +600.
 */
function stallReloads(fake: FakeYtPlayer): void {
  makeMediaCommandsSlow(fake, 60_000);
  const slowLoad = fake.loadVideoById;
  fake.loadVideoById = (videoId: string, startSeconds?: number) => {
    slowLoad(videoId, startSeconds);
    fake.__setState(-1, false);
  };
}

/** A host prepare failure at +430 whose recovery polls a stalled reload from +431. */
const STALLED_PREPARE_FAILURE: StandardScenario = {
  ...SCENARIOS.hostPrepareFailure,
  prepare: (current) => stallReloads(current.iframe()),
};
/** STALLED_PREPARE_FAILURE's lines from +580 to its action at +600. */
const STALLED_POLL = [
  '580 claims recovery owned hard-mute - -',
  ...once(581, ['autoplay false', `set ${HOST} 50`]),
];

describe('Standard host legacy zero-start recovery golden (pinned 2026-11-02)', () => {
  it('H1 a prepare failure (hard-mute-timeout): reloaded, settled, restored, handed off; Stage 1 at once, Stage 2 4 s later', async () => {
    const lines = await record({
      scenario: SCENARIOS.hostPrepareFailure,
      legacy: true,
      windows: [
        [420, 490],
        [4_470, 4_490],
      ],
    });
    expect(lines).toEqual([
      '420 claims - owned hard-mute in-flight protocol',
      ...once(430, [...RUN_GIVES_UP('hard-mute-timeout undefined'), ...HOST_TAKES_OVER]),
      ...once(431, HOST_RELOAD),
      ...once(481, [...HOST_RESTORE(), ...LEGACY_HAND_OFF('hard-mute-timeout')]),
      '4470 claims - - - - -',
      '4481 frame broadcast:* youtube-sync state=1 time=4 manual',
    ]);
  });

  it('H2 a COMMIT the host cannot send (commit-send-failed): the armed resident iframe is adopted without a reload', async () => {
    const lines = await record({
      scenario: SCENARIOS.hostAllReady,
      legacy: true,
      steps: [
        // From +700 the transport refuses the COMMIT; every other frame goes out.
        step(700, () => {
          const send = vi.mocked(safeSend).getMockImplementation()!;
          vi.mocked(safeSend).mockImplementation((conn, data) =>
            (data as { type?: unknown } | undefined)?.type === MSG.YOUTUBE_ZERO_START_COMMIT
              ? false
              : send(conn, data),
          );
        }),
      ],
      windows: [
        [715, 780],
        [4_765, 4_780],
      ],
    });
    expect(lines).toEqual([
      '715 claims - owned - in-flight protocol',
      '720 ready',
      // The guest's ARMED arrives at +722: the COMMIT is not delivered.
      ...once(722, ['ready', ...RUN_GIVES_UP('commit-send-failed undefined'), ...HOST_TAKES_OVER]),
      ...once(723, ['autoplay false', '#1 pauseVideo()', '#1 seekTo(0,true)', `set ${HOST} 50`]),
      ...once(773, [...HOST_RESTORE(), ...LEGACY_HAND_OFF('commit-send-failed')]),
      '4765 claims - - - - -',
      '4773 frame broadcast:* youtube-sync state=1 time=4 manual',
    ]);
  });

  it('H3 the guest connection replaced during the barrier: 1.5 s later the replacement fallback starts the recovery', async () => {
    const lines = await record({
      scenario: SCENARIOS.hostPeerReplaced,
      legacy: true,
      windows: [
        [395, 405],
        [1_895, 1_960],
        [5_945, 5_955],
      ],
    });
    expect(lines).toEqual([
      '395 claims - owned hard-mute in-flight protocol',
      // The run is cancelled (authority-changed) and restores the iframe's audio.
      ...once(400, [
        'frame peer:guest-1 youtube-zero-start-abort',
        '#1 pauseVideo()',
        'claims - - - - -',
        'loading false zero-start',
        'ready',
        '#1 setVolume(100)',
        '#1 unMute()',
        `set ${REPLACEMENT} 1500`,
      ]),
      '1895 claims - - - - -',
      ...once(1_900, [`clear ${REPLACEMENT}`, ...HOST_TAKES_OVER]),
      ...once(1_901, HOST_RELOAD),
      ...once(1_951, [...HOST_RESTORE(), ...LEGACY_HAND_OFF('peer-connection-replaced')]),
      '5945 claims - - - - -',
      '5951 frame broadcast:* youtube-sync state=1 time=4 manual',
    ]);
  });

  it('H3b the replaced guest reconnects: the replacement fallback starts the recovery at once', async () => {
    const lines = await record({
      scenario: SCENARIOS.hostPeerReplaced,
      legacy: true,
      steps: [step(600, (current) => bus.emit('network:peer-connected', current.conn))],
      windows: [
        [595, 660],
        [4_645, 4_655],
      ],
    });
    expect(lines).toEqual([
      '595 claims - - - - -',
      ...once(600, [
        // The late-join bootstrap of the reconnected guest, then the fallback.
        'frame peer:guest-1 youtube-play',
        'frame peer:guest-1 youtube-sync state=2 time=0.26',
        `set ${REPLACEMENT} 0`,
        `clear ${REPLACEMENT}`,
        ...HOST_TAKES_OVER,
      ]),
      ...once(601, HOST_RELOAD),
      ...once(651, [...HOST_RESTORE(), ...LEGACY_HAND_OFF('peer-connection-replaced')]),
      '4645 claims - - - - -',
      '4651 frame broadcast:* youtube-sync state=1 time=4 manual',
    ]);
  });

  it('H4 audio that never restores: the 3 s bridge ends, logged, the loading state ends, and the verified cleanup tries eight times, pausing and seeking each time', async () => {
    // The iframe ignores every unMute: the run's own restore times out at
    // +1560, and so does every check of the recovery that takes it over.
    const lines = await record({
      scenario: SCENARIOS.hostAllReady,
      rig: { iframeInit: { __unMuteIgnoreCount: 1_000 } },
      legacy: true,
      windows: [
        [1_555, 5_410],
        [5_995, 6_005],
      ],
    });
    expect(lines).toEqual([
      '1555 claims - owned - in-flight protocol',
      ...once(1_560, [
        ...RUN_GIVES_UP('audio-restore-timeout [object Object]'),
        ...HOST_TAKES_OVER,
      ]),
      // The resident target is adopted and settled, then polled every 50 ms.
      ...once(1_561, ['autoplay false', '#1 pauseVideo()', '#1 seekTo(0,true)', `set ${HOST} 50`]),
      ...every(1_611, 4_511, 50, [...HOST_RESTORE(), `set ${HOST} 50`]),
      // The bridge ended at +4560.
      ...once(4_561, [
        `clear ${HOST}`,
        'autoplay false',
        'log [YouTube ZeroStart] Legacy recovery timed out: audio-restore-timeout',
        'loading false zero-start',
      ]),
      ...every(4_561, 5_281, 120, [...CLEANUP, `set ${HOST} 120`]),
      ...once(5_401, [...CLEANUP, 'claims - - - - -', `clear ${HOST}`, 'ready']),
      // Today's end (start-ownership table row H4): the room hears paused at 0:00.
      '5995 claims - - - - -',
      '6000 frame broadcast:* youtube-sync state=2 time=0',
    ]);
  });

  it('H5 an iframe rebuilt mid-recovery: the previous one cleaned up once, the new one reloaded once', async () => {
    const lines = await record({
      scenario: STALLED_PREPARE_FAILURE,
      legacy: true,
      steps: [
        step(600, () => {
          const rebuilt = makeFakeYtPlayer({
            __videoId: IDENTITY.videoId,
            __state: 5,
            __duration: 240,
            __advanceClock: true,
            __autoPlayOnLoad: true,
          });
          tapIframe(rebuilt, 2);
          setYouTubePlayer(rebuilt as unknown as YouTubePlayerInstance);
          markYtPlayerReady(rebuilt as unknown as YouTubePlayerInstance);
        }),
      ],
      windows: [
        [430, 690],
        [4_675, 4_690],
      ],
    });
    expect(lines).toEqual([
      '430 claims recovery owned hard-mute - -',
      ...once(431, [
        'autoplay false',
        '#1 mute()',
        '#1 loadVideoById(recoverGldA,0)',
        `set ${HOST} 50`,
      ]),
      ...every(481, 581, 50, ['autoplay false', `set ${HOST} 50`]),
      ...once(631, [
        // The previous iframe: one cleanup, never verified.
        ...CLEANUP,
        // The rebuilt one: hard-muted, reloaded, settled.
        'autoplay false',
        '#2 mute()',
        '#2 loadVideoById(recoverGldA,0)',
        '#2 pauseVideo()',
        '#2 seekTo(0,true)',
        `set ${HOST} 50`,
      ]),
      // The App does not hear the rebuilt fake, so only Stage 1 goes out.
      ...once(681, [...HOST_RESTORE(2), ...LEGACY_HAND_OFF('hard-mute-timeout', 2, false)]),
      '4675 claims - - - - -',
      '4681 frame broadcast:* youtube-sync state=1 time=4 manual',
    ]);
  });

  it('H6 a resident reposition the run hands off (prepare-timeout): settled where it is, no reload', async () => {
    const lines = await record({
      scenario: {
        ...SCENARIOS.hostAllReady,
        // The warm-up play never reaches PLAYING, so the prepare budget ends.
        prepare: (current) => {
          const fake = current.iframe();
          fake.playVideo = () => {
            fake.__log.push({ op: 'playVideo', at: Date.now() });
          };
        },
      },
      legacy: true,
      windows: [
        [10_095, 10_160],
        [14_145, 14_155],
      ],
    });
    expect(lines).toEqual([
      '10095 claims - owned hard-mute in-flight protocol',
      ...once(10_100, [...RUN_GIVES_UP('prepare-timeout [object Object]'), ...HOST_TAKES_OVER]),
      ...once(10_101, ['autoplay false', '#1 pauseVideo()', '#1 seekTo(0,true)', `set ${HOST} 50`]),
      ...once(10_151, [...HOST_RESTORE(), ...LEGACY_HAND_OFF('prepare-timeout', 1, false)]),
      '14145 claims - - - - -',
      '14151 frame broadcast:* youtube-sync state=1 time=0 manual',
    ]);
  });

  const ENDS: ReadonlyArray<readonly [string, () => void, string[]]> = [
    [
      'a host seek starts the legacy rendezvous',
      () => bus.emit('youtube:seek-to', 42),
      once(600, [
        ...RECOVERIES_RETIRED,
        'ready',
        `clear ${LEGACY_STAGE_2}`,
        '#1 seekTo(42,true)',
        'autoplay true',
        '#1 playVideo()',
        'frame broadcast:* youtube-state state=1 time=42',
        'frame broadcast:* youtube-state state=1 time=42',
        `set ${LEGACY_STAGE_2} 2000`,
        'ready',
      ]),
    ],
    [
      'a local pause cancels it',
      () => bus.emit('youtube:set-local-paused', true),
      once(600, [
        ...CANCEL_YT_AUTO_SYNC,
        '#1 pauseVideo()',
        'frame broadcast:* youtube-state state=2 time=0',
        'ready',
      ]),
    ],
    [
      'its target stops being current',
      () => setState('playlist.currentQueueItemId', IDENTITY.nextQueueItemId),
      // The next attempt finds another queue item: no command.
      once(631, [`clear ${HOST}`, 'claims - - - - -', 'ready']),
    ],
  ];

  it.each(ENDS)('H7 the recovery ends when %s', async (_name, act, ended) => {
    const lines = await record({
      scenario: STALLED_PREPARE_FAILURE,
      legacy: true,
      steps: [step(600, act)],
      windows: [[580, 640]],
    });
    expect(lines).toEqual([...STALLED_POLL, ...ended]);
  });

  it('H8 a newer PREPARE retires the recovery, then its run takes the iframe', async () => {
    const lines = await record({
      scenario: STALLED_PREPARE_FAILURE,
      legacy: true,
      steps: [
        step(600, (current) => {
          current.iframe().__hardMuteFails = false;
          bus.emit('youtube:auto-play', {
            zeroStart: true,
            isTrackTransition: true,
            state: 1,
            targetTime: 0,
            videoId: IDENTITY.videoId,
          });
        }),
      ],
      windows: [[580, 640]],
    });
    expect(lines).toEqual([
      ...STALLED_POLL,
      ...once(600, [
        `clear ${LEGACY_STAGE_2}`,
        'autoplay true',
        'frame peer:guest-1 youtube-zero-start-prepare',
        // onPrepareSelection, in today's order.
        'loading false clock-action',
        `clear ${LEGACY_STAGE_2}`,
        ...RECOVERIES_RETIRED,
        'autoplay true',
        // The new run hard-mutes and warms the same iframe; no recovery attempt follows.
        'claims - owned hard-mute in-flight protocol',
        'loading true zero-start',
        'ready',
        '#1 mute()',
        'ready',
        '#1 setVolume(100)',
        '#1 mute()',
        'ready',
        '#1 playVideo()',
      ]),
    ]);
  });

  it('H9 a teardown transfers the iframe: the recovery ends with no command of its own', async () => {
    const lines = await record({
      scenario: STALLED_PREPARE_FAILURE,
      legacy: true,
      steps: [step(600, () => stopYouTubeMode())],
      windows: [[580, 640]],
    });
    expect(lines).toEqual([
      ...STALLED_POLL,
      ...once(600, [
        ...CANCEL_YT_AUTO_SYNC,
        'autoplay false',
        'loading false clock-action',
        'loading false -',
        // The teardown's own commands.
        '#1 mute()',
        '#1 pauseVideo()',
        '#1 stopVideo()',
        '#1 destroy()',
        'frame broadcast:* youtube-stop',
        'ready',
      ]),
    ]);
  });
});
