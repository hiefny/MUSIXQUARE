/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { createFileStartLoadingController } from '../file-start-loading.ts';

const source = vi.hoisted(() => ({
  context: null as AudioContext | null,
  pending: false,
  deadline: 0,
}));

vi.mock('../../audio/context.ts', () => ({
  getExistingAudioContext: () => source.context,
}));
vi.mock('../../player/transport.ts', () => ({
  isLocalFileStartPending: () => source.pending,
  getLocalFilePendingStartDeadlineMs: () => source.deadline,
}));

beforeEach(() => {
  vi.useFakeTimers();
  bus.clear();
  source.context = Object.assign(new EventTarget(), {
    state: 'running',
    currentTime: 0,
  }) as AudioContext;
  source.pending = true;
  source.deadline = performance.now() + 200;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  bus.clear();
});

describe('scheduled local-file loading projection', () => {
  it('keeps loading until the scheduled source starts even without another lifecycle change', () => {
    const changed = vi.fn();
    const controller = createFileStartLoadingController(changed);
    try {
      vi.advanceTimersByTime(199);
      expect(changed.mock.calls).toEqual([[true]]);
      source.pending = false;
      vi.advanceTimersByTime(1);
      expect(changed.mock.calls).toEqual([[true], [false]]);
    } finally {
      controller.destroy();
    }
  });

  it('cancels an old deadline when pause or a mode change removes the source', () => {
    const changed = vi.fn();
    const controller = createFileStartLoadingController(changed);
    try {
      source.pending = false;
      bus.emit('state:playback.activity', 'paused', 'playback.activity');
      vi.advanceTimersByTime(500);
      expect(changed.mock.calls).toEqual([[true], [false]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.destroy();
    }
  });

  it('replaces the timer when a newer scheduled start supersedes it', () => {
    const changed = vi.fn();
    const controller = createFileStartLoadingController(changed);
    try {
      vi.advanceTimersByTime(100);
      source.deadline = performance.now() + 200;
      bus.emit('state:player.startedAt', 0.3, 'player.startedAt');
      vi.advanceTimersByTime(100);
      expect(changed.mock.calls).toEqual([[true]]);
      source.pending = false;
      vi.advanceTimersByTime(100);
      expect(changed.mock.calls).toEqual([[true], [false]]);
    } finally {
      controller.destroy();
    }
  });

  it('stops polling a frozen clock and reconciles when the audio context resumes', () => {
    const changed = vi.fn();
    const controller = createFileStartLoadingController(changed);
    try {
      vi.advanceTimersByTime(60_000);
      expect(changed.mock.calls).toEqual([[true]]);
      expect(vi.getTimerCount()).toBe(0);
      source.pending = false;
      source.context?.dispatchEvent(new Event('statechange'));
      expect(changed.mock.calls).toEqual([[true], [false]]);
    } finally {
      controller.destroy();
    }
  });

  it('removes pending timers and subscriptions when the UI is reinitialized', () => {
    const changed = vi.fn();
    const controller = createFileStartLoadingController(changed);
    controller.destroy();
    source.pending = false;
    bus.emit('state:playback.activity', 'paused', 'playback.activity');
    source.context?.dispatchEvent(new Event('statechange'));
    vi.advanceTimersByTime(500);
    expect(changed.mock.calls).toEqual([[true]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
