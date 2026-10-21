/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { initSeekBar } from '../seekbar.ts';
import { installRangeDragGuard } from '../range-drag.ts';
import { getTrackPosition, isFilePipelineBusyForPlay, seekTo } from '../../player/transport.ts';
import { isProPlaybackTrackSelectionPending } from '../../pro-room/playback-authority-hooks.ts';
import { STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES } from '../../network/standard-room-authority.ts';
import { t } from '../../i18n/index.ts';

const QUEUE_ITEM_ID = '10000000-0000-4000-8000-000000000001';

function seekPointer(type: string, pointerId: number, clientX = 200): MouseEvent {
  const event = new MouseEvent(type, { button: 0, clientX, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

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
  it('repaints authoritative position changes while file playback remains paused', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    initSeekBar();
    setState('player.pausedAt', 42);
    expect((document.getElementById('seek-slider') as HTMLInputElement).value).toBe('42');
    expect(document.getElementById('time-curr')?.innerText).toBe('fmt:42');
    setState('player.pausedAt', 17);
    expect((document.getElementById('seek-slider') as HTMLInputElement).value).toBe('17');
  });

  it('restores a paused late join position when decoding publishes the duration', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    setState('player.pausedAt', 240);
    initSeekBar();
    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    slider.max = '0';
    bus.emit('ui:seek-reset');
    expect(slider.value).toBe('0');
    bus.emit('ui:duration-update', 600);
    expect(slider.value).toBe('240');
    expect(document.getElementById('time-curr')?.innerText).toBe('fmt:240');
  });

  it('does not overwrite a playing timeline when its stored resume position changes', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    initSeekBar();
    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    slider.value = '50';
    setState('player.pausedAt', 10);
    bus.emit('ui:duration-update', 600);
    expect(slider.value).toBe('50');
  });

  it('keeps the current seek draft when a paused update arrives', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'paused');
    initSeekBar();
    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    slider.value = '50';
    setState('player.isSeeking', true);
    setState('player.pausedAt', 10);
    bus.emit('ui:duration-update', 600);
    expect(slider.value).toBe('50');
  });

  it('cancels its animation without cancelling an unrelated timer with the same handle', () => {
    vi.useFakeTimers();
    const unrelatedTimer = vi.fn();
    const timerId = window.setTimeout(unrelatedTimer, 20);
    const cancelFrame = vi.fn();
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => timerId),
    );
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    try {
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
      initSeekBar();
      bus.emit('ui:loop-start');
      bus.emit('ui:seek-reset');

      expect(cancelFrame).toHaveBeenCalledWith(timerId);
      vi.advanceTimersByTime(20);
      expect(unrelatedTimer).toHaveBeenCalledOnce();
    } finally {
      bus.emit('ui:seek-reset');
      clearAllManagedTimers();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('cancels its system-audio timer without cancelling an unrelated animation with the same handle', () => {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 17;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => frames.delete(id)),
    );
    const scheduleTimeout = window.setTimeout.bind(window);
    // Vitest can expose Node-style timer objects; browsers return numeric IDs.
    const timeouts = vi
      .spyOn(window, 'setTimeout')
      .mockImplementation(
        (handler, delay) =>
          Number(scheduleTimeout(handler, delay)) as unknown as ReturnType<
            typeof window.setTimeout
          >,
      );
    try {
      setState('playback.mode', 'system-audio');
      setState('playback.activity', 'playing');
      initSeekBar();
      bus.emit('ui:loop-start');
      const firstFrame = frames.get(17)!;
      frames.delete(17);
      firstFrame(0);
      const pollIndex = timeouts.mock.calls.findIndex(([, delay]) => delay === 1000);
      expect(pollIndex).toBeGreaterThanOrEqual(0);
      const pollTimerId = timeouts.mock.results[pollIndex]!.value as number;
      nextFrameId = pollTimerId;
      const unrelatedAnimation = vi.fn();
      requestAnimationFrame(unrelatedAnimation);

      bus.emit('ui:seek-reset');
      expect(frames.has(pollTimerId)).toBe(true);
      frames.get(pollTimerId)!(20);
      expect(unrelatedAnimation).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1000);
      expect(requestFrame).toHaveBeenCalledTimes(2);
    } finally {
      bus.emit('ui:seek-reset');
      clearAllManagedTimers();
      timeouts.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
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
    expect(slider.max).toBe('0');
    expect(slider.getAttribute('aria-valuetext')).toBe(t('player.seek_unavailable_system_audio'));
    expect(document.getElementById('time-curr')?.innerText).toBe('-:--');
    expect(document.getElementById('time-dur')?.innerText).toBe('-:--');
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
    // The tooltip keeps the toast's sentence line break, which replaces a period.
    expect(slider.title).toBe(t('toast.sync_not_ready'));
    expect(slider.title).toContain('\n');

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
      slider.dispatchEvent(seekPointer('pointerdown', 1));
      slider.value = '33';
      slider.dispatchEvent(new Event('input'));
      slider.dispatchEvent(seekPointer('pointerup', 1));

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

  it.each(['pointerup', 'lostpointercapture', 'pointercancel'])(
    'keeps the current seek draft when a second finger emits %s',
    (terminalEvent) => {
      vi.useFakeTimers();
      vi.stubGlobal('PointerEvent', MouseEvent);
      try {
        setState('playback.mode', 'file');
        setState('playback.activity', 'playing');
        initSeekBar();
        installRangeDragGuard();
        const slider = document.getElementById('seek-slider') as HTMLInputElement;
        vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 40));
        slider.dispatchEvent(seekPointer('pointerdown', 1));
        slider.dispatchEvent(seekPointer('pointerdown', 2, 320));
        slider.dispatchEvent(seekPointer(terminalEvent, 2, 320));
        // Native pointer-enabled browsers also emit compatibility touchend.
        slider.dispatchEvent(new Event('touchend'));
        vi.advanceTimersByTime(850);

        expect(slider.classList.contains('is-dragging')).toBe(true);
        expect(getState('player.isSeeking')).toBe(true);
        expect(slider.value).toBe('60');
        expect(seekTo).not.toHaveBeenCalled();

        slider.dispatchEvent(seekPointer('pointerup', 1));
        expect(slider.classList.contains('is-dragging')).toBe(false);
        expect(getState('player.isSeeking')).toBe(false);
        expect(seekTo).toHaveBeenCalledExactlyOnceWith(60);
      } finally {
        clearAllManagedTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    },
  );

  it('releases the owning cancelled pointer and accepts the next gesture', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    initSeekBar();
    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    slider.dispatchEvent(seekPointer('pointerdown', 1));
    slider.dispatchEvent(seekPointer('pointercancel', 1));
    expect(getState('player.isSeeking')).toBe(false);
    slider.dispatchEvent(seekPointer('pointerdown', 2));
    expect(getState('player.isSeeking')).toBe(true);
    slider.dispatchEvent(seekPointer('pointercancel', 2));
    expect(getState('player.isSeeking')).toBe(false);
  });

  it('retires an old seek drag when a different queue occurrence becomes current', () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    try {
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      initSeekBar();
      installRangeDragGuard();
      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 40));
      slider.dispatchEvent(seekPointer('pointerdown', 1, 200));

      // Remote selection or automatic advancement completes before release.
      bus.emit('ui:seek-reset');
      setState('playlist.currentQueueItemId', '20000000-0000-4000-8000-000000000002');
      bus.emit('ui:duration-update', 180);
      vi.mocked(getTrackPosition).mockReturnValue(3);
      slider.dispatchEvent(seekPointer('pointermove', 1, 300));
      slider.dispatchEvent(seekPointer('pointerup', 1, 300));

      expect(seekTo).not.toHaveBeenCalled();
      expect(getState('player.isSeeking')).toBe(false);
      expect(slider.value).toBe('3');

      slider.dispatchEvent(seekPointer('pointerdown', 2, 200));
      slider.dispatchEvent(seekPointer('pointerup', 2, 200));
      expect(seekTo).toHaveBeenCalledExactlyOnceWith(90);
    } finally {
      clearAllManagedTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it.each([true, false])(
    'does not revive a held pointer after playback permission returns (initial grant: %s)',
    (initiallyAllowed) => {
      vi.stubGlobal('PointerEvent', MouseEvent);
      try {
        setState('network.appRole', 'guest');
        setState('network.hostConn', { peer: 'host-1', open: true } as never);
        setState('network.isOperator', initiallyAllowed);
        setState('playback.mode', 'file');
        setState('playback.activity', 'playing');
        setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
        vi.mocked(getTrackPosition).mockReturnValue(21);
        initSeekBar();
        installRangeDragGuard();
        const slider = document.getElementById('seek-slider') as HTMLInputElement;
        vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 40));
        slider.dispatchEvent(seekPointer('pointerdown', 1, 200));

        // Authority can change twice while the captured pointer stays still.
        // Neither input nor change observes the denied interval directly.
        setState('network.isOperator', false);
        expect(slider.getAttribute('aria-disabled')).toBe('true');
        setState('network.isOperator', true);
        expect(slider.getAttribute('aria-disabled')).toBe('false');
        slider.dispatchEvent(seekPointer('pointerup', 1, 200));

        expect(seekTo).not.toHaveBeenCalled();
        expect(getState('player.isSeeking')).toBe(false);
        expect(slider.value).toBe('21');

        slider.dispatchEvent(seekPointer('pointerdown', 2, 300));
        slider.dispatchEvent(seekPointer('pointerup', 2, 300));
        expect(seekTo).toHaveBeenCalledExactlyOnceWith(90);
      } finally {
        clearAllManagedTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      }
    },
  );

  it('retires a seek drag when a YouTube playlist changes sub-video under the same queue item', () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    try {
      setState('playback.mode', 'youtube');
      setState('playback.activity', 'playing');
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      setState('youtube.currentSubIndex', 0);
      initSeekBar();
      installRangeDragGuard();
      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 40));
      slider.dispatchEvent(seekPointer('pointerdown', 1, 200));

      // The queue row and mode remain unchanged across a playlist sub-video.
      setState('youtube.currentSubIndex', 1);
      vi.mocked(getTrackPosition).mockReturnValue(4);
      bus.emit('ui:time-update', 'fmt:4', 'fmt:180', 4, 180);
      slider.dispatchEvent(seekPointer('pointermove', 1, 300));
      slider.dispatchEvent(seekPointer('pointerup', 1, 300));

      expect(getState('playlist.currentQueueItemId')).toBe(QUEUE_ITEM_ID);
      expect(seekTo).not.toHaveBeenCalled();
      expect(getState('player.isSeeking')).toBe(false);
      expect(slider.value).toBe('4');

      slider.dispatchEvent(seekPointer('pointerdown', 2, 200));
      slider.dispatchEvent(seekPointer('pointerup', 2, 200));
      expect(seekTo).toHaveBeenCalledExactlyOnceWith(90);
    } finally {
      clearAllManagedTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it.each(['before-timeout', 'after-timeout'] as const)(
    'rejects a delayed iOS change when selection changes %s after pointer release',
    (selectionBoundary) => {
      vi.useFakeTimers();
      try {
        setState('playback.mode', 'file');
        setState('playback.activity', 'playing');
        setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
        initSeekBar();
        const slider = document.getElementById('seek-slider') as HTMLInputElement;
        slider.dispatchEvent(seekPointer('pointerdown', 1));
        slider.value = '33';
        slider.dispatchEvent(new Event('input'));
        slider.dispatchEvent(seekPointer('pointerup', 1));
        expect(getState('player.isSeeking')).toBe(true);

        if (selectionBoundary === 'after-timeout') vi.advanceTimersByTime(350);
        setState('playlist.currentQueueItemId', '20000000-0000-4000-8000-000000000002');
        vi.mocked(getTrackPosition).mockReturnValue(3);
        vi.advanceTimersByTime(351);
        slider.dispatchEvent(new Event('change'));

        expect(seekTo).not.toHaveBeenCalled();
        expect(getState('player.isSeeking')).toBe(false);
        expect(slider.value).toBe('3');
      } finally {
        clearAllManagedTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(['ArrowRight', 'ArrowUp'])(
    'accepts a new %s keyboard seek after retiring the preceding pointer gesture',
    (key) => {
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      initSeekBar();
      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      slider.dispatchEvent(seekPointer('pointerdown', 1));
      slider.value = '60';
      slider.dispatchEvent(new Event('input'));
      setState('playlist.currentQueueItemId', '20000000-0000-4000-8000-000000000002');
      slider.dispatchEvent(seekPointer('pointerup', 1));
      slider.dispatchEvent(new Event('change'));
      expect(seekTo).not.toHaveBeenCalled();

      const keydown = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      slider.dispatchEvent(keydown);
      expect(keydown.defaultPrevented).toBe(false);
      // jsdom has no native range keyboard default action. Supply its input
      // and change events after the real keydown admission boundary.
      slider.value = '42';
      slider.dispatchEvent(new Event('input'));
      slider.dispatchEvent(new Event('change'));
      slider.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));

      expect(seekTo).toHaveBeenCalledExactlyOnceWith(42);
      expect(getState('player.isSeeking')).toBe(false);
    },
  );

  it('accepts a fresh accessibility adjustment after a completed pointer seek and later queue change', () => {
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
    initSeekBar();
    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    slider.dispatchEvent(seekPointer('pointerdown', 1));
    slider.value = '33';
    slider.dispatchEvent(new Event('input'));
    slider.dispatchEvent(seekPointer('pointerup', 1));
    slider.dispatchEvent(new Event('change'));
    expect(seekTo).toHaveBeenCalledExactlyOnceWith(33);
    vi.mocked(seekTo).mockClear();

    // This is an ordinary later selection, after the pointer command ended.
    setState('playlist.currentQueueItemId', '20000000-0000-4000-8000-000000000002');
    bus.emit('ui:seek-reset');
    bus.emit('ui:duration-update', 180);
    vi.mocked(getTrackPosition).mockReturnValue(3);

    // Native accessibility range actions can set the value and dispatch
    // input/change directly, without a preceding pointer or keyboard event.
    slider.value = '42';
    slider.dispatchEvent(new Event('input'));
    slider.dispatchEvent(new Event('change'));

    expect(seekTo).toHaveBeenCalledExactlyOnceWith(42);
    expect(slider.value).toBe('42');
    expect(getState('player.isSeeking')).toBe(false);
  });

  it('accepts a fresh accessibility adjustment after consuming a cancelled pointer change', () => {
    vi.useFakeTimers();
    try {
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
      setState('playlist.currentQueueItemId', QUEUE_ITEM_ID);
      initSeekBar();
      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      slider.dispatchEvent(seekPointer('pointerdown', 1));
      slider.value = '33';
      slider.dispatchEvent(new Event('input'));
      slider.dispatchEvent(seekPointer('pointerup', 1));
      setState('playlist.currentQueueItemId', '20000000-0000-4000-8000-000000000002');
      vi.mocked(getTrackPosition).mockReturnValue(3);
      vi.advanceTimersByTime(351);

      // Consume the original release's late change before a new action.
      slider.dispatchEvent(new Event('change'));
      expect(seekTo).not.toHaveBeenCalled();
      expect(slider.value).toBe('3');

      slider.value = '42';
      slider.dispatchEvent(new Event('input'));
      slider.dispatchEvent(new Event('change'));

      expect(seekTo).toHaveBeenCalledExactlyOnceWith(42);
      expect(slider.value).toBe('42');
      expect(getState('player.isSeeking')).toBe(false);
    } finally {
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });

  it('preserves touch release and cancel when PointerEvent is unavailable', () => {
    vi.useFakeTimers();
    vi.stubGlobal('PointerEvent', undefined);
    try {
      setState('playback.mode', 'file');
      setState('playback.activity', 'playing');
      initSeekBar();
      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      slider.dispatchEvent(new Event('touchstart'));
      slider.dispatchEvent(new Event('touchend'));
      vi.advanceTimersByTime(349);
      expect(getState('player.isSeeking')).toBe(true);
      vi.advanceTimersByTime(1);
      expect(getState('player.isSeeking')).toBe(false);
      slider.dispatchEvent(new Event('touchstart'));
      slider.dispatchEvent(new Event('touchcancel'));
      expect(getState('player.isSeeking')).toBe(false);
    } finally {
      clearAllManagedTimers();
      vi.unstubAllGlobals();
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
    expect(slider.max).toBe('0');
    expect(slider.getAttribute('aria-valuetext')).toBe(t('player.no_media'));
    expect(document.getElementById('time-curr')?.innerText).toBe('-:--');
    expect(document.getElementById('time-dur')?.innerText).toBe('-:--');
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('atomically replaces a stale media timeline when system audio takes ownership', () => {
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    initSeekBar();
    bus.emit('ui:time-update', '1:23', '4:56', 83, 296);

    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    expect(slider.getAttribute('aria-valuetext')).toBe('1:23');

    setState('playback.mode', 'system-audio');

    expect(slider.value).toBe('0');
    expect(slider.max).toBe('0');
    expect(slider.getAttribute('aria-disabled')).toBe('true');
    expect(slider.getAttribute('aria-valuetext')).toBe(t('player.seek_unavailable_system_audio'));
    expect(document.getElementById('time-curr')?.innerText).toBe('-:--');
    expect(document.getElementById('time-dur')?.innerText).toBe('-:--');
  });
});

describe('seek bar work while nothing changes on screen', () => {
  interface FrameQueue {
    readonly size: number;
    run(timestamp: number): void;
  }

  function installFrameQueue(): FrameQueue {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.set(nextFrameId, callback);
        return nextFrameId++;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => frames.delete(id)),
    );
    return {
      get size() {
        return frames.size;
      },
      run(timestamp) {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(timestamp);
      },
    };
  }

  function recordWrites(target: object, property: string, prototype: object): string[] {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property)!;
    const writes: string[] = [];
    Object.defineProperty(target, property, {
      configurable: true,
      get() {
        return descriptor.get!.call(this);
      },
      set(value: string) {
        writes.push(value);
        descriptor.set!.call(this, value);
      },
    });
    return writes;
  }

  // jsdom has no innerText. Give these nodes the browser's plain-text behavior.
  function recordTextWrites(element: HTMLElement): string[] {
    const writes: string[] = [];
    Object.defineProperty(element, 'innerText', {
      configurable: true,
      get: () => element.textContent,
      set: (value: string) => {
        writes.push(value);
        element.textContent = value;
      },
    });
    return writes;
  }

  function renderPlayPanel(active: boolean): void {
    document.body.innerHTML = `
      <div id="tab-play" class="tab-content${active ? ' active' : ''}">
        <input id="seek-slider" type="range" value="0" max="120" />
        <span id="time-curr"></span>
        <span id="time-dur"></span>
      </div>
    `;
  }

  function startFilePlayback(position: number): void {
    vi.mocked(getTrackPosition).mockReturnValue(position);
    setState('playback.mode', 'file');
    setState('playback.activity', 'playing');
    initSeekBar();
    bus.emit('ui:loop-start');
  }

  function cleanup(): void {
    bus.emit('ui:seek-reset');
    clearAllManagedTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }

  it('snaps to the step that the seek range declares', () => {
    const markup = readFileSync('index.html', 'utf8');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    expect(parsed.getElementById('seek-slider')?.getAttribute('step')).toBe('0.1');
  });

  it('writes the interpolated position only when it reaches another step', () => {
    const frames = installFrameQueue();
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    try {
      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      const writes = recordWrites(slider, 'value', HTMLInputElement.prototype);
      startFilePlayback(12);

      for (const timestamp of [1_000, 1_016, 1_033, 1_049, 1_051, 1_066, 1_149, 1_151]) {
        frames.run(timestamp);
      }

      expect(writes).toEqual(['12', '12.1', '12.2']);
      expect(slider.style.getPropertyValue('--range-progress')).toBe(`${(12.2 / 120) * 100}%`);
    } finally {
      cleanup();
    }
  });

  it('keeps a max between steps on the value the range clamps to', () => {
    const frames = installFrameQueue();
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    try {
      const slider = document.getElementById('seek-slider') as HTMLInputElement;
      slider.max = '30.06';
      const writes = recordWrites(slider, 'value', HTMLInputElement.prototype);
      startFilePlayback(30);

      // The range cannot hold 30.1 above a 30.06 max, so 30 stays its value.
      for (const timestamp of [1_000, 1_100, 1_500, 2_000]) frames.run(timestamp);

      expect(writes).toEqual(['30']);
    } finally {
      cleanup();
    }
  });

  it('parks the loop behind another mobile tab and repaints before the switch back is captured', () => {
    renderPlayPanel(true);
    const frames = installFrameQueue();
    try {
      startFilePlayback(12);
      expect(frames.size).toBe(1);

      document.getElementById('tab-play')!.classList.remove('active');
      bus.emit('ui:tab-changed', 'playlist');
      expect(frames.size).toBe(0);
      frames.run(5_000);

      vi.mocked(getTrackPosition).mockReturnValue(47.25);
      document.getElementById('tab-play')!.classList.add('active');
      bus.emit('ui:tab-changed', 'play');

      // Synchronous: the View Transition captures the new tab after this callback.
      expect((document.getElementById('seek-slider') as HTMLInputElement).value).toBe('47.25');
      expect(document.getElementById('time-curr')?.innerText).toBe('fmt:47');
      expect(frames.size).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('keeps the dashboard Play panel live across tabs and follows breakpoint changes', () => {
    renderPlayPanel(false);
    const frames = installFrameQueue();
    const listeners = new Set<() => void>();
    const desktop = {
      matches: true,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    };
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => desktop),
    );
    try {
      startFilePlayback(12);
      expect(frames.size).toBe(1);
      bus.emit('ui:tab-changed', 'settings');
      expect(frames.size).toBe(1);

      desktop.matches = false;
      for (const listener of listeners) listener();
      expect(frames.size).toBe(0);

      vi.mocked(getTrackPosition).mockReturnValue(33);
      desktop.matches = true;
      for (const listener of listeners) listener();
      expect((document.getElementById('seek-slider') as HTMLInputElement).value).toBe('33');
      expect(frames.size).toBe(1);
    } finally {
      cleanup();
    }
  });

  it.each(['page', 'screensaver'] as const)(
    'parks the loop while the %s hides the seek bar and repaints as it returns',
    (cover) => {
      const frames = installFrameQueue();
      let hidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      const setHidden = (next: boolean): void => {
        if (cover === 'page') {
          hidden = next;
          document.dispatchEvent(new Event('visibilitychange'));
        } else {
          if (next) document.body.dataset.visualizerCovered = 'true';
          else delete document.body.dataset.visualizerCovered;
          document.dispatchEvent(new Event('mxqr:visualizer-visibility'));
        }
      };
      try {
        startFilePlayback(12);
        setHidden(true);
        expect(frames.size).toBe(0);

        vi.mocked(getTrackPosition).mockReturnValue(64.5);
        setHidden(false);
        expect((document.getElementById('seek-slider') as HTMLInputElement).value).toBe('64.5');
        expect(frames.size).toBe(1);
      } finally {
        delete (document as { hidden?: boolean }).hidden;
        delete document.body.dataset.visualizerCovered;
        cleanup();
      }
    },
  );

  it('keeps the ended check while hidden and skips only the anchor refresh', () => {
    vi.useFakeTimers();
    renderPlayPanel(true);
    const frames = installFrameQueue();
    const endedChecks = vi.fn();
    try {
      startFilePlayback(12);
      bus.on('player:check-ended', endedChecks);
      document.getElementById('tab-play')!.classList.remove('active');
      bus.emit('ui:tab-changed', 'playlist');
      vi.mocked(getTrackPosition).mockClear();

      vi.advanceTimersByTime(1_000);

      expect(endedChecks).toHaveBeenCalledTimes(2);
      expect(getTrackPosition).not.toHaveBeenCalled();
      expect(frames.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('starts parked when playback begins behind another tab', () => {
    renderPlayPanel(false);
    const frames = installFrameQueue();
    try {
      startFilePlayback(12);
      expect(frames.size).toBe(0);

      vi.mocked(getTrackPosition).mockReturnValue(15);
      document.getElementById('tab-play')!.classList.add('active');
      bus.emit('ui:tab-changed', 'play');
      expect((document.getElementById('seek-slider') as HTMLInputElement).value).toBe('15');
      expect(frames.size).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('writes only the YouTube timeline values that differ from the page', () => {
    setState('playback.mode', 'youtube');
    setState('playback.activity', 'playing');
    initSeekBar();
    const slider = document.getElementById('seek-slider') as HTMLInputElement;
    const values = recordWrites(slider, 'value', HTMLInputElement.prototype);
    const maxima = recordWrites(slider, 'max', HTMLInputElement.prototype);
    const attributes = vi.spyOn(slider, 'setAttribute');
    const current = recordTextWrites(document.getElementById('time-curr')!);
    const total = recordTextWrites(document.getElementById('time-dur')!);
    try {
      bus.emit('ui:time-update', '1:23', '4:56', 83.04, 296);
      expect(values).toEqual(['83']);
      expect(maxima).toEqual(['296']);
      expect(slider.getAttribute('aria-valuetext')).toBe('1:23');
      expect(current).toEqual(['1:23']);
      expect(total).toEqual(['4:56']);

      // A paused video repeats the same sample every poll.
      attributes.mockClear();
      bus.emit('ui:time-update', '1:23', '4:56', 83.04, 296);
      expect(values).toEqual(['83']);
      expect(maxima).toEqual(['296']);
      expect(attributes).not.toHaveBeenCalled();
      expect(current).toEqual(['1:23']);
      expect(total).toEqual(['4:56']);

      // Another writer changed the shared nodes, so the next sample repaints them.
      bus.emit('ui:seek-reset');
      bus.emit('ui:time-update', '1:23', '4:56', 83.04, 296);
      expect(values).toEqual(['83', '0', '83']);
      expect(current).toEqual(['1:23', '0:00', '1:23']);
      expect(total).toEqual(['4:56']);
      expect(maxima).toEqual(['296']);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
