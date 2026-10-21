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

function fakeAnalyser(sampleRate = 48000): AnalyserNode {
  return {
    frequencyBinCount: 2048,
    fftSize: 4096,
    context: { sampleRate },
    smoothingTimeConstant: 0.8,
    getFloatFrequencyData(data: Float32Array) {
      mocks.reads++;
      data.fill(-100);
      for (let i = 0; (i * sampleRate) / 4096 < 140; i++) data[i] = mocks.bassDb;
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('screensaver bass glow', () => {
  it.each(['file', 'system-audio'] as const)(
    'makes ordinary %s bass perceptible with a fast attack and a slower release',
    (mode) => {
      setState('playback.mode', mode);
      const target = document.createElement('iframe');
      const stop = startScreensaverBassGlow(target, motionQuery() as unknown as MediaQueryList);
      vi.advanceTimersByTime(200);
      expect(target.style.filter).toBe('');

      mocks.bassDb = -60;
      vi.advanceTimersByTime(100);
      const attacked = brightness(target);
      expect(attacked).toBeGreaterThan(1.045);
      vi.advanceTimersByTime(400);
      const peak = brightness(target);
      expect(peak).toBeGreaterThanOrEqual(attacked);
      expect(peak).toBeGreaterThan(1.08);
      expect(peak).toBeLessThanOrEqual(1.16);

      mocks.bassDb = -100;
      vi.advanceTimersByTime(100);
      // 100 ms after the kick ends, most of the lift remains (release is slower than attack).
      expect(brightness(target) - 1).toBeGreaterThan((peak - 1) * 0.6);
      vi.advanceTimersByTime(4_000);
      expect(target.style.filter).toBe('');

      stop();
    },
  );

  it.each([44100, 48000, 96000])('keeps the bass response below 140 Hz at %i Hz', (sampleRate) => {
    mocks.analyser = fakeAnalyser(sampleRate);
    mocks.bassDb = -60;
    const target = document.createElement('div');
    const stop = startScreensaverBassGlow(target, motionQuery() as unknown as MediaQueryList);
    vi.advanceTimersByTime(500);
    expect(brightness(target)).toBeCloseTo(1.093, 2);
    stop();
  });

  it('rejects the noise floor and caps even over-range input at 16 percent', () => {
    const target = document.createElement('div');
    mocks.bassDb = -95;
    const stop = startScreensaverBassGlow(target, motionQuery() as unknown as MediaQueryList);
    vi.advanceTimersByTime(500);
    expect(target.style.filter).toBe('');

    mocks.bassDb = 40;
    vi.advanceTimersByTime(1_000);
    expect(brightness(target)).toBe(1.16);
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

  it.each([59.94, 60, 120])('keeps its 30Hz sampling phase on a %sHz display', (refreshRate) => {
    let queued: FrameRequestCallback | null = null;
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queued = callback;
      return ++frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      queued = null;
    });
    const times: number[] = [];
    let now = 0;
    const analyser = mocks.analyser!;
    const read = analyser.getFloatFrequencyData.bind(analyser);
    analyser.getFloatFrequencyData = (data) => {
      times.push(now);
      read(data);
    };
    const stop = startScreensaverBassGlow(
      document.createElement('div'),
      motionQuery() as unknown as MediaQueryList,
    );
    const frameMs = 1000 / refreshRate;
    for (let frame = 0; frame * frameMs < 10_000; frame++) {
      now = frame * frameMs;
      const callback = queued as FrameRequestCallback | null;
      queued = null;
      callback?.(now);
    }
    expect(times.length).toBeGreaterThanOrEqual(299);
    expect(times.length).toBeLessThanOrEqual(301);
    const gaps = times.slice(1).map((time, i) => time - times[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1000 / 30 + frameMs + 0.001);
    stop();
    expect(queued).toBeNull();
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

  it('clears the reaction while hidden and samples fresh audio on return', () => {
    const target = document.createElement('div');
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    mocks.bassDb = -60;
    const stop = startScreensaverBassGlow(target, motionQuery() as unknown as MediaQueryList);
    vi.advanceTimersByTime(300);
    expect(brightness(target)).toBeGreaterThan(1.08);

    hidden.mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(target.style.filter).toBe('');
    const reads = mocks.reads;
    vi.advanceTimersByTime(1_000);
    expect(mocks.reads).toBe(reads);
    expect(vi.getTimerCount()).toBe(0);

    mocks.bassDb = -100;
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(100);
    expect(target.style.filter).toBe('');
    expect(mocks.reads).toBeGreaterThan(reads);
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
