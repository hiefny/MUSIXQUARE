/**
 * MUSIXQUARE — File Loading & Decoding
 *
 * Manages: loadAndBroadcastFile (host), loadPreloadedTrack (guest),
 * finalizeGuestFile, clearPreviousTrackState.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { batchSetState, getState, setState } from '../core/state.ts';
import { CHUNK_SIZE, MSG, TRANSFER_STATE } from '../core/constants.ts';
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
import type {
  AnyProtocolMsg,
  DataConnection,
  FileMeta,
  QueueItemId,
  ResidentFile,
  TrackMeta,
} from '../types/index.ts';
import { schedulePreload } from '../storage/preload.ts';
import { broadcast, safeSend, sendToHost } from '../network/peer.ts';
import { beginFileRequest, sendFileRequest } from '../network/file-request-authority.ts';
import { broadcastSystemMessage } from '../chat/protocol.ts';
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import { sendRecoveryRequest } from '../storage/recovery.ts';
import { isSystemAudioActive } from '../audio/system-capture.ts';
import {
  findQueueItemIndex,
  getCurrentQueueItemId,
  getQueueItemById,
  selectQueueItemById,
} from './queue-model.ts';

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
  getLastClearedQueueItemId,
  setLastClearedQueueItemId,
  markTrackFailed,
  isTrackFailed,
  clearFailedTracks,
  getTrackKeyFromItem,
  liveAudioBufferPcmBytes,
  trackDecodedAudioBufferForAdmission,
} from './_state.ts';

import { isFilePipelineBusyForPlay, play, stopAllMedia, stopPlayerNode } from './transport.ts';

import { getAudioContext, ensureRunning } from '../audio/context.ts';
import { showToast, showLoader } from '../ui/toast.ts';
import { isProRoomPersistentPlaylistFile } from '../pro-room/legacy-media-hooks.ts';
import { transition } from './lifecycle.ts';
import { hasRoomCapability } from '../rooms/authority.ts';
import {
  assertBlobCanDecodeToAudioBuffer,
  assertDecodedAudioBufferWithinBudget,
  encodedReceiveReservationIdForBlob,
  isAudioDecodeAdmissionError,
  reserveDecodeMemoryWithinBudget,
  resolveDecodeMemoryBudget,
  waitForInFlightMemoryReservationChange,
} from './decode-admission.ts';

// ─── Decode Accounting & Ownership ─────────────────────────────────
// decodeAudioData has no cancellation API. Racing it against a timer only
// abandons the Promise while native decoder work and its allocation continue,
// which is especially harmful on iOS. The legacy engine therefore awaits the
// native decoder without an arbitrary deadline and checks caller ownership at
// every cancellable boundary. Memory reservations are accounting only under the
// production unbounded policy; they do not pre-reject normal files.

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
      // Reserve synchronously after the async accounting boundary so ownership
      // and diagnostics cannot omit overlapping native decodes. Production
      // policy does not use this ledger as a finite admission ceiling.
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
    // WebKit may retain native PCM even when ownership changed. Track it before
    // the ownership check; publication later deduplicates the same object.
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
  readonly queueItemId: QueueItemId;
  readonly sessionId: number;
}

let _activePreloadActivation: PreloadActivation | null = null;

function beginPreloadActivation(
  epoch: number,
  queueItemId: QueueItemId,
  sessionId: number,
): PreloadActivation {
  if (_activePreloadActivation && _activePreloadActivation.epoch === epoch) {
    log.warn(
      '[Preload] Two activations share one load epoch — a caller skipped its entry-point epoch allocation',
    );
  }
  const owner: PreloadActivation = { epoch, queueItemId, sessionId };
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
  queueItemId: QueueItemId,
  sessionId: number,
  loadEpoch?: number,
  prepareMsg?: AnyProtocolMsg,
): Promise<boolean> {
  const myLoadId = incrementLoadSessionId();
  const myEpoch = loadEpoch ?? getCurrentLoadEpoch();
  const isCurrentOwner = (): boolean =>
    myLoadId === getActiveLoadSessionId() &&
    getCurrentQueueItemId() === queueItemId &&
    getQueueItemById(queueItemId)?.file === file &&
    (loadEpoch === undefined || isCurrentLoadEpoch(myEpoch)) &&
    !isExternalOwner();

  if (!Number.isSafeInteger(sessionId) || sessionId <= 0 || !isCurrentOwner()) return false;

  showLoader(true, t('toast.preparing', { name: file.name }));
  stopAllMedia({ silent: true });
  if (!isCurrentOwner()) return false;

  // Lifecycle: host has the file locally (no download phase). Transition
  // straight into DECODING so the subsequent transition(DECODE_SUCCESS)
  // after decode completes lands cleanly on READY rather than being
  // rejected from IDLE/PLAYING. The `preload-match` variant captures
  // "blob is ready, promote to decoding" which matches host semantics.
  transition({
    type: 'FILE_PREPARE',
    variant: 'preload-match',
    queueItemId,
    name: file.name,
  });

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
    const decoded = await decodeBlobToAudioBuffer(file, 'host-load', file.name, isCurrentOwner);
    const audioBuffer = decoded.audioBuffer;
    try {
      // Re-verify after async decode. The native decode reservation remains
      // live until this result is either published or discarded.
      if (!isCurrentOwner()) {
        if (myLoadId === getActiveLoadSessionId()) {
          log.warn('[Load] Queue owner or load epoch changed after decode. Aborting stale load.');
          showLoader(false);
        }
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

    const indexHint = findQueueItemIndex(queueItemId);
    if (indexHint < 0 || !isCurrentOwner()) return false;
    // Atomic publish: meta first, then blob — both in the same synchronous
    // tick so any subscriber (e.g. recovery.ts findMatchingBlob) always
    // sees them in sync. Order is meta→blob so a reader that checks blob
    // first and then meta can never observe "blob set, meta still stale".
    const mime = file.type || 'application/octet-stream';
    const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const meta: FileMeta = {
      name: file.name,
      type: mime,
      queueItemId,
      indexHint,
      size: file.size,
      mime,
      sessionId,
      total,
    };
    const resident: ResidentFile = { ...meta, blob: file };
    batchSetState({ 'transfer.meta': meta, 'files.current': resident });

    // Enable play button
    const hostConn = getState('network.hostConn');
    bus.emit('ui:play-btn-state', !hostConn || hasRoomCapability('playback.control'));

    // Broadcast file to peers (FILE_PREPARE coalesced into the same debounce
    // so guests don't see metadata flicker for tracks the user already left).
    const connectedPeers = getState('network.connectedPeers') || [];
    if (connectedPeers.length > 0) {
      if (isProRoomPersistentPlaylistFile(queueItemId)) {
        // Persistent PRO participants fetch the immutable asset from the room
        // bucket with their own authenticated presign. The coordinator sends
        // only timing/identity control and never relays these bytes again.
        broadcast(
          prepareMsg ?? {
            type: MSG.FILE_PREPARE,
            name: file.name,
            mime: file.type || 'application/octet-stream',
            size: file.size,
            queueItemId,
            sessionId,
          },
        );
      } else {
        showToast(t('transfer.file_sending'));
        broadcastFileDebounced(file, queueItemId, sessionId, prepareMsg);
        // Queue files are user media regardless of filename. Bundled demo audio
        // has its own DEMO_* protocol and never enters this queue pipeline.
        void shareRemoteFileIfNeeded(file, sessionId, undefined, { queueItemId });
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
    if (!isCurrentOwner()) {
      log.debug('[Load] Decode failed for a superseded load — skipping failure side effects.');
      return false;
    }

    // Clear corrupt/stale blob so recovery doesn't re-serve it to guests
    const currentResident = getState('files.current');
    if (currentResident?.queueItemId === queueItemId && currentResident.blob === file) {
      setState('files.current', null);
    }

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
      markFailedAndAdvance(queueItemId);
    }
    return false;
  } finally {
    if (myLoadId === getActiveLoadSessionId()) {
      showLoader(false);
      setState('player.pausedAt', 0);
    }

    // Only the current load owns the play-button state.
    if (isCurrentOwner()) {
      const hostConn = getState('network.hostConn');
      bus.emit('ui:play-btn-state', !hostConn || hasRoomCapability('playback.control'));
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
    queueItemId: null,
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

    // Demo tracks are addressed by demo.currentTrackIndex, never by a fake
    // queue occurrence. They therefore do not publish a ResidentFile owner.
    batchSetState({ 'transfer.meta': null, 'files.current': null });
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
    setState('files.current', null);
    transition({ type: 'DECODE_ERROR' });
    throw err;
  } finally {
    if (myLoadId === getActiveLoadSessionId()) {
      showLoader(false);
      setState('player.pausedAt', 0);
    }
  }
}

function markFailedAndAdvance(failedQueueItemId: QueueItemId): void {
  const failedItem = getQueueItemById(failedQueueItemId);
  if (!failedItem || getCurrentQueueItemId() !== failedQueueItemId) return;

  broadcastSystemMessage('chat.decode_skip_system_message');
  markTrackFailed(getTrackKeyFromItem(failedItem));

  const playlist = getState('playlist.items') || [];
  const playableCount = playlist.reduce(
    (count, item) => count + (isTrackFailed(getTrackKeyFromItem(item)) ? 0 : 1),
    0,
  );
  if (playableCount === 0) {
    showToast(t('error.all_tracks_failed'));
    clearFailedTracks();
    stopAllMedia();
    setCurrentAudioBuffer(null);
    setPlaybackTrackMeta(null);
    selectQueueItemById(null);
    setState('files.current', null);
    setState('player.pausedAt', 0);
    setPlaybackIdle();
    transition({ type: 'PAUSE', time: 0, queueItemId: null, endOfPlaylist: true });
    broadcast({
      type: MSG.PAUSE,
      time: 0,
      queueItemId: null,
      endOfPlaylist: true,
      reason: 'end-of-playlist',
    });
    return;
  }

  const advanceEpoch = getCurrentLoadEpoch();
  setManagedTimer(
    'decode-fail-advance',
    () => {
      if (
        !isCurrentLoadEpoch(advanceEpoch) ||
        getCurrentQueueItemId() !== failedQueueItemId ||
        !getQueueItemById(failedQueueItemId)
      ) {
        log.debug('[Decode] Skipping auto-advance because queue ownership changed');
        return;
      }

      void import('./playlist.ts').then(
        ({ getShuffleNextPlayableQueueItemId, playNextTrack, playTrack }) => {
          const livePlaylist = getState('playlist.items') || [];
          const failedIndex = findQueueItemIndex(failedQueueItemId, livePlaylist);
          if (failedIndex < 0 || getCurrentQueueItemId() !== failedQueueItemId) return;

          const isGoodCandidate = (queueItemId: QueueItemId): boolean => {
            const item = getQueueItemById(queueItemId, livePlaylist);
            return (
              !!item &&
              queueItemId !== failedQueueItemId &&
              !isTrackFailed(getTrackKeyFromItem(item))
            );
          };

          let targetQueueItemId: QueueItemId | null = null;
          const preloadedQueueItemId = getState('preload.nextQueueItemId');
          if (preloadedQueueItemId && isGoodCandidate(preloadedQueueItemId)) {
            targetQueueItemId = preloadedQueueItemId;
          }

          if (!targetQueueItemId && getState('playlist.isShuffle')) {
            targetQueueItemId = getShuffleNextPlayableQueueItemId((queueItemId) =>
              isGoodCandidate(queueItemId),
            );
          }

          if (!targetQueueItemId && !getState('playlist.isShuffle')) {
            const repeatMode = getState('playlist.repeatMode');
            const maxProbe =
              repeatMode === 1 ? livePlaylist.length : livePlaylist.length - 1 - failedIndex;
            for (let probe = 1; probe <= maxProbe; probe++) {
              const candidate = livePlaylist[(failedIndex + probe) % livePlaylist.length];
              if (candidate && isGoodCandidate(candidate.queueItemId)) {
                targetQueueItemId = candidate.queueItemId;
                break;
              }
            }
          }

          if (targetQueueItemId) {
            void playTrack(targetQueueItemId);
          } else {
            playNextTrack();
          }
        },
      );
    },
    600,
  );
}

// Guest decoders can reject a track the host can play. An operator report may
// advance immediately; non-operator reports require two connected peers so a
// single guest cannot turn a decode report into room-wide skip control. Stale
// and duplicate reports are ignored. In a single-guest room the host therefore
// continues until an operator skips or the track ends.
const NON_OP_DECODE_FAILURE_QUORUM = 2;
const _reportedDecodeFailures = new Map<QueueItemId, Set<string>>();
const _advancedGuestDecodeFailureTracks = new Set<QueueItemId>();

function getConnectedDecodeReporter(peerId: string) {
  return getState('network.connectedPeers').find(
    (peer) => peer.id === peerId && peer.status === 'connected',
  );
}

function rememberDecodeFailureReport(peerId: string, queueItemId: QueueItemId): Set<string> {
  let reports = _reportedDecodeFailures.get(queueItemId);
  if (!reports) {
    reports = new Set<string>();
    _reportedDecodeFailures.set(queueItemId, reports);
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

function advanceFromGuestDecodeFailure(queueItemId: QueueItemId): void {
  if (_advancedGuestDecodeFailureTracks.has(queueItemId)) return;
  _advancedGuestDecodeFailureTracks.add(queueItemId);
  markFailedAndAdvance(queueItemId);
}

function handleGuestDecodeFailed(data: Record<string, unknown>, conn: DataConnection): void {
  if (getState('network.hostConn')) return;

  const peerId = conn?.peer;
  if (!peerId) return;
  const peer = getConnectedDecodeReporter(peerId);
  if (!peer) return;

  const queueItemId = data.queueItemId;
  if (
    typeof queueItemId !== 'string' ||
    queueItemId !== getCurrentQueueItemId() ||
    !getQueueItemById(queueItemId)
  ) {
    log.debug('[Decode] Ignored stale GUEST_DECODE_FAILED queue occurrence');
    return;
  }

  const existingReports = _reportedDecodeFailures.get(queueItemId);
  if (existingReports?.has(peerId)) {
    log.debug(`[Decode] Duplicate decode-failed from ${peerId} for ${queueItemId}`);
    return;
  }
  const reports = rememberDecodeFailureReport(peerId, queueItemId);

  if (verifyOperator(conn, data)) {
    log.info(`[Decode] OP reported decode failure for ${queueItemId}; advancing room`);
    advanceFromGuestDecodeFailure(queueItemId);
    return;
  }

  const nonOpReports = countConnectedNonOpDecodeReports(reports);
  if (nonOpReports < NON_OP_DECODE_FAILURE_QUORUM) {
    log.warn(
      `[Decode] Holding non-OP decode-failed for ${queueItemId}: ${nonOpReports}/${NON_OP_DECODE_FAILURE_QUORUM} reports`,
    );
    notifyOperatorsOfHeldDecodeFailure();
    return;
  }

  log.info(`[Decode] Non-OP decode failure quorum reached for ${queueItemId}; advancing room`);
  advanceFromGuestDecodeFailure(queueItemId);
}

export function initDecodeHandlers(): void {
  registerHandlers({
    [MSG.GUEST_DECODE_FAILED]: handleGuestDecodeFailed,
  });

  bus.on('state:playlist.currentQueueItemId', () => {
    _reportedDecodeFailures.clear();
    _advancedGuestDecodeFailureTracks.clear();
  });
}

// ─── Load Preloaded Track ───────────────────────────────────────────

function exactPreloadIdentity(
  ready: Readonly<ResidentFile>,
  targetQueueItemId: QueueItemId,
): boolean {
  if (
    ready.queueItemId !== targetQueueItemId ||
    !Number.isSafeInteger(ready.sessionId) ||
    ready.sessionId <= 0
  ) {
    return false;
  }
  if (getState('preload.ready') !== ready) return false;
  if (getState('preload.nextQueueItemId') !== targetQueueItemId) return false;

  const activeTarget = getState('preload.activeTarget');
  if (
    activeTarget &&
    (activeTarget.queueItemId !== targetQueueItemId || activeTarget.sessionId !== ready.sessionId)
  ) {
    return false;
  }

  const playlistItem = getQueueItemById(targetQueueItemId);
  if (!playlistItem) return false;
  if (playlistItem.file && playlistItem.file !== ready.blob) return false;
  if (playlistItem.name && playlistItem.name !== ready.name) return false;
  return true;
}

function rejectMismatchedPreload(
  ready: Readonly<ResidentFile>,
  targetQueueItemId: QueueItemId,
): void {
  log.warn(
    `[Preload] Cached blob identity does not match queue item ${targetQueueItemId}; requesting fresh bytes`,
  );

  if (getState('preload.ready') === ready) {
    setState('preload.ready', null);
    const activeTarget = getState('preload.activeTarget');
    if (
      activeTarget?.queueItemId === ready.queueItemId &&
      activeTarget.sessionId === ready.sessionId
    ) {
      setState('preload.activeTarget', null);
    }
    if (getState('preload.nextQueueItemId') === ready.queueItemId) {
      setState('preload.nextQueueItemId', null);
    }
    discardResidentStoredFileAdmission(ready.blob);
  }

  const hostConn = getState('network.hostConn');
  const item = getQueueItemById(targetQueueItemId);
  const indexHint = findQueueItemIndex(targetQueueItemId);
  if (!hostConn?.open || !item || indexHint < 0) return;

  setPendingRecoveryTarget({
    queueItemId: targetQueueItemId,
    indexHint,
    name: item.name,
  });
  const owner = beginFileRequest(hostConn, targetQueueItemId);
  sendFileRequest(owner, {
    type: MSG.REQUEST_CURRENT_FILE,
    name: item.name,
    reason: 'preload_identity_mismatch',
  });
}

function requestFreshQueueItem(queueItemId: QueueItemId, reason: string): void {
  const hostConn = getState('network.hostConn');
  const item = getQueueItemById(queueItemId);
  const indexHint = findQueueItemIndex(queueItemId);
  if (!hostConn?.open || !item || indexHint < 0) return;
  setPendingRecoveryTarget({ queueItemId, indexHint, name: item.name });
  const owner = beginFileRequest(hostConn, queueItemId);
  sendFileRequest(owner, {
    type: MSG.REQUEST_CURRENT_FILE,
    name: item.name,
    reason,
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
  queueItemId: QueueItemId,
  loadEpoch?: number,
): Promise<boolean> {
  const ready = getState('preload.ready');
  const myEpoch = loadEpoch ?? getCurrentLoadEpoch();

  if (!ready || ready.queueItemId !== queueItemId) {
    log.warn('[Preload] No matching preloaded resident found');
    if (getCurrentQueueItemId() === queueItemId) {
      requestFreshQueueItem(queueItemId, 'preload_resident_missing');
    }
    return false;
  }
  if (getCurrentQueueItemId() !== queueItemId || !getQueueItemById(queueItemId)) {
    return false;
  }
  if (!exactPreloadIdentity(ready, queueItemId)) {
    rejectMismatchedPreload(ready, queueItemId);
    return false;
  }

  const localBlob = ready.blob;
  const ownsPublishedTarget = (): boolean => {
    const resident = getState('files.current');
    return (
      resident?.queueItemId === queueItemId &&
      resident.sessionId === ready.sessionId &&
      resident.blob === localBlob &&
      getCurrentQueueItemId() === queueItemId &&
      !!getQueueItemById(queueItemId) &&
      (loadEpoch === undefined || isCurrentLoadEpoch(myEpoch)) &&
      !isExternalOwner()
    );
  };
  const activationOwner = beginPreloadActivation(myEpoch, queueItemId, ready.sessionId);
  let published = false;
  const ownsTarget = (): boolean =>
    isCurrentPreloadActivation(activationOwner) &&
    activationOwner.queueItemId === queueItemId &&
    activationOwner.sessionId === ready.sessionId &&
    getCurrentQueueItemId() === queueItemId &&
    !!getQueueItemById(queueItemId) &&
    (loadEpoch === undefined || isCurrentLoadEpoch(myEpoch)) &&
    exactPreloadIdentity(ready, queueItemId) &&
    !isExternalOwner();

  try {
    if (!isSystemAudioActive()) {
      await Promise.race([initAudio(), delay(2000)]);
      if (getAudioContext().state !== 'running') await ensureRunning();
    }

    if (!ownsTarget()) {
      finishPreloadActivation(activationOwner);
      if (isExternalOwner()) {
        setPendingPlayTime(undefined);
        showLoader(false);
      }
      return false;
    }

    if (getCurrentAudioBuffer()) setCurrentAudioBuffer(null);

    const priorResident = getState('files.current');
    if (priorResident && priorResident.blob !== localBlob) {
      if (getState('files.current') === priorResident) setState('files.current', null);
      discardResidentStoredFileAdmission(priorResident.blob);
    }

    log.debug('[Preload] Decoding audio for Buffer Mode...');
    showToast(t('toast.decoding_audio'));

    const decoded = await decodeBlobToAudioBuffer(localBlob, 'preload', ready.name, ownsTarget);
    const audioBuffer = decoded.audioBuffer;
    try {
      if (!ownsTarget()) {
        log.debug('[Preload] Queue/session/epoch owner changed during decode');
        return false;
      }

      const indexHint = findQueueItemIndex(queueItemId);
      const item = getQueueItemById(queueItemId);
      if (indexHint < 0 || !item) return false;

      if (
        priorResident &&
        (priorResident.queueItemId !== queueItemId || priorResident.sessionId !== ready.sessionId)
      ) {
        cleanupStoredFile(
          priorResident.queueItemId,
          priorResident.name,
          false,
          priorResident.sessionId,
        );
      }

      const isAdmissionBoundPreload = encodedReceiveReservationIdForBlob(localBlob) !== undefined;
      const promoted = promoteStoredFileAdmission(
        queueItemId,
        ready.name,
        ready.sessionId,
        localBlob,
      );
      if (isAdmissionBoundPreload && !promoted) {
        throw new Error('PRELOAD_RESIDENT_PROMOTION_FAILED');
      }

      const mime = ready.mime || localBlob.type || 'application/octet-stream';
      const size = ready.size || localBlob.size;
      const activeTarget = getState('preload.activeTarget');
      const total =
        activeTarget?.queueItemId === queueItemId &&
        Number.isSafeInteger(activeTarget.total) &&
        Number(activeTarget.total) > 0
          ? Number(activeTarget.total)
          : Math.max(1, Math.ceil(size / CHUNK_SIZE));
      const resident: ResidentFile = {
        queueItemId,
        indexHint,
        name: ready.name,
        sessionId: ready.sessionId,
        blob: localBlob,
        mime,
        size,
        ...(ready.objectId ? { objectId: ready.objectId } : {}),
      };
      const meta: FileMeta = {
        queueItemId,
        indexHint,
        name: ready.name,
        sessionId: ready.sessionId,
        type: mime,
        mime,
        size,
        total,
        ...(ready.objectId ? { objectId: ready.objectId } : {}),
      };

      // Promotion is one state publication: consumers never observe the blob
      // under preload and current ownership simultaneously.
      batchSetState({
        'files.current': resident,
        'transfer.meta': meta,
        'preload.ready': null,
        'preload.activeTarget': null,
        'preload.nextQueueItemId': null,
        'preload.isPreloading': false,
      });
      setCurrentAudioBuffer(audioBuffer);
      setPlaybackTrackMeta(item);
      published = true;
    } finally {
      decoded.release();
    }

    finishPreloadActivation(activationOwner);
    transition({ type: 'DECODE_SUCCESS' });
    setEngineMode('buffer');

    if (Number.isFinite(audioBuffer.duration)) {
      bus.emit('ui:duration-update', audioBuffer.duration);
    }

    setPlaybackTransferState(TRANSFER_STATE.READY);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');
    clearManagedTimer('preloadWatchdog');

    const hostConn = getState('network.hostConn');
    if (hostConn?.open) {
      setManagedTimer(
        'playback-preload-auto-sync',
        () => {
          if (!ownsPublishedTarget()) return;
          log.debug('[Guest] Post-preload auto-sync');
          bus.emit('sync:force-resync');
        },
        500,
      );
    }

    const pendingTime = getPendingPlayTime();
    if (hostConn && pendingTime !== undefined && ownsPublishedTarget()) {
      const age = getPendingPlayTimeAge();
      const target = pendingTime + age;
      log.info(`[Preload] Activating playback at ${target.toFixed(1)}s (age=${age.toFixed(1)}s)`);
      await play(target);
      if (ownsPublishedTarget()) {
        setPendingPlayTime(undefined);
        bus.emit('sync:arm-initial');
        setManagedTimer(
          'playback-preload-host-sync',
          () => {
            if (ownsPublishedTarget()) {
              bus.emit('sync:request-immediate-ping');
            }
          },
          250,
        );
      }
    } else if (ownsPublishedTarget()) {
      bus.emit('sync:request-immediate-ping');
    }

    showLoader(false);
    return true;
  } catch (error: unknown) {
    if (published) {
      log.warn('[Preload] Post-publication side effect failed; resident remains active', error);
      showLoader(false);
      return true;
    }
    if (!isCurrentPreloadActivation(activationOwner)) {
      log.debug('[Preload] Stale activation failed after supersession; ignoring', error);
      return false;
    }
    if (!ownsTarget()) {
      finishPreloadActivation(activationOwner);
      if (isExternalOwner()) {
        setPendingPlayTime(undefined);
        showLoader(false);
      }
      return false;
    }
    if (isDecodeSupersededError(error)) {
      log.debug(`[Preload] ${error.message}`);
      finishPreloadActivation(activationOwner);
      return false;
    }

    finishPreloadActivation(activationOwner);
    setPendingPlayTime(undefined);
    log.error('[Preload] Activation failed:', error);
    showLoader(false);
    transition({ type: 'DECODE_ERROR' });
    showToast(t('transfer.preload_fail'));

    if (getState('preload.ready') === ready) {
      batchSetState({
        'preload.ready': null,
        'preload.activeTarget': null,
        'preload.nextQueueItemId': null,
        'preload.isPreloading': false,
      });
      discardResidentStoredFileAdmission(localBlob);
    }
    clearManagedTimer('preloadWatchdog');

    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      markFailedAndAdvance(queueItemId);
      return false;
    }

    const memoryLimited = isAudioDecodeAdmissionError(error);
    if (memoryLimited) {
      markTrackFailed(getTrackKeyFromItem(getQueueItemById(queueItemId)));
      sendToHost({ type: MSG.GUEST_DECODE_FAILED, queueItemId });
      return false;
    }

    const failureCount = (getState('player.decodeFailureCount') || 0) + 1;
    setState('player.decodeFailureCount', failureCount);
    if (failureCount >= 2) {
      log.warn('[Preload] Activation failed twice for the same queue item');
      markTrackFailed(getTrackKeyFromItem(getQueueItemById(queueItemId)));
      sendToHost({ type: MSG.GUEST_DECODE_FAILED, queueItemId });
      return false;
    }

    requestFreshQueueItem(queueItemId, 'preload_activation_failed');
    return false;
  }
}

// ─── Clear Previous Track State ─────────────────────────────────────

// ─── Clear Previous Track State ────────────────────────────────────

export function clearPreviousTrackState(reason = ''): void {
  log.debug(`[State Clear] Clearing previous track state. Reason: ${reason}`);

  const currentResident = getState('files.current');
  const transferMeta = getState('transfer.meta');
  const ownedQueueItemId =
    currentResident?.queueItemId ?? transferMeta?.queueItemId ?? getCurrentQueueItemId();
  if (
    reason === 'redundant-sync' &&
    ownedQueueItemId &&
    getLastClearedQueueItemId() === ownedQueueItemId
  ) {
    log.debug(`[State Clear] Skipping redundant clear for: ${ownedQueueItemId}`);
    return;
  }
  setLastClearedQueueItemId(ownedQueueItemId);

  clearManagedTimer('chunkWatchdog');
  clearManagedTimer('prepareWatchdog');
  if (reason === 'redundant-sync') return;

  batchSetState({
    'transfer.receivedCount': 0,
    'transfer.meta': null,
    'files.current': null,
  });

  if (getCurrentAudioBuffer()) {
    log.debug('[State Clear] Clearing currentAudioBuffer');
    setCurrentAudioBuffer(null);
  }
  stopPlayerNode();

  if (reason !== 'new-session-start') {
    setPendingPlayTime(undefined);
  }

  const playback = getPlaybackModeActivity();
  if (isPlaybackNonIdleFile(playback) && !isFilePipelineBusyForPlay()) {
    setPlaybackIdle();
  }

  setState('preload.ackSent', new Map());

  if (currentResident) {
    const ready = getState('preload.ready');
    const residentIsAlsoPreload =
      ready?.blob === currentResident.blob &&
      ready.queueItemId === currentResident.queueItemId &&
      ready.sessionId === currentResident.sessionId;
    if (!residentIsAlsoPreload) {
      postCommand({
        command: 'STORAGE_RESET',
        queueItemId: currentResident.queueItemId,
        sessionId: currentResident.sessionId,
        isPreload: false,
      });
      cleanupStoredFile(
        currentResident.queueItemId,
        currentResident.name,
        false,
        currentResident.sessionId,
      );
    }
  }
}

// ─── Finalize Guest File (after download) ───────────────────────────

// ─── Finalize Guest File (after download) ─────────────────────────

export async function finalizeGuestFile(
  file: File | Blob,
  queueItemId: QueueItemId,
  sessionId: number,
): Promise<void> {
  const itemAtEntry = getQueueItemById(queueItemId);
  const metaAtEntry = getState('transfer.meta');
  if (
    !itemAtEntry ||
    getCurrentQueueItemId() !== queueItemId ||
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    metaAtEntry?.queueItemId !== queueItemId ||
    metaAtEntry.sessionId !== sessionId
  ) {
    log.debug('[Guest] Ignored finalize for stale queue/session owner');
    return;
  }

  if (isExternalOwner()) {
    log.debug('[Guest] finalizeGuestFile aborted - external playback mode active');
    setPlaybackTransferState(TRANSFER_STATE.IDLE);
    postCommand({ command: 'STORAGE_RESET', queueItemId, sessionId, isPreload: false });
    showLoader(false);
    return;
  }

  log.debug('[Guest] Finalizing with Buffer Mode...');
  const myLoadId = incrementLoadSessionId();
  const myTransferSid = sessionId;
  const isAdmissionBoundFile = encodedReceiveReservationIdForBlob(file) !== undefined;
  const detachedPreviousBuffer = getCurrentAudioBuffer();
  const detachedPreviousResident = getState('files.current');
  const ownsTarget = (): boolean => {
    const liveMeta = getState('transfer.meta');
    return (
      getActiveLoadSessionId() === myLoadId &&
      getState('transfer.localSessionId') === myTransferSid &&
      getCurrentQueueItemId() === queueItemId &&
      !!getQueueItemById(queueItemId) &&
      liveMeta?.queueItemId === queueItemId &&
      liveMeta.sessionId === myTransferSid &&
      !isExternalOwner()
    );
  };

  showLoader(true, t('error.audio_memory'));

  try {
    await initAudio();
    if (getAudioContext().state !== 'running') await ensureRunning();

    if (!ownsTarget()) {
      log.debug('[Guest] Stale finalize before decode');
      return;
    }

    if (detachedPreviousBuffer) setCurrentAudioBuffer(null);
    const liveMeta = getState('transfer.meta');
    const fileName =
      (typeof File !== 'undefined' && file instanceof File ? file.name : '') ||
      liveMeta?.name ||
      itemAtEntry.name;

    const decoded = await decodeBlobToAudioBuffer(file, 'guest-finalize', fileName, ownsTarget);
    const audioBuffer = decoded.audioBuffer;
    try {
      if (!ownsTarget()) {
        log.debug('[Guest] Stale finalize after decode');
        return;
      }

      const indexHint = findQueueItemIndex(queueItemId);
      const item = getQueueItemById(queueItemId);
      const meta = getState('transfer.meta');
      if (
        indexHint < 0 ||
        !item ||
        meta?.queueItemId !== queueItemId ||
        meta.sessionId !== myTransferSid
      ) {
        return;
      }

      const retained = retainStoredFileAdmission(queueItemId, fileName, false, myTransferSid, file);
      if (isAdmissionBoundFile && !retained) {
        throw new Error('CURRENT_RESIDENT_ADMISSION_FAILED');
      }
      if (!retained) {
        log.warn(
          `[Guest] Finalized file has no matching resident admission: ${queueItemId} (SID ${myTransferSid})`,
        );
      }

      const mime = meta.mime || file.type || 'application/octet-stream';
      const size = file.size;
      const metaTotal = Number(meta.total);
      const publishedMeta: FileMeta = {
        ...meta,
        queueItemId,
        indexHint,
        name: fileName,
        sessionId: myTransferSid,
        type: meta.type || mime,
        mime,
        size,
        total:
          Number.isSafeInteger(metaTotal) && metaTotal > 0
            ? metaTotal
            : Math.max(1, Math.ceil(size / CHUNK_SIZE)),
      };
      const resident: ResidentFile = {
        queueItemId,
        indexHint,
        name: fileName,
        sessionId: myTransferSid,
        blob: file,
        mime,
        size,
        ...(meta.objectId ? { objectId: meta.objectId } : {}),
      };
      batchSetState({ 'transfer.meta': publishedMeta, 'files.current': resident });
      setCurrentAudioBuffer(audioBuffer);
      setPlaybackTrackMeta(item);
    } finally {
      decoded.release();
    }

    transition({ type: 'DECODE_SUCCESS' });
    setEngineMode('buffer');

    if (Number.isFinite(audioBuffer.duration)) {
      bus.emit('ui:duration-update', audioBuffer.duration);
    }
    setPlaybackTransferState(TRANSFER_STATE.READY);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');

    const hostConn = getState('network.hostConn');
    const pendingTime = getPendingPlayTime();
    if (hostConn && pendingTime !== undefined && ownsTarget()) {
      const age = getPendingPlayTimeAge();
      const target = pendingTime + age;
      log.debug(`[Guest] Pending play at ${target.toFixed(1)}s (age=${age.toFixed(1)}s)`);
      await play(target);
      if (ownsTarget()) {
        setPendingPlayTime(undefined);
        bus.emit('sync:arm-initial');
        setManagedTimer(
          'playback-finalize-host-sync',
          () => {
            if (ownsTarget()) {
              bus.emit('sync:request-immediate-ping');
            }
          },
          250,
        );
      }
    }

    if (ownsTarget()) {
      bus.emit('ui:play-btn-state', !hostConn || hasRoomCapability('playback.control'));
    }
  } catch (error: unknown) {
    if (!ownsTarget()) {
      log.debug('[Guest] Decode failed for a superseded queue/session owner');
      return;
    }
    if (isDecodeSupersededError(error)) {
      log.debug(`[Guest] ${error.message}`);
      return;
    }

    log.error('[Guest] Decoding failed', error);
    const memoryLimited = isAudioDecodeAdmissionError(error);
    transition({ type: 'DECODE_ERROR' });
    setPlaybackTransferState(TRANSFER_STATE.IDLE);
    setState('transfer.receivedCount', 0);

    const failureCount = (getState('player.decodeFailureCount') || 0) + 1;
    setState('player.decodeFailureCount', failureCount);

    if (memoryLimited || failureCount >= 2) {
      showToast(t('error.local_decode_wait'));
      markTrackFailed(getTrackKeyFromItem(getQueueItemById(queueItemId)));
      sendToHost({ type: MSG.GUEST_DECODE_FAILED, queueItemId });
      return;
    }

    showToast(t('error.audio_decode_fail'));
    const indexHint = findQueueItemIndex(queueItemId);
    const item = getQueueItemById(queueItemId);
    if (indexHint >= 0 && item) {
      setPendingRecoveryTarget({ queueItemId, indexHint, name: item.name });
    }
    sendRecoveryRequest(0);
  } finally {
    if (
      detachedPreviousBuffer &&
      !getCurrentAudioBuffer() &&
      detachedPreviousResident?.queueItemId === queueItemId &&
      detachedPreviousResident.sessionId === myTransferSid &&
      ownsTarget()
    ) {
      setCurrentAudioBuffer(detachedPreviousBuffer);
    }
    showLoader(false);
  }
}
