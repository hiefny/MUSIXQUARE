/**
 * The shared arm steps (arm-steps.ts) on their own, with a scripted iframe
 * and a manual schedule standing in for each machine's timer. The two
 * machines that run them, the Standard zero-start run and the PRO arm, are
 * pinned against the same steps in arm-steps-golden.test.ts. The settle rows
 * were added with Phase 6 6C-5.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptYouTubeWarmPlaying,
  settleYouTubeAtTarget,
  waitForYouTubeHardMute,
  type YouTubeArmPlayer,
} from '../arm-steps.ts';
import {
  YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS,
  YOUTUBE_ARM_HARD_MUTE_POLL_MS,
  YOUTUBE_ARM_PAUSE_SEEK_GAP_MS,
  YOUTUBE_ARM_SETTLE_EPSILON_SEC,
  YOUTUBE_ARM_SETTLE_POLL_MS,
  YOUTUBE_ARM_SETTLE_RESEEK_EVERY,
  YOUTUBE_ARM_SETTLE_STABLE_SAMPLES,
  YOUTUBE_ARM_WARM_PLAY_MS,
} from '../constants.ts';

type Read = boolean | 'throw';

/**
 * An iframe whose isMuted() answers `reads` in order (the last one from then
 * on) and whose mute() throws from call `muteThrowsFrom` on.
 */
function scriptedPlayer(
  name: string,
  log: string[],
  reads: readonly Read[],
  muteThrowsFrom = Number.POSITIVE_INFINITY,
): YouTubeArmPlayer {
  let readCount = 0;
  let muteCount = 0;
  const player: Pick<YouTubeArmPlayer, 'mute' | 'isMuted'> = {
    mute: () => {
      muteCount += 1;
      log.push(`${name}.mute`);
      if (muteCount >= muteThrowsFrom) throw new Error('scripted mute fault');
    },
    isMuted: () => {
      const read = reads[Math.min(readCount, reads.length - 1)];
      readCount += 1;
      log.push(`${name}.isMuted`);
      if (read === 'throw') throw new Error('scripted isMuted fault');
      return read === true;
    },
  };
  return player as YouTubeArmPlayer;
}

/** A machine's timer: each wait is logged and runs only when the row runs it. */
function manualSchedule(log: string[]) {
  const waits: (() => void)[] = [];
  return {
    schedule: (callback: () => void, delayMs: number): void => {
      log.push(`wait ${delayMs}`);
      waits.push(callback);
    },
    runNext: (): void => {
      const next = waits.shift();
      if (!next) throw new Error('no wait is pending');
      next();
    },
    pending: (): number => waits.length,
  };
}

describe('waitForYouTubeHardMute', () => {
  it('mutes at once, then polls only after a 0 ms wait on the caller schedule', () => {
    const log: string[] = [];
    const player = scriptedPlayer('A', log, [true]);
    const timer = manualSchedule(log);
    waitForYouTubeHardMute(
      player,
      () => {
        log.push('fence');
        return player;
      },
      () => log.push('warm'),
      () => log.push('timeout'),
      timer.schedule,
    );
    expect(log).toEqual(['A.mute', 'wait 0']);
  });

  it('lets a first mute() that throws reach the caller, and waits for nothing', () => {
    const log: string[] = [];
    const player = scriptedPlayer('A', log, [true], 1);
    const timer = manualSchedule(log);
    expect(() =>
      waitForYouTubeHardMute(
        player,
        () => {
          log.push('fence');
          return player;
        },
        () => log.push('warm'),
        () => log.push('timeout'),
        timer.schedule,
      ),
    ).toThrow('scripted mute fault');
    expect(log).toEqual(['A.mute']);
    expect(timer.pending()).toBe(0);
  });

  it('mutes again on each unconfirmed poll, polls 30 ms later, and warms in the confirming poll', () => {
    const log: string[] = [];
    const player = scriptedPlayer('A', log, [false, false, true]);
    const timer = manualSchedule(log);
    const warmed: YouTubeArmPlayer[] = [];
    waitForYouTubeHardMute(
      player,
      () => {
        log.push('fence');
        return player;
      },
      (warmPlayer) => {
        log.push('warm');
        warmed.push(warmPlayer);
      },
      () => log.push('timeout'),
      timer.schedule,
    );
    timer.runNext();
    timer.runNext();
    timer.runNext();
    expect(log).toEqual([
      'A.mute',
      'wait 0',
      'fence',
      'A.isMuted',
      'A.mute',
      `wait ${YOUTUBE_ARM_HARD_MUTE_POLL_MS}`,
      'fence',
      'A.isMuted',
      'A.mute',
      `wait ${YOUTUBE_ARM_HARD_MUTE_POLL_MS}`,
      'fence',
      'A.isMuted',
      'warm',
    ]);
    expect(warmed).toEqual([player]);
    expect(timer.pending()).toBe(0);
  });

  it('counts a read that throws as not muted and ignores a mute() that throws on a poll', () => {
    const log: string[] = [];
    const player = scriptedPlayer('A', log, ['throw', true], 2);
    const timer = manualSchedule(log);
    waitForYouTubeHardMute(
      player,
      () => {
        log.push('fence');
        return player;
      },
      () => log.push('warm'),
      () => log.push('timeout'),
      timer.schedule,
    );
    timer.runNext();
    timer.runNext();
    expect(log).toEqual([
      'A.mute',
      'wait 0',
      'fence',
      'A.isMuted',
      'A.mute',
      `wait ${YOUTUBE_ARM_HARD_MUTE_POLL_MS}`,
      'fence',
      'A.isMuted',
      'warm',
    ]);
  });

  it('times out on the last unconfirmed poll without muting or waiting again', () => {
    const log: string[] = [];
    const player = scriptedPlayer('A', log, [false]);
    const timer = manualSchedule(log);
    waitForYouTubeHardMute(
      player,
      () => player,
      () => log.push('warm'),
      () => log.push('timeout'),
      timer.schedule,
    );
    for (let poll = 0; poll < YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS; poll += 1) timer.runNext();
    expect(log.filter((entry) => entry === 'A.isMuted')).toHaveLength(
      YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS,
    );
    // The first mute and one more on each poll but the last.
    expect(log.filter((entry) => entry === 'A.mute')).toHaveLength(
      YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS,
    );
    expect(log.slice(-3)).toEqual([
      `wait ${YOUTUBE_ARM_HARD_MUTE_POLL_MS}`,
      'A.isMuted',
      'timeout',
    ]);
    expect(timer.pending()).toBe(0);
  });

  it('ends without a read, a command or a callback when the caller fence returns no player', () => {
    const log: string[] = [];
    const player = scriptedPlayer('A', log, [false]);
    const timer = manualSchedule(log);
    let current: YouTubeArmPlayer | null = player;
    waitForYouTubeHardMute(
      player,
      () => {
        log.push('fence');
        return current;
      },
      () => log.push('warm'),
      () => log.push('timeout'),
      timer.schedule,
    );
    timer.runNext();
    current = null;
    timer.runNext();
    expect(log).toEqual([
      'A.mute',
      'wait 0',
      'fence',
      'A.isMuted',
      'A.mute',
      `wait ${YOUTUBE_ARM_HARD_MUTE_POLL_MS}`,
      'fence',
    ]);
    expect(timer.pending()).toBe(0);
  });

  it('reads, mutes and warms the player the caller fence returns on each poll', () => {
    const log: string[] = [];
    const first = scriptedPlayer('A', log, [false]);
    const next = scriptedPlayer('B', log, [false, true]);
    const timer = manualSchedule(log);
    const warmed: YouTubeArmPlayer[] = [];
    waitForYouTubeHardMute(
      first,
      () => next,
      (warmPlayer) => warmed.push(warmPlayer),
      () => log.push('timeout'),
      timer.schedule,
    );
    timer.runNext();
    timer.runNext();
    expect(log).toEqual([
      'A.mute',
      'wait 0',
      'B.isMuted',
      'B.mute',
      `wait ${YOUTUBE_ARM_HARD_MUTE_POLL_MS}`,
      'B.isMuted',
    ]);
    expect(warmed).toEqual([next]);
  });
});

describe('acceptYouTubeWarmPlaying', () => {
  it('starts the settle one warm play later on the caller schedule and returns the warm latency', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    expect(acceptYouTubeWarmPlaying(1_000, 1_340, () => log.push('settle'), timer.schedule)).toBe(
      340,
    );
    expect(log).toEqual([`wait ${YOUTUBE_ARM_WARM_PLAY_MS}`]);
    timer.runNext();
    expect(log).toEqual([`wait ${YOUTUBE_ARM_WARM_PLAY_MS}`, 'settle']);
  });

  it('reports no warm latency below 0 when the clock reads before the warm command', () => {
    const timer = manualSchedule([]);
    expect(acceptYouTubeWarmPlaying(1_000, 990, () => undefined, timer.schedule)).toBe(0);
    expect(timer.pending()).toBe(1);
  });
});

/** What one poll reads from the iframe; either read can throw. */
interface Pose {
  state: number | 'throw';
  position: number | 'throw';
}

const PAUSED_AT_TARGET: Pose = { state: 2, position: 12 };
const PAUSED_OFF_TARGET: Pose = { state: 2, position: 40 };
const PLAYING_OFF_TARGET: Pose = { state: 1, position: 40 };

/**
 * An iframe for the settle: each getPlayerState() moves to the next pose (the
 * last one from then on), which getCurrentTime() then reads. Reads and
 * commands are logged; seekTo() throws from call `seekThrowsFrom` on.
 */
function settlingPlayer(
  name: string,
  log: string[],
  poses: readonly Pose[],
  seekThrowsFrom = Number.POSITIVE_INFINITY,
): YouTubeArmPlayer {
  let poseIndex = -1;
  let seeks = 0;
  const pose = (): Pose => {
    const current = poses[Math.min(Math.max(poseIndex, 0), poses.length - 1)];
    if (!current) throw new Error('no pose scripted');
    return current;
  };
  const player: Pick<
    YouTubeArmPlayer,
    'getPlayerState' | 'getCurrentTime' | 'pauseVideo' | 'seekTo'
  > = {
    getPlayerState: () => {
      poseIndex += 1;
      log.push(`${name}.state`);
      const { state } = pose();
      if (state === 'throw') throw new Error('scripted state fault');
      return state;
    },
    getCurrentTime: () => {
      log.push(`${name}.position`);
      const { position } = pose();
      if (position === 'throw') throw new Error('scripted position fault');
      return position;
    },
    pauseVideo: () => {
      log.push(`${name}.pause`);
    },
    seekTo: (seconds) => {
      seeks += 1;
      log.push(`${name}.seek ${seconds}`);
      if (seeks >= seekThrowsFrom) throw new Error('scripted seekTo fault');
    },
  };
  return player as YouTubeArmPlayer;
}

/** The machine's side of a settle; each callback is logged unless a row sets its own. */
interface SettlePolicy {
  fence?: (seek: boolean) => YouTubeArmPlayer | null;
  target?: () => number;
  /** The answers to "does the iframe hold the machine's video", in order (the last one from then on). */
  video?: readonly boolean[];
  positionFirst?: boolean;
  reseekAfterGap?: boolean;
  seekFailed?: boolean;
  /** The answers of `expired`, in order (the last one from then on). */
  expired?: readonly boolean[];
}

function startSettle(
  player: YouTubeArmPlayer,
  log: string[],
  timer: ReturnType<typeof manualSchedule>,
  policy: SettlePolicy = {},
): void {
  const answer = (answers: readonly boolean[] | undefined, call: number, fallback: boolean) =>
    answers?.[Math.min(call, answers.length - 1)] ?? fallback;
  let videoCalls = 0;
  let expiredCalls = 0;
  settleYouTubeAtTarget(
    policy.fence ??
      ((seek) => {
        log.push(seek ? 'fence seek' : 'fence poll');
        return player;
      }),
    policy.target ??
      (() => {
        log.push('target');
        return 12;
      }),
    (current) => {
      log.push(current === player ? 'video' : 'video of another iframe');
      return answer(policy.video, videoCalls++, true);
    },
    policy.positionFirst ?? false,
    policy.reseekAfterGap ?? false,
    policy.seekFailed ? () => log.push('seekFailed') : null,
    () => log.push('settled'),
    (state, position, target) => {
      log.push(`expired ${state} ${position} ${target}`);
      return answer(policy.expired, expiredCalls++, false);
    },
    timer.schedule,
  );
}

/** Starts a settle and runs it to its first poll, then clears the log. */
function settleToFirstPoll(
  player: YouTubeArmPlayer,
  log: string[],
  timer: ReturnType<typeof manualSchedule>,
  policy: SettlePolicy = {},
): void {
  startSettle(player, log, timer, policy);
  timer.runNext();
  log.length = 0;
}

const GAP = `wait ${YOUTUBE_ARM_PAUSE_SEEK_GAP_MS}`;
const NEXT_POLL = `wait ${YOUTUBE_ARM_SETTLE_POLL_MS}`;

describe('settleYouTubeAtTarget', () => {
  it('seeks to the target one pause-seek gap later behind the fence, then polls a settle poll later', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    startSettle(settlingPlayer('A', log, [PAUSED_AT_TARGET]), log, timer);
    expect(log).toEqual([GAP]);
    timer.runNext();
    expect(log).toEqual([GAP, 'fence seek', 'target', 'A.seek 12', NEXT_POLL]);
  });

  it('settles once polls in a row find its video paused or cued within the epsilon, and polls no more', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    const player = settlingPlayer('A', log, [
      { state: 2, position: YOUTUBE_ARM_SETTLE_EPSILON_SEC },
      { state: 5, position: -YOUTUBE_ARM_SETTLE_EPSILON_SEC },
    ]);
    settleToFirstPoll(player, log, timer, {
      target: () => {
        log.push('target');
        return 0;
      },
    });
    for (let poll = 0; poll < YOUTUBE_ARM_SETTLE_STABLE_SAMPLES; poll += 1) timer.runNext();
    expect(log).toEqual([
      'fence poll',
      'target',
      'A.state',
      'video',
      'A.position',
      `expired 2 ${YOUTUBE_ARM_SETTLE_EPSILON_SEC} 0`,
      NEXT_POLL,
      'fence poll',
      'target',
      'A.state',
      'video',
      'A.position',
      'settled',
    ]);
    expect(timer.pending()).toBe(0);
  });

  it.each([
    ['a position just past the epsilon', [true], { state: 2, position: 12.121 }],
    ['another video', [false], PAUSED_AT_TARGET],
    ['an iframe neither paused nor cued', [true], { state: 3, position: 12 }],
  ] as const)('counts %s as unsettled, which starts the count again', (_name, video, pose) => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    const player = settlingPlayer('A', log, [
      PAUSED_AT_TARGET,
      pose,
      PAUSED_AT_TARGET,
      PAUSED_AT_TARGET,
    ]);
    settleToFirstPoll(player, log, timer, { video: [true, ...video, true] });
    timer.runNext();
    timer.runNext();
    timer.runNext();
    expect(log).not.toContain('settled');
    timer.runNext();
    expect(log.at(-1)).toBe('settled');
  });

  it.each([
    [true, ['A.state', 'A.position', 'video']],
    [false, ['A.state', 'video', 'A.position']],
  ] as const)(
    'with the position first %s, reads the state, the video and the position in its order',
    (positionFirst, reads) => {
      const log: string[] = [];
      const timer = manualSchedule(log);
      settleToFirstPoll(settlingPlayer('A', log, [PAUSED_AT_TARGET]), log, timer, {
        positionFirst,
      });
      timer.runNext();
      expect(log).toEqual(['fence poll', 'target', ...reads, 'expired 2 12 12', NEXT_POLL]);
    },
  );

  it.each([
    ['a PLAYING iframe', [true], PLAYING_OFF_TARGET],
    ['another video', [false], PAUSED_OFF_TARGET],
  ] as const)('reads no position of %s when the position comes last', (_name, video, pose) => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    settleToFirstPoll(settlingPlayer('A', log, [pose]), log, timer, { video });
    timer.runNext();
    expect(log).not.toContain('A.position');
    expect(log).toContain(`expired ${pose.state} Infinity 12`);
  });

  it('pauses a PLAYING iframe on an unsettled poll, and on every sixth pauses and seeks again at once', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    settleToFirstPoll(settlingPlayer('A', log, [PLAYING_OFF_TARGET]), log, timer, {
      positionFirst: true,
    });
    timer.runNext();
    expect(log).toEqual([
      'fence poll',
      'target',
      'A.state',
      'A.position',
      'video',
      'A.pause',
      'expired 1 40 12',
      NEXT_POLL,
    ]);
    for (let poll = 2; poll < YOUTUBE_ARM_SETTLE_RESEEK_EVERY; poll += 1) timer.runNext();
    log.length = 0;
    timer.runNext();
    expect(log).toEqual([
      'fence poll',
      'target',
      'A.state',
      'A.position',
      'video',
      'A.pause',
      'A.pause',
      'target',
      'A.seek 12',
      'expired 1 40 12',
      NEXT_POLL,
    ]);
  });

  it('counts its settled polls among the attempts that place a re-seek on the sixth', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    settleToFirstPoll(settlingPlayer('A', log, [PAUSED_AT_TARGET, PAUSED_OFF_TARGET]), log, timer);
    for (let poll = 0; poll < YOUTUBE_ARM_SETTLE_RESEEK_EVERY; poll += 1) timer.runNext();
    expect(log.filter((entry) => entry === 'A.pause')).toEqual(['A.pause']);
    expect(log.filter((entry) => entry === 'A.seek 12')).toEqual(['A.seek 12']);
  });

  it('with the re-seek after the gap, seeks again one pause-seek gap later behind the fence, reading the target then', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    settleToFirstPoll(settlingPlayer('A', log, [PAUSED_OFF_TARGET]), log, timer, {
      reseekAfterGap: true,
    });
    for (let poll = 1; poll < YOUTUBE_ARM_SETTLE_RESEEK_EVERY; poll += 1) timer.runNext();
    log.length = 0;
    timer.runNext();
    expect(log).toEqual([
      'fence poll',
      'target',
      'A.state',
      'video',
      'A.position',
      'A.pause',
      GAP,
      'expired 2 40 12',
      NEXT_POLL,
    ]);
    log.length = 0;
    timer.runNext();
    expect(log).toEqual(['fence seek', 'target', 'A.seek 12']);
    expect(timer.pending()).toBe(1);
  });

  it('drops a re-seek after the gap whose fence returns no iframe, without reading the target', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    const player = settlingPlayer('A', log, [PAUSED_OFF_TARGET]);
    let reseekFenced = false;
    settleToFirstPoll(player, log, timer, {
      reseekAfterGap: true,
      fence: (seek) => {
        log.push(seek ? 'fence seek' : 'fence poll');
        return seek && reseekFenced ? null : player;
      },
    });
    for (let poll = 0; poll < YOUTUBE_ARM_SETTLE_RESEEK_EVERY; poll += 1) timer.runNext();
    reseekFenced = true;
    log.length = 0;
    timer.runNext();
    expect(log).toEqual(['fence seek']);
    expect(timer.pending()).toBe(1);
  });

  it('lets a re-seek that throws after the gap leave its timer, the next poll still due', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    settleToFirstPoll(settlingPlayer('A', log, [PAUSED_OFF_TARGET], 2), log, timer, {
      reseekAfterGap: true,
    });
    for (let poll = 0; poll < YOUTUBE_ARM_SETTLE_RESEEK_EVERY; poll += 1) timer.runNext();
    expect(() => {
      timer.runNext();
    }).toThrow('scripted seekTo fault');
    expect(timer.pending()).toBe(1);
  });

  it('keeps a re-seek at once that throws inside its poll, which counts as unsettled', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    settleToFirstPoll(settlingPlayer('A', log, [PAUSED_OFF_TARGET], 2), log, timer);
    for (let poll = 1; poll < YOUTUBE_ARM_SETTLE_RESEEK_EVERY; poll += 1) timer.runNext();
    log.length = 0;
    timer.runNext();
    expect(log.slice(-4)).toEqual(['target', 'A.seek 12', 'expired 2 40 12', NEXT_POLL]);
  });

  it.each([
    ['state', { state: 'throw', position: 12 }, true, 'expired -1 Infinity 12'],
    ['position read first', { state: 2, position: 'throw' }, true, 'expired 2 Infinity 12'],
    ['position read last', { state: 2, position: 'throw' }, false, 'expired 2 Infinity 12'],
  ] as const)(
    'counts a poll whose %s read throws as unsettled, which starts the count again',
    (_name, pose, positionFirst, expired) => {
      const log: string[] = [];
      const timer = manualSchedule(log);
      const player = settlingPlayer('A', log, [
        PAUSED_AT_TARGET,
        pose,
        PAUSED_AT_TARGET,
        PAUSED_AT_TARGET,
      ]);
      settleToFirstPoll(player, log, timer, { positionFirst });
      timer.runNext();
      timer.runNext();
      timer.runNext();
      expect(log.filter((entry) => entry.startsWith('expired'))).toEqual([
        'expired 2 12 12',
        expired,
        'expired 2 12 12',
      ]);
      timer.runNext();
      expect(log.at(-1)).toBe('settled');
    },
  );

  it.each([
    ['state', { state: 'throw', position: 40 }, true],
    ['position read first', { state: 1, position: 'throw' }, true],
    ['position read last', { state: 2, position: 'throw' }, false],
  ] as const)(
    'neither pauses nor seeks again on a poll whose %s read throws, even the sixth',
    (_name, pose, positionFirst) => {
      const log: string[] = [];
      const timer = manualSchedule(log);
      settleToFirstPoll(settlingPlayer('A', log, [pose]), log, timer, { positionFirst });
      for (let poll = 0; poll < YOUTUBE_ARM_SETTLE_RESEEK_EVERY; poll += 1) timer.runNext();
      expect(log.filter((entry) => entry === 'A.pause' || entry.startsWith('A.seek'))).toEqual([]);
      expect(log.filter((entry) => entry.startsWith('expired'))).toHaveLength(
        YOUTUBE_ARM_SETTLE_RESEEK_EVERY,
      );
    },
  );

  it('asks expired after each poll that does not settle, and polls no more once it gives up', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    settleToFirstPoll(settlingPlayer('A', log, [PAUSED_OFF_TARGET]), log, timer, {
      expired: [false, true],
    });
    timer.runNext();
    timer.runNext();
    expect(log.filter((entry) => entry.startsWith('expired'))).toEqual([
      'expired 2 40 12',
      'expired 2 40 12',
    ]);
    expect(log.at(-1)).toBe('expired 2 40 12');
    expect(timer.pending()).toBe(0);
  });

  it('ends with no read, command or callback when the fence returns no iframe at the seek', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    startSettle(settlingPlayer('A', log, [PAUSED_AT_TARGET]), log, timer, {
      fence: (seek) => {
        log.push(seek ? 'fence seek' : 'fence poll');
        return null;
      },
    });
    timer.runNext();
    expect(log).toEqual([GAP, 'fence seek']);
    expect(timer.pending()).toBe(0);
  });

  it('ends with no read, command or callback when the fence returns no iframe at a poll', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    const player = settlingPlayer('A', log, [PAUSED_AT_TARGET]);
    settleToFirstPoll(player, log, timer, {
      fence: (seek) => {
        log.push(seek ? 'fence seek' : 'fence poll');
        return seek ? player : null;
      },
    });
    timer.runNext();
    expect(log).toEqual(['fence poll']);
    expect(timer.pending()).toBe(0);
  });

  it('reads, commands and asks about the iframe its fence returns', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    const first = settlingPlayer('A', log, [PAUSED_AT_TARGET]);
    const next = settlingPlayer('B', log, [PLAYING_OFF_TARGET]);
    startSettle(first, log, timer, { fence: () => next, positionFirst: true });
    timer.runNext();
    timer.runNext();
    expect(log).toEqual([
      GAP,
      'target',
      'B.seek 12',
      NEXT_POLL,
      'target',
      'B.state',
      'B.position',
      'video of another iframe',
      'B.pause',
      'expired 1 40 12',
      NEXT_POLL,
    ]);
  });

  it('ends the settle with seekFailed when the first seek throws, and schedules nothing', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    startSettle(settlingPlayer('A', log, [PAUSED_AT_TARGET], 1), log, timer, {
      seekFailed: true,
    });
    timer.runNext();
    expect(log).toEqual([GAP, 'fence seek', 'target', 'A.seek 12', 'seekFailed']);
    expect(timer.pending()).toBe(0);
  });

  it('polls on when the first seek throws and no seekFailed is given', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    startSettle(settlingPlayer('A', log, [PAUSED_AT_TARGET], 1), log, timer);
    timer.runNext();
    expect(log).toEqual([GAP, 'fence seek', 'target', 'A.seek 12', NEXT_POLL]);
  });

  it('reads the target before the iframe, outside the poll: a target that throws leaves the poll', () => {
    const log: string[] = [];
    const timer = manualSchedule(log);
    let targetThrows = false;
    settleToFirstPoll(settlingPlayer('A', log, [PAUSED_AT_TARGET]), log, timer, {
      target: () => {
        log.push('target');
        if (targetThrows) throw new Error('scripted target fault');
        return 12;
      },
    });
    targetThrows = true;
    expect(() => {
      timer.runNext();
    }).toThrow('scripted target fault');
    expect(log).toEqual(['fence poll', 'target']);
    expect(timer.pending()).toBe(0);
  });
});
