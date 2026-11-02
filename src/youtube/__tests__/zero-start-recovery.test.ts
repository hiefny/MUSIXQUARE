/**
 * The guest zero-start recovery class on its own (Phase 6 6D-1, plan step
 * C2-9; registry RO-33). Its schedule, cancel, claim setters, fence, iframe
 * getter and target resolvers are this suite's fakes, the iframe is the fake
 * player, and the clock is fake time. The real wiring in player.ts is pinned
 * by zero-start-recovery-golden.test.ts.
 *
 * Each row writes one ordered trace, at milliseconds since the start:
 * 'set <ms>' and 'cancel' (the caller's one timer), 'owned <bool>' and
 * 'retained <bool>' (the claim's two setters), 'autoplay <bool>'
 * (setYtAutoplayIntent), '#<n> <op>(<args>)' (an iframe command) and
 * 'log <message>' (a warning).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STANDARD_ZERO_START_GUEST_DECISION_MS,
  STANDARD_ZERO_START_PREPARE_BUDGET_MS,
  YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS,
  YOUTUBE_RECOVERY_BRIDGE_MS,
  YOUTUBE_RECOVERY_POLL_MS,
  YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC,
} from '../constants.ts';
import { GuestZeroStartRecovery } from '../zero-start-recovery.ts';
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
}

function newRig(): Rig {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const rig: Rig = {
    flags: { owned: false, retained: false },
    current: true,
    player: null,
    scheduleThrows: false,
    recovery: new GuestZeroStartRecovery(
      (callback, delayMs) => {
        write(`set ${delayMs}`);
        if (rig.scheduleThrows) throw new Error('synthetic schedule failure');
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
