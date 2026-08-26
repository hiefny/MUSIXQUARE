/**
 * MUSIXQUARE — Playback Engine (Coordinator)
 *
 * Orchestrates: protocol handler registration, bus event wiring.
 * Re-exports all public API from sub-modules.
 *
 * Sub-modules:
 *   _state.ts    — shared module state (leaf node)
 *   transport.ts — play/pause/stop/seek, track position
 *   decode.ts    — file loading, decoding, guest finalization
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, PLAYBACK_STATE, TRANSFER_STATE } from '../core/constants.ts';
import { transition } from './lifecycle.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { getHostNow, getClockOffset, getClockBestRtt } from '../network/shared-clock.ts';
import { cleanupStoredFile, readStoredFile } from '../storage/storage.ts';
import { sendFileDeliveryUnavailable, unicastFile } from '../storage/transfer.ts';
import { unicastPreload } from '../storage/preload.ts';
import { broadcast, isRemoteGuest, safeSend } from '../network/peer.ts';
import { prepareRemoteShareWait, shouldWaitForRemoteShare } from '../share/remote-share.ts';
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import { beginFileRequest, sendFileRequest } from '../network/file-request-authority.ts';
import type { DataConnection, QueueItemId, ResidentFile } from '../types/index.ts';
import {
  isGuestR2FileDelivery,
  markLateLocalPeerForR2,
  resolvePeerFileDelivery,
} from '../share/file-delivery-policy.ts';

import {
  isCurrentLoadEpoch,
  getCurrentAudioBuffer,
  getTrackKeyFromItem,
  isTrackFailed,
  newLoadEpoch,
  setPendingRecoveryTarget,
  setPendingPlayTime,
  isPlayPreloadedInProgress,
  setLastClearedQueueItemId,
  setLocalFilePaused,
} from './_state.ts';

import {
  play,
  pause,
  stopAllMedia,
  getTrackPosition,
  handleEnded,
  invalidatePendingFilePlayIntent,
  isFilePipelineBusyForPlay,
  skipTime,
  startHostFileAndBroadcastPlay,
} from './transport.ts';

import { loadPreloadedTrack, clearPreviousTrackState, finalizeGuestFile } from './decode.ts';
import { showLoader, updateLoader, showToast } from '../ui/toast.ts';
import {
  isProRoomPersistentPlaylistFile,
  registerProRoomDirectFileHandler,
} from '../pro-room/media-hooks.ts';
import {
  createFileTrackMeta,
  getPlaybackModeActivity,
  isPlaybackActiveYouTube,
  isPlaybackPausedOrPendingFile,
  isPlaybackPlayingFile,
  isPlaybackPlayingSystemAudio,
  isSystemAudioOwner,
  isYouTubeOwner,
  setPlaybackTrackMeta,
  setPlaybackTransferState,
} from './ownership.ts';
import {
  findQueueItemIndex,
  getCurrentQueueItemId,
  getQueueItemById,
  isQueueItemId,
  selectQueueItemById,
} from './queue-model.ts';
import { hasSystemAudioDeviceCapacity } from '../audio/system-audio-policy.ts';
import { getYouTubePlayer } from '../youtube/_state.ts';
import { loadPlaylistModule } from './playlist-loader.ts';
import { isActiveStandardRoomCoordinator } from '../rooms/authority.ts';

/** Must match SCHEDULE_AHEAD_MS in transport.ts */
const SCHEDULE_AHEAD_MS = 200;
const SAME_TRACK_REPLAY_RESYNC_DELAY_MS = 1000;

function canonicalizeRequestedSeekTime(value: unknown): number {
  const parsed = Number(value);
  let time = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  let rawDuration: unknown;

  if (isYouTubeOwner()) {
    try {
      rawDuration = getYouTubePlayer()?.getDuration?.();
    } catch (error) {
      log.debug('[Playback] Could not read YouTube duration for OP seek clamp:', error);
    }
  } else {
    rawDuration = getCurrentAudioBuffer()?.duration;
  }

  const duration = Number(rawDuration);
  if (Number.isFinite(duration) && duration > 0 && time > duration) {
    time = Math.max(0, duration - 0.1);
  }
  return time;
}

function hasOwnedAudioBuffer(queueItemId: QueueItemId): boolean {
  return !!getCurrentAudioBuffer() && getState('files.current')?.queueItemId === queueItemId;
}

function scheduleSameTrackReplayResync(
  time: number,
  incomingQueueItemId: QueueItemId,
  currentQueueItemId: QueueItemId | null,
): void {
  if (time > 0.001) return;
  if (incomingQueueItemId !== currentQueueItemId) return;

  const hostConn = getState('network.hostConn');
  if (!hostConn?.open) return;

  setManagedTimer(
    'playback-repeat-auto-sync',
    () => bus.emit('sync:force-resync'),
    SAME_TRACK_REPLAY_RESYNC_DELAY_MS,
  );
}

function setFileTrackMetaFromPlaylist(queueItemId: QueueItemId, fallbackName?: string): void {
  const item = getQueueItemById(queueItemId);
  const name = item?.name || fallbackName || '';
  setPlaybackTrackMeta(item ?? { ...createFileTrackMeta(name), queueItemId });
}

function requestCurrentFile(queueItemId: QueueItemId, name: string, reason: string): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn?.open) return;
  const owner = beginFileRequest(hostConn, queueItemId);
  sendFileRequest(owner, {
    type: MSG.REQUEST_CURRENT_FILE,
    name,
    reason,
  });
}

function setRecoveryTarget(queueItemId: QueueItemId, name: string): void {
  const indexHint = findQueueItemIndex(queueItemId);
  if (indexHint < 0) return;
  setPendingRecoveryTarget({ queueItemId, indexHint, name });
}

function getRemoteWaitSessionId(): number {
  const localSessionId = Number(getState('transfer.localSessionId'));
  if (Number.isFinite(localSessionId) && localSessionId > 0) return localSessionId;
  const currentSessionId = Number(getState('transfer.currentSessionId'));
  if (Number.isFinite(currentSessionId) && currentSessionId > 0) return currentSessionId;
  return 0;
}

// ─── Preload waiter: cross-invocation cleanup ───────────────────────
// (Mechanism M7a in docs/design/playback-concurrency-invariants.md.)
// Tracks active unsubs from storage:use-preloaded's "blob not ready" path.
// Rapid track switches (A→B while both are waiting) would otherwise leave
// A's listeners alive alongside B's, letting A's closure overwrite B's
// stall timer or issue a REQUEST_DATA_RECOVERY for the wrong track.
let _activePreloadWaiterCleanup: (() => void) | null = null;
// Every preload activation, including the direct PLAY fast path, is registered
// here. Matching both queue identity and Blob identity lets duplicate notifications join
// the in-flight work without decoding the same bytes twice, while a replacement
// resident for the same occurrence still supersedes the stale activation.
interface ActivePreloadTarget {
  readonly resident: Readonly<ResidentFile>;
  readonly epoch: number;
}

let _activePreloadTarget: ActivePreloadTarget | null = null;

function activatePreloadedTrack(resident: Readonly<ResidentFile>): void {
  const { queueItemId, blob } = resident;
  const active = _activePreloadTarget;
  // Teardown may clear the public in-progress flag while an uncancellable
  // decodeAudioData Promise is still settling. Blob identity dedupes only
  // while that target's load epoch remains current; cancelInFlight invalidates
  // the epoch and permits an intentional same-Blob restart.
  if (
    active?.resident.queueItemId === queueItemId &&
    active.resident.blob === blob &&
    isCurrentLoadEpoch(active.epoch)
  ) {
    log.debug('[Playback] Matching preload activation already in progress, ignoring duplicate');
    return;
  }

  if (isPlayPreloadedInProgress()) {
    log.info(
      `[Playback] preload(${queueItemId}) supersedes in-flight load(${active?.resident.queueItemId ?? '?'})`,
    );
  }

  const newEpoch = newLoadEpoch();
  const target: ActivePreloadTarget = { resident, epoch: newEpoch };
  _activePreloadTarget = target;
  loadPreloadedTrack(queueItemId, newEpoch)
    .finally(() => {
      if (_activePreloadTarget === target) _activePreloadTarget = null;
    })
    .catch((error) => {
      log.warn('[Playback] Preloaded track activation failed', error);
    });
}

// ─── Network Message Handlers ──────────────────────────────────────

async function handlePlayMsg(data: Record<string, unknown>, conn?: DataConnection): Promise<void> {
  // PLAY is an authoritative host→guest command. Host-local changes bypass
  // this handler, and peer-supplied frames must not mutate another guest's
  // queue selection or playback position.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  // Ignore PLAY during system audio mode (live stream, not file-based).
  // The helper also covers the guest's pending placeholder window between
  // SYSTEM_AUDIO_START and the first WebRTC stream.
  if (isSystemAudioOwner()) return;

  const rawTime = Number(data.time);
  const time = Number.isFinite(rawTime) && rawTime >= 0 ? rawTime : 0;
  const incomingQueueItemId = data.queueItemId;
  if (!isQueueItemId(incomingQueueItemId)) return;
  const incomingItem = getQueueItemById(incomingQueueItemId);
  if (!incomingItem) {
    log.debug(`[Guest] PLAY ignored for unknown queue item: ${incomingQueueItemId}`);
    return;
  }

  // A decoder failure on this device does not advance or interrupt the room.
  // Ignore repeat/seek/recovery commands for the same unsupported occurrence
  // and rejoin automatically when the host selects another queue item.
  if (isTrackFailed(getTrackKeyFromItem(incomingItem))) {
    setPendingPlayTime(undefined);
    showLoader(false);
    log.debug(`[Guest] PLAY ignored for locally unsupported ${incomingQueueItemId}`);
    return;
  }

  // Only a validated, live queue occurrence may release local pause state or
  // cancel the deferred replay owned by the current file pipeline.
  setLocalFilePaused(false);
  clearManagedTimer('playback-replay-defer');

  // Guard: If loadPreloadedTrack is in progress, queue the play time
  if (
    isPlayPreloadedInProgress() &&
    _activePreloadTarget?.resident.queueItemId === incomingQueueItemId
  ) {
    setPendingPlayTime(time);
    log.debug(`[Guest] Preload in progress, queuing play time: ${time}`);
    return;
  }

  // The host-selected occurrence is authoritative. Array positions are only
  // current projections and never participate in distributed ownership.
  const currentQueueItemId = getCurrentQueueItemId();
  if (incomingQueueItemId !== currentQueueItemId) {
    log.info(
      `[Guest] Queue item changed: current=${currentQueueItemId ?? '-'}, play=${incomingQueueItemId}`,
    );
    setPendingPlayTime(time);
    if (!selectQueueItemById(incomingQueueItemId)) return;

    // Check if preloaded track matches
    const ready = getState('preload.ready');
    if (ready?.queueItemId === incomingQueueItemId) {
      log.debug(`[Guest] Found preloaded resident for ${incomingQueueItemId}`);
      activatePreloadedTrack(ready);
      return;
    }

    if (isProRoomPersistentPlaylistFile(incomingQueueItemId)) {
      const name = incomingItem.name || (typeof data.name === 'string' ? data.name : '');
      setRecoveryTarget(incomingQueueItemId, name);
      setPendingPlayTime(time);
      // Persistent PRO bytes come from the authenticated room bucket on this
      // device. This compatibility request asks only for transfer identity/control;
      // the response contains no file bytes or reusable R2 credential.
      requestCurrentFile(incomingQueueItemId, name, 'pro_room_direct');
      log.info('[Guest] PRO file selected - requesting direct R2 prepare');
      return;
    }

    // Remote guest: orchestrator won't unicast the file. Queue files always
    // use remote share; bundled demo playback has a separate DEMO_* protocol.
    if (isRemoteGuest() || isGuestR2FileDelivery(incomingQueueItemId)) {
      if (shouldWaitForRemoteShare()) {
        const waitName = (typeof data.name === 'string' && data.name) || incomingItem.name || '';
        // Dedup mirror of prepareRemoteShareWait's alreadyWaiting check —
        // only escalate to the host when this PLAY arms a NEW wait.
        const recoveryTarget = getState('playback.pendingRecoveryTarget');
        const alreadyWaiting =
          getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD &&
          recoveryTarget?.queueItemId === incomingQueueItemId &&
          recoveryTarget.name === waitName;
        prepareRemoteShareWait(incomingQueueItemId, waitName, getRemoteWaitSessionId());
        setPendingPlayTime(time);
        if (!alreadyWaiting) {
          // Tell the host about a newly armed wait so it can resend the cached
          // remote-share descriptor to this guest.
          requestCurrentFile(incomingQueueItemId, waitName, 'remote_share_wait');
        }
        log.info('[Guest] Remote guest: waiting for remote share descriptor');
        return;
      }
      setFileTrackMetaFromPlaylist(incomingQueueItemId, data.name as string | undefined);
      showLoader(false);
      showToast(t('share.remote.unavailable'));
      log.info('[Guest] Remote guest: remote share unavailable');
      return;
    }

    // For local guests, PLAY provides the authoritative queue occurrence even
    // if FILE_PREPARE/FILE_START are subsequently lost. Persist the exact
    // queue identity plus display name so recovery never falls back to a
    // filename or positional guess.
    const name = incomingItem.name || (typeof data.name === 'string' ? data.name : '');
    setRecoveryTarget(incomingQueueItemId, name);

    // Fresh join (no prior queue selection): the file will be sent automatically
    // by the orchestrator:peer-joined handler after ICE detection completes.
    // Don't send REQUEST_CURRENT_FILE — it would create a redundant double transfer
    // if the request arrives after the orchestrator sets isDataTarget=true.
    if (currentQueueItemId === null) {
      log.debug('[Guest] Fresh join: file will arrive via orchestrator:peer-joined');
      return;
    }

    // Mid-stream track switch on a local guest with no preload — ask host
    // to re-send the current file.
    requestCurrentFile(incomingQueueItemId, name, 'queue_item_mismatch');
    return;
  }

  // During AWAITING_PRELOAD/DOWNLOADING/DECODING the resident AudioBuffer
  // still belongs to the previous track. Defer PLAY until the current
  // pipeline publishes its decoded buffer.
  //
  // The state machine treats these as stay transitions and stores
  // pendingPlayTime for the load-completion path:
  //   AWAITING_PRELOAD → loadPreloadedTrack consumes pendingPlayTime
  //   DOWNLOADING/DECODING → finalizeGuestFile consumes it after decode.
  const lifecycle = getState('playback.lifecycle');
  if (
    lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD ||
    lifecycle === PLAYBACK_STATE.DOWNLOADING ||
    lifecycle === PLAYBACK_STATE.DECODING
  ) {
    setPendingPlayTime(time);
    // Drive the state machine for observability (it's a stay transition).
    transition({ type: 'PLAY', time, queueItemId: incomingQueueItemId, sameTrack: true });
    log.debug(
      `[Guest] PLAY arrived while ${lifecycle}: deferring to pipeline completion (time=${time})`,
    );
    return;
  }

  // A prepared file source is playable only together with the atomic resident
  // identity that owns it. A leftover source from another occurrence must
  // never be replayed under the selected queue item.
  const hasOwnedSource = hasOwnedAudioBuffer(incomingQueueItemId);

  if (hasOwnedSource) {
    // Lifecycle: we have a prepared source → we're in
    // READY (or PLAYING/PAUSED already if this is a seek). Drive the machine.
    // transition() handles same-track seek, resume from PAUSED, and restart
    // from READY under the tested lifecycle contract.
    transition({ type: 'PLAY', time, queueItemId: incomingQueueItemId, sameTrack: true });

    const residentFile = getState('files.current');
    const buffer = getCurrentAudioBuffer();
    let startPublished = false;
    const occurrenceStillCurrent = (): boolean =>
      getState('network.hostConn') === hostConn &&
      hostConn.open &&
      getCurrentQueueItemId() === incomingQueueItemId &&
      getState('files.current') === residentFile &&
      getCurrentAudioBuffer() === buffer;
    const publishStartedPlay = (): void => {
      if (startPublished || !occurrenceStillCurrent() || !isPlaybackPlayingFile()) return;
      startPublished = true;
      bus.emit('sync:arm-initial');
      scheduleSameTrackReplayResync(time, incomingQueueItemId, currentQueueItemId);
    };
    const startOwnedFile = async (
      offset: number,
      scheduleDelay = 0,
      scheduleDeadlineMs?: number,
    ): Promise<boolean> => {
      try {
        const started = await play(
          offset,
          scheduleDelay,
          scheduleDeadlineMs,
          occurrenceStillCurrent,
          {
            timing: 'catch-up',
            onRecoveredStarted: publishStartedPlay,
          },
        );
        if (started) publishStartedPlay();
        return started;
      } catch (error) {
        log.warn('[Guest] Failed to apply authoritative PLAY:', error);
        return false;
      }
    };

    // Shared Clock: schedule play at the host-specified time.
    //
    // hostPlayAt is produced as "host command time + SCHEDULE_AHEAD_MS" after
    // the host has already started or retimed its own local-file playback.
    // At the guest's actual start moment, the host position is therefore
    // `time + elapsed since that host command`, not just `time + remaining
    // wait`. Using only the remaining wait left guests behind by the message's
    // one-way delivery time on Next/auto-advance/replay.
    const hostPlayAt = Number(data.hostPlayAt) || 0;
    if (hostPlayAt > 0) {
      const now = getHostNow();
      const waitMsRaw = hostPlayAt - now;
      const waitMs = Math.max(0, waitMsRaw);
      const offset = getClockOffset();
      const bestRtt = getClockBestRtt();

      if (Math.abs(waitMsRaw) < 2000) {
        const hostCommandAt = hostPlayAt - SCHEDULE_AHEAD_MS;
        const guestStartAtHostTime = now + waitMs;
        const elapsedSinceHostCommand = Math.max(0, guestStartAtHostTime - hostCommandAt);
        const compensatedTime = time + elapsedSinceHostCommand / 1000;
        // Keep the local rendezvous as an absolute monotonic deadline. If Web
        // Audio setup or the play lock defers this intent, transport can then
        // consume only the remaining delay (and advance the offset when late)
        // instead of replaying the original network wait a second time.
        const scheduleDeadlineMs = performance.now() + waitMs;
        // Web Audio hardware-timed start — sub-ms precision (no setTimeout jitter)
        const started = await startOwnedFile(compensatedTime, waitMs / 1000, scheduleDeadlineMs);
        if (started) {
          log.debug(
            `[SharedClock] Scheduled play in ${waitMs}ms at ${compensatedTime.toFixed(2)}s (offset=${offset}ms, rtt=${bestRtt}ms, commandAge=${elapsedSinceHostCommand.toFixed(0)}ms, WebAudio)`,
          );
        }
      } else {
        log.warn(`[SharedClock] waitMs out of range (${waitMsRaw}ms), playing immediately`);
        await startOwnedFile(time);
      }
    } else {
      // Without hostPlayAt, start immediately and let initial sync correct it.
      await startOwnedFile(time);
    }
  } else {
    if (isProRoomPersistentPlaylistFile(incomingQueueItemId)) {
      setPendingPlayTime(time);
      const lifecycleNow = getState('playback.lifecycle');
      if (lifecycleNow === PLAYBACK_STATE.IDLE || lifecycleNow === PLAYBACK_STATE.FAILED) {
        const trackName = incomingItem.name || (data.name as string) || '';
        requestCurrentFile(incomingQueueItemId, trackName, 'pro_room_no_buffer');
      }
      return;
    }

    // Remote guest: no queue file arrives via P2P; wait for remote share.
    if (isRemoteGuest() || isGuestR2FileDelivery(incomingQueueItemId)) {
      if (shouldWaitForRemoteShare()) {
        const waitName = (typeof data.name === 'string' && data.name) || incomingItem.name || '';
        // Dedup mirror of prepareRemoteShareWait's alreadyWaiting check.
        const recoveryTarget = getState('playback.pendingRecoveryTarget');
        const alreadyWaiting =
          getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD &&
          recoveryTarget?.queueItemId === incomingQueueItemId &&
          recoveryTarget.name === waitName;
        prepareRemoteShareWait(incomingQueueItemId, waitName, getRemoteWaitSessionId());
        setPendingPlayTime(time);
        if (!alreadyWaiting) {
          // Ask the host to resend the descriptor for this newly armed wait.
          requestCurrentFile(incomingQueueItemId, waitName, 'remote_share_wait');
        }
        log.info('[Guest] Remote guest: waiting for remote share descriptor');
        return;
      }
      setFileTrackMetaFromPlaylist(incomingQueueItemId, data.name as string | undefined);
      showLoader(false);
      showToast(t('share.remote.unavailable'));
      log.info('[Guest] Remote guest: remote share unavailable');
      return;
    }
    setPendingPlayTime(time);
    log.debug(`[Guest] Storing pending play time: ${time}`);

    // If PLAY targets the current queue item but neither its resident buffer nor an inbound
    // pipeline exists, request the current file. Never do this while transfer
    // state is RECEIVING/PROCESSING: its watchdog owns resume-based recovery,
    // and a second request could restart a healthy partial transfer.
    const lifecycleNow = getState('playback.lifecycle');
    const transferStateNow = getState('transfer.state');
    if (
      (lifecycleNow === PLAYBACK_STATE.IDLE || lifecycleNow === PLAYBACK_STATE.FAILED) &&
      transferStateNow !== TRANSFER_STATE.RECEIVING &&
      transferStateNow !== TRANSFER_STATE.PROCESSING
    ) {
      const trackName = incomingItem.name || (data.name as string) || '';
      log.info('[Guest] PLAY for current queue item with no buffer/pipeline; requesting file');
      requestCurrentFile(incomingQueueItemId, trackName, 'no_buffer');
    }
  }
}

function handlePauseMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  // Drop PAUSE frames not arriving via hostConn. Without this, a malicious
  // guest can send {type:'pause', endOfPlaylist:true} to the host — the
  // endOfPlaylist branch below stops host audio, clears currentTrackMeta,
  // clears the selected queue item, and shows the "playlist ended" toast.
  // A single raw frame from any session participant would otherwise disrupt
  // host playback, so apply the same authoritative-connection boundary as the
  // chat handlers.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  // Ignore PAUSE during system audio mode
  if (isSystemAudioOwner()) return;
  // Ignore PAUSE in YouTube mode — YouTube uses YOUTUBE_STATE/YOUTUBE_STOP instead
  if (isYouTubeOwner()) return;

  const rawTime = Number(data.time);
  const time = Number.isFinite(rawTime) && rawTime >= 0 ? rawTime : 0;
  const endOfPlaylist = !!data.endOfPlaylist;
  const reason = typeof data.reason === 'string' ? data.reason : undefined;
  const rawQueueItemId = data.queueItemId;
  if (rawQueueItemId !== null && !isQueueItemId(rawQueueItemId)) return;
  const incomingQueueItemId = rawQueueItemId as QueueItemId | null;
  const currentQueueItemId = getCurrentQueueItemId();

  // A delayed pause for a previous occurrence must not stop its successor.
  // Terminal end-of-playlist uses null as the authoritative deselection.
  if (
    (!endOfPlaylist && incomingQueueItemId !== currentQueueItemId) ||
    (endOfPlaylist && incomingQueueItemId !== null && incomingQueueItemId !== currentQueueItemId)
  ) {
    log.debug(
      `[Guest] Stale PAUSE ignored: current=${currentQueueItemId ?? '-'}, pause=${incomingQueueItemId ?? '-'}`,
    );
    return;
  }

  // Authoritative host command — release any local lock-screen pause. Both
  // ends end up paused here; a later host PLAY then resumes this guest.
  setLocalFilePaused(false);

  // If host pauses, cancel any deferred play that was waiting for a
  // download/preload to finish. Otherwise, a guest who completes their
  // download while the host is paused will erroneously auto-start playback.
  setPendingPlayTime(undefined);

  // Host reached end of playlist (Repeat OFF). Short-circuit: skip the
  // regular pause() path which would flash a "일시정지" toast before the
  // "재생목록 끝" toast overwrites it. Just stop everything and clear
  // the stale track meta so title/indicator mirror the host's reset.
  if (endOfPlaylist) {
    log.debug('[Guest] Host signalled end of playlist. Clearing track meta');
    setPlaybackTrackMeta(null);
    // Mirror host's deselected state so operator guest's togglePlay
    // also redirects to playTrack(0) instead of resuming stale audio.
    selectQueueItemById(null);
    setState('player.pausedAt', 0);
    stopAllMedia();
    showToast(t('toast.playlist_ended'));
    return;
  }

  // A late-joining guest can receive the host's PAUSE bootstrap before it has
  // an AudioBuffer or an active transport. pause() deliberately no-ops in that
  // state, so retain the authoritative rendezvous time independently of the
  // concrete transport and use it once the file becomes playable.
  setState('player.pausedAt', time);

  const isUserPause = reason === undefined || reason === 'pause';
  // Stop the concrete WebAudio node before moving semantic state to PAUSED.
  // pause() intentionally no-ops once file ownership is already paused, so
  // doing the lifecycle transition first can leave audio audible while the UI
  // looks stopped.
  pause(time, { holdVisualizer: isUserPause, showToast: isUserPause });

  // Regular PAUSE enters PAUSED only after the transport has stopped;
  // endOfPlaylist=true returned through the terminal branch above.
  transition({ type: 'PAUSE', time, queueItemId: incomingQueueItemId, endOfPlaylist });
}

async function handleRequestPlay(
  data: Record<string, unknown>,
  conn: DataConnection,
): Promise<void> {
  // Host handles OP's request to play
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only Host executes

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playback] Rejected request-play from non-OP: ${conn?.peer}`);
    return;
  }
  if (data.queueItemId !== getCurrentQueueItemId()) {
    log.debug('[Playback] Ignoring stale REQUEST_PLAY');
    return;
  }

  // Cancel any pending auto-play / ended-advance timers — otherwise an OP's
  // REQUEST_PLAY that lands during the post-end 300–500ms window would be
  // silently stomped by the armed `ended-advance-*` timer firing `play(0)`
  // or `playNextTrack()`. Mirrors the guards used by `togglePlay`/`playTrack`.
  clearManagedTimer('autoPlayTimer');
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');
  const pausedAt = getState('player.pausedAt') || 0;
  const rawTime = Number(data.time);
  const time = Number.isFinite(rawTime) && rawTime >= 0 ? rawTime : pausedAt;
  const currentQueueItemId = getCurrentQueueItemId();
  const playlistItems = getState('playlist.items') || [];

  // Deselected state (post end-of-playlist): redirect to playTrack(0)
  // rather than resuming stale audio buffer.
  if (currentQueueItemId === null && playlistItems[0]) {
    const firstQueueItemId = playlistItems[0].queueItemId;
    void loadPlaylistModule()
      .then((mod) => mod.playTrack(firstQueueItemId))
      .catch((error) => {
        log.warn('[Playback] Failed to load the playlist for an operator play request:', error);
        showToast(t('error.network_generic'));
      });
    return;
  }
  if (!currentQueueItemId) return;

  // A busy pipeline still holds the previous track's AudioBuffer. Ignore the
  // request; decode completion owns playback of the newly selected track.
  if (isFilePipelineBusyForPlay()) {
    log.debug('[Playback] Ignoring REQUEST_PLAY while file pipeline is preparing');
    return;
  }

  const currentResident = getState('files.current');
  if (
    !getCurrentAudioBuffer() ||
    !currentResident ||
    currentResident.queueItemId !== currentQueueItemId
  ) {
    log.debug('[Playback] Ignoring REQUEST_PLAY without the selected resident file');
    return;
  }

  await startHostFileAndBroadcastPlay({
    time,
    queueItemId: currentQueueItemId,
    shouldApply: () => verifyOperator(conn, data),
    context: 'operator play request',
  });
  // SharedClock handles sync
}

function handleRequestPause(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playback] Rejected request-pause from non-OP: ${conn?.peer}`);
    return;
  }
  if (data.queueItemId !== getCurrentQueueItemId()) {
    log.debug('[Playback] Ignoring stale REQUEST_PAUSE');
    return;
  }

  clearManagedTimer('autoPlayTimer');
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');
  const currentQueueItemId = getCurrentQueueItemId();
  pause();
  broadcast({
    type: MSG.PAUSE,
    time: getState('player.pausedAt'),
    queueItemId: currentQueueItemId,
    reason: 'pause',
  });
}

async function handleRequestSeek(
  data: Record<string, unknown>,
  conn: DataConnection,
): Promise<void> {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playback] Rejected request-seek from non-OP: ${conn?.peer}`);
    return;
  }
  if (data.queueItemId !== getCurrentQueueItemId()) {
    log.debug('[Playback] Ignoring stale REQUEST_SEEK');
    return;
  }

  // Cancel pending auto-play / ended-advance timers — the 3s auto-play
  // window after a track load would otherwise fire `play(0)` at its
  // scheduled time and overwrite the OP's just-applied seek position.
  clearManagedTimer('autoPlayTimer');
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');

  // The protocol rejects negative requests, but this handler remains defensive
  // because tests and future internal callers can bypass protocol dispatch.
  // Publish one canonical value so host state and every guest receive the same
  // position even when an OP sends a stale/out-of-range seek.
  const time = canonicalizeRequestedSeekTime(data.time);
  const currentQueueItemId = getCurrentQueueItemId();

  // YouTube seek
  if (isYouTubeOwner()) {
    bus.emit('youtube:seek-to', time);
    return;
  }

  // A busy file pipeline still holds the previous track's AudioBuffer. Keep
  // this guard after YouTube handling because file lifecycle state must not
  // block seeks owned by another playback mode.
  if (isFilePipelineBusyForPlay()) {
    log.debug('[Playback] Ignoring REQUEST_SEEK while file pipeline is preparing');
    return;
  }

  if (isPlaybackPlayingFile()) {
    const currentResident = getState('files.current');
    if (
      !currentQueueItemId ||
      !currentResident ||
      currentResident.queueItemId !== currentQueueItemId
    ) {
      log.debug('[Playback] Ignoring REQUEST_SEEK without the selected resident file');
      return;
    }
    await startHostFileAndBroadcastPlay({
      time,
      queueItemId: currentQueueItemId,
      shouldApply: () => verifyOperator(conn, data),
      context: 'operator seek request',
    });
  } else {
    invalidatePendingFilePlayIntent();
    setState('player.pausedAt', time);
    broadcast({ type: MSG.PAUSE, time, queueItemId: currentQueueItemId, reason: 'seek' });
  }
  // SharedClock handles sync
}

function handleRequestSkipTime(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playback] Rejected request-skip-time from non-OP: ${conn?.peer}`);
    return;
  }
  if (data.queueItemId !== getCurrentQueueItemId()) {
    log.debug('[Playback] Ignoring stale REQUEST_SKIP_TIME');
    return;
  }

  const sec = Number(data.sec);
  if (!Number.isFinite(sec)) return;
  skipTime(sec);
}

// ─── Init ──────────────────────────────────────────────────────────

export function initPlayback(): void {
  registerProRoomDirectFileHandler((file, queueItemId, sessionId) =>
    finalizeGuestFile(file, queueItemId, sessionId),
  );
  registerHandlers({
    [MSG.PLAY]: handlePlayMsg,
    [MSG.PAUSE]: handlePauseMsg,
    [MSG.REQUEST_PLAY]: handleRequestPlay,
    [MSG.REQUEST_PAUSE]: handleRequestPause,
    [MSG.REQUEST_SEEK]: handleRequestSeek,
    [MSG.REQUEST_SKIP_TIME]: handleRequestSkipTime,
  });

  // Stop all media (called from youtube player before loading)
  bus.on('player:stop-all-media', (options) => {
    stopAllMedia(options);
  });

  // Replay current track from start (repeat-one: guest already has file).
  // delayMs lets the host tell the guest "I'm going to start at T+delayMs,
  // so don't start playing until then" — prevents the 3-second drift
  // window when host re-clicks a currently-playing track.
  bus.on('playback:replay-current', (delayMs?: number) => {
    const queueItemId = getCurrentQueueItemId();
    if (
      !queueItemId ||
      !getCurrentAudioBuffer() ||
      getState('files.current')?.queueItemId !== queueItemId
    ) {
      return;
    }

    const doReplay = () => {
      log.debug('[Guest] Replaying current track from start');
      const hostConn = getState('network.hostConn');
      const residentFile = getState('files.current');
      const buffer = getCurrentAudioBuffer();
      let syncScheduled = false;
      const occurrenceStillCurrent = (): boolean =>
        !!hostConn?.open &&
        getState('network.hostConn') === hostConn &&
        getCurrentQueueItemId() === queueItemId &&
        getState('files.current') === residentFile &&
        getCurrentAudioBuffer() === buffer;
      const scheduleSyncAfterStart = (): void => {
        if (syncScheduled || !occurrenceStillCurrent() || !isPlaybackPlayingFile()) return;
        syncScheduled = true;
        // Auto-sync 1s later to align with host.
        setManagedTimer('playback-repeat-auto-sync', () => bus.emit('sync:force-resync'), 1000);
      };
      void play(0, 0, undefined, occurrenceStillCurrent, {
        timing: 'catch-up',
        onRecoveredStarted: scheduleSyncAfterStart,
      })
        .then((started) => {
          if (started) scheduleSyncAfterStart();
        })
        .catch((error) => log.warn('[Guest] Failed to replay the current track:', error));
    };

    if (delayMs && delayMs > 0) {
      log.debug(`[Guest] Deferring replay by ${delayMs}ms to match host autoPlayTimer`);
      // Pause locally so the old decoded buffer doesn't keep running, and
      // the guest shows a "lined up" UI while waiting for the host's rendezvous.
      pause(0, { holdVisualizer: false });
      setManagedTimer('playback-replay-defer', doReplay, delayMs);
    } else {
      doReplay();
    }
  });

  // Long background resume recovery: rebuild/re-arm the current file source at
  // the logical position without surfacing a manual-sync toast.
  bus.on('playback:refresh-current-position', () => {
    if (!isPlaybackPlayingFile()) return;
    const queueItemId = getCurrentQueueItemId();
    const buffer = getCurrentAudioBuffer();
    if (!queueItemId || !buffer || getState('files.current')?.queueItemId !== queueItemId) {
      return;
    }
    // A background resume may occur during a track change, while the resident
    // buffer still belongs to the previous track. Decode completion owns restart.
    if (isFilePipelineBusyForPlay()) return;
    // Preserve the instant represented by `position` across any asynchronous
    // AudioContext health/setup work inside play(). The absolute deadline
    // makes a necessary rebuild catch up instead of restarting at stale time.
    const capturedAt = performance.now();
    const position = getTrackPosition();
    // A standard host can return after its canonical wall timeline already
    // crossed the track boundary while Web Audio was frozen. Replaying exactly
    // at duration would be sanitized to duration - 100ms and briefly resurrect
    // the ended occurrence. Let the canonical end owner advance it instead.
    if (
      isActiveStandardRoomCoordinator() &&
      Number.isFinite(buffer.duration) &&
      buffer.duration > 0.1 &&
      position >= buffer.duration - 0.005
    ) {
      handleEnded();
      return;
    }
    void play(position, 0, capturedAt).catch((error) =>
      log.warn('[Playback] Failed to refresh the current file position:', error),
    );
  });

  // Safety polling: periodically check if track ended (called from UI loop)
  bus.on('player:check-ended', () => {
    handleEnded();
  });

  // Clear previous track state (called from transfer module during track switch)
  bus.on('storage:clear-previous-track', (context) => {
    if (context === 'session-change') setLastClearedQueueItemId(null);
    clearPreviousTrackState(context);
  });

  // Storage file ready: finalize guest download processing
  bus.on('storage:file-ready', async (filename, sessionId, isPreload, queueItemId) => {
    if (!isQueueItemId(queueItemId) || !Number.isSafeInteger(sessionId) || sessionId <= 0) return;
    if (isPreload) {
      // Preload files are handled by preload module via storage:preload-file-ready
      bus.emit('storage:preload-file-ready', filename, sessionId, queueItemId);
      return;
    }

    // Only guest processes incoming files (Host loads directly)
    const hostConn = getState('network.hostConn');
    if (!hostConn) return;

    // Session + queue occurrence identify the completed transfer. A filename is
    // display metadata and may only veto an inconsistent event; it must never
    // revive bytes from a superseded same-name transfer.
    const isCurrentCompletion = (): boolean => {
      const localSid = getState('transfer.localSessionId');
      const meta = getState('transfer.meta');
      return (
        sessionId === localSid &&
        sessionId === meta?.sessionId &&
        queueItemId === meta?.queueItemId &&
        queueItemId === getCurrentQueueItemId() &&
        getQueueItemById(queueItemId) !== null &&
        !!filename &&
        filename === meta?.name
      );
    };

    const meta = getState('transfer.meta');
    const activeSessionAndName =
      sessionId === getState('transfer.localSessionId') &&
      sessionId === meta?.sessionId &&
      !!filename &&
      filename === meta?.name;

    if (
      activeSessionAndName &&
      (meta?.queueItemId !== queueItemId || getCurrentQueueItemId() !== queueItemId)
    ) {
      log.warn(
        `[Playback] Completed transfer lost queue identity; requesting selected file (sid=${sessionId}, filename=${filename})`,
      );
      cleanupStoredFile(queueItemId, filename, false, sessionId);
      setState('transfer.receivedCount', 0);
      setPlaybackTransferState(TRANSFER_STATE.IDLE);
      showLoader(true, t('transfer.waiting_recovery', { name: filename }));
      const selectedQueueItemId = getCurrentQueueItemId();
      const selectedItem = getQueueItemById(selectedQueueItemId);
      if (selectedQueueItemId && selectedItem) {
        requestCurrentFile(selectedQueueItemId, selectedItem.name, 'file_ready_identity_mismatch');
      }
      return;
    }

    if (!isCurrentCompletion()) {
      log.debug(
        `[Playback] storage:file-ready dropped: stale identity (qid=${queueItemId}, sid=${sessionId})`,
      );
      return;
    }

    const file = await readStoredFile(queueItemId, filename, false, sessionId);
    if (!file) {
      log.error('[Playback] Failed to read file:', filename);
      showLoader(false);
      return;
    }

    // The RAM read is asynchronous; ownership may have changed while it was
    // pending. Revalidate the full session/queue identity before decoding.
    if (!isCurrentCompletion()) {
      log.debug(
        `[Playback] storage:file-ready dropped after read: superseded (qid=${queueItemId}, sid=${sessionId})`,
      );
      return;
    }

    // Lifecycle: all chunks received and assembled → DOWNLOADING → DECODING.
    // finalizeGuestFile will emit DECODE_SUCCESS next; without this FILE_END
    // beat, that transition would be rejected because we'd still look to
    // the state machine like we're DOWNLOADING.
    transition({ type: 'FILE_END', queueItemId });

    await finalizeGuestFile(file, queueItemId, sessionId);
  });

  // Use preloaded track (skip download, decode from preload cache)
  bus.on('storage:use-preloaded', (queueItemId, name, sessionId) => {
    if (
      !isQueueItemId(queueItemId) ||
      !getQueueItemById(queueItemId) ||
      getCurrentQueueItemId() !== queueItemId
    ) {
      return;
    }
    log.debug(`[Playback] Using preloaded track: ${queueItemId} (${name})`);

    // Tear down any previous waiter before starting this one — otherwise
    // rapid track switches (A→B while both waiting) would leave A's
    // progress listener alive alongside B's, causing closure cross-talk.
    if (_activePreloadWaiterCleanup) {
      _activePreloadWaiterCleanup();
      _activePreloadWaiterCleanup = null;
    }

    // (lifecycle is already AWAITING_PRELOAD or DECODING+PRELOAD_PROMOTED
    //  by the caller's transition() — shouldSkipIncomingFile() returns true.)

    // Try to activate immediately if blob is already available
    const ready = getState('preload.ready');
    const readyMatches =
      ready?.queueItemId === queueItemId &&
      (sessionId === undefined || ready.sessionId === sessionId);
    if (ready && readyMatches) {
      // activatePreloadedTrack deduplicates a repeated notification for the
      // exact Blob and supersedes only when the target really changed.
      activatePreloadedTrack(ready);
    } else {
      // Blob not ready yet — set progress-aware watchdog. Will be triggered
      // by storage:file-ready → storage:preload-file-ready → use-preloaded re-emit.
      log.debug('[Playback] Preload blob not ready yet, waiting for download completion...');

      // Progress-aware watchdog
      // ────────────────────────────────────
      // Serialized preload transfers may take arbitrarily longer than one
      // stall window on slow links. Forward progress is the liveness signal;
      // only a true no-progress interval may start duplicate main recovery.
      const PRELOAD_WATCHDOG_STALL_MS = 10_000; // no-progress timeout
      let lastProgressChunk = -1;
      let disposed = false;

      const cleanup = (): void => {
        if (disposed) return;
        disposed = true;
        clearManagedTimer('preload-blob-watchdog');
        _unsubWatchdog();
        _unsubProgress();
        if (_activePreloadWaiterCleanup === cleanup) {
          _activePreloadWaiterCleanup = null;
        }
      };

      const installStallTimer = (): void => {
        if (disposed) return;
        clearManagedTimer('preload-blob-watchdog');
        setManagedTimer('preload-blob-watchdog', onWatchdogFire, PRELOAD_WATCHDOG_STALL_MS);
      };

      function onWatchdogFire(): void {
        if (disposed) return;
        cleanup();
        // Lifecycle drives the check. If we've left AWAITING_PRELOAD, the blob
        // arrived or got superseded — no recovery needed.
        if (
          getState('playback.lifecycle') !== PLAYBACK_STATE.AWAITING_PRELOAD ||
          getCurrentQueueItemId() !== queueItemId
        ) {
          return;
        }
        log.warn('[Preload] Preloaded blob not available: stall timeout');
        // shouldSkipIncomingFile() will return false once host's response
        // FILE_PREPARE transitions us out of AWAITING_PRELOAD into DOWNLOADING.
        showLoader(false);
        // Request the file from the host after a confirmed stall.
        const hostConn = getState('network.hostConn');
        if (hostConn?.open) {
          showLoader(true, t('transfer.file_requesting'));
          const owner = beginFileRequest(hostConn, queueItemId, sessionId);
          sendFileRequest(owner, {
            type: MSG.REQUEST_DATA_RECOVERY,
            nextChunk: 0,
            fileName: name,
          });
        }
      }

      // Clear watchdog when we transition out of AWAITING_PRELOAD (blob
      // arrived → DECODING, superseded → DOWNLOADING, etc.).
      // Subscribe to lifecycle so watchdog cleanup follows the source of truth.
      const _unsubWatchdog = bus.on('state:playback.lifecycle', (val: unknown) => {
        if (val !== PLAYBACK_STATE.AWAITING_PRELOAD) cleanup();
      });

      // Progress-aware reset: watch preload.sessionState changes. When the
      // session matching our track advances its nextExpectedChunk, reset the
      // stall timer. Session/lifecycle ownership bounds the wait itself.
      const _unsubProgress = bus.on('state:preload.sessionState', () => {
        if (disposed) return;
        if (getState('playback.lifecycle') !== PLAYBACK_STATE.AWAITING_PRELOAD) return;
        if (getCurrentQueueItemId() !== queueItemId) return;

        const sessionState = getState('preload.sessionState');
        for (const [sid, session] of sessionState) {
          if (session.skipped || session.finalized) continue;
          // Match by stable queue occurrence. Name and indexHint are display
          // metadata and cannot own a transfer across reorder.
          if (session.queueItemId !== queueItemId) continue;
          if (sessionId !== undefined && sid !== sessionId) continue;
          const prog = session.nextExpectedChunk || 0;
          if (prog > lastProgressChunk) {
            lastProgressChunk = prog;
            installStallTimer(); // reset stall timer on any forward progress
          }
          break;
        }
      });

      _activePreloadWaiterCleanup = cleanup;
      installStallTimer();
    }
  });

  // Transfer progress (update loader UI)
  bus.on('storage:transfer-progress', (progress, _total) => {
    showLoader(true, t('toast.receiving_pct', { pct: String(progress) }));
    updateLoader(progress);
  });

  // Host: Send playback state to newly connected peer (late-join bootstrap)
  // NOTE: File transfer is deferred to 'orchestrator:peer-type-detected' below,
  // because isDataTarget is still false at this point (ICE detection pending).
  bus.on('network:peer-connected', (conn) => {
    if (!conn?.open) return;

    // Only Host bootstraps guests
    const hostConn = getState('network.hostConn');
    if (hostConn) return;
    if (getState('demo.active')) return;

    const playback = getPlaybackModeActivity();
    const isFilePlaying = isPlaybackPlayingFile(playback);
    const isFilePauseLike = isPlaybackPausedOrPendingFile(playback);
    const isSystemAudioPlaying = isPlaybackPlayingSystemAudio(playback);
    const isYouTubeActive = isPlaybackActiveYouTube(playback);
    const currentQueueItemId = getCurrentQueueItemId();
    const currentItem = getQueueItemById(currentQueueItemId);
    const currentResident = getState('files.current');

    // Send playback state (time-sync for late joiners)
    try {
      const nowPos = getTrackPosition();
      // System audio: send start message instead of PLAY/PAUSE (media call handled by system-audio-host)
      if (isSystemAudioPlaying) {
        // The fifth device causes the active share to stop. Do not briefly
        // bootstrap its placeholder before the capture listener sends STOP.
        if (hasSystemAudioDeviceCapacity()) {
          conn.send({ type: MSG.SYSTEM_AUDIO_START });
        }
      } else if (isYouTubeActive) {
        // YouTube publishes its own late-join state.
      } else if (
        isFilePlaying &&
        currentQueueItemId &&
        currentItem &&
        currentResident?.queueItemId === currentQueueItemId
      ) {
        const itemName = currentResident.name || currentItem.name || currentItem.file?.name || null;
        // Late-join bootstrap: omit hostPlayAt — guest has no clock samples yet.
        // Guest starts immediately; initial sync corrects the unsampled clock.
        conn.send({
          type: MSG.PLAY,
          time: nowPos,
          queueItemId: currentQueueItemId,
          name: itemName,
        });
      } else if (isFilePlaying) {
        log.warn('[Playback] Bootstrap PLAY skipped: selected queue identity is unavailable');
      } else if (!isYouTubeActive) {
        // IDLE or PAUSED: Send pause to sync position
        conn.send({
          type: MSG.PAUSE,
          time: nowPos,
          queueItemId: currentQueueItemId,
          reason: isFilePauseLike ? 'pause' : 'stop',
        });
      }
      // YouTube state is handled by youtube/player.ts bootstrap
      log.debug('[Playback] Bootstrap: sent playback state to new peer');
    } catch (e) {
      log.warn('[Playback] Bootstrap send failed:', e);
    }
  });

  // Host: Send current file when a peer first joins (post-ICE evaluation).
  // Re-evaluations from topology changes (e.g. another peer leaving) reuse
  // 'peer-evaluated' for routing only — bootstrapping the file again would
  // re-trigger 'storage:transfer-progress' on a peer that already has it.
  async function bootstrapLocalPeerFile(peerId: string, reason: string): Promise<void> {
    const hostConn = getState('network.hostConn');
    if (hostConn) return; // Only Host
    if (getState('demo.active')) return;

    const currentQueueItemId = getCurrentQueueItemId();
    const item = getQueueItemById(currentQueueItemId);
    if (!currentQueueItemId || !item || item.type === 'youtube') return;
    const isProDirect = isProRoomPersistentPlaylistFile(currentQueueItemId);

    const peers = getState('network.connectedPeers') || [];
    const peer = peers.find((p) => p.id === peerId);
    if (!peer) return;
    const conn = peer.conn as DataConnection;
    if (!conn?.open) return;

    markLateLocalPeerForR2(peerId);

    const currentResident = getState('files.current');
    if (currentResident?.queueItemId === currentQueueItemId) {
      if (isProDirect) {
        safeSend(conn, {
          type: MSG.FILE_PREPARE,
          name: currentResident.name || item.name,
          queueItemId: currentQueueItemId,
          sessionId: currentResident.sessionId,
          size: currentResident.blob.size,
          mime: currentResident.mime || currentResident.blob.type || 'application/octet-stream',
          autoPlayDelayMs: 0,
        });
        log.debug(`[Playback] Sent PRO direct-file prepare to ${peer.label || peerId} (${reason})`);
        return;
      }
      const delivery = resolvePeerFileDelivery(peer, currentResident.sessionId);
      const prepare = {
        type: MSG.FILE_PREPARE,
        name: currentResident.name || item.name,
        queueItemId: currentQueueItemId,
        sessionId: currentResident.sessionId,
        size: currentResident.blob.size,
        mime: currentResident.mime || currentResident.blob.type || 'application/octet-stream',
        autoPlayDelayMs: 0,
      };
      if (delivery === 'r2') {
        safeSend(conn, {
          ...prepare,
          delivery: 'r2',
        });
        log.debug(`[Playback] Sent R2 file prepare to ${peer.label || peerId} (${reason})`);
        return;
      }
      if (delivery === 'unsupported') {
        sendFileDeliveryUnavailable(conn, prepare, currentResident.sessionId);
        log.warn(
          `[Playback] File delivery unavailable for legacy overflow peer ${peer.label || peerId}`,
        );
        return;
      }
      if (delivery === 'pending') {
        log.debug(`[Playback] Deferring file bootstrap until ICE resolves for ${peerId}`);
        return;
      }
      if (!peer.isDataTarget) return;
      log.debug(`[Playback] Sending current file to ${peer.label || peerId} (${reason})`);
      try {
        await unicastFile(conn, currentResident.blob, 0, currentResident.sessionId, {
          queueItemId: currentQueueItemId,
          purpose: 'bootstrap',
          isSourceCurrent: () => {
            const latest = getState('files.current');
            return (
              getCurrentQueueItemId() === currentQueueItemId &&
              latest?.queueItemId === currentQueueItemId &&
              latest.sessionId === currentResident.sessionId &&
              latest.blob === currentResident.blob
            );
          },
        });
      } catch (e: unknown) {
        log.error('[Host] unicastFile for late joiner failed', e);
        return;
      }
    }

    if (isProDirect) return;

    // Also send the atomically published preload resident.
    const preloadResident = getState('preload.ready');
    if (preloadResident && conn.open) {
      try {
        await unicastPreload(
          conn,
          preloadResident.blob,
          preloadResident.queueItemId,
          preloadResident.sessionId,
        );
      } catch (e: unknown) {
        log.error('[Host] unicastPreload for late joiner failed', e);
      }
    }
  }

  bus.on('orchestrator:peer-joined', async (peerId: string) => {
    await bootstrapLocalPeerFile(peerId, 'post-ICE');
  });

  bus.on('orchestrator:peer-data-target-ready', async (peerId: string) => {
    await bootstrapLocalPeerFile(peerId, 'data-target-ready');
  });

  log.info('[Playback] Engine initialized');
}
