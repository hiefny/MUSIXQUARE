/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { initSeekBar } from '../seekbar.ts';
import { getTrackPosition, seekTo } from '../../player/transport.ts';
import { clearFilePlaybackRuntime } from '../../player/file-playback-runtime.ts';
import { publishManagedFilePlaybackSource } from '../../player/__tests__/managed-file-playback-fixture.ts';

const QUEUE_ITEM_ID = '00000000-0000-4000-8000-000000000001';

vi.mock('../../player/transport.ts', () => ({
  fmtTime: vi.fn((seconds: number) => `fmt:${Math.floor(seconds)}`),
  getTrackPosition: vi.fn(() => 0),
  seekTo: vi.fn(),
}));

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.mocked(seekTo).mockClear();
  vi.mocked(getTrackPosition).mockReset().mockReturnValue(0);
  document.body.innerHTML = `
    <input id="seek-slider" type="range" value="0" max="120" />
    <span id="time-curr"></span>
    <span id="time-dur"></span>
  `;
});

describe('initSeekBar playback mode gates', () => {
  it('repaints duration from an exact managed file source', async () => {
    await publishManagedFilePlaybackSource(QUEUE_ITEM_ID, 345);
    try {
      initSeekBar();
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('playback.mode', 'file');

      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      expect(slider.max).toBe('345');
      expect(document.getElementById('time-dur')?.innerText).toBe('fmt:345');
    } finally {
      await clearFilePlaybackRuntime();
    }
  });

  it('does not repaint duration from a managed source owned by another queue item', async () => {
    await publishManagedFilePlaybackSource(QUEUE_ITEM_ID, 345);
    try {
      initSeekBar();
      setState('playlist.currentQueueItemId', '00000000-0000-4000-8000-000000000002');
      setState('playback.mode', 'file');

      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      expect(slider.max).toBe('120');
      expect(document.getElementById('time-dur')?.innerText).toBeUndefined();
    } finally {
      await clearFilePlaybackRuntime();
    }
  });

  it('blocks seek interaction while system audio owns playback', () => {
    setState('playback.mode', 'system-audio');
    setState('playback.activity', 'playing');
    initSeekBar();

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    slider.value = '30';
    slider.dispatchEvent(new Event('input'));
    expect(slider.value).toBe('0');

    slider.value = '45';
    slider.dispatchEvent(new Event('change'));
    expect(slider.value).toBe('0');
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('allows seek interaction for paused file playback', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    initSeekBar();

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    const current = document.getElementById('time-curr');

    slider.value = '42';
    slider.dispatchEvent(new Event('input'));
    expect(current?.innerText).toBe('fmt:42');
    expect(slider.getAttribute('aria-valuetext')).toBe('fmt:42');

    slider.dispatchEvent(new Event('change'));
    expect(seekTo).toHaveBeenCalledWith(42);
  });

  it('pins an admitted V2 host seek through rAF and the 250ms refresh until settlement', () => {
    vi.useFakeTimers();
    let nextFrame: FrameRequestCallback | null = null;
    let frameId = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        return ++frameId;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    try {
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
      vi.mocked(getTrackPosition).mockReturnValue(7);
      initSeekBar();
      bus.emit('ui:loop-start');

      bus.emit('player:v2-host-seek-pending', {
        token: 101,
        queueItemId: QUEUE_ITEM_ID,
        targetSeconds: 42,
      });

      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      expect(slider.value).toBe('42');
      expect(slider.getAttribute('aria-valuetext')).toBe('fmt:42');
      expect(document.getElementById('time-curr')?.innerText).toBe('fmt:42');

      const firstPendingFrame = nextFrame;
      if (!firstPendingFrame) throw new Error('seek rAF was not scheduled');
      firstPendingFrame(1_000);
      vi.advanceTimersByTime(250);
      const secondPendingFrame = nextFrame;
      if (!secondPendingFrame) throw new Error('seek rAF was not rescheduled');
      secondPendingFrame(1_250);

      expect(getTrackPosition).toHaveBeenCalledTimes(1);
      expect(slider.value).toBe('42');

      bus.emit('player:v2-host-seek-settled', {
        token: 100,
        queueItemId: QUEUE_ITEM_ID,
        status: 'superseded',
        positionSeconds: 7,
      });
      expect(slider.value).toBe('42');

      bus.emit('player:v2-host-seek-settled', {
        token: 101,
        queueItemId: QUEUE_ITEM_ID,
        status: 'committed',
        positionSeconds: 42.5,
      });
      expect(slider.value).toBe('42.5');
      expect(slider.getAttribute('aria-valuetext')).toBe('fmt:42');
      expect(document.getElementById('time-curr')?.innerText).toBe('fmt:42');
    } finally {
      bus.emit('player:stop-all-media');
      clearAllManagedTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('keeps a released pointer draft pinned through an rAF before V2 change admission', () => {
    vi.useFakeTimers();
    let nextFrame: FrameRequestCallback | null = null;
    let frameId = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        return ++frameId;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    try {
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
      vi.mocked(getTrackPosition).mockReturnValue(7);
      vi.mocked(seekTo).mockImplementationOnce((targetSeconds) => {
        bus.emit('player:v2-host-seek-pending', {
          token: 202,
          queueItemId: QUEUE_ITEM_ID,
          targetSeconds,
        });
      });
      initSeekBar();
      bus.emit('ui:loop-start');

      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      slider.dispatchEvent(new Event('pointerdown'));
      slider.value = '42';
      slider.dispatchEvent(new Event('input'));
      slider.dispatchEvent(new Event('pointerup'));

      expect(getState('player.isSeeking')).toBe(true);
      const frameBetweenReleaseAndChange = nextFrame;
      if (!frameBetweenReleaseAndChange) throw new Error('seek rAF was not scheduled');
      frameBetweenReleaseAndChange(1_000);
      expect(slider.value).toBe('42');

      slider.dispatchEvent(new Event('change'));

      expect(seekTo).toHaveBeenCalledOnce();
      expect(seekTo).toHaveBeenCalledWith(42);
      expect(getState('player.isSeeking')).toBe(false);
      expect(slider.value).toBe('42');
    } finally {
      bus.emit('player:stop-all-media');
      clearAllManagedTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('releases an uncommitted draft on cancellation, blur, fallback, and teardown', () => {
    vi.useFakeTimers();
    try {
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
      initSeekBar();
      const slider = document.getElementById('seek-slider') as HTMLInputElement;

      slider.dispatchEvent(new Event('pointerdown'));
      slider.dispatchEvent(new Event('pointercancel'));
      expect(getState('player.isSeeking')).toBe(false);

      slider.dispatchEvent(new Event('pointerdown'));
      slider.dispatchEvent(new Event('blur'));
      expect(getState('player.isSeeking')).toBe(false);

      slider.dispatchEvent(new Event('pointerdown'));
      slider.dispatchEvent(new Event('pointerup'));
      expect(getState('player.isSeeking')).toBe(true);
      vi.advanceTimersByTime(349);
      expect(getState('player.isSeeking')).toBe(true);
      vi.advanceTimersByTime(1);
      expect(getState('player.isSeeking')).toBe(false);

      slider.dispatchEvent(new Event('pointerdown'));
      bus.emit('ui:seek-reset');
      expect(getState('player.isSeeking')).toBe(false);

      slider.dispatchEvent(new Event('pointerdown'));
      bus.emit('player:stop-all-media');
      expect(getState('player.isSeeking')).toBe(false);
      expect(seekTo).not.toHaveBeenCalled();
    } finally {
      bus.emit('player:stop-all-media');
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });

  it('commits one keyboard change without a pointer event or duplicate seek', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    initSeekBar();

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    slider.value = '18';
    slider.dispatchEvent(new Event('input'));
    expect(getState('player.isSeeking')).toBe(true);

    slider.dispatchEvent(new Event('change'));
    slider.dispatchEvent(new Event('blur'));

    expect(seekTo).toHaveBeenCalledOnce();
    expect(seekTo).toHaveBeenCalledWith(18);
    expect(getState('player.isSeeking')).toBe(false);
  });

  it('blocks seek interaction while playback is idle', () => {
    setState('playback.mode', null);
    setState('playback.activity', 'idle');
    initSeekBar();

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    slider.value = '12';
    slider.dispatchEvent(new Event('change'));

    expect(slider.value).toBe('0');
    expect(seekTo).not.toHaveBeenCalled();
  });
});
