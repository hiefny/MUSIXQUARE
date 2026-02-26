import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setManagedTimer,
  clearManagedTimer,
  clearAllManagedTimers,
  getManagedTimer,
} from '../timers.ts';

beforeEach(() => {
  vi.useFakeTimers();
  clearAllManagedTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Managed Timers', () => {
  it('runs a timeout after delay', () => {
    const fn = vi.fn();
    setManagedTimer('chunkWatchdog', fn, 1000);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs an interval repeatedly', () => {
    const fn = vi.fn();
    setManagedTimer('heartbeatMonitor', fn, 500, { interval: true });
    vi.advanceTimersByTime(1500);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('clears a timer by name', () => {
    const fn = vi.fn();
    setManagedTimer('syncDebounce', fn, 1000);
    clearManagedTimer('syncDebounce');
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('replaces existing timer when set again', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    setManagedTimer('autoPlayTimer', fn1, 1000);
    setManagedTimer('autoPlayTimer', fn2, 1000);
    vi.advanceTimersByTime(1000);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('getManagedTimer returns timer ID or null', () => {
    expect(getManagedTimer('chunkWatchdog')).toBeNull();
    setManagedTimer('chunkWatchdog', () => {}, 1000);
    expect(getManagedTimer('chunkWatchdog')).not.toBeNull();
  });

  it('clearAllManagedTimers clears everything', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    setManagedTimer('chunkWatchdog', fn1, 1000);
    setManagedTimer('heartbeatMonitor', fn2, 1000);
    clearAllManagedTimers();
    vi.advanceTimersByTime(2000);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
    expect(getManagedTimer('chunkWatchdog')).toBeNull();
    expect(getManagedTimer('heartbeatMonitor')).toBeNull();
  });
});
