import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bus, createBusScope } from '../../core/events.ts';
import { batchSetState, resetState, setState } from '../../core/state.ts';
import {
  getPlaybackModeActivitySnapshot,
  scopePlaybackModeActivity,
  subscribePlaybackModeActivity,
} from '../_state-hooks.ts';

beforeEach(() => {
  resetState();
  bus.clear();
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

  it('reports the final playback snapshot once for batched mode/activity writes', () => {
    const handler = vi.fn();

    subscribePlaybackModeActivity(handler);

    batchSetState({
      'playback.mode': 'file',
      'playback.activity': 'playing',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenLastCalledWith(
      { mode: 'file', activity: 'playing' },
      { mode: null, activity: 'idle' },
    );
  });

  it('ignores malformed playback mode/activity bus payloads', () => {
    const handler = vi.fn();
    subscribePlaybackModeActivity(handler);

    bus.emit('state:playback.mode', 'NOT_A_MODE', 'playback.mode');
    bus.emit('state:playback.activity', 'NOT_AN_ACTIVITY', 'playback.activity');

    expect(handler).not.toHaveBeenCalled();
  });
});
