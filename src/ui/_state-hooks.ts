import { bus, type BusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import {
  type PlaybackActivityValue,
  type PlaybackModeValue,
} from '../core/constants.ts';

export type Unsubscribe = () => void;
export interface PlaybackModeActivitySnapshot {
  mode: PlaybackModeValue;
  activity: PlaybackActivityValue;
}
export type PlaybackModeActivityHandler = (
  next: PlaybackModeActivitySnapshot,
  prev: PlaybackModeActivitySnapshot,
) => void;

export interface PlaybackModeActivitySubscribeOptions {
  immediate?: boolean;
}

function isPlaybackModeValue(value: unknown): value is PlaybackModeValue {
  return value === null || value === 'file' || value === 'youtube' || value === 'system-audio';
}

function isPlaybackActivityValue(value: unknown): value is PlaybackActivityValue {
  return value === 'idle' || value === 'paused' || value === 'playing' || value === 'pending';
}

export function getPlaybackModeActivitySnapshot(): PlaybackModeActivitySnapshot {
  return {
    mode: getState('playback.mode'),
    activity: getState('playback.activity'),
  };
}

export function subscribePlaybackModeActivity(
  handler: PlaybackModeActivityHandler,
  options: PlaybackModeActivitySubscribeOptions = {},
): Unsubscribe {
  let prev = getPlaybackModeActivitySnapshot();
  if (options.immediate) handler(prev, prev);

  const notify = (next: PlaybackModeActivitySnapshot): void => {
    const typedPrev = prev;
    prev = next;
    handler(next, typedPrev);
  };

  const unsubscribeMode = bus.on('state:playback.mode', (mode) => {
    if (!isPlaybackModeValue(mode)) return;
    notify({ ...prev, mode });
  });
  const unsubscribeActivity = bus.on('state:playback.activity', (activity) => {
    if (!isPlaybackActivityValue(activity)) return;
    notify({ ...prev, activity });
  });

  return () => {
    unsubscribeMode();
    unsubscribeActivity();
  };
}

export function scopePlaybackModeActivity(
  scope: BusScope,
  handler: PlaybackModeActivityHandler,
  options: PlaybackModeActivitySubscribeOptions = {},
): void {
  let prev = getPlaybackModeActivitySnapshot();
  if (options.immediate) handler(prev, prev);

  const notify = (next: PlaybackModeActivitySnapshot): void => {
    const typedPrev = prev;
    prev = next;
    handler(next, typedPrev);
  };

  scope.on('state:playback.mode', (mode) => {
    if (!isPlaybackModeValue(mode)) return;
    notify({ ...prev, mode });
  });
  scope.on('state:playback.activity', (activity) => {
    if (!isPlaybackActivityValue(activity)) return;
    notify({ ...prev, activity });
  });
}
