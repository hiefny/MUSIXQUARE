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
import { MSG, APP_STATE, PLAYBACK_STATE, DEMO_FILE_NAME } from '../core/constants.ts';
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

import {
  getCurrentAudioBuffer,
  getPlayerNode,
  incrementLoadToken,
  setPendingPlayTime,
  getPendingPlayTimeSetAt,
  isPlayPreloadedInProgress,
  setLastClearedTrackName,
} from './_state.ts';

import { play, pause, stopAllMedia, getTrackPosition, handleEnded, skipTime } from './transport.ts';

import { loadPreloadedTrack, clearPreviousTrackState, finalizeGuestFile } from './decode.ts';
import { showLoader, updateLoader, showToast } from '../ui/toast.ts';
import { isSystemAudioSessionActive, setPlaybackTrackMeta } from './ownership.ts';

/** Must match SCHEDULE_AHEAD_MS in transport.ts */
const SCHEDULE_AHEAD_MS = 200;

function setFileTrackMetaFromPlaylist(index: number, fallbackName?: string): void {
  const playlist = getState('playlist.items') || [];
  const item = playlist[index];
  const name = item?.name || fallbackName || '';
  setPlaybackTrackMeta(
    item ?? {
      type: 'file',
      title: name.replace(/\.[^/.]+$/, '') || name,
      name,
      videoId: null,
      playlistId: null,
    },
  );
}

function getRemoteWaitSessionId(): number {
  const localSessionId = Number(getState('transfer.localSessionId'));
  if (Number.isFinite(localSessionId) && localSessionId > 0) return localSessionId;
  const currentSessionId = Number(getState('transfer.currentSessionId'));
  if (Number.isFinite(currentSessionId) && currentSessionId > 0) return currentSessionId;
  return 0;
}

// ─── Preload waiter: cross-invocation cleanup ───────────────────────
// Tracks active unsubs from storage:use-preloaded's "blob not ready" path.
// Rapid track switches (A→B while both are waiting) would otherwise leave
// A's listeners alive alongside B's, letting A's closure overwrite B's
// stall timer or issue a REQUEST_DATA_RECOVERY for the wrong track.
let _activePreloadWaiterCleanup: (() => void) | null = null;
// Tracks which playlist index loadPreloadedTrack is currently decoding for,
// so use-preloaded for a DIFFERENT index can supersede the in-flight call
// rather than getting silently ignored. See the use-preloaded handler for
// the supersession protocol.
let _activePreloadIndex: number | null = null;

// ─── Re-exports ────────────────────────────────────────────────────
// All public API re-exported so external imports from './playback.ts' keep working.

// Note: Re-exports removed. Import directly from transport.ts, decode.ts, _state.ts.

// ─── Network Message Handlers ──────────────────────────────────────

function handlePlayMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  // Drop PLAY frames not arriving via hostConn. Sibling to handlePauseMsg
  // (874a860): both are host→guest authoritative broadcasts (host's own
  // state changes go through setState directly, never through its own
  // dispatcher). Without this, a peer can inject
  // {type:'play', time:<t>, index:<i>} to force
  // an arbitrary track-index change + play() at attacker time on the
  // target. Per-handler guards protect each receiver's own state mutation path — same rationale as
  // a6eadce (effects), 8cbf192 (youtube), fe32164 (preload/transfer).
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  // Ignore PLAY during system audio mode (live stream, not file-based).
  // The helper also covers the guest's pending placeholder window between
  // SYSTEM_AUDIO_START and the first WebRTC stream.
  if (isSystemAudioSessionActive()) return;

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
      const newToken = incrementLoadToken();
      loadPreloadedTrack(incomingIndex, newToken);
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
        prepareRemoteShareWait(incomingIndex, waitName || '', getRemoteWaitSessionId());
        setPendingPlayTime(time);
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

  // Lifecycle gate.
  //
  // If we're in AWAITING_PRELOAD for this track, the "stale audio" we're
  // about to detect below is EXPECTED — we haven't consumed the preload
  // blob yet, so transfer.meta still reflects the previous track. The old
  // stale-audio-recovery timer would kick in 5s later and request a full
  // re-download (0%-restart), wasting the almost-finished preload.
  //
  // In AWAITING_PRELOAD, just defer the play time. When the preload blob
  // finalizes and loadPreloadedTrack runs, it consumes pendingPlayTime and
  // plays at the correct host-scheduled instant.
  const lifecycle = getState('playback.lifecycle');
  if (lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD) {
    setPendingPlayTime(time);
    // Drive the state machine for observability (it's a stay transition).
    transition({ type: 'PLAY', time, index: incomingIndex, sameTrack: true });
    log.debug(
      `[Guest] PLAY arrived while AWAITING_PRELOAD — deferring to preload waiter (time=${time})`,
    );
    return;
  }

  // Stale-audio guard (Phase 4: 5s recovery timer DELETED).
  //
  // Previously this block armed a 5s timer that issued REQUEST_CURRENT_FILE
  // if meta.name != expected when PLAY arrived. That timer's original
  // purpose — catching a "preload still finalizing" race — is now handled
  // by the AWAITING_PRELOAD short-circuit above and the state machine's
  // supersede transitions on FILE_PREPARE.
  //
  // With those in place, any name mismatch reaching this point is either:
  //   (a) a transient out-of-order message (next handler supersedes us)
  //   (b) a genuine inconsistency already handled by the index-mismatch
  //       branch above (line ~88)
  // Issuing REQUEST_CURRENT_FILE here would race with in-flight transfers
  // and cause the very "0% re-download" symptom the refactor killed. So we
  // just store the pending play time and trust the surrounding machinery
  // to put us in the right state.
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
    // Lifecycle (Phase 3 dual-write): we have a decoded buffer → we're in
    // READY (or PLAYING/PAUSED already if this is a seek). Drive the machine.
    // transition() handles same-track seek, resume from PAUSED, restart from
    // READY — see Section 4 of the design doc.
    transition({ type: 'PLAY', time, index: incomingIndex, sameTrack: true });

    // Shared Clock: schedule play at the host-specified time
    const hostPlayAt = Number(data.hostPlayAt) || 0;
    if (hostPlayAt > 0) {
      const now = getHostNow();
      const waitMs = Math.max(0, hostPlayAt - now);
      const offset = getClockOffset();
      const bestRtt = getClockBestRtt();

      if (waitMs > 0 && waitMs < 2000) {
        // Compensate: host has been playing during waitMs, so advance position
        const compensatedTime = time + waitMs / 1000;
        // Web Audio hardware-timed start — sub-ms precision (no setTimeout jitter)
        play(compensatedTime, waitMs / 1000);
        log.debug(
          `[SharedClock] Scheduled play in ${waitMs}ms at ${compensatedTime.toFixed(2)}s (offset=${offset}ms, rtt=${bestRtt}ms, WebAudio)`,
        );
        bus.emit('sync:arm-initial');
      } else {
        log.warn(`[SharedClock] waitMs out of range (${waitMs}ms), playing immediately`);
        play(time);
        bus.emit('sync:arm-initial');
      }
    } else {
      // Legacy: no hostPlayAt field — play immediately
      play(time);
      bus.emit('sync:arm-initial');
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
        prepareRemoteShareWait(safeIndex, waitName || '', getRemoteWaitSessionId());
        setPendingPlayTime(time);
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
  if (name !== DEMO_FILE_NAME) return false;

  // Idempotency: If we already have the demo blob or are in the middle of
  // activating it, return false so heartbeats can proceed to the sync logic.
  const currentFile = getState('files.currentFileBlob') as File | null;
  const hasDemo = currentFile?.name === DEMO_FILE_NAME;
  if (hasDemo || isPlayPreloadedInProgress()) return false;

  log.debug('[Guest] Remote — fetching demo from server');

  // Title fallback: playlist[index] may be empty if PLAYLIST_UPDATE hasn't
  // landed yet. Synthesize a demo-flavoured meta so the UI isn't stuck on
  // "미디어 없음" during the HTTP fetch. loadPreloadedTrack will overwrite
  // with the real playlist entry after decode.
  const item = playlist[index];
  setState(
    'player.currentTrackMeta',
    item ?? {
      type: 'file',
      name,
      title: name.replace(/\.[^/.]+$/, ''),
      videoId: null,
      playlistId: null,
    },
  );

  // Preserve host's play time so loadPreloadedTrack can seek (with age
  // compensation) once decode finishes — without this the post-fetch
  // handler sees pendingPlayTime=undefined and never calls play().
  setPendingPlayTime(time);
  // Demo variant transitions lifecycle to AWAITING_PRELOAD —
  // shouldSkipIncomingFile() returns true automatically.
  transition({ type: 'FILE_PREPARE', variant: 'demo', index, name });
  fetchDemoFromServer(index, time, getPendingPlayTimeSetAt()).catch((e) =>
    log.error('[Guest] Demo fetch failed:', e),
  );
  return true;
}

function handlePauseMsg(data: Record<string, unknown>, conn?: DataConnection): void {
  // Drop PAUSE frames not arriving via hostConn. Without this, a malicious
  // guest can send {type:'pause', endOfPlaylist:true} to the host — the
  // endOfPlaylist branch below stops host audio, clears currentTrackMeta,
  // resets currentTrackIndex=-1, and shows the "playlist ended" toast.
  // Single raw frame from any session participant disrupts the host's
  // playback. Mirrors the chat handler defenses (4157237/dcd3472).
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  // Ignore PAUSE during system audio mode
  if (isSystemAudioSessionActive()) return;
  // Ignore PAUSE in YouTube mode — YouTube uses YOUTUBE_STATE/YOUTUBE_STOP instead
  if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) return;

  const time = Number(data.time) || 0;
  const endOfPlaylist = !!data.endOfPlaylist;
  const reason = typeof data.reason === 'string' ? data.reason : undefined;

  // Lifecycle (Phase 3 dual-write): PAUSE is a global rule when
  // endOfPlaylist=true (→ IDLE from any state). Regular PAUSE routes
  // to PAUSED per Section 4.
  transition({ type: 'PAUSE', time, endOfPlaylist });

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

  pause(time, { holdVisualizer: reason === undefined || reason === 'pause' });
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
  const currentState = getState('appState');
  const currentTrackIndex = getState('playlist.currentTrackIndex');

  // YouTube seek
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    bus.emit('youtube:seek-to', time);
    return;
  }

  if (currentState === APP_STATE.PLAYING_AUDIO) {
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
        setManagedTimer('playback-repeat-auto-sync', () => bus.emit('sync:auto-sync'), 1000);
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
    if (getState('appState') !== APP_STATE.PLAYING_AUDIO) return;
    play(getTrackPosition());
  });

  // 'sync:get-position' and 'sync:response' listeners removed — no emitter exists

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
    const currentState = getState('appState');
    if (currentState === APP_STATE.PLAYING_AUDIO) {
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

    // Stale session guard: by the time this async handler fires, the guest
    // may have moved on to a newer transfer session (rapid track switch,
    // recovery response for an older session, etc.). Compare the incoming
    // sessionId against transfer.localSessionId and drop if superseded.
    // finalizeGuestFile has its own load-token guard internally, but
    // skipping here avoids an unnecessary decode of a now-stale file.
    //
    // FALLBACK (2026-04-25): a "stale" session may actually be the file
    // we still need. In a rapid A→B→A bounce, A's localSid gets bumped
    // past A's original sessionId while A's storage finalize is still in
    // flight; dropping it here stalls the guest at 100% until the chunk
    // watchdog fires a full re-download (~12-60s). Accept the completion
    // when its filename matches the current transfer target — mirrors
    // the preload.ts HOTFIX for the same race class.
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
        //     was still decoding. Supersede via load-token bump — the
        //     in-flight call will detect the mismatch after decode and
        //     bail out (preserving pendingPlayTime per decode.ts), and
        //     this new call takes ownership.
        // Without this distinction, remote-share track 2 → track 3 in
        // rapid succession would wedge: track 2's decode keeps the flag
        // set, track 3's use-preloaded gets ignored, and the user sits
        // with track 3's blob in memory but no decode running.
        const activeIdx = _activePreloadIndex;
        if (activeIdx === index) {
          log.debug('[Playback] Activation already in progress for same index, ignoring');
          return;
        }
        log.info(
          `[Playback] use-preloaded(${index}) supersedes in-flight load(${activeIdx ?? '?'})`,
        );
        // Don't clear setPlayPreloadedInProgress — the in-flight call will
        // hit token mismatch and clear it itself; we'd otherwise create a
        // window where the flag is false but a decode is still running,
        // letting handlePlayMsg fall through and double-trigger play.
      }
      _activePreloadIndex = index;
      const newToken = incrementLoadToken();
      loadPreloadedTrack(index, newToken).finally(() => {
        if (_activePreloadIndex === index) _activePreloadIndex = null;
      });
    } else {
      // Blob not ready yet — set progress-aware watchdog. Will be triggered
      // by storage:file-ready → storage:preload-file-ready → use-preloaded re-emit.
      log.debug('[Playback] Preload blob not ready yet, waiting for download completion...');

      // Approach B: progress-aware watchdog
      // ────────────────────────────────────
      // The host now serializes preload transfers, so an in-progress preload
      // WILL finalize naturally — we just need to wait for it. Fixed 10s was
      // too short for larger tracks over slower networks, forcing a needless
      // 0%-restart recovery. Instead, wait up to 60s total but reset the
      // timer each time the preload session makes progress (nextExpectedChunk
      // increments). If progress stalls for 10s straight, give up and recover.
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
        // Phase 4: lifecycle drives the check. If we've left AWAITING_PRELOAD
        // the blob arrived or got superseded — no recovery needed.
        if (getState('playback.lifecycle') !== PLAYBACK_STATE.AWAITING_PRELOAD) return;
        log.warn('[Preload] Preloaded blob not available — stall timeout');
        // shouldSkipIncomingFile() will return false once host's response
        // FILE_PREPARE transitions us out of AWAITING_PRELOAD into DOWNLOADING.
        showLoader(false);
        // Fallback: request file from host
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
      // Phase 4: subscribe to lifecycle instead of the legacy flag.
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

    const currentState = getState('appState');
    const currentTrackIndex = getState('playlist.currentTrackIndex');
    const playlist = getState('playlist.items') || [];

    // Send playback state (time-sync for late joiners)
    try {
      const nowPos = getTrackPosition();

      // System audio: send start message instead of PLAY/PAUSE (media call handled by system-audio-host)
      if (currentState === APP_STATE.PLAYING_SYSTEM_AUDIO) {
        conn.send({ type: MSG.SYSTEM_AUDIO_START });
      } else if (currentState === APP_STATE.PLAYING_AUDIO) {
        const item = (playlist[currentTrackIndex] as unknown as Record<string, unknown>) || {};
        const itemName = (item.name || (item.file as File | undefined)?.name || null) as
          | string
          | null;
        // Late-join bootstrap: omit hostPlayAt — guest has no clock samples yet.
        // Guest plays immediately (legacy path); initial sync corrects 1s later.
        conn.send({
          type: MSG.PLAY,
          time: nowPos,
          index: currentTrackIndex,
          name: itemName,
          state: currentState,
          timestamp: Date.now(),
        });
      } else if (currentState !== APP_STATE.PLAYING_YOUTUBE) {
        // IDLE or PAUSED: Send pause to sync position
        conn.send({
          type: MSG.PAUSE,
          time: nowPos,
          index: currentTrackIndex,
          state: currentState,
          timestamp: Date.now(),
          reason: currentState === APP_STATE.PAUSED ? 'pause' : 'stop',
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

    const peers = getState('network.connectedPeers') || [];
    const peer = peers.find((p) => p.id === peerId);
    if (!peer || !peer.isDataTarget) return; // Remote peer — no direct file send
    const conn = peer.conn as DataConnection;
    if (!conn?.open) return;

    const currentTrackIndex = getState('playlist.currentTrackIndex');
    const playlist = getState('playlist.items') || [];

    if (currentTrackIndex >= 0 && playlist[currentTrackIndex]) {
      const item = playlist[currentTrackIndex] as unknown as Record<string, unknown>;
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
