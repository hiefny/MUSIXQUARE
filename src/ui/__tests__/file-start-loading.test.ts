/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { isLocalFileStartPending } from '../../player/transport.ts';
import { createFileStartLoadingController } from '../file-start-loading.ts';

const source = vi.hoisted(() => ({
  context: null as AudioContext | null,
  pending: false,
  deadline: 0 as number | undefined,
}));

vi.mock('../../audio/context.ts', () => ({
  getExistingAudioContext: () => source.context,
}));
vi.mock('../../player/transport.ts', () => ({
  isLocalFileStartPending: vi.fn(() => source.pending),
  getLocalFilePendingStartDeadlineMs: () => source.deadline,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
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

  it('survives an unchanged first clock sample before the host deadline is published', () => {
    source.deadline = undefined;
    const startDeadline = performance.now() + 200;
    const changed = vi.fn();
    const controller = createFileStartLoadingController(changed);
    try {
      vi.advanceTimersByTime(16);
      expect(changed.mock.calls).toEqual([[true]]);

      // The host publishes its canonical deadline after the playing event.
      // Android's clock resumes advancing without emitting a statechange.
      source.deadline = startDeadline;
      Object.assign(source.context!, { currentTime: 0.1 });
      vi.advanceTimersByTime(100);
      expect(changed.mock.calls).toEqual([[true]]);
      source.pending = false;
      Object.assign(source.context!, { currentTime: 0.2 });
      vi.advanceTimersByTime(84);
      expect(changed.mock.calls).toEqual([[true], [false]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.destroy();
    }
  });

  it('backs off a frozen running clock and detects recovery without another event', () => {
    source.deadline = undefined;
    const changed = vi.fn();
    const controller = createFileStartLoadingController(changed);
    try {
      vi.advanceTimersByTime(60_000);
      expect(changed.mock.calls).toEqual([[true]]);
      expect(vi.mocked(isLocalFileStartPending).mock.calls.length).toBeLessThan(70);
      expect(vi.getTimerCount()).toBe(1);
      source.pending = false;
      Object.assign(source.context!, { currentTime: 60 });
      vi.advanceTimersByTime(1_000);
      expect(changed.mock.calls).toEqual([[true], [false]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.destroy();
    }
  });

  it('stops checking a suspended context and reconciles when it resumes', () => {
    const changed = vi.fn();
    const controller = createFileStartLoadingController(changed);
    try {
      Object.assign(source.context!, { state: 'suspended' });
      source.context?.dispatchEvent(new Event('statechange'));
      vi.advanceTimersByTime(60_000);
      expect(changed.mock.calls).toEqual([[true]]);
      expect(vi.getTimerCount()).toBe(0);
      source.pending = false;
      Object.assign(source.context!, { state: 'running', currentTime: 0.2 });
      source.context?.dispatchEvent(new Event('statechange'));
      expect(changed.mock.calls).toEqual([[true], [false]]);
    } finally {
      controller.destroy();
    }
  });

  it('replaces a stalled context and ignores state changes from the retired context', () => {
    source.deadline = undefined;
    const changed = vi.fn();
    const controller = createFileStartLoadingController(changed);
    try {
      vi.advanceTimersByTime(5_000);
      const previousContext = source.context;
      source.context = Object.assign(new EventTarget(), {
        state: 'running',
        currentTime: 0,
      }) as AudioContext;
      source.deadline = performance.now() + 200;
      bus.emit('audio:ready');
      source.pending = false;
      previousContext?.dispatchEvent(new Event('statechange'));
      expect(changed.mock.calls).toEqual([[true]]);
      vi.advanceTimersByTime(200);
      expect(changed.mock.calls).toEqual([[true], [false]]);
      expect(vi.getTimerCount()).toBe(0);
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

  it('cancels a stalled retry when playback pauses or the controller is destroyed', () => {
    source.deadline = undefined;
    const changed = vi.fn();
    const controller = createFileStartLoadingController(changed);
    vi.advanceTimersByTime(5_000);
    source.pending = false;
    bus.emit('state:playback.activity', 'paused', 'playback.activity');
    expect(changed.mock.calls).toEqual([[true], [false]]);
    expect(vi.getTimerCount()).toBe(0);

    source.pending = true;
    bus.emit('state:playback.activity', 'playing', 'playback.activity');
    vi.advanceTimersByTime(5_000);
    controller.destroy();
    source.pending = false;
    Object.assign(source.context!, { currentTime: 60 });
    vi.advanceTimersByTime(60_000);
    expect(changed.mock.calls).toEqual([[true], [false], [true]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
