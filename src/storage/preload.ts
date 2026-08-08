/**
 * MUSIXQUARE — Preload System
 *
 * Manages: Host-side preload scheduling, background transfer to peers,
 * Guest-side preload receive (start/chunk/end), preload-ack, play-preloaded.
 */

import { log } from '../core/log.ts';
import { SessionScope } from '../core/session-scope.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { batchSetState, getState, setState } from '../core/state.ts';
import { MSG, CHUNK_SIZE, DELAY, TRANSFER_STATE, PLAYBACK_STATE } from '../core/constants.ts';
import { nextSessionId, validateSessionId } from '../core/session.ts';
import { setManagedTimer, clearManagedTimer, delay } from '../core/timers.ts';
import {
  admitIncomingStoredFile,
  postCommand,
  readStoredFile,
  retainStoredFileAdmission,
} from './storage.ts';
import { registerHandlers, registerInboundRateLimitExemptionGuard } from '../network/protocol.ts';
import {
  beginFileRequest,
  completeFileRequest,
  sendFileRequest,
} from '../network/file-request-authority.ts';
import {
  broadcast,
  safeSend,
  sendToHost,
  canSendFileTo,
  filterEligiblePeers,
  isRemoteGuest,
} from '../network/peer.ts';
import {
  pumpChunksToPeers,
  isBulkTransferWritablePeer,
  isPeerConnectionCurrent,
} from './chunk-pump.ts';
import type { ConnectedPeer, DataConnection, ProtocolMsg, QueueItemId } from '../types/index.ts';
import { showLoader, showToast, updateLoader } from '../ui/toast.ts';
import {
  cancelRemoteFilePreload,
  preloadRemoteFileIfNeeded,
  prepareRemoteShareWait,
  promoteRemotePreloadWait,
  shouldWaitForRemoteShare,
} from '../share/remote-share.ts';
import { transition } from '../player/lifecycle.ts';
import {
  currentAudioBufferPcmBytes,
  liveAudioBufferPcmBytes,
  setPendingRecoveryTarget,
} from '../player/_state.ts';
import { isSystemAudioOwner, setPlaybackTrackMeta } from '../player/ownership.ts';
import { resolveDecodeMemoryBudget } from '../player/decode-admission.ts';
import {
  freezeFileDeliveryMode,
  isGuestR2FileDelivery,
  recordGuestFileDelivery,
} from '../share/file-delivery-policy.ts';
import {
  cancelProRoomPlaylistFilePreload,
  hasProRoomPlaylistFilePreload,
  preloadProRoomPlaylistFile,
} from '../pro-room/media-hooks.ts';
import { isArrayBuffer } from './transfer-shared.ts';

/**
 * One-switch rollback for the persistent-room R2 prefetch policy. Keep this
 * independent from the standard-room remote-share switch so operations can
 * shed either workload without disabling LAN preload.
 */
const PRO_ROOM_FILE_PRELOAD_ENABLED = true;

// ─── Reorder Buffer ──────────────────────────────────────────────────
// sessionId → Map(chunkIndex → Uint8Array)
const preloadReorderBuffer = new Map<number, Map<number, Uint8Array>>();
/** Queue identity bound to each buffered transfer session, including early chunks. */
const preloadQueueItemBySid = new Map<number, string>();
let latestPreloadSessionId = 0;
let lastPreloadUiSessionId = 0;
let lastPreloadUiPercent = -1;
const MAX_EARLY_PRELOAD_SESSIONS = 4;
const MAX_EARLY_PRELOAD_CHUNKS = 64;
const MAX_EARLY_PRELOAD_BYTES = 4 * 1024 * 1024;
let _activePlayPreloadedQueueItemId: string | undefined;
let _preloadScope: SessionScope | null = null;
/** Per-peer unicast preload abort controls (key: peerId).
 *  Tracks scope + sid + conn so cancelPreloadTransfer can send a targeted
 *  PRELOAD_ABORT to the receiving peer before disposing the scope. */
interface UnicastEntry {
  scope: SessionScope;
  sid: number;
  queueItemId: string;
  conn: DataConnection;
}
const _activePreloadUnicasts = new Map<string, UnicastEntry>();

interface PreloadIdentity {
  readonly sessionId: number;
  readonly queueItemId: string;
}

/**
 * Exact preload transfer selected by the latest authoritative PLAY_PRELOADED.
 *
 * queueItemId is the logical occurrence identity across reorder. The transfer
 * session keeps a late storage
 * completion attributable to the command that actually awaited it. `name` is
 * only a consistency veto; it never selects bytes by itself.
 */
let _awaitedPreloadIdentity: PreloadIdentity | null = null;

function retainedPcmBytesForReceive(): number {
  return resolveDecodeMemoryBudget().tier === 'ios'
    ? liveAudioBufferPcmBytes()
    : currentAudioBufferPcmBytes();
}

function createPreloadIdentity(sessionId: unknown, queueItemId: unknown): PreloadIdentity | null {
  if (
    typeof sessionId !== 'number' ||
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0 ||
    typeof queueItemId !== 'string' ||
    !queueItemId
  ) {
    return null;
  }
  return { sessionId, queueItemId };
}

function samePreloadIdentity(left: PreloadIdentity | null, right: PreloadIdentity | null): boolean {
  return (
    !!left &&
    !!right &&
    left.sessionId === right.sessionId &&
    left.queueItemId === right.queueItemId
  );
}

function identityFromMeta(
  meta: Readonly<{ sessionId?: unknown; queueItemId?: unknown }> | null,
): PreloadIdentity | null {
  return createPreloadIdentity(meta?.sessionId, meta?.queueItemId);
}

function isExactAwaitedPreload(identity: PreloadIdentity): boolean {
  if (!samePreloadIdentity(_awaitedPreloadIdentity, identity)) return false;
  const target = getState('playback.pendingRecoveryTarget');
  return (
    getState('playback.lifecycle') === PLAYBACK_STATE.AWAITING_PRELOAD &&
    getState('playlist.currentQueueItemId') === identity.queueItemId &&
    target?.queueItemId === identity.queueItemId
  );
}

function isCurrentPreloadSnapshot(identity: PreloadIdentity): boolean {
  const currentMeta = identityFromMeta(getState('preload.activeTarget'));
  return (
    identity.sessionId === latestPreloadSessionId && samePreloadIdentity(currentMeta, identity)
  );
}

function isPreloadCompletionPublishable(identity: PreloadIdentity): boolean {
  return isExactAwaitedPreload(identity) || isCurrentPreloadSnapshot(identity);
}

function reconcileAwaitedPreloadOnStart(identity: PreloadIdentity): void {
  const target = getState('playback.pendingRecoveryTarget');
  const lifecycle = getState('playback.lifecycle');
  const targetsIncomingSession =
    (lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD || lifecycle === PLAYBACK_STATE.DOWNLOADING) &&
    getState('playlist.currentQueueItemId') === identity.queueItemId &&
    target?.queueItemId === identity.queueItemId;

  if (targetsIncomingSession) {
    _awaitedPreloadIdentity = identity;
    return;
  }

  // A newer transfer for the same queue occurrence supersedes an older awaited
  // tuple even when the display filename happens to collide.
  if (
    _awaitedPreloadIdentity?.queueItemId === identity.queueItemId &&
    identity.sessionId > _awaitedPreloadIdentity.sessionId
  ) {
    _awaitedPreloadIdentity = null;
  }
}

// ─── Serialized Preload Transfers ─────────────────────────────────
// Let the current background transfer finish before starting its successor so
// guests can consume a partially completed preload without restarting it.
let _inFlightBackgroundTransfer: Promise<void> | null = null;
type BackgroundTransferTerminal = 'streaming' | 'completed' | 'cancelled';

/**
 * Outbound preload delivery owns a different lifetime from the host's local
 * preload cache. The cache is promoted into files.current as soon as the host
 * activates the track, while guests may still need the remainder of the same
 * transfer. Keeping this frozen owner separate lets that transfer reach END
 * without allowing a later queue occurrence or Blob to inherit its authority.
 */
interface BackgroundTransferOwner {
  readonly queueItemId: QueueItemId;
  readonly sessionId: number;
  readonly sourceBlob: File;
  readonly scope: SessionScope;
  readonly targets: readonly ConnectedPeer[];
  readonly abortedPeerIds: Set<string>;
  terminal: BackgroundTransferTerminal;
}

let _inFlightBackgroundOwner: BackgroundTransferOwner | null = null;

function abortBackgroundPeer(owner: BackgroundTransferOwner, peer: ConnectedPeer): void {
  if (owner.abortedPeerIds.has(peer.id)) return;
  owner.abortedPeerIds.add(peer.id);
  safeSend(peer.conn, {
    type: MSG.PRELOAD_ABORT,
    queueItemId: owner.queueItemId,
    sessionId: owner.sessionId,
  });
}

function cancelInFlightBackgroundTransfer(): void {
  const owner = _inFlightBackgroundOwner;
  if (!owner || owner.terminal !== 'streaming') return;

  // Claim the terminal transition before sending anything. END and ABORT can
  // therefore never both win for the same outbound transfer.
  owner.terminal = 'cancelled';
  owner.targets.forEach((peer) => abortBackgroundPeer(owner, peer));
  owner.scope.dispose();

  if (_inFlightBackgroundOwner === owner) _inFlightBackgroundOwner = null;
  if (_preloadScope === owner.scope) _preloadScope = null;
}

/**
 * Monotonic counter incremented on every schedulePreload/cancelPreloadTransfer
 * call. Each preloadNextTrack snapshot its myGeneration; after the serialization
 * await, it re-checks against the current _preloadGeneration. If a newer call
 * has come in (or a cancel has fired), the stale preloadNextTrack aborts.
 */
let _preloadGeneration = 0;

interface ProRoomPreloadOwner {
  readonly queueItemId: QueueItemId;
  readonly sessionId: number;
  promise: Promise<void>;
}

interface PendingProRoomPreloadHint {
  readonly roomId: string;
  readonly queueItemId: QueueItemId;
  readonly sessionId: number;
  readonly hostConn: DataConnection;
}

/**
 * PRO media never enters the legacy chunk pump. Each participant warms the
 * canonical private-R2 object itself, while this owner publishes the same
 * queue/session identity into the ordinary preload slot. Selecting the row
 * can therefore adopt an in-flight promise or a completed File without a
 * second GET.
 */
let _proRoomPreloadOwner: ProRoomPreloadOwner | null = null;
// Signaling can deliver the coordinator's one-shot warm hint before the
// member has projected that queue occurrence. Retain only the newest exact
// authority tuple and replay it once the playlist/runtime hooks are ready.
let _pendingProRoomPreloadHint: PendingProRoomPreloadHint | null = null;

/**
 * Clean up reorder buffers and session state for stale (non-current) sessions.
 */
const PRELOAD_SESSION_MAX = 20;

function cleanupStalePreloadSessions(keepSessionId: number): void {
  // Clean up reorder buffers for old sessions
  for (const sid of preloadReorderBuffer.keys()) {
    if (sid !== keepSessionId) {
      preloadReorderBuffer.delete(sid);
      preloadQueueItemBySid.delete(sid);
    }
  }
  // Clean up finalized/skipped session entries (immutable update)
  const sessionState = getState('preload.sessionState');
  const toRemove: number[] = [];
  for (const [sid, entry] of sessionState.entries()) {
    if (sid !== keepSessionId && (entry.finalized || entry.skipped)) {
      toRemove.push(sid);
    }
  }
  // Hard cap: evict numerically oldest beyond the active one
  if (sessionState.size - toRemove.length > PRELOAD_SESSION_MAX) {
    const sortedSids = [...sessionState.keys()].sort((a, b) => a - b);
    for (const sid of sortedSids) {
      if (sid !== keepSessionId && !toRemove.includes(sid)) {
        toRemove.push(sid);
        if (sessionState.size - toRemove.length <= PRELOAD_SESSION_MAX) break;
      }
    }
  }
  if (toRemove.length > 0) {
    const updated = new Map(sessionState);
    for (const sid of toRemove) {
      updated.delete(sid);
      preloadReorderBuffer.delete(sid);
      preloadQueueItemBySid.delete(sid);
      preloadQueueItemBySid.delete(sid);
      clearManagedTimer(`preload-admission-watchdog-${sid}`);
      postCommand({ command: 'STORAGE_RESET_SESSION', isPreload: true, sessionId: sid });
    }
    setState('preload.sessionState', updated);
  }
}

function abandonStalledPreloadSession(sessionId: number, reason: string): void {
  const session = getState('preload.sessionState').get(sessionId);
  if (!session || session.finalized || session.skipped) return;
  log.warn(
    `[Preload] ${reason}: releasing stalled session ${sessionId} (${session.progress}/${session.total})`,
  );
  const updated = new Map(getState('preload.sessionState'));
  updated.set(sessionId, { ...session, skipped: true });
  setState('preload.sessionState', updated);
  preloadReorderBuffer.delete(sessionId);
  preloadQueueItemBySid.delete(sessionId);
  clearManagedTimer(`preload-drain-${sessionId}`);
  clearManagedTimer(`preload-end-deferred-${sessionId}`);
  clearManagedTimer(`preload-admission-watchdog-${sessionId}`);
  postCommand({ command: 'STORAGE_RESET_SESSION', isPreload: true, sessionId });
}

// ─── Host: Cancel In-Flight Preload ─────────────────────────────────

/**
 * Cancel any in-flight preload transfer (host-only).
 * Called by clearPreloadState() during backward navigation to prevent stale
 * preload data from reaching guests after the host changes tracks.
 *
 * Send PRELOAD_ABORT before disposing each scope so receivers can release
 * partial buffers immediately. Because the channel is ordered, any chunk
 * already in flight arrives before the abort; later chunks are dropped by the
 * receiver's skipped-session guard.
 */
export function cancelPreloadTransfer(queueItemId?: QueueItemId): void {
  // Supersede any pending preloadNextTrack that is still awaiting a prior
  // serialized transfer — it will notice the generation mismatch after its
  // await and exit instead of starting a new (unwanted) transfer.
  _preloadGeneration++;

  cancelRemoteFilePreload('preload-transfer-cancelled', queueItemId);

  // Notify the exact peers that received PRELOAD_START before disposing the
  // transfer scope. This still works after local cache promotion clears its
  // ready/nextQueueItemId consumer fields.
  cancelInFlightBackgroundTransfer();

  // Unicast: each entry tracks its own (sid, conn). May differ from the
  // broadcast sid if a unicast was started for an earlier preload session
  // that's still streaming to a late-joiner.
  for (const entry of _activePreloadUnicasts.values()) {
    safeSend(entry.conn, {
      type: MSG.PRELOAD_ABORT,
      queueItemId: entry.queueItemId,
      sessionId: entry.sid,
    });
    entry.scope.dispose();
  }
  _activePreloadUnicasts.clear();

  if (_preloadScope) {
    _preloadScope.dispose();
    _preloadScope = null;
  }
  // Bump sessionId so any lingering async loop sees a mismatch and exits
  setState('preload.sessionId', nextSessionId());
}

/**
 * Drop guest receive high-water marks when a replacement host connection
 * establishes queue authority. Preload SIDs are host-runtime scoped, so the
 * new host must be free to begin again at SID 1.
 */
export function resetPreloadReceiveAuthority(): void {
  _preloadGeneration++;
  clearManagedTimer('preloadScheduleTimer');
  _awaitedPreloadIdentity = null;
  _activePlayPreloadedQueueItemId = undefined;
  _pendingProRoomPreloadHint = null;
  latestPreloadSessionId = 0;
  lastPreloadUiSessionId = 0;
  lastPreloadUiPercent = -1;

  const sessionIds = new Set<number>([
    ...preloadReorderBuffer.keys(),
    ...getState('preload.sessionState').keys(),
  ]);
  for (const sessionId of sessionIds) {
    clearManagedTimer(`preload-drain-${sessionId}`);
    clearManagedTimer(`preload-end-deferred-${sessionId}`);
    clearManagedTimer(`preload-admission-watchdog-${sessionId}`);
  }
  preloadReorderBuffer.clear();
  preloadQueueItemBySid.clear();

  cancelInFlightBackgroundTransfer();
  _preloadScope?.dispose();
  _preloadScope = null;
  _activePreloadUnicasts.forEach((entry) => entry.scope.dispose());
  _activePreloadUnicasts.clear();

  batchSetState({
    'preload.sessionId': 0,
    'preload.sessionState': new Map(),
    'preload.ackSent': new Map(),
    'preload.isPreloading': false,
    'preload.nextQueueItemId': null,
    'preload.activeTarget': null,
    'preload.ready': null,
  });
}

// ─── Host: Schedule Preload ─────────────────────────────────────────

/**
 * Schedule next track preload after a delay (host-only).
 *
 * Each call bumps the preload generation so any in-flight preloadNextTrack
 * that is still awaiting a prior serialized transfer will notice it has
 * been superseded and exit cleanly after its await resolves.
 */
export function schedulePreload(delayMs = 500): void {
  _preloadGeneration++;
  clearManagedTimer('preloadScheduleTimer');
  setManagedTimer(
    'preloadScheduleTimer',
    () => {
      preloadNextTrack();
    },
    delayMs,
  );
}

/** Reset the preload cache fields so the host fast path can't pick up a stale entry. */
function clearPreloadCacheState(): void {
  if (getState('room.context').kind === 'pro') {
    const ownerQueueItemId =
      _proRoomPreloadOwner?.queueItemId ??
      getState('preload.ready')?.queueItemId ??
      getState('preload.activeTarget')?.queueItemId;
    cancelProRoomPlaylistFilePreload(ownerQueueItemId);
    _proRoomPreloadOwner = null;
  }
  setState('preload.nextQueueItemId', null);
  setState('preload.isPreloading', false);
  setState('preload.ready', null);
  setState('preload.activeTarget', null);
}

function proRoomPreloadMeta(queueItemId: QueueItemId, sessionId: number) {
  const playlist = getState('playlist.items');
  const indexHint = playlist.findIndex((item) => item.queueItemId === queueItemId);
  const item = indexHint >= 0 ? playlist[indexHint] : null;
  if (!item || item.type !== 'file') return null;
  const size = item.file?.size ?? 0;
  const mime = item.file?.type ?? '';
  return {
    name: item.name,
    queueItemId,
    indexHint,
    mime,
    size,
    total: size > 0 ? Math.max(1, Math.ceil(size / CHUNK_SIZE)) : 1,
    sessionId,
  };
}

function isCurrentProRoomPreloadOwner(owner: ProRoomPreloadOwner): boolean {
  const context = getState('room.context');
  const target = getState('preload.activeTarget');
  return (
    _proRoomPreloadOwner === owner &&
    context.kind === 'pro' &&
    getState('preload.nextQueueItemId') === owner.queueItemId &&
    target?.queueItemId === owner.queueItemId &&
    Number(target.sessionId) === owner.sessionId
  );
}

function beginProRoomFilePreload(
  queueItemId: QueueItemId,
  sessionId: number,
): Promise<void> | null {
  if (
    !PRO_ROOM_FILE_PRELOAD_ENABLED ||
    getState('room.context').kind !== 'pro' ||
    !Number.isSafeInteger(sessionId) ||
    sessionId <= 0
  ) {
    return null;
  }

  const existing = _proRoomPreloadOwner;
  if (
    existing?.queueItemId === queueItemId &&
    existing.sessionId === sessionId &&
    isCurrentProRoomPreloadOwner(existing)
  ) {
    return existing.promise;
  }

  const settledTarget = getState('preload.activeTarget');
  if (
    !_proRoomPreloadOwner &&
    getState('preload.isPreloading') === false &&
    getState('preload.nextQueueItemId') === queueItemId &&
    settledTarget?.queueItemId === queueItemId &&
    Number(settledTarget.sessionId) === sessionId &&
    hasProRoomPlaylistFilePreload(queueItemId)
  ) {
    return Promise.resolve();
  }

  const meta = proRoomPreloadMeta(queueItemId, sessionId);
  if (!meta) return null;
  const preload = preloadProRoomPlaylistFile(queueItemId);
  if (!preload) return null;

  const owner: ProRoomPreloadOwner = {
    queueItemId,
    sessionId,
    promise: Promise.resolve(),
  };
  _proRoomPreloadOwner = owner;
  batchSetState({
    'preload.sessionId': sessionId,
    'preload.nextQueueItemId': queueItemId,
    'preload.activeTarget': meta,
    'preload.ready': null,
    'preload.isPreloading': true,
  });

  owner.promise = (async () => {
    try {
      const file = await preload;
      if (!isCurrentProRoomPreloadOwner(owner)) return;
      if (!file) {
        batchSetState({
          'preload.nextQueueItemId': null,
          'preload.activeTarget': null,
          'preload.ready': null,
          'preload.isPreloading': false,
        });
        return;
      }
      const liveMeta = proRoomPreloadMeta(queueItemId, sessionId);
      if (!liveMeta) return;
      const cachedMeta = {
        ...liveMeta,
        name: file.name || liveMeta.name,
        mime: file.type || liveMeta.mime,
        size: file.size,
      };
      batchSetState({
        // The File stays solely in ProRoomAssetCache until selection. Keeping
        // it in preload.ready as well would let a later cache eviction leave a
        // hidden, unbounded Blob reference alive for the rest of the session.
        'preload.activeTarget': cachedMeta,
        'preload.ready': null,
        'preload.isPreloading': false,
      });
      log.debug(`[Preload] PRO asset cached for ${queueItemId}`);
    } catch (error) {
      if (!isCurrentProRoomPreloadOwner(owner)) return;
      log.warn('[Preload] PRO background fetch failed; foreground selection may retry', error);
      batchSetState({
        'preload.nextQueueItemId': null,
        'preload.activeTarget': null,
        'preload.ready': null,
        'preload.isPreloading': false,
      });
    } finally {
      if (_proRoomPreloadOwner === owner) _proRoomPreloadOwner = null;
    }
  })();
  return owner.promise;
}

function handleProRoomFilePreload(
  data: ProtocolMsg<typeof MSG.PRO_FILE_PRELOAD>,
  conn?: DataConnection,
): void {
  const context = getState('room.context');
  if (!PRO_ROOM_FILE_PRELOAD_ENABLED || context.kind !== 'pro' || !context.roomId) return;
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  const currentMeta = getState('preload.activeTarget');
  const currentSessionId = Number(currentMeta?.sessionId) || 0;
  if (
    currentSessionId > data.sessionId ||
    (currentSessionId === data.sessionId && currentMeta?.queueItemId !== data.queueItemId)
  ) {
    return;
  }

  const operation = beginProRoomFilePreload(data.queueItemId, data.sessionId);
  if (operation) {
    _pendingProRoomPreloadHint = null;
    void operation;
    return;
  }

  const pending = _pendingProRoomPreloadHint;
  const sameAuthority = pending?.roomId === context.roomId && pending.hostConn === hostConn;
  if (sameAuthority) {
    if (pending.sessionId > data.sessionId) return;
    // A coordinator session identifies exactly one queue occurrence. Keep the
    // first authenticated tuple if a conflicting duplicate somehow arrives.
    if (pending.sessionId === data.sessionId && pending.queueItemId !== data.queueItemId) return;
  }
  _pendingProRoomPreloadHint = {
    roomId: context.roomId,
    queueItemId: data.queueItemId,
    sessionId: data.sessionId,
    hostConn,
  };
}

function replayPendingProRoomPreloadHint(): void {
  const pending = _pendingProRoomPreloadHint;
  if (!pending) return;
  const context = getState('room.context');
  const hostConn = getState('network.hostConn');
  if (
    context.kind !== 'pro' ||
    context.roomId !== pending.roomId ||
    hostConn !== pending.hostConn
  ) {
    _pendingProRoomPreloadHint = null;
    return;
  }

  const operation = beginProRoomFilePreload(pending.queueItemId, pending.sessionId);
  if (!operation) return;
  _pendingProRoomPreloadHint = null;
  void operation;
}

/**
 * Preload the next track in the playlist (host-only).
 *
 * Await the prior background transfer before publishing the next preload.
 * A generation snapshot prevents a schedule or cancellation that occurs
 * during that wait from starting stale work afterward.
 */
async function preloadNextTrack(): Promise<void> {
  const myGeneration = _preloadGeneration;

  const roomContext = getState('room.context');
  if (roomContext.kind === 'pro') {
    // The server owns queue order in PRO rooms. Each member warms the canonical
    // private object without a browser coordinator.
  } else if (getState('network.hostConn')) {
    return;
  }

  const playlist = getState('playlist.items');
  if (playlist.length <= 1) {
    clearPreloadCacheState();
    return;
  }

  const currentQueueItemId = getState('playlist.currentQueueItemId');
  const currentTrackIndex = playlist.findIndex((item) => item.queueItemId === currentQueueItemId);
  if (currentTrackIndex < 0) return;
  const repeatMode = getState('playlist.repeatMode');
  const isShuffle = getState('playlist.isShuffle');

  // Repeat-one replays the already-decoded current owner in place. Staging
  // that same queue occurrence again would mint a new transfer session and,
  // for R2 participants, download a duplicate Blob that can never be used.
  // setRepeatMode()/track transitions already cancel any prior next-track
  // work before scheduling this pass, so there is intentionally no target.
  if (repeatMode === 2) {
    clearPreloadCacheState();
    return;
  }

  // Determine next index
  let nextIdx: number;
  if (isShuffle && playlist.length > 1) {
    // Ask playlist.ts for the next slot in its Fisher-Yates permutation so
    // the preload matches exactly what playNextTrack will pick.
    //
    // -1 means the non-repeating shuffle pass is complete, so there is no
    // legitimate preload target.
    try {
      const mod = await import('../player/playlist.ts');
      const hintedQueueItemId = mod.getShuffleNextQueueItemId();
      const hinted = playlist.findIndex((item) => item.queueItemId === hintedQueueItemId);
      if (hinted >= 0 && hinted !== currentTrackIndex) {
        nextIdx = hinted;
      } else {
        nextIdx = -1;
      }
    } catch {
      nextIdx = -1;
    }
  } else {
    nextIdx = currentTrackIndex + 1;
    if (nextIdx >= playlist.length) {
      if (repeatMode === 1) nextIdx = 0;
      else nextIdx = -1;
    }
  }

  if (_preloadGeneration !== myGeneration) return;

  // Invalid-target early exit: clear stale preload state and bail out
  // (this runs BEFORE the serialization await so there's no window
  // where inconsistent state could be observed by the host fast path).
  if (nextIdx < 0 || nextIdx >= playlist.length) {
    clearPreloadCacheState();
    return;
  }

  // Scan-forward through consecutive YouTube entries to find the next
  // preloadable local file. Without this, hybrid playlists like
  // local→YT→local→YT got zero preload benefit: every nextIdx that landed
  // on a YouTube track aborted, even though a local file was just one
  // slot further. The scan respects the same wrap/end semantics as the
  // initial nextIdx pick — repeatMode=1 wraps to 0, repeatMode=0 stops
  // at the playlist end. The currentTrackIndex check prevents an infinite
  // wrap on an all-YouTube playlist (or a repeat-all list with only one
  // local track that we'd otherwise re-pick as our own preload target).
  // Shuffle keeps its own permutation that we don't second-guess.
  if (!isShuffle) {
    let scanCount = 0;
    while (
      scanCount < playlist.length &&
      playlist[nextIdx] &&
      playlist[nextIdx].type === 'youtube'
    ) {
      nextIdx = nextIdx + 1;
      if (nextIdx >= playlist.length) {
        if (repeatMode === 1) {
          nextIdx = 0;
        } else {
          nextIdx = -1;
          break;
        }
      }
      if (nextIdx === currentTrackIndex) {
        // Wrapped a full lap without finding a local file.
        nextIdx = -1;
        break;
      }
      scanCount++;
    }

    if (nextIdx < 0 || nextIdx >= playlist.length) {
      clearPreloadCacheState();
      return;
    }
  }

  const item = playlist[nextIdx];
  if (!item) return;

  // Still possible to land on a YouTube item: shuffle's next occurrence can
  // return one.
  // Either way, clear stale preload state so the host's fast path in
  // playTrack doesn't match a no-longer-valid cached file.
  if (item.type === 'youtube') {
    clearPreloadCacheState();
    return;
  }

  const queueItemId = item.queueItemId;

  if (roomContext.kind === 'pro') {
    if (!PRO_ROOM_FILE_PRELOAD_ENABLED) {
      clearPreloadCacheState();
      return;
    }

    const active = getState('preload.activeTarget');
    if (
      getState('preload.nextQueueItemId') === queueItemId &&
      active?.queueItemId === queueItemId &&
      (_proRoomPreloadOwner?.queueItemId === queueItemId ||
        hasProRoomPlaylistFilePreload(queueItemId))
    ) {
      return;
    }

    const sessionId = nextSessionId();
    const operation = beginProRoomFilePreload(queueItemId, sessionId);
    if (!operation) {
      clearPreloadCacheState();
      return;
    }
    broadcast({ type: MSG.PRO_FILE_PRELOAD, queueItemId, sessionId });
    await operation;
    return;
  }

  const file = item.file as File;
  if (!file) return;

  // A reorder can move rows without changing the actual next occurrence.
  // Keep the completed resident and its transfer session in that case: the
  // positional hint is explicitly non-authoritative, while queueItemId +
  // Blob identity remain exact. This avoids retransmitting bytes merely
  // because an unrelated row moved.
  const ready = getState('preload.ready');
  if (ready?.queueItemId === queueItemId && ready.blob === file) {
    setState('preload.nextQueueItemId', queueItemId);
    return;
  }

  // Let the prior preload reach PRELOAD_END before starting another.
  //
  // NOTE: we do NOT mutate preload.* state before this await. Publishing a
  // ready resident while activeTarget still describes the prior session would
  // create a half-updated cache that the host's fast path could consume.
  // Both fields are written only after the await as one coherent snapshot.
  const prevTransfer = _inFlightBackgroundTransfer;
  if (prevTransfer) {
    log.debug('[Preload] Serializing — awaiting prior backgroundTransfer');
    try {
      await prevTransfer;
    } catch {
      /* prior may have been cancelled */
    }
  }

  // Re-check generation: a newer schedulePreload or cancelPreloadTransfer
  // may have fired while we were awaiting the prior transfer.
  if (_preloadGeneration !== myGeneration) {
    log.debug('[Preload] Aborted — superseded during serialization wait');
    return;
  }

  // Resolve the chosen occurrence's current position after the await. A
  // reorder must not invalidate stable queue identity, while removal or File
  // replacement still invalidates the frozen source tuple.
  const playlistNow = getState('playlist.items');
  const currentIndexHint = playlistNow.findIndex(
    (candidate) => candidate.queueItemId === queueItemId && candidate.file === file,
  );
  if (currentIndexHint < 0) {
    log.debug('[Preload] Aborted — playlist changed during serialization wait');
    return;
  }

  // Safe to allocate the new session id and publish the preload cache
  // atomically. All five state fields below describe the SAME track and
  // the SAME session — the host's fast path in playTrack will only ever
  // observe them as a consistent snapshot.
  const currentSession = nextSessionId();
  freezeFileDeliveryMode(currentSession);
  setState('preload.sessionId', currentSession);
  setState('preload.nextQueueItemId', queueItemId);
  setState('preload.isPreloading', true);

  const total = Math.ceil(file.size / CHUNK_SIZE);
  const activeTarget = {
    name: file.name,
    queueItemId,
    indexHint: currentIndexHint,
    mime: file.type,
    total,
    size: file.size,
    sessionId: currentSession,
  };
  setState('preload.activeTarget', activeTarget);
  setState('preload.ready', { ...activeTarget, blob: file });

  log.debug('[Preload] Starting for:', file.name, 'session:', currentSession);

  // Warm direct-local peers and R2-routed peers in parallel. Both lanes own
  // the exact same queue/session tuple, so promotion never has to restart at
  // zero when this occurrence becomes current.
  const transferPromise = Promise.all([
    backgroundTransfer(file, queueItemId, currentSession),
    preloadRemoteFileIfNeeded(file, currentSession, queueItemId),
  ]).then(() => undefined);
  _inFlightBackgroundTransfer = transferPromise;
  try {
    await transferPromise;
  } catch (e) {
    log.warn('[Preload] backgroundTransfer failed:', e);
  } finally {
    if (_inFlightBackgroundTransfer === transferPromise) {
      _inFlightBackgroundTransfer = null;
    }
    if (getState('preload.sessionId') === currentSession) {
      setState('preload.isPreloading', false);
    }
  }
}

// ─── Host: Background Transfer ──────────────────────────────────────

// Preload deliberately tolerates congestion longer than active-file broadcast.
// Both share the bulk channel, and prematurely excluding background work would
// force that guest to restart the next track from zero.
const PRELOAD_BROADCAST_BACKPRESSURE_LIMIT = 256 * 1024;
const PRELOAD_BROADCAST_BACKPRESSURE_TIMEOUT = 30_000;

async function backgroundTransfer(
  file: File,
  queueItemId: QueueItemId,
  sessionId: number,
): Promise<void> {
  if (getState('room.context').kind === 'pro') return;
  const CHUNK = CHUNK_SIZE;
  const total = Math.ceil(file.size / CHUNK);
  const header = {
    type: MSG.PRELOAD_START,
    name: file.name,
    mime: file.type,
    total,
    size: file.size,
    queueItemId,
    sessionId,
  };

  // Writability pre-filter (parity with broadcastFile): dead-channel peers
  // get no PRELOAD_START header at all instead of a header for a stream
  // that can never reach them. Receiver-safe: a guest that never sees the
  // header simply has no sessionState entry for this sid.
  const targets = filterEligiblePeers(sessionId).filter(isBulkTransferWritablePeer);

  if (targets.length === 0) return;

  // The caller serialized prior work, so only explicit cancellation disposes
  // this fresh scope. This owner deliberately survives local cache promotion:
  // the host can decode its own File before slower guests receive every byte.
  const scope = new SessionScope();
  const owner: BackgroundTransferOwner = {
    queueItemId,
    sessionId,
    sourceBlob: file,
    scope,
    targets,
    abortedPeerIds: new Set(),
    terminal: 'streaming',
  };
  _preloadScope = scope;
  _inFlightBackgroundOwner = owner;

  try {
    const targetsWhoNeedChunks = targets.filter((p) => {
      const preloadedQueueItemIds = p.preloadedQueueItemIds as Set<string> | undefined;
      return !preloadedQueueItemIds || !preloadedQueueItemIds.has(queueItemId);
    });

    // Send header per-peer
    targets.forEach((p) => {
      const conn = p.conn as DataConnection;
      const needsChunks = targetsWhoNeedChunks.includes(p);
      safeSend(conn, { ...header, skipped: !needsChunks });
    });

    // Per-peer backpressure prevents one stalled guest from blocking the room.
    const { status, excluded } = await pumpChunksToPeers({
      file: owner.sourceBlob,
      chunkSize: CHUNK,
      peers: targetsWhoNeedChunks,
      buildChunkMsg: (chunk, i) => ({
        type: MSG.PRELOAD_CHUNK,
        chunk,
        chunkIndex: i,
        queueItemId: owner.queueItemId,
        sessionId: owner.sessionId,
      }),
      bufferedLimit: PRELOAD_BROADCAST_BACKPRESSURE_LIMIT,
      stallTimeoutMs: PRELOAD_BROADCAST_BACKPRESSURE_TIMEOUT,
      isWritable: isBulkTransferWritablePeer,
      shouldContinue: () =>
        _inFlightBackgroundOwner === owner &&
        owner.terminal === 'streaming' &&
        !owner.scope.aborted,
      // Tear down only the excluded peer. PRELOAD_ABORT uses the control channel,
      // and the normal AWAITING_PRELOAD watchdog owns any later recovery.
      onPeerExcluded: (p) => abortBackgroundPeer(owner, p),
    });

    // Cancelled/superseded mid-pump: no fanout, no state writes.
    // cancelPreloadTransfer already broadcast PRELOAD_ABORT to all targets,
    // and preloadNextTrack's finally owns preload.isPreloading.
    if (
      status === 'stopped' ||
      _inFlightBackgroundOwner !== owner ||
      owner.terminal !== 'streaming'
    ) {
      return;
    }

    // Claim completion before sending END so an explicit cancellation cannot
    // also emit ABORT for this same owner.
    owner.terminal = 'completed';
    const endMsg = {
      type: MSG.PRELOAD_END,
      name: owner.sourceBlob.name,
      queueItemId: owner.queueItemId,
      sessionId: owner.sessionId,
    };
    // END audience: all targets — INCLUDING skipped-flag peers, whose
    // handler no-ops on it — MINUS excluded peers. Excluded peers got a
    // targeted PRELOAD_ABORT instead; sending them END too would arm
    // handlePreloadEnd's 10s deferred-END timer churn on the guest.
    targets.forEach((p) => {
      if (excluded.has(p.id)) return;
      const conn = p.conn as DataConnection;
      if (conn?.open) safeSend(conn, endMsg);
    });
    log.debug('[Preload] Complete for queue item:', owner.queueItemId);
  } catch (error) {
    // A source read failure after PRELOAD_START must terminate the exact
    // receivers immediately instead of leaving them to a 30-second watchdog.
    if (_inFlightBackgroundOwner === owner && owner.terminal === 'streaming') {
      owner.terminal = 'cancelled';
      owner.targets.forEach((peer) => abortBackgroundPeer(owner, peer));
    }
    throw error;
  } finally {
    if (_inFlightBackgroundOwner === owner) _inFlightBackgroundOwner = null;
    if (_preloadScope === scope) _preloadScope = null;
    scope.dispose();
  }
}

/**
 * Unicast preload data to a single peer (for late-joining guests).
 */
export async function unicastPreload(
  conn: DataConnection,
  file: File | Blob,
  queueItemId: string,
  sessionId: number,
): Promise<void> {
  if (getState('room.context').kind === 'pro') return;
  if (!conn?.open || !file || !queueItemId || !Number.isSafeInteger(sessionId) || sessionId <= 0) {
    return;
  }

  // Freeze the exact source tuple before the asynchronous transport guard.
  // The host can replace a preload for the same queue occurrence while ICE
  // classification, backpressure, or Blob reads are pending.
  const unicastKey = conn.peer;
  const prevEntry = _activePreloadUnicasts.get(unicastKey);
  const scope = SessionScope.replace(prevEntry?.scope ?? null);
  _activePreloadUnicasts.set(unicastKey, { scope, sid: sessionId, queueItemId, conn });

  const isSourceCurrent = (): boolean => {
    const meta = getState('preload.activeTarget');
    const isPreloadResident =
      getState('preload.ready')?.blob === file &&
      getState('preload.nextQueueItemId') === queueItemId &&
      meta?.queueItemId === queueItemId &&
      Number(meta?.sessionId) === sessionId;
    if (isPreloadResident) return true;

    // Normal activation atomically promotes the same encoded resident from
    // preload.ready into files.current before clearing the preload projection.
    // That consumer-side ownership move must not cancel a late-join unicast
    // that already froze the exact Blob/session/queue tuple. A replacement
    // resident still fails all three identity checks and stops the transfer.
    const current = getState('files.current');
    return (
      current?.blob === file &&
      current.queueItemId === queueItemId &&
      Number(current.sessionId) === sessionId
    );
  };
  const canContinue = (): boolean =>
    !scope.aborted && conn.open && isPeerConnectionCurrent(unicastKey, conn) && isSourceCurrent();
  const releaseScope = (): void => {
    scope.dispose();
    if (_activePreloadUnicasts.get(unicastKey)?.scope === scope) {
      _activePreloadUnicasts.delete(unicastKey);
    }
  };

  try {
    // Transport guard: block remote/unknown peers. Revalidate the frozen
    // source and connection after the await before emitting PRELOAD_START.
    if (!(await canSendFileTo(conn, sessionId))) {
      log.info('[Preload Unicast] Skipped — remote/unknown peer');
      return;
    }
    if (!canContinue()) return;

    const CHUNK = CHUNK_SIZE;
    const total = Math.ceil(file.size / CHUNK);
    const fileName = 'name' in file ? file.name : 'Track';

    safeSend(conn, {
      type: MSG.PRELOAD_START,
      name: fileName,
      mime: file.type,
      total,
      size: file.size,
      queueItemId,
      sessionId,
      skipped: false,
    });

    for (let i = 0; i < total; i++) {
      if (!canContinue()) return;
      const bpStart = Date.now();
      while (conn.open && conn.dataChannel && conn.dataChannel.bufferedAmount > 256 * 1024) {
        if (!canContinue()) return;
        if (Date.now() - bpStart > 30_000) {
          log.warn('[Preload Unicast] Backpressure timeout');
          return;
        }
        await delay(DELAY.BACKPRESSURE);
      }
      if (!canContinue()) return;
      const start = i * CHUNK;
      const chunkBuf = await file.slice(start, Math.min(start + CHUNK, file.size)).arrayBuffer();
      if (!canContinue()) return;
      safeSend(conn, {
        type: MSG.PRELOAD_CHUNK,
        chunk: new Uint8Array(chunkBuf),
        chunkIndex: i,
        queueItemId,
        sessionId,
      });
    }

    if (canContinue()) {
      safeSend(conn, { type: MSG.PRELOAD_END, name: fileName, queueItemId, sessionId });
    }
  } finally {
    // Always dispose our own scope; remove the registry entry only if this
    // invocation still owns it. A stale failure must not detach its successor.
    releaseScope();
  }
}

// ─── Guest: Preload Receive Handlers ────────────────────────────────

/**
 * Reject broadcast frames not arriving via hostConn. Preload messages flow
 * host-to-guest only: the host schedules preloads and guests only trust frames
 * from that authenticated connection. handlePreloadAck stays unguarded because
 * it is the host-side guest-to-host reply handler.
 */
function isHostBroadcast(conn: DataConnection | undefined): boolean {
  const hostConn = getState('network.hostConn');
  return !!hostConn && conn === hostConn;
}

/** Exempt only chunks for a bounded, non-finalized preload owned by hostConn. */
function isActiveHostPreloadChunkForRateLimit(
  data: Readonly<Record<string, unknown>>,
  conn: DataConnection,
): boolean {
  if (
    getState('network.appRole') !== 'guest' ||
    conn.open !== true ||
    !isHostBroadcast(conn) ||
    data.type !== MSG.PRELOAD_CHUNK ||
    Object.keys(data).length !== 5
  ) {
    return false;
  }
  const sessionId = data.sessionId;
  const queueItemId = data.queueItemId;
  const chunkIndex = data.chunkIndex;
  const chunk = data.chunk;
  if (
    !Number.isSafeInteger(sessionId) ||
    (sessionId as number) <= 0 ||
    typeof queueItemId !== 'string' ||
    !queueItemId ||
    !Number.isSafeInteger(chunkIndex) ||
    (chunkIndex as number) < 0 ||
    (!(chunk instanceof Uint8Array) && !isArrayBuffer(chunk)) ||
    chunk.byteLength > CHUNK_SIZE
  ) {
    return false;
  }

  const session = getState('preload.sessionState').get(sessionId as number);
  const expectedByteLength =
    session && (chunkIndex as number) === session.total - 1
      ? session.size - CHUNK_SIZE * (session.total - 1)
      : CHUNK_SIZE;
  return (
    !!session &&
    !session.skipped &&
    !session.finalized &&
    session.queueItemId === queueItemId &&
    Number.isSafeInteger(session.total) &&
    session.total > 0 &&
    (chunkIndex as number) < session.total &&
    chunk.byteLength === expectedByteLength
  );
}

export const isActiveHostPreloadChunkForRateLimitForTests = isActiveHostPreloadChunkForRateLimit;

function handlePreloadStart(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  // Remote guests receive preloads through the authenticated whole-object path.
  const routeQueueItemId =
    typeof data.queueItemId === 'string' ? (data.queueItemId as QueueItemId) : null;
  const incomingSessionId = Number(data.sessionId);
  if (isRemoteGuest() || isGuestR2FileDelivery(routeQueueItemId, incomingSessionId)) {
    log.info('[Preload] Skipped direct preload for remote guest');
    return;
  }

  const incomingIdentity = createPreloadIdentity(data.sessionId, data.queueItemId);
  if (
    !incomingIdentity ||
    !Number.isSafeInteger(data.total) ||
    (data.total as number) <= 0 ||
    !Number.isSafeInteger(data.size) ||
    (data.size as number) <= 0 ||
    (data.total as number) !== Math.ceil((data.size as number) / CHUNK_SIZE)
  ) {
    log.warn('[Preload] Start message has invalid transfer identity. Ignoring.');
    return;
  }
  const { sessionId: sid, queueItemId: incomingQueueItemId } = incomingIdentity;
  recordGuestFileDelivery(incomingQueueItemId, sid, 'direct-local');
  const incomingName = data.name as string;
  const incomingIndexHint = getState('playlist.items').findIndex(
    (item) => item.queueItemId === incomingQueueItemId,
  );
  if (incomingIndexHint < 0) {
    log.warn('[Preload] Start targets an unknown queue item. Ignoring.');
    return;
  }
  const earlyQueueItemId = preloadQueueItemBySid.get(sid);
  if (earlyQueueItemId && earlyQueueItemId !== incomingQueueItemId) {
    preloadReorderBuffer.delete(sid);
  }
  preloadQueueItemBySid.set(sid, incomingQueueItemId);

  clearManagedTimer('prepareWatchdog');

  // Clean up buffers from previous sessions when a new one starts
  if (latestPreloadSessionId && latestPreloadSessionId !== sid) {
    cleanupStalePreloadSessions(sid);
  }
  latestPreloadSessionId = sid;

  // Skip if this preload was already marked as skipped by host
  if (data.skipped) {
    log.debug(`[Preload] Skipping session ${sid}`);
    const skipSessionState = new Map(getState('preload.sessionState'));
    skipSessionState.set(sid, {
      skipped: true,
      progress: 0,
      total: (data.total as number) || 0,
      name: incomingName,
      queueItemId: incomingQueueItemId,
      indexHint: incomingIndexHint,
      size: (data.size as number) || 0,
      mime: (data.mime as string) || '',
      nextExpectedChunk: 0,
      finalized: false,
    });
    setState('preload.sessionState', skipSessionState);
    try {
      preloadReorderBuffer.delete(sid);
      preloadQueueItemBySid.delete(sid);
    } catch (e) {
      log.debug('[Preload] reorder buffer cleanup:', e);
    }
    return;
  }

  // A real replacement supersedes the resident cache even if admission later
  // fails. A skipped re-schedule above deliberately keeps the cached Blob.
  setState('preload.ready', null);

  try {
    admitIncomingStoredFile({
      queueItemId: incomingQueueItemId,
      filename: incomingName,
      isPreload: true,
      sessionId: sid,
      totalSize: data.size as number,
      retainedPcmBytes: retainedPcmBytesForReceive(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[Preload] RAM admission rejected session ${sid}: ${message}`);
    const rejected = new Map(getState('preload.sessionState'));
    rejected.set(sid, {
      skipped: true,
      progress: 0,
      total: data.total as number,
      name: incomingName,
      queueItemId: incomingQueueItemId,
      indexHint: incomingIndexHint,
      size: data.size as number,
      mime: (data.mime as string) || '',
      nextExpectedChunk: 0,
      finalized: false,
    });
    setState('preload.sessionState', rejected);
    // This authoritative START supersedes the prior cache even when the new
    // encoded receive cannot be admitted. Leaving the old Blob/meta published
    // would let PLAY_PRELOADED activate stale bytes for this queue occurrence.
    clearPreloadCacheState();
    _awaitedPreloadIdentity = null;
    showLoader(false);
    showToast(t('error.load_failed', { msg: message }));
    return;
  }

  // Clear any stuck waiting state from previous preload

  log.debug(
    `[Preload] Start: ${data.name} (queueItemId: ${incomingQueueItemId}, total: ${data.total})`,
  );

  // Show loader only if main transfer is not in progress
  const transferState = getState('transfer.state');
  if (
    transferState === TRANSFER_STATE.READY ||
    transferState === TRANSFER_STATE.IDLE ||
    !transferState
  ) {
    showLoader(true, t('toast.preparing_next', { name: data.name as string }));
  }

  // Initialize session state
  const initSessionState = new Map(getState('preload.sessionState'));
  initSessionState.set(sid, {
    skipped: false,
    progress: 0,
    total: (data.total as number) || 0,
    name: incomingName,
    queueItemId: incomingQueueItemId,
    indexHint: incomingIndexHint,
    size: (data.size as number) || 0,
    mime: (data.mime as string) || '',
    nextExpectedChunk: 0,
    finalized: false,
  });
  setState('preload.sessionState', initSessionState);

  // Clear stale preload blob BEFORE updating meta — prevents meta/blob mismatch
  // where an old Blob (from a completed stale preload) is paired with new metadata,
  // causing handlePlayPreloaded to use the wrong file.
  setState('preload.activeTarget', {
    name: incomingName,
    queueItemId: incomingQueueItemId,
    indexHint: incomingIndexHint,
    mime: data.mime as string,
    total: data.total as number,
    size: data.size as number,
    sessionId: sid,
  });

  reconcileAwaitedPreloadOnStart(incomingIdentity);

  // Start preload slot
  // Note: We deliberately do NOT send STORAGE_RESET here. The ramstore
  // manages preload slots by sessionId. Sending STORAGE_RESET would abort
  // any still-downloading "stale" preloads (like a late-joiner's Track 2
  // that was superseded by Track 3).
  postCommand({
    command: 'STORAGE_START',
    queueItemId: incomingQueueItemId,
    filename: incomingName,
    mime: (data.mime as string) || '',
    isPreload: true,
    sessionId: validateSessionId(sid),
    size: CHUNK_SIZE,
  });

  // Drain chunks that arrived before PRELOAD_START after the start state has
  // been published for this event turn.
  setManagedTimer(
    'preload-drain-' + sid,
    () => {
      try {
        drainPreloadReorderBuffer(sid);
      } catch (e) {
        log.debug('[Preload] drain reorder buffer:', e);
      }
    },
    0,
  );

  setManagedTimer(
    `preload-admission-watchdog-${sid}`,
    () => abandonStalledPreloadSession(sid, 'admission watchdog'),
    30_000,
  );

  // Watchdog: unconditionally clear preload loader after 30s
  clearManagedTimer('preloadUiWatchdog');
  setManagedTimer(
    'preloadUiWatchdog',
    () => {
      log.warn('[Preload] Watchdog: forcing preload loader reset after 30s');
      showLoader(false);
      // If main transfer is still in progress, restore its loader
      const transferState = getState('transfer.state');
      if (transferState === TRANSFER_STATE.RECEIVING) {
        const meta = getState('transfer.meta');
        const receivedCount = getState('transfer.receivedCount');
        const total = (meta?.total as number) || 0;
        if (total > 0) {
          const pct = Math.round((receivedCount / total) * 100);
          updateLoader(pct);
        }
      }
    },
    30000,
  );
}

function drainPreloadReorderBuffer(sessionId: number): void {
  const sessionState = getState('preload.sessionState');
  const session = sessionState.get(sessionId);
  if (!session || session.skipped) return;

  const sessionBuffer = preloadReorderBuffer.get(sessionId);
  if (!sessionBuffer) return;

  let nextChunkPtr = session.nextExpectedChunk || 0;

  while (sessionBuffer.has(nextChunkPtr)) {
    const chunk = sessionBuffer.get(nextChunkPtr)!;

    const fileName = session.name;

    // If we still don't know the filename, keep buffering
    if (!fileName) break;

    postCommand({
      command: 'STORAGE_WRITE',
      // handlePreloadChunk already made one exact-span owned copy before this
      // reorder map. RAM storage is synchronous/in-process, so hand that same
      // backing buffer over instead of copying every chunk a second time.
      chunk: chunk.buffer as ArrayBuffer,
      chunkIndex: nextChunkPtr,
      isPreload: true,
      queueItemId: session.queueItemId,
      filename: fileName,
      sessionId: validateSessionId(sessionId),
    });

    sessionBuffer.delete(nextChunkPtr);
    nextChunkPtr++;
  }

  // Immutable update: create new session object with updated progress
  const totalExpected = session.total || 0;
  const fileSize = session.size || 0;
  const isComplete = totalExpected > 0 && nextChunkPtr >= totalExpected;
  const updatedSession = {
    ...session,
    nextExpectedChunk: nextChunkPtr,
    progress: nextChunkPtr,
    finalized: session.finalized || (isComplete ? true : false),
  };
  const newSessionState = new Map(getState('preload.sessionState'));
  newSessionState.set(sessionId, updatedSession);
  setState('preload.sessionState', newSessionState);

  if (isComplete) {
    clearManagedTimer(`preload-admission-watchdog-${sessionId}`);
  } else if (nextChunkPtr > (session.progress || 0)) {
    clearManagedTimer(`preload-admission-watchdog-${sessionId}`);
    setManagedTimer(
      `preload-admission-watchdog-${sessionId}`,
      () => abandonStalledPreloadSession(sessionId, 'progress watchdog'),
      15_000,
    );
  }

  // Update preload progress UI (only if main transfer is not active)
  // To avoid UI flickering when a superseded session finishes in the background,
  // we must be mutually exclusive. If we're blocked waiting for a track, ONLY show
  // that track's progress. Otherwise, show the latest broadcast preload.
  const lifecycle = getState('playback.lifecycle');
  const recoveryTarget = getState('playback.pendingRecoveryTarget');
  const shouldUpdateUI =
    lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD
      ? updatedSession.queueItemId === recoveryTarget?.queueItemId
      : sessionId === latestPreloadSessionId;

  if (shouldUpdateUI && updatedSession.total > 0) {
    const pct = Math.round((updatedSession.progress / updatedSession.total) * 100);
    const transferState = getState('transfer.state');
    if (
      transferState === TRANSFER_STATE.READY ||
      transferState === TRANSFER_STATE.IDLE ||
      !transferState
    ) {
      if (lastPreloadUiSessionId !== sessionId || lastPreloadUiPercent !== pct) {
        lastPreloadUiSessionId = sessionId;
        lastPreloadUiPercent = pct;
        showLoader(true, t('toast.preparing_next_pct', { pct }));
        updateLoader(pct);
      }
    }
  }

  // Tick watchdog on progress
  const preloadMeta = getState('preload.activeTarget');
  if (preloadMeta && (preloadMeta.total as number) > 0) {
    clearManagedTimer('preloadUiWatchdog');
    setManagedTimer(
      'preloadUiWatchdog',
      () => {
        const transferState = getState('transfer.state');
        if (transferState === TRANSFER_STATE.READY || transferState === TRANSFER_STATE.IDLE) {
          showLoader(false);
        }
      },
      15000,
    );
  }

  // Finalize if all chunks received (in-chunk finalization)
  if (isComplete && !session.finalized) {
    log.debug(`[Preload] All chunks received (${nextChunkPtr}/${totalExpected}). Finalizing...`);
    postCommand({
      command: 'STORAGE_END',
      queueItemId: updatedSession.queueItemId,
      filename: updatedSession.name,
      isPreload: true,
      sessionId: validateSessionId(sessionId),
      totalSize: fileSize,
      total: updatedSession.total,
    });
    preloadReorderBuffer.delete(sessionId); // Prevent memory leak
  }
}

function handlePreloadChunk(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  // Remote guests receive authenticated whole objects instead of direct chunks.
  if (isRemoteGuest()) return;

  // Exact session identity is mandatory on every preload chunk.
  const sid = data.sessionId as number;
  // Repeat the protocol guard at the sink before keying reorder/session maps.
  if (!Number.isSafeInteger(sid) || sid <= 0) return;
  const queueItemId = typeof data.queueItemId === 'string' ? data.queueItemId : '';
  if (!queueItemId) return;

  // We intentionally DO NOT drop chunks for sid < latestPreloadSessionId.
  // This allows "stale" preloads (like a late-joiner's unicastPreload that
  // got superseded by a track advance) to finish naturally and be promoted
  // to the current track without forcing a 0% recovery restart.

  const sessionState = getState('preload.sessionState');
  const session = sessionState.get(sid);
  if (session && session.queueItemId !== queueItemId) return;
  const bufferedQueueItemId = preloadQueueItemBySid.get(sid);
  if (bufferedQueueItemId && bufferedQueueItemId !== queueItemId) return;
  preloadQueueItemBySid.set(sid, queueItemId);

  // If session state is marked skipped/finalized, ignore
  if (session?.skipped || session?.finalized) return;

  // Bounds check: drop chunks beyond the advertised total.
  if (session && session.total > 0 && (data.chunkIndex as number) >= session.total) {
    log.warn(`[Preload] Out-of-bounds chunk index ${data.chunkIndex} (total: ${session.total})`);
    return;
  }

  // Buffer the chunk in the reorder map
  if (!preloadReorderBuffer.has(sid)) {
    if (!session) {
      const earlySessionIds = [...preloadReorderBuffer.keys()].filter(
        (bufferSid) => !sessionState.has(bufferSid),
      );
      if (earlySessionIds.length >= MAX_EARLY_PRELOAD_SESSIONS) {
        const evictedSid = earlySessionIds[0]!;
        preloadReorderBuffer.delete(evictedSid);
        preloadQueueItemBySid.delete(evictedSid);
        log.warn(`[Preload] Early buffer evicted stale session ${evictedSid}`);
      }
    }
    preloadReorderBuffer.set(sid, new Map());
  }
  const sessionBuffer = preloadReorderBuffer.get(sid)!;

  // Clone data before storing to avoid detached ArrayBuffer issues
  sessionBuffer.set(data.chunkIndex as number, new Uint8Array(data.chunk as Uint8Array));

  // If PRELOAD_START hasn't been processed yet (unordered delivery),
  // keep buffering until sessionState exists so we have a reliable filename/total.
  if (!session) {
    const earlyFootprint = (): { chunks: number; bytes: number } => {
      let chunks = 0;
      let bytes = 0;
      for (const [bufferSid, buffer] of preloadReorderBuffer) {
        if (sessionState.has(bufferSid)) continue;
        chunks += buffer.size;
        for (const chunk of buffer.values()) bytes += chunk.byteLength;
      }
      return { chunks, bytes };
    };
    if (sessionBuffer.size > MAX_EARLY_PRELOAD_CHUNKS) {
      // Drop highest-index chunk — the drain loop starts from chunk 0, so
      // evicting low indices (especially 0) permanently stalls the drain.
      const highestKey = Math.max(...sessionBuffer.keys());
      sessionBuffer.delete(highestKey);
      log.warn(`[Preload] Early chunk buffer overflow (SID: ${sid}). Dropped chunk ${highestKey}.`);
    }
    let footprint = earlyFootprint();
    while (
      footprint.chunks > MAX_EARLY_PRELOAD_CHUNKS ||
      footprint.bytes > MAX_EARLY_PRELOAD_BYTES
    ) {
      const oldestStaleSid = [...preloadReorderBuffer.keys()].find(
        (bufferSid) => bufferSid !== sid && !sessionState.has(bufferSid),
      );
      if (oldestStaleSid !== undefined) {
        preloadReorderBuffer.delete(oldestStaleSid);
        preloadQueueItemBySid.delete(oldestStaleSid);
        footprint = earlyFootprint();
        continue;
      }
      // Preserve low indexes so START can still drain a contiguous prefix.
      const highestKey = sessionBuffer.size > 0 ? Math.max(...sessionBuffer.keys()) : -1;
      if (highestKey < 0) break;
      sessionBuffer.delete(highestKey);
      footprint = earlyFootprint();
      log.warn(`[Preload] Global early-buffer cap dropped SID ${sid} chunk ${highestKey}`);
    }
    if (sessionBuffer.size === 0) preloadReorderBuffer.delete(sid);
    return;
  }

  // Drain the reorder buffer sequentially
  drainPreloadReorderBuffer(sid);
}

function handlePreloadEnd(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  const sid = data.sessionId as number;
  if (!Number.isSafeInteger(sid) || sid <= 0) return;
  const queueItemId = typeof data.queueItemId === 'string' ? data.queueItemId : '';
  if (!queueItemId) return;

  const sessionState = getState('preload.sessionState');
  const session = sessionState.get(sid);
  if (!session || session.skipped || session.queueItemId !== queueItemId) return;

  // Dispatch every buffered STORAGE_WRITE before STORAGE_END.
  drainPreloadReorderBuffer(sid);

  // Re-read session after drain (drain may have updated it via immutable setState)
  const freshSession = getState('preload.sessionState').get(sid);
  if (!freshSession) return;

  // Only finalize if not already finalized by in-chunk detection (drain may have done it)
  if (!freshSession.finalized) {
    const allReceived = freshSession.total > 0 && freshSession.progress >= freshSession.total;
    if (allReceived) {
      // All chunks drained — safe to send STORAGE_END
      const finalizedSession = { ...freshSession, finalized: true };
      const updatedSessionState = new Map(getState('preload.sessionState'));
      updatedSessionState.set(sid, finalizedSession);
      setState('preload.sessionState', updatedSessionState);

      postCommand({
        command: 'STORAGE_END',
        queueItemId: freshSession.queueItemId,
        filename: freshSession.name,
        isPreload: true,
        sessionId: validateSessionId(sid),
        totalSize: freshSession.size,
        total: freshSession.total,
      });
    } else {
      // Some chunks still missing — let future handlePreloadChunk → drain finalize it.
      // This prevents premature STORAGE_END when network reordering causes late chunk arrival.
      log.debug(
        `[Preload] END received but ${freshSession.progress}/${freshSession.total} — deferring STORAGE_END`,
      );

      // Bound the deferred state. Preload broadcasts are one-way (no per-chunk
      // recovery like main transfer), so a chunk that never arrives would
      // otherwise leave this session stuck at finalized=false forever, leaking
      // the reorder buffer and blocking cleanupStalePreloadSessions from
      // evicting it. After the cap, mark the session skipped so it becomes
      // evictable; the next track entry will fall back to main-transfer
      // download via the standard handlePlayPreloaded path.
      const sidLocal = sid;
      setManagedTimer(
        `preload-end-deferred-${sidLocal}`,
        () => {
          const cur = getState('preload.sessionState').get(sidLocal);
          if (!cur || cur.finalized || cur.skipped) return;
          log.warn(
            `[Preload] Deferred END for session ${sidLocal} timed out (${cur.progress}/${cur.total}) — marking skipped.`,
          );
          abandonStalledPreloadSession(sidLocal, 'deferred END watchdog');
        },
        10_000,
      );
    }
  }

  // Cleanup reorder buffer only if finalized (otherwise chunks may still arrive)
  if (getState('preload.sessionState').get(sid)?.finalized) {
    preloadReorderBuffer.delete(sid);
  }

  log.debug(
    `[Preload] End: ${freshSession.name} (${freshSession.progress}/${freshSession.total} chunks)`,
  );

  // PRELOAD_ACK is sent only after storage confirms the finalized file.

  bus.emit('storage:preload-ready', queueItemId);
}

/**
 * Tear down a preload session aborted mid-stream by the host.
 *
 * Host scope disposal is local, so this message releases the receiver's
 * partial session, reorder buffer, and RAM slot. Missing, finalized, and
 * already-skipped sessions are idempotent no-ops; late chunks are dropped by
 * the skipped-session guard.
 */
function handlePreloadAbort(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  const sid = data.sessionId as number;
  if (!Number.isSafeInteger(sid) || sid <= 0) return;
  const queueItemId = typeof data.queueItemId === 'string' ? data.queueItemId : '';
  if (!queueItemId) return;

  const sessionState = getState('preload.sessionState');
  const session = sessionState.get(sid);
  if (session && session.queueItemId !== queueItemId) return;

  // Cancel any pending deferred-end timer that handlePreloadEnd may have
  // set when it saw a partial session. Idempotent (no-op if absent).
  clearManagedTimer(`preload-end-deferred-${sid}`);
  clearManagedTimer(`preload-admission-watchdog-${sid}`);

  // Drop any reorder buffer entries for this sid — they would otherwise
  // wait forever for chunks that aren't coming. Idempotent.
  preloadReorderBuffer.delete(sid);
  preloadQueueItemBySid.delete(sid);

  if (!session || session.finalized || session.skipped) {
    log.debug(
      `[Preload] Abort received for sid ${sid} — session ${
        !session ? 'absent' : session.finalized ? 'finalized' : 'skipped'
      }, no teardown needed`,
    );
    return;
  }

  log.debug(`[Preload] Abort: tearing down sid ${sid} (${session.name})`);

  // Mark skipped so cleanupStalePreloadSessions can evict on the next
  // PRELOAD_START, and so any in-flight chunks for this sid are dropped
  // by the existing skipped guard.
  const updated = new Map(sessionState);
  updated.set(sid, { ...session, skipped: true });
  setState('preload.sessionState', updated);

  // Release the RAM preload slot for this sid. Do not use
  // STORAGE_END here — that path posts STORAGE_FILE_READY which would push a
  // partial resident through the storage:preload-file-ready handler.
  // STORAGE_RESET_SESSION only releases the lock and removes the slot.
  if (session.name) {
    postCommand({
      command: 'STORAGE_RESET_SESSION',
      isPreload: true,
      sessionId: validateSessionId(sid),
    });
  }

  // Hide the preparing-next loader if it was showing for THIS preload.
  const preloadMeta = getState('preload.activeTarget');
  if (preloadMeta?.queueItemId === queueItemId && (preloadMeta.sessionId as number) === sid) {
    showLoader(false);
  }
}

function handlePreloadAck(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Guest ignores

  const connectedPeers = getState('network.connectedPeers');
  const p = connectedPeers.find((x) => x.id === conn.peer);
  const queueItemId = typeof data.queueItemId === 'string' ? data.queueItemId : '';
  const sessionId = Number(data.sessionId);
  const ready = getState('preload.ready');
  if (
    p &&
    queueItemId &&
    Number.isSafeInteger(sessionId) &&
    sessionId > 0 &&
    ready?.queueItemId === queueItemId &&
    ready.sessionId === sessionId
  ) {
    const preloadedQueueItemIds = p.preloadedQueueItemIds as Set<string>;
    if (preloadedQueueItemIds) {
      if (preloadedQueueItemIds.has(queueItemId)) return;
      // Immutable update: new Set → new peer → new array → setState
      const updatedSet = new Set(preloadedQueueItemIds);
      updatedSet.add(queueItemId);
      const updatedPeers = connectedPeers.map((x) =>
        x.id === conn.peer ? { ...x, preloadedQueueItemIds: updatedSet } : x,
      );
      setState('network.connectedPeers', updatedPeers);
      log.debug(`[Host] Marked queue item ${queueItemId} as CACHED for peer ${p.label}`);
    }
  }
}

function handlePlayPreloaded(data: Record<string, unknown>, conn?: DataConnection): void {
  if (!isHostBroadcast(conn)) return;

  if (isSystemAudioOwner()) {
    _awaitedPreloadIdentity = null;
    log.debug('[Preload] Ignoring PLAY_PRELOADED - system audio mode active');
    return;
  }

  const queueItemId = typeof data.queueItemId === 'string' ? data.queueItemId : '';
  const name = (data.name as string) || '';
  const playlist = getState('playlist.items') || [];
  const indexHint = playlist.findIndex((item) => item.queueItemId === queueItemId);
  if (!queueItemId || indexHint < 0) return;

  log.debug(`[Guest] Command: Play Preloaded Track, queueItemId: ${queueItemId}`);

  // Dedup: ignore duplicate commands for same track
  if (_activePlayPreloadedQueueItemId === queueItemId) {
    log.debug(`[PlayPreloaded] Already processing ${queueItemId}, ignoring duplicate`);
    return;
  }

  _activePlayPreloadedQueueItemId = queueItemId;
  bus.emit('player:stop-all-media');
  setState('playlist.currentQueueItemId', queueItemId);

  // Update metadata for UI title display
  if (playlist[indexHint]) {
    setPlaybackTrackMeta(playlist[indexHint]);
  }

  // PLAY_PRELOADED supplies the target slot; the exact PRELOAD_START session
  // supplies byte identity. A filename may veto inconsistent metadata, but it
  // never selects bytes by itself.
  const ready = getState('preload.ready');
  const readyIdentity = identityFromMeta(ready);
  const isMatch = !!ready && readyIdentity?.queueItemId === queueItemId;

  if (isMatch) {
    _awaitedPreloadIdentity = readyIdentity;
    // Preloaded file available — activate it directly via playback module
    log.debug('[Guest] Using preloaded file for queue item', queueItemId);
    // Lifecycle: blob is ready in memory → promote to DECODING.
    // The subsequent loadPreloadedTrack flow will emit DECODE_SUCCESS on completion.
    transition({ type: 'PLAY_PRELOADED', variant: 'blob-ready', queueItemId, name });
    setPendingRecoveryTarget({ queueItemId, indexHint, name });
    bus.emit('storage:use-preloaded', queueItemId, name, readyIdentity.sessionId);
    _activePlayPreloadedQueueItemId = undefined;

    return;
  }

  // Check if preload download is still in progress for this track
  const sessionState = getState('preload.sessionState');
  let downloadingIdentity: PreloadIdentity | null = null;
  for (const [sid, session] of sessionState) {
    if (session.skipped || session.finalized || session.queueItemId !== queueItemId) continue;
    const candidate = createPreloadIdentity(sid, session.queueItemId);
    if (!candidate) continue;
    if (!downloadingIdentity || candidate.sessionId > downloadingIdentity.sessionId) {
      downloadingIdentity = candidate;
    }
  }

  // An in-progress matching preload enters AWAITING_PRELOAD. Its watchdog
  // monitors progress, and storage:preload-file-ready re-enters this path once
  // the serialized transfer finalizes.
  if (downloadingIdentity) {
    _awaitedPreloadIdentity = downloadingIdentity;
    log.debug('[Guest] Preload in progress — delegating to waiter (storage:use-preloaded)');
    // Lifecycle: enter AWAITING_PRELOAD. A subsequent
    // PLAY arrival in this state must NOT fire stale-audio-recovery — that
    // logic is gated in playback.ts::handlePlay on the lifecycle check.
    transition({ type: 'PLAY_PRELOADED', variant: 'blob-waiting', queueItemId, name });
    setPendingRecoveryTarget({ queueItemId, indexHint, name });
    showLoader(true, t('transfer.download_finishing'));
    bus.emit('storage:use-preloaded', queueItemId, name, downloadingIdentity.sessionId);
    _activePlayPreloadedQueueItemId = undefined;

    return;
  }

  _awaitedPreloadIdentity = null;

  // Remote guest fork — PLAY_PRELOADED was the only host→guest track-change
  // message without one. No P2P bytes will arrive (remote guests are excluded
  // from preload sessions), and the REQUEST_DATA_RECOVERY below is silently
  // dropped by the host's unicast transport guard for remote peers: with R2
  // configured the incoming descriptor self-heals the detour, but without it
  // the loader spun forever. Mirror handlePlayMsg's remote branch instead;
  // prepareRemoteShareWait owns the lifecycle transition.
  if (isRemoteGuest() || isGuestR2FileDelivery(queueItemId)) {
    _activePlayPreloadedQueueItemId = undefined;
    if (shouldWaitForRemoteShare()) {
      if (promoteRemotePreloadWait(queueItemId, name)) {
        log.info('[Guest] Promoted in-flight remote preload without restarting');
        return;
      }
      setPendingRecoveryTarget({ queueItemId, indexHint, name });
      const localSid = Number(getState('transfer.localSessionId')) || 0;
      const currentSid = Number(getState('transfer.currentSessionId')) || 0;
      prepareRemoteShareWait(
        queueItemId,
        name || ((playlist[indexHint]?.name as string) ?? ''),
        localSid > 0 ? localSid : currentSid,
      );
      log.info('[Guest] Remote guest — waiting for remote share descriptor (play-preloaded)');
      return;
    }
    showLoader(false);
    showToast(t('share.remote.unavailable'));
    log.info('[Guest] Remote guest — remote share unavailable (play-preloaded)');
    return;
  }

  // Fallback: no preloaded file available — request from host
  log.warn('[Guest] No preloaded file for queue item', queueItemId, '— requesting from Host');
  // No preload session exists for this track. Enter DOWNLOADING (fresh) via
  // the recovery fallback. shouldSkipIncomingFile() returns false naturally
  // once lifecycle = DOWNLOADING. The actual REQUEST_DATA_RECOVERY fires
  // below after a small jitter.
  transition({ type: 'PLAY_PRELOADED', variant: 'no-session', queueItemId, name });
  _activePlayPreloadedQueueItemId = undefined;

  setPendingRecoveryTarget({ queueItemId, indexHint, name });
  showLoader(true, t('transfer.file_requesting'));

  const hostConn = getState('network.hostConn');
  const trackName = name || playlist[indexHint]?.name || '';

  if (hostConn?.open) {
    // Short jitter to avoid thundering herd, but not too long to cause stale track
    const jitter = Math.random() * 300 + 50;
    setManagedTimer(
      'preload-recovery-jitter',
      () => {
        // Double-check: did preload arrive during wait?
        const nowReady = getState('preload.ready');
        const nowIdentity = identityFromMeta(nowReady);
        if (nowReady && nowIdentity?.queueItemId === queueItemId) {
          _awaitedPreloadIdentity = nowIdentity;
          log.debug('[Guest] Preload arrived during jitter wait! Using it.');
          bus.emit('storage:use-preloaded', queueItemId, trackName, nowIdentity.sessionId);
          return;
        }

        // Check if host already moved past this track — don't request stale file
        const currentQueueItemId = getState('playlist.currentQueueItemId');
        if (currentQueueItemId !== queueItemId) {
          log.debug('[Guest] Queue item changed; skipping stale recovery request');
          showLoader(false);
          return;
        }

        const currentHostConn = getState('network.hostConn');
        if (!currentHostConn?.open) return;
        const owner = beginFileRequest(currentHostConn, queueItemId);
        if (
          sendFileRequest(owner, {
            type: MSG.REQUEST_DATA_RECOVERY,
            nextChunk: 0,
            fileName: trackName,
          })
        ) {
          log.debug('[Guest] Requested file recovery from Host for:', trackName);
        }
      },
      jitter,
    );
  }
}

// ─── Debug: Memory Stats ────────────────────────────────────────────
//
// Exposes module-local reorder buffer footprint for `/debug memory`. Walks
// the nested Map<sid, Map<chunkIndex, Uint8Array>> to sum chunk byteLengths.
// Hot-path safe: only called from chat command handler, not from the
// receive pipeline.

export function getPreloadMemoryStats(): {
  reorderSessions: number;
  reorderChunks: number;
  reorderBytes: number;
  latestSessionId: number;
} {
  let chunks = 0;
  let bytes = 0;
  for (const sessionBuf of preloadReorderBuffer.values()) {
    chunks += sessionBuf.size;
    for (const chunk of sessionBuf.values()) {
      bytes += chunk.byteLength;
    }
  }
  return {
    reorderSessions: preloadReorderBuffer.size,
    reorderChunks: chunks,
    reorderBytes: bytes,
    latestSessionId: latestPreloadSessionId,
  };
}

// ─── Register Handlers ──────────────────────────────────────────────

export function initPreload(): void {
  let observedProHostConn = getState('network.hostConn');
  const initialRoomContext = getState('room.context');
  let observedProRoomId = initialRoomContext.kind === 'pro' ? initialRoomContext.roomId : null;
  registerInboundRateLimitExemptionGuard(MSG.PRELOAD_CHUNK, isActiveHostPreloadChunkForRateLimit);
  registerHandlers({
    [MSG.PRO_FILE_PRELOAD]: handleProRoomFilePreload,
    [MSG.PRELOAD_START]: handlePreloadStart,
    [MSG.PRELOAD_CHUNK]: handlePreloadChunk,
    [MSG.PRELOAD_END]: handlePreloadEnd,
    [MSG.PRELOAD_ABORT]: handlePreloadAbort,
    [MSG.PRELOAD_ACK]: handlePreloadAck,
    [MSG.PLAY_PRELOADED]: handlePlayPreloaded,
  });

  // Handle preload file ready from storage (bridged from storage:file-ready via playback.ts)
  bus.on(
    'storage:preload-file-ready',
    async (filename: string, sessionId: number, queueItemId: string) => {
      try {
        log.debug(`[Preload] preload ready: ${filename} (SID: ${sessionId})`);

        // Resolve the completion through its transfer session. Filename is not
        // identity: separate playlist entries may have the same name, and a
        // newer same-name preload may already own preloadByName by the time this
        // asynchronous completion runs.
        const sessionForFile = getState('preload.sessionState').get(sessionId);
        const preloadMeta = getState('preload.activeTarget');
        const currentMetaMatchesSession =
          Number(preloadMeta?.sessionId) === sessionId && preloadMeta?.queueItemId === queueItemId;
        const identityMeta = sessionForFile
          ? sessionForFile.queueItemId === queueItemId
            ? { ...sessionForFile, sessionId }
            : null
          : currentMetaMatchesSession
            ? preloadMeta
            : null;

        const completionIdentity = createPreloadIdentity(sessionId, queueItemId);
        if (
          !identityMeta ||
          !completionIdentity ||
          identityMeta.queueItemId !== queueItemId ||
          identityMeta.name !== filename
        ) {
          log.debug(
            `[Preload] Ignoring completion without exact session identity: filename=${filename}, sid=${sessionId}`,
          );
          postCommand({ command: 'STORAGE_RESET_SESSION', isPreload: true, sessionId });
          return;
        }

        if (!isPreloadCompletionPublishable(completionIdentity)) {
          log.debug(
            `[Preload] Ignoring stale preload completion: SID ${sessionId}, qid=${queueItemId}`,
          );
          postCommand({ command: 'STORAGE_RESET_SESSION', isPreload: true, sessionId });
          return;
        }
        if (sessionId < latestPreloadSessionId) {
          log.info(
            `[Preload] Accepting older preload completion for exact awaited tuple qid=${queueItemId}, sid=${sessionId}`,
          );
        }

        const file = await readStoredFile(queueItemId, filename, true, sessionId);
        if (!file) {
          log.error('[Preload] Failed to read preload file:', filename);
          postCommand({ command: 'STORAGE_RESET_SESSION', isPreload: true, sessionId });
          return;
        }

        // RAM reads yield to the microtask queue. A same-qid replacement may
        // have rebound the awaited tuple while the exact old slot was being
        // wrapped as a File; revalidate before publishing any state or ACK.
        if (!isPreloadCompletionPublishable(completionIdentity)) {
          log.debug(
            `[Preload] Completion superseded during storage read: SID ${sessionId}, qid=${queueItemId}`,
          );
          postCommand({ command: 'STORAGE_RESET_SESSION', isPreload: true, sessionId });
          return;
        }

        const indexHint = getState('playlist.items').findIndex(
          (item) => item.queueItemId === queueItemId,
        );
        if (indexHint < 0) {
          postCommand({ command: 'STORAGE_RESET_SESSION', isPreload: true, sessionId });
          return;
        }

        if (!retainStoredFileAdmission(queueItemId, filename, true, sessionId, file)) {
          log.warn(
            `[Preload] Finalized file has no matching admission: filename=${filename}, sid=${sessionId}`,
          );
          postCommand({ command: 'STORAGE_RESET_SESSION', isPreload: true, sessionId });
          return;
        }

        // Blob + identity publish atomically. Positional metadata is a fresh hint
        // derived from queueItemId after the asynchronous RAM read.
        const readyEntry = {
          queueItemId,
          sessionId,
          indexHint,
          name: filename,
          mime: identityMeta.mime || file.type || '',
          size: file.size,
          ...(identityMeta.objectId ? { objectId: identityMeta.objectId } : {}),
          blob: file,
        };
        setState('preload.nextQueueItemId', queueItemId);
        setState('preload.ready', readyEntry);
        const currentHostConn = getState('network.hostConn');
        if (currentHostConn && completeFileRequest(currentHostConn, queueItemId, sessionId)) {
          clearManagedTimer('fileWaitTimeout');
        }

        // Send PRELOAD_ACK to host now that storage file is confirmed ready
        if (indexHint >= 0) {
          const ackSent = getState('preload.ackSent') as ReadonlyMap<string, number>;
          if (ackSent.get(queueItemId) !== sessionId) {
            const updatedAckSent = new Map(ackSent);
            updatedAckSent.set(queueItemId, sessionId);
            setState('preload.ackSent', updatedAckSent);
            if (sendToHost({ type: MSG.PRELOAD_ACK, queueItemId, sessionId })) {
              log.debug(`[Guest] Sent PRELOAD_ACK for ${queueItemId} sid=${sessionId}`);
            }
          }
        }

        // Hide preload loader (background preload complete)
        showLoader(false);

        // If guest was waiting for this preloaded file, trigger playback.
        // Lifecycle is authoritative for the wait gate; pendingRecoveryTarget
        // confirms the exact queue item and session match.
        const shouldActivate = isExactAwaitedPreload(completionIdentity);
        if (shouldActivate) {
          log.debug('[Preload] Guest was waiting for this track. Playing now.');
          // Lifecycle: the blob we were AWAITING_PRELOAD for
          // is now assembled → promote to DECODING. No-op if we're in any other
          // state (e.g. background preload for next track while currently PLAYING).
          transition({ type: 'PRELOAD_FILE_READY', queueItemId });
          bus.emit('storage:use-preloaded', queueItemId, filename, completionIdentity.sessionId);
          if (samePreloadIdentity(_awaitedPreloadIdentity, completionIdentity)) {
            _awaitedPreloadIdentity = null;
          }
        }
      } catch (e) {
        log.error('[Preload] preload-file-ready handler failed:', e);
      }
    },
  );

  // Handle preload-ready notification (emitted after PRELOAD_END)
  bus.on('storage:preload-ready', (queueItemId: string) => {
    log.debug(`[Preload] Preload ready for queue item: ${queueItemId}`);
    // This signals the preload chain is complete.
    // The actual file finalization is handled by storage:file-ready → storage:preload-file-ready
  });

  bus.on('state:playback.pendingRecoveryTarget', () => {
    const awaited = _awaitedPreloadIdentity;
    if (!awaited) return;
    const target = getState('playback.pendingRecoveryTarget');
    if (target?.queueItemId !== awaited.queueItemId) {
      _awaitedPreloadIdentity = null;
    }
  });

  bus.on('state:playlist.currentQueueItemId', (queueItemId: unknown) => {
    if (_awaitedPreloadIdentity && queueItemId !== _awaitedPreloadIdentity.queueItemId) {
      _awaitedPreloadIdentity = null;
    }
  });

  // A PRO_FILE_PRELOAD frame can beat the persistent playlist projection on
  // a fresh/returning member. Projection publishes playlist.items only after
  // the PRO media hooks exist, making this the safe replay boundary.
  bus.on('state:playlist.items', replayPendingProRoomPreloadHint);

  // A late PRO participant misses the original broadcast hint. Re-send the
  // exact active preload owner once its data connection becomes eligible;
  // duplicate hints are idempotent on the member.
  const sendProRoomPreloadHintToPeer = (peerId: string): void => {
    if (!PRO_ROOM_FILE_PRELOAD_ENABLED || getState('room.context').kind !== 'pro') {
      return;
    }
    // Coordinator-free PRO rooms never create browser data targets. Keep this
    // legacy listener inert if an unrelated orchestrator event leaks through.
    if (!getState('network.connectedPeers').some((candidate) => candidate.id === peerId)) return;
    const target = getState('preload.activeTarget');
    const queueItemId = getState('preload.nextQueueItemId');
    const sessionId = Number(target?.sessionId);
    if (
      !queueItemId ||
      target?.queueItemId !== queueItemId ||
      !Number.isSafeInteger(sessionId) ||
      sessionId <= 0
    ) {
      schedulePreload(0);
      return;
    }
    const peer = getState('network.connectedPeers').find((candidate) => candidate.id === peerId);
    if (!peer?.conn?.open) return;
    safeSend(peer.conn, { type: MSG.PRO_FILE_PRELOAD, queueItemId, sessionId });
  };
  // Initial peers emit peer-joined; a connection promoted to a data target
  // later emits peer-data-target-ready. Listen to both and keep the hint
  // idempotent so local, remote, and reclassified participants all catch up.
  bus.on('orchestrator:peer-joined', sendProRoomPreloadHintToPeer);
  bus.on('orchestrator:peer-data-target-ready', sendProRoomPreloadHintToPeer);

  bus.on('state:network.hostConn', (nextConnection: unknown) => {
    const next = (nextConnection as DataConnection | null) ?? null;
    const previous = observedProHostConn;
    observedProHostConn = next;
    if (next === previous || getState('room.context').kind !== 'pro') return;

    // PRO session IDs are generated per coordinator device. A failover keeps
    // the room code but replaces (member) or removes (new coordinator) the
    // authenticated host connection. Both edges must discard the prior SID;
    // otherwise a newly elected coordinator can rebroadcast its predecessor's
    // high SID before generating a lower device-local SID.
    cancelProRoomPlaylistFilePreload();
    _proRoomPreloadOwner = null;
    resetPreloadReceiveAuthority();
    if (!next) schedulePreload(0);
  });

  bus.on('state:room.context', () => {
    const context = getState('room.context');
    const nextProRoomId = context.kind === 'pro' ? context.roomId : null;
    const enteredProRoom = !!nextProRoomId && nextProRoomId !== observedProRoomId;
    observedProRoomId = nextProRoomId;
    if (context.kind !== 'pro') {
      _pendingProRoomPreloadHint = null;
      return;
    }
    // Authority can flip member→coordinator before network.hostConn is
    // Reset room-scoped preload ownership when entering another persistent room.
    if (enteredProRoom) {
      cancelProRoomPlaylistFilePreload();
      _proRoomPreloadOwner = null;
      resetPreloadReceiveAuthority();
      if (!getState('network.hostConn')) schedulePreload(0);
      return;
    }
    replayPendingProRoomPreloadHint();
    // Every PRO endpoint independently fetches the next immutable R2 object.
    if (!getState('network.hostConn')) schedulePreload(0);
  });

  // Clean up module-local variables when the session is left
  bus.on('state:network.sessionCode', () => {
    // Preload SIDs, reorder buffers, and transfer scopes belong to exactly one
    // room. Reset on every actual room-code change, including A -> B without
    // an intermediate empty value.
    cancelProRoomPlaylistFilePreload();
    _proRoomPreloadOwner = null;
    resetPreloadReceiveAuthority();
  });

  log.info('[Preload] Handlers registered');
}
