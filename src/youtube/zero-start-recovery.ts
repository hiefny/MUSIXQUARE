/**
 * The Standard guest's local zero-start recovery: when the zero-start run
 * gives up this guest's start (the host committed without it, its clock is
 * uncalibrated, its prepare failed or its release timed out), the recovery
 * takes the start over on the current iframe on its own.
 *
 * Registry RO-33, an accepted exception under RO-02: the recovery stays an
 * owner of its own beside the run, never a stage of it, so the run's facades
 * (isYouTubeZeroStartInFlight, isYouTubeZeroStartProtocolActive) read false
 * while it holds the start. Its claim on the start ledger is player.ts's: the
 * two flags player.ts keeps and registers as 'standard-recovery' (owned: the
 * iframe's events are the recovery's; retained: its player state stays the
 * recovery's until the release is acknowledged), which this class sets
 * through the setters it is given. It sets no timer either: every wait goes
 * through the caller's schedule (player.ts's 'yt-zero-start-external-fallback'
 * managed timer), and player.ts keeps the fence, the run's snapshot and the
 * desired audio it hands over.
 *
 * One attempt at a time: the fence first; a cohort-excluded guest whose load
 * is issued adopts what is left of the prepare budget, any other start gets
 * YOUTUBE_RECOVERY_BRIDGE_MS. The target is ready when the iframe plays or
 * buffers it, or holds it within YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC of the
 * local zero; it is then paused and sought there, polled every
 * YOUTUBE_RECOVERY_POLL_MS until settled, and held muted until the room's
 * start. The audio is restored by command, check and poll (the third
 * cadence) until max(deadline, now + 1 s); the release seeks to the room
 * position and plays, and a PLAYING within YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS
 * ends the recovery. A recovery that fails restores the exact iframe through
 * the verified restore ('verify-then-settle', iframe-audio.ts).
 */
import { log } from '../core/log.ts';
import { getHostNow, isClockCalibrated } from '../network/shared-clock.ts';
import { setYtAutoplayIntent } from './_state.ts';
import {
  STANDARD_ZERO_START_GUEST_DECISION_MS,
  STANDARD_ZERO_START_PREPARE_BUDGET_MS,
  YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS,
  YOUTUBE_RECOVERY_BRIDGE_MS,
  YOUTUBE_RECOVERY_POLL_MS,
  YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC,
} from './constants.ts';
import {
  isYouTubeAudioRestored,
  restoreYouTubeAudioVerified,
  writeYouTubeAudio,
} from './iframe-audio.ts';
import type { YouTubeZeroStartFallbackEvent, YouTubeZeroStartPlayer } from './zero-start.ts';

/** The audio a recovery restores: the user's intent from before the run's hard mute. */
interface RecoveryAudio {
  muted: boolean;
  volume: number;
}

/**
 * What the caller lends the recovery, by position: a property name would ship
 * in the eagerly loaded entry chunk.
 */
type GuestRecoveryPorts = readonly [
  /** The caller's one timer: a new wait replaces a pending one. */
  schedule: (callback: () => void, delayMs: number) => void,
  /** Clears that timer. */
  cancel: () => void,
  /** The claim's active flag: the recovery owns the iframe's events. */
  setOwned: (owned: boolean) => void,
  /** The claim's held player state, until the release is acknowledged. */
  setRetained: (retained: boolean) => void,
  /** Reads it. */
  isRetained: () => boolean,
];

export class GuestZeroStartRecovery {
  /** Moved by every clear and settled recovery: an attempt or cleanup of an older one is stale. */
  #generation = 0;
  /** The held iframe's unverified cleanup, which clear() runs. */
  #cleanup: (() => void) | null = null;
  readonly #ports: GuestRecoveryPorts;

  constructor(...ports: GuestRecoveryPorts) {
    this.#ports = ports;
  }

  /**
   * Ends the recovery: a later attempt or cleanup is stale, the timer and
   * both flags clear, and the held iframe gets its unverified cleanup unless
   * `transfer`. Returns whether a transfer took the recovery's player state.
   */
  clear(transfer = false): boolean {
    const [, cancel, setOwned, setRetained, isRetained] = this.#ports;
    this.#generation += 1;
    cancel();
    setOwned(false);
    const cleanup = this.#cleanup;
    const hadPlayerState = isRetained();
    this.#cleanup = null;
    setRetained(false);
    // A newly accepted PREPARE immediately takes ownership of this exact
    // iframe. Do not run any old pause/seek/unmute command: a delayed WebKit
    // unmute could land after the new hard mute. The new run receives the
    // canonical app audio intent instead. Ordinary cancellation still
    // performs the full exact-player cleanup.
    if (!transfer) cleanup?.();
    return transfer && hadPlayerState;
  }

  /**
   * Takes over the start `event` hands over.
   * @param isCurrent The caller's fence, asked at every attempt.
   * @param audibleLeadMs This device's fixed audible lead.
   * @param capture Captures the audio to restore; the caller may retarget it later.
   * @param getPlayer The current iframe, or null.
   * @param resolveTarget The local position for a room position.
   * @param resolveDelay The participant-local start delay at a room position.
   */
  start(
    event: YouTubeZeroStartFallbackEvent,
    isCurrent: () => boolean,
    audibleLeadMs: number,
    capture: (event: YouTubeZeroStartFallbackEvent) => RecoveryAudio,
    getPlayer: () => YouTubeZeroStartPlayer | null,
    resolveTarget: (canonicalPositionSec: number) => number,
    resolveDelay: (canonicalPositionSec: number) => number,
  ): void {
    const [schedule, cancel, setOwned, setRetained] = this.#ports;
    const handedOffPlayer =
      event.targetLoadIssued || event.mediaAction === 'resident-reposition'
        ? event.handedOffPlayer
        : null;
    const generation = this.#generation;
    // A cohort-excluded guest may already be 2.3s into the controller's
    // original 10s prepare window. Adopt that load for the remainder of the
    // same bounded window instead of restarting its deadline and media load.
    const canAdoptRemainingPrepareWindow =
      event.reason === 'cohort-excluded' &&
      (event.targetLoadIssued === true || event.mediaAction === 'resident-reposition');
    const deadline =
      Date.now() +
      (canAdoptRemainingPrepareWindow
        ? STANDARD_ZERO_START_PREPARE_BUDGET_MS - STANDARD_ZERO_START_GUEST_DECISION_MS
        : YOUTUBE_RECOVERY_BRIDGE_MS);
    const uncalibratedHoldMs = Math.max(
      0,
      resolveDelay(event.targetPositionSec ?? 0) - audibleLeadMs,
    );
    const uncalibratedReleaseAt = Date.now() + uncalibratedHoldMs;
    const desiredAudio = capture(event);
    let loadIssued = false;
    let fallbackPlayer: YouTubeZeroStartPlayer | null = null;
    let settleIssued = false;
    let releasePlayIssued = false;
    let releaseAckDeadline = 0;
    let releaseAudioDeadline = 0;

    const cleanupExactPlayer = (player: YouTubeZeroStartPlayer): void => {
      setYtAutoplayIntent(false);
      player.pauseVideo();
      player.seekTo(resolveTarget(0), true);
      writeYouTubeAudio(player, desiredAudio);
    };

    const abandonFallback = (verifyAudioRestore = false): void => {
      if (generation !== this.#generation) return;
      const cleanupGeneration = ++this.#generation;
      cancel();
      setYtAutoplayIntent(false);
      const ownedPlayer = fallbackPlayer ?? handedOffPlayer;
      const cleanup = this.#cleanup;
      this.#cleanup = null;
      setRetained(false);
      if (!verifyAudioRestore || !ownedPlayer) {
        setOwned(false);
        cleanup?.();
        return;
      }

      // A timed-out fallback must not leave WebKit's transient hard mute as
      // the new user intent. Retry and verify the exact owned iframe only;
      // a later run increments the generation and fences this cleanup.
      // Every attempt reissues the pause and the seek with the audio.
      const endCleanup = (): void => {
        setOwned(false);
        cancel();
      };
      setOwned(true);
      restoreYouTubeAudioVerified(
        'verify-then-settle',
        () => cleanupGeneration === this.#generation,
        () => cleanupExactPlayer(ownedPlayer),
        () => isYouTubeAudioRestored(ownedPlayer, desiredAudio),
        endCleanup,
        schedule,
      );
    };

    const attemptFallback = (): void => {
      if (generation !== this.#generation || !isCurrent()) {
        abandonFallback();
        return;
      }

      const player = getPlayer();
      if (!player) {
        if (Date.now() < deadline) {
          schedule(attemptFallback, YOUTUBE_RECOVERY_POLL_MS);
        } else {
          abandonFallback(true);
        }
        return;
      }

      try {
        if (fallbackPlayer !== player) {
          const previousPlayer = fallbackPlayer;
          if (previousPlayer) {
            try {
              cleanupExactPlayer(previousPlayer);
            } catch {
              // A rebuilt iframe can disappear between polls. Never let its
              // ownership token migrate to the replacement instance.
            }
          }
          fallbackPlayer = player;
          // targetLoadIssued belongs to the exact player handed off by the
          // controller. A rebuilt iframe has no such load to adopt.
          loadIssued =
            player === handedOffPlayer &&
            (event.targetLoadIssued === true ||
              (event.mediaAction === 'resident-reposition' &&
                (player.getVideoData().video_id ?? '') === event.videoId));
          settleIssued = false;
          releasePlayIssued = false;
          releaseAckDeadline = 0;
          releaseAudioDeadline = 0;
          const ownedPlayer = player;
          this.#cleanup = () => {
            setYtAutoplayIntent(false);
            try {
              cleanupExactPlayer(ownedPlayer);
            } catch {
              // A stale/rebuilt iframe is fenced by the exact identity token.
            }
          };
          setRetained(true);
        }

        if (releasePlayIssued) {
          const releaseAcknowledged =
            player === fallbackPlayer &&
            (player.getVideoData().video_id ?? '') === event.videoId &&
            player.getPlayerState() === 1;
          if (releaseAcknowledged) {
            cancel();
            this.#cleanup = null;
            setRetained(false);
            this.#generation += 1;
            log.warn(`[YouTube ZeroStart] Recovered locally: ${event.reason}`);
            return;
          }
          if (Date.now() >= releaseAckDeadline) {
            log.warn('[YouTube ZeroStart] Local fallback release was not acknowledged');
            setOwned(true);
            setYtAutoplayIntent(false);
            abandonFallback(true);
            return;
          }
          // The ordinary iframe handler remains enabled so its first real
          // PLAYING transition updates the UI. This poll only confirms that
          // the exact player/track accepted the release command.
          setOwned(false);
          setYtAutoplayIntent(true);
          schedule(attemptFallback, YOUTUBE_RECOVERY_POLL_MS);
          return;
        }

        // Keep every late PLAYING/CUED/ENDED event under this recovery owner.
        // The normal iframe handler sees the successful release only after
        // this flag and autoplay guard are deliberately switched below.
        setOwned(true);
        setYtAutoplayIntent(false);

        if (!loadIssued) {
          loadIssued = true;
          player.mute();
          player.loadVideoById(event.videoId, resolveTarget(0));
        }

        const currentVideoId = player.getVideoData().video_id ?? '';
        const playerState = player.getPlayerState();
        const currentTime = player.getCurrentTime();
        const zeroTarget = resolveTarget(0);
        const canRepositionResident =
          player === handedOffPlayer &&
          event.mediaAction === 'resident-reposition' &&
          currentVideoId === event.videoId &&
          (playerState === 0 || playerState === 2 || playerState === 5);
        const targetIdentityReady =
          currentVideoId === event.videoId &&
          (playerState === 1 ||
            playerState === 3 ||
            ((playerState === 2 || playerState === 5) &&
              Math.abs(currentTime - zeroTarget) <= YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC) ||
            canRepositionResident);

        if (!targetIdentityReady && Date.now() < deadline) {
          schedule(attemptFallback, YOUTUBE_RECOVERY_POLL_MS);
          return;
        }
        if (!targetIdentityReady) {
          abandonFallback(true);
          return;
        }

        if (!settleIssued) {
          player.pauseVideo();
          player.seekTo(zeroTarget, true);
          settleIssued = true;
          schedule(attemptFallback, YOUTUBE_RECOVERY_POLL_MS);
          return;
        }

        const settledState = player.getPlayerState();
        const settledTime = player.getCurrentTime();
        const playerReady =
          (player.getVideoData().video_id ?? '') === event.videoId &&
          (settledState === 2 || settledState === 5) &&
          Math.abs(settledTime - zeroTarget) <= YOUTUBE_RECOVERY_SETTLE_EPSILON_SEC;
        if (!playerReady && Date.now() < deadline) {
          player.pauseVideo();
          player.seekTo(zeroTarget, true);
          schedule(attemptFallback, YOUTUBE_RECOVERY_POLL_MS);
          return;
        }
        if (!playerReady) {
          abandonFallback(true);
          return;
        }

        const releaseWaitMs =
          event.startAtHost !== null && isClockCalibrated()
            ? event.startAtHost + resolveDelay(0) - audibleLeadMs - getHostNow()
            : uncalibratedReleaseAt - Date.now();
        if (releaseWaitMs > 0) {
          // The iframe recovered before the authoritative COMMIT deadline.
          // Keep it silent and cued, then revalidate the exact run/connection
          // identity at release instead of letting this guest start early.
          const localTarget = resolveTarget(0);
          player.mute();
          player.pauseVideo();
          player.seekTo(localTarget, true);
          schedule(attemptFallback, Math.max(1, releaseWaitMs));
          return;
        }

        // An intentional negative hold may outlive the preparation budget.
        // The iframe still needs its own bounded asynchronous audio restore:
        // the third cadence, command, check, then a poll.
        if (!releaseAudioDeadline) releaseAudioDeadline = Math.max(deadline, Date.now() + 1000);
        writeYouTubeAudio(player, desiredAudio);
        const audioRestored = isYouTubeAudioRestored(player, desiredAudio);
        if (!audioRestored) {
          if (Date.now() < releaseAudioDeadline) {
            schedule(attemptFallback, YOUTUBE_RECOVERY_POLL_MS);
          } else {
            abandonFallback(true);
          }
          return;
        }

        // Keep the signed canonical position until adding the fixed lead:
        // a release 250ms before zero must seek to zero, not to +250ms.
        const canonicalTarget =
          (event.startAtHost !== null && isClockCalibrated()
            ? (getHostNow() - event.startAtHost) / 1_000
            : (event.targetPositionSec ?? 0) + uncalibratedHoldMs / 1000) +
          audibleLeadMs / 1000;
        const localTarget = resolveTarget(canonicalTarget);
        player.pauseVideo();
        player.seekTo(localTarget, true);
        writeYouTubeAudio(player, desiredAudio);
        setYtAutoplayIntent(true);
        setOwned(false);
        try {
          player.playVideo();
        } catch (error) {
          setOwned(true);
          setYtAutoplayIntent(false);
          log.warn('[YouTube ZeroStart] Local fallback release failed:', error);
          abandonFallback(true);
          return;
        }
        releasePlayIssued = true;
        releaseAckDeadline = Date.now() + YOUTUBE_ARM_RELEASE_ACK_TIMEOUT_MS;
        schedule(attemptFallback, 0);
      } catch (error) {
        if (Date.now() < Math.max(deadline, releaseAudioDeadline)) {
          schedule(attemptFallback, YOUTUBE_RECOVERY_POLL_MS);
        } else {
          log.warn('[YouTube ZeroStart] Local fallback failed:', error);
          abandonFallback(true);
        }
      }
    };

    log.warn(`[YouTube ZeroStart] Falling back locally: ${event.reason}`);
    try {
      setOwned(true);
      schedule(attemptFallback, 0);
    } catch (error) {
      setOwned(false);
      log.warn('[YouTube ZeroStart] Local fallback failed:', error);
    }
  }
}
