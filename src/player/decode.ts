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
import { clearManagedTimer, setManagedTimer, delay } from '../core/timers.ts';
import { BlobURLManager } from '../core/blob-manager.ts';
import { initAudio } from '../audio/engine.ts';
import { setEngineMode } from './video.ts';
import { postWorkerCommand, cleanupOPFSInWorker } from '../storage/opfs.ts';
import { broadcastFileDebounced } from '../storage/transfer.ts';
import type { AnyProtocolMsg } from '../types/index.ts';
import { schedulePreload } from '../storage/preload.ts';
import { sendToHost } from '../network/peer.ts';
import { broadcastSystemNotice } from '../chat/protocol.ts';
import { registerHandlers } from '../network/protocol.ts';
import { sendRecoveryRequest } from '../storage/recovery.ts';
import { isSystemAudioActive } from '../audio/system-capture.ts';
import type { DataConnection } from '../types/index.ts';

import {
  getCurrentAudioBuffer,
  setCurrentAudioBuffer,
  getLoadToken,
  getActiveLoadSessionId,
  incrementLoadSessionId,
  getPendingPlayTime,
  setPendingPlayTime,
  getPendingPlayTimeAge,
  setPlayPreloadedInProgress,
  getLastClearedTrackName,
  setLastClearedTrackName,
  markTrackFailed,
  isTrackFailed,
  clearFailedTracks,
  getTrackKeyFromFile,
  getTrackKeyFromItem,
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

async function decodeWithTimeout(arrayBuffer: ArrayBuffer, label = 'decode'): Promise<AudioBuffer> {
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
  prepareMsg?: AnyProtocolMsg,
): Promise<void> {
  const myLoadId = incrementLoadSessionId();
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
    if (!isSystemAudioActive()) {
      // Don't let audio initialization block the whole activation if it hangs (e.g. autoplay blocked)
      await Promise.race([initAudio(), delay(2000)]);
    }
    if (getAudioContext().state === 'suspended') await ensureRunning();

    // Create blob URL eagerly for video element; actual state publication
    // of files.currentFileBlob is deferred until AFTER decode succeeds so
    // that (files.currentFileBlob, transfer.meta) are always published as
    // an atomic pair. Previously, blob was set pre-decode and meta post-
    // decode — a recovery request arriving in the intervening async window
    // would resolve to currentFileBlob with the PREVIOUS track's meta,
    // causing recovery.ts findMatchingBlob() to match the wrong file or
    // fall through its no-hint branch with stale metadata.
    BlobURLManager.create(file);

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

    const currentTrackIndex = getState('playlist.currentTrackIndex');
    // Atomic publish: meta first, then blob — both in the same synchronous
    // tick so any subscriber (e.g. recovery.ts findMatchingBlob) always
    // sees them in sync. Order is meta→blob so a reader that checks blob
    // first and then meta can never observe "blob set, meta still stale".
    setState('transfer.meta', { name: file.name, type: file.type, index: currentTrackIndex });
    setState('files.currentFileBlob', file);

    BlobURLManager.confirm();

    // Enable play button
    const hostConn = getState('network.hostConn');
    const isOperator = getState('network.isOperator');
    bus.emit('ui:play-btn-state', !(hostConn && !isOperator));

    // Broadcast file to peers (FILE_PREPARE coalesced into the same debounce
    // so guests don't see metadata flicker for tracks the user already left).
    const connectedPeers = getState('network.connectedPeers') || [];
    if (connectedPeers.length > 0 && sessionId !== null) {
      showToast(t('transfer.file_sending'));
      broadcastFileDebounced(file, sessionId, prepareMsg);
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
        : t('error.load_failed', { msg: (err as Error).message }),
    );

    // Auto-advance to the next playable track (host only — guests follow host).
    // We only do this on the host side; guests receive the next FILE_START from
    // the host after host itself advances, so guests don't need independent skip.
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      const failedIdx = getState('playlist.currentTrackIndex');
      markFailedAndAdvance(file, failedIdx);
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

// ─── Host-Side Auto-Advance on Decode Failure ──────────────────────
//
// Called when a track fails to play — either the host's own decode failed in
// loadAndBroadcastFile, or a guest reported decode failure via
// MSG.GUEST_DECODE_FAILED (e.g. iOS Safari can't decode mp4-as-mp3 even
// though host's Chrome can). Marks the track as failed and walks to the next
// playable track via preloaded → shuffle → sequential priority. If no
// playable track remains, returns to IDLE rather than leaving the UI stuck.
//
// Caller must already be on host (hostConn=null) — this function does not
// re-check, since both call sites have host-only guards.
function markFailedAndAdvance(file: File | Blob | null, failedIdx: number): void {
  const playlist = getState('playlist.items') || [];

  if (failedIdx < 0 || playlist.length === 0) return;

  // System notice in the chat: tells everyone in the room why playback is
  // jumping. broadcastSystemNotice handles per-recipient i18n + host-local
  // emit (see chat/protocol.ts).
  broadcastSystemNotice('chat.decode_skip_notice');

  // Key by the file itself when available, so reordering/removing tracks
  // after a failure doesn't strand the "failed" memory on a stale slot.
  // For guest-reported failures the host doesn't have the original File, so
  // fall back to the playlist item's own key.
  const failedKey = getTrackKeyFromFile(file) ?? getTrackKeyFromItem(playlist[failedIdx]);
  markTrackFailed(failedKey);

  // Count playable (non-failed) tracks remaining. If none — including the
  // single-track-failed case (formerly `playlist.length > 1` skipped this
  // path entirely, leaving the iPhone host with one bad track stuck on a
  // toast and no way back to idle) — stop and return to IDLE.
  const playableCount = playlist.reduce(
    (n, item) => n + (isTrackFailed(getTrackKeyFromItem(item)) ? 0 : 1),
    0,
  );
  if (playableCount === 0) {
    showToast(t('error.all_tracks_failed'));
    clearFailedTracks();
    // Without an explicit stop, the play button stays enabled and the user
    // falls back into the same failure cycle on the next click.
    stopAllMedia();
    setAppState(APP_STATE.IDLE);
    return;
  }

  // Walk order candidates in priority:
  //   (1) preloaded next — preserves shuffle intent when host already
  //       staged the shuffle-next, and avoids wasting the preload
  //   (2) shuffle — random non-failed (when shuffle ON)
  //   (3) sequential — (failedIdx + 1) % length (when shuffle OFF)
  const isShuffle = getState('playlist.isShuffle');
  const preloadIdx = getState('preload.nextTrackIndex');

  const isGoodCandidate = (i: number): boolean =>
    i >= 0 &&
    i < playlist.length &&
    i !== failedIdx &&
    !isTrackFailed(getTrackKeyFromItem(playlist[i]));

  let nextIdx = -1;

  if (isGoodCandidate(preloadIdx)) {
    nextIdx = preloadIdx;
  }

  if (nextIdx === -1 && isShuffle) {
    const pool: number[] = [];
    for (let i = 0; i < playlist.length; i++) {
      if (isGoodCandidate(i)) pool.push(i);
    }
    if (pool.length > 0) {
      nextIdx = pool[Math.floor(Math.random() * pool.length)];
    }
  }

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
    // Snapshot the load token at scheduling time. If a user action (track
    // click, next/prev) bumps the token during the 600ms backoff, abort —
    // playTrack already cleared this timer at its entry, but the snapshot
    // guards the timer-fire-vs-clear race (clearManagedTimer just above
    // the new playTrack's increment happens *after* the timer's setTimeout
    // body has already begun executing in some browsers' microtask ordering).
    const advanceToken = getLoadToken();
    setManagedTimer(
      'decode-fail-advance',
      () => {
        if (getLoadToken() !== advanceToken) {
          log.debug(
            '[Decode] Skipping auto-advance — load token bumped (user action superseded)',
          );
          return;
        }
        // Dynamic import to avoid a static cycle with playlist.ts
        import('./playlist.ts').then(({ playTrack }) => playTrack(nextIdx));
      },
      600,
    );
  }
}

// Host-side handler for guest's "I can't decode this track" report. Triggers
// the same advance path the host uses for its own decode failures, so the
// whole room moves on rather than leaving the failing guest in a silent
// recovery loop. Stale reports (host already advanced) are ignored.
function handleGuestDecodeFailed(data: Record<string, unknown>, _conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host acts on this report

  const reportedIdx = data.index as number;
  const currentIdx = getState('playlist.currentTrackIndex');

  if (reportedIdx !== currentIdx) {
    log.debug(
      `[Decode] Stale GUEST_DECODE_FAILED for index ${reportedIdx} (current ${currentIdx})`,
    );
    return;
  }

  log.info(`[Decode] Guest reported decode failure at index ${reportedIdx}, advancing room`);
  markFailedAndAdvance(null, reportedIdx);
}

export function initDecodeHandlers(): void {
  registerHandlers({
    [MSG.GUEST_DECODE_FAILED]: handleGuestDecodeFailed,
  });
}

// ─── Load Preloaded Track ──────────────────────────────────────────

export async function loadPreloadedTrack(
  expectedIndex?: number,
  loadToken?: number,
): Promise<void> {
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
    if (!isSystemAudioActive()) {
      await Promise.race([initAudio(), delay(2000)]);
      if (getAudioContext().state === 'suspended') await ensureRunning();
    }

    if (
      expectedIndex !== undefined &&
      currentTrackIndex !== -1 &&
      currentTrackIndex !== targetIndex
    ) {
      log.warn(
        `[Preload] Index mismatch! Expected ${targetIndex}, current is ${currentTrackIndex}. Aborting.`,
      );
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
    if (
      expectedIndex !== undefined &&
      currentTrackIndex !== -1 &&
      getState('playlist.currentTrackIndex') !== targetIndex
    ) {
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

    setEngineMode('buffer');

    BlobURLManager.create(localBlob);

    const dur = audioBuffer.duration;
    if (Number.isFinite(dur)) {
      bus.emit('ui:duration-update', dur);
    }
    BlobURLManager.confirm();

    // Clear preload state
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
    log.debug('[Preload] Safe clear: nextFileBlob moved to current.');

    // Reset transfer guards — transfer.state must be READY so next preload loader shows.
    // shouldSkipIncomingFile() returns true via the PRELOAD_PROMOTED loadSource
    // branch (lifecycle is READY/PLAYING after this), so no flag needed.
    setState('transfer.state', 'READY');
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('preloadWatchdog');

    // Auto-sync after settle
    if (hostConn?.open) {
      setManagedTimer(
        'playback-preload-auto-sync',
        () => {
          log.debug('[Guest] Post-preload auto-sync');
          bus.emit('sync:auto-sync');
        },
        500,
      );
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

      log.info(
        `[Preload] Activating demo/preload playback at ${target.toFixed(1)}s (age=${age.toFixed(1)}s)`,
      );
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
    showToast(timedOut ? t('error.decode_timeout', { name }) : t('transfer.preload_fail'));

    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
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
    sendToHost({
      type: MSG.REQUEST_CURRENT_FILE,
      name: recoveryName,
      index: idx,
      reason: 'preload_activation_failed',
    });
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

  // Don't clear pendingPlayTime for 'new-session-start' — late-join flow sends
  // PLAY bootstrap (which sets pendingPlayTime) BEFORE FILE_START arrives.
  // Clearing it here would prevent the guest from auto-playing at the correct position.
  // For 'file-prepare' / 'session-change', PLAY arrives AFTER the clear, so it's safe.
  if (reason !== 'new-session-start') {
    setPendingPlayTime(undefined);
  }

  // Reset state to IDLE
  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_AUDIO || currentState === APP_STATE.PAUSED) {
    setAppState(APP_STATE.IDLE);
  }

  // Clear preload ack tracking (immutable — replace with new Set)
  setState('preload.ackSent', new Set());

  BlobURLManager.revoke();

  try {
    BlobURLManager.flushDeferred('clearPreviousTrackState');
  } catch {
    /* noop */
  }

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
    // shouldSkipIncomingFile() returns true via the appState check.
    setState('transfer.state', TRANSFER_STATE.IDLE);
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
    if (getActiveLoadSessionId() !== myLoadId) {
      log.debug('[Guest] Stale finalize (pre-decode), aborting');
      return;
    }
    const audioBuffer = await decodeWithTimeout(arrayBuffer, 'guest-finalize');
    if (getActiveLoadSessionId() !== myLoadId) {
      log.debug('[Guest] Stale finalize (post-decode), aborting');
      return;
    }

    if (getCurrentAudioBuffer()) {
      setCurrentAudioBuffer(null);
    }
    setCurrentAudioBuffer(audioBuffer);

    // Lifecycle (Phase 3 dual-write): main-transfer file decoded → READY.
    transition({ type: 'DECODE_SUCCESS' });

    setState('files.currentFileBlob', file);
    setEngineMode('buffer');

    BlobURLManager.create(file);

    if (audioBuffer.duration && Number.isFinite(audioBuffer.duration)) {
      bus.emit('ui:duration-update', audioBuffer.duration);
    }
    BlobURLManager.confirm();

    // Reset guards
    setState('transfer.state', TRANSFER_STATE.READY);
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
    showToast(timedOut ? t('error.decode_timeout', { name }) : t('error.audio_decode_fail'));

    // Reset transfer state so recovery can start fresh (prevents infinite loop)
    setState('transfer.state', TRANSFER_STATE.IDLE);
    setState('transfer.receivedCount', 0);

    // Per-track decode failure counter. The first non-timeout failure may be
    // a rare chunk-loss case that recovery's re-fetch can fix. The second
    // (or any timeout) means the file is genuinely undecodable on this
    // device — iOS Safari can't decode mp4-as-mp3 even though host's
    // Chrome can. Loop-on-fail without this counter would re-fetch + re-fail
    // until recovery exhausted (3 retries) and then silently hang in FAILED
    // forever, with the host none the wiser. Tell host so the room advances.
    const failureCount = (getState('player.decodeFailureCount') || 0) + 1;
    setState('player.decodeFailureCount', failureCount);

    if (timedOut || failureCount >= 2) {
      const failedIdx = getState('playlist.currentTrackIndex');
      if (failedIdx >= 0) {
        sendToHost({ type: MSG.GUEST_DECODE_FAILED, index: failedIdx });
      }
      return;
    }

    // First non-timeout failure: try recovery (3 attempts + backoff) for the
    // chunk-loss case. If decode still fails after recovery completes, the
    // counter trips on entry to this catch on the second pass.
    sendRecoveryRequest(0);
  } finally {
    showLoader(false);
  }
}
