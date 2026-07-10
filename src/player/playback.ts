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
import { readStoredFile } from '../storage/storage.ts';
import { unicastFile, fetchDemoFromServer } from '../storage/transfer.ts';
import { unicastPreload } from '../storage/preload.ts';
import { broadcast, sendToHost, isRemoteGuest } from '../network/peer.ts';
import { prepareRemoteShareWait, shouldWaitForRemoteShare } from '../share/remote-share.ts';
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import { getSurroundSplitter } from '../audio/engine.ts';
import type { DataConnection } from '../types/index.ts';
import { getDemoTrackForPlayback, isDemoTrackName } from '../demo/tracks.ts';

import {
  getCurrentAudioBuffer,
  getPlayerNode,
  newLoadEpoch,
  setPendingPlayTime,
  getPendingPlayTimeSetAt,
  isPlayPreloadedInProgress,
  setLastClearedTrackName,
  setLocalFilePaused,
} from './_state.ts';

import {
  play,
  pause,
  stopAllMedia,
  getTrackPosition,
  handleEnded,
  isFilePipelineBusyForPlay,
  skipTime,
} from './transport.ts';

import { loadPreloadedTrack, clearPreviousTrackState, finalizeGuestFile } from './decode.ts';
import { showLoader, updateLoader, showToast } from '../ui/toast.ts';
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
} from './ownership.ts';

/** Must match SCHEDULE_AHEAD_MS in transport.ts */
const SCHEDULE_AHEAD_MS = 200;
const SAME_TRACK_REPLAY_RESYNC_DELAY_MS = 1000;

function scheduleSameTrackReplayResync(
  time: number,
  incomingIndex: number | undefined,
  currentTrackIndex: number,
): void {
  if (time > 0.001) return;
  if (incomingIndex === undefined || incomingIndex !== currentTrackIndex) return;

  const hostConn = getState('network.hostConn');
  if (!hostConn?.open) return;

  setManagedTimer(
    'playback-repeat-auto-sync',
    () => bus.emit('sync:force-resync'),
    SAME_TRACK_REPLAY_RESYNC_DELAY_MS,
  );
}

function setFileTrackMetaFromPlaylist(index: number, fallbackName?: string): void {
  const playlist = getState('playlist.items') || [];
  const item = playlist[index];
  const name = item?.name || fallbackName || '';
  setPlaybackTrackMeta(item ?? createFileTrackMeta(name));
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
// Tracks the playlist index decoded by storage:use-preloaded so a different
// index can supersede it. Direct handlePlayMsg activations are not registered;
// an overlap therefore takes the safe supersession path and may repeat a decode.
let _activePreloadIndex: number | null = null;

// ─── Network Message Handlers ──────────────────────────────────────

function handlePlayMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  // PLAY is an authoritative host→guest command. Host-local changes bypass
  // this handler, and peer-supplied frames must not mutate another guest's
  // track index or playback position.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  // Authoritative host command — release any local lock-screen pause so this
  // guest follows the host again (symmetric to handleYouTubePlay).
  setLocalFilePaused(false);

  // Ignore PLAY during system audio mode (live stream, not file-based).
  // The helper also covers the guest's pending placeholder window between
  // SYSTEM_AUDIO_START and the first WebRTC stream.
  if (isSystemAudioOwner()) return;

  // Host's MSG.PLAY is authoritative — cancel any pending deferred replay
  // from a prior FILE_PREPARE(autoPlayDelayMs) so we don't double-start.
  clearManagedTimer('playback-replay-defer');

  const time = Number(data.time) || 0;
  const incomingIndex = data.index != null ? Number(data.index) : undefined;

  // Guard: If loadPreloadedTrack is in progress, queue the play time
  if (isPlayPreloadedInProgress()) {
    setPendingPlayTime(time);
    log.debug(`[Guest] Preload in progress, queuing play time: ${time}`);
    return;
  }

  // Index-mismatch recovery: Host sent PLAY for a different track
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  if (incomingIndex !== undefined && incomingIndex !== currentTrackIndex) {
    log.warn(`[Guest] Index mismatch: current=${currentTrackIndex}, play=${incomingIndex}`);
    setPendingPlayTime(time);
    setState('playlist.currentTrackIndex', incomingIndex);

    // Check if preloaded track matches
    const nextFileBlob = getState('preload.nextFileBlob');
    const nextTrackIndex = getState('preload.nextTrackIndex');
    if (nextFileBlob && nextTrackIndex === incomingIndex) {
      log.debug(`[Guest] Found preloaded track for index ${incomingIndex}`);
      const newEpoch = newLoadEpoch();
      loadPreloadedTrack(incomingIndex, newEpoch);
      return;
    }

    // Remote guest: orchestrator won't unicast the file
    // (isDataTarget=false) and a REQUEST_CURRENT_FILE would route over
    // TURN. Handle this case up-front — it applies to both fresh-join
    // and mid-stream track switches. The demo gets an HTTP fallback
    // fetch from the server; any other file falls back to the remote-share
    // unavailable notice.
    if (isRemoteGuest()) {
      if (tryFetchDemoForRemote(incomingIndex, data.name as string | undefined, time)) return;
      if (shouldWaitForRemoteShare()) {
        const waitName = data.name as string | undefined;
        // Dedup mirror of prepareRemoteShareWait's alreadyWaiting check —
        // only escalate to the host when this PLAY arms a NEW wait.
        const recoveryTarget = getState('playback.pendingRecoveryTarget');
        const alreadyWaiting =
          getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD &&
          recoveryTarget?.index === incomingIndex &&
          recoveryTarget.name === (waitName || '');
        prepareRemoteShareWait(incomingIndex, waitName || '', getRemoteWaitSessionId());
        setPendingPlayTime(time);
        if (!alreadyWaiting) {
          // Tell the host about a newly armed wait so it can resend the cached
          // remote-share descriptor to this guest.
          const remotePlaylist = getState('playlist.items') || [];
          sendToHost({
            type: MSG.REQUEST_CURRENT_FILE,
            name: remotePlaylist[incomingIndex]?.name || waitName || '',
            index: incomingIndex,
            reason: 'remote_share_wait',
          });
        }
        log.info('[Guest] Remote guest — waiting for remote share descriptor');
        return;
      }
      setFileTrackMetaFromPlaylist(incomingIndex, data.name as string | undefined);
      showLoader(false);
      showToast(t('share.remote.unavailable'));
      log.info('[Guest] Remote guest — remote share unavailable');
      return;
    }

    // Fresh join (currentTrackIndex was -1): the file will be sent automatically
    // by the orchestrator:peer-joined handler after ICE detection completes.
    // Don't send REQUEST_CURRENT_FILE — it would create a redundant double transfer
    // if the request arrives after the orchestrator sets isDataTarget=true.
    if (currentTrackIndex === -1) {
      log.debug('[Guest] Fresh join — file will arrive via orchestrator:peer-joined');
      return;
    }

    // Mid-stream track switch on a local guest with no preload — ask host
    // to re-send the current file.
    const playlist = getState('playlist.items') || [];
    const name = playlist[incomingIndex]?.name || '';
    sendToHost({
      type: MSG.REQUEST_CURRENT_FILE,
      name,
      index: incomingIndex,
      reason: 'index_mismatch',
    });
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
    transition({ type: 'PLAY', time, index: incomingIndex, sameTrack: true });
    log.debug(
      `[Guest] PLAY arrived while ${lifecycle} — deferring to pipeline completion (time=${time})`,
    );
    return;
  }

  // Lifecycle and FILE_PREPARE supersession own stale-audio recovery. A name
  // mismatch here can be transient; requesting another file would race with an
  // active transfer, so retain the play time and wait for pipeline state.
  const meta = getState('transfer.meta');
  const playlist = getState('playlist.items') || [];
  const expectedName = (data.name as string) || playlist[currentTrackIndex]?.name || '';
  const loadedName = (meta?.name as string) || '';
  if (expectedName && loadedName && expectedName !== loadedName) {
    log.warn(
      `[Guest] Name mismatch on PLAY (loaded=${loadedName}, expected=${expectedName}) — deferring to pending play time; next FILE_PREPARE will supersede.`,
    );
    setPendingPlayTime(time);
    return;
  }

  if (getCurrentAudioBuffer()) {
    // Lifecycle: we have a decoded buffer → we're in
    // READY (or PLAYING/PAUSED already if this is a seek). Drive the machine.
    // transition() handles same-track seek, resume from PAUSED, and restart
    // from READY under the tested lifecycle contract.
    transition({ type: 'PLAY', time, index: incomingIndex, sameTrack: true });

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
        // Web Audio hardware-timed start — sub-ms precision (no setTimeout jitter)
        play(compensatedTime, waitMs / 1000);
        log.debug(
          `[SharedClock] Scheduled play in ${waitMs}ms at ${compensatedTime.toFixed(2)}s (offset=${offset}ms, rtt=${bestRtt}ms, commandAge=${elapsedSinceHostCommand.toFixed(0)}ms, WebAudio)`,
        );
        bus.emit('sync:arm-initial');
        scheduleSameTrackReplayResync(time, incomingIndex, currentTrackIndex);
      } else {
        log.warn(`[SharedClock] waitMs out of range (${waitMsRaw}ms), playing immediately`);
        play(time);
        bus.emit('sync:arm-initial');
        scheduleSameTrackReplayResync(time, incomingIndex, currentTrackIndex);
      }
    } else {
      // Without hostPlayAt, start immediately and let initial sync correct it.
      play(time);
      bus.emit('sync:arm-initial');
      scheduleSameTrackReplayResync(time, incomingIndex, currentTrackIndex);
    }
  } else {
    // Remote guest: no file will arrive via P2P. For the demo, fall back
    // to an HTTP fetch (covers the case where PLAYLIST_UPDATE arrived
    // before PLAY, so currentTrackIndex already matches and we skipped
    // the index-mismatch branch above). Otherwise, surface remote-share
    // unavailability.
    if (isRemoteGuest()) {
      if (tryFetchDemoForRemote(currentTrackIndex, data.name as string | undefined, time)) return;
      if (shouldWaitForRemoteShare()) {
        const safeIndex =
          Number.isFinite(currentTrackIndex) && currentTrackIndex >= 0
            ? currentTrackIndex
            : incomingIndex !== undefined && Number.isFinite(incomingIndex) && incomingIndex >= 0
              ? incomingIndex
              : 0;
        const waitName = data.name as string | undefined;
        // Dedup mirror of prepareRemoteShareWait's alreadyWaiting check.
        const recoveryTarget = getState('playback.pendingRecoveryTarget');
        const alreadyWaiting =
          getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD &&
          recoveryTarget?.index === safeIndex &&
          recoveryTarget.name === (waitName || '');
        prepareRemoteShareWait(safeIndex, waitName || '', getRemoteWaitSessionId());
        setPendingPlayTime(time);
        if (!alreadyWaiting) {
          // Ask the host to resend the descriptor for this newly armed wait.
          sendToHost({
            type: MSG.REQUEST_CURRENT_FILE,
            name: playlist[safeIndex]?.name || waitName || '',
            index: safeIndex,
            reason: 'remote_share_wait',
          });
        }
        log.info('[Guest] Remote guest — waiting for remote share descriptor');
        return;
      }
      setFileTrackMetaFromPlaylist(currentTrackIndex, data.name as string | undefined);
      showLoader(false);
      showToast(t('share.remote.unavailable'));
      log.info('[Guest] Remote guest — remote share unavailable');
      return;
    }
    setPendingPlayTime(time);
    log.debug(`[Guest] Storing pending play time: ${time}`);

    // If PLAY targets the current index but neither a buffer nor an inbound
    // pipeline exists, request the current file. Never do this while transfer
    // state is RECEIVING/PROCESSING: its watchdog owns resume-based recovery,
    // and a second request could restart a healthy partial transfer.
    const lifecycleNow = getState('playback.lifecycle');
    const transferStateNow = getState('transfer.state');
    if (
      (lifecycleNow === PLAYBACK_STATE.IDLE || lifecycleNow === PLAYBACK_STATE.FAILED) &&
      transferStateNow !== TRANSFER_STATE.RECEIVING &&
      transferStateNow !== TRANSFER_STATE.PROCESSING &&
      currentTrackIndex >= 0
    ) {
      const trackName = playlist[currentTrackIndex]?.name || (data.name as string) || '';
      log.info('[Guest] PLAY for current index with no buffer/pipeline — requesting current file');
      sendToHost({
        type: MSG.REQUEST_CURRENT_FILE,
        name: trackName,
        index: currentTrackIndex,
        reason: 'no_buffer',
      });
    }
  }
}

/**
 * Remote-guest helper: if the track at `index` is the demo, kick off the
 * HTTP fetch from the server and return true. Used in two PLAY-handler
 * branches (index-mismatch and no-buffer) so either message-arrival order
 * lands on the same path.
 */
function tryFetchDemoForRemote(index: number, dataName: string | undefined, time: number): boolean {
  const playlist = getState('playlist.items') || [];
  const name = playlist[index]?.name || dataName || '';
  if (!isDemoTrackName(name)) return false;

  // Idempotency: If we already have the demo blob or are in the middle of
  // activating it, return false so heartbeats can proceed to the sync logic.
  const currentFile = getState('files.currentFileBlob') as File | null;
  const hasDemo = isDemoTrackName(currentFile?.name);
  if (hasDemo || isPlayPreloadedInProgress()) return false;

  log.debug('[Guest] Remote — fetching demo from server');

  // Title fallback: playlist[index] may be empty if PLAYLIST_UPDATE hasn't
  // landed yet. Synthesize a demo-flavoured meta so the UI isn't stuck on
  // "미디어 없음" during the HTTP fetch. loadPreloadedTrack will overwrite
  // with the real playlist entry after decode.
  const item = playlist[index];
  setPlaybackTrackMeta(item ?? createFileTrackMeta(name));

  // Preserve host's play time so loadPreloadedTrack can seek (with age
  // compensation) once decode finishes — without this the post-fetch
  // handler sees pendingPlayTime=undefined and never calls play().
  setPendingPlayTime(time);
  // Demo variant transitions lifecycle to AWAITING_PRELOAD —
  // shouldSkipIncomingFile() returns true automatically.
  const demoTrack = getDemoTrackForPlayback(index, name);
  transition({ type: 'FILE_PREPARE', variant: 'demo', index, name: demoTrack.fileName });
  fetchDemoFromServer(index, time, getPendingPlayTimeSetAt(), name).catch((e) =>
    log.error('[Guest] Demo fetch failed:', e),
  );
  return true;
}

function handlePauseMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  // Drop PAUSE frames not arriving via hostConn. Without this, a malicious
  // guest can send {type:'pause', endOfPlaylist:true} to the host — the
  // endOfPlaylist branch below stops host audio, clears currentTrackMeta,
  // resets currentTrackIndex=-1, and shows the "playlist ended" toast.
  // A single raw frame from any session participant would otherwise disrupt
  // host playback, so apply the same authoritative-connection boundary as the
  // chat handlers.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  // Authoritative host command — release any local lock-screen pause. Both
  // ends end up paused here; a later host PLAY then resumes this guest.
  setLocalFilePaused(false);

  // Ignore PAUSE during system audio mode
  if (isSystemAudioOwner()) return;
  // Ignore PAUSE in YouTube mode — YouTube uses YOUTUBE_STATE/YOUTUBE_STOP instead
  if (isYouTubeOwner()) return;

  const time = Number(data.time) || 0;
  const endOfPlaylist = !!data.endOfPlaylist;
  const reason = typeof data.reason === 'string' ? data.reason : undefined;

  // If host pauses, cancel any deferred play that was waiting for a
  // download/preload to finish. Otherwise, a guest who completes their
  // download while the host is paused will erroneously auto-start playback.
  setPendingPlayTime(undefined);

  // Host reached end of playlist (Repeat OFF). Short-circuit: skip the
  // regular pause() path which would flash a "일시정지" toast before the
  // "재생목록 끝" toast overwrites it. Just stop everything and clear
  // the stale track meta so title/indicator mirror the host's reset.
  if (endOfPlaylist) {
    log.debug('[Guest] Host signalled end of playlist — clearing track meta');
    setPlaybackTrackMeta(null);
    // Mirror host's deselected state so operator guest's togglePlay
    // also redirects to playTrack(0) instead of resuming stale audio.
    setState('playlist.currentTrackIndex', -1);
    setState('player.pausedAt', 0);
    stopAllMedia();
    showToast(t('toast.playlist_ended'));
    return;
  }

  const isUserPause = reason === undefined || reason === 'pause';
  // Stop the concrete WebAudio node before moving semantic state to PAUSED.
  // pause() intentionally no-ops once file ownership is already paused, so
  // doing the lifecycle transition first can leave audio audible while the UI
  // looks stopped.
  pause(time, { holdVisualizer: isUserPause, showToast: isUserPause });

  // Regular PAUSE enters PAUSED only after the transport has stopped;
  // endOfPlaylist=true returned through the terminal branch above.
  transition({ type: 'PAUSE', time, endOfPlaylist });
}

function handleRequestPlay(data: Record<string, unknown>, conn: DataConnection): void {
  // Host handles OP's request to play
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only Host executes

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playback] Rejected request-play from non-OP: ${conn?.peer}`);
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
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const playlistItems = getState('playlist.items') || [];

  // Deselected state (post end-of-playlist): redirect to playTrack(0)
  // rather than resuming stale audio buffer.
  if (currentTrackIndex === -1 && playlistItems.length > 0) {
    void import('./playlist.ts').then((mod) => mod.playTrack(0));
    return;
  }

  // A busy pipeline still holds the previous track's AudioBuffer. Ignore the
  // request; decode completion owns playback of the newly selected track.
  if (isFilePipelineBusyForPlay()) {
    log.debug('[Playback] Ignoring REQUEST_PLAY while file pipeline is preparing');
    return;
  }

  play(time);
  broadcast({
    type: MSG.PLAY,
    time,
    index: currentTrackIndex,
    hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS,
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

  clearManagedTimer('autoPlayTimer');
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');
  pause();
  broadcast({ type: MSG.PAUSE, time: getState('player.pausedAt'), reason: 'pause' });
}

function handleRequestSeek(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playback] Rejected request-seek from non-OP: ${conn?.peer}`);
    return;
  }

  // Cancel pending auto-play / ended-advance timers — the 3s auto-play
  // window after a track load would otherwise fire `play(0)` at its
  // scheduled time and overwrite the OP's just-applied seek position.
  clearManagedTimer('autoPlayTimer');
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');

  const time = Number(data.time) || 0;
  const currentTrackIndex = getState('playlist.currentTrackIndex');

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
    play(time);
    broadcast({
      type: MSG.PLAY,
      time,
      index: currentTrackIndex,
      hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS,
    });
  } else {
    setState('player.pausedAt', time);
    broadcast({ type: MSG.PAUSE, time, reason: 'seek' });
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

  const sec = Number(data.sec);
  if (!Number.isFinite(sec)) return;
  skipTime(sec);
}

// ─── Init ──────────────────────────────────────────────────────────

export function initPlayback(): void {
  registerHandlers({
    [MSG.PLAY]: handlePlayMsg,
    [MSG.PAUSE]: handlePauseMsg,
    [MSG.REQUEST_PLAY]: handleRequestPlay,
    [MSG.REQUEST_PAUSE]: handleRequestPause,
    [MSG.REQUEST_SEEK]: handleRequestSeek,
    [MSG.REQUEST_SKIP_TIME]: handleRequestSkipTime,
  });

  // Stop all media (called from youtube player before loading)
  bus.on('player:stop-all-media', () => {
    stopAllMedia();
  });

  // Replay current track from start (repeat-one: guest already has file).
  // delayMs lets the host tell the guest "I'm going to start at T+delayMs,
  // so don't start playing until then" — prevents the 3-second drift
  // window when host re-clicks a currently-playing track.
  bus.on('playback:replay-current', (delayMs?: number) => {
    if (!getCurrentAudioBuffer()) return;

    const doReplay = () => {
      log.debug('[Guest] Replaying current track from start');
      play(0);
      // Auto-sync 1s later to align with host
      const hostConn = getState('network.hostConn');
      if (hostConn?.open) {
        setManagedTimer('playback-repeat-auto-sync', () => bus.emit('sync:force-resync'), 1000);
      }
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

  // Long background resume recovery: rebuild the current AudioBufferSourceNode
  // at the current logical position without surfacing a manual-sync toast.
  bus.on('playback:refresh-current-position', () => {
    if (!getCurrentAudioBuffer()) return;
    if (!isPlaybackPlayingFile()) return;
    // A background resume may occur during a track change, while the resident
    // buffer still belongs to the previous track. Decode completion owns restart.
    if (isFilePipelineBusyForPlay()) return;
    play(getTrackPosition());
  });

  // Disconnect playerNode from surround splitter (called when surround mode turns off)
  bus.on('audio:disconnect-surround', () => {
    const _playerNode = getPlayerNode();
    if (_playerNode) {
      try {
        _playerNode.disconnect(getSurroundSplitter()!);
      } catch {
        /* may not be connected */
      }
    }
  });

  // Surround mode toggled during playback: restart at current position
  bus.on('audio:surround-toggled', () => {
    if (isPlaybackPlayingFile()) {
      play(getTrackPosition());
    }
  });

  // Safety polling: periodically check if track ended (called from UI loop)
  bus.on('player:check-ended', () => {
    handleEnded();
  });

  // Clear previous track state (called from transfer module during track switch)
  bus.on('storage:clear-previous-track', (context) => {
    if (context === 'session-change') setLastClearedTrackName('');
    clearPreviousTrackState(context);
  });

  // Storage file ready: finalize guest download processing
  bus.on('storage:file-ready', async (filename, _sessionId, isPreload) => {
    if (isPreload) {
      // Preload files are handled by preload module via storage:preload-file-ready
      bus.emit('storage:preload-file-ready', filename, _sessionId);
      return;
    }

    // Only guest processes incoming files (Host loads directly)
    const hostConn = getState('network.hostConn');
    if (!hostConn) return;

    // Drop completions superseded by a newer transfer before decoding them.
    // A lower session id remains usable when its filename still matches the
    // current target, which covers a rapid A→B→A return while assembly is
    // finishing.
    const localSid = getState('transfer.localSessionId');
    if (_sessionId && localSid && _sessionId < localSid) {
      const currentName = getState('transfer.meta')?.name || '';
      const matchesCurrent = !!filename && !!currentName && filename === currentName;
      if (!matchesCurrent) {
        log.debug(
          `[Playback] storage:file-ready dropped — stale session ${_sessionId} < ${localSid}, filename=${filename}, current=${currentName || '(none)'}`,
        );
        return;
      }
      log.info(
        `[Playback] Accepting "stale" file completion — matches current transfer target (${filename}, SID ${_sessionId} < ${localSid})`,
      );
    }

    const file = await readStoredFile(filename, false);
    if (!file) {
      log.error('[Playback] Failed to read file:', filename);
      showLoader(false);
      return;
    }

    // Re-check session after async readStoredFile — the read itself is
    // async and the session may have advanced while we were waiting.
    // Same fallback applies: accept when filename still matches.
    const sidAfterRead = getState('transfer.localSessionId');
    if (_sessionId && sidAfterRead && _sessionId < sidAfterRead) {
      const currentNameAfter = getState('transfer.meta')?.name || '';
      const stillMatches = !!filename && !!currentNameAfter && filename === currentNameAfter;
      if (!stillMatches) {
        log.debug(
          `[Playback] storage:file-ready dropped after read — stale session ${_sessionId} < ${sidAfterRead}`,
        );
        return;
      }
    }

    // Lifecycle: all chunks received and assembled → DOWNLOADING → DECODING.
    // finalizeGuestFile will emit DECODE_SUCCESS next; without this FILE_END
    // beat, that transition would be rejected because we'd still look to
    // the state machine like we're DOWNLOADING.
    transition({ type: 'FILE_END' });

    await finalizeGuestFile(file);
  });

  // Use preloaded track (skip download, decode from preload cache)
  bus.on('storage:use-preloaded', (index, name) => {
    log.debug(`[Playback] Using preloaded track for index: ${index} (${name})`);

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
    const nextFileBlob = getState('preload.nextFileBlob');
    if (nextFileBlob) {
      if (isPlayPreloadedInProgress()) {
        // A loadPreloadedTrack is mid-flight. Two cases:
        //   - Same index: redundant call (e.g. duplicate use-preloaded
        //     from a re-arm path). Ignore.
        //   - Different index: a new preload arrived while the old one
        //     was still decoding. Supersede via a fresh load epoch — the
        //     in-flight call will detect the supersession after decode and
        //     bail out (preserving pendingPlayTime per decode.ts), and
        //     this new call takes ownership.
        // The distinction ensures a new blob always gets its own activation.
        const activeIdx = _activePreloadIndex;
        if (activeIdx === index) {
          log.debug('[Playback] Activation already in progress for same index, ignoring');
          return;
        }
        log.info(
          `[Playback] use-preloaded(${index}) supersedes in-flight load(${activeIdx ?? '?'})`,
        );
        // Do not clear the in-progress flag here. The compare-before-clear
        // owner handle makes the superseded finish a no-op, and the successor
        // clears the flag when its own activation ends.
      }
      _activePreloadIndex = index;
      const newEpoch = newLoadEpoch();
      loadPreloadedTrack(index, newEpoch).finally(() => {
        if (_activePreloadIndex === index) _activePreloadIndex = null;
      });
    } else {
      // Blob not ready yet — set progress-aware watchdog. Will be triggered
      // by storage:file-ready → storage:preload-file-ready → use-preloaded re-emit.
      log.debug('[Playback] Preload blob not ready yet, waiting for download completion...');

      // Progress-aware watchdog
      // ────────────────────────────────────
      // Serialized preload transfers may take longer than one stall window, so
      // reset the timer on forward chunk progress, retain an absolute ceiling,
      // and recover only after a true stall.
      const PRELOAD_WATCHDOG_MAX_MS = 60_000; // absolute ceiling
      const PRELOAD_WATCHDOG_STALL_MS = 10_000; // no-progress timeout
      const watchdogStart = Date.now();
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
        if (getState('playback.lifecycle') !== PLAYBACK_STATE.AWAITING_PRELOAD) return;
        log.warn('[Preload] Preloaded blob not available — stall timeout');
        // shouldSkipIncomingFile() will return false once host's response
        // FILE_PREPARE transitions us out of AWAITING_PRELOAD into DOWNLOADING.
        showLoader(false);
        // Request the file from the host after a confirmed stall.
        const hostConn = getState('network.hostConn');
        if (hostConn?.open) {
          showLoader(true, t('transfer.file_requesting'));
          sendToHost({
            type: MSG.REQUEST_DATA_RECOVERY,
            nextChunk: 0,
            fileName: name,
            index,
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
      // stall timer. Respect the absolute ceiling to prevent runaway waits.
      const _unsubProgress = bus.on('state:preload.sessionState', () => {
        if (disposed) return;
        if (getState('playback.lifecycle') !== PLAYBACK_STATE.AWAITING_PRELOAD) return;

        // Absolute ceiling — give up even if progress is still happening
        if (Date.now() - watchdogStart > PRELOAD_WATCHDOG_MAX_MS) {
          log.warn('[Preload] Absolute watchdog ceiling reached');
          onWatchdogFire();
          return;
        }

        const sessionState = getState('preload.sessionState');
        for (const [, session] of sessionState) {
          if (session.skipped || session.finalized) continue;
          // Match by (index, name) tuple — both must agree. Loose-OR matching
          // would let a stale session for a different track win the reset
          // when names collide (duplicate track in queue) or indices shift
          // (post-reorder), causing the stall timer to reset for the wrong
          // session and delay recovery.
          if (session.index !== index || session.name !== name) continue;
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
    const currentTrackIndex = getState('playlist.currentTrackIndex');
    const playlist = getState('playlist.items') || [];

    // Send playback state (time-sync for late joiners)
    try {
      const nowPos = getTrackPosition();

      // System audio: send start message instead of PLAY/PAUSE (media call handled by system-audio-host)
      if (isSystemAudioPlaying) {
        conn.send({ type: MSG.SYSTEM_AUDIO_START });
      } else if (isFilePlaying) {
        const item = playlist[currentTrackIndex];
        const itemName = item?.name || item?.file?.name || null;
        // Late-join bootstrap: omit hostPlayAt — guest has no clock samples yet.
        // Guest starts immediately; initial sync corrects the unsampled clock.
        conn.send({
          type: MSG.PLAY,
          time: nowPos,
          index: currentTrackIndex,
          name: itemName,
        });
      } else if (!isYouTubeActive) {
        // IDLE or PAUSED: Send pause to sync position
        conn.send({
          type: MSG.PAUSE,
          time: nowPos,
          index: currentTrackIndex,
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

    const peers = getState('network.connectedPeers') || [];
    const peer = peers.find((p) => p.id === peerId);
    if (!peer || !peer.isDataTarget) return; // Remote peer — no direct file send
    const conn = peer.conn as DataConnection;
    if (!conn?.open) return;

    const currentTrackIndex = getState('playlist.currentTrackIndex');
    const playlist = getState('playlist.items') || [];

    if (currentTrackIndex >= 0 && playlist[currentTrackIndex]) {
      const item = playlist[currentTrackIndex];
      if (item.type !== 'youtube') {
        const currentFileBlob = getState('files.currentFileBlob');
        const currentSessionId = getState('transfer.currentSessionId');
        if (currentFileBlob) {
          log.debug(`[Playback] Sending current file to ${peer.label || peerId} (${reason})`);
          try {
            await unicastFile(conn, currentFileBlob, 0, currentSessionId);
          } catch (e: unknown) {
            log.error('[Host] unicastFile for late joiner failed', e);
            return;
          }
        }

        // Also send preloaded next track
        const nextFileBlob = getState('preload.nextFileBlob');
        const nextMeta = getState('preload.meta');
        const nextTrackIndex = getState('preload.nextTrackIndex');
        if (nextFileBlob && nextMeta && nextTrackIndex >= 0 && conn.open) {
          const preloadSid = (nextMeta.sessionId as number) || 0;
          try {
            await unicastPreload(conn, nextFileBlob, nextTrackIndex, preloadSid);
          } catch (e: unknown) {
            log.error('[Host] unicastPreload for late joiner failed', e);
          }
        }
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
