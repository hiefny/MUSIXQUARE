import { bus } from '../core/events.ts';
import { activateNoSleep } from '../core/wake-lock.ts';
import { markAppUsed } from '../demo/storage.ts';
import { primeYouTubePlayer } from '../youtube/player.ts';

export function prepareSetupStartFromGesture(): void {
  markAppUsed();
  bus.emit('audio:activate');
  primeYouTubePlayer();
  activateNoSleep();
}
