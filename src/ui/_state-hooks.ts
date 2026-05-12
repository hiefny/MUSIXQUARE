import { bus, type BusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import {
  isPlaybackActivityValue,
  isPlaybackModeValue,
  type PlaybackModeActivity,
} from '../player/ownership.ts';

export type Unsubscribe = () => void;
export type PlaybackModeActivitySnapshot = PlaybackModeActivity;
export type PlaybackModeActivityHandler = (
  next: PlaybackModeActivitySnapshot,
  prev: PlaybackModeActivitySnapshot,
) => void;

export interface PlaybackModeActivitySubscribeOptions {
  immediate?: boolean;
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

  const notifyCurrent = (): void => {
    const next = getPlaybackModeActivitySnapshot();
    if (next.mode === prev.mode && next.activity === prev.activity) return;

    const typedPrev = prev;
    prev = next;
    handler(next, typedPrev);
  };

  const unsubscribeMode = bus.on('state:playback.mode', (mode) => {
    if (!isPlaybackModeValue(mode)) return;
    notifyCurrent();
  });
  const unsubscribeActivity = bus.on('state:playback.activity', (activity) => {
    if (!isPlaybackActivityValue(activity)) return;
    notifyCurrent();
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

  const notifyCurrent = (): void => {
    const next = getPlaybackModeActivitySnapshot();
    if (next.mode === prev.mode && next.activity === prev.activity) return;

    const typedPrev = prev;
    prev = next;
    handler(next, typedPrev);
  };

  scope.on('state:playback.mode', (mode) => {
    if (!isPlaybackModeValue(mode)) return;
    notifyCurrent();
  });
  scope.on('state:playback.activity', (activity) => {
    if (!isPlaybackActivityValue(activity)) return;
    notifyCurrent();
  });
}
