/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processSyncPong, registerPing, resetClockState } from '../../network/shared-clock.ts';
import { captureGuestFilePlayTiming, resolveFilePlayTiming } from '../file-play-timing.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  resetClockState();
  vi.spyOn(performance, 'now').mockReturnValue(10_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetClockState();
});

function calibrateHostOffset(offset: number): void {
  registerPing(1);
  processSyncPong(1, Date.now() + offset);
}

describe('local-file shared start timeline', () => {
  it('keeps time zero intact after network delivery and a decode that finishes before the start', () => {
    calibrateHostOffset(50_000);
    // Host chose 51200; delivery consumed 50ms of the 200ms window.
    vi.setSystemTime(1_050);
    const timeline = captureGuestFilePlayTiming({ hostStartAt: 51_200, hostPlayAt: 51_400 }, 0);
    vi.setSystemTime(1_125);

    expect(resolveFilePlayTiming(timeline.time, timeline.setAt)).toEqual({
      offset: 0,
      scheduleDelay: 0.075,
      scheduleDeadlineMs: 10_075,
    });
  });

  it('joins at the elapsed host position after a long decode without counting the lead', () => {
    calibrateHostOffset(50_000);
    vi.setSystemTime(1_050);
    const timeline = captureGuestFilePlayTiming({ hostStartAt: 51_200 }, 12);
    vi.setSystemTime(4_700);

    expect(resolveFilePlayTiming(timeline.time, timeline.setAt)).toEqual({
      offset: 15.5,
      scheduleDelay: 0,
      scheduleDeadlineMs: 10_000,
    });
  });

  it('preserves older hosts command-time semantics through late decode', () => {
    calibrateHostOffset(50_000);
    vi.setSystemTime(1_050);
    const timeline = captureGuestFilePlayTiming({ hostPlayAt: 51_200 }, 12);
    vi.setSystemTime(1_700);

    expect(resolveFilePlayTiming(timeline.time, timeline.setAt).offset).toBeCloseTo(12.7);
  });

  it('does not turn a cold clock difference into a wait or a seek', () => {
    const timeline = captureGuestFilePlayTiming({ hostStartAt: 5_000_000 }, 0);
    expect(timeline.needsClockSync).toBe(true);
    expect(resolveFilePlayTiming(timeline.time, timeline.setAt)).toEqual({
      offset: 0,
      scheduleDelay: 0.2,
      scheduleDeadlineMs: 10_200,
    });
  });

  it('includes connection-routing time for untimed late-join PLAY', () => {
    const timeline = captureGuestFilePlayTiming({}, 12);
    vi.setSystemTime(2_500);
    expect(resolveFilePlayTiming(timeline.time, timeline.setAt).offset).toBe(13.5);
  });
});
