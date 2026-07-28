import { describe, expect, it, vi } from 'vitest';

import type { ClockQuality } from '../../network/clock-estimator.ts';
import { FilePlaybackClock } from '../file-playback-clock.ts';
import {
  FilePlaybackRoomClock,
  type FilePlaybackRoomClockProvider,
} from '../file-playback-room-clock.ts';

const quality: ClockQuality = {
  calibrated: true,
  offsetMs: 0,
  minRttMs: 0,
  rttP95Ms: 0,
  offsetSpreadMs: 0,
  sampleCount: 1,
  ageMs: 0,
};

function provider(now = 1_000): FilePlaybackRoomClockProvider {
  return {
    nowRoomTimeMs: () => now,
    quality: () => quality,
    handleWake: vi.fn(),
    bindAudioContext: (context) => ({
      nowRoomTimeMs: () => now,
      roomTimeMsToContextTime: (roomTimeMs) => context.currentTime + (roomTimeMs - now) / 1_000,
      localPerformanceMsToContextTime: (localTimeMs) =>
        context.currentTime + (localTimeMs - now) / 1_000,
    }),
  };
}

describe('FilePlaybackRoomClock', () => {
  it('publishes a calibrated host clock for the active room', () => {
    let now = 2_000;
    const room = new FilePlaybackRoomClock({
      createHostClock: () => new FilePlaybackClock({ now: () => now }),
    });
    const lease = room.beginHostSession();
    expect(lease.role).toBe('host');
    expect(room.role()).toBe('host');
    expect(room.nowRoomTimeMs()).toBe(2_000);
    expect(room.quality()).toMatchObject({ calibrated: true, offsetMs: 0 });

    now = 2_100;
    expect(room.nowRoomTimeMs()).toBe(2_100);
  });

  it('revokes every old AudioContext mapping on guest replacement', () => {
    const room = new FilePlaybackRoomClock();
    const oldLease = room.bindGuestSession(provider(1_000));
    const context = { currentTime: 5 } as AudioContext;
    const old = room.bindAudioContext(context);
    expect(old.roomTimeMsToContextTime(1_200)).toBeCloseTo(5.2, 10);

    const currentLease = room.bindGuestSession(provider(10_000));
    expect(room.role()).toBe('guest');
    expect(() => old.nowRoomTimeMs()).toThrow('FILE_PLAYBACK_ROOM_CLOCK_REVOKED');
    expect(room.clear(oldLease)).toBe(false);
    expect(room.clear(currentLease)).toBe(true);
    expect(() => room.nowRoomTimeMs()).toThrow('FILE_PLAYBACK_ROOM_CLOCK_UNAVAILABLE');
  });

  it('forwards wake only to the exact active provider', () => {
    const room = new FilePlaybackRoomClock();
    const first = provider();
    const second = provider();
    room.bindGuestSession(first);
    room.bindGuestSession(second);
    room.handleWake();

    expect(first.handleWake).not.toHaveBeenCalled();
    expect(second.handleWake).toHaveBeenCalledOnce();
  });

  it('rejects incomplete providers without disturbing the active clock', () => {
    const room = new FilePlaybackRoomClock();
    room.bindGuestSession(provider(50));
    expect(() => room.bindGuestSession({ nowRoomTimeMs: () => 2 } as never)).toThrow(TypeError);
    expect(room.nowRoomTimeMs()).toBe(50);
  });
});
