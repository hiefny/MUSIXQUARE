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
 * YOUTUBE_ARM_TIMING.audioRestorePollMs, at most audioRestoreMaxAttempts
 * times: WebKit can ignore the first unMute right after an iframe transition
 * or a hard mute.
 *
 * Each caller keeps its own rhythm (the two cadences stay apart), its fences,
 * its confirmation predicate (zero-start alone counts a NaN volume read as
 * restored), what follows a restore or the last attempt, and its timer: every
 * wait goes through the caller's own schedule, so its timer key or slot and
 * the cancel that clears them stay with the caller. This module keeps no
 * state, sets no timer and logs nothing.
 *
 * The guest fallback's restore before its release (player.ts) writes and
 * checks through the same two helpers but keeps its own 50 ms poll.
 */
import { YOUTUBE_ARM_TIMING } from './constants.ts';

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

interface YouTubeAudioRestore {
  /**
   * 'settle-then-verify': write, wait one poll, then verify (zero-start's
   * active and detached restores, the PRO arm's active restore).
   * 'verify-then-settle': write and verify at once, then wait one poll
   * before the next attempt (the PRO arm's detached restore and player.ts's
   * two cleanups).
   */
  readonly cadence: 'settle-then-verify' | 'verify-then-settle';
  /** The caller's fence before every write; false ends the loop with no callback. */
  readonly canWrite: () => boolean;
  /** One attempt's commands. A throw skips that attempt's verify: not restored. */
  readonly write: () => void;
  /** 'settle-then-verify' only: the fence after the wait, before the verify (canWrite if omitted). */
  readonly canVerify?: () => boolean;
  /** The caller's confirmation predicate; a throw counts as not restored. */
  readonly verify: () => boolean;
  /** The audio verified after this many attempts. */
  readonly onRestored: (attempts: number) => void;
  /** The last attempt did not verify. */
  readonly onExhausted: () => void;
  /** The caller's own timer, asked only for the wait between attempts. */
  readonly schedule: (callback: () => void, delayMs: number) => void;
}

/** Runs one bounded restore; the first attempt writes synchronously. */
export function restoreYouTubeAudioVerified(restore: YouTubeAudioRestore): void {
  const verifyFirst = restore.cadence === 'verify-then-settle';
  const attempt = (attempts: number): void => {
    if (!restore.canWrite()) return;
    let wrote = true;
    try {
      restore.write();
    } catch {
      wrote = false;
    }
    const check = (): void => {
      let restored = false;
      try {
        restored = wrote && restore.verify();
      } catch {
        // A failed read is not a verified restore.
      }
      if (restored) restore.onRestored(attempts + 1);
      else if (attempts + 1 >= YOUTUBE_ARM_TIMING.audioRestoreMaxAttempts) restore.onExhausted();
      else if (verifyFirst) {
        restore.schedule(() => attempt(attempts + 1), YOUTUBE_ARM_TIMING.audioRestorePollMs);
      } else attempt(attempts + 1);
    };
    if (verifyFirst) check();
    else {
      restore.schedule(() => {
        if ((restore.canVerify ?? restore.canWrite)()) check();
      }, YOUTUBE_ARM_TIMING.audioRestorePollMs);
    }
  };
  attempt(0);
}
