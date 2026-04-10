/**
 * MUSIXQUARE 3.0 — Playback Engine (Coordinator)
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
import { MSG, APP_STATE, TRANSFER_STATE } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { getHostNow, getClockOffset, getClockBestRtt } from '../network/shared-clock.ts';
import { getVideoElement } from './video.ts';
import { readFileFromOpfs } from '../storage/opfs.ts';
import { unicastFile } from '../storage/transfer.ts';
import { unicastPreload } from '../storage/preload.ts';
import { broadcast, sendToHost, isRemoteGuest, hasActiveRelay } from '../network/peer.ts';
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import { getSurroundSplitter } from '../audio/engine.ts';
import type { DataConnection } from '../types/index.ts';

import {
  getCurrentAudioBuffer,
  getPlayerNode,
  incrementLoadToken,
  getPendingPlayTime, setPendingPlayTime,
  isPlayPreloadedInProgress,
  setLastClearedTrackName,
} from './_state.ts';

import {
  play, pause, stopAllMedia,
  getTrackPosition, checkVideoSync, handleEnded,
  skipTime,
} from './transport.ts';

import {
  loadPreloadedTrack,
  clearPreviousTrackState, finalizeGuestFile,
} from './decode.ts';
import { showLoader, updateLoader, showToast } from '../ui/toast.ts';

/** Must match SCHEDULE_AHEAD_MS in transport.ts */
const SCHEDULE_AHEAD_MS = 200;

// ─── Preload waiter: cross-invocation cleanup ───────────────────────
// Tracks active unsubs from storage:use-preloaded's "blob not ready" path.
// Rapid track switches (A→B while both are waiting) would otherwise leave
// A's listeners alive alongside B's, letting A's closure overwrite B's
// stall timer or issue a REQUEST_DATA_RECOVERY for the wrong track.
let _activePreloadWaiterCleanup: (() => void) | null = null;

// ─── Re-exports ────────────────────────────────────────────────────
// All public API re-exported so external imports from './playback.ts' keep working.

// Note: Re-exports removed. Import directly from transport.ts, decode.ts, _state.ts.

// ─── Network Message Handlers ──────────────────────────────────────

function handlePlayMsg(data: Record<string, unknown>): void {
  // Ignore PLAY during system audio mode (live stream, not file-based)
  if (getState('appState') === APP_STATE.PLAYING_SYSTEM_AUDIO) return;

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

    // Fresh join (currentTrackIndex was -1): the file will be sent automatically
    // by the orchestrator:peer-evaluated handler after ICE detection completes.
    // Don't send REQUEST_CURRENT_FILE — it would create a redundant double transfer
    // if the request arrives after the orchestrator sets isDataTarget=true.
    if (currentTrackIndex === -1) {
      log.debug('[Guest] Fresh join — file will arrive via orchestrator:peer-evaluated');
      return;
    }

    // No preload — request file from host (transport guard)
    if (isRemoteGuest() && !hasActiveRelay()) {
      const playlist = getState('playlist.items') || [];
      const name = playlist[incomingIndex]?.name || '';
      setState('player.currentTrackMeta', {
        type: 'file',
        title: t('toast.same_wifi_file_title'),
        name,
        videoId: null,
        playlistId: null,
      });
      showLoader(false);
      log.info('[Guest] Remote guest — skipping file request (TURN billing prevention)');
      return;
    }
    const playlist = getState('playlist.items') || [];
    const name = playlist[incomingIndex]?.name || '';
    sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name, index: incomingIndex, reason: 'index_mismatch' });
    return;
  }

  // Stale audio guard: verify loaded file matches expected name
  const meta = getState('transfer.meta');
  const playlist = getState('playlist.items') || [];
  const expectedName = (data.name as string) || playlist[currentTrackIndex]?.name || '';
  const loadedName = (meta?.name as string) || '';
  if (expectedName && loadedName && expectedName !== loadedName) {
    log.warn(`[Guest] Stale audio detected: loaded=${loadedName}, expected=${expectedName}`);
    setPendingPlayTime(time);
    // Request the correct file from host after a short delay to allow in-flight
    // transfers to complete. Without this, the guest permanently blocks.
    setManagedTimer('stale-audio-recovery', () => {
      if (getPendingPlayTime() !== undefined) {
        // Transport guard: remote guest without relay can't receive file data
        if (isRemoteGuest() && !hasActiveRelay()) {
          log.info('[Guest] Stale audio recovery skipped — remote without relay');
          return;
        }
        // Skip if transfer is already in progress — file is arriving, no need to re-request
        const transferState = getState('transfer.state');
        if (transferState === TRANSFER_STATE.RECEIVING || transferState === TRANSFER_STATE.PROCESSING) {
          log.info(`[Guest] Stale audio recovery skipped — transfer in progress (${transferState})`);
          return;
        }
        // Check by name match instead of buffer existence — a stale buffer
        // may still be loaded (different track name), blocking recovery
        const currentMeta = getState('transfer.meta');
        const currentName = (currentMeta?.name as string) || '';
        if (!currentName || currentName !== expectedName) {
          log.info('[Guest] Stale audio recovery: requesting current file from host');
          const freshIndex = getState('playlist.currentTrackIndex');
          sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name: expectedName, index: freshIndex, reason: 'stale_audio' });
        }
      }
    }, 5000);
    return;
  }

  if (getCurrentAudioBuffer() || getVideoElement()?.src) {
    // Shared Clock: schedule play at the host-specified time
    const hostPlayAt = Number(data.hostPlayAt) || 0;
    if (hostPlayAt > 0) {
      const now = getHostNow();
      const waitMs = Math.max(0, hostPlayAt - now);
      const offset = getClockOffset();
      const bestRtt = getClockBestRtt();

      if (waitMs > 0 && waitMs < 2000) {
        // Compensate: host has been playing during waitMs, so advance position
        const compensatedTime = time + (waitMs / 1000);
        // Web Audio hardware-timed start — sub-ms precision (no setTimeout jitter)
        const hasBuffer = !!getCurrentAudioBuffer();
        if (hasBuffer) {
          play(compensatedTime, waitMs / 1000);
        } else {
          // Video-only: fall back to setTimeout (Web Audio scheduling not available)
          setManagedTimer('clock-play', () => play(compensatedTime), waitMs);
        }
        log.debug(`[SharedClock] Scheduled play in ${waitMs}ms at ${compensatedTime.toFixed(2)}s (offset=${offset}ms, rtt=${bestRtt}ms${hasBuffer ? ', WebAudio' : ', setTimeout'})`);
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
    // Remote guest: no file will arrive, show guide (transport guard)
    if (isRemoteGuest() && !hasActiveRelay()) {
      const playlist2 = getState('playlist.items') || [];
      setState('player.currentTrackMeta', {
        type: 'file',
        title: t('toast.same_wifi_file_title'),
        name: playlist2[currentTrackIndex]?.name || '',
        videoId: null,
        playlistId: null,
      });
      showLoader(false);
      log.info('[Guest] Remote guest — no file will arrive, showing guide');
      return;
    }
    setPendingPlayTime(time);
    log.debug(`[Guest] Storing pending play time: ${time}`);
  }
}

function handlePauseMsg(data: Record<string, unknown>): void {
  // Ignore PAUSE during system audio mode
  if (getState('appState') === APP_STATE.PLAYING_SYSTEM_AUDIO) return;
  // Ignore PAUSE in YouTube mode — YouTube uses YOUTUBE_STATE/YOUTUBE_STOP instead
  if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) return;

  // Host reached end of playlist (Repeat OFF). Short-circuit: skip the
  // regular pause() path which would flash a "일시정지" toast before the
  // "재생목록 끝" toast overwrites it. Just stop everything and clear
  // the stale track meta so title/indicator mirror the host's reset.
  if (data.endOfPlaylist) {
    log.debug('[Guest] Host signalled end of playlist — clearing track meta');
    setState('player.currentTrackMeta', null);
    // Mirror host's deselected state so operator guest's togglePlay
    // also redirects to playTrack(0) instead of resuming stale audio.
    setState('playlist.currentTrackIndex', -1);
    setState('player.pausedAt', 0);
    stopAllMedia();
    showToast(t('toast.playlist_ended'));
    return;
  }

  const time = Number(data.time) || 0;
  pause(time);
}

function handleRequestPlay(data: Record<string, unknown>, conn: DataConnection): void {
  // Host handles OP's request to play
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only Host executes

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playback] Rejected request-play from non-OP: ${conn?.peer}`);
    return;
  }

  clearManagedTimer('autoPlayTimer');
  const pausedAt = getState('player.pausedAt') || 0;
  const rawTime = Number(data.time);
  const time = (Number.isFinite(rawTime) && rawTime >= 0) ? rawTime : pausedAt;
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const playlistItems = getState('playlist.items') || [];

  // Deselected state (post end-of-playlist): redirect to playTrack(0)
  // rather than resuming stale audio buffer.
  if (currentTrackIndex === -1 && playlistItems.length > 0) {
    void import('./playlist.ts').then(mod => mod.playTrack(0));
    return;
  }

  play(time);
  broadcast({ type: MSG.PLAY, time, index: currentTrackIndex, hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS });
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
  pause();
  broadcast({ type: MSG.PAUSE, time: getState('player.pausedAt') });
}

function handleRequestSeek(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playback] Rejected request-seek from non-OP: ${conn?.peer}`);
    return;
  }

  const time = Number(data.time) || 0;
  const currentState = getState('appState');
  const currentTrackIndex = getState('playlist.currentTrackIndex');

  // YouTube seek
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    bus.emit('youtube:seek-to', time);
    return;
  }

  if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
    play(time);
    broadcast({ type: MSG.PLAY, time, index: currentTrackIndex, hostPlayAt: getHostNow() + SCHEDULE_AHEAD_MS });
  } else {
    setState('player.pausedAt', time);
    const videoElement = getVideoElement();
    if (videoElement) try { videoElement.currentTime = time; } catch { /* noop */ }
    broadcast({ type: MSG.PAUSE, time });
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

  // Video sync timer tick
  bus.on('worker:timer-tick', (id) => {
    if (id === 'video-sync') checkVideoSync();
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
    if (!(getCurrentAudioBuffer() || getVideoElement()?.src)) return;

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
      pause(0);
      setManagedTimer('playback-replay-defer', doReplay, delayMs);
    } else {
      doReplay();
    }
  });

  // 'sync:get-position' and 'sync:response' listeners removed — no emitter exists

  // Disconnect playerNode from surround splitter (called when surround mode turns off)
  bus.on('audio:disconnect-surround', () => {
    const _playerNode = getPlayerNode();
    if (_playerNode) {
      try { _playerNode.disconnect(getSurroundSplitter()!); } catch { /* may not be connected */ }
    }
  });

  // Surround mode toggled during playback: restart at current position
  bus.on('audio:surround-toggled', () => {
    const currentState = getState('appState');
    if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
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

  // OPFS file ready: finalize guest download processing
  bus.on('opfs:file-ready', async (filename, _sessionId, isPreload) => {
    if (isPreload) {
      // Preload files are handled by preload module via storage:preload-file-ready
      bus.emit('storage:preload-file-ready', filename, _sessionId);
      return;
    }

    // Only guest processes OPFS files (Host loads directly)
    const hostConn = getState('network.hostConn');
    if (!hostConn) return;

    const file = await readFileFromOpfs(filename, false);
    if (!file) {
      log.error('[Playback] Failed to read OPFS file:', filename);
      showLoader(false);
      return;
    }

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

    setState('transfer.skipIncomingFile', true);
    setState('transfer.waitingForPreload', true);

    // Try to activate immediately if blob is already available
    const nextFileBlob = getState('preload.nextFileBlob');
    if (nextFileBlob) {
      setState('transfer.waitingForPreload', false);
      const newToken = incrementLoadToken();
      loadPreloadedTrack(index, newToken);
    } else {
      // Blob not ready yet — set progress-aware watchdog. Will be triggered
      // by opfs:file-ready → storage:preload-file-ready → use-preloaded re-emit.
      log.debug('[Playback] Preload blob not ready yet, waiting...');

      // Approach B: progress-aware watchdog
      // ────────────────────────────────────
      // The host now serializes preload transfers, so an in-progress preload
      // WILL finalize naturally — we just need to wait for it. Fixed 10s was
      // too short for larger tracks over slower networks, forcing a needless
      // 0%-restart recovery. Instead, wait up to 60s total but reset the
      // timer each time the preload session makes progress (nextExpectedChunk
      // increments). If progress stalls for 10s straight, give up and recover.
      const PRELOAD_WATCHDOG_MAX_MS = 60_000;    // absolute ceiling
      const PRELOAD_WATCHDOG_STALL_MS = 10_000;  // no-progress timeout
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
        if (!getState('transfer.waitingForPreload')) return;
        log.warn('[Preload] Preloaded blob not available — stall timeout');
        setState('transfer.waitingForPreload', false);
        setState('transfer.skipIncomingFile', false);
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

      // Clear watchdog if blob arrives in time (waitingForPreload set to false)
      const _unsubWatchdog = bus.on('state:transfer.waitingForPreload', (val: unknown) => {
        if (val === false) cleanup();
      });

      // Progress-aware reset: watch preload.sessionState changes. When the
      // session matching our track advances its nextExpectedChunk, reset the
      // stall timer. Respect the absolute ceiling to prevent runaway waits.
      const _unsubProgress = bus.on('state:preload.sessionState', () => {
        if (disposed) return;
        if (!getState('transfer.waitingForPreload')) return;

        // Absolute ceiling — give up even if progress is still happening
        if (Date.now() - watchdogStart > PRELOAD_WATCHDOG_MAX_MS) {
          log.warn('[Preload] Absolute watchdog ceiling reached');
          onWatchdogFire();
          return;
        }

        const sessionState = getState('preload.sessionState');
        for (const [, session] of sessionState) {
          if (session.skipped || session.finalized) continue;
          if (session.index !== index && session.name !== name) continue;
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
      } else if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO) {
        const item = (playlist[currentTrackIndex] as unknown as Record<string, unknown>) || {};
        const itemName = (item.name || (item.file as File | undefined)?.name || null) as string | null;
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
        });
      }
      // YouTube state is handled by youtube/player.ts bootstrap
      log.debug('[Playback] Bootstrap: sent playback state to new peer');
    } catch (e) {
      log.warn('[Playback] Bootstrap send failed:', e);
    }
  });

  // Host: Send current file after orchestrator evaluation (isDataTarget is now set)
  bus.on('orchestrator:peer-evaluated', (peerId: string) => {
    const hostConn = getState('network.hostConn');
    if (hostConn) return; // Only Host

    const peers = getState('network.connectedPeers') || [];
    const peer = peers.find(p => p.id === peerId);
    if (!peer || !peer.isDataTarget) return; // Remote/relay peer — no direct file send
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
          log.debug(`[Playback] Sending current file to late-joiner ${peer.label || peerId} (post-ICE)`);
          unicastFile(conn, currentFileBlob, 0, currentSessionId)
            .catch((e: unknown) => log.error('[Host] unicastFile for late joiner failed', e));
        }

        // Also send preloaded next track
        const nextFileBlob = getState('preload.nextFileBlob');
        const nextMeta = getState('preload.meta');
        const nextTrackIndex = getState('preload.nextTrackIndex');
        if (nextFileBlob && nextMeta && nextTrackIndex >= 0) {
          const preloadSid = (nextMeta.sessionId as number) || 0;
          unicastPreload(conn, nextFileBlob, nextTrackIndex, preloadSid)
            .catch((e: unknown) => log.error('[Host] unicastPreload for late joiner failed', e));
        }
      }
    }
  });

  log.info('[Playback] Engine initialized');
}
