/**
 * MUSIXQUARE 3.0 — File Loading & Decoding
 *
 * Manages: loadAndBroadcastFile (host), loadPreloadedTrack (guest),
 * finalizeGuestFile, clearPreviousTrackState.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE, TRANSFER_STATE } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { BlobURLManager } from '../core/blob-manager.ts';
import { initAudio } from '../audio/engine.ts';
import { getVideoElement, isMediaVideo, setEngineMode } from './video.ts';
import { postWorkerCommand, cleanupOPFSInWorker } from '../storage/opfs.ts';
import { broadcastFile } from '../storage/transfer.ts';
import { schedulePreload } from '../storage/preload.ts';
import { sendToHost } from '../network/peer.ts';
import { sendRecoveryRequest } from '../storage/recovery.ts';

import {
  getCurrentAudioBuffer, setCurrentAudioBuffer,
  getLoadToken,
  getActiveLoadSessionId, incrementLoadSessionId,
  getPendingPlayTime, setPendingPlayTime,
  setPlayPreloadedInProgress,
  getLastClearedTrackName, setLastClearedTrackName,
  replaceLoadScope,
} from './_state.ts';

import { play, stopAllMedia, stopPlayerNode, setAppState } from './transport.ts';

import { getAudioContext, ensureRunning } from '../audio/context.ts';
import { showToast, showLoader } from '../ui/toast.ts';

// ─── Load And Broadcast File (Host) ────────────────────────────────

export async function loadAndBroadcastFile(
  file: File,
  sessionId: number | null = null,
  loadToken?: number,
): Promise<void> {
  const myLoadId = incrementLoadSessionId();
  replaceLoadScope();
  const myToken = loadToken ?? getLoadToken();

  showLoader(true, t('toast.preparing', { name: file.name }));
  stopAllMedia({ silent: true });

  try {
    await initAudio();
    if (getAudioContext().state === 'suspended') await ensureRunning();

    const url = BlobURLManager.create(file) || '';
    setState('files.currentFileBlob', file);

    log.debug('[BufferMode] Decoding audio for high-precision sync...');
    showToast(t('toast.hprecision_sync'));

    // Decode audio
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer);

    // Re-verify after async decode
    if (loadToken !== undefined && getLoadToken() !== myToken) {
      if (myLoadId === getActiveLoadSessionId()) {
        log.warn('[Load] Token mismatch after decode. Aborting stale load.');
        showLoader(false);
      }
      return;
    }

    // Dispose old buffer
    if (getCurrentAudioBuffer()) {
      setCurrentAudioBuffer(null);
    }

    if (myLoadId !== getActiveLoadSessionId()) {
      log.debug('[Load] Stale loading session detected. Aborting.');
      return;
    }

    // Load into state
    setCurrentAudioBuffer(audioBuffer);
    log.debug(`[BufferMode] Loaded ${audioBuffer.duration.toFixed(2)}s into RAM.`);

    // Emit duration immediately from decoded buffer (primary source)
    if (audioBuffer.duration && Number.isFinite(audioBuffer.duration)) {
      bus.emit('ui:duration-update', audioBuffer.duration);
    }

    // Visual sync
    const videoElement = getVideoElement();
    if (videoElement) {
      videoElement.src = url;
      videoElement.muted = true;
    }

    const currentTrackIndex = getState('playlist.currentTrackIndex');
    setState('transfer.meta', { name: file.name, type: file.type, index: currentTrackIndex });


    if (videoElement) {
      const cleanupMeta = () => {
        videoElement.removeEventListener('loadedmetadata', onMetaLoaded);
        videoElement.removeEventListener('error', onMetaError);
      };
      const onMetaLoaded = () => {
        cleanupMeta();
        if (myLoadId !== getActiveLoadSessionId()) return;
        const dur = getCurrentAudioBuffer() ? getCurrentAudioBuffer()!.duration : videoElement.duration;
        if (dur && Number.isFinite(dur)) {
          bus.emit('ui:duration-update', dur);
        }
        BlobURLManager.confirm();
      };
      const onMetaError = () => {
        cleanupMeta();
        log.warn('[Playback] Video loadedmetadata failed — confirming blob URL');
        BlobURLManager.confirm();
      };
      videoElement.addEventListener('loadedmetadata', onMetaLoaded, { once: true });
      videoElement.addEventListener('error', onMetaError, { once: true });
      videoElement.load();
    } else {
      BlobURLManager.confirm();
    }

    // Enable play button
    const hostConn = getState('network.hostConn');
    const isOperator = getState('network.isOperator');
    bus.emit('ui:play-btn-state', !(hostConn && !isOperator));

    // Broadcast file to peers
    const connectedPeers = getState('network.connectedPeers') || [];
    if (connectedPeers.length > 0 && sessionId !== null) {
      showToast(t('transfer.file_sending'));
      broadcastFile(file, sessionId)
        .catch(e => log.error('[Host] broadcastFile failed:', e));
    }

    if (!hostConn) {
      schedulePreload();
    }
  } catch (err: unknown) {
    log.error(err);
    // Clear corrupt/stale blob so recovery doesn't re-serve it to guests
    setState('files.currentFileBlob', null);
    showToast(`Load Failed: ${(err as Error).message}`);
  } finally {
    if (myLoadId === getActiveLoadSessionId()) {
      showLoader(false);
      setState('player.pausedAt', 0);
    }

    const hostConn = getState('network.hostConn');
    const isOperator = getState('network.isOperator');
    bus.emit('ui:play-btn-state', !hostConn || isOperator);
  }
}

// ─── Load Preloaded Track ──────────────────────────────────────────

export async function loadPreloadedTrack(
  expectedIndex?: number,
  loadToken?: number,
): Promise<void> {
  replaceLoadScope();
  const nextMeta = getState('preload.meta');
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const targetIndex = expectedIndex ?? (nextMeta?.index as number) ?? currentTrackIndex;
  const myToken = loadToken ?? getLoadToken();
  const localBlob = getState('preload.nextFileBlob');
  const localMeta = nextMeta ? { ...nextMeta } : null;

  if (!localBlob) {
    log.warn('[Preload] No preloaded blob found in cache!');
    setPendingPlayTime(undefined);
    return;
  }

  setPlayPreloadedInProgress(true);

  try {
    await initAudio();

    if (expectedIndex !== undefined && currentTrackIndex !== -1 && currentTrackIndex !== targetIndex) {
      log.warn(`[Preload] Index mismatch! Expected ${targetIndex}, current is ${currentTrackIndex}. Aborting.`);
      setPlayPreloadedInProgress(false);
      setPendingPlayTime(undefined);
      return;
    }

    // Dispose old buffer
    if (getCurrentAudioBuffer()) {
      setCurrentAudioBuffer(null);
    }

    log.debug('[Preload] Decoding audio for Buffer Mode...');
    showToast(t('toast.decoding_audio'));

    const arrayBuffer = await localBlob.arrayBuffer();
    const audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer);

    // Re-verify after async decode
    if (loadToken !== undefined && getLoadToken() !== myToken) {
      log.warn('[Preload] Token mismatch after decode. Discarding.');
      setPlayPreloadedInProgress(false);
      setPendingPlayTime(undefined);
      return;
    }
    if (expectedIndex !== undefined && currentTrackIndex !== -1 &&
        getState('playlist.currentTrackIndex') !== targetIndex) {
      log.warn('[Preload] Track changed during decode. Discarding.');
      setPlayPreloadedInProgress(false);
      setPendingPlayTime(undefined);
      return;
    }

    const activeMeta = localMeta || getState('transfer.meta');

    // Update global state
    setState('files.currentFileBlob', localBlob);
    setState('transfer.meta', activeMeta);
    setCurrentAudioBuffer(audioBuffer);
    log.debug(`[BufferMode] Preloaded ${audioBuffer.duration.toFixed(2)}s decoded.`);

    const isVideo = isMediaVideo(localBlob, activeMeta);
    setEngineMode(isVideo ? 'video' : 'buffer');

    // Visual sync
    const url = BlobURLManager.create(localBlob) || '';
    const videoElement = getVideoElement();
    if (videoElement) {
      videoElement.src = url;
      videoElement.muted = true;
    }

    const dur = audioBuffer.duration;
    if (Number.isFinite(dur)) {
      bus.emit('ui:duration-update', dur);
    }
    BlobURLManager.confirm();

    if (videoElement) videoElement.load();

    // Clear preload state
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
    log.debug('[Preload] Safe clear: nextFileBlob moved to current.');

    // Reset transfer guards — transfer.state must be READY so next preload loader shows
    setState('transfer.state', 'READY');
    setState('transfer.skipIncomingFile', true);
    setState('transfer.waitingForPreload', false);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('preloadWatchdog');

    // Auto-sync after settle
    const hostConn = getState('network.hostConn');
    if (hostConn?.open) {
      setManagedTimer('playback-preload-auto-sync', () => {
        log.debug('[Guest] Post-preload auto-sync');
        bus.emit('sync:auto-sync');
      }, 500);
    }

    setPlayPreloadedInProgress(false);

    // Consume pending play time
    const localOffset = getState('sync.localOffset') || 0;
    const pendingTime = getPendingPlayTime();
    if (hostConn && pendingTime !== undefined) {
      const target = pendingTime + localOffset;
      log.debug(`[Preload] Pending play at ${target.toFixed(1)}s`);
      play(target);
      setPendingPlayTime(undefined);
    }

  } catch (e: unknown) {
    setPlayPreloadedInProgress(false);
    setPendingPlayTime(undefined);
    log.error('[Preload] Activation failed:', e);
    showLoader(false);
    showToast(t('transfer.preload_fail'));

    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
    setState('transfer.skipIncomingFile', false);
    setState('transfer.waitingForPreload', false);
    clearManagedTimer('preloadWatchdog');

    // Request recovery from host
    const playlist = getState('playlist.items') || [];
    const meta = getState('transfer.meta');
    const idx = getState('playlist.currentTrackIndex');
    const name = (playlist[idx] as unknown as Record<string, string>)?.name || (meta?.name as string) || '';
    sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name, index: idx, reason: 'preload_activation_failed' });
  }
}

// ─── Clear Previous Track State ────────────────────────────────────

export function clearPreviousTrackState(reason = ''): void {
  log.debug(`[State Clear] Clearing previous track state. Reason: ${reason}`);

  // Edge Case: skip redundant clears for same track
  const playlist = getState('playlist.items') || [];
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const meta = getState('transfer.meta');
  const trackName = playlist[currentTrackIndex]?.name || (meta?.name as string) || '';
  if (reason === 'redundant-sync' && trackName && getLastClearedTrackName() === trackName) {
    log.debug(`[State Clear] Skipping redundant clear for: ${trackName}`);
    return;
  }
  setLastClearedTrackName(trackName);

  // Stop timers
  clearManagedTimer('chunkWatchdog');
  clearManagedTimer('prepareWatchdog');
  clearManagedTimer('stale-audio-recovery');

  // Redundant sync: only reset timers and name tracking, keep audio buffer intact
  if (reason === 'redundant-sync') return;

  // Reset transfer state
  setState('transfer.receivedCount', 0);
  setState('transfer.meta', {});
  setState('files.currentFileBlob', null);

  // CRITICAL: Clear audio buffer to prevent previous track from replaying
  if (getCurrentAudioBuffer()) {
    log.debug('[State Clear] Clearing currentAudioBuffer');
    setCurrentAudioBuffer(null);
  }
  stopPlayerNode();
  setState('transfer.skipIncomingFile', false);

  // Don't clear pendingPlayTime for 'new-session-start' — late-join flow sends
  // PLAY bootstrap (which sets pendingPlayTime) BEFORE FILE_START arrives.
  // Clearing it here would prevent the guest from auto-playing at the correct position.
  // For 'file-prepare' / 'session-change', PLAY arrives AFTER the clear, so it's safe.
  if (reason !== 'new-session-start') {
    setPendingPlayTime(undefined);
  }

  // Reset state to IDLE
  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PLAYING_VIDEO || currentState === APP_STATE.PAUSED) {
    setAppState(APP_STATE.IDLE);
  }

  // Clear preload ack tracking (immutable — replace with new Set)
  setState('preload.ackSent', new Set());

  BlobURLManager.revoke();

  const videoElement = getVideoElement();
  if (videoElement) {
    videoElement.pause();
    videoElement.removeAttribute('src');
    videoElement.load();
  }
  try { BlobURLManager.flushDeferred('clearPreviousTrackState'); } catch { /* noop */ }

  // Physically delete OLD current file from OPFS
  const opfsFilename = getState('files.currentFileOpfs');
  if (opfsFilename?.name) {
    const nextMeta = getState('preload.meta');
    const isActuallyChanging = opfsFilename.name !== nextMeta?.name;
    if (isActuallyChanging) {
      postWorkerCommand({ command: 'OPFS_RESET', isPreload: false });
      cleanupOPFSInWorker(opfsFilename.name, false);
      setState('files.currentFileOpfs', { name: null });
    }
  }
}

// ─── Finalize Guest File (after OPFS download) ────────────────────

export async function finalizeGuestFile(file: File | Blob): Promise<void> {
  log.debug('[Guest] Finalizing with Buffer Mode...');
  const myLoadId = incrementLoadSessionId();
  showLoader(true, t('error.audio_memory'));

  try {
    await initAudio();
    if (getAudioContext().state === 'suspended') await ensureRunning();

    const arrayBuffer = await file.arrayBuffer();
    if (getActiveLoadSessionId() !== myLoadId) { log.debug('[Guest] Stale finalize (pre-decode), aborting'); return; }
    const audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer);
    if (getActiveLoadSessionId() !== myLoadId) { log.debug('[Guest] Stale finalize (post-decode), aborting'); return; }

    if (getCurrentAudioBuffer()) {
      setCurrentAudioBuffer(null);
    }
    setCurrentAudioBuffer(audioBuffer);

    // Set blob BEFORE setEngineMode so updateBodyModeClass reads the correct file
    setState('files.currentFileBlob', file);

    const meta = getState('transfer.meta');
    const isVideo = isMediaVideo(file, meta);
    setEngineMode(isVideo ? 'video' : 'buffer');

    const url = BlobURLManager.create(file) || '';
    const videoElement = getVideoElement();
    if (videoElement) {
      videoElement.src = url;
      videoElement.muted = true;
    }

    if (audioBuffer.duration && Number.isFinite(audioBuffer.duration)) {
      bus.emit('ui:duration-update', audioBuffer.duration);
    }
    BlobURLManager.confirm();

    if (videoElement) {
      const cleanupMeta = () => {
        videoElement.removeEventListener('loadedmetadata', onMetaLoaded);
        videoElement.removeEventListener('error', onMetaError);
      };
      const onMetaLoaded = () => {
        cleanupMeta();
        const dur = getCurrentAudioBuffer() ? getCurrentAudioBuffer()!.duration : videoElement.duration;
        if (dur && Number.isFinite(dur)) bus.emit('ui:duration-update', dur);
      };
      const onMetaError = () => {
        cleanupMeta();
        log.warn('[Guest] Video loadedmetadata failed during finalize');
      };
      videoElement.addEventListener('loadedmetadata', onMetaLoaded, { once: true });
      videoElement.addEventListener('error', onMetaError, { once: true });
      videoElement.load();
    }

    // Reset guards
    setState('transfer.state', TRANSFER_STATE.READY);
    setState('transfer.skipIncomingFile', false);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');

    // Consume pending play time and start playback (position may be stale)
    const hostConn = getState('network.hostConn');
    const pendingTime = getPendingPlayTime();
    if (hostConn && pendingTime !== undefined) {
      const localOffset = getState('sync.localOffset') || 0;
      const target = pendingTime + localOffset;
      log.debug(`[Guest] Pending play at ${target.toFixed(1)}s`);
      play(target);
      setPendingPlayTime(undefined);
    }

    // Force sync after 1s — position is stale from file transfer delay
    if (hostConn?.open) {
      setManagedTimer('force-initial-sync', () => {
        bus.emit('sync:force-initial');
      }, 1000);
    }

    bus.emit('ui:play-btn-state', true);
  } catch (err: unknown) {
    log.error('[Guest] Decoding failed', err);
    showToast(t('error.audio_decode_fail'));

    // Reset transfer state so recovery can start fresh (prevents infinite loop)
    setState('transfer.state', TRANSFER_STATE.IDLE);
    setState('transfer.receivedCount', 0);

    // Use recovery with retry limit (3 attempts + backoff) instead of unlimited sendToHost
    sendRecoveryRequest(0);
  } finally {
    showLoader(false);
  }
}
