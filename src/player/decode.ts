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
import { BlobURLManager } from '../core/blob-manager.ts';
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
import { postCommand, cleanupStoredFile } from '../storage/storage.ts';
import { broadcastFileDebounced } from '../storage/transfer.ts';
import { shareRemoteFileIfNeeded } from '../share/remote-share.ts';
import type { AnyProtocolMsg, TrackMeta } from '../types/index.ts';
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

import { isFilePipelineBusyForPlay, play, stopAllMedia, stopPlayerNode } from './transport.ts';

import { getAudioContext, ensureRunning } from '../audio/context.ts';
import { showToast, showLoader } from '../ui/toast.ts';
import { transition } from './lifecycle.ts';
import { isDemoTrackName } from '../demo/tracks.ts';

// ─── Decode Timeout Helper ─────────────────────────────────────────
// 10s is a generous upper bound for legitimate audio/video decoding. Normal
// MP3/AAC decodes in <500ms; lossless FLAC in a few seconds; even a 30-hour
// podcast decodes fine because the browser streams-decodes. What DOES fall
// into the timeout bucket: pathological bitrates (e.g., 50,000 kbps WAV),
// corrupt headers, or codec/container mismatches that cause the decoder to
// hang. In those cases we'd rather skip than freeze the tab.

const DECODE_TIMEOUT_MS = 10_000;
const DECODE_TIMEOUT_TAG = '__decode_timeout__';

// Preload-activation owner handle (mechanism M4 in
// docs/design/playback-concurrency-invariants.md). Exists solely so a
// SUPERSEDED activation cannot clear the playPreloadedInProgress flag the
// superseding one set (compare-before-clear). Every begin takes ownership;
// finish is a no-op unless the caller still owns the activation. The flag has
// one other sanctioned writer: stopAllMedia's flag-only clear (contract C4) —
// benign because finishPreloadActivation is idempotent. Pinned by
// __tests__/concurrency-invariants.test.ts (pins a, f).
//
// Stage B (PLAYER-SPRAWL): the former private `_preloadActivationSeq` counter
// is gone — the handle records the owning LOAD EPOCH (M1) instead. Ownership
// comparison is by handle identity, NOT by epoch equality: comparing epochs
// would let (a) an unrelated epoch bump (watchdog fire mid-activation) strand
// the flag true forever, and (b) two begins that erroneously share one epoch
// stomp each other's clear — handle identity preserves the exact pre-Stage-B
// compare-before-clear semantics while the epoch field keeps the owner
// attributable to its logical run. Every prod begin receives a FRESHLY
// allocated epoch (all three loadPreloadedTrack call sites bump first); the
// warn in begin trips if a future caller skips its entry-point bump.
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

async function decodeWithTimeout(arrayBuffer: ArrayBuffer, label = 'decode'): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    // One-shot timeout race for decodeAudioData; cleared in finally below.
    // setManagedTimer is name-keyed and not suited for per-call concurrent decodes.
    timeoutId = globalThis.setTimeout(() => {
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

    // Dispose old buffer
    if (getCurrentAudioBuffer()) {
      setCurrentAudioBuffer(null);
    }

    if (myLoadId !== getActiveLoadSessionId()) {
      log.debug('[Load] Stale loading session detected. Aborting.');
      return false;
    }

    // Load into state
    setCurrentAudioBuffer(audioBuffer);
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
    log.error(err);
    // Clear corrupt/stale blob so recovery doesn't re-serve it to guests
    setState('files.currentFileBlob', null);

    const timedOut = isDecodeTimeout(err);
    // Lifecycle: decode failed → FAILED. markTrackFailed
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
    return false;
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

    BlobURLManager.create(file);

    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await decodeWithTimeout(arrayBuffer, 'demo-load');

    if (loadEpoch !== undefined && !isCurrentLoadEpoch(myEpoch)) {
      if (myLoadId === getActiveLoadSessionId()) showLoader(false);
      return;
    }

    if (isExternalOwner()) {
      log.debug('[Demo] Aborted - external playback mode took ownership after decode');
      return;
    }

    if (getCurrentAudioBuffer()) setCurrentAudioBuffer(null);
    if (myLoadId !== getActiveLoadSessionId()) return;

    setCurrentAudioBuffer(audioBuffer);
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
    BlobURLManager.confirm();
    bus.emit('ui:play-btn-state', true);
  } catch (err: unknown) {
    log.error('[Demo] Load failed', err);
    setState('files.currentFileBlob', null);
    transition({ type: isDecodeTimeout(err) ? 'DECODE_TIMEOUT' : 'DECODE_ERROR' });
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
    for (let probe = 1; probe <= playlist.length; probe++) {
      const candidate = (failedIdx + probe) % playlist.length;
      if (isGoodCandidate(candidate)) {
        nextIdx = candidate;
        break;
      }
    }
  }

  if (nextIdx !== -1 || shouldUseShuffleOrder) {
    // Snapshot the load epoch at scheduling time. If a user action (track
    // click, next/prev) allocates a new epoch during the 600ms backoff, abort
    // — playTrack already cleared this timer at its entry, but the snapshot
    // guards the timer-fire-vs-clear race (clearManagedTimer just above
    // the new playTrack's allocation happens *after* the timer's setTimeout
    // body has already begun executing in some browsers' microtask ordering).
    const advanceEpoch = getCurrentLoadEpoch();
    setManagedTimer(
      'decode-fail-advance',
      () => {
        if (!isCurrentLoadEpoch(advanceEpoch)) {
          log.debug('[Decode] Skipping auto-advance — load epoch advanced (user action superseded)');
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

// Host-side handler for guest's "I can't decode this track" report. OP
// reports trigger the same advance path the host uses for its own decode
// failures. Non-OP reports are held unless independent guests corroborate,
// so one failing device waits locally instead of getting room-wide skip power.
// Stale reports (host already advanced) are ignored.
//
// This is a data-plane recovery message that any guest (including non-OP)
// may send, because iOS Safari can fail to decode a file Chrome can play.
// However, a single non-OP report must not get room-wide track control: that
// is equivalent to a one-frame "skip current track" DoS. OP reports still
// act immediately; non-OP reports require independent corroboration.
//
// In a host + single-guest room the quorum is intentionally unreachable:
// the host keeps playing while only the failing guest sees the local-wait
// toast, and the host advances at track end (or via manual skip after the
// operator-only toast prompt). Earlier "advance when sole non-OP fails"
// effectively let one device act as a room-wide skipper.
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

/**
 * Activate the preloaded blob (decode → swap into the live buffer).
 *
 * Returns `true` only when the activation fully succeeded (buffer swapped,
 * lifecycle at READY). Every abort/supersede/failure path returns `false` so
 * callers that follow up with play()+broadcast (host fast path in
 * playlist.ts) can bail instead of broadcasting a PLAY for audio the host
 * never loaded (SA-05, docs/scenario-audit-2026-06-10.md). Mirrors the
 * boolean contract of loadAndBroadcastFile above.
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
      // Preserve pendingPlayTime — it belongs to the LATEST MSG.PLAY (which
      // updated currentTrackIndex), so the matching loadPreloadedTrack call
      // for the current target needs it. Clearing here would leave the
      // correct-track decode without a play signal, leaving the guest
      // silently stalled with the blob loaded but never started — exactly
      // the "downloads but doesn't sync-play" symptom on remote-share track
      // switching.
      return false;
    }

    if (isExternalOwner()) {
      log.debug('[Preload] Activation aborted - external playback mode active');
      finishPreloadActivation(activationOwner);
      setPendingPlayTime(undefined);
      showLoader(false);
      return false;
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

    const activeMeta = localMeta || getState('transfer.meta');

    // Storage rotation — release the previous track's stored chunks before
    // overwriting currentFileBlob. handleFileStart already does this for
    // the main-transfer path; the preload-promoted path didn't, which
    // accumulated one ramstore slot per track and grew the heap unbounded
    // until iOS killed the tab.
    //
    // We attempt cleanup with both isPreload variants because the prior
    // track's slot could live in either pool (came via main transfer
    // vs. preload promote). cleanupStoredFile is idempotent — the
    // wrong-pool call is a silent no-op.
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
        setPlaybackTrackMeta(playlist[targetIndex]);
      }
    }

    // Lifecycle: preload blob decoded → READY.
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
      // First-load case: a remote-share download finished but no MSG.PLAY
      // landed for this track (host had played BEFORE we joined / before
      // the encrypted blob was ready). Kick the sync ping immediately so
      // SYNC_PONG's bootstrap path can start playback at the host's
      // current position — otherwise we wait up to 1s for the next worker
      // tick and the user perceives a stuck-at-0:00 first track.
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
    finishPreloadActivation(activationOwner);
    setPendingPlayTime(undefined);
    log.error('[Preload] Activation failed:', e);
    showLoader(false);

    const timedOut = isDecodeTimeout(e);
    const meta = getState('transfer.meta');
    const name = (meta?.name as string) || '';
    // Lifecycle: preload decode failed → FAILED.
    transition({ type: timedOut ? 'DECODE_TIMEOUT' : 'DECODE_ERROR' });
    showToast(timedOut ? t('error.decode_timeout', { name }) : t('transfer.preload_fail'));

    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    setState('preload.nextTrackIndex', -1);
    clearManagedTimer('preloadWatchdog');

    const hostConn = getState('network.hostConn');
    const failedIdx = getState('playlist.currentTrackIndex');

    // HOST: this was the preloaded-fast-path activation of the host's own
    // file — there is no one to request recovery FROM (the old
    // sendToHost below was a silent no-op on host, leaving the host stuck
    // while guests played; SA-05). Route through the same
    // failed-mark + auto-advance path that loadAndBroadcastFile failures use.
    if (!hostConn) {
      markFailedAndAdvance(localBlob, failedIdx);
      return false;
    }

    // GUEST, decode timeout: the file itself is unplayable — asking host for
    // a recovery copy would just re-trigger the same timeout. Skip recovery
    // and wait for host to advance to the next track on its own.
    //
    // Also mark the track as failed so that a subsequent manual click on the
    // same entry (while still in this session) doesn't re-run the 10s timeout
    // loop. The failed-set is keyed by file identity (name+size+lastModified)
    // so uploading a different file with the same playlist slot still retries.
    if (timedOut) {
      const failedKey = getTrackKeyFromFile(localBlob);
      markTrackFailed(failedKey);
      return false;
    }

    // GUEST, non-timeout failure (e.g. partial download, network error) —
    // request recovery from host. The LOCAL pipeline's recovery has its own
    // retry ceiling, but a REMOTE guest's request now routes to a descriptor
    // re-send (recovery.ts) which re-triggers this very activation: bound the
    // loop at 2 attempts per track, or a persistent (codec) decode failure
    // would download the full file from R2 forever.
    const failureCount = (getState('player.decodeFailureCount') || 0) + 1;
    setState('player.decodeFailureCount', failureCount);
    if (failureCount >= 2) {
      log.warn('[Preload] Activation failed twice for the same track — marking failed, no re-request');
      markTrackFailed(getTrackKeyFromFile(localBlob));
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
  // Stale-audio recovery is lifecycle-driven; no separate timer needs clearing.

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

  // Reset active or pending file playback to idle — but NOT while the file
  // pipeline is mid-engagement (DOWNLOADING/AWAITING_PRELOAD/DECODING).
  // handleFilePrepare's fresh branch transitions the FSM to DOWNLOADING and
  // emits 'storage:clear-previous-track' ONE statement later; idling here
  // clobbered that just-written state, leaving lifecycle=IDLE for the whole
  // download. With the FSM disengaged, handlePlayMsg's DOWNLOADING defer-gate
  // never fired and its SA-03 no-buffer branch sent REQUEST_CURRENT_FILE on
  // the host's first PLAY mid-transfer — the host's unicast-from-0 response
  // then reset the partial download to 0% (DV-1, device-test find).
  const playback = getPlaybackModeActivity();
  if (isPlaybackNonIdleFile(playback) && !isFilePipelineBusyForPlay()) {
    setPlaybackIdle();
  }

  // Clear preload ack tracking (immutable — replace with new Set)
  setState('preload.ackSent', new Set());

  BlobURLManager.revoke();

  try {
    BlobURLManager.flushDeferred('clearPreviousTrackState');
  } catch {
    /* noop */
  }

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
    showLoader(false);
    return;
  }

  log.debug('[Guest] Finalizing with Buffer Mode...');
  const myLoadId = incrementLoadSessionId();
  showLoader(true, t('error.audio_memory'));

  try {
    await initAudio();
    if (getAudioContext().state !== 'running') await ensureRunning();

    if (isExternalOwner()) {
      log.debug('[Guest] Stale finalize (post-audio-init), aborting');
      setPlaybackTransferState(TRANSFER_STATE.IDLE);
      setPendingPlayTime(undefined);
      return;
    }

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
    if (isExternalOwner()) {
      log.debug('[Guest] Stale finalize (external mode after decode), aborting');
      setPlaybackTransferState(TRANSFER_STATE.IDLE);
      setPendingPlayTime(undefined);
      return;
    }

    if (getCurrentAudioBuffer()) {
      setCurrentAudioBuffer(null);
    }
    setCurrentAudioBuffer(audioBuffer);

    // Lifecycle: main-transfer file decoded → READY.
    transition({ type: 'DECODE_SUCCESS' });

    setState('files.currentFileBlob', file);
    setEngineMode('buffer');

    BlobURLManager.create(file);

    if (audioBuffer.duration && Number.isFinite(audioBuffer.duration)) {
      bus.emit('ui:duration-update', audioBuffer.duration);
    }
    BlobURLManager.confirm();

    // Reset guards
    setPlaybackTransferState(TRANSFER_STATE.READY);
    clearManagedTimer('prepareWatchdog');
    clearManagedTimer('chunkWatchdog');

    // Set track metadata from playlist (missing in download path — fixes title display)
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
    log.error('[Guest] Decoding failed', err);

    const timedOut = isDecodeTimeout(err);
    // Lifecycle: guest main-transfer decode failed → FAILED.
    transition({ type: timedOut ? 'DECODE_TIMEOUT' : 'DECODE_ERROR' });
    // Reset transfer state so recovery can start fresh (prevents infinite loop)
    setPlaybackTransferState(TRANSFER_STATE.IDLE);
    setState('transfer.receivedCount', 0);

    // Per-track decode failure counter. The first non-timeout failure may be
    // a rare chunk-loss case that recovery's re-fetch can fix. The second
    // (or any timeout) means the file is genuinely undecodable on this
    // device — iOS Safari can't decode mp4-as-mp3 even though host's Chrome
    // can. Tell host for OP/quorum handling, while this device stays idle and
    // waits for the next host-selected track.
    const failureCount = (getState('player.decodeFailureCount') || 0) + 1;
    setState('player.decodeFailureCount', failureCount);

    if (timedOut || failureCount >= 2) {
      showToast(t('error.local_decode_wait'));
      const failedIdx = getState('playlist.currentTrackIndex');
      if (failedIdx >= 0) {
        sendToHost({ type: MSG.GUEST_DECODE_FAILED, index: failedIdx });
      }
      return;
    }

    showToast(t('error.audio_decode_fail'));

    // First non-timeout failure: try recovery (3 attempts + backoff) for the
    // chunk-loss case. If decode still fails after recovery completes, the
    // counter trips on entry to this catch on the second pass.
    sendRecoveryRequest(0);
  } finally {
    showLoader(false);
  }
}
