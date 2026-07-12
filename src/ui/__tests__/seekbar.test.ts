/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { initSeekBar } from '../seekbar.ts';
import { seekTo } from '../../player/transport.ts';
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
