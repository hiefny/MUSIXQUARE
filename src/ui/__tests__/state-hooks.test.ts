import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_STATE } from '../../core/constants.ts';
import { bus, createBusScope } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import {
  getPlaybackModeActivitySnapshot,
  scopeAppState,
  scopePlaybackModeActivity,
  subscribeAppState,
  subscribePlaybackModeActivity,
} from '../_state-hooks.ts';

beforeEach(() => {
  resetState();
  bus.clear();
});

describe('ui appState hooks', () => {
  it('can render immediately from the current snapshot and then receive changes', () => {
    const handler = vi.fn();

    const unsubscribe = subscribeAppState(handler, { immediate: true });

    expect(handler).toHaveBeenCalledWith(APP_STATE.IDLE, APP_STATE.IDLE);

    setState('appState', APP_STATE.PLAYING_AUDIO);
    expect(handler).toHaveBeenLastCalledWith(APP_STATE.PLAYING_AUDIO, APP_STATE.IDLE);

    unsubscribe();
    setState('appState', APP_STATE.PAUSED);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('follows BusScope disposal', () => {
    const scope = createBusScope();
    const handler = vi.fn();

    scopeAppState(scope, handler);
    setState('appState', APP_STATE.PLAYING_YOUTUBE);

    expect(handler).toHaveBeenCalledWith(APP_STATE.PLAYING_YOUTUBE, APP_STATE.IDLE);

    scope.dispose();
    setState('appState', APP_STATE.IDLE);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed appState bus payloads', () => {
    const handler = vi.fn();
    subscribeAppState(handler);

    bus.emit('state:appState', 'NOT_A_REAL_STATE', 'appState');

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('ui playback mode/activity hooks', () => {
  it('can render immediately from the current playback snapshot and receive mode/activity changes', () => {
    const handler = vi.fn();

    const unsubscribe = subscribePlaybackModeActivity(handler, { immediate: true });

    expect(handler).toHaveBeenCalledWith(
      { mode: null, activity: 'idle' },
      { mode: null, activity: 'idle' },
    );

    setState('playback.mode', 'youtube');
    expect(handler).toHaveBeenLastCalledWith(
      { mode: 'youtube', activity: 'idle' },
      { mode: null, activity: 'idle' },
    );

    setState('playback.activity', 'playing');
    expect(handler).toHaveBeenLastCalledWith(
      { mode: 'youtube', activity: 'playing' },
      { mode: 'youtube', activity: 'idle' },
    );

    expect(getPlaybackModeActivitySnapshot()).toEqual({ mode: 'youtube', activity: 'playing' });

    unsubscribe();
    setState('playback.activity', 'paused');
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('follows BusScope disposal for playback mode/activity', () => {
    const scope = createBusScope();
    const handler = vi.fn();

    scopePlaybackModeActivity(scope, handler);
    setState('playback.mode', 'system-audio');

    expect(handler).toHaveBeenCalledWith(
      { mode: 'system-audio', activity: 'idle' },
      { mode: null, activity: 'idle' },
    );

    scope.dispose();
    setState('playback.activity', 'playing');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed playback mode/activity bus payloads', () => {
    const handler = vi.fn();
    subscribePlaybackModeActivity(handler);

    bus.emit('state:playback.mode', 'NOT_A_MODE', 'playback.mode');
    bus.emit('state:playback.activity', 'NOT_AN_ACTIVITY', 'playback.activity');

    expect(handler).not.toHaveBeenCalled();
  });
});
