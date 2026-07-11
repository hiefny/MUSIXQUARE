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
import { MSG, TRANSFER_STATE } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer, delay } from '../core/timers.ts';
import { initAudio } from '../audio/engine.ts';
import {
  getPlaybackModeActivity,
  isExternalOwner,
  isPlaybackNonIdleFile,
  setPlaybackIdle,
  setPlaybackTransferState,
  setPlaybackTrackMeta,
} from './ownership.ts';
import { setEngineMode } from './video.ts';
import {
  cleanupStoredFile,
  discardResidentStoredFileAdmission,
  postCommand,
  promoteStoredFileAdmission,
  retainStoredFileAdmission,
} from '../storage/storage.ts';
import { broadcastFileDebounced } from '../storage/transfer.ts';
import { shareRemoteFileIfNeeded } from '../share/remote-share.ts';
import type { AnyProtocolMsg, FileMeta, TrackMeta } from '../types/index.ts';
import { schedulePreload } from '../storage/preload.ts';
import { broadcast, safeSend, sendToHost } from '../network/peer.ts';
import { broadcastSystemNotice } from '../chat/protocol.ts';
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import { sendRecoveryRequest } from '../storage/recovery.ts';
import { isSystemAudioActive } from '../audio/system-capture.ts';
import type { DataConnection } from '../types/index.ts';

import {
  getCurrentAudioBuffer,
  setCurrentAudioBuffer,
  getCurrentLoadEpoch,
  isCurrentLoadEpoch,
  getActiveLoadSessionId,
  incrementLoadSessionId,
  getPendingPlayTime,
  setPendingPlayTime,
  setPendingRecoveryTarget,
  getPendingPlayTimeAge,
  setPlayPreloadedInProgress,
  getLastClearedTrackName,
  setLastClearedTrackName,
  markTrackFailed,
  isTrackFailed,
  clearFailedTracks,
  getTrackKeyFromFile,
  getTrackKeyFromItem,
  liveAudioBufferPcmBytes,
  trackDecodedAudioBufferForAdmission,
} from './_state.ts';

import { isFilePipelineBusyForPlay, play, stopAllMedia, stopPlayerNode } from './transport.ts';

import { getAudioContext, ensureRunning } from '../audio/context.ts';
import { showToast, showLoader } from '../ui/toast.ts';
import { transition } from './lifecycle.ts';
import { isDemoTrackName } from '../demo/tracks.ts';
import {
  assertBlobCanDecodeToAudioBuffer,
  assertDecodedAudioBufferWithinBudget,
  encodedReceiveReservationIdForBlob,
  isAudioDecodeAdmissionError,
  reserveDecodeMemoryWithinBudget,
  resolveDecodeMemoryBudget,
  waitForInFlightMemoryReservationChange,
} from './decode-admission.ts';

// ─── Decode Admission & Ownership ──────────────────────────────────
// decodeAudioData has no cancellation API. Racing it against a timer only
// abandons the Promise while native decoder work and its allocation continue,
// which is especially harmful on iOS. We therefore admit the projected RAM
// footprint before arrayBuffer(), await the native decoder without an
// arbitrary deadline, and check caller ownership at every cancellable boundary.

class DecodeSupersededError extends Error {
  constructor(readonly label: string) {
    super(`Decode superseded: ${label}`);
    this.name = 'DecodeSupersededError';
  }
}

function isDecodeSupersededError(error: unknown): error is DecodeSupersededError {
  return error instanceof DecodeSupersededError;
}

interface DecodeAdmissionLease {
  readonly audioBuffer: AudioBuffer;
  release(): void;
}

async function waitForMemoryReservationChangeWhileCurrent(
  isCurrent: () => boolean,
  excludeEncodedReceiveReservationId?: number,
): Promise<boolean> {
  if (!isCurrent()) return false;
  const abort = new AbortController();
  const ownerPoll = globalThis.setInterval(() => {
    if (!isCurrent()) abort.abort();
  }, 100);
  try {
    return await waitForInFlightMemoryReservationChange(abort.signal, {
      excludeEncodedReceiveReservationId,
    });
  } finally {
    globalThis.clearInterval(ownerPoll);
  }
}

async function decodeBlobToAudioBuffer(
  blob: Blob,
  label: string,
  fileName: string,
  isCurrent: () => boolean,
): Promise<DecodeAdmissionLease> {
  if (!isCurrent()) throw new DecodeSupersededError(label);

  const budget = resolveDecodeMemoryBudget();
  const sourceEncodedReceiveReservationId = encodedReceiveReservationIdForBlob(blob);
  // Only the iOS tier counts WeakRef survivors. Other tiers still release the
  // app-owned current buffer before entry, while avoiding nondeterministic GC
  // accounting on browsers that do not exhibit the long-session WebKit issue.
  let retainedPcmBytes = budget.tier === 'ios' ? liveAudioBufferPcmBytes() : 0;
  let admission: Awaited<ReturnType<typeof assertBlobCanDecodeToAudioBuffer>>;
  let reservation: ReturnType<typeof reserveDecodeMemoryWithinBudget>;
  for (;;) {
    try {
      if (budget.tier === 'ios') retainedPcmBytes = liveAudioBufferPcmBytes();
      admission = await assertBlobCanDecodeToAudioBuffer(blob, {
        budget,
        fileName,
        retainedPcmBytes,
        outputSampleRate: getAudioContext().sampleRate,
      });

      if (!isCurrent()) throw new DecodeSupersededError(label);
      // The probes above are asynchronous. Re-check and reserve synchronously so
      // two probe continuations queued in the same microtask checkpoint cannot
      // both observe the old in-flight total and over-admit.
      reservation = reserveDecodeMemoryWithinBudget(admission.ownDecodeFootprintBytes, {
        budget: admission.budget,
        fileName,
        retainedPcmBytes: budget.tier === 'ios' ? liveAudioBufferPcmBytes() : retainedPcmBytes,
        excludeEncodedReceiveReservationId: admission.sourceEncodedReceiveReservationId,
      });
      break;
    } catch (error) {
      if (isAudioDecodeAdmissionError(error) && error.reason === 'working-set') {
        if (!isCurrent()) throw new DecodeSupersededError(label);
        const changed = await waitForMemoryReservationChangeWhileCurrent(
          isCurrent,
          sourceEncodedReceiveReservationId,
        );
        if (changed) {
          // The file fits by itself but an older uncancellable decode or remote
          // transport still owns RAM. Retry only after the live ledger changes.
          continue;
        }
        if (!isCurrent()) throw new DecodeSupersededError(label);
      }
      throw error;
    }
  }
  try {
    const arrayBuffer = await blob.arrayBuffer();
    if (!isCurrent()) throw new DecodeSupersededError(label);

    // Intentionally no timeout: the browser cannot cancel decodeAudioData, so
    // a timeout would create an invisible native decode that can overlap
    // retries. The reservation remains until this native Promise settles even
    // when a newer load supersedes the caller.
    const audioBuffer = await getAudioContext().decodeAudioData(arrayBuffer);
    // WebKit may retain native PCM even when ownership changed or the measured
    // footprint is rejected. Track it before either check; publication later
    // deduplicates the same object.
    trackDecodedAudioBufferForAdmission(audioBuffer);
    if (!isCurrent()) throw new DecodeSupersededError(label);

    const actualFootprint = assertDecodedAudioBufferWithinBudget(audioBuffer, blob.size, {
      budget: admission.budget,
      fileName,
      retainedPcmBytes:
        budget.tier === 'ios' ? liveAudioBufferPcmBytes(audioBuffer) : retainedPcmBytes,
      // Replace this lease's estimate with the browser-reported footprint;
      // every other live decode lease is read from the global ledger once.
      excludeDecodeReservationId: reservation.id,
      excludeEncodedReceiveReservationId: admission.sourceEncodedReceiveReservationId,
    });
    reservation.update(actualFootprint);
    return { audioBuffer, release: reservation.release };
  } catch (error) {
    reservation.release();
    throw error;
  }
}

// Preload-activation owner handle (M4 in the playback concurrency design).
// A superseded activation must not clear the flag owned by its successor, so
// finish compares handle identity rather than epoch equality. The epoch keeps
// each owner attributable to its logical run and detects callers that skipped
// entry-point allocation. stopAllMedia may also clear the flag; finish remains
// idempotent after that teardown.
interface PreloadActivation {
  /** The load epoch (M1) that owned the pipeline when this activation began. */
  readonly epoch: number;
}

let _activePreloadActivation: PreloadActivation | null = null;

function beginPreloadActivation(epoch: number): PreloadActivation {
  if (_activePreloadActivation && _activePreloadActivation.epoch === epoch) {
    log.warn(
      '[Preload] Two activations share one load epoch — a caller skipped its entry-point epoch allocation',
    );
  }
  const owner: PreloadActivation = { epoch };
  _activePreloadActivation = owner;
  setPlayPreloadedInProgress(true);
  return owner;
}

function isCurrentPreloadActivation(owner: PreloadActivation): boolean {
  return _activePreloadActivation === owner;
}

function finishPreloadActivation(owner: PreloadActivation): void {
  if (!isCurrentPreloadActivation(owner)) return;
  _activePreloadActivation = null;
  setPlayPreloadedInProgress(false);
}

// ─── Load And Broadcast File (Host) ────────────────────────────────

export async function loadAndBroadcastFile(
  file: File,
  sessionId: number | null = null,
  loadEpoch?: number,
  prepareMsg?: AnyProtocolMsg,
): Promise<boolean> {
  const myLoadId = incrementLoadSessionId();
  const myEpoch = loadEpoch ?? getCurrentLoadEpoch();

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
    if (getAudioContext().state !== 'running') await ensureRunning();

    log.debug('[BufferMode] Decoding audio for high-precision sync...');
    showToast(t('toast.hprecision_sync'));

    // The previous track is already stopped. Drop the app-owned PCM reference
    // before admission so the next decode does not guarantee a two-buffer peak.
    if (getCurrentAudioBuffer()) setCurrentAudioBuffer(null);
    const decoded = await decodeBlobToAudioBuffer(
      file,
      'host-load',
      file.name,
      () =>
        myLoadId === getActiveLoadSessionId() &&
        (loadEpoch === undefined || isCurrentLoadEpoch(myEpoch)) &&
        !isExternalOwner(),
    );
    const audioBuffer = decoded.audioBuffer;
    try {
      // Re-verify after async decode. The native decode reservation remains
      // live until this result is either published or discarded.
      if (loadEpoch !== undefined && !isCurrentLoadEpoch(myEpoch)) {
        if (myLoadId === getActiveLoadSessionId()) {
          log.warn('[Load] Load epoch superseded after decode. Aborting stale load.');
          showLoader(false);
        }
        return false;
      }

      if (isExternalOwner()) {
        log.debug('[Load] Aborted - external playback mode took ownership after decode');
        return false;
      }

      if (myLoadId !== getActiveLoadSessionId()) {
        log.debug('[Load] Stale loading session detected. Aborting.');
        return false;
      }

      // Publishing transfers accounting from the in-flight reservation to the
      // current-buffer state; release immediately afterward in finally.
      setCurrentAudioBuffer(audioBuffer);
    } finally {
      decoded.release();
    }
    log.debug(`[BufferMode] Loaded ${audioBuffer.duration.toFixed(2)}s into RAM.`);

    // Lifecycle: host-side decode completed → READY.
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
      // Demo is a public bundled asset: remote guests fetch it over HTTP from
      // the app server. Also sending an R2 descriptor makes the HTTP and R2
      // downloads race for the same preload slot.
      if (!isDemoTrackName(file.name)) {
        void shareRemoteFileIfNeeded(file, sessionId);
      }
    }

    if (!hostConn) {
      schedulePreload();
    }
    return true;
  } catch (err: unknown) {
    if (isDecodeSupersededError(err)) {
      log.debug(`[Load] ${err.message}`);
      return false;
    }
    log.error(err);

    // Failure side effects target shared state for the current track. A stale
    // load must not clear, fail, or auto-advance its successor.
    if (
      (loadEpoch !== undefined && !isCurrentLoadEpoch(myEpoch)) ||
      myLoadId !== getActiveLoadSessionId()
    ) {
      log.debug('[Load] Decode failed for a superseded load — skipping failure side effects.');
      return false;
    }

    // Clear corrupt/stale blob so recovery doesn't re-serve it to guests
    setState('files.currentFileBlob', null);

    const memoryLimited = isAudioDecodeAdmissionError(err);
    if (memoryLimited) log.warn('[Decode] RAM admission rejected the file', err);
    // Admission and native decoder failures share the FAILED lifecycle; the
    // recovery policy below still distinguishes host from guest ownership.
    transition({ type: 'DECODE_ERROR' });
    const message = err instanceof Error ? err.message : String(err);
    showToast(t('error.load_failed', { msg: message }));

    // Auto-advance to the next playable track (host only — guests follow host).
    // We only do this on the host side; guests receive the next FILE_START from
    // the host after host itself advances, so guests don't need independent skip.
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      const failedIdx = getState('playlist.currentTrackIndex');
      markFailedAndAdvance(file, failedIdx);
    }
    return false;
  } finally {
    if (myLoadId === getActiveLoadSessionId()) {
      showLoader(false);
      setState('player.pausedAt', 0);
    }

    // Only the current load owns the play-button state.
    if (
      !(loadEpoch !== undefined && !isCurrentLoadEpoch(myEpoch)) &&
      myLoadId === getActiveLoadSessionId()
    ) {
      const hostConn = getState('network.hostConn');
      const isOperator = getState('network.isOperator');
      bus.emit('ui:play-btn-state', !hostConn || isOperator);
    }
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
export async function loadDemoFile(file: File, meta: TrackMeta, loadEpoch?: number): Promise<void> {
  const myLoadId = incrementLoadSessionId();
  const myEpoch = loadEpoch ?? getCurrentLoadEpoch();

  showLoader(true, t('transfer.demo_loading_short'));
  stopAllMedia({ silent: true });
  setPlaybackTrackMeta(meta);

  transition({
    type: 'FILE_PREPARE',
    variant: 'preload-match',
    index: 0,
    name: file.name,
  });

  try {
    if (!isSystemAudioActive()) {
      await Promise.race([initAudio(), delay(2000)]);
    }
    if (getAudioContext().state !== 'running') await ensureRunning();

    if (getCurrentAudioBuffer()) setCurrentAudioBuffer(null);
    const decoded = await decodeBlobToAudioBuffer(
      file,
      'demo-load',
      file.name,
      () =>
        myLoadId === getActiveLoadSessionId() &&
        (loadEpoch === undefined || isCurrentLoadEpoch(myEpoch)) &&
        !isExternalOwner(),
    );
    const audioBuffer = decoded.audioBuffer;
    try {
      if (loadEpoch !== undefined && !isCurrentLoadEpoch(myEpoch)) {
        if (myLoadId === getActiveLoadSessionId()) showLoader(false);
        return;
      }

      if (isExternalOwner()) {
        log.debug('[Demo] Aborted - external playback mode took ownership after decode');
        return;
      }

      if (myLoadId !== getActiveLoadSessionId()) return;

      setCurrentAudioBuffer(audioBuffer);
    } finally {
      decoded.release();
    }
    transition({ type: 'DECODE_SUCCESS' });
    if (audioBuffer.duration && Number.isFinite(audioBuffer.duration)) {
      bus.emit('ui:duration-update', audioBuffer.duration);
    }

    setState('transfer.meta', {
      name: file.name,
      type: file.type,
      index: 0,
      title: meta.title,
    });
    setState('files.currentFileBlob', file);
    setPlaybackTrackMeta(meta);
    bus.emit('ui:play-btn-state', true);
  } catch (err: unknown) {
    if (isDecodeSupersededError(err)) {
      log.debug(`[Demo] ${err.message}`);
      return;
    }
    log.error('[Demo] Load failed', err);
    // Same supersession guard as loadAndBroadcastFile's catch: a superseded
    // demo load's failure must not null the successor's published blob or
    // knock the successor's FSM to FAILED. Rethrow either way — the caller's
    // catch owns demo-level recovery.
    if (
      (loadEpoch !== undefined && !isCurrentLoadEpoch(myEpoch)) ||
      myLoadId !== getActiveLoadSessionId()
    ) {
      throw err;
    }
    setState('files.currentFileBlob', null);
    transition({ type: 'DECODE_ERROR' });
    throw err;
  } finally {
    if (myLoadId === getActiveLoadSessionId()) {
      showLoader(false);
      setState('player.pausedAt', 0);
    }
  }
}

function markFailedAndAdvance(file: File | Blob | null, failedIdx: number): void {
  const playlist = getState('playlist.items') || [];

  if (failedIdx < 0 || playlist.length === 0) return;

  // System notice in the chat: tells everyone in the room why playback is
  // jumping. broadcastSystemNotice handles per-recipient i18n + host-local
  // emit (see chat/protocol.ts).
  broadcastSystemNotice('chat.decode_skip_notice');

  // Prefer the playlist item's identity so the key used below to count and
  // select candidates is exactly the key we mark. Its attached File, when
  // present, supplies the underlying object identity. Fall back to the decode
  // Blob only when no playlist entry exists.
  const failedKey = getTrackKeyFromItem(playlist[failedIdx]) ?? getTrackKeyFromFile(file);
  markTrackFailed(failedKey);

  // If no playable track remains, stop and return to IDLE.
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
    setCurrentAudioBuffer(null);
    setPlaybackTrackMeta(null);
    setState('playlist.currentTrackIndex', -1);
    setState('player.pausedAt', 0);
    setPlaybackIdle();
    transition({ type: 'PAUSE', time: 0, endOfPlaylist: true });
    broadcast({ type: MSG.PAUSE, time: 0, endOfPlaylist: true, reason: 'end-of-playlist' });
    return;
  }

  // Walk order candidates in priority:
  //   (1) preloaded next — preserves shuffle intent when host already
  //       staged the shuffle-next, and avoids wasting the preload
  //   (2) shuffle — shared row-level Fisher-Yates order
  //   (3) sequential — (failedIdx + 1) % length (when shuffle OFF)
  const isShuffle = getState('playlist.isShuffle');
  const repeatMode = getState('playlist.repeatMode');
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

  const shouldUseShuffleOrder = nextIdx === -1 && isShuffle;

  if (nextIdx === -1 && !shouldUseShuffleOrder) {
    // Wrap past the playlist end only under repeat-all. Sequential and shuffle
    // failure paths must both stop at the end of a non-repeating pass.
    const maxProbe = repeatMode === 1 ? playlist.length : playlist.length - 1 - failedIdx;
    for (let probe = 1; probe <= maxProbe; probe++) {
      const candidate = (failedIdx + probe) % playlist.length;
      if (isGoodCandidate(candidate)) {
        nextIdx = candidate;
        break;
      }
    }
  }

  {
    // A -1 target falls through to the canonical end-of-playlist handler.
    // Snapshot the load epoch so a user action during the backoff supersedes
    // this scheduled advance even if timer clearing races with its callback.
    const advanceEpoch = getCurrentLoadEpoch();
    setManagedTimer(
      'decode-fail-advance',
      () => {
        if (!isCurrentLoadEpoch(advanceEpoch)) {
          log.debug(
            '[Decode] Skipping auto-advance — load epoch advanced (user action superseded)',
          );
          return;
        }
        // Dynamic import to avoid a static cycle with playlist.ts
        import('./playlist.ts').then(
          ({ getShuffleNextPlayableIndex, playNextTrack, playTrack }) => {
            const targetIdx = shouldUseShuffleOrder
              ? getShuffleNextPlayableIndex(isGoodCandidate)
              : nextIdx;
            if (targetIdx !== -1) {
              playTrack(targetIdx);
            } else {
              playNextTrack();
            }
          },
        );
      },
      600,
    );
  }
}

// Guest decoders can reject a track the host can play. An operator report may
// advance immediately; non-operator reports require two connected peers so a
// single guest cannot turn a decode report into room-wide skip control. Stale
// and duplicate reports are ignored. In a single-guest room the host therefore
// continues until an operator skips or the track ends.
const NON_OP_DECODE_FAILURE_QUORUM = 2;
const _reportedDecodeFailures = new Map<number, Set<string>>();
const _advancedGuestDecodeFailureTracks = new Set<number>();

function getConnectedDecodeReporter(peerId: string) {
  return getState('network.connectedPeers').find(
    (peer) => peer.id === peerId && peer.status === 'connected',
  );
}

function rememberDecodeFailureReport(peerId: string, trackIndex: number): Set<string> {
  let reports = _reportedDecodeFailures.get(trackIndex);
  if (!reports) {
    reports = new Set<string>();
    _reportedDecodeFailures.set(trackIndex, reports);
  }
  reports.add(peerId);
  return reports;
}

function countConnectedNonOpDecodeReports(reports: Set<string>): number {
  const peers = getState('network.connectedPeers');
  let count = 0;
  for (const peer of peers) {
    if (peer.status !== 'connected' || peer.isOp || !reports.has(peer.id)) continue;
    count += 1;
  }
  return count;
}

function notifyOperatorsOfHeldDecodeFailure(): void {
  const text = t('toast.remote_decode_device_wait');
  showToast(text);
  for (const peer of getState('network.connectedPeers')) {
    if (peer.status !== 'connected' || !peer.isOp) continue;
    safeSend(peer.conn, {
      type: MSG.OPERATOR_TOAST,
      text,
      i18nKey: 'toast.remote_decode_device_wait',
    });
  }
}

function advanceFromGuestDecodeFailure(trackIndex: number): void {
  if (_advancedGuestDecodeFailureTracks.has(trackIndex)) return;
  _advancedGuestDecodeFailureTracks.add(trackIndex);
  markFailedAndAdvance(null, trackIndex);
}

function handleGuestDecodeFailed(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host acts on this report

  const peerId = conn?.peer;
  if (!peerId) return;
  const peer = getConnectedDecodeReporter(peerId);
  if (!peer) return;

  const reportedIdx = data.index as number;
  const currentIdx = getState('playlist.currentTrackIndex');

  if (reportedIdx !== currentIdx) {
    log.debug(
      `[Decode] Stale GUEST_DECODE_FAILED for index ${reportedIdx} (current ${currentIdx})`,
    );
    return;
  }

  const existingReports = _reportedDecodeFailures.get(reportedIdx);
  if (existingReports?.has(peerId)) {
    log.debug(`[Decode] Duplicate decode-failed from ${peerId} for index ${reportedIdx}`);
    return;
  }
  const reports = rememberDecodeFailureReport(peerId, reportedIdx);

  if (verifyOperator(conn, data)) {
    log.info(`[Decode] OP reported decode failure at index ${reportedIdx}, advancing room`);
    advanceFromGuestDecodeFailure(reportedIdx);
    return;
  }

  const nonOpReports = countConnectedNonOpDecodeReports(reports);
  const requiredReports = NON_OP_DECODE_FAILURE_QUORUM;
  if (nonOpReports < requiredReports) {
    log.warn(
      `[Decode] Holding non-OP decode-failed for index ${reportedIdx}: ${nonOpReports}/${requiredReports} reports`,
    );
    notifyOperatorsOfHeldDecodeFailure();
    return;
  }

  log.info(`[Decode] Non-OP decode failure quorum reached at index ${reportedIdx}, advancing room`);
  advanceFromGuestDecodeFailure(reportedIdx);
}

export function initDecodeHandlers(): void {
  registerHandlers({
    [MSG.GUEST_DECODE_FAILED]: handleGuestDecodeFailed,
  });

  // Clear dedup set on track change — each new track starts fresh, so every
  // peer gets one report budget per track. Also covers session reset
  // (currentTrackIndex resets to -1 on leave).
  bus.on('state:playlist.currentTrackIndex', () => {
    _reportedDecodeFailures.clear();
    _advancedGuestDecodeFailureTracks.clear();
  });
}

// ─── Load Preloaded Track ──────────────────────────────────────────

function exactPreloadIdentity(
  blob: Blob,
  meta: Readonly<Partial<FileMeta>> | null,
  targetIndex: number,
): meta is Readonly<Partial<FileMeta>> {
  if (!meta || !Number.isSafeInteger(targetIndex) || targetIndex < 0) return false;
  if (!Number.isSafeInteger(meta.index) || meta.index !== targetIndex) return false;
  if (!Number.isSafeInteger(meta.sessionId) || (meta.sessionId as number) <= 0) return false;

  // Blob + metadata are one cache snapshot. A newer preload published while
  // this activation was awaiting audio setup/decode must supersede it even if
  // it happens to use the same playlist index and filename.
  if (getState('preload.nextFileBlob') !== blob) return false;
  if (getState('preload.nextTrackIndex') !== targetIndex) return false;
  const liveMeta = getState('preload.meta');
  if (!liveMeta || !Number.isSafeInteger(liveMeta.index) || liveMeta.index !== targetIndex)
    return false;
  if (
    !Number.isSafeInteger(liveMeta.sessionId) ||
    liveMeta.sessionId !== meta.sessionId ||
    (liveMeta.sessionId as number) <= 0
  )
    return false;

  const playlistItem = getState('playlist.items')[targetIndex];
  if (playlistItem?.file && playlistItem.file !== blob) return false;
  if (playlistItem?.name && meta.name && playlistItem.name !== meta.name) return false;

  return true;
}

function rejectMismatchedPreload(
  blob: Blob,
  meta: Readonly<Partial<FileMeta>> | null,
  targetIndex: number,
): void {
  log.warn(
    `[Preload] Cached blob identity does not match target index ${targetIndex}; requesting fresh bytes`,
  );

  // Clear only the snapshot we rejected. If a newer preload already replaced
  // it, that newer snapshot owns the cache and must remain intact.
  if (getState('preload.nextFileBlob') === blob) {
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
  }

  const hostConn = getState('network.hostConn');
  if (!hostConn?.open || !Number.isInteger(targetIndex) || targetIndex < 0) return;

  const playlistItem = getState('playlist.items')[targetIndex];
  const name = playlistItem?.name || (typeof meta?.name === 'string' ? meta.name : '');
  setPendingRecoveryTarget(targetIndex, name);
  sendToHost({
    type: MSG.REQUEST_CURRENT_FILE,
    name,
    index: targetIndex,
    reason: 'preload_identity_mismatch',
  });
}

/**
 * Activate the preloaded blob (decode → swap into the live buffer).
 *
 * Returns `true` only when the activation fully succeeded (buffer swapped,
 * lifecycle at READY). Every abort/supersede/failure path returns `false` so
 * callers that follow up with play()+broadcast can avoid announcing audio the
 * host did not load. This mirrors loadAndBroadcastFile's boolean contract.
 */
export async function loadPreloadedTrack(
  expectedIndex?: number,
  loadEpoch?: number,
): Promise<boolean> {
  const nextMeta = getState('preload.meta');
  const currentTrackIndex = getState('playlist.currentTrackIndex');
  const targetIndex = expectedIndex ?? (nextMeta?.index as number) ?? currentTrackIndex;
  const myEpoch = loadEpoch ?? getCurrentLoadEpoch();
  const localBlob = getState('preload.nextFileBlob');
  const localMeta = nextMeta ? { ...nextMeta } : null;

  if (!localBlob) {
    log.warn('[Preload] No preloaded blob found in cache!');
    setPendingPlayTime(undefined);
    return false;
  }
  const isAdmissionBoundPreload = encodedReceiveReservationIdForBlob(localBlob) !== undefined;

  if (!exactPreloadIdentity(localBlob, localMeta, targetIndex)) {
    rejectMismatchedPreload(localBlob, localMeta, targetIndex);
    return false;
  }

  const activationOwner = beginPreloadActivation(myEpoch);

  try {
    if (!isSystemAudioActive()) {
      await Promise.race([initAudio(), delay(2000)]);
      if (getAudioContext().state !== 'running') await ensureRunning();
    }

    if (
      expectedIndex !== undefined &&
      currentTrackIndex !== -1 &&
      currentTrackIndex !== targetIndex
    ) {
      log.warn(
        `[Preload] Index mismatch! Expected ${targetIndex}, current is ${currentTrackIndex}. Aborting.`,
      );
      finishPreloadActivation(activationOwner);
      // pendingPlayTime belongs to the latest PLAY target; its matching loader
      // must retain it across a superseded activation.
      return false;
    }

    if (isExternalOwner()) {
      log.debug('[Preload] Activation aborted - external playback mode active');
      finishPreloadActivation(activationOwner);
      setPendingPlayTime(undefined);
      showLoader(false);
      return false;
    }

    if (getCurrentAudioBuffer()) {
      setCurrentAudioBuffer(null);
    }

    // Activation has already committed to replacing the old file buffer. Drop
    // its exact encoded resident before admitting the next decode; otherwise a
    // fully app-controlled 100+ MiB prior Blob can cause a false memory reject.
    let priorCurrentBlob = getState('files.currentFileBlob');
    if (priorCurrentBlob && priorCurrentBlob !== localBlob) {
      setState('files.currentFileBlob', null);
      discardResidentStoredFileAdmission(priorCurrentBlob);
      priorCurrentBlob = null;
    }

    log.debug('[Preload] Decoding audio for Buffer Mode...');
    showToast(t('toast.decoding_audio'));

    const preloadName =
      (localMeta?.name as string) ||
      (typeof File !== 'undefined' && localBlob instanceof File ? localBlob.name : '');
    const decoded = await decodeBlobToAudioBuffer(
      localBlob,
      'preload',
      preloadName,
      () =>
        isCurrentPreloadActivation(activationOwner) &&
        (loadEpoch === undefined || isCurrentLoadEpoch(myEpoch)) &&
        (expectedIndex === undefined || getState('playlist.currentTrackIndex') === targetIndex) &&
        exactPreloadIdentity(localBlob, localMeta, targetIndex) &&
        !isExternalOwner(),
    );
    const audioBuffer = decoded.audioBuffer;
    const activeMeta = localMeta;
    try {
      // Re-verify after async decode.
      if (loadEpoch !== undefined && !isCurrentLoadEpoch(myEpoch)) {
        log.warn('[Preload] Load epoch superseded after decode. Discarding.');
        finishPreloadActivation(activationOwner);
        // Same rationale: epoch supersession means a newer load is starting;
        // the newer load owns pendingPlayTime consumption.
        return false;
      }
      if (
        expectedIndex !== undefined &&
        currentTrackIndex !== -1 &&
        getState('playlist.currentTrackIndex') !== targetIndex
      ) {
        log.warn('[Preload] Track changed during decode. Discarding.');
        finishPreloadActivation(activationOwner);
        // Preserve pendingPlayTime for the new track's loader.
        return false;
      }
      if (isExternalOwner()) {
        log.debug('[Preload] Activation discarded - external playback mode took ownership');
        finishPreloadActivation(activationOwner);
        setPendingPlayTime(undefined);
        showLoader(false);
        return false;
      }

      // Release the prior track's RAM slot before publishing the promoted blob.
      // The prior slot may belong to either pool; cleanupStoredFile is
      // idempotent, so probing both variants is safe.
      const newName = (activeMeta?.name as string) || '';
      const prevTrackName = getState('files.currentTrack')?.name;
      if (prevTrackName && prevTrackName !== newName) {
        log.info(`[Preload] Track rotate: prev="${prevTrackName}" new="${newName}"`);
        cleanupStoredFile(prevTrackName, false);
        cleanupStoredFile(prevTrackName, true);
      } else {
        log.info(`[Preload] Track rotate skip (prev=${prevTrackName ?? 'null'}, new=${newName})`);
      }
      if (newName) {
        setState('files.currentTrack', { name: newName });
      }

      const activeSessionId = Number(activeMeta?.sessionId);
      if (newName && Number.isSafeInteger(activeSessionId) && activeSessionId > 0) {
        const promoted = promoteStoredFileAdmission(newName, activeSessionId, localBlob);
        if (isAdmissionBoundPreload && !promoted) {
          throw new Error('PRELOAD_RESIDENT_PROMOTION_FAILED');
        }
      }

      // Update global state and transfer accounting from the decode lease.
      setState('files.currentFileBlob', localBlob);
      setState('transfer.meta', activeMeta);
      setCurrentAudioBuffer(audioBuffer);
    } finally {
      decoded.release();
    }
    log.debug(`[BufferMode] Preloaded ${audioBuffer.duration.toFixed(2)}s decoded.`);

    // Guest: refresh track title from playlist — finalizeGuestFile sets this
    // on the P2P download path, but the preload/demo path never did, leaving
    // the UI stuck on the previous track's title.
    const hostConn = getState('network.hostConn');
    if (hostConn) {
      const playlist = getState('playlist.items') || [];
      if (playlist[targetIndex]) {
        setPlaybackTrackMeta(playlist[targetIndex]);
      }
    }

    // Lifecycle: preload blob decoded → READY.
    transition({ type: 'DECODE_SUCCESS' });

    setEngineMode('buffer');

    const dur = audioBuffer.duration;
    if (Number.isFinite(dur)) {
      bus.emit('ui:duration-update', dur);
    }
    // Clear preload state
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
    log.debug('[Preload] Safe clear: nextFileBlob moved to current.');

    // Reset transfer guards — transfer.state must be READY so next preload loader shows.
    // shouldSkipIncomingFile() returns true via the PRELOAD_PROMOTED loadSource
    // branch (lifecycle is READY/PLAYING after this), so no flag needed.
    setPlaybackTransferState(TRANSFER_STATE.READY);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('preloadWatchdog');

    // Auto-sync after settle
    if (hostConn?.open) {
      setManagedTimer(
        'playback-preload-auto-sync',
        () => {
          log.debug('[Guest] Post-preload auto-sync');
          bus.emit('sync:force-resync');
        },
        500,
      );
    }

    // Consume pending play time — compensate for elapsed wall clock so the
    // guest doesn't resume at the host's past position (remote-demo HTTP
    // fetch can take several seconds during which the host keeps playing).
    const pendingTime = getPendingPlayTime();
    if (hostConn && pendingTime !== undefined) {
      const age = getPendingPlayTimeAge();
      let target = pendingTime + age;

      // Wrap target time for demo tracks to avoid seeking past the end (silence)
      if (isDemoTrackName(localMeta?.name) && audioBuffer.duration > 0) {
        target = target % audioBuffer.duration;
      }

      log.info(
        `[Preload] Activating demo/preload playback at ${target.toFixed(1)}s (age=${age.toFixed(1)}s)`,
      );
      play(target);
      setPendingPlayTime(undefined);
      bus.emit('sync:arm-initial');
      setManagedTimer(
        'playback-preload-host-sync',
        () => bus.emit('sync:request-immediate-ping'),
        250,
      );
    } else {
      log.info('[Preload] No pending play time, requesting initial sync from host');
      // A remote-share download may finish without a PLAY for this track.
      // Request sync immediately so bootstrap can start at the host position
      // without waiting for the next periodic sync.
      bus.emit('sync:request-immediate-ping');
    }

    finishPreloadActivation(activationOwner);
    showLoader(false);
    return true;
  } catch (e: unknown) {
    if (!isCurrentPreloadActivation(activationOwner)) {
      log.debug('[Preload] Stale activation failed after supersession; ignoring', e);
      return false;
    }
    if (isDecodeSupersededError(e)) {
      log.debug(`[Preload] ${e.message}`);
      finishPreloadActivation(activationOwner);
      if (isExternalOwner()) {
        setPendingPlayTime(undefined);
        showLoader(false);
      }
      return false;
    }
    finishPreloadActivation(activationOwner);
    setPendingPlayTime(undefined);
    log.error('[Preload] Activation failed:', e);
    showLoader(false);

    const memoryLimited = isAudioDecodeAdmissionError(e);
    const meta = getState('transfer.meta');
    const name = (meta?.name as string) || '';
    // Lifecycle: preload decode failed → FAILED.
    transition({ type: 'DECODE_ERROR' });
    showToast(t('transfer.preload_fail'));

    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
    discardResidentStoredFileAdmission(localBlob);
    clearManagedTimer('preloadWatchdog');

    const hostConn = getState('network.hostConn');
    const failedIdx = getState('playlist.currentTrackIndex');

    // A host cannot request recovery from itself; use the normal host
    // failed-track and auto-advance path.
    if (!hostConn) {
      markFailedAndAdvance(localBlob, failedIdx);
      return false;
    }

    // Admission rejection is device-local and cannot be repaired by fetching
    // the same bytes again. Mark it failed and wait for the host to advance.
    if (memoryLimited) {
      const failedKey = getTrackKeyFromFile(localBlob);
      markTrackFailed(failedKey);
      if (failedIdx >= 0) sendToHost({ type: MSG.GUEST_DECODE_FAILED, index: failedIdx });
      return false;
    }

    // An ordinary decoder failure may be recoverable. Bound descriptor re-sends to
    // two activation attempts so persistent decode failures cannot loop.
    const failureCount = (getState('player.decodeFailureCount') || 0) + 1;
    setState('player.decodeFailureCount', failureCount);
    if (failureCount >= 2) {
      log.warn(
        '[Preload] Activation failed twice for the same track — marking failed, no re-request',
      );
      markTrackFailed(getTrackKeyFromFile(localBlob));
      if (failedIdx >= 0) sendToHost({ type: MSG.GUEST_DECODE_FAILED, index: failedIdx });
      return false;
    }
    const playlist = getState('playlist.items') || [];
    const recoveryName = playlist[failedIdx]?.name || name;
    sendToHost({
      type: MSG.REQUEST_CURRENT_FILE,
      name: recoveryName,
      index: failedIdx,
      reason: 'preload_activation_failed',
    });
    return false;
  }
}

// ─── Clear Previous Track State ────────────────────────────────────

export function clearPreviousTrackState(reason = ''): void {
  log.debug(`[State Clear] Clearing previous track state. Reason: ${reason}`);

  // Skip redundant clears for the same track.
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
  // Stale-audio recovery is lifecycle-driven; no separate timer needs clearing.

  // Redundant sync: only reset timers and name tracking, keep audio buffer intact
  if (reason === 'redundant-sync') return;

  // Reset transfer state
  setState('transfer.receivedCount', 0);
  setState('transfer.meta', {});
  setState('files.currentFileBlob', null);

  // Clear the resident buffer before the next track can start.
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

  // Reset file playback to idle only when no load pipeline is active. A fresh
  // FILE_PREPARE enters DOWNLOADING before emitting this cleanup event, and
  // that lifecycle must remain engaged so PLAY is deferred instead of
  // requesting a replacement transfer.
  const playback = getPlaybackModeActivity();
  if (isPlaybackNonIdleFile(playback) && !isFilePipelineBusyForPlay()) {
    setPlaybackIdle();
  }

  // Clear preload ack tracking (immutable — replace with new Set)
  setState('preload.ackSent', new Set());

  // Release OLD current file from storage
  const currentTrackEntry = getState('files.currentTrack');
  if (currentTrackEntry?.name) {
    const nextMeta = getState('preload.meta');
    const isActuallyChanging = currentTrackEntry.name !== nextMeta?.name;
    if (isActuallyChanging) {
      postCommand({ command: 'STORAGE_RESET', isPreload: false });
      cleanupStoredFile(currentTrackEntry.name, false);
      setState('files.currentTrack', { name: null });
    }
  }
}

// ─── Finalize Guest File (after download) ─────────────────────────

export async function finalizeGuestFile(file: File | Blob): Promise<void> {
  // Guard: if an external mode owns playback, abort the finalize path.
  // Otherwise setEngineMode('buffer') would overwrite that mode after an
  // async decode finishes.
  if (isExternalOwner()) {
    log.debug('[Guest] finalizeGuestFile aborted - external playback mode active');
    setPlaybackTransferState(TRANSFER_STATE.IDLE);
    postCommand({ command: 'STORAGE_RESET', isPreload: false });
    showLoader(false);
    return;
  }

  log.debug('[Guest] Finalizing with Buffer Mode...');
  const myLoadId = incrementLoadSessionId();
  // Snapshot the transfer session at entry. FILE_PREPARE can replace a transfer
  // during decode without changing the load epoch or activeLoadSessionId; the
  // snapshot prevents the old finalize from publishing into the new pipeline.
  // Use the entry value at every checkpoint so same-target A→B→A recovery
  // remains attributable to the finalize that actually began.
  const myTransferSid = getState('transfer.localSessionId');
  const isAdmissionBoundFile = encodedReceiveReservationIdForBlob(file) !== undefined;
  let detachedPreviousBuffer: AudioBuffer | null = null;
  showLoader(true, t('error.audio_memory'));

  try {
    await initAudio();
    if (getAudioContext().state !== 'running') await ensureRunning();

    if (isExternalOwner()) {
      log.debug('[Guest] Stale finalize (post-audio-init), aborting');
      setPlaybackTransferState(TRANSFER_STATE.IDLE);
      postCommand({ command: 'STORAGE_RESET', isPreload: false });
      setPendingPlayTime(undefined);
      return;
    }

    if (getActiveLoadSessionId() !== myLoadId) {
      log.debug('[Guest] Stale finalize (pre-decode), aborting');
      return;
    }
    if (getState('transfer.localSessionId') !== myTransferSid) {
      log.debug('[Guest] Stale finalize (new transfer session pre-decode), aborting');
      return;
    }

    detachedPreviousBuffer = getCurrentAudioBuffer();
    if (detachedPreviousBuffer) setCurrentAudioBuffer(null);
    const fileName =
      (typeof File !== 'undefined' && file instanceof File ? file.name : '') ||
      ((getState('transfer.meta')?.name as string) ?? '');
    const decoded = await decodeBlobToAudioBuffer(
      file,
      'guest-finalize',
      fileName,
      () =>
        getActiveLoadSessionId() === myLoadId &&
        getState('transfer.localSessionId') === myTransferSid &&
        !isExternalOwner(),
    );
    const audioBuffer = decoded.audioBuffer;
    try {
      if (getActiveLoadSessionId() !== myLoadId) {
        log.debug('[Guest] Stale finalize (post-decode), aborting');
        return;
      }
      if (getState('transfer.localSessionId') !== myTransferSid) {
        log.debug('[Guest] Stale finalize (new transfer session post-decode), aborting');
        return;
      }
      if (isExternalOwner()) {
        log.debug('[Guest] Stale finalize (external mode after decode), aborting');
        setPlaybackTransferState(TRANSFER_STATE.IDLE);
        postCommand({ command: 'STORAGE_RESET', isPreload: false });
        setPendingPlayTime(undefined);
        return;
      }

      const retained = retainStoredFileAdmission(fileName, false, myTransferSid, file);
      if (isAdmissionBoundFile && !retained) {
        throw new Error('CURRENT_RESIDENT_ADMISSION_FAILED');
      }
      if (!retained) {
        log.warn(
          `[Guest] Finalized file has no matching resident admission: ${fileName} (SID ${myTransferSid})`,
        );
      }
      setState('files.currentFileBlob', file);
      setCurrentAudioBuffer(audioBuffer);
    } finally {
      decoded.release();
    }

    // Lifecycle: main-transfer file decoded → READY.
    transition({ type: 'DECODE_SUCCESS' });

    setEngineMode('buffer');

    if (audioBuffer.duration && Number.isFinite(audioBuffer.duration)) {
      bus.emit('ui:duration-update', audioBuffer.duration);
    }
    // Reset guards
    setPlaybackTransferState(TRANSFER_STATE.READY);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');

    // Publish guest track metadata from the playlist.
    const hostConn = getState('network.hostConn');
    const playlist = getState('playlist.items') || [];
    const idx = getState('playlist.currentTrackIndex');
    const currentPlaylistItem = idx >= 0 ? playlist[idx] : undefined;
    if (hostConn && currentPlaylistItem) {
      setPlaybackTrackMeta(currentPlaylistItem);
    }

    // Consume pending play time — compensate for elapsed wall clock so the
    // guest doesn't resume at the host's past position after a slow decode.
    const pendingTime = getPendingPlayTime();
    if (hostConn && pendingTime !== undefined) {
      const age = getPendingPlayTimeAge();
      let target = pendingTime + age;
      const fileName =
        currentPlaylistItem?.name || (file as File).name || getState('transfer.meta')?.name;
      if (
        isDemoTrackName(fileName) &&
        Number.isFinite(audioBuffer.duration) &&
        audioBuffer.duration > 0
      ) {
        target = target % audioBuffer.duration;
      }
      log.debug(`[Guest] Pending play at ${target.toFixed(1)}s (age=${age.toFixed(1)}s)`);
      play(target);
      setPendingPlayTime(undefined);
      bus.emit('sync:arm-initial');
      setManagedTimer(
        'playback-finalize-host-sync',
        () => bus.emit('sync:request-immediate-ping'),
        250,
      );
    }

    bus.emit('ui:play-btn-state', true);
  } catch (err: unknown) {
    // Validate both finalize ownership and the entry transfer session before
    // failure side effects. Do not check the load epoch here: watchdog epoch
    // bumps intentionally do not abort guest finalization.
    if (
      getActiveLoadSessionId() !== myLoadId ||
      getState('transfer.localSessionId') !== myTransferSid
    ) {
      log.debug('[Guest] Decode failed for a superseded finalize — skipping failure side effects.');
      return;
    }

    if (isDecodeSupersededError(err)) {
      log.debug(`[Guest] ${err.message}`);
      if (isExternalOwner()) {
        setPlaybackTransferState(TRANSFER_STATE.IDLE);
        postCommand({ command: 'STORAGE_RESET', isPreload: false });
        setPendingPlayTime(undefined);
      }
      return;
    }

    log.error('[Guest] Decoding failed', err);

    const memoryLimited = isAudioDecodeAdmissionError(err);
    // Lifecycle: guest main-transfer decode failed → FAILED.
    transition({ type: 'DECODE_ERROR' });
    // Reset transfer state so recovery can start fresh (prevents infinite loop)
    setPlaybackTransferState(TRANSFER_STATE.IDLE);
    setState('transfer.receivedCount', 0);

    // The first ordinary decode failure may be a rare chunk-loss case that a
    // fresh transfer can fix. Admission rejection is deterministic for this
    // device, and a second decoder failure is treated as genuinely unsupported.
    const failureCount = (getState('player.decodeFailureCount') || 0) + 1;
    setState('player.decodeFailureCount', failureCount);

    if (memoryLimited || failureCount >= 2) {
      showToast(t('error.local_decode_wait'));
      const failedIdx = getState('playlist.currentTrackIndex');
      if (failedIdx >= 0) {
        sendToHost({ type: MSG.GUEST_DECODE_FAILED, index: failedIdx });
      }
      return;
    }

    showToast(t('error.audio_decode_fail'));

    // First ordinary failure: try recovery (3 attempts + backoff) for the
    // chunk-loss case. If decode still fails after recovery completes, the
    // counter trips on entry to this catch on the second pass.
    sendRecoveryRequest(0);
  } finally {
    // Preserve the pre-existing buffer when a finalize is superseded or fails.
    // A successful successor will already have published its own buffer, and
    // an external playback owner must not have file audio restored underneath.
    if (
      detachedPreviousBuffer &&
      !getCurrentAudioBuffer() &&
      !isExternalOwner() &&
      getActiveLoadSessionId() === myLoadId &&
      getState('transfer.localSessionId') === myTransferSid &&
      myTransferSid > 0
    ) {
      setCurrentAudioBuffer(detachedPreviousBuffer);
    }
    showLoader(false);
  }
}
