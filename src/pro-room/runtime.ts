import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { batchSetState, getState, setState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { MSG } from '../core/constants.ts';
import { scheduleSessionReset } from '../core/session-reset.ts';
import { t } from '../i18n/index.ts';
import { showLoader, updateLoader } from '../ui/toast.ts';
import { broadcast, sendToHost } from '../network/peer.ts';
import { registerHandler } from '../network/protocol.ts';
import { applyPlaylistSnapshot, moveQueueItemBefore } from '../player/queue-model.ts';
import { setPendingRecoveryTarget } from '../player/_state.ts';
import { clearPreloadState, getShuffleNextPlayableQueueItemId } from '../player/playlist.ts';
import { getTrackPosition } from '../player/transport.ts';
import { getYouTubePlayer } from '../youtube/_state.ts';
import {
  isCoordinator,
  resetRoomContext,
  setRoomContext,
  verifyPeerCapability,
} from '../rooms/authority.ts';
import type {
  DataConnection,
  PlaylistItem,
  PlaylistWireItem,
  QueueItemId,
  RoomContext,
} from '../types/index.ts';
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
import {
  registerProRoomLegacyMediaHooks,
  restoreProRoomLegacyPlayback,
  type ProRoomLegacyMediaHooks,
} from './legacy-media-hooks.ts';
import { ProRoomInvalidationHighWater } from './invalidation-high-water.ts';
import { buildProRoomUnloadCheckpoint, waitForProRoomPresenceClose } from './hard-close.ts';
import { createProRoomIdempotencyKey } from './idempotency.ts';
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
const PLAYBACK_RESTORE_TIMEOUT_MS = 120_000;
const PLAYBACK_RESTORE_TIMEOUT_TIMER = 'pro-room-playback-restore-timeout';
const INVALIDATION_REFRESH_MIN_INTERVAL_MS = 5_000;
const INVALIDATION_REFRESH_TIMER = 'pro-room-invalidation-refresh';
const EXPLICIT_LEAVE_CLOSE_TIMEOUT_MS = 1_200;

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
let suppressPlaybackCheckpoint = false;
let lastPlaybackRestoreKey = '';
let terminalRecoveryInFlight = false;
let topologyRecoveryAttempt = 0;
let invalidationRefreshScheduled = false;
let lastInvalidationRefreshAt = 0;
const invalidationHighWater = new ProRoomInvalidationHighWater();
const heartbeatSingleFlight = new ProRoomHeartbeatSingleFlight();
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
}
let pendingFileDownload: PendingFileDownload | null = null;
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
  const current = getState('playlist.items');
  let changed = false;
  const next = current.map((item) => {
    const wire = sourceById.get(item.queueItemId);
    if (!wire || wire.source.kind !== 'pro-r2') return item;
    const file = mediaTransfer?.cache.get(wire.source, wire.name) ?? null;
    if (!file || item.file === file) return item;
    changed = true;
    return { ...item, file };
  });
  if (changed) setState('playlist.items', next);
}

function reconcileRemovedProRoomQueueState(removedQueueItemIds: readonly QueueItemId[]): void {
  if (removedQueueItemIds.length === 0) return;
  const removedIds = new Set(removedQueueItemIds);

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
        : t('pro.connect_failed');
  bus.emit('ui:show-toast', message);
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
      const existing = pendingFileDownload;
      if (
        existing?.queueItemId === queueItemId &&
        existing.leaseGeneration === lease.generation &&
        existing.roomCode === lease.roomCode &&
        !existing.controller.signal.aborted
      ) {
        return existing.promise;
      }
      if (existing) existing.controller.abort();
      const item = getState('playlist.items').find(
        (candidate) => candidate.queueItemId === queueItemId,
      );
      if (!item || item.type !== 'file') return null;
      if (item.file) return Promise.resolve(item.file);
      const transfer = mediaTransfer;
      const roomCode = lease.roomCode;
      const linkedAbort = createRoomLinkedAbortController(playlistRuntimeAbort?.signal);
      const loaderId = openTransferLoader('download', t('pro.downloading'));
      let completed = false;
      const download: Promise<File | null> = resolveCanonicalR2Source(queueItemId, lease)
        .then(async (source) => {
          if (!source || !isDownloadLeaseCurrent(lease) || linkedAbort.controller.signal.aborted) {
            return null;
          }
          const file = await transfer.download({
            code: roomCode,
            name: item.name,
            source,
            onProgress: (fraction) => reportTransferProgress(loaderId, fraction),
            signal: linkedAbort.controller.signal,
          });
          if (!isDownloadLeaseCurrent(lease) || linkedAbort.controller.signal.aborted) {
            return null;
          }
          const liveSource = playlistProjection?.sourceFor(queueItemId) ?? null;
          if (!liveSource || liveSource.kind !== 'pro-r2' || !sameR2Source(liveSource, source)) {
            log.warn('[PRO] Downloaded asset no longer matches the canonical playlist source');
            return null;
          }
          const items = getState('playlist.items');
          const index = items.findIndex((candidate) => candidate.queueItemId === queueItemId);
          if (index < 0) return null;
          const next = [...items];
          next[index] = { ...next[index]!, file };
          setState('playlist.items', next);
          completed = true;
          return file;
        })
        .catch((error) => {
          if (linkedAbort.controller.signal.aborted || !isDownloadLeaseCurrent(lease)) {
            return null;
          }
          if (getState('playlist.currentQueueItemId') === queueItemId) {
            reportPlaylistError(error);
          }
          throw error;
        })
        .finally(() => {
          linkedAbort.detach();
          closeTransferLoader(loaderId, completed);
          if (pendingFileDownload?.promise === download) pendingFileDownload = null;
        });
      pendingFileDownload = {
        queueItemId,
        leaseGeneration: lease.generation,
        roomCode,
        controller: linkedAbort.controller,
        promise: download,
      };
      return download;
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
  pendingFileDownload?.controller.abort();
  pendingFileDownload = null;
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
  lastInvalidationRefreshAt = 0;
  clearManagedTimer(INVALIDATION_REFRESH_TIMER);
  checkpointInFlight = false;
  checkpointDirty = false;
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
  if (!hasPendingCoordinatorInvalidation()) {
    invalidationRefreshScheduled = false;
    clearManagedTimer(INVALIDATION_REFRESH_TIMER);
  }
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
  heartbeatSingleFlight.reset();
  refreshInFlight = false;
  topologyRecoveryAttempt = 0;
  clearManagedTimer(HEARTBEAT_TIMER);
  clearManagedTimer(SIGNALING_REFRESH_TIMER);
  clearManagedTimer(PLAYBACK_CHECKPOINT_TIMER);
  clearManagedTimer(PLAYBACK_CHECKPOINT_DEBOUNCE_TIMER);
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
    }
    if (cancelPlaybackRestoreForQueueOverride()) return;
    reconcilePlaybackRestore();
    schedulePlaybackCheckpoint();
  });
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

registerProRoomHardCloseHandler(() => hardCloseActiveProRoom());
registerProRoomLeaveHandler(() => leaveActiveProRoom());
registerProRoomSignalingReconnectHandler(() => refreshSignalingCredential());
registerProRoomSignalingEpochAdvanceHandler(() => beginTopologyRecovery());
