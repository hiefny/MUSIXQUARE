/**
 * Navigation intents of the app, each run behind the navigation owner's reset
 * screen (core/session-reset.ts, RO-23). Requesters choose the intent and the
 * message; the URL, the history mode and the room-code check live here, at the
 * one sink each intent has.
 */

import { RECONNECT_TARGET_KEY } from './navigation-contract.ts';
import { scheduleSessionReset } from './session-reset.ts';

interface LocationReplacer {
  replace(url: string): void;
}

/** The only room-code shape a navigation may put into the path. */
const ROOM_CODE_PATTERN = /^\d{6}$/;

/** Leave the current route without keeping an auto-join room URL in history. */
export function navigateToAppHome(location: LocationReplacer = window.location): void {
  location.replace('/');
}

function pushAppHome(): void {
  window.location.href = '/';
}

/**
 * Leave for the app home. `replace` drops the current route from history, as
 * leaving a room does. `push` keeps it as a Back entry: the setup-guest Back
 * buttons keep that by owner decision (Phase 2, decision 6, 2026-10-23).
 */
export function navigateHome(message: string, options: { history: 'replace' | 'push' }): void {
  scheduleSessionReset(message, options.history === 'replace' ? navigateToAppHome : pushAppHome);
}

interface RoomStartReturn {
  /** Shown on the reset screen. */
  readonly message: string;
  /** Mark the next document's join as a reconnect; setup's join error reads it. */
  readonly reconnect: boolean;
  /** Runs instead of any navigation when the code is not a six-digit room code. */
  readonly fallback: () => void;
  /**
   * Runs once if this document stays: the return never committed, or another
   * navigation already held the page. Not called after the fallback runs.
   */
  readonly onRecovered?: () => void;
}

/**
 * Return to a room's Start screen (its /CODE invite page), as a pushed history
 * entry like every /CODE return. The code is checked here, at the navigation
 * sink, so nothing else can put "../path" into the URL; anything but a
 * six-digit room code runs `fallback` instead. Returns whether it was a code.
 */
export function returnToRoomStart(code: unknown, options: RoomStartReturn): boolean {
  if (typeof code !== 'string' || !ROOM_CODE_PATTERN.test(code)) {
    options.fallback();
    return false;
  }
  if (options.reconnect) {
    try {
      globalThis.sessionStorage?.setItem(RECONNECT_TARGET_KEY, code);
    } catch {
      // Storage can be denied in private or embedded contexts; return anyway.
    }
  }
  const handle = scheduleSessionReset(options.message, () => {
    window.location.href = `/${code}`;
  });
  const { onRecovered } = options;
  if (onRecovered) {
    if (handle) handle.onRecovered(onRecovered);
    else onRecovered();
  }
  return true;
}
