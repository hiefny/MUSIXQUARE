/**
 * Load the listener graph that is only meaningful once a room transport is
 * about to exist. The shared promise makes concurrent standard and PRO entry
 * callers converge on one fail-closed module evaluation.
 */

import { bus } from '../core/events.ts';
import { createLazyFeatureLoadError } from '../core/lazy-feature-failure.ts';

let loadFlight: Promise<void> | null = null;
let loadFailure: Error | null = null;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Room session setup cancelled', 'AbortError');
}

function waitForCaller(load: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return load;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);

    signal.addEventListener('abort', onAbort, { once: true });
    void load.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function prepareRoomSessionFeatures(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (loadFailure) bus.emit('app:lazy-feature-load-failed', 'room-session', loadFailure);

  loadFlight ??= import('./room-session-feature-runtime.ts')
    .then(() => undefined)
    .catch((cause: unknown) => {
      // Browsers may cache a failed ESM fetch/evaluation for this document.
      // Keep one terminal rejection instead of presenting a retry button that
      // cannot actually re-evaluate the same specifier; the app offers reload.
      const error = createLazyFeatureLoadError('room-session', cause);
      loadFailure = error;
      bus.emit('app:lazy-feature-load-failed', 'room-session', error);
      throw error;
    });
  return waitForCaller(loadFlight, signal);
}
