import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertHardMutedWarmupOrder,
  makeFakeYtPlayer,
  mutationOps,
} from './__helpers__/fake-yt-player.ts';

describe('fake YouTube player zero-start support', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves hard mute and volume state across a warmup sequence', () => {
    const player = makeFakeYtPlayer({ __autoPlayOnLoad: true });

    player.mute();
    expect(player.isMuted()).toBe(true);
    player.setVolume(0);
    expect(player.getVolume()).toBe(0);

    player.loadVideoById('NEXT_VIDEO');
    expect(player.getVideoData().video_id).toBe('NEXT_VIDEO');
    expect(player.getPlayerState()).toBe(1);

    player.pauseVideo();
    player.seekTo(0, true);
    player.setVolume(100);
    player.unMute();

    expect(player.getPlayerState()).toBe(2);
    expect(player.getCurrentTime()).toBe(0);
    expect(player.getVolume()).toBe(100);
    expect(player.isMuted()).toBe(false);
    expect(() => assertHardMutedWarmupOrder(player)).not.toThrow();
  });

  it('advances currentTime only while playing when the opt-in clock is enabled', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'));
    const player = makeFakeYtPlayer({
      __state: 2,
      __currentTime: 4,
      __advanceClock: true,
    });

    player.playVideo();
    vi.advanceTimersByTime(1_250);
    expect(player.getCurrentTime()).toBeCloseTo(5.25, 5);

    player.pauseVideo();
    vi.advanceTimersByTime(2_000);
    expect(player.getCurrentTime()).toBeCloseTo(5.25, 5);

    player.seekTo(12, true);
    player.playVideo();
    vi.advanceTimersByTime(500);
    expect(player.getCurrentTime()).toBeCloseTo(12.5, 5);
  });

  it('can notify deterministic state transitions without changing legacy call logs', () => {
    const states: number[] = [];
    const player = makeFakeYtPlayer({
      __onStateChange: ({ data }) => states.push(data),
    });

    player.__setState(3);
    player.__setState(1);
    player.__setState(2, false);

    expect(states).toEqual([3, 1]);
    expect(mutationOps(player)).toEqual([]);
  });

  it('can delay or permanently fail hard mute for fallback tests', () => {
    vi.useFakeTimers();
    const delayed = makeFakeYtPlayer({ __hardMuteDelayMs: 120 });
    delayed.mute();
    expect(delayed.isMuted()).toBe(false);
    vi.advanceTimersByTime(119);
    expect(delayed.isMuted()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(delayed.isMuted()).toBe(true);

    const failed = makeFakeYtPlayer({ __hardMuteFails: true });
    failed.mute();
    vi.runAllTimers();
    expect(failed.isMuted()).toBe(false);
  });

  it('answers a fixed call script exactly as before the fault knobs existed (pinned 2026-10-30)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const notified: number[] = [];
    const player = makeFakeYtPlayer({
      __state: 2,
      __currentTime: 0,
      __onStateChange: ({ data }) => notified.push(data),
    });
    const samples: Array<[boolean, number, number]> = [];
    const sample = () =>
      samples.push([player.isMuted(), player.getVolume(), player.getPlayerState()]);

    player.mute();
    sample();
    vi.advanceTimersByTime(30);
    player.setVolume(40);
    player.seekTo(12, true);
    sample();
    vi.advanceTimersByTime(90);
    player.unMute();
    sample();
    player.playVideo();
    vi.advanceTimersByTime(120);
    player.pauseVideo();
    sample();

    expect(player.__log).toEqual([
      { op: 'mute', at: 1_000_000 },
      { op: 'setVolume', args: [40], at: 1_000_030 },
      { op: 'seekTo', args: [12, true], at: 1_000_030 },
      { op: 'unMute', at: 1_000_120 },
      { op: 'playVideo', at: 1_000_120 },
      { op: 'pauseVideo', at: 1_000_240 },
    ]);
    expect(samples).toEqual([
      [true, 100, 2],
      [true, 40, 2],
      [false, 40, 2],
      [false, 40, 2],
    ]);
    // Only play and pause notify; the seek stays silent.
    expect(notified).toEqual([1, 2]);
  });

  it('keeps a player muted through as many unMute calls as the ignore knob counts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const once = makeFakeYtPlayer({ __muted: true, __unMuteIgnoreCount: 1 });
    once.unMute();
    expect(once.isMuted()).toBe(true);
    expect(once.__unMuteIgnoreCount).toBe(0);
    vi.advanceTimersByTime(120);
    once.unMute();
    expect(once.isMuted()).toBe(false);
    expect(once.__log).toEqual([
      { op: 'unMute', at: 1_000_000 },
      { op: 'unMute', at: 1_000_120 },
    ]);

    const twice = makeFakeYtPlayer({ __muted: true, __unMuteIgnoreCount: 2 });
    twice.unMute();
    twice.unMute();
    expect(twice.isMuted()).toBe(true);
    twice.unMute();
    expect(twice.isMuted()).toBe(false);
  });

  it('turns isMuted false only when the unMute delay elapses, and lets a later mute win', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const delayed = makeFakeYtPlayer({ __muted: true, __unMuteDelayMs: 250 });
    delayed.unMute();
    vi.advanceTimersByTime(249);
    expect(delayed.isMuted()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(delayed.isMuted()).toBe(false);

    const cancelled = makeFakeYtPlayer({ __muted: true, __unMuteDelayMs: 250 });
    cancelled.unMute();
    vi.advanceTimersByTime(100);
    cancelled.mute();
    vi.advanceTimersByTime(400);
    expect(cancelled.isMuted()).toBe(true);
    expect(cancelled.__log).toEqual([
      { op: 'unMute', at: 1_000_250 },
      { op: 'mute', at: 1_000_350 },
    ]);
  });

  it('restarts the unMute delay on every accepted unMute, so a retry inside the delay pushes it back (pinned 2026-10-31)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const retried = makeFakeYtPlayer({ __muted: true, __unMuteDelayMs: 250 });
    retried.unMute();
    vi.advanceTimersByTime(120);
    // A restore loop's retry, one 120 ms verify cycle later.
    retried.unMute();
    // The first unmute (due at +250) was superseded by the retry.
    vi.advanceTimersByTime(249);
    expect(retried.isMuted()).toBe(true);
    // The retry lands 250 ms after it was issued: +120 + 250 = +370.
    vi.advanceTimersByTime(1);
    expect(retried.isMuted()).toBe(false);
    expect(retried.__log).toEqual([
      { op: 'unMute', at: 1_000_000 },
      { op: 'unMute', at: 1_000_120 },
    ]);
  });

  it('reads NaN or throws from getVolume when the volume read fault is set', () => {
    const nan = makeFakeYtPlayer({ __volume: 60, __volumeReadFault: 'nan' });
    expect(nan.getVolume()).toBeNaN();
    const throwing = makeFakeYtPlayer({ __volume: 60, __volumeReadFault: 'throw' });
    expect(() => throwing.getVolume()).toThrow('Fake getVolume read fault');
    // The fault is read at call time, also through a copied method reference.
    const getVolume = throwing.getVolume;
    throwing.__volumeReadFault = null;
    expect(getVolume()).toBe(60);
  });

  it('applies an unMute and then throws, as many times as the throw knob counts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const throwing = makeFakeYtPlayer({ __muted: true, __unMuteThrowCount: 1 });
    expect(() => throwing.unMute()).toThrow('Fake unMute command fault');
    expect(throwing.isMuted()).toBe(false);
    expect(throwing.__unMuteThrowCount).toBe(0);
    throwing.mute();
    expect(() => throwing.unMute()).not.toThrow();
    expect(throwing.isMuted()).toBe(false);
    expect(throwing.__log).toEqual([
      { op: 'unMute', at: 1_000_000 },
      { op: 'mute', at: 1_000_000 },
      { op: 'unMute', at: 1_000_000 },
    ]);

    // An ignored unMute neither throws nor counts the throw knob down.
    const ignored = makeFakeYtPlayer({
      __muted: true,
      __unMuteIgnoreCount: 1,
      __unMuteThrowCount: 1,
    });
    expect(() => ignored.unMute()).not.toThrow();
    expect(ignored.isMuted()).toBe(true);
    expect(ignored.__unMuteThrowCount).toBe(1);
    expect(() => ignored.unMute()).toThrow('Fake unMute command fault');
    expect(ignored.isMuted()).toBe(false);
  });

  it('delivers exactly the listed seek states, in order, through onStateChange', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const notified: number[] = [];
    const player = makeFakeYtPlayer({
      __state: 2,
      __seekStateSequence: [3, 2],
      __onStateChange: ({ data }) => notified.push(data),
    });
    player.seekTo(30, true);
    expect(notified).toEqual([3, 2]);
    expect(player.getPlayerState()).toBe(2);
    expect(player.getCurrentTime()).toBe(30);
    expect(player.__log).toEqual([{ op: 'seekTo', args: [30, true], at: 1_000_000 }]);

    player.__seekStateSequence = [];
    player.seekTo(31, true);
    expect(notified).toEqual([3, 2]);
  });

  it('reports a useful operation trace when warmup ordering regresses', () => {
    const player = makeFakeYtPlayer();
    player.loadVideoById('NEXT_VIDEO');
    player.mute();
    player.pauseVideo();
    player.seekTo(0, true);
    player.unMute();

    expect(() => assertHardMutedWarmupOrder(player)).toThrow(
      'loadVideoById -> mute -> pauseVideo -> seekTo -> unMute',
    );
  });
});
