/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { initSeekBar } from '../seekbar.ts';
import { getTrackPosition, isFilePipelineBusyForPlay, seekTo } from '../../player/transport.ts';

const QUEUE_ITEM_ID = '10000000-0000-4000-8000-000000000001';

const boundedV1 = vi.hoisted(() => {
  const state: {
    snapshot: {
      active: boolean;
      role: 'host' | 'guest' | 'idle';
      current: {
        queueItemId: string;
        legacySessionId: number;
        state: 'ready';
        phase: 'playing' | 'paused' | 'stopped';
        positionSeconds: number;
        durationSeconds: number;
      } | null;
    };
    positionSeconds: number | null;
  } = {
    snapshot: { active: false, role: 'idle', current: null },
    positionSeconds: null,
  };
  return {
    state,
    product: {
      snapshot: vi.fn(() => state.snapshot),
      positionSeconds: vi.fn(() => state.positionSeconds),
    },
  };
});

vi.mock('../../player/transport.ts', () => ({
  fmtTime: vi.fn((seconds: number) => `fmt:${Math.floor(seconds)}`),
  getTrackPosition: vi.fn(() => 0),
  isFilePipelineBusyForPlay: vi.fn(() => false),
  seekTo: vi.fn(),
}));

vi.mock('../../player/legacy-bounded-file-v1-product.ts', () => ({
  legacyBoundedFileV1Product: boundedV1.product,
}));

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.mocked(seekTo).mockClear();
  vi.mocked(getTrackPosition).mockReturnValue(0);
  vi.mocked(isFilePipelineBusyForPlay).mockReturnValue(false);
  boundedV1.state.snapshot = { active: false, role: 'idle', current: null };
  boundedV1.state.positionSeconds = null;
  document.body.innerHTML = `
    <input id="seek-slider" type="range" value="0" max="120" />
    <span id="time-curr"></span>
    <span id="time-dur"></span>
  `;
});

describe('initSeekBar playback mode gates', () => {
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

  it('projects a missing playback-control permission before a guest can drag', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { peer: 'host-1', open: true } as never);
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    vi.mocked(getTrackPosition).mockReturnValue(21);
    initSeekBar();

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    expect(slider.getAttribute('aria-disabled')).toBe('true');

    slider.value = '42';
    slider.dispatchEvent(new Event('change'));

    expect(slider.value).toBe('21');
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('blocks a seek draft while a replacement file is still preparing', () => {
    setState('network.appRole', 'host');
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    vi.mocked(isFilePipelineBusyForPlay).mockReturnValue(true);
    vi.mocked(getTrackPosition).mockReturnValue(14);
    initSeekBar();

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    expect(slider.getAttribute('aria-disabled')).toBe('true');

    slider.value = '55';
    slider.dispatchEvent(new Event('input'));

    expect(slider.value).toBe('14');
    expect(getState('player.isSeeking')).toBe(false);
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('restores an AudioBuffer-free bounded timeline after system audio exits', () => {
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    setState('player.pausedAt', 83.25);
    setState('playback.mode', 'system-audio');
    setState('playback.activity', 'playing');
    boundedV1.state.snapshot = {
      active: true,
      role: 'host',
      current: {
        queueItemId: QUEUE_ITEM_ID,
        legacySessionId: 7,
        state: 'ready',
        phase: 'stopped',
        positionSeconds: 0,
        durationSeconds: 245.5,
      },
    };
    boundedV1.state.positionSeconds = 0;
    initSeekBar();

    setState('playback.activity', 'paused');
    setState('playback.mode', 'file');

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    expect(slider.max).toBe('245.5');
    expect(slider.value).toBe('83.25');
    expect(document.getElementById('time-curr')?.innerText).toBe('fmt:83');
    expect(document.getElementById('time-dur')?.innerText).toBe('fmt:245');
  });

  it('freezes file interpolation immediately at the exact paused position', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    vi.mocked(getTrackPosition).mockReturnValue(18.25);
    initSeekBar();
    bus.emit('ui:loop-start');

    setState('playback.activity', 'paused');

    expect((document.getElementById('seek-slider') as HTMLInputElement).value).toBe('18.25');
    expect(document.getElementById('time-curr')?.innerText).toBe('fmt:18');
  });

  it('pins a PRO seek target through stale time updates and the internal prepare reset', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    vi.mocked(seekTo).mockImplementationOnce((targetSeconds) => {
      bus.emit('pro-playback:ui-control-pending', {
        token: 41,
        kind: 'seek',
        queueItemId: QUEUE_ITEM_ID,
        targetSeconds,
        wasPlaying: true,
      });
    });
    initSeekBar();

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    const current = document.getElementById('time-curr');
    slider.value = '42';
    slider.dispatchEvent(new Event('input'));
    slider.dispatchEvent(new Event('change'));

    bus.emit('ui:time-update', 'fmt:7', 'fmt:120', 7, 120);
    bus.emit('ui:seek-reset');

    expect(slider.value).toBe('42');
    expect(current?.innerText).toBe('fmt:42');

    bus.emit('pro-playback:ui-control-settled', {
      token: 41,
      kind: 'seek',
      queueItemId: QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 42.25,
    });

    expect(slider.value).toBe('42.25');
    expect(current?.innerText).toBe('fmt:42');
  });

  it('holds an iOS-style pointer release draft until change admits the command', () => {
    vi.useFakeTimers();
    try {
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
      initSeekBar();

      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      slider.dispatchEvent(new Event('pointerdown'));
      slider.value = '33';
      slider.dispatchEvent(new Event('input'));
      slider.dispatchEvent(new Event('pointerup'));

      expect(getState('player.isSeeking')).toBe(true);
      vi.advanceTimersByTime(349);
      expect(getState('player.isSeeking')).toBe(true);

      slider.dispatchEvent(new Event('change'));
      expect(seekTo).toHaveBeenCalledWith(33);
      expect(getState('player.isSeeking')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a pending PRO seek when a different queue occurrence becomes current', () => {
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    initSeekBar();
    bus.emit('pro-playback:ui-control-pending', {
      token: 77,
      kind: 'seek',
      queueItemId: QUEUE_ITEM_ID,
      targetSeconds: 55,
      wasPlaying: true,
    });

    setState('playlist.currentQueueItemId', '20000000-0000-4000-8000-000000000002');
    bus.emit('ui:time-update', 'fmt:3', 'fmt:90', 3, 90);

    expect((document.getElementById('seek-slider') as HTMLInputElement).value).toBe('3');
  });

  it('does not flash to zero when a prepared PRO seek is rejected', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    initSeekBar();
    bus.emit('pro-playback:ui-control-pending', {
      token: 88,
      kind: 'seek',
      queueItemId: QUEUE_ITEM_ID,
      targetSeconds: 48,
      wasPlaying: true,
    });
    bus.emit('ui:seek-reset');
    bus.emit('pro-playback:ui-control-settled', {
      token: 88,
      kind: 'seek',
      queueItemId: QUEUE_ITEM_ID,
      status: 'failed',
    });

    expect((document.getElementById('seek-slider') as HTMLInputElement).value).toBe('48');
    expect(document.getElementById('time-curr')?.innerText).toBe('fmt:48');
  });

  it('pins the newest V2 seek through stale samples, reset, and stale settlement', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    initSeekBar();

    bus.emit('player:v2-host-seek-pending', {
      token: 101,
      queueItemId: QUEUE_ITEM_ID,
      targetSeconds: 37,
    });
    bus.emit('player:v2-host-seek-pending', {
      token: 102,
      queueItemId: QUEUE_ITEM_ID,
      targetSeconds: 64,
    });
    bus.emit('ui:time-update', 'fmt:8', 'fmt:120', 8, 120);
    bus.emit('ui:seek-reset');
    bus.emit('player:v2-host-seek-settled', {
      token: 101,
      queueItemId: QUEUE_ITEM_ID,
      status: 'superseded',
      positionSeconds: 8,
    });

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    expect(slider.value).toBe('64');
    expect(document.getElementById('time-curr')?.innerText).toBe('fmt:64');

    bus.emit('player:v2-host-seek-settled', {
      token: 102,
      queueItemId: QUEUE_ITEM_ID,
      status: 'committed',
      positionSeconds: 64.25,
    });

    expect(slider.value).toBe('64.25');
    expect(document.getElementById('time-curr')?.innerText).toBe('fmt:64');
  });

  it('settles PRO and V2 projections independently without repainting an older target', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    initSeekBar();

    bus.emit('pro-playback:ui-control-pending', {
      token: 201,
      kind: 'seek',
      queueItemId: QUEUE_ITEM_ID,
      targetSeconds: 21,
      wasPlaying: true,
    });
    bus.emit('player:v2-host-seek-pending', {
      token: 202,
      queueItemId: QUEUE_ITEM_ID,
      targetSeconds: 52,
    });
    bus.emit('pro-playback:ui-control-settled', {
      token: 201,
      kind: 'seek',
      queueItemId: QUEUE_ITEM_ID,
      status: 'applied',
      positionSeconds: 21,
    });

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    expect(slider.value).toBe('52');

    bus.emit('player:v2-host-seek-settled', {
      token: 202,
      queueItemId: QUEUE_ITEM_ID,
      status: 'committed',
      positionSeconds: 52.5,
    });

    expect(slider.value).toBe('52.5');
  });

  it('releases a pending V2 projection when the queue occurrence changes', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    initSeekBar();
    bus.emit('player:v2-host-seek-pending', {
      token: 301,
      queueItemId: QUEUE_ITEM_ID,
      targetSeconds: 75,
    });

    setState('playlist.currentQueueItemId', '20000000-0000-4000-8000-000000000002');
    bus.emit('ui:time-update', 'fmt:4', 'fmt:100', 4, 100);

    expect((document.getElementById('seek-slider') as HTMLInputElement).value).toBe('4');
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
