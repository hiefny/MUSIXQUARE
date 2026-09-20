import { bus } from '../core/events.ts';
import { activateNoSleep } from '../core/wake-lock.ts';
import { markAppUsed } from '../demo/storage.ts';
import { primeYouTubePlayer } from '../youtube/player.ts';
import { waitForPendingYouTubePrimeBounce } from '../youtube/iframe.ts';
import { YOUTUBE_PRIME_BOUNCE_TIMEOUT_MS } from '../youtube/constants.ts';

export function prepareSetupStartFromGesture(): Promise<boolean> | null {
  markAppUsed();
  bus.emit('audio:activate');
  const pending = primeYouTubePlayer({ retryPending: true });
  activateNoSleep();
  // Keep the play call in the actual tap stack. Room media must not replace
  // the silent player before its PLAYING event proves that tap was accepted.
  return pending ? waitForPendingYouTubePrimeBounce(YOUTUBE_PRIME_BOUNCE_TIMEOUT_MS) : null;
}
