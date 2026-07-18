import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { batchSetState, getState, setState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { MSG } from '../core/constants.ts';
import { scheduleSessionReset } from '../core/session-reset.ts';
import { t } from '../i18n/index.ts';
import { broadcastTracksAdded } from '../chat/queue-events.ts';
import { showLoader, updateLoader } from '../ui/toast.ts';
import { broadcast, sendToHost } from '../network/peer.ts';
import { applyRoomEffectsState, captureRoomEffectsState } from '../audio/effects.ts';
import { roomEffectsEqual, type ProRoomEffectsSnapshot } from '../core/room-effects.ts';
import { getHostNow } from '../network/shared-clock.ts';
import { registerHandler } from '../network/protocol.ts';
import { applyPlaylistSnapshot, moveQueueItemBefore } from '../player/queue-model.ts';
import {
  getCurrentAudioBuffer,
  isPlayLocked,
  liveAudioBufferPcmBytes,
  setPendingRecoveryTarget,
} from '../player/_state.ts';
import {
  isAudioDecodeAdmissionError,
  reserveEncodedReceiveMemoryWithinBudget,
} from '../player/decode-admission.ts';
import {
  applyPlaylistQueueModeState,
  capturePlaylistQueueModeState,
  clearPreloadState,
  getShuffleNextPlayableQueueItemId,
  playNextTrack,
  playTrack,
  reconcileShuffleOrderForCurrentPlaylist,
} from '../player/playlist.ts';
import { schedulePreload } from '../storage/preload.ts';
import {
  getTrackPosition,
  isFilePipelineBusyForPlay,
  pause,
  play,
  seekTo,
} from '../player/transport.ts';
import { getPlaybackModeActivity } from '../player/ownership.ts';
import { getYouTubePlayer, isYtLoadInProgress } from '../youtube/_state.ts';
import {
  isCoordinator,
  resetRoomContext,
  setRoomContext,
  verifyPeerCapability,
} from '../rooms/authority.ts';
import type {
  DataConnection,
  DeveloperCommandFrame,
  DeveloperCommandResultCode,
  DeveloperInvalidationFrame,
  PlaylistItem,
  PlaylistWireItem,
  QueueItemId,
  RoomContext,
} from '../types/index.ts';
import type { ProQueueAdditionFrame } from '../network/transport/types.ts';
import {
  ProRoomApiClient,
  ProRoomApiError,
  type ActivateProRoomInput,
  type CreateProRoomSessionInput,
  type EnterProRoomPresenceOptions,
  type ProRoomBootstrap,
  type RecoverProRoomOwnerInput,
} from './api.ts';
import type { ProRoomR2Source, ProRoomSnapshot } from './contracts.ts';
import type { ProRoomQueueModeSnapshot } from './queue-mode.ts';
import {
  registerProRoomLegacyMediaHooks,
  restoreProRoomLegacyPlayback,
  type ProRoomLegacyMediaHooks,
} from './legacy-media-hooks.ts';
import { ProRoomInvalidationHighWater } from './invalidation-high-water.ts';
import { buildProRoomUnloadCheckpoint, waitForProRoomPresenceClose } from './hard-close.ts';
import { createProRoomIdempotencyKey } from './idempotency.ts';
import { DeveloperControlExecutor } from './developer-control.ts';
import {
  registerProRoomHardCloseHandler,
  registerProRoomLeaveHandler,
  registerProRoomSignalingEpochAdvanceHandler,
  registerProRoomSignalingReconnectHandler,
} from './lifecycle-hook.ts';
import { ProRoomHeartbeatSingleFlight } from './heartbeat-single-flight.ts';
import { ProRoomMediaTransfer } from './media-transfer.ts';
import { LegacyProRoomNetworkBridge } from './network-bridge.ts';
import { completeProRoomPinRotation } from './pin-rotation.ts';
import { ProRoomPlaylistProjection } from './playlist-projection.ts';
import { ProRoomPlaylistStateManager } from './playlist-state-manager.ts';
import {
  dispatchProRoomRemovalTransition,
  findRemovedProRoomQueueItemIds,
  resolveProRoomRemovalTransition,
} from './playlist-transition.ts';
import { ProRoomSessionController, type ProRoomSessionObserver } from './session-controller.ts';
import { createByteWeightedProgressEntries } from './transfer-progress.ts';
import { resetProRoomTransportRecovery } from './transport-recovery.ts';
import { onProRoomTabTakeover } from './tab-handoff.ts';
import {
  bindProSystemAudioSession,
  configureProSystemAudioService,
  refreshProSystemAudioState,
  releaseLocalProSystemAudioLease,
  resetProSystemAudioService,
} from './system-audio-service.ts';

const HEARTBEAT_INTERVAL_MS = 15_000;
const TOPOLOGY_RECOVERY_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const SIGNALING_REFRESH_INTERVAL_MS = 45_000;
const HEARTBEAT_TIMER = 'pro-room-heartbeat';
const SIGNALING_REFRESH_TIMER = 'pro-room-signaling-refresh';
const PLAYBACK_CHECKPOINT_INTERVAL_MS = 10_000;
const PLAYBACK_CHECKPOINT_DEBOUNCE_MS = 350;
const PLAYBACK_CHECKPOINT_TIMER = 'pro-room-playback-checkpoint';
const PLAYBACK_CHECKPOINT_DEBOUNCE_TIMER = 'pro-room-playback-checkpoint-debounce';
const EFFECTS_CHECKPOINT_DEBOUNCE_MS = 350;
const EFFECTS_CHECKPOINT_DEBOUNCE_TIMER = 'pro-room-effects-checkpoint-debounce';
const QUEUE_MODE_CHECKPOINT_DEBOUNCE_MS = 350;
const QUEUE_MODE_CHECKPOINT_DEBOUNCE_TIMER = 'pro-room-queue-mode-checkpoint-debounce';
const QUEUE_MODE_CHECKPOINT_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const PLAYBACK_RESTORE_TIMEOUT_MS = 120_000;
const PLAYBACK_RESTORE_TIMEOUT_TIMER = 'pro-room-playback-restore-timeout';
const INVALIDATION_REFRESH_MIN_INTERVAL_MS = 5_000;
const INVALIDATION_REFRESH_TIMER = 'pro-room-invalidation-refresh';
const QUEUE_ADDITION_FLUSH_TIMER = 'pro-room-queue-addition-flush';
const QUEUE_ADDITION_REORDER_WINDOW_MS = 100;
const EXPLICIT_LEAVE_CLOSE_TIMEOUT_MS = 1_200;
/** Must match the local-file coordinator lead used by player/transport.ts. */
const DEVELOPER_FILE_PLAY_SCHEDULE_AHEAD_MS = 200;

const api = new ProRoomApiClient();
configureProSystemAudioService(api);
const bridge = new LegacyProRoomNetworkBridge();
let active = false;
let refreshInFlight = false;
let visibilityBound = false;
let playlistManager: ProRoomPlaylistStateManager | null = null;
let playlistProjection: ProRoomPlaylistProjection | null = null;
let mediaTransfer: ProRoomMediaTransfer | null = null;
let playlistRoomCode: string | null = null;
let playlistSignature = '';
let playlistRuntimeAbort: AbortController | null = null;
interface PlaylistRuntimeLease {
  generation: number;
  roomCode: string;
}
let playlistRuntimeGeneration = 0;
let playlistRuntimeLease: PlaylistRuntimeLease | null = null;
let coordinatorRefresh: Promise<void> | null = null;
let checkpointInFlight = false;
let checkpointDirty = false;
let effectsMutationTail: Promise<void> = Promise.resolve();
let acceptedEffects: ProRoomEffectsSnapshot | null = null;
let suppressEffectsCheckpoint = false;
let lastEffectsCoordinatorEpoch = -1;
let pendingEffectsBroadcast: {
  commandId: string;
  coordinatorEpoch: number;
} | null = null;
let queueModeMutationTail: Promise<void> = Promise.resolve();
let acceptedQueueMode: ProRoomQueueModeSnapshot | null = null;
let suppressQueueModeCheckpoint = false;
let lastQueueModeCoordinatorEpoch = -1;
let queueModeCheckpointDirty = false;
let queueModeCheckpointRetryAttempt = 0;
let suppressPlaybackCheckpoint = false;
let lastPlaybackRestoreKey = '';
let terminalRecoveryInFlight = false;
let topologyRecoveryAttempt = 0;
let invalidationRefreshScheduled = false;
let lastInvalidationRefreshAt = 0;
const invalidationHighWater = new ProRoomInvalidationHighWater();
const heartbeatSingleFlight = new ProRoomHeartbeatSingleFlight();
const seenQueueAdditionEventIds = new Set<string>();
const pendingQueueAdditions = new Map<string, ProQueueAdditionFrame>();
let lastAnnouncedQueueAdditionOrder = 0;
let pendingPlaybackRestore: {
  queueItemId: QueueItemId;
  state: 'playing' | 'paused';
} | null = null;
interface PendingFileDownload {
  queueItemId: QueueItemId;
  leaseGeneration: number;
  roomCode: string;
  controller: AbortController;
  promise: Promise<File | null>;
  mode: 'foreground' | 'preload';
  /** Admission intent never changes when an in-flight preload is promoted. */
  startedAsPreload: boolean;
  source: ProRoomR2Source | null;
  progress: number;
  loaderId: string | null;
}
let pendingFileDownload: PendingFileDownload | null = null;
let pendingPreloadDownload: PendingFileDownload | null = null;
interface DeferredPreloadRequest {
  queueItemId: QueueItemId;
  leaseGeneration: number;
  roomCode: string;
  generation: number;
  promise: Promise<File | null>;
}
let deferredPreloadRequest: DeferredPreloadRequest | null = null;
let deferredPreloadGeneration = 0;
let uploadOperationTail: Promise<void> = Promise.resolve();
let transferLoaderSequence = 0;
const activeTransferLoaderIds = new Set<string>();

function openTransferLoader(kind: 'upload' | 'download', text: string): string {
  const id = `pro-room-${kind}-${++transferLoaderSequence}`;
  activeTransferLoaderIds.add(id);
  showLoader(true, text, id);
  updateLoader(0, id);
  return id;
}

function reportTransferProgress(id: string, fraction: number): void {
  if (!activeTransferLoaderIds.has(id)) return;
  // PUT/GET byte completion is followed by server verification, canonical
  // snapshot acceptance, and (for downloads) File publication. Reserve 100%
  // for the completion of that whole operation rather than claiming success
  // as soon as the last network byte arrives.
  const percent = Math.round(Math.max(0, Math.min(0.99, fraction)) * 100);
  updateLoader(percent, id);
}

function closeTransferLoader(id: string, completed = false): void {
  if (!activeTransferLoaderIds.delete(id)) return;
  if (completed) updateLoader(100, id);
  showLoader(false, undefined, id);
}

function closeAllTransferLoaders(): void {
  for (const id of activeTransferLoaderIds) showLoader(false, undefined, id);
  activeTransferLoaderIds.clear();
}

function createRoomLinkedAbortController(parent?: AbortSignal): {
  controller: AbortController;
  detach: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', abort, { once: true });
  return {
    controller,
    detach: () => parent?.removeEventListener('abort', abort),
  };
}

function cancelSupersededFileDownload(queueItemId: QueueItemId | null): void {
  const pending = pendingFileDownload;
  if (!pending || pending.queueItemId === queueItemId) return;
  pending.controller.abort();
}

function cancelPendingPreloadDownload(queueItemId?: QueueItemId): void {
  const pending = pendingPreloadDownload;
  if (!pending || (queueItemId !== undefined && pending.queueItemId !== queueItemId)) return;
  pending.controller.abort();
}

function shouldRetainPendingProDownload(roomCode: string, context: RoomContext): boolean {
  return context.kind === 'pro' && context.roomId === roomCode;
}

export function shouldRetainPendingProDownloadForTests(
  roomCode: string,
  context: RoomContext,
): boolean {
  return shouldRetainPendingProDownload(roomCode, context);
}

function isDownloadLeaseCurrent(lease: PlaylistRuntimeLease): boolean {
  const context = getState('room.context');
  return (
    isPlaylistLeaseCurrent(lease) && context.kind === 'pro' && context.roomId === lease.roomCode
  );
}

function sameR2Source(left: ProRoomR2Source, right: ProRoomR2Source): boolean {
  return (
    left.assetId === right.assetId &&
    left.version === right.version &&
    left.byteLength === right.byteLength &&
    left.mime === right.mime &&
    left.sha256 === right.sha256
  );
}

function pendingDownloadMatches(
  pending: PendingFileDownload,
  queueItemId: QueueItemId,
  lease: PlaylistRuntimeLease,
): boolean {
  if (
    pending.queueItemId !== queueItemId ||
    pending.leaseGeneration !== lease.generation ||
    pending.roomCode !== lease.roomCode ||
    pending.controller.signal.aborted
  ) {
    return false;
  }

  const liveSource = playlistProjection?.sourceFor(queueItemId) ?? null;
  return (
    pending.source === null ||
    (liveSource?.kind === 'pro-r2' && sameR2Source(pending.source, liveSource))
  );
}

async function resolveCanonicalR2Source(
  queueItemId: QueueItemId,
  lease: PlaylistRuntimeLease,
): Promise<ProRoomR2Source | null> {
  const current = playlistProjection?.sourceFor(queueItemId) ?? null;
  if (current?.kind === 'pro-r2') return current;

  // A newly connected participant can receive the legacy queue projection a
  // moment before its own authenticated heartbeat carries the canonical media
  // source. Refresh once; never accept an asset identity supplied by a peer.
  await runHeartbeat(true, true);
  if (!isDownloadLeaseCurrent(lease)) return null;
  const refreshed = playlistProjection?.sourceFor(queueItemId) ?? null;
  return refreshed?.kind === 'pro-r2' ? refreshed : null;
}

function isPlaylistLeaseCurrent(lease: PlaylistRuntimeLease): boolean {
  return (
    playlistRuntimeLease?.generation === lease.generation &&
    playlistRuntimeLease.roomCode === lease.roomCode &&
    playlistRoomCode === lease.roomCode
  );
}

function projectedSignature(snapshot: ProRoomSnapshot): string {
  return JSON.stringify([snapshot.playlist, snapshot.currentQueueItemId]);
}

function playlistWireItems(items: readonly PlaylistItem[]): PlaylistWireItem[] {
  return items.map((item) => ({
    queueItemId: item.queueItemId,
    type: item.type,
    name: item.name,
    ...(item.title === undefined ? {} : { title: item.title }),
    ...(item.artist === undefined ? {} : { artist: item.artist }),
    ...(item.thumbnail === undefined ? {} : { thumbnail: item.thumbnail }),
    videoId: item.videoId,
    playlistId: item.playlistId,
  }));
}

function attachCachedFiles(snapshot: ProRoomSnapshot): void {
  if (!mediaTransfer) return;
  const sourceById = new Map(snapshot.playlist.map((item) => [item.queueItemId, item]));
  const currentQueueItemId = getState('playlist.currentQueueItemId');
  const current = getState('playlist.items');
  let changed = false;
  const next = current.map((item) => {
    const wire = sourceById.get(item.queueItemId);
    if (!wire || wire.source.kind !== 'pro-r2') return item;
    // A playlist row is not a second cache. Only the selected occurrence may
    // expose a File to the legacy decoder; background assets remain owned by
    // ProRoomAssetCache so its byte-bounded LRU cannot be bypassed by row refs.
    if (item.queueItemId !== currentQueueItemId) {
      if (!item.file) return item;
      const { file: _discardedFile, ...withoutFile } = item;
      changed = true;
      return withoutFile;
    }
    const file = mediaTransfer?.cache.get(wire.source, wire.name) ?? null;
    if (!file || item.file === file) return item;
    changed = true;
    return { ...item, file };
  });
  if (changed) setState('playlist.items', next);
}

function pruneNonCurrentProRoomFileRows(): void {
  if (!playlistProjection || getState('room.context').kind !== 'pro') return;
  const currentQueueItemId = getState('playlist.currentQueueItemId');
  const items = getState('playlist.items');
  let changed = false;
  const next = items.map((item) => {
    if (!item.file || item.queueItemId === currentQueueItemId) return item;
    if (playlistProjection?.sourceFor(item.queueItemId)?.kind !== 'pro-r2') return item;
    const { file: _discardedFile, ...withoutFile } = item;
    changed = true;
    return withoutFile;
  });
  if (changed) setState('playlist.items', next);
}

function reconcileRemovedProRoomQueueState(removedQueueItemIds: readonly QueueItemId[]): void {
  if (removedQueueItemIds.length === 0) return;
  const removedIds = new Set(removedQueueItemIds);
  if (pendingFileDownload && removedIds.has(pendingFileDownload.queueItemId)) {
    pendingFileDownload.controller.abort();
  }
  if (pendingPreloadDownload && removedIds.has(pendingPreloadDownload.queueItemId)) {
    pendingPreloadDownload.controller.abort();
  }

  // A PRO mutation is projected locally before the coordinator's legacy
  // PLAYLIST_UPDATE relay. That later frame is a duplicate revision, so the
  // ordinary guest cleanup path cannot be relied upon to release background
  // bytes owned by a deleted occurrence.
  const preloadOwnsRemovedItem =
    removedIds.has(getState('preload.nextQueueItemId') ?? '') ||
    removedIds.has(getState('preload.ready')?.queueItemId ?? '') ||
    removedIds.has(getState('preload.activeTarget')?.queueItemId ?? '');
  if (preloadOwnsRemovedItem) clearPreloadState();

  const recoveryTarget = getState('playback.pendingRecoveryTarget');
  if (recoveryTarget?.queueItemId && removedIds.has(recoveryTarget.queueItemId)) {
    setPendingRecoveryTarget(null);
    setState('recovery.pending', false);
  }

  const connectedPeers = getState('network.connectedPeers');
  if (
    connectedPeers.some((peer) =>
      [...removedIds].some((queueItemId) => peer.preloadedQueueItemIds.has(queueItemId)),
    )
  ) {
    setState(
      'network.connectedPeers',
      connectedPeers.map((peer) => {
        const preloadedQueueItemIds = new Set(peer.preloadedQueueItemIds);
        let changed = false;
        for (const queueItemId of removedIds) {
          changed = preloadedQueueItemIds.delete(queueItemId) || changed;
        }
        return changed ? { ...peer, preloadedQueueItemIds } : peer;
      }),
    );
  }
}

/** @internal Focused regression seam for accepted PRO removal projections. */
export function reconcileRemovedProRoomQueueStateForTests(
  removedQueueItemIds: readonly QueueItemId[],
): void {
  reconcileRemovedProRoomQueueState(removedQueueItemIds);
}

async function applyProjectedPlaylist(
  snapshot: ProRoomSnapshot,
  playlist: PlaylistItem[],
  lease: PlaylistRuntimeLease,
): Promise<void> {
  if (!isPlaylistLeaseCurrent(lease) || snapshot.roomCode !== lease.roomCode) return;
  const nextSignature = projectedSignature(snapshot);
  const firstProjection = playlistSignature === '';
  if (firstProjection || nextSignature !== playlistSignature) {
    const previousItems = getState('playlist.items');
    const previousCurrent = getState('playlist.currentQueueItemId');
    const removedQueueItemIds = firstProjection
      ? []
      : findRemovedProRoomQueueItemIds(previousItems, playlist);
    const survivingQueueItemIds = new Set(playlist.map((item) => item.queueItemId));
    const preferredShuffleSuccessor =
      !firstProjection &&
      isCoordinator() &&
      getState('playlist.isShuffle') &&
      previousCurrent !== null &&
      removedQueueItemIds.includes(previousCurrent)
        ? getShuffleNextPlayableQueueItemId((queueItemId) => survivingQueueItemIds.has(queueItemId))
        : null;
    const removalTransition = firstProjection
      ? { removedCurrent: false, successorQueueItemId: null }
      : resolveProRoomRemovalTransition(
          previousItems,
          playlist,
          previousCurrent,
          preferredShuffleSuccessor,
        );
    const payload = {
      list: playlistWireItems(playlist),
      // The room revision, unlike playlistRevision, also advances when the
      // selected item changes. It is therefore the safe legacy queue clock.
      revision: snapshot.revision,
      currentQueueItemId: snapshot.currentQueueItemId,
    };
    const outcome = applyPlaylistSnapshot(payload, firstProjection ? 'rebase' : 'monotonic');
    if (outcome === 'invalid' || outcome === 'stale' || outcome === 'conflict') {
      throw new Error(`PRO_ROOM_PLAYLIST_PROJECTION_${outcome.toUpperCase()}`);
    }
    if (getState('playlist.isShuffle')) reconcileShuffleOrderForCurrentPlaylist();
    reconcileRemovedProRoomQueueState(removedQueueItemIds);
    playlistSignature = nextSignature;
    attachCachedFiles(snapshot);
    if (isCoordinator()) broadcast({ type: MSG.PLAYLIST_UPDATE, ...payload });
    // A member's own accepted mutation is projected before the coordinator
    // relays the same revision. That later PLAYLIST_UPDATE is a duplicate, so
    // it cannot be relied upon to tear down media owned by a deleted row.
    // Stop locally now; only the elected coordinator chooses/starts the
    // successor and therefore remains the sole playback authority.
    dispatchProRoomRemovalTransition(
      removalTransition,
      isCoordinator(),
      (queueItemId) => bus.emit('playlist:play-track', queueItemId),
      () => bus.emit('player:stop-all-media', { cancelInFlight: true, clearBuffer: true }),
    );
    // PRO mutations are projected through this runtime and therefore bypass
    // playlist.ts's ordinary add/reorder/remove scheduling paths. Re-evaluate
    // the coordinator-owned next occurrence after every accepted projection;
    // schedulePreload preserves an exact still-valid owner and replaces only a
    // target that actually changed.
    if (isCoordinator()) schedulePreload();
    return;
  }
  attachCachedFiles(snapshot);
}

function reportPlaylistError(error: unknown): void {
  log.warn('[PRO] Persistent playlist operation failed', error);
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
  const message =
    code === 'PRO_ROOM_MEDIA_UPLOAD_SIZE_INVALID'
      ? t('pro.file_too_large')
      : code === 'ROOM_QUOTA_EXCEEDED'
        ? t('pro.quota_exceeded')
        : code === 'PLAYLIST_CAPACITY_EXCEEDED' ||
            code === 'PRO_ROOM_PLAYLIST_LIMIT_REACHED' ||
            code === 'ROOM_STATE_CAPACITY_EXCEEDED' ||
            code === 'REQUEST_TOO_LARGE'
          ? t('playlist.queue_full')
          : t('pro.connect_failed');
  bus.emit('ui:show-toast', message);
}

function ensureForegroundDownloadLoader(owner: PendingFileDownload): void {
  if (owner.loaderId !== null) return;
  owner.loaderId = openTransferLoader('download', t('pro.downloading'));
  reportTransferProgress(owner.loaderId, owner.progress);
}

function promotePendingPreload(owner: PendingFileDownload): Promise<File | null> {
  const foreground = pendingFileDownload;
  if (foreground && foreground !== owner) foreground.controller.abort();
  if (pendingPreloadDownload === owner) pendingPreloadDownload = null;
  owner.mode = 'foreground';
  pendingFileDownload = owner;
  ensureForegroundDownloadLoader(owner);
  return owner.promise;
}

function startProRoomFileDownload(
  queueItemId: QueueItemId,
  lease: PlaylistRuntimeLease,
  mode: PendingFileDownload['mode'],
): PendingFileDownload | null {
  const transfer = mediaTransfer;
  const projection = playlistProjection;
  const context = getState('room.context');
  const item = getState('playlist.items').find(
    (candidate) => candidate.queueItemId === queueItemId,
  );
  if (
    !transfer ||
    !projection ||
    !item ||
    item.type !== 'file' ||
    !isPlaylistLeaseCurrent(lease) ||
    context.kind !== 'pro' ||
    context.roomId !== lease.roomCode
  ) {
    return null;
  }

  const linkedAbort = createRoomLinkedAbortController(playlistRuntimeAbort?.signal);
  const owner: PendingFileDownload = {
    queueItemId,
    leaseGeneration: lease.generation,
    roomCode: lease.roomCode,
    controller: linkedAbort.controller,
    promise: Promise.resolve(null),
    mode,
    startedAsPreload: mode === 'preload',
    source: null,
    progress: 0,
    loaderId: null,
  };
  if (mode === 'foreground') ensureForegroundDownloadLoader(owner);

  let published = false;
  const download = resolveCanonicalR2Source(queueItemId, lease)
    .then(async (source) => {
      if (!source || !isDownloadLeaseCurrent(lease) || owner.controller.signal.aborted) return null;
      owner.source = source;
      const currentResident = getState('files.current');
      const retainedEncodedBytes =
        currentResident?.queueItemId !== queueItemId ? (currentResident?.blob.size ?? 0) : 0;
      if (owner.mode === 'preload') {
        if (retainedEncodedBytes + source.byteLength > transfer.cache.maxTotalBytes) {
          log.debug('[PRO] Background media preload skipped: encoded RAM budget is occupied');
          return null;
        }
      }

      let receiveReservation: ReturnType<typeof reserveEncodedReceiveMemoryWithinBudget> | null =
        null;
      try {
        // A background GET assembles byte chunks while the current PCM remains
        // live. Reuse the shared receive ledger for that overlap; foreground
        // selection already releases the old PCM before resolving this hook.
        if (owner.startedAsPreload) {
          receiveReservation = reserveEncodedReceiveMemoryWithinBudget(source.byteLength, {
            fileName: item.name,
            retainedPcmBytes: liveAudioBufferPcmBytes(),
          });
        }
        const file = await transfer.download({
          code: lease.roomCode,
          name: item.name,
          source,
          onProgress: (fraction) => {
            owner.progress = fraction;
            if (owner.loaderId !== null) reportTransferProgress(owner.loaderId, fraction);
          },
          signal: owner.controller.signal,
          retainedEncodedBytes,
        });
        if (!isDownloadLeaseCurrent(lease) || owner.controller.signal.aborted) return null;

        const liveSource = projection.sourceFor(queueItemId);
        if (!liveSource || liveSource.kind !== 'pro-r2' || !sameR2Source(liveSource, source)) {
          log.warn('[PRO] Downloaded asset no longer matches the canonical playlist source');
          return null;
        }

        // A completed background body remains cache-only. resolveFile attaches
        // it to the selected row only when playback adopts this occurrence.
        if (owner.mode === 'preload') {
          published = true;
          return file;
        }

        const items = getState('playlist.items');
        const index = items.findIndex((candidate) => candidate.queueItemId === queueItemId);
        if (index < 0 || items[index]?.type !== 'file') return null;
        const next = [...items];
        next[index] = { ...next[index]!, file };
        setState('playlist.items', next);
        published = true;
        return file;
      } finally {
        receiveReservation?.release();
      }
    })
    .catch((error) => {
      if (owner.controller.signal.aborted || !isDownloadLeaseCurrent(lease)) return null;
      if (owner.mode === 'preload') {
        if (isAudioDecodeAdmissionError(error)) {
          log.debug('[PRO] Background media preload skipped by RAM admission');
        } else {
          log.warn('[PRO] Background media preload failed', error);
        }
        return null;
      }
      if (getState('playlist.currentQueueItemId') === queueItemId) reportPlaylistError(error);
      throw error;
    })
    .finally(() => {
      linkedAbort.detach();
      if (owner.loaderId !== null) closeTransferLoader(owner.loaderId, published);
      if (pendingFileDownload === owner) pendingFileDownload = null;
      if (pendingPreloadDownload === owner) pendingPreloadDownload = null;
    });
  owner.promise = download;
  if (mode === 'foreground') pendingFileDownload = owner;
  else pendingPreloadDownload = owner;
  return owner;
}

function deferProRoomFilePreload(
  queueItemId: QueueItemId,
  lease: PlaylistRuntimeLease,
): Promise<File | null> {
  const existing = deferredPreloadRequest;
  if (
    existing?.queueItemId === queueItemId &&
    existing.leaseGeneration === lease.generation &&
    existing.roomCode === lease.roomCode
  ) {
    return existing.promise;
  }

  const generation = ++deferredPreloadGeneration;
  const request: DeferredPreloadRequest = {
    queueItemId,
    leaseGeneration: lease.generation,
    roomCode: lease.roomCode,
    generation,
    promise: Promise.resolve(null),
  };
  deferredPreloadRequest = request;
  request.promise = (async () => {
    try {
      // Foreground media owns the receive budget. Wait for every foreground
      // owner that races this hint, then begin exactly the newest deferred
      // preload instead of dropping the one-shot coordinator message.
      while (pendingFileDownload) {
        const foreground = pendingFileDownload;
        try {
          await foreground.promise;
        } catch {
          // A failed current track still releases the lane for the next hint.
        }
        if (
          deferredPreloadRequest !== request ||
          deferredPreloadGeneration !== generation ||
          !isPlaylistLeaseCurrent(lease)
        ) {
          return null;
        }
      }

      if (deferredPreloadRequest !== request || !isPlaylistLeaseCurrent(lease)) return null;
      const item = getState('playlist.items').find(
        (candidate) => candidate.queueItemId === queueItemId,
      );
      if (!item || item.type !== 'file') return null;
      if (item.file) return item.file;

      const source = playlistProjection?.sourceFor(queueItemId);
      if (source?.kind === 'pro-r2') {
        const cached = mediaTransfer?.cache.get(source, item.name);
        if (cached) return cached;
      }

      const warm = pendingPreloadDownload;
      if (warm && pendingDownloadMatches(warm, queueItemId, lease)) return warm.promise;
      if (warm) warm.controller.abort();
      return startProRoomFileDownload(queueItemId, lease, 'preload')?.promise ?? null;
    } finally {
      if (deferredPreloadRequest === request) deferredPreloadRequest = null;
    }
  })();
  return request.promise;
}

function cancelDeferredProRoomPreload(queueItemId?: QueueItemId): void {
  const deferred = deferredPreloadRequest;
  if (!deferred || (queueItemId && deferred.queueItemId !== queueItemId)) return;
  deferredPreloadGeneration++;
  deferredPreloadRequest = null;
}

function reconcileAuthoritativePeers(snapshot: ProRoomSnapshot): void {
  if (
    snapshot.viewer?.participantId !== snapshot.presence.coordinatorParticipantId ||
    getState('network.appRole') !== 'host'
  ) {
    return;
  }
  const present = new Set(snapshot.presence.participants.map((peer) => peer.participantId));
  for (const peer of getState('network.connectedPeers')) {
    if (present.has(peer.id)) continue;
    log.info(`[PRO] Closing peer absent from authoritative presence: ${peer.id}`);
    try {
      peer.conn?.close();
    } catch {
      /* connection close is best-effort; the next topology refresh also drops it */
    }
  }
}

function sendCoordinatorInvalidation(snapshot: ProRoomSnapshot): void {
  if (isCoordinator()) return;
  sendToHost({
    type: MSG.PRO_ROOM_INVALIDATED,
    revision: snapshot.revision,
    playlistRevision: snapshot.playlistRevision,
  });
}

function shouldStartFirstProjectedItem(
  previous: ProRoomSnapshot,
  next: ProRoomSnapshot,
): next is ProRoomSnapshot & { currentQueueItemId: QueueItemId } {
  return (
    previous.playlist.length === 0 &&
    previous.currentQueueItemId === null &&
    previous.playback.state === 'idle' &&
    next.playlist.length > 0 &&
    next.currentQueueItemId !== null &&
    next.playback.state === 'paused' &&
    next.playback.queueItemId === next.currentQueueItemId &&
    next.playback.positionSeconds === 0
  );
}

function installLegacyMediaHooks(
  manager: ProRoomPlaylistStateManager,
  lease: PlaylistRuntimeLease,
): void {
  const reportCurrentPlaylistError = (error: unknown) => {
    if (isPlaylistLeaseCurrent(lease)) reportPlaylistError(error);
  };
  const hooks: ProRoomLegacyMediaHooks = {
    addFiles(files, rejectedCount) {
      if (!isPlaylistLeaseCurrent(lease)) return true;
      if (files.length === 0) return true;
      if (rejectedCount > 0) {
        bus.emit('ui:show-toast', t('toast.unsupported_files_excluded', { count: rejectedCount }));
      }

      // The playlist manager serializes mutations. Mirror that ordering in the
      // UI so a newly queued batch at 0% cannot cover an upload already making
      // progress. The authoritative row still appears only after R2 complete
      // and snapshot acceptance.
      const operation = uploadOperationTail.then(async () => {
        if (!isPlaylistLeaseCurrent(lease)) return;
        const signal = playlistRuntimeAbort?.signal;
        if (!signal || signal.aborted) return;
        const loaderId = openTransferLoader('upload', t('pro.uploading'));
        let completed = false;
        try {
          const entries = createByteWeightedProgressEntries(files, (fraction) => {
            reportTransferProgress(loaderId, fraction);
          });
          await manager.addLocalFiles(
            entries.map(({ value: file, onProgress }) => ({ file, onProgress })),
            { signal },
          );
          completed = isPlaylistLeaseCurrent(lease) && !signal.aborted;
        } catch (error) {
          reportCurrentPlaylistError(error);
        } finally {
          closeTransferLoader(loaderId, completed);
        }
      });
      uploadOperationTail = operation.catch(() => undefined);
      return true;
    },
    addYouTube(item) {
      if (!isPlaylistLeaseCurrent(lease)) return true;
      if (item.type !== 'youtube' || !item.videoId) return false;
      void manager
        .addYouTube({
          queueItemId: item.queueItemId,
          name: item.name,
          videoId: item.videoId,
          ...(item.playlistId ? { playlistId: item.playlistId } : {}),
          ...(item.title === undefined ? {} : { title: item.title }),
          ...(item.artist === undefined ? {} : { artist: item.artist }),
          ...(item.thumbnail === undefined ? {} : { thumbnail: item.thumbnail }),
          signal: playlistRuntimeAbort?.signal,
        })
        .catch(reportCurrentPlaylistError);
      return true;
    },
    updateTrackMetadata(queueItemId, metadata) {
      if (!isPlaylistLeaseCurrent(lease)) return true;
      void manager
        .updateMetadata(
          queueItemId,
          {
            name: metadata.name,
            ...(metadata.title === undefined ? {} : { title: metadata.title }),
            ...(metadata.artist === undefined ? {} : { artist: metadata.artist }),
            ...(metadata.thumbnail === undefined ? {} : { thumbnail: metadata.thumbnail }),
          },
          { signal: playlistRuntimeAbort?.signal },
        )
        .catch(reportCurrentPlaylistError);
      return true;
    },
    removeTracks(queueItemIds) {
      if (!isPlaylistLeaseCurrent(lease)) return true;
      void manager
        .removeMany(queueItemIds, { signal: playlistRuntimeAbort?.signal })
        .catch(reportCurrentPlaylistError);
      return true;
    },
    reorderTrack(queueItemId, beforeQueueItemId, baseRevision) {
      if (!isPlaylistLeaseCurrent(lease)) return true;
      if (baseRevision !== getState('playlist.revision')) return false;
      const reordered = moveQueueItemBefore(queueItemId, beforeQueueItemId);
      if (!reordered) return true;
      void manager
        .reorder(
          reordered.map((item) => item.queueItemId),
          { baseRevision, signal: playlistRuntimeAbort?.signal },
        )
        .catch(reportCurrentPlaylistError);
      return true;
    },
    handlesPersistentFile(queueItemId) {
      if (!isPlaylistLeaseCurrent(lease)) return false;
      const context = getState('room.context');
      const item = getState('playlist.items').find(
        (candidate) => candidate.queueItemId === queueItemId,
      );
      return context.kind === 'pro' && context.roomId === lease.roomCode && item?.type === 'file';
    },
    resolveFile(queueItemId) {
      if (!isPlaylistLeaseCurrent(lease)) return null;
      if (!mediaTransfer || !playlistProjection) return null;
      const context = getState('room.context');
      if (context.kind !== 'pro' || context.roomId !== lease.roomCode) return null;
      const item = getState('playlist.items').find(
        (candidate) => candidate.queueItemId === queueItemId,
      );
      if (!item || item.type !== 'file') return null;

      const existing = pendingFileDownload;
      if (existing && pendingDownloadMatches(existing, queueItemId, lease)) return existing.promise;
      if (item.file) return Promise.resolve(item.file);

      // A completed self-preload is cache-only. Adopt the exact canonical
      // asset into the selected legacy row without opening a foreground loader
      // or issuing a second presign/GET.
      const source = playlistProjection.sourceFor(queueItemId);
      if (source?.kind === 'pro-r2') {
        const cached = mediaTransfer.cache.get(source, item.name);
        if (cached) {
          const items = getState('playlist.items');
          const index = items.findIndex((candidate) => candidate.queueItemId === queueItemId);
          if (index >= 0 && getState('playlist.currentQueueItemId') === queueItemId) {
            const next = [...items];
            next[index] = { ...next[index]!, file: cached };
            setState('playlist.items', next);
          }
          // FILE_PREPARE resolves the canonical asset before the legacy queue
          // selection is committed. The cache hit is still authoritative even
          // when the row is not selected yet; the caller performs selection
          // and final adoption without issuing a second GET.
          return Promise.resolve(cached);
        }
      }

      const warm = pendingPreloadDownload;
      if (warm && pendingDownloadMatches(warm, queueItemId, lease)) {
        return promotePendingPreload(warm);
      }

      if (existing) existing.controller.abort();
      if (warm) warm.controller.abort();
      return startProRoomFileDownload(queueItemId, lease, 'foreground')?.promise ?? null;
    },
    preloadFile(queueItemId) {
      if (!isPlaylistLeaseCurrent(lease)) return null;
      const projection = playlistProjection;
      const transfer = mediaTransfer;
      if (!projection || !transfer) return null;
      const context = getState('room.context');
      if (context.kind !== 'pro' || context.roomId !== lease.roomCode) return null;
      const item = getState('playlist.items').find(
        (candidate) => candidate.queueItemId === queueItemId,
      );
      if (!item || item.type !== 'file') return null;

      if (item.file) return Promise.resolve(item.file);

      const source = projection.sourceFor(queueItemId);
      if (source?.kind === 'pro-r2') {
        const cached = transfer.cache.get(source, item.name);
        if (cached) return Promise.resolve(cached);
      }

      const foreground = pendingFileDownload;
      if (foreground) {
        return pendingDownloadMatches(foreground, queueItemId, lease)
          ? foreground.promise
          : deferProRoomFilePreload(queueItemId, lease);
      }

      const warm = pendingPreloadDownload;
      if (warm && pendingDownloadMatches(warm, queueItemId, lease)) return warm.promise;
      if (warm) warm.controller.abort();
      return startProRoomFileDownload(queueItemId, lease, 'preload')?.promise ?? null;
    },
    hasPreloadedFile(queueItemId) {
      if (!isPlaylistLeaseCurrent(lease)) return false;
      const item = getState('playlist.items').find(
        (candidate) => candidate.queueItemId === queueItemId,
      );
      if (!item || item.type !== 'file') return false;
      if (item.file) return true;
      const warm = pendingPreloadDownload;
      if (warm && pendingDownloadMatches(warm, queueItemId, lease)) return true;
      const source = playlistProjection?.sourceFor(queueItemId);
      return source?.kind === 'pro-r2' && !!mediaTransfer?.cache.get(source, item.name);
    },
    cancelPreload(queueItemId) {
      if (!isPlaylistLeaseCurrent(lease)) return;
      cancelDeferredProRoomPreload(queueItemId);
      cancelPendingPreloadDownload(queueItemId);
    },
    cancelFileResolution() {
      if (!isPlaylistLeaseCurrent(lease)) return;
      pendingFileDownload?.controller.abort();
    },
  };
  registerProRoomLegacyMediaHooks(hooks);
}

function resetPlaylistRuntime(): void {
  playlistRuntimeGeneration += 1;
  playlistRuntimeLease = null;
  cancelDeferredProRoomPreload();
  pendingFileDownload?.controller.abort();
  pendingFileDownload = null;
  pendingPreloadDownload?.controller.abort();
  pendingPreloadDownload = null;
  playlistRuntimeAbort?.abort();
  playlistRuntimeAbort = null;
  closeAllTransferLoaders();
  uploadOperationTail = Promise.resolve();
  registerProRoomLegacyMediaHooks(null);
  mediaTransfer?.cache.clear();
  playlistManager = null;
  playlistProjection = null;
  mediaTransfer = null;
  playlistRoomCode = null;
  playlistSignature = '';
  coordinatorRefresh = null;
  invalidationRefreshScheduled = false;
  invalidationHighWater.reset();
  seenQueueAdditionEventIds.clear();
  pendingQueueAdditions.clear();
  lastAnnouncedQueueAdditionOrder = 0;
  clearManagedTimer(QUEUE_ADDITION_FLUSH_TIMER);
  lastInvalidationRefreshAt = 0;
  clearManagedTimer(INVALIDATION_REFRESH_TIMER);
  checkpointInFlight = false;
  checkpointDirty = false;
  acceptedEffects = null;
  suppressEffectsCheckpoint = false;
  lastEffectsCoordinatorEpoch = -1;
  pendingEffectsBroadcast = null;
  clearManagedTimer(EFFECTS_CHECKPOINT_DEBOUNCE_TIMER);
  queueModeMutationTail = Promise.resolve();
  acceptedQueueMode = null;
  suppressQueueModeCheckpoint = false;
  lastQueueModeCoordinatorEpoch = -1;
  queueModeCheckpointDirty = false;
  queueModeCheckpointRetryAttempt = 0;
  clearManagedTimer(QUEUE_MODE_CHECKPOINT_DEBOUNCE_TIMER);
  suppressPlaybackCheckpoint = false;
  lastPlaybackRestoreKey = '';
  pendingPlaybackRestore = null;
  clearManagedTimer(PLAYBACK_RESTORE_TIMEOUT_TIMER);
}

function ensurePlaylistManager(snapshot: ProRoomSnapshot): ProRoomPlaylistStateManager {
  if (playlistManager && playlistRoomCode === snapshot.roomCode) return playlistManager;
  resetPlaylistRuntime();
  playlistRuntimeAbort = new AbortController();
  playlistRoomCode = snapshot.roomCode;
  const lease: PlaylistRuntimeLease = {
    generation: playlistRuntimeGeneration,
    roomCode: snapshot.roomCode,
  };
  playlistRuntimeLease = lease;
  playlistProjection = new ProRoomPlaylistProjection();
  mediaTransfer = new ProRoomMediaTransfer({ api });
  const manager = new ProRoomPlaylistStateManager({
    code: snapshot.roomCode,
    api,
    mediaTransfer,
    projection: playlistProjection,
    sink: ({ snapshot: accepted, playlist }) => applyProjectedPlaylist(accepted, playlist, lease),
    invalidateCoordinator: ({ previous, next, playlistChanged, playbackChanged }) => {
      if (!isPlaylistLeaseCurrent(lease)) return;
      // The first append atomically publishes both the row and its selection.
      // Only the elected coordinator turns that accepted intent into the
      // existing synchronized load/play path; members merely invalidate it.
      if (isCoordinator() && shouldStartFirstProjectedItem(previous, next)) {
        bus.emit('playlist:play-track', next.currentQueueItemId);
      }
      if (playlistChanged || playbackChanged) sendCoordinatorInvalidation(next);
    },
    reportMediaCleanupError: ({ assetId, error }) => {
      if (isPlaylistLeaseCurrent(lease)) {
        log.warn(`[PRO] Could not clean unused asset ${assetId}`, error);
      }
    },
  });
  playlistManager = manager;
  installLegacyMediaHooks(manager, lease);
  return manager;
}

async function acceptPlaylistSnapshot(snapshot: ProRoomSnapshot): Promise<void> {
  const manager = ensurePlaylistManager(snapshot);
  const lease = playlistRuntimeLease;
  if (!lease) return;
  await manager.acceptSnapshot(snapshot);
  if (!isPlaylistLeaseCurrent(lease)) return;
  invalidationHighWater.acknowledge(snapshot);
  // Coalesce signaling requests that completed out of order before rendering
  // their rows. The accepted snapshot remains the authority fence.
  scheduleAcceptedQueueAdditionFlush();
  if (!hasPendingCoordinatorInvalidation()) {
    invalidationRefreshScheduled = false;
    clearManagedTimer(INVALIDATION_REFRESH_TIMER);
  }
}

function queueAdditionOrder(frame: ProQueueAdditionFrame): number {
  const revision = Number(frame.eventId.split('_').at(-1));
  return Number.isSafeInteger(revision) ? revision : frame.playlistRevision;
}

function rememberSeenQueueAddition(eventId: string): void {
  seenQueueAdditionEventIds.add(eventId);
  while (seenQueueAdditionEventIds.size > 128) {
    const oldest = seenQueueAdditionEventIds.values().next().value as string | undefined;
    if (!oldest) break;
    seenQueueAdditionEventIds.delete(oldest);
  }
}

/**
 * A signaling hint is not authoritative playlist state. Announce it only
 * after the corresponding (or newer) snapshot has been accepted, and sort a
 * concurrently delivered group by server revision before fanout.
 */
function flushAcceptedQueueAdditions(acceptedPlaylistRevision: number): void {
  const ready = [...pendingQueueAdditions.values()]
    .filter((frame) => frame.playlistRevision <= acceptedPlaylistRevision)
    .sort(
      (left, right) =>
        left.playlistRevision - right.playlistRevision ||
        queueAdditionOrder(left) - queueAdditionOrder(right) ||
        left.eventId.localeCompare(right.eventId),
    );
  for (const frame of ready) {
    pendingQueueAdditions.delete(frame.eventId);
    rememberSeenQueueAddition(frame.eventId);
    const order = queueAdditionOrder(frame);
    // Internal invalidation requests may reach signaling out of order. A late
    // older row is more misleading than omitting that stale notification.
    if (order <= lastAnnouncedQueueAdditionOrder) continue;
    lastAnnouncedQueueAdditionOrder = order;
    broadcastTracksAdded(frame.actorName, frame.count);
  }
}

function scheduleAcceptedQueueAdditionFlush(): void {
  clearManagedTimer(QUEUE_ADDITION_FLUSH_TIMER);
  setManagedTimer(
    QUEUE_ADDITION_FLUSH_TIMER,
    () => {
      const acceptedPlaylistRevision = playlistManager?.snapshot?.playlistRevision;
      if (acceptedPlaylistRevision !== undefined) {
        flushAcceptedQueueAdditions(acceptedPlaylistRevision);
      }
    },
    QUEUE_ADDITION_REORDER_WINDOW_MS,
  );
}

function captureLocalPlaybackCheckpoint(): {
  state: 'idle' | 'playing' | 'paused';
  queueItemId: QueueItemId | null;
  positionSeconds: number;
  youtubeVideoId: string | null;
  youtubeSubIndex: number | null;
  updatedAtMs: number;
} {
  const mode = getState('playback.mode');
  const activity = getState('playback.activity');
  const queueItemId = getState('playlist.currentQueueItemId');
  const item = queueItemId
    ? getState('playlist.items').find((candidate) => candidate.queueItemId === queueItemId)
    : null;
  if (!item || !queueItemId || mode === null || mode === 'system-audio' || activity === 'idle') {
    return {
      state: 'idle',
      queueItemId: null,
      positionSeconds: 0,
      youtubeVideoId: null,
      youtubeSubIndex: null,
      updatedAtMs: Date.now(),
    };
  }
  const rawPosition = getTrackPosition();
  const positionSeconds = Number.isFinite(rawPosition) ? Math.max(0, rawPosition) : 0;
  const previous = playlistManager?.snapshot?.playback;
  const previousMatches = previous?.queueItemId === queueItemId ? previous : null;
  const liveYouTubeVideoId =
    mode === 'youtube' ? (getYouTubePlayer()?.getVideoData?.()?.video_id ?? '') : '';
  const rawYouTubeSubIndex = getState('youtube.currentSubIndex');
  const playlistVideoIds =
    item.type === 'youtube' && item.playlistId
      ? getState('youtube.subItemsMap')[item.playlistId]?.ids
      : undefined;
  const liveYouTubeSubIndex = playlistVideoIds?.indexOf(liveYouTubeVideoId) ?? -1;
  const youtubeVideoId =
    item.type === 'youtube'
      ? (/^[A-Za-z0-9_-]{11}$/.test(liveYouTubeVideoId)
          ? liveYouTubeVideoId
          : previousMatches?.youtubeVideoId) || item.videoId
      : null;
  const youtubeSubIndex =
    item.type === 'youtube'
      ? liveYouTubeSubIndex >= 0
        ? liveYouTubeSubIndex
        : Number.isSafeInteger(rawYouTubeSubIndex) && rawYouTubeSubIndex >= 0
          ? rawYouTubeSubIndex
          : (previousMatches?.youtubeSubIndex ?? 0)
      : null;
  return {
    state: activity === 'playing' ? 'playing' : 'paused',
    queueItemId,
    positionSeconds,
    youtubeVideoId,
    youtubeSubIndex,
    updatedAtMs: Date.now(),
  };
}

/** Exact periodic-checkpoint observation seam used by lifecycle regression tests. */
export function captureLocalPlaybackCheckpointForTests(): ReturnType<
  typeof captureLocalPlaybackCheckpoint
> {
  return captureLocalPlaybackCheckpoint();
}

async function persistPlaybackCheckpoint(): Promise<void> {
  const manager = playlistManager;
  const lease = playlistRuntimeLease;
  const operationSignal = playlistRuntimeAbort?.signal;
  if (
    !active ||
    suppressPlaybackCheckpoint ||
    !manager ||
    !lease ||
    !operationSignal ||
    !isCoordinator()
  ) {
    return;
  }
  if (checkpointInFlight) {
    checkpointDirty = true;
    return;
  }
  checkpointInFlight = true;
  try {
    await manager.updatePlayback(captureLocalPlaybackCheckpoint(), {
      signal: operationSignal,
    });
  } catch (error) {
    if (isPlaylistLeaseCurrent(lease) && !operationSignal.aborted) {
      log.warn('[PRO] Playback checkpoint failed', error);
    }
  } finally {
    if (isPlaylistLeaseCurrent(lease)) {
      checkpointInFlight = false;
      if (checkpointDirty) {
        checkpointDirty = false;
        schedulePlaybackCheckpoint();
      }
    }
  }
}

function schedulePlaybackCheckpoint(): void {
  if (!active || suppressPlaybackCheckpoint || !isCoordinator()) return;
  clearManagedTimer(PLAYBACK_CHECKPOINT_DEBOUNCE_TIMER);
  setManagedTimer(
    PLAYBACK_CHECKPOINT_DEBOUNCE_TIMER,
    () => void persistPlaybackCheckpoint(),
    PLAYBACK_CHECKPOINT_DEBOUNCE_MS,
  );
}

function schedulePlaybackCheckpointLoop(): void {
  clearManagedTimer(PLAYBACK_CHECKPOINT_TIMER);
  if (!active) return;
  setManagedTimer(
    PLAYBACK_CHECKPOINT_TIMER,
    () => {
      void persistPlaybackCheckpoint();
      schedulePlaybackCheckpointLoop();
    },
    PLAYBACK_CHECKPOINT_INTERVAL_MS,
  );
}

function enqueueEffectsMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = effectsMutationTail.then(operation, operation);
  effectsMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function effectsRuntimeSnapshot(): ProRoomSnapshot | null {
  return playlistManager?.snapshot ?? controller.snapshot;
}

async function persistRoomEffects(): Promise<void> {
  const lease = playlistRuntimeLease;
  if (!active || suppressEffectsCheckpoint || !lease || !isCoordinator()) return;
  await enqueueEffectsMutation(async () => {
    const snapshot = effectsRuntimeSnapshot();
    if (
      !active ||
      !isPlaylistLeaseCurrent(lease) ||
      !isCoordinator() ||
      snapshot?.roomCode !== lease.roomCode
    ) {
      return;
    }
    const effects = captureRoomEffectsState();
    if (
      acceptedEffects?.roomCode === snapshot.roomCode &&
      roomEffectsEqual(acceptedEffects.effects, effects)
    ) {
      return;
    }
    try {
      const accepted = await api.updateEffects({
        code: snapshot.roomCode,
        coordinatorEpoch: snapshot.presence.coordinatorEpoch,
        effects,
      });
      if (active && isPlaylistLeaseCurrent(lease) && isCoordinator()) {
        acceptedEffects = accepted;
        lastEffectsCoordinatorEpoch = snapshot.presence.coordinatorEpoch;
      }
    } catch (error) {
      if (active && isPlaylistLeaseCurrent(lease)) {
        log.warn('[PRO] Room effects checkpoint failed', error);
      }
    }
  });
}

function scheduleEffectsCheckpoint(): void {
  if (!active || suppressEffectsCheckpoint || !isCoordinator()) return;
  clearManagedTimer(EFFECTS_CHECKPOINT_DEBOUNCE_TIMER);
  setManagedTimer(
    EFFECTS_CHECKPOINT_DEBOUNCE_TIMER,
    () => void persistRoomEffects(),
    EFFECTS_CHECKPOINT_DEBOUNCE_MS,
  );
}

async function refreshPersistedEffectsUnlocked(
  snapshot: ProRoomSnapshot,
  options: { broadcast?: boolean } = {},
): Promise<boolean> {
  const lease = playlistRuntimeLease;
  if (!lease || !isPlaylistLeaseCurrent(lease) || lease.roomCode !== snapshot.roomCode)
    return false;
  const accepted = await api.getEffects(snapshot.roomCode);
  const current = effectsRuntimeSnapshot();
  if (!isPlaylistLeaseCurrent(lease) || current?.roomCode !== snapshot.roomCode) return false;
  if (
    options.broadcast &&
    (!active ||
      !isCoordinator() ||
      current.presence.coordinatorEpoch !== snapshot.presence.coordinatorEpoch)
  ) {
    return false;
  }
  suppressEffectsCheckpoint = true;
  try {
    if (!applyRoomEffectsState(accepted.effects, { broadcast: options.broadcast })) return false;
    acceptedEffects = accepted;
    lastEffectsCoordinatorEpoch = snapshot.presence.coordinatorEpoch;
    return true;
  } finally {
    suppressEffectsCheckpoint = false;
  }
}

async function refreshPersistedEffects(
  snapshot: ProRoomSnapshot,
  options: { broadcast?: boolean } = {},
): Promise<boolean> {
  return enqueueEffectsMutation(() => refreshPersistedEffectsUnlocked(snapshot, options));
}

function queueModeMatchesPlaylist(
  queueMode: ProRoomQueueModeSnapshot,
  snapshot: ProRoomSnapshot,
): boolean {
  if (
    queueMode.roomCode !== snapshot.roomCode ||
    queueMode.playlistRevision !== snapshot.playlistRevision
  ) {
    return false;
  }
  if (!queueMode.shuffleEnabled) return queueMode.shuffleOrder.length === 0;
  if (queueMode.shuffleOrder.length !== snapshot.playlist.length) return false;
  const liveIds = new Set(snapshot.playlist.map((item) => item.queueItemId));
  return (
    queueMode.shuffleOrder.every((queueItemId) => liveIds.delete(queueItemId)) && liveIds.size === 0
  );
}

function enqueueQueueModeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = queueModeMutationTail.then(operation, operation);
  queueModeMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function persistQueueModeCheckpoint(): Promise<void> {
  const manager = playlistManager;
  const lease = playlistRuntimeLease;
  const signal = playlistRuntimeAbort?.signal;
  if (!active || suppressQueueModeCheckpoint || !manager || !lease || !signal || !isCoordinator()) {
    return;
  }
  await enqueueQueueModeMutation(async () => {
    if (
      !active ||
      suppressQueueModeCheckpoint ||
      !isPlaylistLeaseCurrent(lease) ||
      signal.aborted ||
      !isCoordinator()
    ) {
      return;
    }
    const snapshot = manager.snapshot;
    if (!snapshot) return;
    const pendingLocal = capturePlaylistQueueModeState();
    const previousAccepted = acceptedQueueMode;
    if (
      !acceptedQueueMode ||
      acceptedQueueMode.roomCode !== snapshot.roomCode ||
      !queueModeMatchesPlaylist(acceptedQueueMode, snapshot)
    ) {
      await refreshPersistedQueueModeUnlocked(snapshot, { broadcast: isCoordinator() });
      const canonical = acceptedQueueMode;
      const canonicalSemanticUnchanged =
        previousAccepted !== null &&
        canonical !== null &&
        canonical.repeatMode === previousAccepted.repeatMode &&
        canonical.shuffleEnabled === previousAccepted.shuffleEnabled;
      const localSemanticChanged =
        previousAccepted !== null &&
        (pendingLocal.repeatMode !== previousAccepted.repeatMode ||
          pendingLocal.shuffleEnabled !== previousAccepted.shuffleEnabled);
      if (canonicalSemanticUnchanged && localSemanticChanged && canonical) {
        suppressQueueModeCheckpoint = true;
        try {
          applyPlaylistQueueModeState(
            {
              repeatMode: pendingLocal.repeatMode,
              shuffleEnabled: pendingLocal.shuffleEnabled,
              shuffleOrder:
                pendingLocal.shuffleEnabled && canonical.shuffleEnabled
                  ? canonical.shuffleOrder
                  : pendingLocal.shuffleOrder,
            },
            false,
          );
        } finally {
          suppressQueueModeCheckpoint = false;
        }
      }
    }
    const baseRevision = acceptedQueueMode?.revision;
    if (baseRevision === undefined) return;
    const local = capturePlaylistQueueModeState();
    let accepted: ProRoomQueueModeSnapshot;
    try {
      accepted = await api.updateQueueMode(
        {
          code: snapshot.roomCode,
          coordinatorEpoch: snapshot.presence.coordinatorEpoch,
          baseRevision,
          playlistRevision: snapshot.playlistRevision,
          repeatMode: local.repeatMode,
          shuffleEnabled: local.shuffleEnabled,
          shuffleOrder: local.shuffleOrder,
        },
        signal,
      );
    } catch (error) {
      if (
        error instanceof ProRoomApiError &&
        (error.code === 'QUEUE_MODE_REVISION_CONFLICT' ||
          error.code === 'PLAYLIST_REVISION_CONFLICT')
      ) {
        await refreshPersistedQueueModeUnlocked(snapshot, { broadcast: isCoordinator() });
        queueModeCheckpointDirty = false;
        queueModeCheckpointRetryAttempt = 0;
        return;
      }
      if (
        queueModeCheckpointDirty &&
        queueModeCheckpointRetryAttempt < QUEUE_MODE_CHECKPOINT_RETRY_DELAYS_MS.length
      ) {
        const delay = QUEUE_MODE_CHECKPOINT_RETRY_DELAYS_MS[queueModeCheckpointRetryAttempt];
        queueModeCheckpointRetryAttempt += 1;
        setManagedTimer(
          QUEUE_MODE_CHECKPOINT_DEBOUNCE_TIMER,
          () =>
            void persistQueueModeCheckpoint().catch((retryError) => {
              log.warn('[PRO] Queue mode checkpoint retry failed', retryError);
            }),
          delay,
        );
      }
      throw error;
    }
    if (!isPlaylistLeaseCurrent(lease) || signal.aborted) return;
    acceptedQueueMode = accepted;
    lastQueueModeCoordinatorEpoch = snapshot.presence.coordinatorEpoch;
    queueModeCheckpointDirty = false;
    queueModeCheckpointRetryAttempt = 0;
  });
}

function scheduleQueueModeCheckpoint(): void {
  if (!active || suppressQueueModeCheckpoint || !isCoordinator()) return;
  queueModeCheckpointDirty = true;
  queueModeCheckpointRetryAttempt = 0;
  clearManagedTimer(QUEUE_MODE_CHECKPOINT_DEBOUNCE_TIMER);
  setManagedTimer(
    QUEUE_MODE_CHECKPOINT_DEBOUNCE_TIMER,
    () => {
      void persistQueueModeCheckpoint().catch((error) => {
        log.warn('[PRO] Queue mode checkpoint failed', error);
      });
    },
    QUEUE_MODE_CHECKPOINT_DEBOUNCE_MS,
  );
}

async function refreshPersistedQueueModeUnlocked(
  snapshot: ProRoomSnapshot,
  options: { broadcast?: boolean } = {},
): Promise<boolean> {
  const lease = playlistRuntimeLease;
  if (!lease || lease.roomCode !== snapshot.roomCode || !isPlaylistLeaseCurrent(lease))
    return false;
  const accepted = await api.getQueueMode(snapshot.roomCode, playlistRuntimeAbort?.signal);
  const currentSnapshot = playlistManager?.snapshot;
  if (
    !isPlaylistLeaseCurrent(lease) ||
    !currentSnapshot ||
    currentSnapshot.roomCode !== snapshot.roomCode ||
    !queueModeMatchesPlaylist(accepted, currentSnapshot)
  ) {
    return false;
  }
  const changed = acceptedQueueMode?.revision !== accepted.revision;
  suppressQueueModeCheckpoint = true;
  try {
    if (
      !applyPlaylistQueueModeState(
        {
          repeatMode: accepted.repeatMode,
          shuffleEnabled: accepted.shuffleEnabled,
          shuffleOrder: accepted.shuffleOrder,
        },
        false,
      )
    ) {
      return false;
    }
    acceptedQueueMode = accepted;
    lastQueueModeCoordinatorEpoch = currentSnapshot.presence.coordinatorEpoch;
    if (changed && options.broadcast && isCoordinator()) {
      broadcast({ type: MSG.REPEAT_MODE, value: accepted.repeatMode });
      broadcast({ type: MSG.SHUFFLE_MODE, value: accepted.shuffleEnabled });
    }
    return true;
  } finally {
    suppressQueueModeCheckpoint = false;
  }
}

async function refreshPersistedQueueMode(
  snapshot: ProRoomSnapshot,
  options: { broadcast?: boolean } = {},
): Promise<boolean> {
  return enqueueQueueModeMutation(() => refreshPersistedQueueModeUnlocked(snapshot, options));
}

function showPlaybackRestoreHint(): void {
  if (!pendingPlaybackRestore || !suppressPlaybackCheckpoint) return;
  bus.emit('ui:show-toast', t('pro.resume_tap'));
}

function finishPlaybackRestore(): void {
  if (!pendingPlaybackRestore && !suppressPlaybackCheckpoint) return;
  pendingPlaybackRestore = null;
  suppressPlaybackCheckpoint = false;
  clearManagedTimer(PLAYBACK_RESTORE_TIMEOUT_TIMER);
  schedulePlaybackCheckpoint();
}

function cancelPlaybackRestoreForQueueOverride(): boolean {
  const pending = pendingPlaybackRestore;
  if (!pending) return false;
  const selectedQueueItemId = getState('playlist.currentQueueItemId');
  const targetExists = getState('playlist.items').some(
    (item) => item.queueItemId === pending.queueItemId,
  );
  if (selectedQueueItemId === pending.queueItemId && targetExists) return false;

  // A deliberate queue selection/removal supersedes the sleeping-room
  // checkpoint. Only this explicit override (or a successful restore) may
  // release suppression; a timeout/decoder failure must preserve server state.
  finishPlaybackRestore();
  return true;
}

function reconcilePlaybackRestore(): void {
  const pending = pendingPlaybackRestore;
  if (!pending) return;
  const activity = getState('playback.activity');
  if (
    getState('playlist.currentQueueItemId') === pending.queueItemId &&
    activity === pending.state
  ) {
    finishPlaybackRestore();
  }
}

async function restorePersistedPlayback(snapshot: ProRoomSnapshot): Promise<void> {
  const lease = playlistRuntimeLease;
  if (!lease || lease.roomCode !== snapshot.roomCode || !isPlaylistLeaseCurrent(lease)) return;
  if (!isCoordinator() || snapshot.playback.state === 'idle' || !snapshot.playback.queueItemId) {
    return;
  }
  const item = getState('playlist.items').find(
    (candidate) => candidate.queueItemId === snapshot.playback.queueItemId,
  );
  if (!item) return;
  // A checkpoint revision changes during ordinary 10-second persistence. A
  // restore belongs to one coordinator tenure, not to every checkpoint write.
  const restoreKey = `${snapshot.roomCode}:${snapshot.presence.coordinatorEpoch}`;
  if (restoreKey === lastPlaybackRestoreKey) return;
  lastPlaybackRestoreKey = restoreKey;

  const elapsedSeconds =
    snapshot.playback.state === 'playing' && snapshot.playback.updatedAtMs > 0
      ? Math.max(0, (Date.now() - snapshot.playback.updatedAtMs) / 1000)
      : 0;
  const positionSeconds = Math.max(0, snapshot.playback.positionSeconds + elapsedSeconds);
  pendingPlaybackRestore = {
    queueItemId: snapshot.playback.queueItemId,
    state: snapshot.playback.state,
  };
  suppressPlaybackCheckpoint = true;
  clearManagedTimer(PLAYBACK_RESTORE_TIMEOUT_TIMER);
  setManagedTimer(
    PLAYBACK_RESTORE_TIMEOUT_TIMER,
    () => showPlaybackRestoreHint(),
    PLAYBACK_RESTORE_TIMEOUT_MS,
  );

  if (item.type === 'youtube') {
    bus.emit('youtube:restore-room-playback', {
      videoId: snapshot.playback.youtubeVideoId,
      playlistId: item.playlistId,
      name: item.name,
      queueItemId: item.queueItemId,
      autoplay: snapshot.playback.state === 'playing',
      subIndex: snapshot.playback.youtubeSubIndex ?? 0,
      positionSeconds,
    });
    return;
  }

  let restored: boolean;
  try {
    restored = await restoreProRoomLegacyPlayback({
      queueItemId: item.queueItemId,
      positionSeconds,
      state: snapshot.playback.state,
    });
  } catch (error) {
    if (!isPlaylistLeaseCurrent(lease)) return;
    throw error;
  }
  if (!isPlaylistLeaseCurrent(lease)) return;
  if (!restored) showPlaybackRestoreHint();
  else reconcilePlaybackRestore();
}

function applyAuthority(context: RoomContext): void {
  const pending = pendingFileDownload;
  if (pending && !shouldRetainPendingProDownload(pending.roomCode, context)) {
    pending.controller.abort();
  }
  const preload = pendingPreloadDownload;
  if (preload && !shouldRetainPendingProDownload(preload.roomCode, context)) {
    preload.controller.abort();
  }
  setRoomContext(context);
  batchSetState({
    'network.sessionCode': context.roomId ?? '',
    'network.lastJoinCode': context.roomId ?? '',
    // Compatibility flag for legacy controls. Real authorization remains the
    // server-projected capability set in room.context.
    'network.isOperator': context.role === 'member',
  });
}

function stopLifecycle(): void {
  active = false;
  developerControl.reset();
  heartbeatSingleFlight.reset();
  refreshInFlight = false;
  topologyRecoveryAttempt = 0;
  clearManagedTimer(HEARTBEAT_TIMER);
  clearManagedTimer(SIGNALING_REFRESH_TIMER);
  clearManagedTimer(PLAYBACK_CHECKPOINT_TIMER);
  clearManagedTimer(PLAYBACK_CHECKPOINT_DEBOUNCE_TIMER);
  clearManagedTimer(QUEUE_MODE_CHECKPOINT_DEBOUNCE_TIMER);
  clearManagedTimer(PLAYBACK_RESTORE_TIMEOUT_TIMER);
  clearManagedTimer(INVALIDATION_REFRESH_TIMER);
  invalidationRefreshScheduled = false;
}

const observer: ProRoomSessionObserver = {
  snapshot(snapshot) {
    // Runtime entry points accept playlist state transactionally. The observer
    // only enforces topology authority, avoiding a duplicate async projection
    // of the same snapshot racing that explicit accept.
    bindProSystemAudioSession(snapshot);
    reconcileAuthoritativePeers(snapshot);
  },
  authority(context) {
    applyAuthority(context);
  },
  cleared() {
    stopLifecycle();
    resetProSystemAudioService();
    resetPlaylistRuntime();
    resetProRoomTransportRecovery();
    resetRoomContext();
  },
};

const controller = new ProRoomSessionController(api, bridge, observer);

function isDeveloperControlBusy(): boolean {
  return (
    pendingFileDownload !== null ||
    isFilePipelineBusyForPlay() ||
    isPlayLocked() ||
    isYtLoadInProgress() ||
    getState('player.isSeeking')
  );
}

function cancelPendingDeveloperFileTransitions(): void {
  // Mirror the coordinator's ordinary play/pause controls without surfacing
  // their user-initiated "auto play canceled" toast. Otherwise a file that
  // is waiting in the standard 3-second start window can overwrite an API
  // pause, or replay from zero shortly after an API play/seek succeeded.
  clearManagedTimer('autoPlayTimer');
  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');
}

/** Exact timer-cancellation seam for the developer-control regression test. */
export function cancelPendingDeveloperFileTransitionsForTests(): void {
  cancelPendingDeveloperFileTransitions();
}

type DeveloperPlayItemStarter = (queueItemId: QueueItemId) => Promise<void>;

function beginDeveloperPlayItemIntent(
  queueItemId: QueueItemId,
  starter: DeveloperPlayItemStarter = playTrack,
): boolean {
  // playTrack synchronously commits the queue selection before its first
  // await. That selection is the bounded API contract; R2 download/decode may
  // legitimately continue for minutes and must not keep a short-lived command
  // open past its epoch/TTL. The existing player pipeline owns all later UX,
  // retry, and failure transitions.
  const completion = starter(queueItemId);
  void completion.catch((error) => {
    log.warn('[PRO] Developer play-item background pipeline failed', error);
  });
  return getState('playlist.currentQueueItemId') === queueItemId;
}

/** Exact synchronous-intent seam for long-running play-item regression tests. */
export function beginDeveloperPlayItemIntentForTests(
  queueItemId: QueueItemId,
  starter: DeveloperPlayItemStarter,
): boolean {
  return beginDeveloperPlayItemIntent(queueItemId, starter);
}

async function executeDeveloperCommand(
  command: DeveloperCommandFrame['command'],
  snapshot: ProRoomSnapshot,
): Promise<Exclude<DeveloperCommandResultCode, 'already_applied' | 'expired'>> {
  if (command.type === 'set_effects') {
    const lease = playlistRuntimeLease;
    if (!lease || lease.roomCode !== snapshot.roomCode) return 'execution_failed';
    const current = effectsRuntimeSnapshot();
    return !active ||
      !isPlaylistLeaseCurrent(lease) ||
      !isCoordinator() ||
      current?.roomCode !== snapshot.roomCode ||
      current.presence.coordinatorEpoch !== snapshot.presence.coordinatorEpoch
      ? 'execution_failed'
      : 'applied';
  }

  if (isDeveloperControlBusy()) return 'busy';

  if (command.type === 'play_item') {
    const localItem = getState('playlist.items').find(
      (item) => item.queueItemId === command.queueItemId,
    );
    if (!localItem) return 'stale_queue';
    return beginDeveloperPlayItemIntent(command.queueItemId) ? 'applied' : 'execution_failed';
  }

  const queueItemId = snapshot.currentQueueItemId;
  if (!queueItemId || getState('playlist.currentQueueItemId') !== queueItemId) {
    return queueItemId ? 'stale_queue' : 'no_media';
  }
  const item = snapshot.playlist.find((candidate) => candidate.queueItemId === queueItemId);
  if (!item) return 'stale_queue';

  const playback = getPlaybackModeActivity();
  if (playback.mode === 'system-audio') return 'unsupported_mode';

  if (command.type === 'next') {
    // Keep Developer API traversal identical to the visible Next control:
    // YouTube aggregates advance their internal sub-index first, then the
    // shared queue/repeat/shuffle path chooses the next top-level item.
    playNextTrack();
    return 'applied';
  }

  if (item.source.kind === 'youtube') {
    const player = getYouTubePlayer();
    if (!player || playback.mode !== 'youtube') return 'no_media';
    const playerState = player.getPlayerState();
    const currentTime = Math.max(0, Number(player.getCurrentTime()) || 0);

    if (command.type === 'play') {
      if (playerState === 1 && playback.activity === 'playing') return 'applied';
      bus.emit('youtube:auto-play', {
        targetTime: currentTime,
        skipSeek: true,
        state: 1,
      });
      return 'applied';
    }
    if (command.type === 'pause') {
      if (playerState === 2 && playback.activity === 'paused') return 'applied';
      bus.emit('youtube:auto-play', {
        targetTime: currentTime,
        skipSeek: true,
        state: 2,
      });
      return 'applied';
    }
    seekTo(command.positionSeconds);
    return 'applied';
  }

  if (playback.mode !== 'file') return 'no_media';
  const resident = getState('files.current');
  if (!getCurrentAudioBuffer() || resident?.queueItemId !== queueItemId) return 'no_media';
  cancelPendingDeveloperFileTransitions();

  if (command.type === 'play') {
    if (playback.activity === 'playing') return 'applied';
    if (playback.activity !== 'paused') return 'no_media';
    const position = Math.max(0, Number(getState('player.pausedAt')) || 0);
    await play(position);
    if (
      getState('playlist.currentQueueItemId') !== queueItemId ||
      getPlaybackModeActivity().activity !== 'playing'
    ) {
      return 'execution_failed';
    }
    broadcast({
      type: MSG.PLAY,
      time: position,
      queueItemId,
      hostPlayAt: getHostNow() + DEVELOPER_FILE_PLAY_SCHEDULE_AHEAD_MS,
    });
    return 'applied';
  }

  if (command.type === 'pause') {
    if (playback.activity === 'paused') return 'applied';
    if (playback.activity !== 'playing') return 'no_media';
    const position = getTrackPosition();
    pause(position, { showToast: false });
    broadcast({
      type: MSG.PAUSE,
      time: position,
      queueItemId,
      reason: 'pause',
    });
    return 'applied';
  }

  seekTo(command.positionSeconds);
  return 'applied';
}

async function refreshDeveloperControlSnapshot(): Promise<ProRoomSnapshot | null> {
  const lease = playlistRuntimeLease;
  if (!active || !lease || !isCoordinator()) return null;
  const incoming = await controller.refresh();
  if (!active || !isPlaylistLeaseCurrent(lease) || !isCoordinator()) return null;
  await acceptPlaylistSnapshot(incoming);
  if (!active || !isPlaylistLeaseCurrent(lease) || !isCoordinator()) return null;
  return playlistManager?.snapshot ?? incoming;
}

const developerControl = new DeveloperControlExecutor({
  now: () => Date.now(),
  isActive: () => active,
  isCoordinator,
  snapshot: () => playlistManager?.snapshot ?? controller.snapshot,
  refreshSnapshot: refreshDeveloperControlSnapshot,
  execute: executeDeveloperCommand,
  acknowledge: async (frame, resultCode) => {
    const committedEffects =
      frame.command.type === 'set_effects' &&
      (resultCode === 'applied' || resultCode === 'already_applied');
    if (!committedEffects) {
      await api.ackDeveloperCommand({
        code: frame.roomCode,
        commandId: frame.commandId,
        resultCode,
      });
      return;
    }

    const pending = {
      commandId: frame.commandId,
      coordinatorEpoch: frame.coordinatorEpoch,
    };
    pendingEffectsBroadcast = pending;
    await enqueueEffectsMutation(async () => {
      await api.ackDeveloperCommand({
        code: frame.roomCode,
        commandId: frame.commandId,
        resultCode,
      });
      const snapshot = effectsRuntimeSnapshot();
      if (
        snapshot?.roomCode === frame.roomCode &&
        snapshot.presence.coordinatorEpoch === frame.coordinatorEpoch
      ) {
        try {
          if (
            (await refreshPersistedEffectsUnlocked(snapshot, { broadcast: true })) &&
            pendingEffectsBroadcast?.commandId === pending.commandId
          ) {
            pendingEffectsBroadcast = null;
          }
        } catch (error) {
          // The ACK may already be durable even when its response or the
          // follow-up read is lost. Heartbeat retries the canonical broadcast.
          log.warn('[PRO] Applied Developer API effects refresh failed', error);
        }
      }
    });
  },
});

onProRoomTabTakeover((roomCode) => {
  if (!active || controller.snapshot?.roomCode !== roomCode) return;
  void recoverTerminalSession(new ProRoomApiError('PRESENCE_SUPERSEDED', 409));
});

function isTerminalSessionError(error: unknown): error is ProRoomApiError {
  return (
    error instanceof ProRoomApiError &&
    (error.status === 401 ||
      error.code === 'SESSION_REQUIRED' ||
      error.code === 'PRESENCE_SUPERSEDED' ||
      error.status === 423 ||
      error.code === 'ROOM_SUSPENDED')
  );
}

async function recoverTerminalSession(error: ProRoomApiError): Promise<void> {
  if (terminalRecoveryInFlight) return;
  terminalRecoveryInFlight = true;
  stopLifecycle();
  log.warn(`[PRO] Session is no longer valid (${error.code}); re-authentication required`);
  try {
    await controller.terminate();
  } catch (disconnectError) {
    log.warn('[PRO] Terminal session transport cleanup failed', disconnectError);
  }
  // Another tab with the same HttpOnly cookie explicitly took ownership.
  // Leave this document inert and navigate home; reloading the room URL would
  // immediately challenge the new tab and recreate the takeover loop.
  if (error.code === 'PRESENCE_SUPERSEDED') {
    if (typeof window !== 'undefined') {
      scheduleSessionReset(t('pro.active_tab_title'), () => window.location.replace('/'));
    }
    return;
  }
  if (typeof window !== 'undefined') {
    scheduleSessionReset(t('dialog.refreshing_session'), () => window.location.reload());
  }
}

async function runHeartbeat(forceFollowUp = false, propagateFailure = false): Promise<void> {
  const lease = playlistRuntimeLease;
  if (!active || !lease) return;
  try {
    await heartbeatSingleFlight.run(
      async () => {
        const invalidationGeneration = invalidationHighWater.beginHeartbeat();
        const snapshot = await controller.heartbeat();
        await acceptPlaylistSnapshot(snapshot);
        if (snapshot.presence.coordinatorEpoch !== lastEffectsCoordinatorEpoch) {
          await refreshPersistedEffects(snapshot).catch((error) => {
            // Effects are a dedicated rolling-deploy resource. A transient
            // read failure must not tear down presence or media playback.
            log.warn('[PRO] Room effects refresh failed', error);
          });
        }
        if (
          isCoordinator() ||
          snapshot.presence.coordinatorEpoch !== lastQueueModeCoordinatorEpoch
        ) {
          await refreshPersistedQueueMode(snapshot, { broadcast: isCoordinator() }).catch(
            (error) => {
              // The dedicated resource is deliberately optional during a
              // rolling Worker/app deployment. A later heartbeat retries it.
              log.warn('[PRO] Queue mode refresh failed', error);
            },
          );
        }
        if (
          pendingEffectsBroadcast !== null &&
          pendingEffectsBroadcast.coordinatorEpoch !== snapshot.presence.coordinatorEpoch
        ) {
          // A new coordinator causes every participant to refresh canonical
          // effects above, so an old coordinator's pending broadcast is stale.
          pendingEffectsBroadcast = null;
        } else if (pendingEffectsBroadcast !== null && isCoordinator()) {
          const pending = pendingEffectsBroadcast;
          try {
            if (
              (await refreshPersistedEffects(snapshot, { broadcast: true })) &&
              pendingEffectsBroadcast?.commandId === pending.commandId
            ) {
              pendingEffectsBroadcast = null;
            }
          } catch (error) {
            log.warn('[PRO] Pending Developer API effects broadcast failed', error);
          }
        }
        if (isCoordinator()) {
          await refreshProSystemAudioState().catch((error) => {
            // The media lease is intentionally independent from presence.
            // A transient state refresh must not tear down a healthy room.
            log.warn('[PRO] System-audio state refresh failed', error);
          });
        }
        invalidationHighWater.finishHeartbeat(snapshot, invalidationGeneration);
        if (!invalidationHighWater.pending) {
          invalidationRefreshScheduled = false;
          clearManagedTimer(INVALIDATION_REFRESH_TIMER);
        }
        void restorePersistedPlayback(snapshot).catch((error) => {
          log.warn('[PRO] Coordinator playback restore failed', error);
          showPlaybackRestoreHint();
        });
      },
      { forceFollowUp },
    );
  } catch (error) {
    if (isTerminalSessionError(error)) {
      await recoverTerminalSession(error);
    } else {
      // Presence is eventually reconciled by the DO TTL. A transient heartbeat
      // failure must not tear down healthy P2P media during the ordinary loop.
      log.warn('[PRO] Presence heartbeat failed', error);
    }
    if (propagateFailure) throw error;
  } finally {
    if (isPlaylistLeaseCurrent(lease) && active) {
      setManagedTimer(HEARTBEAT_TIMER, () => void runHeartbeat(), HEARTBEAT_INTERVAL_MS);
    }
  }
}

async function runTopologyRecovery(): Promise<void> {
  const lease = playlistRuntimeLease;
  if (!active || !lease) return;
  clearManagedTimer(HEARTBEAT_TIMER);
  try {
    await runHeartbeat(true, true);
    topologyRecoveryAttempt = 0;
  } catch {
    if (!active || !isPlaylistLeaseCurrent(lease)) return;
    const delay =
      TOPOLOGY_RECOVERY_RETRY_MS[
        Math.min(topologyRecoveryAttempt, TOPOLOGY_RECOVERY_RETRY_MS.length - 1)
      ] ?? HEARTBEAT_INTERVAL_MS;
    topologyRecoveryAttempt += 1;
    // A member can reach signaling just before the newly elected coordinator
    // has attached. Every ticket is one-use, so retry through heartbeat to
    // mint a fresh ticket; keep doing so through the 45s presence TTL for an
    // abruptly vanished coordinator.
    setManagedTimer(HEARTBEAT_TIMER, () => void runTopologyRecovery(), delay);
  }
}

function beginTopologyRecovery(): Promise<void> {
  topologyRecoveryAttempt = 0;
  clearManagedTimer(HEARTBEAT_TIMER);
  // The data topology is known dead even when authority has not changed yet.
  // Force the next accepted heartbeat to rebuild the transport for the same
  // coordinator as well as for a newly elected one.
  controller.invalidateTransportAuthority();
  return runTopologyRecovery();
}

async function refreshSignalingCredential(): Promise<boolean> {
  const lease = playlistRuntimeLease;
  if (!active || refreshInFlight || !lease) return false;
  refreshInFlight = true;
  try {
    await controller.refreshSignaling();
    return true;
  } catch (error) {
    if (isTerminalSessionError(error)) {
      await recoverTerminalSession(error);
      return false;
    }
    // Existing data channels remain valid without signaling. Retry soon so a
    // later coordinator failover or new member can still connect.
    log.warn('[PRO] Signaling credential refresh failed', error);
    return false;
  } finally {
    if (isPlaylistLeaseCurrent(lease)) {
      refreshInFlight = false;
      if (active) {
        setManagedTimer(
          SIGNALING_REFRESH_TIMER,
          () => void refreshSignalingCredential(),
          SIGNALING_REFRESH_INTERVAL_MS,
        );
      }
    }
  }
}

function bindVisibilityRefresh(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (!active || document.visibilityState !== 'visible') return;
    clearManagedTimer(HEARTBEAT_TIMER);
    clearManagedTimer(SIGNALING_REFRESH_TIMER);
    void runHeartbeat();
    void refreshSignalingCredential();
  });
}

function startLifecycle(): void {
  developerControl.reset();
  active = true;
  terminalRecoveryInFlight = false;
  bindVisibilityRefresh();
  clearManagedTimer(HEARTBEAT_TIMER);
  clearManagedTimer(SIGNALING_REFRESH_TIMER);
  setManagedTimer(HEARTBEAT_TIMER, () => void runHeartbeat(), HEARTBEAT_INTERVAL_MS);
  setManagedTimer(
    SIGNALING_REFRESH_TIMER,
    () => void refreshSignalingCredential(),
    SIGNALING_REFRESH_INTERVAL_MS,
  );
  schedulePlaybackCheckpointLoop();
}

export function getProRoomBootstrap(code: string, signal?: AbortSignal): Promise<ProRoomBootstrap> {
  return api.getBootstrap(code, signal);
}

async function finalizeOpenedRoom(snapshot: ProRoomSnapshot): Promise<ProRoomSnapshot> {
  try {
    await acceptPlaylistSnapshot(snapshot);
    await refreshPersistedEffects(snapshot).catch((error) => {
      // Keep room entry compatible during a staggered Worker/app rollout.
      // The next heartbeat retries the authoritative effects read.
      log.warn('[PRO] Initial room effects refresh failed', error);
    });
    await refreshPersistedQueueMode(snapshot).catch((error) => {
      // Keep entry compatible while the Worker endpoint rolls out. The first
      // heartbeat retries without discarding playlist/playback restoration.
      log.warn('[PRO] Initial queue mode refresh failed', error);
    });
  } catch (error) {
    await controller.leave().catch(() => undefined);
    throw error;
  }
  startLifecycle();
  void refreshProSystemAudioState().catch((error) => {
    log.warn('[PRO] Initial system-audio state refresh failed', error);
  });
  void restorePersistedPlayback(snapshot).catch((error) => {
    log.warn('[PRO] Persistent playback restore failed', error);
    showPlaybackRestoreHint();
  });
  return snapshot;
}

export async function resumeProRoom(
  code: string,
  options: EnterProRoomPresenceOptions = {},
): Promise<ProRoomSnapshot> {
  const snapshot = await controller.resume(code, options);
  return finalizeOpenedRoom(snapshot);
}

export async function joinProRoom(
  input: CreateProRoomSessionInput,
  signal?: AbortSignal,
): Promise<ProRoomSnapshot> {
  const snapshot = await controller.join(input, signal);
  return finalizeOpenedRoom(snapshot);
}

export async function activateProRoom(
  input: ActivateProRoomInput,
  signal?: AbortSignal,
): Promise<ProRoomSnapshot> {
  const snapshot = await controller.activate(input, signal);
  return finalizeOpenedRoom(snapshot);
}

export async function recoverProRoomOwner(
  input: RecoverProRoomOwnerInput,
  signal?: AbortSignal,
): Promise<ProRoomSnapshot> {
  const snapshot = await controller.recoverOwner(input, signal);
  return finalizeOpenedRoom(snapshot);
}

export async function changeActiveProRoomPin(pin: string, signal?: AbortSignal): Promise<void> {
  const code = controller.snapshot?.roomCode;
  if (!code) throw new Error('PRO_ROOM_SESSION_INACTIVE');
  const lease = controller.captureSessionLease();
  let pinMutationCompleted = false;
  try {
    // PIN rotation revokes every other cookie session. Pull the resulting
    // presence snapshot through the authority-aware heartbeat path. Do not
    // report success until a new-epoch coordinator ticket has rebuilt
    // signaling and closed every revoked old-epoch peer.
    const completed = await completeProRoomPinRotation({
      changePin: async () => {
        await api.changePin(code, pin, signal);
        pinMutationCompleted = true;
      },
      isSessionCurrent: () => controller.isSessionLeaseCurrent(lease, code),
      // Join the same single-flight used by timers/epoch-close events. The
      // forced pass guarantees one authoritative post-PIN read even if an
      // old-epoch heartbeat was already in progress, and strict propagation
      // prevents a failed transport rebuild from looking successful.
      heartbeat: () => runHeartbeat(true, true),
    });
    if (!completed || !controller.isSessionLeaseCurrent(lease, code)) return;
  } catch (error) {
    const leaseCurrent = controller.isSessionLeaseCurrent(lease, code);
    // A failed transport rebuild clears the controller lease itself. Once the
    // server has accepted the new PIN, that must still reject this operation
    // rather than being mistaken for a harmless stale-tab completion.
    if (!leaseCurrent && !pinMutationCompleted) return;
    if (leaseCurrent && isTerminalSessionError(error)) await recoverTerminalSession(error);
    throw error;
  }
}

function leaveActiveProRoom(signal?: AbortSignal): Promise<void> {
  // `leave()` also supersedes an authentication/transport open that has not
  // published a snapshot yet. Skipping it when snapshot is null can let a
  // cancelled setup request finish later and silently re-enter the room.
  // Start one atomic final-checkpoint + presence-close fetch with the old
  // room's cookie before invalidating local authority. This avoids a later
  // async leave request accidentally authenticating with a newly-created
  // same-room cookie.
  const snapshot = playlistManager?.snapshot ?? controller.snapshot;
  // Release a locally-owned media lease promptly. Presence removal is the
  // authoritative fallback when this best-effort request races navigation.
  void releaseLocalProSystemAudioLease().catch(() => undefined);
  const atomicPresenceClose = active && snapshot ? startAtomicPresenceClose(snapshot) : null;
  const presenceClose = atomicPresenceClose
    ? waitForProRoomPresenceClose(atomicPresenceClose, EXPLICIT_LEAVE_CLOSE_TIMEOUT_MS)
    : null;
  stopLifecycle();
  return controller.leave(signal, presenceClose ?? undefined);
}

function startAtomicPresenceClose(snapshot: ProRoomSnapshot): Promise<void> | null {
  const viewer = snapshot.viewer;
  if (!viewer) {
    log.warn('[PRO] Refused atomic presence close without an authenticated participant');
    return null;
  }
  let idempotencyKey: string;
  try {
    idempotencyKey = createProRoomIdempotencyKey();
  } catch (error) {
    log.warn('[PRO] Could not create atomic presence close key', error);
    return null;
  }

  const checkpoint =
    !suppressPlaybackCheckpoint && playlistManager
      ? buildProRoomUnloadCheckpoint(snapshot, captureLocalPlaybackCheckpoint())
      : { currentQueueItemId: null, playback: null };
  return api.closePresenceOnUnload({
    code: snapshot.roomCode,
    expectedParticipantId: viewer.participantId,
    expectedPresenceIncarnationId: viewer.presenceIncarnationId,
    baseRevision: snapshot.revision,
    currentQueueItemId: checkpoint.currentQueueItemId,
    playback: checkpoint.playback,
    idempotencyKey,
  });
}

/**
 * Start the one unload-safe server mutation before the app-wide pagehide
 * teardown destroys player/network state. Returning true tells the lifecycle
 * hook not to race this request with the ordinary async leave sequence.
 */
function hardCloseActiveProRoom(): boolean {
  const snapshot = playlistManager?.snapshot ?? controller.snapshot;
  if (!active || !snapshot) return false;
  // Calling the async API method synchronously reaches fetch() before it
  // yields. Only after the keepalive request has started may local teardown
  // abort managers, timers, and the WebRTC facade.
  const closeRequest = startAtomicPresenceClose(snapshot);
  if (!closeRequest) return false;
  stopLifecycle();
  void controller.closeForUnload().catch((error) => {
    log.warn('[PRO] Unload transport cleanup failed', error);
  });
  void closeRequest.catch((error) => {
    // Nothing else can be made more reliable during unload; the DO presence
    // TTL remains the final fallback if the browser drops even keepalive.
    log.warn('[PRO] Atomic unload close failed', error);
  });
  return true;
}

for (const event of [
  'state:playback.mode',
  'state:playback.activity',
  'state:playlist.currentQueueItemId',
  'state:playlist.items',
  'state:player.startedAt',
  'state:player.pausedAt',
] as const) {
  bus.on(event, () => {
    if (event === 'state:playlist.currentQueueItemId') {
      cancelSupersededFileDownload(getState('playlist.currentQueueItemId'));
      pruneNonCurrentProRoomFileRows();
    }
    if (cancelPlaybackRestoreForQueueOverride()) return;
    reconcilePlaybackRestore();
    schedulePlaybackCheckpoint();
  });
}

for (const event of ['state:playlist.repeatMode', 'state:playlist.isShuffle'] as const) {
  bus.on(event, () => scheduleQueueModeCheckpoint());
}
bus.on('playlist:shuffle-order-changed', () => scheduleQueueModeCheckpoint());

for (const event of [
  'state:audio.reverbMix',
  'state:audio.reverbDecay',
  'state:audio.reverbPreDelay',
  'state:audio.reverbLowCut',
  'state:audio.reverbHighCut',
  'state:audio.eqValues',
  'state:audio.stereoWidth',
  'state:audio.virtualBass',
] as const) {
  bus.on(event, () => scheduleEffectsCheckpoint());
}

function hasPendingCoordinatorInvalidation(): boolean {
  return invalidationHighWater.pending;
}

function scheduleCoordinatorInvalidationRefresh(): void {
  if (
    !active ||
    !isCoordinator() ||
    !hasPendingCoordinatorInvalidation() ||
    coordinatorRefresh ||
    invalidationRefreshScheduled
  ) {
    return;
  }

  const delay = Math.max(
    0,
    INVALIDATION_REFRESH_MIN_INTERVAL_MS - (Date.now() - lastInvalidationRefreshAt),
  );
  if (delay > 0) {
    invalidationRefreshScheduled = true;
    setManagedTimer(
      INVALIDATION_REFRESH_TIMER,
      () => {
        invalidationRefreshScheduled = false;
        void runCoordinatorInvalidationRefresh();
      },
      delay,
    );
    return;
  }
  void runCoordinatorInvalidationRefresh();
}

async function runCoordinatorInvalidationRefresh(): Promise<void> {
  const lease = playlistRuntimeLease;
  if (!active || !isCoordinator() || coordinatorRefresh || !lease) return;
  invalidationRefreshScheduled = false;
  clearManagedTimer(INVALIDATION_REFRESH_TIMER);
  const attemptedRevision = invalidationHighWater.revision;
  const attemptedPlaylistRevision = invalidationHighWater.playlistRevision;

  const refresh = (async () => {
    const snapshot = await controller.refresh();
    await acceptPlaylistSnapshot(snapshot);
    if (isPlaylistLeaseCurrent(lease) && isCoordinator()) {
      await refreshPersistedQueueMode(snapshot, { broadcast: true });
    }
  })();
  coordinatorRefresh = refresh;
  try {
    await refresh;
  } catch (error) {
    if (isTerminalSessionError(error)) await recoverTerminalSession(error);
    else log.warn('[PRO] Coordinator playlist refresh failed', error);
  } finally {
    if (isPlaylistLeaseCurrent(lease) && coordinatorRefresh === refresh) {
      coordinatorRefresh = null;
      lastInvalidationRefreshAt = Date.now();
      // A hint arriving during this request may describe a later commit than
      // the snapshot we just fetched. Preserve its high-water mark and
      // schedule one throttled follow-up. A forged/server-ahead mark is not
      // spun forever; the regular heartbeat will reconcile it later.
      if (
        invalidationHighWater.revision > attemptedRevision ||
        invalidationHighWater.playlistRevision > attemptedPlaylistRevision
      ) {
        scheduleCoordinatorInvalidationRefresh();
      }
    }
  }
}

registerHandler(MSG.PRO_ROOM_INVALIDATED, (data, conn: DataConnection) => {
  const context = getState('room.context');
  const current = playlistManager?.snapshot;
  if (
    context.kind !== 'pro' ||
    !isCoordinator() ||
    !verifyPeerCapability(conn, 'queue.mutate') ||
    (data.revision <= (current?.revision ?? -1) &&
      data.playlistRevision <= (current?.playlistRevision ?? -1))
  ) {
    return;
  }

  if (!invalidationHighWater.offer(data, current ?? { revision: -1, playlistRevision: -1 })) return;
  scheduleCoordinatorInvalidationRefresh();
});

function acceptDeveloperInvalidation(frame: DeveloperInvalidationFrame): void {
  const context = getState('room.context');
  const current = playlistManager?.snapshot;
  if (
    context.kind !== 'pro' ||
    !isCoordinator() ||
    context.roomId !== frame.roomCode ||
    context.epoch !== frame.coordinatorEpoch ||
    (frame.revision <= (current?.revision ?? -1) &&
      frame.playlistRevision <= (current?.playlistRevision ?? -1))
  ) {
    return;
  }

  if (!invalidationHighWater.offer(frame, current ?? { revision: -1, playlistRevision: -1 })) {
    return;
  }
  scheduleCoordinatorInvalidationRefresh();
}

bus.on('network:developer-invalidation', acceptDeveloperInvalidation);

bus.on('network:pro-queue-addition', (frame) => {
  const context = getState('room.context');
  if (
    context.kind !== 'pro' ||
    !isCoordinator() ||
    context.roomId !== frame.roomCode ||
    context.epoch !== frame.coordinatorEpoch ||
    seenQueueAdditionEventIds.has(frame.eventId) ||
    pendingQueueAdditions.has(frame.eventId)
  ) {
    return;
  }
  pendingQueueAdditions.set(frame.eventId, frame);
  while (pendingQueueAdditions.size > 128) {
    const oldest = pendingQueueAdditions.keys().next().value as string | undefined;
    if (!oldest) break;
    pendingQueueAdditions.delete(oldest);
  }
  scheduleAcceptedQueueAdditionFlush();
});

bus.on('network:developer-command', (frame) => {
  void developerControl.handle(frame).catch((error) => {
    // A failed authoritative refresh is deliberately left unacknowledged;
    // after execution, the RAM dedupe entry remains even when only the ACK
    // failed, so bounded redelivery cannot repeat an applied side effect.
    log.warn('[PRO] Developer command delivery was not acknowledged', error);
  });
});

registerProRoomHardCloseHandler(() => hardCloseActiveProRoom());
registerProRoomLeaveHandler(() => leaveActiveProRoom());
registerProRoomSignalingReconnectHandler(() => refreshSignalingCredential());
registerProRoomSignalingEpochAdvanceHandler(() => beginTopologyRecovery());
