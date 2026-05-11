import { bus, type BusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import {
  APP_STATE,
  type AppStateValue,
  type PlaybackActivityValue,
  type PlaybackModeValue,
} from '../core/constants.ts';

export type Unsubscribe = () => void;
export type AppStateHandler = (next: AppStateValue, prev: AppStateValue) => void;
export interface PlaybackModeActivitySnapshot {
  mode: PlaybackModeValue;
  activity: PlaybackActivityValue;
}
export type PlaybackModeActivityHandler = (
  next: PlaybackModeActivitySnapshot,
  prev: PlaybackModeActivitySnapshot,
) => void;

export interface AppStateSubscribeOptions {
  immediate?: boolean;
}

function isAppStateValue(value: unknown): value is AppStateValue {
  return (
    value === APP_STATE.IDLE ||
    value === APP_STATE.PLAYING_AUDIO ||
    value === APP_STATE.PAUSED ||
    value === APP_STATE.PLAYING_YOUTUBE ||
    value === APP_STATE.PLAYING_SYSTEM_AUDIO
  );
}

function isPlaybackModeValue(value: unknown): value is PlaybackModeValue {
  return value === null || value === 'file' || value === 'youtube' || value === 'system-audio';
}

function isPlaybackActivityValue(value: unknown): value is PlaybackActivityValue {
  return value === 'idle' || value === 'paused' || value === 'playing' || value === 'pending';
}

export function getAppStateSnapshot(): AppStateValue {
  return getState('appState');
}

export function getPlaybackModeActivitySnapshot(): PlaybackModeActivitySnapshot {
  return {
    mode: getState('playback.mode'),
    activity: getState('playback.activity'),
  };
}

export function subscribeAppState(
  handler: AppStateHandler,
  options: AppStateSubscribeOptions = {},
): Unsubscribe {
  let prev = getAppStateSnapshot();
  if (options.immediate) handler(prev, prev);

  return bus.on('state:appState', (next) => {
    if (!isAppStateValue(next)) return;
    const typedPrev = prev;
    prev = next;
    handler(next, typedPrev);
  });
}

export function scopeAppState(
  scope: BusScope,
  handler: AppStateHandler,
  options: AppStateSubscribeOptions = {},
): void {
  let prev = getAppStateSnapshot();
  if (options.immediate) handler(prev, prev);

  scope.on('state:appState', (next) => {
    if (!isAppStateValue(next)) return;
    const typedPrev = prev;
    prev = next;
    handler(next, typedPrev);
  });
}

export function subscribePlaybackModeActivity(
  handler: PlaybackModeActivityHandler,
  options: AppStateSubscribeOptions = {},
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
  options: AppStateSubscribeOptions = {},
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
