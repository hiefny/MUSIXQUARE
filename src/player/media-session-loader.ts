/** Shared optional Media Session boundary for both room and guided-demo playback. */

import { log } from '../core/log.ts';

let mediaSessionFlight: Promise<void> | null = null;

export function prepareMediaSession(): Promise<void> {
  mediaSessionFlight ??= import('./media-session.ts')
    .then(({ initMediaSession }) => {
      initMediaSession();
    })
    .catch((error: unknown) => {
      // Media Session is an optional OS integration. Preserve playback when a
      // browser implementation or its deferred chunk is unavailable.
      log.warn('[MediaSession] Optional initialization failed', error);
    });
  return mediaSessionFlight;
}
