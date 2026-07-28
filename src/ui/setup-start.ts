import { bus } from '../core/events.ts';
import { activateNoSleep } from '../core/wake-lock.ts';
import { markAppUsed } from '../demo/storage.ts';
import { primeYouTubePlayer } from '../youtube/player.ts';
import { primeFilePlaybackProductAudioFromGesture } from '../audio/file-playback-audio-readiness.ts';
import { isFilePlaybackEngineV2Enabled } from '../player/file-playback-engine-gate.ts';

const FILE_PLAYBACK_ENGINE_V2_ENABLED = isFilePlaybackEngineV2Enabled();

/** Re-attempts only the gesture-sensitive V2 audio activation. */
export function refreshSetupAudioFromGesture(): void {
  if (FILE_PLAYBACK_ENGINE_V2_ENABLED) {
    void primeFilePlaybackProductAudioFromGesture().catch(() => undefined);
  }
}

export function prepareSetupStartFromGesture(): void {
  markAppUsed();
  // This direct call is intentionally synchronous. The returned readiness is
  // consumed later by the V2 guest owner, but WebKit's resume request must be
  // issued from this original setup click/keydown stack.
  refreshSetupAudioFromGesture();
  bus.emit('audio:activate');
  primeYouTubePlayer();
  activateNoSleep();
}
