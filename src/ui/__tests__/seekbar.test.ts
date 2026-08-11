/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { initSeekBar } from '../seekbar.ts';
import { getTrackPosition, isFilePipelineBusyForPlay, seekTo } from '../../player/transport.ts';
import { isProPlaybackTrackSelectionPending } from '../../pro-room/playback-authority-hooks.ts';
import { STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES } from '../../network/standard-room-authority.ts';

const QUEUE_ITEM_ID = '10000000-0000-4000-8000-000000000001';

const zeroStartFacade = vi.hoisted(() => ({ active: false, inFlight: false }));

vi.mock('../../player/transport.ts', () => ({
  fmtTime: vi.fn((seconds: number) => `fmt:${Math.floor(seconds)}`),
  getTrackPosition: vi.fn(() => 0),
  isFilePipelineBusyForPlay: vi.fn(() => false),
  seekTo: vi.fn(),
}));

vi.mock('../../pro-room/playback-authority-hooks.ts', () => ({
  isProPlaybackTrackSelectionPending: vi.fn(() => false),
}));

vi.mock('../../youtube/zero-start.ts', () => ({
  isYouTubeZeroStartInFlight: vi.fn(() => zeroStartFacade.inFlight),
  isYouTubeZeroStartProtocolActive: vi.fn(() => zeroStartFacade.active),
}));

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.mocked(seekTo).mockClear();
  vi.mocked(getTrackPosition).mockReturnValue(0);
  vi.mocked(isFilePipelineBusyForPlay).mockReturnValue(false);
  vi.mocked(isProPlaybackTrackSelectionPending).mockReturnValue(false);
  zeroStartFacade.active = false;
  zeroStartFacade.inFlight = false;
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

  it('keeps physical host seek enabled through same-account sibling authority churn', () => {
    setState('network.appRole', 'host');
    setState('network.hostConn', null);
    setState('network.sessionCode', '123456');
    setState('setup.sessionStarted', true);
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    initSeekBar();

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    const expectHostSeekEnabled = () => {
      expect(getState('network.appRole')).toBe('host');
      expect(getState('network.hostConn')).toBeNull();
      expect(slider.getAttribute('aria-disabled')).toBe('false');
      expect(slider.hasAttribute('title')).toBe(false);
    };

    expectHostSeekEnabled();
    setState('network.standardRoomCapabilities', [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES]);
    expectHostSeekEnabled();
    setState('network.isOperator', true);
    expectHostSeekEnabled();
    setState('network.standardRoomCapabilities', null);
    expectHostSeekEnabled();
    setState('network.isOperator', false);
    expectHostSeekEnabled();

    slider.value = '42';
    slider.dispatchEvent(new Event('change'));
    expect(seekTo).toHaveBeenCalledWith(42);
  });

  it('restores and revokes seek with the exact host-account sibling capability projection', () => {
    setState('network.appRole', 'guest');
    setState('network.hostConn', { peer: 'host-1', open: true } as never);
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'paused');
    vi.mocked(getTrackPosition).mockReturnValue(21);
    initSeekBar();

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    expect(slider.getAttribute('aria-disabled')).toBe('true');

    setState('network.standardRoomCapabilities', [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES]);
    setState('network.isOperator', true);
    expect(slider.getAttribute('aria-disabled')).toBe('false');

    slider.value = '42';
    slider.dispatchEvent(new Event('change'));
    expect(seekTo).toHaveBeenCalledWith(42);

    vi.mocked(seekTo).mockClear();
    setState('network.standardRoomCapabilities', null);
    setState('network.isOperator', false);
    expect(slider.getAttribute('aria-disabled')).toBe('true');

    slider.value = '55';
    slider.dispatchEvent(new Event('change'));
    expect(slider.value).toBe('21');
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('releases host seek at PLAYING while zero-start finishes timeline calibration', () => {
    setState('network.appRole', 'host');
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    zeroStartFacade.active = true;
    zeroStartFacade.inFlight = true;
    initSeekBar();

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    expect(slider.getAttribute('aria-disabled')).toBe('true');

    // handlePlayerStateChange(PLAYING) closes iframe ownership immediately,
    // while the protocol identity remains active for its 2.75s calibration.
    zeroStartFacade.inFlight = false;
    bus.emit('youtube:sync-loading', false, 'zero-start');

    expect(zeroStartFacade.active).toBe(true);
    expect(slider.getAttribute('aria-disabled')).toBe('false');

    slider.value = '42';
    slider.dispatchEvent(new Event('change'));
    expect(seekTo).toHaveBeenCalledWith(42);
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

  it('blocks a seek while a PRO local-to-YouTube selection awaits server admission', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    vi.mocked(isProPlaybackTrackSelectionPending).mockReturnValue(true);
    vi.mocked(getTrackPosition).mockReturnValue(14);
    initSeekBar();

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    expect(slider.getAttribute('aria-disabled')).toBe('true');

    slider.value = '55';
    slider.dispatchEvent(new Event('input'));
    slider.dispatchEvent(new Event('change'));

    expect(slider.value).toBe('14');
    expect(getState('player.isSeeking')).toBe(false);
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('keeps seek blocked through the PRO media transition after server admission', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    vi.mocked(getTrackPosition).mockReturnValue(14);
    initSeekBar();

    bus.emit('pro-playback:transition-loading', true);
    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    expect(slider.getAttribute('aria-disabled')).toBe('true');

    slider.value = '55';
    slider.dispatchEvent(new Event('change'));
    expect(slider.value).toBe('14');
    expect(seekTo).not.toHaveBeenCalled();

    bus.emit('pro-playback:transition-loading', false);
    expect(slider.getAttribute('aria-disabled')).toBe('false');
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
