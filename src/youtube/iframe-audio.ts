/**
 * Verified restore of a YouTube iframe's audio.
 *
 * Resource owner: RO-12
 *
 * The one bounded restore loop of the start machines: zero-start's active
 * and detached restores (zero-start.ts), the PRO arm's active and detached
 * restores (authority-arm.ts) and the verified cleanups of the host legacy
 * recovery and the guest local fallback (player.ts). Each attempt writes the
 * audio and checks that the iframe reports it, every
 * YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS, at most
 * YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS times: WebKit can ignore the first
 * unMute right after an iframe transition or a hard mute.
 *
 * Each caller keeps its own rhythm (the two cadences stay apart), its fences,
 * its confirmation predicate (zero-start alone counts a NaN volume read as
 * restored), what follows a restore or the last attempt, and its timer: every
 * wait goes through the caller's own schedule, so its timer key or slot and
 * the cancel that clears them stay with the caller. This module keeps no
 * state, sets no timer and logs nothing.
 *
 * The restores of the host legacy recovery and the guest local fallback
 * before their release (player.ts) write and check through the same two
 * helpers but keep their own 50 ms polls. The guest fallback's release write
 * and both recoveries' unverified cleanups of a replaced or cancelled iframe
 * (cleanupExactPlayer) write through writeYouTubeAudio too, without a check.
 */
import {
  YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS,
  YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS,
} from './constants.ts';

/** The iframe player methods a restore writes and reads. */
interface YouTubeAudioPlayer {
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getVolume(): number;
}

/** The audio a restore writes and then expects the iframe to report. */
interface YouTubeAudioTarget {
  readonly muted: boolean;
  readonly volume: number;
}

/** setVolume, then mute or unMute: the write of every restore attempt. */
export function writeYouTubeAudio(player: YouTubeAudioPlayer, target: YouTubeAudioTarget): void {
  player.setVolume(target.volume);
  if (target.muted) player.mute();
  else player.unMute();
}

/**
 * Whether the iframe reports the target: the same mute state, then a volume
 * within 1 of it. A NaN volume read never matches.
 */
export function isYouTubeAudioRestored(
  player: YouTubeAudioPlayer,
  target: YouTubeAudioTarget,
): boolean {
  return player.isMuted() === target.muted && Math.abs(player.getVolume() - target.volume) <= 1;
}

/**
 * Runs one bounded restore; the first attempt writes synchronously. The
 * steps are positional parameters: a call site stays a short list of the
 * caller's own closures in the eagerly loaded entry chunk.
 *
 * @param cadence 'settle-then-verify': write, wait one poll, then verify
 *   (zero-start's active and detached restores, the PRO arm's active
 *   restore). 'verify-then-settle': write and verify at once, then wait one
 *   poll before the next attempt (the PRO arm's detached restore and
 *   player.ts's two cleanups).
 * @param canWrite The caller's fence before every write; false ends the loop
 *   with no callback.
 * @param write One attempt's commands. A throw skips that attempt's verify:
 *   not restored.
 * @param verify The caller's confirmation predicate; a throw counts as not
 *   restored.
 * @param onDone Called once: restored after this many attempts, or not
 *   restored after the last one.
 * @param schedule The caller's own timer, asked only for the wait between
 *   attempts.
 * @param canVerify 'settle-then-verify' only: the fence after the wait,
 *   before the verify.
 */
export function restoreYouTubeAudioVerified(
  cadence: 'settle-then-verify' | 'verify-then-settle',
  canWrite: () => boolean,
  write: () => void,
  verify: () => boolean,
  onDone: (restored: boolean, attempts: number) => void,
  schedule: (callback: () => void, delayMs: number) => void,
  canVerify = canWrite,
): void {
  const verifyFirst = cadence === 'verify-then-settle';
  const attempt = (attempts: number): void => {
    if (!canWrite()) return;
    let wrote = true;
    try {
      write();
    } catch {
      wrote = false;
    }
    const check = (): void => {
      let restored = false;
      try {
        restored = wrote && verify();
      } catch {
        // A failed read is not a verified restore.
      }
      if (restored || attempts + 1 >= YOUTUBE_ARM_AUDIO_RESTORE_MAX_ATTEMPTS) {
        onDone(restored, attempts + 1);
      } else if (verifyFirst) {
        schedule(() => attempt(attempts + 1), YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS);
      } else attempt(attempts + 1);
    };
    if (verifyFirst) check();
    else {
      schedule(() => {
        if (canVerify()) check();
      }, YOUTUBE_ARM_AUDIO_RESTORE_POLL_MS);
    }
  };
  attempt(0);
}
