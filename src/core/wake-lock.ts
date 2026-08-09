/**
 * MUSIXQUARE - Screen Wake Lock (native API)
 *
 * Keep this state machine outside `app.ts` so feature modules never
 * back-import the composition root. This dependency-free leaf stays safely
 * callable synchronously from setup's user-gesture handlers.
 */

import { log } from './log.ts';

let _wakeLockDesired = false;
let _wakeLockSentinel: WakeLockSentinel | null = null;
let _wakeLockRequest: Promise<void> | null = null;
let _wakeLockGeneration = 0;

function releaseWakeLock(sentinel: WakeLockSentinel): void {
  try {
    void sentinel.release().catch((err) => {
      log.warn('[WakeLock] Wake Lock release failed:', err);
    });
  } catch (err) {
    log.warn('[WakeLock] Wake Lock release failed:', err);
  }
}

function acquireWakeLock(): void {
  if (!_wakeLockDesired || !('wakeLock' in navigator)) return;
  if (_wakeLockSentinel && !_wakeLockSentinel.released) return;
  _wakeLockSentinel = null;
  if (_wakeLockRequest) return;

  const requestGeneration = _wakeLockGeneration;
  let sentinelRequest: Promise<WakeLockSentinel>;
  try {
    sentinelRequest = navigator.wakeLock.request('screen');
  } catch (err) {
    log.warn('[WakeLock] Wake Lock request failed:', err);
    return;
  }

  const request = sentinelRequest
    .then((sentinel) => {
      // Setup/session teardown may win while the browser request is pending.
      // Never let that late result resurrect keep-awake.
      if (!_wakeLockDesired || requestGeneration !== _wakeLockGeneration) {
        if (!sentinel.released) releaseWakeLock(sentinel);
        return;
      }

      if (sentinel.released) return;
      _wakeLockSentinel = sentinel;
      sentinel.addEventListener(
        'release',
        () => {
          if (_wakeLockSentinel === sentinel) _wakeLockSentinel = null;
        },
        { once: true },
      );
      log.debug('[WakeLock] Wake Lock acquired');
    })
    .catch((err) => {
      // Browser policy failures remain best-effort. Preserve desired state so
      // a later visibility bounce can retry.
      log.warn('[WakeLock] Wake Lock request failed:', err);
    })
    .finally(() => {
      if (_wakeLockRequest !== request) return;
      _wakeLockRequest = null;

      // A deactivate -> activate transition can occur while the old request
      // is pending. Once its stale result is released, serve the new intent.
      if (_wakeLockDesired && requestGeneration !== _wakeLockGeneration) {
        acquireWakeLock();
      }
    });

  _wakeLockRequest = request;
}

/**
 * Mark keep-awake as wanted and fire a best-effort request. A live sentinel or
 * in-flight request makes repeated calls safe and idempotent.
 */
export function activateNoSleep(): void {
  if (!_wakeLockDesired) {
    _wakeLockDesired = true;
    _wakeLockGeneration++;
  }
  acquireWakeLock();
}

/** Stop wanting keep-awake and release the sentinel owned by this document. */
export function deactivateNoSleep(): void {
  if (!_wakeLockDesired && !_wakeLockSentinel) return;

  _wakeLockDesired = false;
  _wakeLockGeneration++;
  const sentinel = _wakeLockSentinel;
  _wakeLockSentinel = null;
  if (sentinel && !sentinel.released) releaseWakeLock(sentinel);
}

/**
 * Re-request the wake lock after browser-driven release. No-ops unless an
 * active setup/session still desires keep-awake.
 */
export function reacquireWakeLockIfActive(): void {
  acquireWakeLock();
}

/** @internal Reset module-owned state between unit tests. */
export function __resetWakeLockForTests(): void {
  _wakeLockDesired = false;
  _wakeLockGeneration++;
  const sentinel = _wakeLockSentinel;
  _wakeLockSentinel = null;
  _wakeLockRequest = null;
  if (sentinel && !sentinel.released) releaseWakeLock(sentinel);
}
