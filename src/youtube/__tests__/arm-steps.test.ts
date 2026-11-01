/**
 * The shared arm steps (arm-steps.ts) on their own, with a scripted iframe
 * and a manual schedule standing in for each machine's timer. The two
 * machines that run them, the Standard zero-start run and the PRO arm, are
 * pinned against the same steps in arm-steps-golden.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  acceptYouTubeWarmPlaying,
  waitForYouTubeHardMute,
  type YouTubeArmPlayer,
} from '../arm-steps.ts';
import {
  YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS,
  YOUTUBE_ARM_HARD_MUTE_POLL_MS,
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
