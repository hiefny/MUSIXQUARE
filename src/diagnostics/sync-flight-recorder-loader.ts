/** Optional diagnostics shared by the room and guided-demo readiness boundaries. */

import { log } from '../core/log.ts';

let recorderFlight: Promise<void> | null = null;

export function prepareSyncFlightRecorder(): Promise<void> {
  recorderFlight ??= import('./sync-flight-recorder.ts')
    .then(({ initSyncFlightRecorder }) => {
      initSyncFlightRecorder();
    })
    .catch((error: unknown) => {
      // Diagnostics must be ready before the first session/playback events, but
      // an unavailable recorder must not prevent entering a room or the demo.
      log.warn('[SyncFlightRecorder] Optional initialization failed', error);
    });
  return recorderFlight;
}
