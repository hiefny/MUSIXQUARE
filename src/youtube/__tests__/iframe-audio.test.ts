/**
 * The verified YouTube iframe audio restore (src/youtube/iframe-audio.ts,
 * RO-12), pinned before Phase 6 6A-4 moves six restore loops onto it.
 *
 * youtube-audio-restore-cadence.test.ts pins each caller's op log through its
 * public entries. These rows pin the shared pieces on their own: the writer
 * (setVolume, then mute or unMute), the check (the mute state, then a volume
 * within 1, a NaN read never matching), and the loop with its two cadences
 * (write, wait 120 ms, verify; or write, verify, wait 120 ms), its eight
 * attempts, the synchronous first attempt, the fences, what a throw counts as,
 * and that it keeps no state between two loops. Each caller keeps its own
 * timer: the loop only ever asks the caller's schedule for one 120 ms wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isYouTubeAudioRestored,
  restoreYouTubeAudioVerified,
  writeYouTubeAudio,
} from '../iframe-audio.ts';

type Cadence = 'settle-then-verify' | 'verify-then-settle';

/** An iframe audio surface that logs every call, reads included. */
function makeAudioPlayer(init: { muted?: boolean; volume?: number } = {}) {
  const calls: string[] = [];
  const player = {
    calls,
    muted: init.muted ?? true,
    volume: init.volume ?? 100,
    /** The next N unMute() calls are logged and ignored. */
    unMuteIgnoreCount: 0,
    volumeRead: 'value' as 'value' | 'nan' | 'throw',
    mutedRead: 'value' as 'value' | 'throw',
    setVolume(volume: number) {
      calls.push(`setVolume(${volume})`);
      player.volume = volume;
    },
    mute() {
      calls.push('mute()');
      player.muted = true;
    },
    unMute() {
      calls.push('unMute()');
      if (player.unMuteIgnoreCount > 0) {
        player.unMuteIgnoreCount -= 1;
        return;
      }
      player.muted = false;
    },
    isMuted() {
      calls.push('isMuted()');
      if (player.mutedRead === 'throw') throw new Error('synthetic isMuted read fault');
      return player.muted;
    },
    getVolume() {
      calls.push('getVolume()');
      if (player.volumeRead === 'throw') throw new Error('synthetic getVolume read fault');
      return player.volumeRead === 'nan' ? Number.NaN : player.volume;
    },
  };
  return player;
}

type AudioPlayer = ReturnType<typeof makeAudioPlayer>;

/** The writes an audio player received, reads left out. */
function writesOf(player: AudioPlayer): string[] {
  return player.calls.filter(
    (call) => call.startsWith('setVolume(') || call === 'mute()' || call === 'unMute()',
  );
}

interface LoopScript {
  /** The first write after which verify answers true (never when omitted). */
  restoredAfterWrite?: number;
  /** Writes (1-based) that throw instead of returning. */
  throwingWrites?: readonly number[];
  /** Verifies (1-based) that throw instead of answering. */
  throwingVerifies?: readonly number[];
  /** The first write fence answer (1-based) that is false. */
  writeFenceClosesAt?: number;
  /** The first verify fence answer (1-based) that is false; null passes no verify fence. */
  verifyFenceClosesAt?: number | null;
}

/**
 * Runs one loop and logs every step it takes, relative to its start:
 * '+<ms> <step>'. The caller's schedule is a plain fake-timer setTimeout.
 */
function runLoop(cadence: Cadence, script: LoopScript = {}) {
  const t0 = Date.now();
  const log: string[] = [];
  const delays: number[] = [];
  const at = (step: string) => log.push(`+${Date.now() - t0} ${step}`);
  let writes = 0;
  let verifies = 0;
  let writeFences = 0;
  let verifyFences = 0;
  const restoredAfter = script.restoredAfterWrite ?? Number.POSITIVE_INFINITY;
  const verifyFence =
    script.verifyFenceClosesAt === null
      ? undefined
      : () => {
          verifyFences += 1;
          at('canVerify');
          return verifyFences < (script.verifyFenceClosesAt ?? Number.POSITIVE_INFINITY);
        };
  restoreYouTubeAudioVerified(
    cadence,
    () => {
      writeFences += 1;
      at('canWrite');
      return writeFences < (script.writeFenceClosesAt ?? Number.POSITIVE_INFINITY);
    },
    () => {
      writes += 1;
      at(`write ${writes}`);
      if (script.throwingWrites?.includes(writes)) throw new Error('synthetic write failure');
    },
    () => {
      verifies += 1;
      at(`verify ${verifies}`);
      if (script.throwingVerifies?.includes(verifies)) throw new Error('synthetic read failure');
      return writes >= restoredAfter;
    },
    (restored, attempts) => at(restored ? `restored after ${attempts}` : 'exhausted'),
    (callback, delayMs) => {
      delays.push(delayMs);
      at(`schedule ${delayMs}`);
      setTimeout(callback, delayMs);
    },
    verifyFence,
  );
  return { log, delays };
}

/** One attempt's steps, all at `at` ms. */
function steps(at: number, ...names: string[]): string[] {
  return names.map((name) => `+${at} ${name}`);
}

function writeSteps(log: readonly string[]): string[] {
  return log.filter((step) => / write \d+$/u.test(step));
}

function verifySteps(log: readonly string[]): string[] {
  return log.filter((step) => / verify \d+$/u.test(step));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-31T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('writeYouTubeAudio', () => {
  it('writes the volume, then unMute() for an audible target', () => {
    const player = makeAudioPlayer({ muted: true, volume: 0 });
    writeYouTubeAudio(player, { muted: false, volume: 35 });
    expect(player.calls).toEqual(['setVolume(35)', 'unMute()']);
  });

  it('writes the volume, then mute() for a muted target', () => {
    const player = makeAudioPlayer({ muted: false, volume: 80 });
    writeYouTubeAudio(player, { muted: true, volume: 20 });
    expect(player.calls).toEqual(['setVolume(20)', 'mute()']);
  });

  it('lets a failing command throw to its caller, after the commands before it', () => {
    const player = makeAudioPlayer();
    player.unMute = () => {
      player.calls.push('unMute()');
      throw new Error('synthetic unMute failure');
    };
    expect(() => writeYouTubeAudio(player, { muted: false, volume: 50 })).toThrow(
      'synthetic unMute failure',
    );
    expect(player.calls).toEqual(['setVolume(50)', 'unMute()']);
  });
});

describe('isYouTubeAudioRestored', () => {
  it.each([
    { name: 'the same volume', volume: 40, restored: true },
    { name: 'a volume 1 above', volume: 41, restored: true },
    { name: 'a volume 1 below', volume: 39, restored: true },
    { name: 'a volume 2 away', volume: 42, restored: false },
  ])('reads the mute state, then the volume: $name answers $restored', ({ volume, restored }) => {
    const player = makeAudioPlayer({ muted: false, volume });
    expect(isYouTubeAudioRestored(player, { muted: false, volume: 40 })).toBe(restored);
    expect(player.calls).toEqual(['isMuted()', 'getVolume()']);
  });

  it('answers false on another mute state without reading the volume', () => {
    const player = makeAudioPlayer({ muted: true, volume: 40 });
    expect(isYouTubeAudioRestored(player, { muted: false, volume: 40 })).toBe(false);
    expect(player.calls).toEqual(['isMuted()']);
  });

  it('never counts a NaN volume read as restored', () => {
    const player = makeAudioPlayer({ muted: false, volume: 40 });
    player.volumeRead = 'nan';
    expect(isYouTubeAudioRestored(player, { muted: false, volume: 40 })).toBe(false);
  });

  it('lets a failing read throw to its caller', () => {
    const player = makeAudioPlayer({ muted: false, volume: 40 });
    player.volumeRead = 'throw';
    expect(() => isYouTubeAudioRestored(player, { muted: false, volume: 40 })).toThrow(
      'synthetic getVolume read fault',
    );
    player.mutedRead = 'throw';
    expect(() => isYouTubeAudioRestored(player, { muted: false, volume: 40 })).toThrow(
      'synthetic isMuted read fault',
    );
  });
});

describe('restoreYouTubeAudioVerified: cadences', () => {
  it("'settle-then-verify' writes, waits 120 ms, then verifies: eight attempts at most", () => {
    const { log, delays } = runLoop('settle-then-verify');
    vi.advanceTimersByTime(2_000);
    expect(log).toEqual([
      ...steps(0, 'canWrite', 'write 1', 'schedule 120'),
      ...[1, 2, 3, 4, 5, 6, 7].flatMap((attempt) =>
        steps(
          attempt * 120,
          'canVerify',
          `verify ${attempt}`,
          'canWrite',
          `write ${attempt + 1}`,
          'schedule 120',
        ),
      ),
      ...steps(960, 'canVerify', 'verify 8', 'exhausted'),
    ]);
    expect(delays).toEqual(Array(8).fill(120));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("'verify-then-settle' writes and verifies at once, then waits 120 ms: eight attempts at most", () => {
    const { log, delays } = runLoop('verify-then-settle');
    vi.advanceTimersByTime(2_000);
    expect(log).toEqual([
      ...[0, 1, 2, 3, 4, 5, 6].flatMap((attempt) =>
        steps(
          attempt * 120,
          'canWrite',
          `write ${attempt + 1}`,
          `verify ${attempt + 1}`,
          'schedule 120',
        ),
      ),
      ...steps(840, 'canWrite', 'write 8', 'verify 8', 'exhausted'),
    ]);
    expect(delays).toEqual(Array(7).fill(120));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs the first attempt synchronously, before any timer', () => {
    expect(runLoop('settle-then-verify').log).toEqual(
      steps(0, 'canWrite', 'write 1', 'schedule 120'),
    );
    expect(runLoop('verify-then-settle').log).toEqual(
      steps(0, 'canWrite', 'write 1', 'verify 1', 'schedule 120'),
    );
    // A verify-then-settle loop whose first check passes ends inside the call.
    expect(runLoop('verify-then-settle', { restoredAfterWrite: 1 }).log).toEqual(
      steps(0, 'canWrite', 'write 1', 'verify 1', 'restored after 1'),
    );
  });

  it.each([
    ['settle-then-verify', 360],
    ['verify-then-settle', 240],
  ] as const)('%s reports a restore with its write count (+%i ms)', (cadence, restoredAt) => {
    const { log } = runLoop(cadence, { restoredAfterWrite: 3 });
    vi.advanceTimersByTime(2_000);
    expect(log.slice(-2)).toEqual([`+${restoredAt} verify 3`, `+${restoredAt} restored after 3`]);
    expect(writeSteps(log)).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('restoreYouTubeAudioVerified: fences', () => {
  it.each(['settle-then-verify', 'verify-then-settle'] as const)(
    '%s: a closed write fence ends the loop with no write, verify or callback',
    (cadence) => {
      const closedFirst = runLoop(cadence, { writeFenceClosesAt: 1 });
      expect(closedFirst.log).toEqual(['+0 canWrite']);
      expect(closedFirst.delays).toEqual([]);

      const closedThird = runLoop(cadence, { writeFenceClosesAt: 3 });
      vi.advanceTimersByTime(2_000);
      expect(closedThird.log.at(-1)).toBe('+240 canWrite');
      expect(writeSteps(closedThird.log)).toHaveLength(2);
      expect(closedThird.log.some((step) => /restored|exhausted/u.test(step))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("'settle-then-verify' asks its verify fence after the wait; a closed one ends the loop", () => {
    const { log } = runLoop('settle-then-verify', { verifyFenceClosesAt: 2 });
    vi.advanceTimersByTime(2_000);
    expect(log).toEqual([
      ...steps(0, 'canWrite', 'write 1', 'schedule 120'),
      ...steps(120, 'canVerify', 'verify 1', 'canWrite', 'write 2', 'schedule 120'),
      '+240 canVerify',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("'settle-then-verify' asks the write fence before each verify when it has no verify fence", () => {
    const { log } = runLoop('settle-then-verify', {
      verifyFenceClosesAt: null,
      writeFenceClosesAt: 4,
    });
    vi.advanceTimersByTime(2_000);
    expect(log).toEqual([
      ...steps(0, 'canWrite', 'write 1', 'schedule 120'),
      ...steps(120, 'canWrite', 'verify 1', 'canWrite', 'write 2', 'schedule 120'),
      // The fourth fence answer is false: the loop ends before the second verify.
      '+240 canWrite',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("'verify-then-settle' never asks a verify fence", () => {
    const { log } = runLoop('verify-then-settle', { verifyFenceClosesAt: 1 });
    vi.advanceTimersByTime(2_000);
    expect(log.some((step) => step.endsWith(' canVerify'))).toBe(false);
    expect(log.at(-1)).toBe('+840 exhausted');
  });
});

describe('restoreYouTubeAudioVerified: throws', () => {
  it("'verify-then-settle': a throwing write skips that attempt's verify and retries", () => {
    const { log } = runLoop('verify-then-settle', {
      throwingWrites: [1, 2],
      restoredAfterWrite: 3,
    });
    vi.advanceTimersByTime(2_000);
    expect(log).toEqual([
      ...steps(0, 'canWrite', 'write 1', 'schedule 120'),
      ...steps(120, 'canWrite', 'write 2', 'schedule 120'),
      ...steps(240, 'canWrite', 'write 3', 'verify 1', 'restored after 3'),
    ]);
  });

  it("'settle-then-verify': a throwing write still waits, then skips its verify and retries", () => {
    const { log } = runLoop('settle-then-verify', {
      throwingWrites: [1],
      restoredAfterWrite: 2,
    });
    vi.advanceTimersByTime(2_000);
    expect(log).toEqual([
      ...steps(0, 'canWrite', 'write 1', 'schedule 120'),
      ...steps(120, 'canVerify', 'canWrite', 'write 2', 'schedule 120'),
      ...steps(240, 'canVerify', 'verify 1', 'restored after 2'),
    ]);
  });

  it.each([
    ['settle-then-verify', '+960 exhausted'],
    ['verify-then-settle', '+840 exhausted'],
  ] as const)(
    '%s: eight throwing writes exhaust the loop without a single verify',
    (cadence, exhausted) => {
      const { log } = runLoop(cadence, { throwingWrites: [1, 2, 3, 4, 5, 6, 7, 8] });
      vi.advanceTimersByTime(2_000);
      expect(verifySteps(log)).toEqual([]);
      expect(writeSteps(log)).toHaveLength(8);
      expect(log.at(-1)).toBe(exhausted);
    },
  );

  it.each([
    ['settle-then-verify', '+360 restored after 3'],
    ['verify-then-settle', '+240 restored after 3'],
  ] as const)('%s: a throwing verify counts as not restored', (cadence, restored) => {
    const { log } = runLoop(cadence, { throwingVerifies: [1, 2], restoredAfterWrite: 1 });
    vi.advanceTimersByTime(2_000);
    expect(log.at(-1)).toBe(restored);
    expect(verifySteps(log)).toHaveLength(3);
  });
});

describe('restoreYouTubeAudioVerified: independent loops', () => {
  it('keeps no state between loops: two overlapping loops each run their own course', () => {
    // Two iframes with a restore each: one ignores two unMutes, the other
    // three. The loops overlap and neither touches the other's iframe.
    const first = makeAudioPlayer({ muted: true, volume: 0 });
    first.unMuteIgnoreCount = 2;
    const second = makeAudioPlayer({ muted: true, volume: 0 });
    second.unMuteIgnoreCount = 3;
    const outcomes: string[] = [];
    const t0 = Date.now();
    const loop = (
      name: string,
      cadence: Cadence,
      player: AudioPlayer,
      target: { muted: boolean; volume: number },
    ) =>
      restoreYouTubeAudioVerified(
        cadence,
        () => true,
        () => writeYouTubeAudio(player, target),
        () => isYouTubeAudioRestored(player, target),
        (restored, attempts) =>
          outcomes.push(`+${Date.now() - t0} ${name} ${restored ? attempts : 'exhausted'}`),
        (callback, delayMs) => setTimeout(callback, delayMs),
      );

    loop('first', 'settle-then-verify', first, { muted: false, volume: 60 });
    vi.advanceTimersByTime(60);
    loop('second', 'verify-then-settle', second, { muted: false, volume: 30 });
    vi.advanceTimersByTime(2_000);

    expect(outcomes).toEqual(['+360 first 3', '+420 second 4']);
    expect(writesOf(first)).toEqual(Array(3).fill(['setVolume(60)', 'unMute()']).flat());
    expect(writesOf(second)).toEqual(Array(4).fill(['setVolume(30)', 'unMute()']).flat());
    expect(vi.getTimerCount()).toBe(0);
  });
});
