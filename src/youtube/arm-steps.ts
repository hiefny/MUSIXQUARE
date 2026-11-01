/**
 * The arm steps both YouTube start machines run on the shared iframe: the
 * Standard zero-start run (zero-start.ts) and the coordinator-free PRO arm
 * (authority-arm.ts).
 *
 * Resource owner: RO-03
 *
 * A contract of two production consumers (docs/design/
 * source-complexity-ratchet.md). Each machine stays the shell of its own
 * protocol: it keeps its clock (zero-start reads Date.now(), the PRO arm
 * performance.now()), its scheduler with the fences and the cancel around
 * every wait, its failure reasons, its warm command and all that follows the
 * warm: the settle, the audio restore and the release. These steps hold no
 * state, set no timer of their own and log nothing; each wait goes through
 * the caller's schedule. Their timing comes from constants.ts.
 *
 * - The hard-mute wait (waitForYouTubeHardMute): one mute(), then a poll
 *   after a 0 ms wait and every YOUTUBE_ARM_HARD_MUTE_POLL_MS until the
 *   iframe reports the mute, at most YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS polls.
 *   The confirming poll runs the machine's warm.
 * - The warm PLAYING's acceptance (acceptYouTubeWarmPlaying): the settle
 *   starts YOUTUBE_ARM_WARM_PLAY_MS after it.
 *
 * Which PLAYING a machine accepts as its warm is the machine's policy:
 * zero-start refuses one reported before its own warm command and bounds the
 * warm with its prepare watchdog; the PRO arm accepts any PLAYING of its
 * video while it warms, within its prepare deadline.
 * arm-steps-golden.test.ts runs both machines on the same scripted iframe.
 */
import {
  YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS,
  YOUTUBE_ARM_HARD_MUTE_POLL_MS,
  YOUTUBE_ARM_WARM_PLAY_MS,
} from './constants.ts';

/**
 * The iframe player methods a start machine arms with: the PRO arm's player
 * (YouTubeAuthorityArmPlayer) is this set, and the zero-start run's
 * (YouTubeZeroStartPlayer) adds two. player.ts and iframe.ts each keep their
 * own adapter, which checks that the iframe has them.
 */
export interface YouTubeArmPlayer {
  loadVideoById(videoId: string, startSeconds?: number): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
  getCurrentTime(): number;
  getDuration?(): number;
  getPlayerState(): number;
  getVideoData(): { video_id?: string };
}

/** The machine's own timer: `callback` after `delayMs`, behind the machine's fences. */
type ArmSchedule = (callback: () => void, delayMs: number) => unknown;

/**
 * Hard-mutes the iframe and waits until it reports the mute.
 *
 * The first mute() is synchronous; one that throws reaches the caller, which
 * fails with its own reason, and nothing is scheduled. Each poll runs after a
 * wait on `schedule`, 0 ms before the first and then
 * YOUTUBE_ARM_HARD_MUTE_POLL_MS, and starts with `fence`. A poll reads
 * isMuted(), counting a throw as not muted. A confirmed mute calls `warm` in
 * the same poll. An unconfirmed poll calls `timeout` if it is the
 * YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS-th, and otherwise mutes again (a throw
 * is ignored: the next poll observes the command or the last one fails
 * safely) and waits for the next poll.
 *
 * @param player The machine's iframe, muted first.
 * @param fence Before each poll: the machine's iframe now, which that poll
 *   reads and commands, or none to end the wait with no read, command or
 *   callback (the machine fails or cancels there itself).
 * @param warm The machine's warm, given the confirming poll's iframe.
 * @param timeout The machine's failure after the last unconfirmed poll.
 * @param schedule The machine's timer for each wait.
 */
export function waitForYouTubeHardMute<Player extends YouTubeArmPlayer>(
  player: Player,
  fence: () => Player | null,
  warm: (player: Player) => void,
  timeout: () => void,
  schedule: ArmSchedule,
): void {
  player.mute();
  const poll = (attempt: number): void => {
    const current = fence();
    if (!current) return;
    let muted = false;
    try {
      muted = current.isMuted() === true;
    } catch {
      // A read that throws is not a confirmed mute.
    }
    if (muted) warm(current);
    else if (attempt + 1 >= YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS) timeout();
    else {
      try {
        current.mute();
      } catch {
        // The next poll observes the command, or the last one fails safely.
      }
      schedule(() => poll(attempt + 1), YOUTUBE_ARM_HARD_MUTE_POLL_MS);
    }
  };
  schedule(() => poll(0), 0);
}

/**
 * Accepts the warm PLAYING: `settle` runs YOUTUBE_ARM_WARM_PLAY_MS later on
 * the caller's `schedule`. Each machine accepts once per run, after its own
 * checks, and keeps the warm latency returned: `now` less `warmCallAt`, both
 * on the machine's clock, and never below 0.
 */
export function acceptYouTubeWarmPlaying(
  warmCallAt: number,
  now: number,
  settle: () => void,
  schedule: ArmSchedule,
): number {
  schedule(settle, YOUTUBE_ARM_WARM_PLAY_MS);
  return Math.max(0, now - warmCallAt);
}
