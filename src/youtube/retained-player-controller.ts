import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { IS_IOS } from '../core/platform.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { isPlaybackModeYouTube } from '../player/ownership.ts';
import { getCurrentQueueItemId } from '../player/queue-model.ts';
import type { QueueItemId } from '../types/index.ts';
import {
  getCurrentSessionId,
  getYouTubePlayer,
  getYtAutoplayIntent,
  isYtPlayerReady,
  isYtPrimeBouncePending,
  isYtPrimed,
  setCachedYtPlaylistIdx,
  setYouTubePlayer,
  setYtAutoplayIntent,
  setYtLoadInProgress,
  setYtPrimeBouncePending,
  setYtPrimed,
  setYtPrimeReady,
  setYtPriming,
} from './_state.ts';
import type { YouTubePlayerInstance, YTNamespace } from './_state.ts';
import { YOUTUBE_PRIME_MODE, YOUTUBE_PRIME_VIDEO_ID } from './constants.ts';

declare const YT: YTNamespace;

const RETAINED_PLAYER_PARK_CONFIRM_TIMER = 'yt-retained-player-park-confirm';
const RETAINED_PLAYER_TARGET_CONFIRM_TIMER = 'yt-retained-player-target-confirm';
const RETAINED_PLAYER_CONFIRM_POLL_MS = 40;
// Identity may need a cold-network window, but physical mute gets a separate,
// short proof budget on every sample.
const RETAINED_PLAYER_PARK_CONFIRM_MAX_POLLS = 250;
const RETAINED_PLAYER_TARGET_CONFIRM_MAX_POLLS = 250;
const RETAINED_PLAYER_HARD_MUTE_CONFIRM_MAX_POLLS = 25;
const RETAINED_PLAYER_STABLE_SAMPLES = 2;

type RetainedPlayerPhase =
  | 'parking-prime'
  | 'parking-prime-after-bounce'
  | 'parked'
  | 'loading-target'
  | 'releasing-target'
  | 'active-target';

interface RetainedPlayerTargetRequest {
  videoId: string | null;
  playlistId: string | null;
  autoplay: boolean;
  subIndex: number;
}

export interface RetainedPlayerHandoffRequest extends RetainedPlayerTargetRequest {
  commandPlaylistId: string | null;
  sessionId: number;
  sameVideoReuse: boolean;
}

interface RetainedPlayerParking {
  player: YouTubePlayerInstance;
  generation: number;
  phase: RetainedPlayerPhase;
  outgoingVideoId: string;
  targetVideoId: string | null;
  targetPlaylistId: string | null;
  targetPlaylistIndex: number | null;
  commandIssued: boolean;
  acceptedState: number | null;
  acceptedVideoId: string | null;
  acceptedPlaylistIndex: number | null;
  releaseAccepted: boolean;
  pauseBackObserved: boolean;
  stableVideoId: string | null;
  stablePlaylistIndex: number | null;
  stableState: number | null;
  stableSamples: number;
  pollCount: number;
  hardMuteUnconfirmedPolls: number;
  releaseLoadInProgressOnTargetProof: boolean;
  sessionId: number | null;
  queueItemId: QueueItemId | null;
  retry: RetainedPlayerTargetRequest | null;
}

interface RetainedPlayerTargetIdentity {
  videoId: string;
  state: number;
  playlistIndex: number | null;
}

type RetainedPlayerHardMuteProof =
  | { status: 'confirmed' }
  | { status: 'pending' }
  | { status: 'failed'; reason: string };

interface RetainedPlayerControllerPorts {
  loadTarget(request: RetainedPlayerTargetRequest): void;
  dispatchStableState(player: YouTubePlayerInstance, state: number): void;
  invalidateDurationCache(): void;
  hideSyncOverlay(): void;
  finalizeDestroy(options: { resetHost: boolean; recreatePrime: boolean }): void;
}

/**
 * Owns the retained iOS iframe's phase, identity generation, mute proof, and
 * confirmation timers. The iframe module remains the owner of player creation
 * and UI callbacks through the narrow ports above.
 */
export class RetainedYouTubePlayerController {
  private parking: RetainedPlayerParking | null = null;
  private generation = 0;

  constructor(private readonly ports: RetainedPlayerControllerPorts) {}

  sanitizePlaylistIndex(subIndex: number): number {
    if (!Number.isFinite(subIndex)) return 0;
    return Math.max(0, Math.trunc(subIndex));
  }

  resolveCommandPlaylistId(
    videoId: string | null,
    playlistId: string | null,
    indexingRequested: boolean,
  ): string | null {
    if (!playlistId) return null;
    if (!videoId || !getState('network.hostConn') || indexingRequested) return playlistId;
    return null;
  }

  private clearTimers(): void {
    clearManagedTimer(RETAINED_PLAYER_PARK_CONFIRM_TIMER);
    clearManagedTimer(RETAINED_PLAYER_TARGET_CONFIRM_TIMER);
  }

  private readIdentity(player: YouTubePlayerInstance): { videoId: string; state: number } | null {
    if (!player.getVideoData || !player.getPlayerState) return null;
    try {
      const videoId = player.getVideoData()?.video_id || '';
      const state = player.getPlayerState();
      if (!videoId || !Number.isFinite(state)) return null;
      return { videoId, state };
    } catch {
      return null;
    }
  }

  private readPlaylistIdentity(player: YouTubePlayerInstance): {
    videoId: string;
    state: number;
    playlistIndex: number;
  } | null {
    const identity = this.readIdentity(player);
    if (!identity || identity.videoId === YOUTUBE_PRIME_VIDEO_ID) return null;
    try {
      const playlistIndex = player.getPlaylistIndex?.();
      const playlist = player.getPlaylist?.();
      if (
        typeof playlistIndex !== 'number' ||
        !Number.isInteger(playlistIndex) ||
        playlistIndex < 0 ||
        !Array.isArray(playlist) ||
        playlist[playlistIndex] !== identity.videoId
      ) {
        return null;
      }
      return { ...identity, playlistIndex };
    } catch {
      return null;
    }
  }

  private readMuteState(player: YouTubePlayerInstance): boolean | null {
    if (!player.isMuted) return null;
    try {
      return player.isMuted() === true;
    } catch {
      return null;
    }
  }

  private readSnapshot(player: YouTubePlayerInstance): {
    videoId: string;
    state: number;
    muted: boolean;
  } | null {
    const identity = this.readIdentity(player);
    const muted = this.readMuteState(player);
    if (!identity || muted === null) return null;
    return { ...identity, muted };
  }

  private issueHardMute(player: YouTubePlayerInstance): boolean {
    if (!player.mute || !player.isMuted) return false;
    try {
      player.mute();
      return true;
    } catch {
      return false;
    }
  }

  private proveHardMute(parking: RetainedPlayerParking): RetainedPlayerHardMuteProof {
    const initialMuteState = this.readMuteState(parking.player);
    if (initialMuteState === true) {
      parking.hardMuteUnconfirmedPolls = 0;
      return { status: 'confirmed' };
    }
    if (!this.issueHardMute(parking.player)) {
      return { status: 'failed', reason: 'hard-mute-command-failed' };
    }
    const retriedMuteState = this.readMuteState(parking.player);
    if (retriedMuteState === true) {
      parking.hardMuteUnconfirmedPolls = 0;
      return { status: 'confirmed' };
    }
    parking.hardMuteUnconfirmedPolls += 1;
    if (parking.hardMuteUnconfirmedPolls >= RETAINED_PLAYER_HARD_MUTE_CONFIRM_MAX_POLLS) {
      return {
        status: 'failed',
        reason: retriedMuteState === false ? 'hard-mute-unconfirmed' : 'hard-mute-unreadable',
      };
    }
    return { status: 'pending' };
  }

  private destroy(parking: RetainedPlayerParking, recreatePrime: boolean): void {
    if (this.parking !== parking) return;
    this.clearTimers();
    this.parking = null;

    const { player } = parking;
    for (const command of [
      () => player.mute?.(),
      () => player.pauseVideo?.(),
      () => player.stopVideo?.(),
      () => player.destroy?.(),
    ]) {
      try {
        command();
      } catch (error) {
        log.debug('[YouTube] Retained-player destruction cleanup failed:', error);
      }
    }
    const resetHost = getYouTubePlayer() === player;
    if (resetHost) {
      setYouTubePlayer(null);
      setYtPrimed(false);
      setYtPrimeReady(false);
      setYtPriming(false);
      setYtPrimeBouncePending(false);
    }
    this.ports.finalizeDestroy({
      resetHost,
      recreatePrime: recreatePrime && !isPlaybackModeYouTube(),
    });
  }

  private targetRequestStillCurrent(parking: RetainedPlayerParking): boolean {
    return (
      parking.retry !== null &&
      parking.sessionId === getCurrentSessionId() &&
      parking.queueItemId === getCurrentQueueItemId() &&
      isPlaybackModeYouTube()
    );
  }

  private failParking(parking: RetainedPlayerParking, reason: string): void {
    if (this.parking !== parking) return;
    if (parking.retry && this.targetRequestStillCurrent(parking)) {
      this.retryTargetWithFreshPlayer(parking, reason);
      return;
    }
    log.warn(`[YouTube] Retained-player parking failed (${reason}); rebuilding iframe`);
    this.destroy(parking, IS_IOS);
  }

  private pollParking(parking: RetainedPlayerParking): void {
    if (
      this.parking !== parking ||
      (parking.phase !== 'parking-prime' && parking.phase !== 'parking-prime-after-bounce') ||
      getYouTubePlayer() !== parking.player
    ) {
      return;
    }
    const hardMuteProof = this.proveHardMute(parking);
    if (hardMuteProof.status === 'failed') {
      this.failParking(parking, hardMuteProof.reason);
      return;
    }
    if (hardMuteProof.status === 'pending') {
      parking.stableSamples = 0;
      setManagedTimer(
        RETAINED_PLAYER_PARK_CONFIRM_TIMER,
        () => this.pollParking(parking),
        RETAINED_PLAYER_CONFIRM_POLL_MS,
      );
      return;
    }

    parking.pollCount += 1;
    const identity = this.readIdentity(parking.player);
    const confirmed =
      identity?.videoId === YOUTUBE_PRIME_VIDEO_ID &&
      (identity.state === YT.PlayerState.CUED || identity.state === YT.PlayerState.PAUSED);
    parking.stableSamples = confirmed ? parking.stableSamples + 1 : 0;
    if (parking.stableSamples >= RETAINED_PLAYER_STABLE_SAMPLES) {
      parking.phase = 'parked';
      parking.pollCount = 0;
      parking.stableSamples = 0;
      setCachedYtPlaylistIdx(-1);
      this.ports.invalidateDurationCache();
      if (parking.retry) {
        if (!this.targetRequestStillCurrent(parking)) {
          const ownedCurrentLoad = parking.sessionId === getCurrentSessionId();
          parking.retry = null;
          parking.sessionId = null;
          parking.queueItemId = null;
          if (ownedCurrentLoad) setYtLoadInProgress(false);
        } else if (!this.beginTargetHandoff(parking)) {
          this.retryTargetWithFreshPlayer(parking, 'hard-mute-command-failed');
          return;
        } else {
          const retry = parking.retry;
          if (!retry) return;
          setYtLoadInProgress(true);
          this.ports.loadTarget(retry);
          return;
        }
      }
      setYtPrimeReady(!isYtPrimed() && isYtPlayerReady());
      bus.emit('youtube:zero-start-readiness-changed');
      return;
    }

    const maxPolls = parking.retry
      ? RETAINED_PLAYER_TARGET_CONFIRM_MAX_POLLS
      : RETAINED_PLAYER_PARK_CONFIRM_MAX_POLLS;
    if (parking.pollCount >= maxPolls) {
      this.failParking(parking, 'silent-prime-unconfirmed');
      return;
    }
    setManagedTimer(
      RETAINED_PLAYER_PARK_CONFIRM_TIMER,
      () => this.pollParking(parking),
      RETAINED_PLAYER_CONFIRM_POLL_MS,
    );
  }

  private beginTargetHandoff(parking: RetainedPlayerParking): boolean {
    const retry = parking.retry;
    if (!retry || !this.issueHardMute(parking.player)) return false;
    this.clearTimers();
    parking.generation = ++this.generation;
    parking.phase = 'loading-target';
    parking.targetVideoId = retry.videoId;
    parking.commandIssued = false;
    parking.acceptedState = null;
    parking.acceptedVideoId = null;
    parking.acceptedPlaylistIndex = null;
    parking.releaseAccepted = false;
    parking.pauseBackObserved = false;
    this.resetTargetStableProof(parking);
    parking.pollCount = 0;
    parking.releaseLoadInProgressOnTargetProof = false;
    setYtPrimeReady(false);
    return true;
  }

  private retryTargetWithFreshPlayer(parking: RetainedPlayerParking, reason: string): void {
    if (this.parking !== parking) return;
    const retry = parking.retry;
    const stillCurrent = this.targetRequestStillCurrent(parking);
    log.warn(`[YouTube] Retained-player target handoff failed (${reason}); rebuilding iframe`);
    this.destroy(parking, false);
    if (!stillCurrent || !retry) return;
    setYtLoadInProgress(true);
    this.ports.loadTarget(retry);
  }

  private readTargetIdentity(parking: RetainedPlayerParking): RetainedPlayerTargetIdentity | null {
    if (parking.targetPlaylistId) {
      const playlistIdentity = this.readPlaylistIdentity(parking.player);
      if (!playlistIdentity || playlistIdentity.playlistIndex !== parking.targetPlaylistIndex) {
        return null;
      }
      return playlistIdentity;
    }
    const identity = this.readIdentity(parking.player);
    if (!identity || !parking.targetVideoId || identity.videoId !== parking.targetVideoId) {
      return null;
    }
    return { ...identity, playlistIndex: null };
  }

  private resetTargetStableProof(parking: RetainedPlayerParking): void {
    parking.stableVideoId = null;
    parking.stablePlaylistIndex = null;
    parking.stableState = null;
    parking.stableSamples = 0;
  }

  private scheduleTargetPoll(
    parking: RetainedPlayerParking,
    generation = parking.generation,
  ): void {
    setManagedTimer(
      RETAINED_PLAYER_TARGET_CONFIRM_TIMER,
      () => this.pollTarget(parking, generation),
      RETAINED_PLAYER_CONFIRM_POLL_MS,
    );
  }

  private pollTarget(parking: RetainedPlayerParking, generation: number): void {
    if (
      this.parking !== parking ||
      parking.generation !== generation ||
      parking.phase !== 'loading-target' ||
      !parking.commandIssued ||
      getYouTubePlayer() !== parking.player
    ) {
      return;
    }
    if (!this.targetRequestStillCurrent(parking)) {
      this.retryTargetWithFreshPlayer(parking, 'target-request-superseded');
      return;
    }
    const hardMuteProof = this.proveHardMute(parking);
    if (hardMuteProof.status === 'failed') {
      this.retryTargetWithFreshPlayer(parking, hardMuteProof.reason);
      return;
    }
    if (hardMuteProof.status === 'pending') {
      this.resetTargetStableProof(parking);
      this.scheduleTargetPoll(parking, generation);
      return;
    }

    parking.pollCount += 1;
    const identity = this.readTargetIdentity(parking);
    const usableState =
      identity?.state === YT.PlayerState.CUED ||
      identity?.state === YT.PlayerState.PAUSED ||
      identity?.state === YT.PlayerState.PLAYING;
    if (identity && usableState) {
      if (
        parking.stableVideoId === identity.videoId &&
        parking.stablePlaylistIndex === identity.playlistIndex &&
        parking.stableState === identity.state
      ) {
        parking.stableSamples += 1;
      } else {
        parking.stableVideoId = identity.videoId;
        parking.stablePlaylistIndex = identity.playlistIndex;
        parking.stableState = identity.state;
        parking.stableSamples = 1;
      }
    } else {
      this.resetTargetStableProof(parking);
    }

    if (identity && parking.stableSamples >= RETAINED_PLAYER_STABLE_SAMPLES) {
      if (
        identity.state === YT.PlayerState.PLAYING &&
        !getYtAutoplayIntent() &&
        parking.pauseBackObserved
      ) {
        try {
          parking.player.pauseVideo?.();
        } catch (error) {
          log.debug('[YouTube] Retained target pause-back retry failed:', error);
        }
        this.resetTargetStableProof(parking);
        if (parking.pollCount >= RETAINED_PLAYER_TARGET_CONFIRM_MAX_POLLS) {
          this.retryTargetWithFreshPlayer(parking, 'pause-back-unconfirmed');
          return;
        }
        this.scheduleTargetPoll(parking, generation);
        return;
      }
      parking.phase = 'releasing-target';
      parking.acceptedState = identity.state;
      parking.acceptedVideoId = identity.videoId;
      parking.acceptedPlaylistIndex = identity.playlistIndex;
      parking.releaseAccepted = false;
      const releasesOrdinaryLoad =
        parking.releaseLoadInProgressOnTargetProof &&
        !(identity.state === YT.PlayerState.PLAYING && !getYtAutoplayIntent());
      if (releasesOrdinaryLoad) setYtLoadInProgress(false);
      this.ports.dispatchStableState(parking.player, identity.state);
      if (
        this.parking !== parking ||
        parking.generation !== generation ||
        getYouTubePlayer() !== parking.player
      ) {
        return;
      }
      if (!parking.releaseAccepted) {
        parking.phase = 'loading-target';
        parking.acceptedState = null;
        parking.acceptedVideoId = null;
        parking.acceptedPlaylistIndex = null;
        this.resetTargetStableProof(parking);
        this.scheduleTargetPoll(parking, generation);
        return;
      }
      if (identity.state === YT.PlayerState.PLAYING && !getYtAutoplayIntent()) {
        parking.phase = 'loading-target';
        parking.acceptedState = null;
        parking.acceptedVideoId = null;
        parking.acceptedPlaylistIndex = null;
        parking.releaseAccepted = false;
        parking.pauseBackObserved = true;
        this.resetTargetStableProof(parking);
        this.scheduleTargetPoll(parking, generation);
        return;
      }
      parking.phase = 'active-target';
      parking.acceptedState = null;
      parking.acceptedVideoId = null;
      parking.acceptedPlaylistIndex = null;
      parking.releaseAccepted = false;
      parking.retry = null;
      this.resetTargetStableProof(parking);
      parking.releaseLoadInProgressOnTargetProof = false;
      bus.emit('audio:apply-youtube-volume');
      return;
    }

    if (parking.pollCount >= RETAINED_PLAYER_TARGET_CONFIRM_MAX_POLLS) {
      this.retryTargetWithFreshPlayer(parking, 'target-unconfirmed');
      return;
    }
    this.scheduleTargetPoll(parking, generation);
  }

  armHandoff(
    player: YouTubePlayerInstance | null,
    request: RetainedPlayerHandoffRequest,
  ): 'ready' | 'deferred' | 'rebuilt' {
    const parking = this.parking;
    if (!player || parking?.player !== player) return 'ready';
    const invalidTarget =
      (!request.videoId && !request.commandPlaylistId) ||
      request.videoId === YOUTUBE_PRIME_VIDEO_ID;
    if (invalidTarget) {
      this.destroy(parking, false);
      return 'rebuilt';
    }
    const hasConfirmedPrimeBoundary =
      parking.phase === 'parked' ||
      parking.phase === 'parking-prime' ||
      parking.phase === 'parking-prime-after-bounce';
    if (request.commandPlaylistId && !hasConfirmedPrimeBoundary) {
      const parked = this.park(player);
      const replacementParking = this.parking;
      if (!parked || replacementParking?.player !== player) {
        if (replacementParking?.player === player) this.destroy(replacementParking, false);
        return 'rebuilt';
      }
      return this.armHandoff(player, request);
    }
    if (parking.phase === 'active-target' && request.sameVideoReuse) {
      this.forget(player);
      return 'ready';
    }

    parking.sessionId = request.sessionId;
    parking.queueItemId = getCurrentQueueItemId();
    parking.targetVideoId = request.videoId;
    parking.targetPlaylistId = request.commandPlaylistId;
    parking.targetPlaylistIndex = request.commandPlaylistId ? request.subIndex : null;
    parking.retry = {
      videoId: request.videoId,
      playlistId: request.playlistId,
      autoplay: request.autoplay,
      subIndex: request.subIndex,
    };
    const parkingPrime =
      parking.phase === 'parking-prime' || parking.phase === 'parking-prime-after-bounce';
    if (parkingPrime) {
      if (!this.issueHardMute(player)) {
        this.destroy(parking, false);
        return 'rebuilt';
      }
      parking.pollCount = 0;
      parking.stableSamples = 0;
      setYtPrimeReady(false);
      setManagedTimer(
        RETAINED_PLAYER_PARK_CONFIRM_TIMER,
        () => this.pollParking(parking),
        RETAINED_PLAYER_CONFIRM_POLL_MS,
      );
      return 'deferred';
    }
    if (!this.beginTargetHandoff(parking)) {
      this.destroy(parking, false);
      return 'rebuilt';
    }
    return 'ready';
  }

  markLoadCommand(
    player: YouTubePlayerInstance,
    videoId: string | null,
    playlistId: string | null,
    subIndex: number,
    releaseLoadInProgressOnTargetProof: boolean,
  ): boolean {
    const parking = this.parking;
    const commandMatches = parking?.targetPlaylistId
      ? playlistId === parking.targetPlaylistId && subIndex === parking.targetPlaylistIndex
      : !playlistId && videoId !== null && parking?.targetVideoId === videoId;
    if (
      !parking ||
      parking.player !== player ||
      parking.phase !== 'loading-target' ||
      !commandMatches
    ) {
      return false;
    }
    parking.generation = ++this.generation;
    parking.commandIssued = true;
    parking.pollCount = 0;
    this.resetTargetStableProof(parking);
    parking.releaseLoadInProgressOnTargetProof = releaseLoadInProgressOnTargetProof;
    this.scheduleTargetPoll(parking);
    return true;
  }

  ensureHardMuted(player: YouTubePlayerInstance): boolean {
    const parking = this.parking;
    if (!parking || parking.player !== player) return true;
    if (!this.issueHardMute(player)) {
      if (parking.retry && isPlaybackModeYouTube()) {
        this.retryTargetWithFreshPlayer(parking, 'hard-mute-command-failed');
      } else {
        this.destroy(parking, IS_IOS && !isPlaybackModeYouTube());
      }
      return false;
    }
    const muted = this.readMuteState(player);
    if (muted === true) {
      parking.hardMuteUnconfirmedPolls = 0;
      return true;
    }
    if (
      parking.phase === 'parked' ||
      parking.phase === 'parking-prime' ||
      parking.phase === 'parking-prime-after-bounce'
    ) {
      const confirmsPostBouncePause =
        (parking.phase === 'parked' || parking.phase === 'parking-prime-after-bounce') &&
        isYtPrimed() &&
        this.readIdentity(player)?.videoId === YOUTUBE_PRIME_VIDEO_ID;
      if (parking.phase === 'parked') parking.hardMuteUnconfirmedPolls = 0;
      parking.phase = confirmsPostBouncePause ? 'parking-prime-after-bounce' : 'parking-prime';
      parking.pollCount = 0;
      parking.stableSamples = 0;
      setYtPrimeReady(false);
      setManagedTimer(
        RETAINED_PLAYER_PARK_CONFIRM_TIMER,
        () => this.pollParking(parking),
        RETAINED_PLAYER_CONFIRM_POLL_MS,
      );
    } else {
      if (parking.phase === 'active-target' || parking.phase === 'releasing-target') {
        parking.hardMuteUnconfirmedPolls = 0;
      }
      parking.phase = 'loading-target';
      parking.acceptedState = null;
      parking.acceptedVideoId = null;
      parking.acceptedPlaylistIndex = null;
      parking.releaseAccepted = false;
      parking.pollCount = 0;
      parking.stableSamples = 0;
      parking.stableVideoId = null;
      parking.stablePlaylistIndex = null;
      parking.stableState = null;
      if (parking.commandIssued) this.scheduleTargetPoll(parking);
    }
    return true;
  }

  shouldIgnoreCallback(player: YouTubePlayerInstance, state?: number): boolean {
    const parking = this.parking;
    if (!parking || parking.player !== player) return false;
    if (!isPlaybackModeYouTube()) {
      const snapshot = this.readSnapshot(player);
      const intentionalPrimeBounce =
        state === YT.PlayerState.PLAYING &&
        parking.phase === 'parked' &&
        isYtPrimeBouncePending() &&
        snapshot?.videoId === YOUTUBE_PRIME_VIDEO_ID &&
        snapshot.state === YT.PlayerState.PLAYING;
      if (intentionalPrimeBounce) return false;
      if (state === YT.PlayerState.PLAYING) {
        const hardMuteIssued = this.ensureHardMuted(player);
        try {
          player.pauseVideo?.();
        } catch (error) {
          log.debug('[YouTube] Failed to pause a parked-player callback:', error);
        }
        if (hardMuteIssued && this.parking === parking) {
          if (
            (parking.phase !== 'parked' &&
              parking.phase !== 'parking-prime' &&
              parking.phase !== 'parking-prime-after-bounce') ||
            snapshot?.videoId !== YOUTUBE_PRIME_VIDEO_ID
          ) {
            const parked = this.park(player);
            const failedParking = this.parking;
            if (!parked && failedParking?.player === player) this.destroy(failedParking, IS_IOS);
          }
        }
      }
      return true;
    }
    if (parking.phase === 'releasing-target') {
      let accepted = false;
      if (state !== undefined && state === parking.acceptedState) {
        if (parking.targetPlaylistId) {
          const playlistIdentity = this.readPlaylistIdentity(player);
          accepted =
            this.readMuteState(player) === true &&
            playlistIdentity !== null &&
            playlistIdentity.videoId === parking.acceptedVideoId &&
            playlistIdentity.playlistIndex === parking.acceptedPlaylistIndex &&
            playlistIdentity.state === state;
        } else {
          const snapshot = this.readSnapshot(player);
          accepted =
            snapshot?.videoId === parking.acceptedVideoId &&
            snapshot.state === state &&
            snapshot.muted;
        }
      }
      if (accepted) parking.releaseAccepted = true;
      return !accepted;
    }
    if (parking.phase === 'active-target') {
      if (parking.targetPlaylistId) {
        const playlistIdentity = this.readPlaylistIdentity(player);
        if (state === undefined) return !playlistIdentity;
        return !playlistIdentity || playlistIdentity.state !== state;
      }
      const snapshot = this.readSnapshot(player);
      if (state === undefined) return snapshot?.videoId !== parking.targetVideoId;
      return !(snapshot?.videoId === parking.targetVideoId && snapshot.state === state);
    }
    return true;
  }

  isParked(player: YouTubePlayerInstance | null): boolean {
    return (
      !!player &&
      this.parking?.player === player &&
      (this.parking.phase !== 'active-target' || !isPlaybackModeYouTube())
    );
  }

  isTargetHandoffPending(player: YouTubePlayerInstance | null): boolean {
    return (
      !!player &&
      this.parking?.player === player &&
      (this.parking.phase === 'loading-target' || this.parking.phase === 'releasing-target')
    );
  }

  rebindActiveTargetToVideo(player: YouTubePlayerInstance, videoId: string): void {
    const parking = this.parking;
    if (!videoId || parking?.player !== player || parking.phase !== 'active-target') return;
    parking.targetVideoId = videoId;
    parking.targetPlaylistId = null;
    parking.targetPlaylistIndex = null;
  }

  park(player: YouTubePlayerInstance): boolean {
    if (getYouTubePlayer() !== player) return false;
    this.clearTimers();
    let outgoingVideoId = '';
    try {
      outgoingVideoId = player.getVideoData?.()?.video_id || '';
    } catch {
      // The hard-mute/cue confirmation remains authoritative.
    }
    const parking: RetainedPlayerParking = {
      player,
      generation: ++this.generation,
      phase: 'parking-prime',
      outgoingVideoId,
      targetVideoId: null,
      targetPlaylistId: null,
      targetPlaylistIndex: null,
      commandIssued: false,
      acceptedState: null,
      acceptedVideoId: null,
      acceptedPlaylistIndex: null,
      releaseAccepted: false,
      pauseBackObserved: false,
      stableVideoId: null,
      stablePlaylistIndex: null,
      stableState: null,
      stableSamples: 0,
      pollCount: 0,
      hardMuteUnconfirmedPolls: 0,
      releaseLoadInProgressOnTargetProof: false,
      sessionId: null,
      queueItemId: null,
      retry: null,
    };
    this.parking = parking;
    setYtAutoplayIntent(false);
    this.ports.hideSyncOverlay();
    setYtPrimeReady(false);
    if (!this.issueHardMute(player)) return false;
    try {
      player.pauseVideo?.();
    } catch (error) {
      log.debug('[YouTube] Failed to pause retained player before parking:', error);
    }
    if (YOUTUBE_PRIME_MODE === 'B' && YOUTUBE_PRIME_VIDEO_ID && player.cueVideoById) {
      try {
        player.cueVideoById(YOUTUBE_PRIME_VIDEO_ID, 0);
        setManagedTimer(
          RETAINED_PLAYER_PARK_CONFIRM_TIMER,
          () => this.pollParking(parking),
          RETAINED_PLAYER_CONFIRM_POLL_MS,
        );
        return true;
      } catch (error) {
        log.warn('[YouTube] Failed to park retained player on the silent prime video:', error);
      }
    }
    try {
      player.stopVideo?.();
    } catch {
      // The caller performs definitive destruction.
    }
    return false;
  }

  forget(player: YouTubePlayerInstance): void {
    if (this.parking?.player !== player) return;
    this.clearTimers();
    this.parking = null;
  }

  verifyBeforePrimeBounce(player: YouTubePlayerInstance): boolean {
    const parking = this.parking;
    if (!parking || parking.player !== player) return true;
    const snapshot = this.readSnapshot(player);
    const safeResident =
      parking.phase === 'parked' &&
      snapshot?.videoId === YOUTUBE_PRIME_VIDEO_ID &&
      snapshot.muted &&
      (snapshot.state === YT.PlayerState.CUED || snapshot.state === YT.PlayerState.PAUSED);
    if (safeResident) return true;
    setYtPrimeReady(false);
    setYtPrimeBouncePending(false);
    clearManagedTimer('yt-prime-bounce-timeout');
    const parked = this.park(player);
    const failedParking = this.parking;
    if (!parked && failedParking?.player === player) this.destroy(failedParking, IS_IOS);
    return false;
  }

  recoverPrimeBounceForRetry(player: YouTubePlayerInstance | null): void {
    setYtPrimeBouncePending(false);
    setYtPrimeReady(false);
    clearManagedTimer('yt-prime-bounce-timeout');
    if (!player || getYouTubePlayer() !== player || isYtPrimed()) {
      bus.emit('youtube:zero-start-readiness-changed');
      return;
    }
    if (this.parking?.player === player) {
      const parked = this.park(player);
      const failedParking = this.parking;
      if (!parked && failedParking?.player === player) this.destroy(failedParking, IS_IOS);
      bus.emit('youtube:zero-start-readiness-changed');
      return;
    }
    if (isYtPlayerReady()) setYtPrimeReady(true);
    bus.emit('youtube:zero-start-readiness-changed');
  }
}
