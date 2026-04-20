/**
 * MUSIXQUARE — File Loading & Decoding
 *
 * Manages: loadAndBroadcastFile (host), loadPreloadedTrack (guest),
 * finalizeGuestFile, clearPreviousTrackState.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE, TRANSFER_STATE, DEMO_FILE_NAME } from '../core/constants.ts';
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
  getPendingPlayTime, setPendingPlayTime, getPendingPlayTimeAge,
  setPlayPreloadedInProgress,
  getLastClearedTrackName, setLastClearedTrackName,
  replaceLoadScope,
  markTrackFailed, isTrackFailed, clearFailedTracks,
  getTrackKeyFromFile, getTrackKeyFromItem,
} from './_state.ts';

import { play, stopAllMedia, stopPlayerNode, setAppState } from './transport.ts';

import { getAudioContext, ensureRunning } from '../audio/context.ts';
import { showToast, showLoader } from '../ui/toast.ts';
import { transition } from './lifecycle.ts';

// ─── Decode Timeout Helper ─────────────────────────────────────────
// 10s is a generous upper bound for legitimate audio/video decoding. Normal
// MP3/AAC decodes in <500ms; lossless FLAC in a few seconds; even a 30-hour
// podcast decodes fine because the browser streams-decodes. What DOES fall
// into the timeout bucket: pathological bitrates (e.g., 50,000 kbps WAV),
// corrupt headers, or codec/container mismatches that cause the decoder to
// hang. In those cases we'd rather skip than freeze the tab.

const DECODE_TIMEOUT_MS = 10_000;
const DECODE_TIMEOUT_TAG = '__decode_timeout__';

async function decodeWithTimeout(
  arrayBuffer: ArrayBuffer,
  label = 'decode'
): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    // One-shot timeout race for decodeAudioData; cleared in finally below.
    // setManagedTimer is name-keyed and not suited for per-call concurrent decodes.
    // eslint-disable-next-line no-restricted-globals
    timeoutId = setTimeout(() => {
      reject(new Error(`${DECODE_TIMEOUT_TAG}:${label}:${DECODE_TIMEOUT_MS}ms`));
    }, DECODE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([ctx.decodeAudioData(arrayBuffer), timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function isDecodeTimeout(err: unknown): boolean {
  return err instanceof Error && err.message.includes(DECODE_TIMEOUT_TAG);
}

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

  // Lifecycle: host has the file locally (no download phase). Transition
  // straight into DECODING so the subsequent transition(DECODE_SUCCESS)
  // after decode completes lands cleanly on READY rather than being
  // rejected from IDLE/PLAYING. The `preload-match` variant captures
  // "blob is ready, promote to decoding" which matches host semantics.
  {
    const trackIdx = getState('playlist.currentTrackIndex');
    transition({
      type: 'FILE_PREPARE',
      variant: 'preload-match',
      index: typeof trackIdx === 'number' ? Math.max(0, trackIdx) : 0,
      name: file.name,
    });
  }

  try {
    await initAudio();
    if (getAudioContext().state === 'suspended') await ensureRunning();

    // Create blob URL eagerly for video element; actual state publication
    // of files.currentFileBlob is deferred until AFTER decode succeeds so
    // that (files.currentFileBlob, transfer.meta) are always published as
    // an atomic pair. Previously, blob was set pre-decode and meta post-
    // decode — a recovery request arriving in the intervening async window
    // would resolve to currentFileBlob with the PREVIOUS track's meta,
    // causing recovery.ts findMatchingBlob() to match the wrong file or
    // fall through its no-hint branch with stale metadata.
    const url = BlobURLManager.create(file) || '';

    log.debug('[BufferMode] Decoding audio for high-precision sync...');
    showToast(t('toast.hprecision_sync'));

    // Decode audio (with 10s timeout to avoid hanging on pathological files)
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await decodeWithTimeout(arrayBuffer, 'host-load');

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

    // Lifecycle (Phase 3 dual-write): host-side decode completed → READY.
    // Host is also a guest-of-itself for this machine; transition() is a
    // no-op in non-audio modes (guards inside the helper).
    transition({ type: 'DECODE_SUCCESS' });

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
    // Atomic publish: meta first, then blob — both in the same synchronous
    // tick so any subscriber (e.g. recovery.ts findMatchingBlob) always
    // sees them in sync. Order is meta→blob so a reader that checks blob
    // first and then meta can never observe "blob set, meta still stale".
    setState('transfer.meta', { name: file.name, type: file.type, index: currentTrackIndex });
    setState('files.currentFileBlob', file);


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

    const timedOut = isDecodeTimeout(err);
    // Lifecycle (Phase 3 dual-write): decode failed → FAILED. markTrackFailed
    // below handles the failed-set; the state machine distinguishes only
    // "decoded OK vs decode failed" here, so the timeout/error variants
    // share the same transition.
    transition({ type: timedOut ? 'DECODE_TIMEOUT' : 'DECODE_ERROR' });
    showToast(
      timedOut
        ? t('error.decode_timeout', { name: file.name })
        : t('error.load_failed', { msg: (err as Error).message })
    );

    // Auto-advance to the next playable track (host only — guests follow host).
    // We only do this on the host side; guests receive the next FILE_START from
    // the host after host itself advances, so guests don't need independent skip.
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      const failedIdx = getState('playlist.currentTrackIndex');
      const playlist = getState('playlist.items') || [];

      if (failedIdx >= 0 && playlist.length > 1) {
        // Key by the file itself, not by index. This way, if the user reorders
        // or removes tracks after a failure, the "failed" memory stays attached
        // to the actual bad file rather than a now-stale slot number.
        const failedKey = getTrackKeyFromFile(file) ?? getTrackKeyFromItem(playlist[failedIdx]);
        markTrackFailed(failedKey);

        // Count playable (non-failed) tracks remaining. If none, stop.
        const playableCount = playlist.reduce(
          (n, item) => n + (isTrackFailed(getTrackKeyFromItem(item)) ? 0 : 1),
          0
        );
        if (playableCount === 0) {
          showToast(t('error.all_tracks_failed'));
          clearFailedTracks();
        } else {
          // Walk order candidates in priority:
          //   (1) preloaded next — preserves shuffle intent when host already
          //       staged the shuffle-next, and avoids wasting the preload
          //   (2) shuffle — random non-failed (when shuffle ON)
          //   (3) sequential — (failedIdx + 1) % length (when shuffle OFF)
          const isShuffle = getState('playlist.isShuffle');
          const preloadIdx = getState('preload.nextTrackIndex');

          const isGoodCandidate = (i: number): boolean =>
            i >= 0 && i < playlist.length && i !== failedIdx &&
            !isTrackFailed(getTrackKeyFromItem(playlist[i]));

          let nextIdx = -1;

          // (1) preloaded next (matches what playNextTrack would pick)
          if (isGoodCandidate(preloadIdx)) {
            nextIdx = preloadIdx;
          }

          // (2) shuffle — pick a random non-failed track
          if (nextIdx === -1 && isShuffle) {
            const pool: number[] = [];
            for (let i = 0; i < playlist.length; i++) {
              if (isGoodCandidate(i)) pool.push(i);
            }
            if (pool.length > 0) {
              nextIdx = pool[Math.floor(Math.random() * pool.length)];
            }
          }

          // (3) sequential fallback (also used for non-shuffle)
          if (nextIdx === -1) {
            for (let probe = 1; probe <= playlist.length; probe++) {
              const candidate = (failedIdx + probe) % playlist.length;
              if (isGoodCandidate(candidate)) {
                nextIdx = candidate;
                break;
              }
            }
          }

          if (nextIdx !== -1) {
            setManagedTimer('decode-fail-advance', () => {
              // Dynamic import to avoid a static cycle with playlist.ts
              import('./playlist.ts').then(({ playTrack }) => playTrack(nextIdx));
            }, 600);
          }
        }
      }
    }
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
    const audioBuffer = await decodeWithTimeout(arrayBuffer, 'preload');

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

    // Guest: refresh track title from playlist — finalizeGuestFile sets this
    // on the P2P download path, but the preload/demo path never did, leaving
    // the UI stuck on the previous track's title.
    const hostConn = getState('network.hostConn');
    if (hostConn) {
      const playlist = getState('playlist.items') || [];
      if (playlist[targetIndex]) {
        setState('player.currentTrackMeta', playlist[targetIndex]);
      }
    }

    // Lifecycle (Phase 3 dual-write): preload blob decoded → READY.
    transition({ type: 'DECODE_SUCCESS' });

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
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('preloadWatchdog');

    // Auto-sync after settle
    if (hostConn?.open) {
      setManagedTimer('playback-preload-auto-sync', () => {
        log.debug('[Guest] Post-preload auto-sync');
        bus.emit('sync:auto-sync');
      }, 500);
    }
    setPlayPreloadedInProgress(false);
    showLoader(false);

    // Consume pending play time — compensate for elapsed wall clock so the
    // guest doesn't resume at the host's past position (remote-demo HTTP
    // fetch can take several seconds during which the host keeps playing).
    const localOffset = getState('sync.localOffset') || 0;
    const pendingTime = getPendingPlayTime();
    if (hostConn && pendingTime !== undefined) {
      const age = getPendingPlayTimeAge();
      let target = pendingTime + age + localOffset;

      // Wrap target time for demo tracks to avoid seeking past the end (silence)
      if (localMeta?.name === DEMO_FILE_NAME && audioBuffer.duration > 0) {
        target = target % audioBuffer.duration;
      }

      log.info(`[Preload] Activating demo/preload playback at ${target.toFixed(1)}s (age=${age.toFixed(1)}s)`);
      play(target);
      setPendingPlayTime(undefined);
    } else {
      log.info('[Preload] No pending play time, staying in READY state');
    }

    showLoader(false);

  } catch (e: unknown) {
    setPlayPreloadedInProgress(false);
    setPendingPlayTime(undefined);
    log.error('[Preload] Activation failed:', e);
    showLoader(false);

    const timedOut = isDecodeTimeout(e);
    const meta = getState('transfer.meta');
    const name = (meta?.name as string) || '';
    // Lifecycle (Phase 3 dual-write): preload decode failed → FAILED.
    transition({ type: timedOut ? 'DECODE_TIMEOUT' : 'DECODE_ERROR' });
    showToast(
      timedOut
        ? t('error.decode_timeout', { name })
        : t('transfer.preload_fail')
    );

    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
    setState('transfer.skipIncomingFile', false);
    clearManagedTimer('preloadWatchdog');

    // On decode timeout, the file itself is unplayable — asking host for a
    // recovery copy would just re-trigger the same timeout. Skip recovery and
    // wait for host to advance to the next track on its own.
    //
    // Also mark the track as failed so that a subsequent manual click on the
    // same entry (while still in this session) doesn't re-run the 10s timeout
    // loop. The failed-set is keyed by file identity (name+size+lastModified)
    // so uploading a different file with the same playlist slot still retries.
    if (timedOut) {
      const failedKey = getTrackKeyFromFile(localBlob);
      markTrackFailed(failedKey);
      return;
    }

    // Non-timeout failure (e.g. partial download, network error) — request
    // recovery from host. Recovery path has its own retry ceiling so this
    // won't infinite-loop.
    const playlist = getState('playlist.items') || [];
    const idx = getState('playlist.currentTrackIndex');
    const recoveryName = (playlist[idx] as unknown as Record<string, string>)?.name || name;
    sendToHost({ type: MSG.REQUEST_CURRENT_FILE, name: recoveryName, index: idx, reason: 'preload_activation_failed' });
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
  // Note: stale-audio-recovery timer was deleted in Phase 4. Left a
  // clearManagedTimer here would be a no-op, so we drop it.

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
  // Guard: if the app has switched to YouTube mode mid-transfer, abort the
  // finalize path. Otherwise setEngineMode('buffer') would kill the iframe
  // and currentTrackMeta would attach the YouTube track's metadata to the
  // file blob. (Primary defence is in handleYouTubePlay cancelling the
  // transfer, this is a belt-and-suspenders second layer.)
  if (getState('appState') === APP_STATE.PLAYING_YOUTUBE) {
    log.debug('[Guest] finalizeGuestFile aborted — app switched to YouTube mode');
    setState('transfer.state', TRANSFER_STATE.IDLE);
    setState('transfer.skipIncomingFile', true);
    showLoader(false);
    return;
  }

  log.debug('[Guest] Finalizing with Buffer Mode...');
  const myLoadId = incrementLoadSessionId();
  showLoader(true, t('error.audio_memory'));

  try {
    await initAudio();
    if (getAudioContext().state === 'suspended') await ensureRunning();

    const arrayBuffer = await file.arrayBuffer();
    if (getActiveLoadSessionId() !== myLoadId) { log.debug('[Guest] Stale finalize (pre-decode), aborting'); return; }
    const audioBuffer = await decodeWithTimeout(arrayBuffer, 'guest-finalize');
    if (getActiveLoadSessionId() !== myLoadId) { log.debug('[Guest] Stale finalize (post-decode), aborting'); return; }

    if (getCurrentAudioBuffer()) {
      setCurrentAudioBuffer(null);
    }
    setCurrentAudioBuffer(audioBuffer);

    // Lifecycle (Phase 3 dual-write): main-transfer file decoded → READY.
    transition({ type: 'DECODE_SUCCESS' });

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

    // Set track metadata from playlist (missing in download path — fixes title display)
    const hostConn = getState('network.hostConn');
    if (hostConn) {
      const playlist = getState('playlist.items') || [];
      const idx = getState('playlist.currentTrackIndex');
      if (playlist[idx]) {
        setState('player.currentTrackMeta', playlist[idx]);
      }
    }

    // Consume pending play time — compensate for elapsed wall clock so the
    // guest doesn't resume at the host's past position after a slow decode.
    const pendingTime = getPendingPlayTime();
    if (hostConn && pendingTime !== undefined) {
      const localOffset = getState('sync.localOffset') || 0;
      const age = getPendingPlayTimeAge();
      const target = pendingTime + age + localOffset;
      log.debug(`[Guest] Pending play at ${target.toFixed(1)}s (age=${age.toFixed(1)}s)`);
      play(target);
      setPendingPlayTime(undefined);
    }

    // Force sync handled by sync.ts state:appState listener (1s delayed reset)

    bus.emit('ui:play-btn-state', true);
  } catch (err: unknown) {
    log.error('[Guest] Decoding failed', err);

    const timedOut = isDecodeTimeout(err);
    const meta = getState('transfer.meta');
    const name = (meta?.name as string) || '';
    // Lifecycle (Phase 3 dual-write): guest main-transfer decode failed → FAILED.
    transition({ type: timedOut ? 'DECODE_TIMEOUT' : 'DECODE_ERROR' });
    showToast(
      timedOut
        ? t('error.decode_timeout', { name })
        : t('error.audio_decode_fail')
    );

    // Reset transfer state so recovery can start fresh (prevents infinite loop)
    setState('transfer.state', TRANSFER_STATE.IDLE);
    setState('transfer.receivedCount', 0);

    // On decode timeout, the file is genuinely unplayable — recovery would
    // re-fetch the same bad bytes and time out again. Skip recovery and wait
    // for the host to advance to the next track.
    if (timedOut) return;

    // Use recovery with retry limit (3 attempts + backoff) instead of unlimited sendToHost
    sendRecoveryRequest(0);
  } finally {
    showLoader(false);
  }
}
