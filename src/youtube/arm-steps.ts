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
 * every wait, its failure reasons, its warm command, the policy of its
 * settle, the audio restore and the release. These steps keep no state but
 * the settle's counts, set no timer of their own and log nothing; each wait
 * goes through the caller's schedule. Their timing comes from constants.ts.
 *
 * - The hard-mute wait (waitForYouTubeHardMute): one mute(), then a poll
 *   after a 0 ms wait and every YOUTUBE_ARM_HARD_MUTE_POLL_MS until the
 *   iframe reports the mute, at most YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS polls.
 *   The confirming poll runs the machine's warm.
 * - The warm PLAYING's acceptance (acceptYouTubeWarmPlaying): the settle
 *   starts YOUTUBE_ARM_WARM_PLAY_MS after it.
 * - The settle (settleYouTubeAtTarget), after the machine's pause of the warm
 *   iframe: a seek to the target YOUTUBE_ARM_PAUSE_SEEK_GAP_MS later, then a
 *   poll every YOUTUBE_ARM_SETTLE_POLL_MS until
 *   YOUTUBE_ARM_SETTLE_STABLE_SAMPLES polls in a row find the iframe stopped
 *   at the target, with a pause and a seek again on every
 *   YOUTUBE_ARM_SETTLE_RESEEK_EVERY-th poll that does not.
 *
 * Which PLAYING a machine accepts as its warm is the machine's policy:
 * zero-start refuses one reported before its own warm command and bounds the
 * warm with its prepare watchdog; the PRO arm accepts any PLAYING of its
 * video while it warms, within its prepare deadline. So is the settle's:
 * zero-start re-resolves its target for every seek and poll, reads the
 * position before the video, seeks again one pause-seek gap after the pause,
 * polls on when a seek throws and gives up once its prepare budget has
 * passed; the PRO arm keeps one target, reads the position last, seeks again
 * at once, fails when its first seek throws and gives up at its prepare
 * deadline. arm-steps-golden.test.ts runs both machines on the same scripted
 * iframe.
 */
import {
  YOUTUBE_ARM_HARD_MUTE_MAX_ATTEMPTS,
  YOUTUBE_ARM_HARD_MUTE_POLL_MS,
  YOUTUBE_ARM_PAUSE_SEEK_GAP_MS,
  YOUTUBE_ARM_SETTLE_EPSILON_SEC,
  YOUTUBE_ARM_SETTLE_POLL_MS,
  YOUTUBE_ARM_SETTLE_RESEEK_EVERY,
  YOUTUBE_ARM_SETTLE_STABLE_SAMPLES,
  YOUTUBE_ARM_WARM_PLAY_MS,
} from './constants.ts';

/**
 * The IFrame API's player states a settle poll tells apart. UNSTARTED also
 * stands for a state the poll could not read.
 */
const UNSTARTED = -1;
const PLAYING = 1;
const PAUSED = 2;
const CUED = 5;

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

/**
 * Settles the warm iframe paused at the target, once the machine has paused
 * it and entered its settle phase.
 *
 * After YOUTUBE_ARM_PAUSE_SEEK_GAP_MS on `schedule`, `fence(true)` and then a
 * seek to `target()`. A seek that throws ends the settle with `seekFailed`,
 * or, without one, leaves the polls to find the iframe off the target. A
 * poll follows every YOUTUBE_ARM_SETTLE_POLL_MS after `fence(false)`: it
 * reads `target()` and then, in one try, the iframe's state, its position and
 * `isTargetVideo`, in the machine's order. The iframe is settled on a poll
 * when it holds the machine's video, PAUSED or CUED, within
 * YOUTUBE_ARM_SETTLE_EPSILON_SEC of the target; YOUTUBE_ARM_SETTLE_STABLE_SAMPLES
 * such polls in a row call `settled`. A poll that is not settled pauses a
 * PLAYING iframe and, if it is the YOUTUBE_ARM_SETTLE_RESEEK_EVERY-th poll or
 * a multiple (every poll counts, settled or not), pauses the iframe and
 * seeks to `target()` again. A read or a command that throws there ends the
 * poll as not settled. After every poll that does not settle the iframe,
 * `expired` decides whether the machine gives up; if not, the next poll
 * follows.
 *
 * @param fence Before the seek, each re-seek after the gap (`true`) and each
 *   poll (`false`): the machine's iframe, which that step reads and
 *   commands, or none to end the step there (the machine fails or cancels
 *   first if it should).
 * @param target The target in seconds, read for each seek and at the start
 *   of each poll, outside the poll's try: a throw there leaves the poll.
 * @param isTargetVideo Whether the iframe holds the machine's video.
 * @param positionFirst true: each poll reads the position right after the
 *   state; false: only for a PAUSED or CUED iframe of the machine's video.
 * @param reseekAfterGap true: a re-seek follows its pause after
 *   YOUTUBE_ARM_PAUSE_SEEK_GAP_MS on `schedule`, behind `fence(true)`, where a
 *   throw leaves the timer; false: at once, inside the poll.
 * @param seekFailed The machine's failure when the first seek throws; null:
 *   the polls go on.
 * @param settled The machine's next step once the iframe is settled.
 * @param expired After each poll that does not settle the iframe, with the
 *   state and the position that poll read (UNSTARTED and Infinity when it
 *   could not) and its target: true when the machine gives up (it fails
 *   first).
 * @param schedule The machine's timer for each wait.
 */
export function settleYouTubeAtTarget<Player extends YouTubeArmPlayer>(
  fence: (seek: boolean) => Player | null,
  target: () => number,
  isTargetVideo: (player: Player) => boolean,
  positionFirst: boolean,
  reseekAfterGap: boolean,
  seekFailed: (() => void) | null,
  settled: () => void,
  expired: (state: number, position: number, target: number) => boolean,
  schedule: ArmSchedule,
): void {
  let attempts = 0;
  let stable = 0;
  const poll = (): void => {
    const player = fence(false);
    if (!player) return;
    attempts += 1;
    const goal = target();
    let state = UNSTARTED;
    let position = Number.POSITIVE_INFINITY;
    try {
      state = player.getPlayerState();
      if (positionFirst) position = player.getCurrentTime();
      if (
        isTargetVideo(player) &&
        (state === PAUSED || state === CUED) &&
        Math.abs((positionFirst ? position : (position = player.getCurrentTime())) - goal) <=
          YOUTUBE_ARM_SETTLE_EPSILON_SEC
      ) {
        stable += 1;
      } else {
        stable = 0;
        if (state === PLAYING) player.pauseVideo();
        if (attempts % YOUTUBE_ARM_SETTLE_RESEEK_EVERY === 0) {
          player.pauseVideo();
          if (reseekAfterGap) {
            schedule(() => fence(true)?.seekTo(target(), true), YOUTUBE_ARM_PAUSE_SEEK_GAP_MS);
          } else {
            player.seekTo(target(), true);
          }
        }
      }
    } catch {
      stable = 0;
    }
    if (stable >= YOUTUBE_ARM_SETTLE_STABLE_SAMPLES) settled();
    else if (!expired(state, position, goal)) schedule(poll, YOUTUBE_ARM_SETTLE_POLL_MS);
  };
  schedule(() => {
    const player = fence(true);
    if (!player) return;
    try {
      player.seekTo(target(), true);
    } catch {
      if (seekFailed) {
        seekFailed();
        return;
      }
    }
    schedule(poll, YOUTUBE_ARM_SETTLE_POLL_MS);
  }, YOUTUBE_ARM_PAUSE_SEEK_GAP_MS);
}
