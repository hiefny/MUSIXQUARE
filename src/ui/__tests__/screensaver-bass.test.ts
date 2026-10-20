/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { startScreensaverBassGlow } from '../screensaver-bass.ts';

const mocks = vi.hoisted(() => ({
  analyser: null as AnalyserNode | null,
  bassDb: -100,
  reads: 0,
}));

vi.mock('../../audio/engine.ts', () => ({ getAnalyser: () => mocks.analyser }));

function fakeAnalyser(): AnalyserNode {
  return {
    frequencyBinCount: 2048,
    getFloatFrequencyData(data: Float32Array) {
      mocks.reads++;
      data.fill(-100);
      for (let i = 0; i < 12; i++) data[i] = mocks.bassDb;
    },
  } as unknown as AnalyserNode;
}

function motionQuery(matches = false) {
  const listeners = new Set<() => void>();
  return {
    matches,
    addEventListener: vi.fn((_: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_: string, listener: () => void) => listeners.delete(listener)),
    change(next: boolean) {
      this.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

function brightness(target: HTMLElement): number {
  const match = /^brightness\(([\d.]+)\)$/u.exec(target.style.filter);
  return match ? Number(match[1]) : 1;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
  resetState();
  setState('playback.mode', 'file');
  setState('playback.activity', 'playing');
  mocks.analyser = fakeAnalyser();
  mocks.bassDb = -100;
  mocks.reads = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('screensaver bass glow', () => {
  it('lifts brightness a few percent on bass with a fast attack and a slower release', () => {
    const target = document.createElement('iframe');
    const stop = startScreensaverBassGlow(target, motionQuery() as unknown as MediaQueryList);
    vi.advanceTimersByTime(200);
    expect(target.style.filter).toBe('');

    mocks.bassDb = -2;
    vi.advanceTimersByTime(100);
    const attacked = brightness(target);
    expect(attacked).toBeGreaterThan(1.03);
    vi.advanceTimersByTime(400);
    const peak = brightness(target);
    expect(peak).toBeGreaterThanOrEqual(attacked);
    expect(peak).toBeLessThanOrEqual(1.06);

    mocks.bassDb = -100;
    vi.advanceTimersByTime(100);
    // 100 ms after the kick ends, most of the lift remains (release is slower than attack).
    expect(brightness(target) - 1).toBeGreaterThan((peak - 1) * 0.6);
    vi.advanceTimersByTime(4_000);
    expect(target.style.filter).toBe('');

    stop();
  });

  it('samples the analyser at no more than 30 Hz', () => {
    const target = document.createElement('div');
    const stop = startScreensaverBassGlow(target, motionQuery() as unknown as MediaQueryList);
    vi.advanceTimersByTime(1_000);
    expect(mocks.reads).toBeGreaterThan(15);
    expect(mocks.reads).toBeLessThanOrEqual(31);
    stop();
  });

  it('stays unfiltered for reduced motion and turns off at once when it is enabled', () => {
    const target = document.createElement('div');
    const motion = motionQuery(true);
    mocks.bassDb = -2;
    const stop = startScreensaverBassGlow(target, motion as unknown as MediaQueryList);
    vi.advanceTimersByTime(500);
    expect(target.style.filter).toBe('');
    expect(mocks.reads).toBe(0);

    motion.change(false);
    vi.advanceTimersByTime(300);
    expect(brightness(target)).toBeGreaterThan(1);
    motion.change(true);
    vi.advanceTimersByTime(20);
    expect(target.style.filter).toBe('');
    stop();
  });

  it('never reacts to YouTube and idles while nothing plays', () => {
    const target = document.createElement('div');
    mocks.bassDb = -2;
    setState('playback.mode', 'youtube');
    const stop = startScreensaverBassGlow(target, motionQuery() as unknown as MediaQueryList);
    vi.advanceTimersByTime(500);
    expect(target.style.filter).toBe('');
    expect(mocks.reads).toBe(0);

    setState('playback.mode', 'file');
    vi.advanceTimersByTime(300);
    expect(brightness(target)).toBeGreaterThan(1);

    setState('playback.activity', 'paused');
    vi.advanceTimersByTime(4_000);
    expect(target.style.filter).toBe('');
    const reads = mocks.reads;
    vi.advanceTimersByTime(1_000);
    expect(mocks.reads).toBe(reads);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it('removes the filter and every listener when stopped', () => {
    const target = document.createElement('div');
    const motion = motionQuery();
    mocks.bassDb = -2;
    const listenersBefore = bus.debug();
    const stop = startScreensaverBassGlow(target, motion as unknown as MediaQueryList);
    vi.advanceTimersByTime(300);
    expect(brightness(target)).toBeGreaterThan(1);

    stop();
    expect(target.style.filter).toBe('');
    expect(motion.removeEventListener).toHaveBeenCalled();
    expect(bus.debug()).toEqual(listenersBefore);
    expect(vi.getTimerCount()).toBe(0);
  });
});
