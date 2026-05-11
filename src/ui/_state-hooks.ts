import { bus, type BusScope } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { APP_STATE, type AppStateValue } from '../core/constants.ts';

export type Unsubscribe = () => void;
export type AppStateHandler = (next: AppStateValue, prev: AppStateValue) => void;

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

export function getAppStateSnapshot(): AppStateValue {
  return getState('appState');
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
