/**
 * The zero-start recovery classes on their own: the guest's (Phase 6 6D-1,
 * plan step C2-9; registry RO-33) and the host's legacy recovery (Phase 6
 * 6D-2, plan step C2-11; RO-02). Their timer, claim setters, fences, iframe
 * getter, audio capture, target resolvers and the host's hand-off are this
 * suite's fakes, the iframe is the fake player, and the clock is fake time.
 * The real wiring in player.ts is pinned by zero-start-recovery-golden.test.ts.
 * Rows that call a callback the fake schedule took before the recovery moved
 * on (as a timer that escaped its clear would run) pin each recovery's own
 * token.
 *
 * Each row writes one ordered trace, at milliseconds since the start:
 * 'set <ms>' and 'cancel' (the guest's one timer; the host's clears are
 * 'clear'), 'owned <bool>' and 'retained <bool>' (the claim's setters),
 * 'autoplay <bool>' (setYtAutoplayIntent), '#<n> <op>(<args>)' (an iframe
 * command), 'log <message>' (a warning), and for the host 'hand-off <video>'
 * (the legacy rendezvous it hands the start to) and 'loading <busy> <owner>'
 * (a youtube:sync-loading event).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import {
  STANDARD_ZERO_START_GUEST_DECISION_MS,
  STANDARD_ZERO_START_PREPARE_BUDGET_MS,
  YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS,
  YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS,
  YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS,
  YOUTUBE_RECOVERY_BRIDGE_MS,
  YOUTUBE_RECOVERY_POLL_MS,
  YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC,
} from '../constants.ts';
import {
  GuestZeroStartRecovery,
  HostZeroStartRecovery,
  type HostRecoveryTarget,
} from '../zero-start-recovery.ts';
import type { YouTubeZeroStartFallbackEvent, YouTubeZeroStartPlayer } from '../zero-start.ts';
import { makeFakeYtPlayer, type FakeYtPlayer } from './__helpers__/fake-yt-player.ts';

const trace = vi.hoisted(() => ({ lines: [] as string[], origin: 0, calibrated: true }));
const write = vi.hoisted(() => (text: string) => {
  trace.lines.push(`+${Date.now() - trace.origin} ${text}`);
});

vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn((message: string, ...details: unknown[]) => {
      write(['log', message.replace('[YouTube ZeroStart] ', ''), ...details.map(String)].join(' '));
    }),
  },
}));
vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: () => Date.now(),
  isClockCalibrated: () => trace.calibrated,
}));
vi.mock('../_state.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_state.ts')>()),
  setYtAutoplayIntent: (autoplay: boolean) => write(`autoplay ${autoplay}`),
}));

const VIDEO = 'unitRecovA1';
const ADOPTED_WINDOW_MS =
  STANDARD_ZERO_START_PREPARE_BUDGET_MS - STANDARD_ZERO_START_GUEST_DECISION_MS;

interface Rig {
  readonly recovery: GuestZeroStartRecovery;
  readonly flags: { owned: boolean; retained: boolean };
  /** The fence's answer. */
  current: boolean;
  /** The current iframe. */
  player: FakeYtPlayer | null;
  /** Make the caller's schedule throw from now on. */
  scheduleThrows: boolean;
  /** The last callback the schedule took. */
  scheduled: (() => void) | null;
}

function newRig(): Rig {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const rig: Rig = {
    flags: { owned: false, retained: false },
    current: true,
    player: null,
    scheduleThrows: false,
    scheduled: null,
    recovery: new GuestZeroStartRecovery(
      (callback, delayMs) => {
        write(`set ${delayMs}`);
        if (rig.scheduleThrows) throw new Error('synthetic schedule failure');
        rig.scheduled = callback;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          pending = null;
          callback();
        }, delayMs);
      },
      () => {
        write('cancel');
        if (pending) clearTimeout(pending);
        pending = null;
      },
      (owned) => {
        rig.flags.owned = owned;
        write(`owned ${owned}`);
      },
      (retained) => {
        rig.flags.retained = retained;
        write(`retained ${retained}`);
      },
      () => rig.flags.retained,
    ),
  };
  return rig;
}

/** A fake iframe whose commands are written as '#<n> <op>(<args>)'. */
function iframe(n: number, init: Partial<FakeYtPlayer>): FakeYtPlayer {
  const fake = makeFakeYtPlayer({ __videoId: VIDEO, __state: 2, __volume: 80, ...init });
  const calls = fake.__log;
  const push = calls.push.bind(calls);
  calls.push = (...entries) => {
    for (const { op, args } of entries) write(`#${n} ${op}(${(args ?? []).join(',')})`);
    return push(...entries);
  };
  return fake;
}

function fallbackEvent(
  handedOffPlayer: FakeYtPlayer | null,
  overrides: Partial<YouTubeZeroStartFallbackEvent> = {},
): YouTubeZeroStartFallbackEvent {
  return {
    runId: 'unit-run-1',
    queueItemId: '77000000-0000-4000-8000-000000000001',
    videoId: VIDEO,
    mediaAction: 'replace-media',
    reason: 'cohort-excluded',
    startAtHost: Date.now() + 700,
    targetPositionSec: 0,
    desiredMuted: false,
    desiredVolume: 80,
    targetLoadIssued: true,
    handedOffPlayer: handedOffPlayer as YouTubeZeroStartPlayer | null,
    ...overrides,
  };
}

interface StartOptions {
  readonly audibleLeadMs?: number;
  /** The local start delay resolveDelay answers. */
  readonly delayMs?: number;
  /** The local offset resolveTarget adds. */
  readonly offsetSec?: number;
  readonly audio?: { muted: boolean; volume: number };
}

function start(rig: Rig, event: YouTubeZeroStartFallbackEvent, options: StartOptions = {}): void {
  rig.recovery.start(
    event,
    () => rig.current,
    options.audibleLeadMs ?? 0,
    (handed) =>
      options.audio ?? { muted: handed.desiredMuted ?? false, volume: handed.desiredVolume ?? 100 },
    () => rig.player as YouTubeZeroStartPlayer | null,
    (canonicalPositionSec) => Math.max(0, canonicalPositionSec + (options.offsetSec ?? 0)),
    () => options.delayMs ?? 0,
  );
}

/**
 * A recovery whose target never comes, abandoned when its 3 s window ends
 * and left in its verified cleanup, whose retries run on because the iframe
 * ignores every unmute. Returns the rig and the attempt the schedule held
 * before the abandon.
 */
function stuckRecovery(): { rig: Rig; attempt: (() => void) | null } {
  const rig = newRig();
  const player = iframe(1, {
    __videoId: 'unitRecovB2',
    __state: 1,
    __muted: true,
    __unMuteIgnoreCount: 1_000,
  });
  player.loadVideoById = (videoId: string, startSeconds?: number) => {
    player.__log.push({ op: 'loadVideoById', args: [videoId, startSeconds], at: Date.now() });
  };
  rig.player = player;
  start(rig, fallbackEvent(player, { reason: 'clock-uncalibrated' }));
  vi.advanceTimersByTime(60);
  const attempt = rig.scheduled;
  vi.advanceTimersByTime(YOUTUBE_RECOVERY_BRIDGE_MS);
  return { rig, attempt };
}

/** `lines` at each instant from `from` to `to` (inclusive), `step` ms apart. */
function every(from: number, to: number, step: number, lines: readonly string[]): string[] {
  const out: string[] = [];
  for (let instant = from; instant <= to; instant += step) {
    out.push(...lines.map((line) => `+${instant} ${line}`));
  }
  return out;
}

function once(instant: number, lines: readonly string[]): string[] {
  return every(instant, instant, 1, lines);
}

const POLL = `set ${YOUTUBE_RECOVERY_POLL_MS}`;
const NOT_READY = ['owned true', 'autoplay false', POLL];
const CLEANUP = (n = 1, volume = 80) => [
  'autoplay false',
  `#${n} pauseVideo()`,
  `#${n} seekTo(0,true)`,
  `#${n} setVolume(${volume})`,
  `#${n} unMute()`,
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 2, 0, 0, 0));
  trace.lines = [];
  trace.origin = Date.now();
  trace.calibrated = true;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('GuestZeroStartRecovery', () => {
  it("takes the start at once and makes its first attempt through the caller's schedule", () => {
    const rig = newRig();
    start(rig, fallbackEvent(null));
    expect(trace.lines).toEqual([
      '+0 log Falling back locally: cohort-excluded',
      '+0 owned true',
      '+0 set 0',
    ]);
  });

  it('ends owning nothing when the first schedule throws, and logs it', () => {
    const rig = newRig();
    rig.scheduleThrows = true;
    start(rig, fallbackEvent(null));
    expect(trace.lines).toEqual([
      '+0 log Falling back locally: cohort-excluded',
      '+0 owned true',
      '+0 set 0',
      '+0 owned false',
      '+0 log Local fallback failed: Error: synthetic schedule failure',
    ]);
    expect(rig.flags).toEqual({ owned: false, retained: false });
  });

  it('adopts the issued load, settles it, holds it until startAtHost, restores the audio and releases; a PLAYING ends it', () => {
    const rig = newRig();
    rig.player = iframe(1, { __videoId: 'unitRecovB2', __state: 5, __muted: true });
    start(rig, fallbackEvent(rig.player));
    // The load reports its target at +120.
    vi.advanceTimersByTime(120);
    rig.player.__videoId = VIDEO;
    rig.player.__setState(1);
    vi.advanceTimersByTime(1_000);
    expect(trace.lines).toEqual([
      '+0 log Falling back locally: cohort-excluded',
      '+0 owned true',
      '+0 set 0',
      '+0 retained true',
      ...every(0, 100, YOUTUBE_RECOVERY_POLL_MS, NOT_READY),
      ...once(150, ['owned true', 'autoplay false', '#1 pauseVideo()', '#1 seekTo(0,true)', POLL]),
      ...once(200, [
        'owned true',
        'autoplay false',
        '#1 mute()',
        '#1 pauseVideo()',
        '#1 seekTo(0,true)',
        'set 500',
      ]),
      ...once(700, [
        'owned true',
        'autoplay false',
        '#1 setVolume(80)',
        '#1 unMute()',
        '#1 pauseVideo()',
        '#1 seekTo(0,true)',
        '#1 setVolume(80)',
        '#1 unMute()',
        'autoplay true',
        'owned false',
        '#1 playVideo()',
        'set 0',
      ]),
      // A zero-delay wait scheduled inside a timer runs one millisecond later.
      ...once(701, ['cancel', 'retained false', 'log Recovered locally: cohort-excluded']),
    ]);
    expect(rig.flags).toEqual({ owned: false, retained: false });
  });

  it.each([
    ['a cohort-excluded guest whose load is issued', {}, ADOPTED_WINDOW_MS],
    [
      'a cohort-excluded guest with no load to adopt',
      { targetLoadIssued: false, handedOffPlayer: null },
      YOUTUBE_RECOVERY_BRIDGE_MS,
    ],
    [
      'a resident iframe the guest repositions',
      { targetLoadIssued: false, mediaAction: 'resident-reposition' as const },
      ADOPTED_WINDOW_MS,
    ],
    [
      'an uncalibrated guest',
      { reason: 'clock-uncalibrated' as const },
      YOUTUBE_RECOVERY_BRIDGE_MS,
    ],
  ])('gives %s its window: the attempt at its end abandons', (_case, overrides, windowMs) => {
    const rig = newRig();
    // Never the target: another video, playing, whose loads never complete.
    const player = iframe(1, { __videoId: 'unitRecovB2', __state: 1 });
    player.loadVideoById = (videoId: string, startSeconds?: number) => {
      player.__log.push({ op: 'loadVideoById', args: [videoId, startSeconds], at: Date.now() });
    };
    rig.player = player;
    start(rig, fallbackEvent(player, overrides));
    vi.advanceTimersByTime(windowMs - 1);
    const before = trace.lines.length;
    expect(trace.lines.at(-1)).toBe(`+${windowMs - YOUTUBE_RECOVERY_POLL_MS} ${POLL}`);
    vi.advanceTimersByTime(1);
    // The attempt at the window's end abandons with the verified cleanup,
    // which this iframe confirms at once.
    expect(trace.lines.slice(before)).toEqual(
      once(windowMs, [
        'owned true',
        'autoplay false',
        'cancel',
        'autoplay false',
        'retained false',
        'owned true',
        ...CLEANUP(),
        'owned false',
        'cancel',
      ]),
    );
  });

  it.each([
    [YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC, true],
    [YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC + 0.001, false],
  ])('a paused iframe %s s from the local zero is the target: %s', (positionSec, ready) => {
    const rig = newRig();
    rig.player = iframe(1, { __currentTime: positionSec });
    start(rig, fallbackEvent(rig.player));
    vi.advanceTimersByTime(0);
    expect(trace.lines.slice(3)).toEqual([
      '+0 retained true',
      '+0 owned true',
      '+0 autoplay false',
      ...(ready ? ['+0 #1 pauseVideo()', '+0 #1 seekTo(0,true)'] : []),
      `+0 ${POLL}`,
    ]);
  });

  it.each([
    [2.25, true],
    [2.45, false],
  ])(
    'measures that tolerance from the local zero: at %s s with the zero at 2 s, the target: %s',
    (positionSec, ready) => {
      const rig = newRig();
      rig.player = iframe(1, { __currentTime: positionSec });
      // A local offset of +2 s puts the local zero at 2 s.
      start(rig, fallbackEvent(rig.player), { offsetSec: 2 });
      vi.advanceTimersByTime(0);
      expect(trace.lines.slice(3)).toEqual([
        '+0 retained true',
        '+0 owned true',
        '+0 autoplay false',
        ...(ready ? ['+0 #1 pauseVideo()', '+0 #1 seekTo(2,true)'] : []),
        `+0 ${POLL}`,
      ]);
    },
  );

  it('pauses and seeks again at each attempt while a seek lands past the tolerance', () => {
    const rig = newRig();
    const player = iframe(1, { __state: 2 });
    rig.player = player;
    const seek = player.seekTo;
    let landing = YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC + 0.001;
    player.seekTo = (seconds: number, allowAhead?: boolean) => {
      seek(seconds, allowAhead);
      player.__currentTime = seconds + landing;
    };
    start(rig, fallbackEvent(player, { mediaAction: 'resident-reposition' }));
    vi.advanceTimersByTime(60);
    landing = 0;
    vi.advanceTimersByTime(60);
    expect(trace.lines.filter((line) => /#1 (pause|seek)|set/u.test(line))).toEqual([
      '+0 set 0',
      '+0 #1 pauseVideo()',
      '+0 #1 seekTo(0,true)',
      `+0 ${POLL}`,
      '+50 #1 pauseVideo()',
      '+50 #1 seekTo(0,true)',
      `+50 ${POLL}`,
      '+100 #1 pauseVideo()',
      '+100 #1 seekTo(0,true)',
      `+100 ${POLL}`,
    ]);
  });

  // Pinned as today's behaviour, not claimed right, like the host's row: the
  // settled check's own pause and seek never run for a target the run did not
  // leave resident, because the identity check before it uses the same
  // tolerance. The recovery polls to the end of its window, then gives up
  // with the verified cleanup, which leaves the iframe paused at the local
  // zero with the audio restored, and writes no log line.
  it.each([
    ['a cohort-excluded guest whose load is issued', 'cohort-excluded' as const, ADOPTED_WINDOW_MS],
    ['an uncalibrated guest', 'clock-uncalibrated' as const, YOUTUBE_RECOVERY_BRIDGE_MS],
  ])(
    'waits out the window of %s without seeking again when a settle lands a loaded target past the tolerance',
    (_case, reason, windowMs) => {
      const rig = newRig();
      const player = iframe(1, { __state: 1 });
      rig.player = player;
      const seek = player.seekTo;
      player.seekTo = (seconds: number, allowAhead?: boolean) => {
        seek(seconds, allowAhead);
        player.__currentTime = seconds + YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC + 0.001;
      };
      start(rig, fallbackEvent(player, { reason }));
      vi.advanceTimersByTime(windowMs + 500);
      expect(trace.lines.slice(3)).toEqual([
        '+0 retained true',
        ...once(0, ['owned true', 'autoplay false', '#1 pauseVideo()', '#1 seekTo(0,true)', POLL]),
        ...every(50, windowMs - 50, YOUTUBE_RECOVERY_POLL_MS, NOT_READY),
        ...once(windowMs, [
          'owned true',
          'autoplay false',
          'cancel',
          'autoplay false',
          'retained false',
          'owned true',
          ...CLEANUP(),
          'owned false',
          'cancel',
        ]),
      ]);
      expect(rig.flags).toEqual({ owned: false, retained: false });
    },
  );

  it('abandons with the verified cleanup when its target never settles by the end of its window', () => {
    const rig = newRig();
    const player = iframe(1, {});
    rig.player = player;
    // Every seek lands half a second past its target.
    const seek = player.seekTo;
    player.seekTo = (seconds: number, allowAhead?: boolean) => {
      seek(seconds, allowAhead);
      player.__currentTime = seconds + 0.5;
    };
    start(
      rig,
      fallbackEvent(player, { reason: 'clock-uncalibrated', mediaAction: 'resident-reposition' }),
    );
    vi.advanceTimersByTime(YOUTUBE_RECOVERY_BRIDGE_MS - 1);
    expect(trace.lines.slice(-3)).toEqual([
      `+${YOUTUBE_RECOVERY_BRIDGE_MS - 50} #1 pauseVideo()`,
      `+${YOUTUBE_RECOVERY_BRIDGE_MS - 50} #1 seekTo(0,true)`,
      `+${YOUTUBE_RECOVERY_BRIDGE_MS - 50} ${POLL}`,
    ]);
    const before = trace.lines.length;
    vi.advanceTimersByTime(200);
    expect(trace.lines.slice(before)).toEqual(
      once(YOUTUBE_RECOVERY_BRIDGE_MS, [
        'owned true',
        'autoplay false',
        'cancel',
        'autoplay false',
        'retained false',
        'owned true',
        ...CLEANUP(),
        'owned false',
        'cancel',
      ]),
    );
  });

  it('polls again after an iframe read throws, and at the end of its window logs it and abandons', () => {
    const rig = newRig();
    const player = iframe(1, {});
    rig.player = player;
    player.getPlayerState = () => {
      throw new Error('synthetic state read failure');
    };
    start(rig, fallbackEvent(player, { reason: 'clock-uncalibrated' }));
    vi.advanceTimersByTime(YOUTUBE_RECOVERY_BRIDGE_MS + 200);
    expect(trace.lines.slice(3)).toEqual([
      '+0 retained true',
      ...every(0, YOUTUBE_RECOVERY_BRIDGE_MS - 50, YOUTUBE_RECOVERY_POLL_MS, NOT_READY),
      ...once(YOUTUBE_RECOVERY_BRIDGE_MS, [
        'owned true',
        'autoplay false',
        'log Local fallback failed: Error: synthetic state read failure',
        'cancel',
        'autoplay false',
        'retained false',
        'owned true',
        ...CLEANUP(),
        'owned false',
        'cancel',
      ]),
    ]);
  });

  it('abandons with one unverified cleanup of the held iframe when the fence fails', () => {
    const rig = newRig();
    rig.player = iframe(1, { __videoId: 'unitRecovB2', __state: 1 });
    start(rig, fallbackEvent(rig.player));
    vi.advanceTimersByTime(60);
    rig.current = false;
    const before = trace.lines.length;
    vi.advanceTimersByTime(50);
    expect(trace.lines.slice(before)).toEqual([
      '+100 cancel',
      '+100 autoplay false',
      '+100 retained false',
      '+100 owned false',
      '+100 autoplay false',
      ...once(100, CLEANUP()),
    ]);
    const after = trace.lines.length;
    vi.advanceTimersByTime(1_000);
    expect(trace.lines).toHaveLength(after);
  });

  it('clear() ends it: the next attempt is stale, and the held iframe gets its cleanup', () => {
    const rig = newRig();
    rig.player = iframe(1, { __videoId: 'unitRecovB2', __state: 1 });
    start(rig, fallbackEvent(rig.player));
    vi.advanceTimersByTime(10);
    const before = trace.lines.length;
    expect(rig.recovery.clear()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(trace.lines.slice(before)).toEqual([
      '+10 cancel',
      '+10 owned false',
      '+10 retained false',
      '+10 autoplay false',
      ...once(10, CLEANUP()),
    ]);
  });

  it('clear(true) transfers the held iframe as it is, and says the recovery held its player state', () => {
    const rig = newRig();
    rig.player = iframe(1, { __videoId: 'unitRecovB2', __state: 1 });
    start(rig, fallbackEvent(rig.player));
    vi.advanceTimersByTime(10);
    const before = trace.lines.length;
    expect(rig.recovery.clear(true)).toBe(true);
    expect(rig.recovery.clear(true)).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(trace.lines.slice(before)).toEqual([
      '+10 cancel',
      '+10 owned false',
      '+10 retained false',
      '+10 cancel',
      '+10 owned false',
      '+10 retained false',
    ]);
  });

  // The guest token: each row calls a callback the caller's schedule took
  // before the recovery moved on, as a timer that escaped its clear would.
  it('clear() revokes it: an attempt that escaped it does nothing', () => {
    const rig = newRig();
    rig.player = iframe(1, { __videoId: 'unitRecovB2', __state: 1 });
    start(rig, fallbackEvent(rig.player));
    vi.advanceTimersByTime(10);
    const escaped = rig.scheduled;
    rig.recovery.clear();
    const before = trace.lines.length;
    escaped?.();
    vi.advanceTimersByTime(1_000);
    expect(trace.lines.slice(before)).toEqual([]);
  });

  it('an abandoned recovery: an attempt that escaped it does nothing while its cleanup runs', () => {
    const { attempt } = stuckRecovery();
    const before = trace.lines.length;
    attempt?.();
    expect(trace.lines.slice(before)).toEqual([]);
  });

  it('clear() during the verified cleanup: a retry that escaped it does nothing', () => {
    const { rig } = stuckRecovery();
    const escaped = rig.scheduled;
    rig.recovery.clear();
    const before = trace.lines.length;
    escaped?.();
    vi.advanceTimersByTime(2_000);
    expect(trace.lines.slice(before)).toEqual([]);
  });

  it('an acknowledged release: an attempt that escaped it does nothing', () => {
    const rig = newRig();
    rig.player = iframe(1, { __videoId: 'unitRecovB2', __state: 5, __muted: true });
    start(rig, fallbackEvent(rig.player));
    // The load reports its target at +120, as in the row that adopts it.
    vi.advanceTimersByTime(120);
    rig.player.__videoId = VIDEO;
    rig.player.__setState(1);
    vi.advanceTimersByTime(1_000);
    expect(trace.lines.at(-1)).toBe('+701 log Recovered locally: cohort-excluded');
    const before = trace.lines.length;
    rig.scheduled?.();
    expect(trace.lines.slice(before)).toEqual([]);
  });

  it('a rebuilt iframe: the previous one gets its cleanup, the new one its own hard-muted load', () => {
    const rig = newRig();
    rig.player = iframe(1, { __videoId: 'unitRecovB2', __state: 1 });
    start(rig, fallbackEvent(rig.player));
    vi.advanceTimersByTime(10);
    rig.player = iframe(2, { __videoId: 'unitRecovB2', __state: 5, __autoPlayOnLoad: true });
    const before = trace.lines.length;
    vi.advanceTimersByTime(50);
    expect(trace.lines.slice(before)).toEqual([
      ...once(50, CLEANUP(1)),
      '+50 retained true',
      '+50 owned true',
      '+50 autoplay false',
      `+50 #2 mute()`,
      `+50 #2 loadVideoById(${VIDEO},0)`,
      '+50 #2 pauseVideo()',
      '+50 #2 seekTo(0,true)',
      `+50 ${POLL}`,
    ]);
  });

  it('without an iframe, polls to the end of its window, then restores the handed-off one', () => {
    const rig = newRig();
    const handedOff = iframe(1, { __muted: true, __unMuteIgnoreCount: 1 });
    start(rig, fallbackEvent(handedOff, { reason: 'clock-uncalibrated' }));
    vi.advanceTimersByTime(YOUTUBE_RECOVERY_BRIDGE_MS + 200);
    expect(trace.lines.slice(3)).toEqual([
      ...every(0, YOUTUBE_RECOVERY_BRIDGE_MS - YOUTUBE_RECOVERY_POLL_MS, YOUTUBE_RECOVERY_POLL_MS, [
        POLL,
      ]),
      ...once(YOUTUBE_RECOVERY_BRIDGE_MS, [
        'cancel',
        'autoplay false',
        'retained false',
        'owned true',
        ...CLEANUP(),
        'set 120',
      ]),
      ...once(YOUTUBE_RECOVERY_BRIDGE_MS + 120, [...CLEANUP(), 'owned false', 'cancel']),
    ]);
  });

  it('polls the restore before its release until the iframe reports the audio', () => {
    const rig = newRig();
    rig.player = iframe(1, { __muted: true });
    start(rig, fallbackEvent(rig.player, { startAtHost: Date.now() + 100 }));
    vi.advanceTimersByTime(60);
    rig.player.__unMuteIgnoreCount = 2;
    const before = trace.lines.length;
    vi.advanceTimersByTime(300);
    expect(trace.lines.slice(before).filter((line) => /unMute|set |playVideo/u.test(line))).toEqual(
      [
        '+100 #1 unMute()',
        `+100 ${POLL}`,
        '+150 #1 unMute()',
        `+150 ${POLL}`,
        '+200 #1 unMute()',
        '+200 #1 unMute()',
        '+200 #1 playVideo()',
        '+200 set 0',
      ],
    );
  });

  it('ends the restore before a late release at max(deadline, now + 1 s), then the verified cleanup', () => {
    const rig = newRig();
    rig.player = iframe(1, { __muted: true });
    // A -9 s hold releases at +9700, past the adopted window (+7700), so the
    // restore ends at +10700; the verified cleanup then tries eight times.
    start(rig, fallbackEvent(rig.player), { delayMs: 9_000 });
    vi.advanceTimersByTime(9_000);
    rig.player.__unMuteIgnoreCount = 1_000;
    const before = trace.lines.length;
    vi.advanceTimersByTime(3_000);
    expect(
      trace.lines.slice(before).filter((line) => /unMute|cancel|playVideo/u.test(line)),
    ).toEqual([
      ...every(9_700, 10_700, YOUTUBE_RECOVERY_POLL_MS, ['#1 unMute()']),
      '+10700 cancel',
      ...every(10_700, 11_540, 120, ['#1 unMute()']),
      '+11540 cancel',
    ]);
  });

  it('an uncalibrated recovery holds for the local delay less the audible lead, then releases at that position', () => {
    trace.calibrated = false;
    const rig = newRig();
    rig.player = iframe(1, {});
    start(
      rig,
      fallbackEvent(rig.player, {
        reason: 'clock-uncalibrated',
        startAtHost: null,
        targetPositionSec: null,
        mediaAction: 'resident-reposition',
      }),
      { delayMs: 400, audibleLeadMs: 100 },
    );
    vi.advanceTimersByTime(400);
    expect(trace.lines.filter((line) => /seekTo|playVideo|set [1-9]/u.test(line))).toEqual([
      '+0 #1 seekTo(0,true)',
      `+0 ${POLL}`,
      '+50 #1 seekTo(0,true)',
      '+50 set 250',
      '+300 #1 seekTo(0.4,true)',
      '+300 #1 playVideo()',
    ]);
  });

  it(`abandons a release the iframe never acknowledges after ${YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS} ms, then the verified cleanup`, () => {
    const rig = newRig();
    const player = iframe(1, {});
    rig.player = player;
    player.playVideo = () => {
      player.__log.push({ op: 'playVideo', at: Date.now() });
      player.__setState(3);
    };
    start(rig, fallbackEvent(player, { mediaAction: 'resident-reposition' }));
    vi.advanceTimersByTime(700 + YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS + 100);
    const ackStart = trace.lines.indexOf('+700 #1 playVideo()');
    expect(ackStart).toBeGreaterThan(0);
    expect(trace.lines.slice(ackStart, ackStart + 4)).toEqual([
      '+700 #1 playVideo()',
      '+700 set 0',
      '+701 owned false',
      '+701 autoplay true',
    ]);
    expect(trace.lines).toContain(
      `+${700 + YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS + 1} log Local fallback release was not acknowledged`,
    );
    expect(rig.flags).toEqual({ owned: false, retained: false });
  });

  it('logs a release playVideo() that throws and abandons with the verified cleanup', () => {
    const rig = newRig();
    const player = iframe(1, {});
    rig.player = player;
    player.playVideo = () => {
      player.__log.push({ op: 'playVideo', at: Date.now() });
      throw new Error('synthetic playVideo failure');
    };
    start(rig, fallbackEvent(player, { mediaAction: 'resident-reposition' }));
    vi.advanceTimersByTime(1_000);
    const thrown = trace.lines.indexOf('+700 #1 playVideo()');
    expect(trace.lines.slice(thrown, thrown + 8)).toEqual([
      '+700 #1 playVideo()',
      '+700 owned true',
      '+700 autoplay false',
      '+700 log Local fallback release failed: Error: synthetic playVideo failure',
      '+700 cancel',
      '+700 autoplay false',
      '+700 retained false',
      '+700 owned true',
    ]);
    expect(rig.flags).toEqual({ owned: false, retained: false });
  });

  it('writes the captured audio as the caller retargets it', () => {
    const rig = newRig();
    rig.player = iframe(1, { __muted: true });
    const audio = { muted: false, volume: 80 };
    start(rig, fallbackEvent(rig.player, { mediaAction: 'resident-reposition' }), { audio });
    vi.advanceTimersByTime(300);
    audio.volume = 35;
    vi.advanceTimersByTime(500);
    expect(trace.lines.filter((line) => line.includes('setVolume'))).toEqual([
      '+700 #1 setVolume(35)',
      '+700 #1 setVolume(35)',
    ]);
  });
});

interface HostRig {
  readonly recovery: HostZeroStartRecovery;
  /** The claim's active flag, as the setter last wrote it. */
  owned: boolean;
  /** The fence's answer. */
  current: boolean;
  /** The current iframe. */
  player: FakeYtPlayer | null;
  /** The audio the capture answers; the row may retarget it. */
  audio: { muted: boolean; volume: number } | null;
  /** Runs inside the hand-off, after its trace line (the legacy rendezvous retires the recovery). */
  onHandOff: (() => void) | null;
  /** The last callback the schedule took. */
  scheduled: (() => void) | null;
  /** The targets the fence, the capture and the hand-off were given. */
  readonly seen: HostRecoveryTarget[];
}

function newHostRig(): HostRig {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const rig: HostRig = {
    owned: false,
    current: true,
    player: null,
    audio: null,
    onHandOff: null,
    scheduled: null,
    seen: [],
    recovery: new HostZeroStartRecovery(
      (callback, delayMs) => {
        write(`set ${delayMs}`);
        rig.scheduled = callback;
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => {
          pending = null;
          callback();
        }, delayMs);
      },
      () => {
        write('clear');
        if (pending) clearTimeout(pending);
        pending = null;
      },
      (owned) => {
        rig.owned = owned;
        write(`owned ${owned}`);
      },
      (target) => {
        rig.seen.push(target);
        return rig.current;
      },
      () => rig.player as YouTubeZeroStartPlayer | null,
      (target) => {
        rig.seen.push(target);
        return (
          rig.audio ?? { muted: target.desiredMuted ?? false, volume: target.desiredVolume ?? 100 }
        );
      },
      (target) => {
        rig.seen.push(target);
        write(`hand-off ${target.videoId}`);
        rig.onHandOff?.();
      },
    ),
  };
  return rig;
}

function hostTarget(
  handedOffPlayer: FakeYtPlayer | null,
  overrides: Partial<HostRecoveryTarget> = {},
): HostRecoveryTarget {
  return {
    queueItemId: '77000000-0000-4000-8000-000000000002',
    videoId: VIDEO,
    subIndex: null,
    mediaAction: 'replace-media',
    desiredMuted: false,
    desiredVolume: 80,
    targetLoadIssued: false,
    handedOffPlayer: handedOffPlayer as YouTubeZeroStartPlayer | null,
    ...overrides,
  };
}

/** A fake iframe whose loads never complete: it keeps another video, playing. */
function neverTarget(n: number): FakeYtPlayer {
  const player = iframe(n, { __videoId: 'unitRecovB2', __state: 1 });
  player.loadVideoById = (videoId: string, startSeconds?: number) => {
    player.__log.push({ op: 'loadVideoById', args: [videoId, startSeconds], at: Date.now() });
  };
  return player;
}

const HOST_TAKES_OVER = ['+0 clear', '+0 owned true', '+0 set 0'];
/** An attempt that holds the iframe's events and the autoplay guard. */
const HOST_ATTEMPT = ['owned true', 'autoplay false'];
const HOST_SETTLE = [...HOST_ATTEMPT, '#1 pauseVideo()', '#1 seekTo(0,true)', POLL];

describe('HostZeroStartRecovery', () => {
  beforeEach(() => {
    bus.on('youtube:sync-loading', (busy: boolean, owner?: string) => {
      write(`loading ${busy} ${owner ?? '-'}`);
    });
  });

  afterEach(() => {
    bus.clear();
  });

  it('takes the start at once: its own timer cleared, the claim owned, the first attempt scheduled', () => {
    const rig = newHostRig();
    rig.recovery.start(hostTarget(null), 'hard-mute-timeout');
    expect(trace.lines).toEqual(HOST_TAKES_OVER);
    expect(rig.owned).toBe(true);
  });

  it('reloads an iframe it cannot adopt hard-muted at 0:00, settles it, restores the audio and hands the start off, then logs', () => {
    const rig = newHostRig();
    rig.player = iframe(1, { __videoId: 'unitRecovB2', __state: 2 });
    const target = hostTarget(null);
    rig.recovery.start(target, 'hard-mute-timeout');
    vi.advanceTimersByTime(1_000);
    expect(trace.lines).toEqual([
      ...HOST_TAKES_OVER,
      ...once(0, [
        ...HOST_ATTEMPT,
        '#1 mute()',
        `#1 loadVideoById(${VIDEO},0)`,
        '#1 pauseVideo()',
        '#1 seekTo(0,true)',
        POLL,
      ]),
      ...once(50, [
        ...HOST_ATTEMPT,
        '#1 setVolume(80)',
        '#1 unMute()',
        `hand-off ${VIDEO}`,
        'log Falling back to legacy rendezvous: hard-mute-timeout',
      ]),
    ]);
    // The capture, every fence and the hand-off were given the same target.
    expect(new Set(rig.seen)).toEqual(new Set([target]));
    expect(rig.seen).toHaveLength(4);
    // The hand-off ends the recovery's own part; the legacy rendezvous it
    // started retires the claim (player.ts's invalidate).
    expect(rig.owned).toBe(true);
  });

  it.each([
    ['the load the run issued on it', { targetLoadIssued: true }, 1, false],
    [
      'the resident video the run repositions, at any position',
      { mediaAction: 'resident-reposition' as const },
      2,
      false,
    ],
    [
      'the resident video the run repositions, cued',
      { mediaAction: 'resident-reposition' as const },
      5,
      false,
    ],
    [
      'the resident video the run repositions, ended',
      { mediaAction: 'resident-reposition' as const },
      0,
      false,
    ],
    [
      'a resident iframe that shows another video',
      { mediaAction: 'resident-reposition' as const, videoId: 'unitRecovC3' },
      2,
      true,
    ],
  ])(
    'adopts the handed-off iframe with %s, reloading only another video',
    (_case, overrides, state, reload) => {
      const rig = newHostRig();
      const player = iframe(1, { __videoId: VIDEO, __state: state, __currentTime: 180 });
      rig.player = player;
      const target = hostTarget(player, overrides);
      rig.recovery.start(target, 'prepare-timeout');
      vi.advanceTimersByTime(0);
      expect(trace.lines.slice(3)).toEqual(
        once(0, [
          ...HOST_ATTEMPT,
          ...(reload
            ? ['#1 mute()', `#1 loadVideoById(${target.videoId},0)`, '#1 pauseVideo()']
            : ['#1 pauseVideo()']),
          '#1 seekTo(0,true)',
          POLL,
        ]),
      );
    },
  );

  it('never takes an iframe that reports no video id for its target: it polls', () => {
    const rig = newHostRig();
    const player = iframe(1, { __videoId: VIDEO, __state: 1 });
    player.getVideoData = () => ({}) as { video_id: string };
    rig.player = player;
    rig.recovery.start(hostTarget(player, { targetLoadIssued: true }), 'hard-mute-timeout');
    vi.advanceTimersByTime(0);
    expect(trace.lines.slice(3)).toEqual(once(0, [...HOST_ATTEMPT, POLL]));
  });

  it('settles again when the iframe stops reporting its video id at the settled check', () => {
    const rig = newHostRig();
    const player = iframe(1, { __videoId: VIDEO, __state: 2 });
    rig.player = player;
    rig.recovery.start(hostTarget(player, { targetLoadIssued: true }), 'hard-mute-timeout');
    vi.advanceTimersByTime(10);
    // At the next attempt the target check reads the video id and the settled
    // check reads none; every later read reports it again.
    let reads = 0;
    player.getVideoData = () =>
      ((reads += 1) === 2 ? {} : { video_id: VIDEO }) as {
        video_id: string;
      };
    vi.advanceTimersByTime(1_000);
    expect(trace.lines.slice(3)).toEqual([
      ...once(0, HOST_SETTLE),
      ...once(50, HOST_SETTLE),
      ...once(100, [
        ...HOST_ATTEMPT,
        '#1 setVolume(80)',
        '#1 unMute()',
        `hand-off ${VIDEO}`,
        'log Falling back to legacy rendezvous: hard-mute-timeout',
      ]),
    ]);
  });

  it('reloads when the run issued its load on no iframe it hands over', () => {
    const rig = newHostRig();
    rig.player = iframe(1, { __videoId: VIDEO, __state: 2 });
    rig.recovery.start(
      hostTarget(null, { targetLoadIssued: true, handedOffPlayer: undefined }),
      'hard-mute-timeout',
    );
    vi.advanceTimersByTime(0);
    expect(trace.lines.slice(3, 7)).toEqual(
      once(0, [...HOST_ATTEMPT, '#1 mute()', `#1 loadVideoById(${VIDEO},0)`]),
    );
  });

  it.each([
    [YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC, true],
    [YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC + 0.001, false],
  ])('a paused iframe %s s from 0:00 is the target: %s', (positionSec, ready) => {
    const rig = newHostRig();
    rig.player = iframe(1, { __videoId: VIDEO, __state: 2, __currentTime: positionSec });
    rig.recovery.start(hostTarget(rig.player, { targetLoadIssued: true }), 'hard-mute-timeout');
    vi.advanceTimersByTime(0);
    expect(trace.lines.slice(3)).toEqual(once(0, ready ? HOST_SETTLE : [...HOST_ATTEMPT, POLL]));
  });

  /** Every seek on `player` lands `landing()` past its target. */
  function landSeeksLate(player: FakeYtPlayer, landing: () => number): void {
    const seek = player.seekTo;
    player.seekTo = (seconds: number, allowAhead?: boolean) => {
      seek(seconds, allowAhead);
      player.__currentTime = seconds + landing();
    };
  }

  it('pauses and seeks a resident target again at each attempt while a seek lands past the tolerance', () => {
    const rig = newHostRig();
    const player = iframe(1, { __videoId: VIDEO, __state: 2 });
    rig.player = player;
    let landing = YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC + 0.001;
    landSeeksLate(player, () => landing);
    rig.recovery.start(
      hostTarget(player, { mediaAction: 'resident-reposition' }),
      'hard-mute-timeout',
    );
    vi.advanceTimersByTime(60);
    landing = 0;
    vi.advanceTimersByTime(1_000);
    expect(trace.lines.slice(3)).toEqual([
      ...once(0, HOST_SETTLE),
      ...once(50, HOST_SETTLE),
      ...once(100, HOST_SETTLE),
      ...once(150, [
        ...HOST_ATTEMPT,
        '#1 setVolume(80)',
        '#1 unMute()',
        `hand-off ${VIDEO}`,
        'log Falling back to legacy rendezvous: hard-mute-timeout',
      ]),
    ]);
  });

  // Pinned as today's behaviour, not claimed right: the settled check's own
  // pause and seek never run for a target the run did not leave resident,
  // because the target check before it uses the same tolerance.
  it('waits out its bridge without seeking again when a settle lands a loaded target past the tolerance', () => {
    const rig = newHostRig();
    const player = iframe(1, { __videoId: VIDEO, __state: 1 });
    rig.player = player;
    landSeeksLate(player, () => YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC + 0.001);
    rig.recovery.start(hostTarget(player, { targetLoadIssued: true }), 'hard-mute-timeout');
    vi.advanceTimersByTime(YOUTUBE_RECOVERY_BRIDGE_MS + 500);
    expect(trace.lines.slice(3)).toEqual([
      ...once(0, HOST_SETTLE),
      ...every(50, YOUTUBE_RECOVERY_BRIDGE_MS - 50, YOUTUBE_RECOVERY_POLL_MS, [
        ...HOST_ATTEMPT,
        POLL,
      ]),
      ...once(YOUTUBE_RECOVERY_BRIDGE_MS, [
        'clear',
        'autoplay false',
        'log Legacy recovery timed out: hard-mute-timeout',
        'loading false zero-start',
        'owned true',
        ...CLEANUP(),
        'owned false',
        'clear',
      ]),
    ]);
  });

  it('restores before its hand-off by command, check and poll until the iframe reports the audio', () => {
    const rig = newHostRig();
    rig.player = iframe(1, { __videoId: VIDEO, __state: 2, __muted: true, __unMuteIgnoreCount: 2 });
    rig.recovery.start(hostTarget(rig.player, { targetLoadIssued: true }), 'hard-mute-timeout');
    vi.advanceTimersByTime(500);
    expect(trace.lines.slice(3)).toEqual([
      ...once(0, HOST_SETTLE),
      ...every(50, 100, YOUTUBE_RECOVERY_POLL_MS, [
        ...HOST_ATTEMPT,
        '#1 setVolume(80)',
        '#1 unMute()',
        POLL,
      ]),
      ...once(150, [
        ...HOST_ATTEMPT,
        '#1 setVolume(80)',
        '#1 unMute()',
        `hand-off ${VIDEO}`,
        'log Falling back to legacy rendezvous: hard-mute-timeout',
      ]),
    ]);
  });

  it('writes the captured audio as the caller retargets it', () => {
    const rig = newHostRig();
    rig.audio = { muted: false, volume: 80 };
    rig.player = iframe(1, { __videoId: VIDEO, __state: 2 });
    rig.recovery.start(hostTarget(rig.player, { targetLoadIssued: true }), 'hard-mute-timeout');
    vi.advanceTimersByTime(10);
    rig.audio.volume = 35;
    rig.audio.muted = true;
    vi.advanceTimersByTime(100);
    expect(trace.lines.filter((line) => /setVolume|mute\(|unMute/u.test(line))).toEqual([
      '+50 #1 setVolume(35)',
      '+50 #1 mute()',
    ]);
  });

  it('retires itself from inside its hand-off, as the legacy rendezvous does, and still logs after it', () => {
    const rig = newHostRig();
    rig.player = iframe(1, { __videoId: VIDEO, __state: 2 });
    rig.onHandOff = () => rig.recovery.cancel();
    rig.recovery.start(hostTarget(rig.player, { targetLoadIssued: true }), 'commit-send-failed');
    vi.advanceTimersByTime(1_000);
    expect(trace.lines.slice(-3)).toEqual([
      `+50 hand-off ${VIDEO}`,
      '+50 clear',
      '+50 log Falling back to legacy rendezvous: commit-send-failed',
    ]);
  });

  it('a hand-off that throws after retiring the recovery: the iframe paused, no further attempt', () => {
    const rig = newHostRig();
    rig.player = iframe(1, { __videoId: VIDEO, __state: 2 });
    rig.onHandOff = () => {
      rig.recovery.cancel();
      throw new Error('synthetic hand-off failure');
    };
    rig.recovery.start(hostTarget(rig.player, { targetLoadIssued: true }), 'hard-mute-timeout');
    vi.advanceTimersByTime(5_000);
    expect(trace.lines.slice(-3)).toEqual([
      `+50 hand-off ${VIDEO}`,
      '+50 clear',
      '+50 #1 pauseVideo()',
    ]);
  });

  it('without an iframe, polls until its 3 s bridge ends, then restores the handed-off one: pause, seek and audio at each attempt', () => {
    const rig = newHostRig();
    const handedOff = iframe(1, { __videoId: VIDEO, __muted: true, __unMuteIgnoreCount: 1 });
    rig.recovery.start(hostTarget(handedOff, { targetLoadIssued: true }), 'prepare-timeout');
    vi.advanceTimersByTime(YOUTUBE_RECOVERY_BRIDGE_MS + 500);
    expect(trace.lines.slice(3)).toEqual([
      ...every(0, YOUTUBE_RECOVERY_BRIDGE_MS - YOUTUBE_RECOVERY_POLL_MS, YOUTUBE_RECOVERY_POLL_MS, [
        POLL,
      ]),
      ...once(YOUTUBE_RECOVERY_BRIDGE_MS, [
        'clear',
        'autoplay false',
        'log Legacy recovery timed out: prepare-timeout',
        'loading false zero-start',
        'owned true',
        ...CLEANUP(),
        `set ${YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS}`,
      ]),
      ...once(YOUTUBE_RECOVERY_BRIDGE_MS + YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS, [
        ...CLEANUP(),
        'owned false',
        'clear',
      ]),
    ]);
  });

  it('with no iframe found and none handed off, ends its bridge owning nothing', () => {
    const rig = newHostRig();
    rig.recovery.start(hostTarget(null), 'peer-connection-replaced');
    vi.advanceTimersByTime(YOUTUBE_RECOVERY_BRIDGE_MS + 500);
    expect(trace.lines.slice(-5)).toEqual(
      once(YOUTUBE_RECOVERY_BRIDGE_MS, [
        'clear',
        'autoplay false',
        'log Legacy recovery timed out: peer-connection-replaced',
        'loading false zero-start',
        'owned false',
      ]),
    );
  });

  it(`gives the verified cleanup ${YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS} attempts when the audio never restores, then lets the claim go`, () => {
    const rig = newHostRig();
    rig.player = neverTarget(1);
    rig.player.__unMuteIgnoreCount = 1_000;
    rig.recovery.start(hostTarget(null), 'hard-mute-timeout');
    vi.advanceTimersByTime(YOUTUBE_RECOVERY_BRIDGE_MS + 2_000);
    const timedOut = trace.lines.indexOf(
      `+${YOUTUBE_RECOVERY_BRIDGE_MS} log Legacy recovery timed out: hard-mute-timeout`,
    );
    expect(timedOut).toBeGreaterThan(0);
    const last =
      YOUTUBE_RECOVERY_BRIDGE_MS +
      (YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS - 1) * YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS;
    expect(trace.lines.slice(timedOut + 1)).toEqual([
      `+${YOUTUBE_RECOVERY_BRIDGE_MS} loading false zero-start`,
      `+${YOUTUBE_RECOVERY_BRIDGE_MS} owned true`,
      ...every(YOUTUBE_RECOVERY_BRIDGE_MS, last - 1, YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS, [
        ...CLEANUP(),
        `set ${YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS}`,
      ]),
      ...once(last, [...CLEANUP(), 'owned false', 'clear']),
    ]);
  });

  it.each([
    ['an iframe read throws', false],
    ['the pause after it throws too', true],
  ])(
    'when %s: the error is kept, the attempt repeated, and the end of its bridge logs that error',
    (_case, pauseThrows) => {
      const rig = newHostRig();
      const player = iframe(1, { __videoId: VIDEO, __state: 2 });
      rig.player = player;
      player.getPlayerState = () => {
        throw new Error('synthetic state read failure');
      };
      if (pauseThrows) {
        player.pauseVideo = () => {
          player.__log.push({ op: 'pauseVideo', at: Date.now() });
          throw new Error('synthetic pause failure');
        };
      }
      rig.recovery.start(hostTarget(player, { targetLoadIssued: true }), 'hard-mute-timeout');
      vi.advanceTimersByTime(YOUTUBE_RECOVERY_POLL_MS);
      expect(trace.lines.slice(3)).toEqual(
        every(0, YOUTUBE_RECOVERY_POLL_MS, YOUTUBE_RECOVERY_POLL_MS, [
          ...HOST_ATTEMPT,
          '#1 pauseVideo()',
          POLL,
        ]),
      );
      vi.advanceTimersByTime(YOUTUBE_RECOVERY_BRIDGE_MS + 1_000);
      expect(trace.lines).toContain(
        `+${YOUTUBE_RECOVERY_BRIDGE_MS} log Legacy recovery timed out: Error: synthetic state read failure`,
      );
      expect(rig.owned).toBe(false);
    },
  );

  it('its fence: a target no longer current ends it at the next attempt, with no command', () => {
    const rig = newHostRig();
    rig.player = neverTarget(1);
    rig.recovery.start(hostTarget(null), 'hard-mute-timeout');
    vi.advanceTimersByTime(60);
    rig.current = false;
    const before = trace.lines.length;
    vi.advanceTimersByTime(1_000);
    expect(trace.lines.slice(before)).toEqual(['+100 clear', '+100 owned false']);
  });

  it('cancel() revokes it: its timer cleared, and an attempt that escaped it does nothing', () => {
    const rig = newHostRig();
    rig.player = neverTarget(1);
    rig.recovery.start(hostTarget(null), 'hard-mute-timeout');
    vi.advanceTimersByTime(60);
    const escaped = rig.scheduled;
    const before = trace.lines.length;
    rig.recovery.cancel();
    escaped?.();
    vi.advanceTimersByTime(5_000);
    expect(trace.lines.slice(before)).toEqual(['+60 clear']);
    // The claim is the caller's to retire (player.ts's invalidate does).
    expect(rig.owned).toBe(true);
  });

  it('cancel() during the verified cleanup: a retry that escaped it does nothing', () => {
    const rig = newHostRig();
    rig.player = neverTarget(1);
    rig.player.__unMuteIgnoreCount = 1_000;
    rig.recovery.start(hostTarget(null), 'hard-mute-timeout');
    // The bridge ends at +3000; the verified cleanup's next retry is due at +3120.
    vi.advanceTimersByTime(YOUTUBE_RECOVERY_BRIDGE_MS + 60);
    const escaped = rig.scheduled;
    rig.recovery.cancel();
    const before = trace.lines.length;
    escaped?.();
    vi.advanceTimersByTime(2_000);
    expect(trace.lines.slice(before)).toEqual([]);
  });

  it('a newer start makes the older one stale: only the newer target is attempted', () => {
    const rig = newHostRig();
    rig.player = neverTarget(1);
    const older = hostTarget(null, { videoId: 'unitRecovD4' });
    rig.recovery.start(older, 'hard-mute-timeout');
    const escaped = rig.scheduled;
    const newer = hostTarget(null);
    rig.recovery.start(newer, 'peer-connection-replaced');
    escaped?.();
    vi.advanceTimersByTime(0);
    expect(trace.lines).toEqual([
      ...HOST_TAKES_OVER,
      ...HOST_TAKES_OVER,
      ...once(0, [...HOST_ATTEMPT, '#1 mute()', `#1 loadVideoById(${VIDEO},0)`, POLL]),
    ]);
  });

  it.each([
    ['the previous one gets one cleanup', false],
    ['a previous one that rejects its cleanup is left alone', true],
  ])('a rebuilt iframe: %s, the new one its own hard-muted load', (_case, cleanupThrows) => {
    const rig = newHostRig();
    const previous = neverTarget(1);
    rig.player = previous;
    rig.recovery.start(hostTarget(null), 'hard-mute-timeout');
    vi.advanceTimersByTime(10);
    if (cleanupThrows) {
      previous.pauseVideo = () => {
        previous.__log.push({ op: 'pauseVideo', at: Date.now() });
        throw new Error('synthetic destroyed iframe');
      };
    }
    rig.player = iframe(2, { __videoId: 'unitRecovB2', __state: 5, __autoPlayOnLoad: true });
    const before = trace.lines.length;
    vi.advanceTimersByTime(50);
    expect(trace.lines.slice(before)).toEqual(
      once(50, [
        ...(cleanupThrows ? ['autoplay false', '#1 pauseVideo()'] : CLEANUP(1)),
        ...HOST_ATTEMPT,
        '#2 mute()',
        `#2 loadVideoById(${VIDEO},0)`,
        '#2 pauseVideo()',
        '#2 seekTo(0,true)',
        POLL,
      ]),
    );
  });
});
