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
