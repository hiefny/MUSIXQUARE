import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { batchSetState, getState, setState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { scheduleSessionReset } from '../core/session-reset.ts';
import { t } from '../i18n/index.ts';
import { announceTracksAddedLocally } from '../chat/queue-events.ts';
import { receiveProRoomRealtimeChat } from '../chat/protocol.ts';
import { showLoader, updateLoader } from '../ui/toast.ts';
import { applyRoomEffectsState, captureRoomEffectsState } from '../audio/effects.ts';
import {
  roomEffectsEqual,
  type ProRoomEffectsSnapshot,
  type RoomEffectsState,
} from '../core/room-effects.ts';
import { applyPlaylistSnapshot, moveQueueItemBefore } from '../player/queue-model.ts';
import { liveAudioBufferPcmBytes, setPendingRecoveryTarget } from '../player/_state.ts';
import {
  isAudioDecodeAdmissionError,
  reserveEncodedReceiveMemoryWithinBudget,
} from '../player/decode-admission.ts';
import {
  applyPlaylistQueueModeState,
  capturePlaylistQueueModeState,
  clearPreloadState,
  reconcileShuffleOrderForCurrentPlaylist,
} from '../player/playlist.ts';
import { schedulePreload } from '../storage/preload.ts';
import { setPlaybackTrackMeta } from '../player/ownership.ts';
import { updateSubItemIds } from '../youtube/_state.ts';
import { resolveYouTubePlaylistManifest } from '../youtube/search.ts';
import { resetRoomContext, setRoomContext } from '../rooms/authority.ts';
import type { PlaylistItem, PlaylistWireItem, QueueItemId, RoomContext } from '../types/index.ts';
import {
  parseProQueueAdditionFrame,
  type ProQueueAdditionFrame,
} from '../network/transport/types.ts';
import {
  ProRoomApiClient,
  ProRoomApiError,
  parseProRoomPlaybackCancelEvent,
  parseProRoomPlaybackCommitEvent,
  parseProRoomPlaybackPrepareEvent,
  type ActivateProRoomInput,
  type CreateProRoomSessionInput,
  type EnterProRoomPresenceOptions,
  type ProRoomBotCommandResult,
  type ProRoomBootstrap,
  type ProRoomPlaybackCommand,
  type ProRoomPlaybackCommitEvent,
  type ProRoomPlaybackPrepareEvent,
  type RecoverProRoomOwnerInput,
} from './api.ts';
import type { ProRoomPlaybackCheckpoint, ProRoomR2Source, ProRoomSnapshot } from './contracts.ts';
import type { ProRoomQueueModeSnapshot } from './queue-mode.ts';
import {
  registerProRoomLegacyMediaHooks,
  type ProRoomLegacyMediaHooks,
} from './legacy-media-hooks.ts';
import { waitForProRoomPresenceClose } from './hard-close.ts';
import { createProRoomIdempotencyKey } from './idempotency.ts';
import {
  registerProRoomHardCloseHandler,
  registerProRoomLeaveHandler,
  registerProRoomSignalingEpochAdvanceHandler,
  registerProRoomSignalingReconnectHandler,
} from './lifecycle-hook.ts';
import { ProRoomHeartbeatSingleFlight } from './heartbeat-single-flight.ts';
import { ProRoomMediaTransfer } from './media-transfer.ts';
import {
  getProRoomServerNow,
  isProRoomServerClockCalibrated,
  onProRoomRealtimeConnection,
  onProRoomRealtimeEvent,
  proRoomServerBridge,
  waitForFreshProRoomServerClockCalibration,
  type ProRealtimeRelayEnvelope,
  type ProServerEventEnvelope,
} from './network-bridge.ts';
import {
  cancelProPlaybackPreparation,
  commitProPlaybackAuthority,
  createProPlaybackAuthorityToken,
  prepareProPlaybackAuthority,
  registerProPlaybackCommandHandler,
  resetProPlaybackAuthorityHooks,
  type ProPlaybackAuthorityToken,
  type ProPlaybackTimingMode,
  type ProPlaybackUserIntent,
} from './playback-authority-hooks.ts';
import { completeProRoomPinRotation } from './pin-rotation.ts';
import { ProRoomPlaylistProjection } from './playlist-projection.ts';
import {
  ProRoomPlaylistStateManager,
  type ProRoomFirstAppendSelectionRequest,
} from './playlist-state-manager.ts';
import {
  findRemovedProRoomQueueItemIds,
  resolveProRoomRemovalTransition,
} from './playlist-transition.ts';
import { ProRoomSessionController, type ProRoomSessionObserver } from './session-controller.ts';
import { createByteWeightedProgressEntries } from './transfer-progress.ts';
import {
  markProRoomTransportRecovered,
  requestProRoomTransportRecovery,
  resetProRoomTransportRecovery,
} from './transport-recovery.ts';
import { onProRoomTabTakeover } from './tab-handoff.ts';
import {
  bindProSystemAudioSession,
  configureProSystemAudioService,
  refreshProSystemAudioState,
  releaseLocalProSystemAudioLease,
  resetProSystemAudioService,
} from './system-audio-service.ts';

const HEARTBEAT_INTERVAL_MS = 15_000;
const CONTROL_CHANNEL_RECOVERY_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const HEARTBEAT_TIMER = 'pro-room-heartbeat';
const EFFECTS_CHECKPOINT_DEBOUNCE_MS = 350;
const EFFECTS_CHECKPOINT_DEBOUNCE_TIMER = 'pro-room-effects-checkpoint-debounce';
const QUEUE_MODE_CHECKPOINT_DEBOUNCE_MS = 350;
const QUEUE_MODE_CHECKPOINT_DEBOUNCE_TIMER = 'pro-room-queue-mode-checkpoint-debounce';
const QUEUE_MODE_CHECKPOINT_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const QUEUE_ADDITION_FLUSH_TIMER = 'pro-room-queue-addition-flush';
const QUEUE_ADDITION_REORDER_WINDOW_MS = 100;
const EXPLICIT_LEAVE_CLOSE_TIMEOUT_MS = 1_200;
// Keep well below the manifest endpoint's per-IP minute budget so a room with
// legacy rows cannot starve an explicit user add. Remaining rows continue on
// a later room session.
const MAX_LAZY_YOUTUBE_MANIFEST_UPGRADES = 4;

const api = new ProRoomApiClient();
configureProSystemAudioService(api);
const bridge = proRoomServerBridge;
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
let effectsMutationTail: Promise<void> = Promise.resolve();
let acceptedEffects: ProRoomEffectsSnapshot | null = null;
let suppressEffectsCheckpoint = false;
let queueModeMutationTail: Promise<void> = Promise.resolve();
let acceptedQueueMode: ProRoomQueueModeSnapshot | null = null;
let suppressQueueModeCheckpoint = false;
let queueModeCheckpointDirty = false;
let queueModeCheckpointRetryAttempt = 0;
let terminalRecoveryInFlight = false;
let controlChannelRecoveryAttempt = 0;
const heartbeatSingleFlight = new ProRoomHeartbeatSingleFlight();
const seenQueueAdditionEventIds = new Set<string>();
const pendingQueueAdditions = new Map<string, ProQueueAdditionFrame>();
let lastAnnouncedQueueAdditionOrder = 0;
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
let unregisterPlaybackCommandHandler: (() => void) | null = null;
let playbackCommandTail: Promise<void> = Promise.resolve();
let highestKnownPlaybackRevision = -1;
let lastAppliedPlaybackRevision = -1;
let activeServerPlaybackTransition: {
  event: ProRoomPlaybackPrepareEvent;
  authority: ProPlaybackAuthorityToken;
  preparation: ReturnType<typeof prepareProPlaybackAuthority>;
  readyReportStarted: boolean;
  receivedAtMs: number;
  clockAbort: AbortController;
} | null = null;
const playbackCommitInFlight = new Map<number, Promise<void>>();
let playbackCommitTail: Promise<void> = Promise.resolve();
let playbackCommitGeneration = 0;
let youtubeManifestUpgradeTail: Promise<void> = Promise.resolve();
const attemptedYouTubeManifestUpgrades = new Set<QueueItemId>();

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

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Publish canonical server manifests into the legacy YouTube navigation map. */
function hydrateProRoomYouTubeManifests(snapshot: ProRoomSnapshot): void {
  for (const item of snapshot.playlist) {
    if (item.source.kind !== 'youtube' || !item.source.playlistId || !item.source.videoIds) {
      continue;
    }
    const current = getState('youtube.subItemsMap')[item.source.playlistId];
    if (current && sameStringArray(current.ids, item.source.videoIds)) continue;
    // updateSubItemIds clones the IDs and retains any richer titles already
    // fetched by this endpoint instead of replacing them with empty labels.
    updateSubItemIds(item.source.playlistId, item.source.videoIds);
  }
}

/** @internal Focused regression seam for authoritative manifest hydration. */
export function hydrateProRoomYouTubeManifestsForTests(snapshot: ProRoomSnapshot): void {
  hydrateProRoomYouTubeManifests(snapshot);
}

function isLegacyYouTubeSourceCurrent(
  queueItemId: QueueItemId,
  playlistId: string,
  videoId: string,
): boolean {
  const source = playlistProjection?.sourceFor(queueItemId);
  return (
    source?.kind === 'youtube' &&
    source.playlistId === playlistId &&
    source.videoId === videoId &&
    source.videoIds === undefined
  );
}

interface LegacyYouTubeManifestCandidate {
  queueItemId: QueueItemId;
  playlistId: string;
  videoId: string;
}

function claimLegacyYouTubeManifestCandidates(
  snapshot: ProRoomSnapshot,
  attempted: Set<QueueItemId>,
): LegacyYouTubeManifestCandidate[] {
  const candidates: LegacyYouTubeManifestCandidate[] = [];
  for (const item of snapshot.playlist) {
    if (attempted.size >= MAX_LAZY_YOUTUBE_MANIFEST_UPGRADES) break;
    if (
      item.source.kind !== 'youtube' ||
      !item.source.playlistId ||
      item.source.videoIds ||
      item.queueItemId === snapshot.currentQueueItemId ||
      attempted.has(item.queueItemId)
    ) {
      continue;
    }
    attempted.add(item.queueItemId);
    candidates.push({
      queueItemId: item.queueItemId,
      playlistId: item.source.playlistId,
      videoId: item.source.videoId,
    });
  }
  return candidates;
}

function scheduleLegacyYouTubeManifestUpgrades(
  snapshot: ProRoomSnapshot,
  lease: PlaylistRuntimeLease,
): void {
  const manager = playlistManager;
  const operationSignal = playlistRuntimeAbort?.signal;
  if (!manager || !operationSignal || operationSignal.aborted || !isPlaylistLeaseCurrent(lease)) {
    return;
  }

  for (const { queueItemId, playlistId, videoId } of claimLegacyYouTubeManifestCandidates(
    snapshot,
    attemptedYouTubeManifestUpgrades,
  )) {
    const operation = youtubeManifestUpgradeTail.then(async () => {
      if (
        operationSignal.aborted ||
        !isPlaylistLeaseCurrent(lease) ||
        !isLegacyYouTubeSourceCurrent(queueItemId, playlistId, videoId)
      ) {
        return;
      }

      const resolved = await resolveYouTubePlaylistManifest(playlistId, operationSignal);
      if (
        operationSignal.aborted ||
        !isPlaylistLeaseCurrent(lease) ||
        resolved.playlistId !== playlistId ||
        !isLegacyYouTubeSourceCurrent(queueItemId, playlistId, videoId)
      ) {
        return;
      }
      if (!resolved.videoIds.includes(videoId)) {
        log.warn(
          `[PRO] Legacy YouTube entry ${videoId} is absent from resolved playlist ${playlistId}`,
        );
        return;
      }
      await manager.updateYouTubeManifest(
        queueItemId,
        { playlistId, videoId, videoIds: resolved.videoIds },
        { signal: operationSignal },
      );
    });
    youtubeManifestUpgradeTail = operation.catch((error) => {
      if (!operationSignal.aborted && isPlaylistLeaseCurrent(lease)) {
        log.warn('[PRO] Legacy YouTube manifest upgrade failed', error);
      }
    });
  }
}

/** @internal Stable policy seam for bounded-upgrade regression tests. */
export function maxLazyYouTubeManifestUpgradesForTests(): number {
  return MAX_LAZY_YOUTUBE_MANIFEST_UPGRADES;
}

/** @internal Exact bounded candidate-selection seam for regression tests. */
export function claimLegacyYouTubeManifestCandidatesForTests(
  snapshot: ProRoomSnapshot,
  attempted: readonly QueueItemId[] = [],
): QueueItemId[] {
  return claimLegacyYouTubeManifestCandidates(snapshot, new Set(attempted)).map(
    (candidate) => candidate.queueItemId,
  );
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

  // A PRO mutation is projected locally before the legacy-compatible
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

function shouldStopForAuthoritativeDeselection(
  firstProjection: boolean,
  previousCurrentQueueItemId: QueueItemId | null,
  authoritativeCurrentQueueItemId: QueueItemId | null,
  survivingQueueItemIds: ReadonlySet<QueueItemId>,
): boolean {
  return (
    !firstProjection &&
    previousCurrentQueueItemId !== null &&
    authoritativeCurrentQueueItemId === null &&
    survivingQueueItemIds.has(previousCurrentQueueItemId)
  );
}

/** @internal Focused regression seam for authoritative selection invalidation. */
export function shouldStopForAuthoritativeDeselectionForTests(
  firstProjection: boolean,
  previousCurrentQueueItemId: QueueItemId | null,
  authoritativeCurrentQueueItemId: QueueItemId | null,
  survivingQueueItemIds: ReadonlySet<QueueItemId>,
): boolean {
  return shouldStopForAuthoritativeDeselection(
    firstProjection,
    previousCurrentQueueItemId,
    authoritativeCurrentQueueItemId,
    survivingQueueItemIds,
  );
}

async function applyProjectedPlaylist(
  snapshot: ProRoomSnapshot,
  playlist: PlaylistItem[],
  lease: PlaylistRuntimeLease,
): Promise<void> {
  if (!isPlaylistLeaseCurrent(lease) || snapshot.roomCode !== lease.roomCode) return;
  hydrateProRoomYouTubeManifests(snapshot);
  scheduleLegacyYouTubeManifestUpgrades(snapshot, lease);
  const nextSignature = projectedSignature(snapshot);
  const firstProjection = playlistSignature === '';
  if (firstProjection || nextSignature !== playlistSignature) {
    const previousItems = getState('playlist.items');
    const previousCurrent = getState('playlist.currentQueueItemId');
    const removedQueueItemIds = firstProjection
      ? []
      : findRemovedProRoomQueueItemIds(previousItems, playlist);
    const survivingQueueItemIds = new Set(playlist.map((item) => item.queueItemId));
    const authoritativeDeselection = shouldStopForAuthoritativeDeselection(
      firstProjection,
      previousCurrent,
      snapshot.currentQueueItemId,
      survivingQueueItemIds,
    );
    const removalTransition = firstProjection
      ? { removedCurrent: false, successorQueueItemId: null }
      : resolveProRoomRemovalTransition(previousItems, playlist, previousCurrent, null);
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
    // Playlist projection is local state only. The server independently emits
    // a revision-fenced playback PREPARE/COMMIT when selection must change.
    const stopProjectedMedia = (): void => {
      bus.emit('player:stop-all-media', { cancelInFlight: true, clearBuffer: true });
      // PRO mutations bypass playlist.ts's ordinary removal teardown and
      // the server's later relay is a duplicate revision. Clear the
      // invalidated occurrence's presentation and resident metadata here so
      // a deselected room cannot keep displaying or replaying the old title.
      setPlaybackTrackMeta(null);
      setState('files.current', null);
      setState('transfer.meta', null);
      if (playlist.length === 0) bus.emit('ui:play-btn-state', false);
    };
    if (authoritativeDeselection) {
      stopProjectedMedia();
    } else if (removalTransition.removedCurrent) {
      stopProjectedMedia();
    }
    // Every equal endpoint preloads directly from R2. The cache remains local
    // and byte-bounded; no participant uploads or relays it for another.
    schedulePreload();
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
      // preload instead of dropping the one-shot server queue event.
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
  const viewerId = snapshot.viewer?.participantId ?? '';
  const participants = [...snapshot.presence.participants].sort(
    (left, right) =>
      left.joinedAtMs - right.joinedAtMs || left.participantId.localeCompare(right.participantId),
  );
  const list = participants.map((participant, index) => ({
    id: participant.participantId,
    label: participant.displayName,
    // PRO lifecycle ownership is deliberately absent from the live device
    // hierarchy. Every row is an equal controller and renders without a host
    // or ADMIN distinction.
    isOp: true,
    isHost: false,
    status: 'connected',
    joinOrder: index,
    connectionType: 'remote' as const,
  }));
  const ownIndex = participants.findIndex((participant) => participant.participantId === viewerId);
  batchSetState({
    'network.connectedPeers': [],
    'network.lastKnownDeviceList': list,
    'network.peerLabels': Object.fromEntries(
      participants.map((participant) => [participant.participantId, participant.displayName]),
    ),
    'network.myJoinOrder': ownIndex >= 0 ? ownIndex : 0,
  });
  bus.emit('network:device-list-update', list);
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
    addYouTube(item, _sourceUrl, completeVideoIds) {
      if (!isPlaylistLeaseCurrent(lease)) return true;
      if (item.type !== 'youtube' || !item.videoId) return false;
      const currentIds = item.playlistId
        ? getState('youtube.subItemsMap')[item.playlistId]?.ids
        : undefined;
      const videoIds =
        completeVideoIds &&
        currentIds &&
        completeVideoIds.includes(item.videoId) &&
        sameStringArray(completeVideoIds, currentIds)
          ? [...currentIds]
          : undefined;
      void manager
        .addYouTube({
          queueItemId: item.queueItemId,
          name: item.name,
          videoId: item.videoId,
          ...(item.playlistId ? { playlistId: item.playlistId } : {}),
          ...(videoIds ? { videoIds } : {}),
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
  youtubeManifestUpgradeTail = Promise.resolve();
  attemptedYouTubeManifestUpgrades.clear();
  registerProRoomLegacyMediaHooks(null);
  mediaTransfer?.cache.clear();
  playlistManager = null;
  playlistProjection = null;
  mediaTransfer = null;
  playlistRoomCode = null;
  playlistSignature = '';
  seenQueueAdditionEventIds.clear();
  pendingQueueAdditions.clear();
  lastAnnouncedQueueAdditionOrder = 0;
  clearManagedTimer(QUEUE_ADDITION_FLUSH_TIMER);
  acceptedEffects = null;
  suppressEffectsCheckpoint = false;
  clearManagedTimer(EFFECTS_CHECKPOINT_DEBOUNCE_TIMER);
  queueModeMutationTail = Promise.resolve();
  acceptedQueueMode = null;
  suppressQueueModeCheckpoint = false;
  queueModeCheckpointDirty = false;
  queueModeCheckpointRetryAttempt = 0;
  clearManagedTimer(QUEUE_MODE_CHECKPOINT_DEBOUNCE_TIMER);
  if (activeServerPlaybackTransition) {
    activeServerPlaybackTransition.clockAbort.abort();
    cancelProPlaybackPreparation(activeServerPlaybackTransition.authority);
  }
  activeServerPlaybackTransition = null;
  playbackCommitInFlight.clear();
  playbackCommitGeneration += 1;
  // A promise from the room being torn down must never serialize a canonical
  // COMMIT for the next room incarnation behind stale media work. Its
  // generation fence still prevents it from publishing a late result.
  playbackCommitTail = Promise.resolve();
  playbackCommandTail = Promise.resolve();
  highestKnownPlaybackRevision = -1;
  lastAppliedPlaybackRevision = -1;
  resetProPlaybackAuthorityHooks();
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
    reportMediaCleanupError: ({ assetId, error }) => {
      if (isPlaylistLeaseCurrent(lease)) {
        log.warn(`[PRO] Could not clean unused asset ${assetId}`, error);
      }
    },
    requestFirstAppendSelection: (request, signal) =>
      enqueueFirstAppendSelection(request, lease, signal),
    reportFirstAppendSelectionError: ({ request, error }) => {
      if (isPlaylistLeaseCurrent(lease)) {
        log.warn(
          `[PRO Playback] First appended item ${request.queueItemId} could not be selected`,
          error,
        );
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
  // Coalesce signaling requests that completed out of order before rendering
  // their rows. The accepted snapshot remains the authority fence.
  scheduleAcceptedQueueAdditionFlush();
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
    announceTracksAddedLocally(frame.actorName, frame.count, frame.firstTitle);
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

function cloneRoomEffects(effects: RoomEffectsState): RoomEffectsState {
  return {
    reverb: { ...effects.reverb },
    equalizer: {
      bandsDb: [...effects.equalizer.bandsDb] as RoomEffectsState['equalizer']['bandsDb'],
    },
    virtualBass: { ...effects.virtualBass },
    virtualSurround: { ...effects.virtualSurround },
  };
}

/**
 * Reapply only the fields changed relative to `base` onto a newer canonical
 * snapshot. Two participants can therefore adjust unrelated controls without
 * a stale full-form write erasing either change.
 */
function rebaseRoomEffectsIntent(
  base: RoomEffectsState,
  desired: RoomEffectsState,
  canonical: RoomEffectsState,
): RoomEffectsState {
  const rebased = cloneRoomEffects(canonical);
  for (const key of Object.keys(base.reverb) as (keyof RoomEffectsState['reverb'])[]) {
    if (desired.reverb[key] !== base.reverb[key]) rebased.reverb[key] = desired.reverb[key];
  }
  for (let index = 0; index < desired.equalizer.bandsDb.length; index += 1) {
    if (desired.equalizer.bandsDb[index] !== base.equalizer.bandsDb[index]) {
      rebased.equalizer.bandsDb[index] = desired.equalizer.bandsDb[index];
    }
  }
  if (desired.virtualBass.strengthPercent !== base.virtualBass.strengthPercent) {
    rebased.virtualBass.strengthPercent = desired.virtualBass.strengthPercent;
  }
  if (desired.virtualSurround.widthPercent !== base.virtualSurround.widthPercent) {
    rebased.virtualSurround.widthPercent = desired.virtualSurround.widthPercent;
  }
  return rebased;
}

/** @internal Deterministic seam for concurrent-effects regression tests. */
export function rebaseRoomEffectsIntentForTests(
  base: RoomEffectsState,
  desired: RoomEffectsState,
  canonical: RoomEffectsState,
): RoomEffectsState {
  return rebaseRoomEffectsIntent(base, desired, canonical);
}

function applyCanonicalRoomEffects(effects: RoomEffectsState): boolean {
  suppressEffectsCheckpoint = true;
  try {
    // PRO effect state is server-fanned-out. Applying it locally must never
    // create a second browser-originated broadcast path.
    return applyRoomEffectsState(effects, { broadcast: false });
  } finally {
    suppressEffectsCheckpoint = false;
  }
}

async function persistRoomEffects(): Promise<void> {
  const lease = playlistRuntimeLease;
  if (!active || suppressEffectsCheckpoint || !lease) return;
  await enqueueEffectsMutation(async () => {
    const snapshot = effectsRuntimeSnapshot();
    if (!active || !isPlaylistLeaseCurrent(lease) || snapshot?.roomCode !== lease.roomCode) {
      return;
    }
    let desired = captureRoomEffectsState();
    let base = acceptedEffects?.roomCode === snapshot.roomCode ? acceptedEffects : null;
    try {
      if (!base || snapshot.effectsRevision > base.revision) {
        const previousBase = base;
        const desiredBeforeRead = desired;
        const canonical = await api.getEffects(snapshot.roomCode, playlistRuntimeAbort?.signal);
        if (!active || !isPlaylistLeaseCurrent(lease)) return;
        const latestLocal = captureRoomEffectsState();
        desired = previousBase
          ? rebaseRoomEffectsIntent(previousBase.effects, desiredBeforeRead, canonical.effects)
          : desiredBeforeRead;
        // Preserve adjustments made while the canonical GET was in flight.
        desired = rebaseRoomEffectsIntent(desiredBeforeRead, latestLocal, desired);
        base = canonical;
        acceptedEffects = canonical;
        if (!roomEffectsEqual(latestLocal, desired)) applyCanonicalRoomEffects(desired);
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (roomEffectsEqual(base.effects, desired)) return;
        try {
          const accepted = await api.updateEffects(
            {
              code: snapshot.roomCode,
              coordinatorEpoch: snapshot.presence.coordinatorEpoch,
              baseRevision: base.revision,
              effects: desired,
            },
            playlistRuntimeAbort?.signal,
          );
          if (active && isPlaylistLeaseCurrent(lease)) acceptedEffects = accepted;
          return;
        } catch (error) {
          if (
            attempt !== 0 ||
            !(error instanceof ProRoomApiError) ||
            error.code !== 'EFFECTS_REVISION_CONFLICT'
          ) {
            throw error;
          }
          const previousBase = base;
          const desiredBeforeRead = desired;
          const canonical = await api.getEffects(snapshot.roomCode, playlistRuntimeAbort?.signal);
          if (!active || !isPlaylistLeaseCurrent(lease)) return;
          const latestLocal = captureRoomEffectsState();
          desired = rebaseRoomEffectsIntent(
            previousBase.effects,
            desiredBeforeRead,
            canonical.effects,
          );
          desired = rebaseRoomEffectsIntent(desiredBeforeRead, latestLocal, desired);
          base = canonical;
          acceptedEffects = canonical;
          if (!roomEffectsEqual(latestLocal, desired)) applyCanonicalRoomEffects(desired);
        }
      }
    } catch (error) {
      if (active && isPlaylistLeaseCurrent(lease)) {
        log.warn('[PRO] Room effects checkpoint failed', error);
      }
    }
  });
}

function scheduleEffectsCheckpoint(): void {
  if (!active || suppressEffectsCheckpoint) return;
  clearManagedTimer(EFFECTS_CHECKPOINT_DEBOUNCE_TIMER);
  setManagedTimer(
    EFFECTS_CHECKPOINT_DEBOUNCE_TIMER,
    () => void persistRoomEffects(),
    EFFECTS_CHECKPOINT_DEBOUNCE_MS,
  );
}

async function refreshPersistedEffectsUnlocked(snapshot: ProRoomSnapshot): Promise<boolean> {
  const lease = playlistRuntimeLease;
  if (!lease || !isPlaylistLeaseCurrent(lease) || lease.roomCode !== snapshot.roomCode)
    return false;
  const accepted = await api.getEffects(snapshot.roomCode, playlistRuntimeAbort?.signal);
  const current = effectsRuntimeSnapshot();
  if (!isPlaylistLeaseCurrent(lease) || current?.roomCode !== snapshot.roomCode) return false;
  if (!applyCanonicalRoomEffects(accepted.effects)) return false;
  acceptedEffects = accepted;
  return true;
}

async function refreshPersistedEffects(snapshot: ProRoomSnapshot): Promise<boolean> {
  return enqueueEffectsMutation(() => refreshPersistedEffectsUnlocked(snapshot));
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
  if (!active || suppressQueueModeCheckpoint || !manager || !lease || !signal) {
    return;
  }
  await enqueueQueueModeMutation(async () => {
    if (
      !active ||
      suppressQueueModeCheckpoint ||
      !isPlaylistLeaseCurrent(lease) ||
      signal.aborted
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
      await refreshPersistedQueueModeUnlocked(snapshot);
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
        await refreshPersistedQueueModeUnlocked(snapshot);
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
    queueModeCheckpointDirty = false;
    queueModeCheckpointRetryAttempt = 0;
  });
}

function scheduleQueueModeCheckpoint(): void {
  if (!active || suppressQueueModeCheckpoint) return;
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
    // The server invalidation reaches every equal endpoint; never fan this
    // state through a browser participant.
    void changed;
    void options;
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

function serverNowForFrame(serverTimeMs: number, receivedAtMs: number): number {
  return isProRoomServerClockCalibrated()
    ? getProRoomServerNow()
    : serverTimeMs + Math.max(0, Date.now() - receivedAtMs);
}

function playbackAuthorityFor(
  roomCode: string,
  roomEpoch: number,
  playbackRevision: number,
  transitionId: string | null,
): ProPlaybackAuthorityToken {
  return createProPlaybackAuthorityToken({
    roomId: roomCode,
    roomEpoch,
    basePlaybackRevision: Math.max(0, playbackRevision - 1),
    transitionId,
  });
}

function playbackPrepareRequest(
  authority: ProPlaybackAuthorityToken,
  playback: ProRoomPlaybackCheckpoint,
) {
  if (!playback.queueItemId) return null;
  return {
    authority,
    queueItemId: playback.queueItemId,
    positionSeconds: playback.positionSeconds,
    youtubeSubIndex: playback.youtubeSubIndex,
    youtubeVideoId: playback.youtubeVideoId,
  } as const;
}

function sameServerTransition(
  activeTransition: typeof activeServerPlaybackTransition,
  event: ProRoomPlaybackPrepareEvent,
): boolean {
  return !!(
    activeTransition &&
    activeTransition.event.transitionId === event.transitionId &&
    activeTransition.event.basePlaybackRevision === event.basePlaybackRevision
  );
}

function reportPlaybackPreparation(
  transition: NonNullable<typeof activeServerPlaybackTransition>,
): void {
  if (transition.readyReportStarted) return;
  transition.readyReportStarted = true;
  void transition.preparation
    .then(async (result) => {
      if (activeServerPlaybackTransition !== transition) return;
      let status: 'ready' | 'failed' = 'failed';
      if (result.status === 'ready') {
        const elapsedSinceReceiptMs = Math.max(0, Date.now() - transition.receivedAtMs);
        const fallbackTimeoutMs = Math.max(
          0,
          transition.event.deadlineAtMs - transition.event.serverTimeMs - elapsedSinceReceiptMs,
        );
        const calibrated = await waitForFreshProRoomServerClockCalibration({
          serverDeadlineAtMs: transition.event.deadlineAtMs,
          fallbackTimeoutMs,
          signal: transition.clockAbort.signal,
        });
        if (activeServerPlaybackTransition !== transition) return;
        if (calibrated) status = 'ready';
      }
      try {
        const outcome = await api.reportPlaybackTransitionReady({
          code: transition.authority.roomId,
          transitionId: transition.event.transitionId,
          basePlaybackRevision: transition.event.basePlaybackRevision,
          status,
        });
        // A lost WebSocket COMMIT is recovered from the canonical snapshot.
        if (outcome === 'committed') void runHeartbeat(true);
      } catch (error) {
        if (
          error instanceof ProRoomApiError &&
          (error.code === 'PLAYBACK_TRANSITION_NOT_FOUND' ||
            error.code === 'PLAYBACK_TRANSITION_STALE' ||
            error.code === 'PLAYBACK_TRANSITION_NOT_IN_COHORT')
        ) {
          return;
        }
        log.warn('[PRO Playback] Could not report participant readiness', error);
      }
    })
    .catch((error) => {
      log.warn('[PRO Playback] Participant preparation failed unexpectedly', error);
    });
}

function acceptPlaybackPrepare(
  event: ProRoomPlaybackPrepareEvent,
  receivedAtMs = Date.now(),
): void {
  const context = getState('room.context');
  if (
    !active ||
    context.kind !== 'pro' ||
    !context.roomId ||
    event.target.coordinatorEpoch !== context.epoch ||
    event.target.revision !== event.basePlaybackRevision + 1 ||
    event.target.state === 'idle' ||
    !event.target.queueItemId ||
    event.basePlaybackRevision < highestKnownPlaybackRevision
  ) {
    return;
  }
  if (sameServerTransition(activeServerPlaybackTransition, event)) return;

  if (activeServerPlaybackTransition) {
    activeServerPlaybackTransition.clockAbort.abort();
    cancelProPlaybackPreparation(activeServerPlaybackTransition.authority);
  }
  const authority = createProPlaybackAuthorityToken({
    roomId: context.roomId,
    roomEpoch: context.epoch,
    basePlaybackRevision: event.basePlaybackRevision,
    transitionId: event.transitionId,
  });
  const request = playbackPrepareRequest(authority, event.target);
  if (!request) return;
  const transition = {
    event,
    authority,
    preparation: prepareProPlaybackAuthority(request),
    readyReportStarted: false,
    receivedAtMs,
    clockAbort: new AbortController(),
  };
  activeServerPlaybackTransition = transition;
  reportPlaybackPreparation(transition);
}

function acceptPlaybackCancel(transitionId: string): void {
  const transition = activeServerPlaybackTransition;
  if (!transition || transition.event.transitionId !== transitionId) return;
  transition.clockAbort.abort();
  cancelProPlaybackPreparation(transition.authority);
  activeServerPlaybackTransition = null;
}

function playbackCommitStillCurrent(
  event: ProRoomPlaybackCommitEvent,
  generation: number,
): boolean {
  const context = getState('room.context');
  return !!(
    active &&
    generation === playbackCommitGeneration &&
    context.kind === 'pro' &&
    !!context.roomId &&
    context.epoch === event.playback.coordinatorEpoch &&
    event.playback.revision > lastAppliedPlaybackRevision &&
    event.playback.revision >= highestKnownPlaybackRevision
  );
}

const PRO_PLAYBACK_ZERO_START_WIRE_LEAD_MS = 699;

function playbackCommitTiming(
  event: ProRoomPlaybackCommitEvent,
  receivedAtMs: number,
): {
  positionSeconds: number;
  scheduleDelayMs: number;
  timingMode: ProPlaybackTimingMode;
} {
  const nowMs = serverNowForFrame(event.serverTimeMs, receivedAtMs);
  // Wire-compatible rollout marker: old clients treat 699ms as an ordinary
  // future COMMIT instant. Refreshed clients grant platform lead only to this
  // explicit marker; legacy, direct, and malformed timings fail safely as
  // running-timeline controls.
  const zeroStart =
    event.transitionId !== null &&
    event.executeAtMs - event.serverTimeMs === PRO_PLAYBACK_ZERO_START_WIRE_LEAD_MS;
  return {
    scheduleDelayMs: Math.max(0, event.executeAtMs - nowMs),
    timingMode: zeroStart ? 'zero-start' : 'scheduled-control',
    positionSeconds:
      event.playback.state === 'playing'
        ? event.playback.positionSeconds + Math.max(0, nowMs - event.executeAtMs) / 1_000
        : event.playback.positionSeconds,
  };
}

function clearServerPlaybackTransition(
  transition: NonNullable<typeof activeServerPlaybackTransition>,
): void {
  transition.clockAbort.abort();
  cancelProPlaybackPreparation(transition.authority);
  if (activeServerPlaybackTransition === transition) activeServerPlaybackTransition = null;
}

async function catchUpExactPlaybackCheckpoint(
  event: ProRoomPlaybackCommitEvent,
  receivedAtMs: number,
  generation: number,
  roomCode: string,
  roomEpoch: number,
) {
  const playback = event.playback;
  if (playback.state === 'idle' || !playback.queueItemId) return null;
  const authority = playbackAuthorityFor(
    roomCode,
    roomEpoch,
    playback.revision,
    `snapshot_${playback.revision}`,
  );
  const request = playbackPrepareRequest(authority, playback);
  if (!request) return null;
  const prepared = await prepareProPlaybackAuthority(request);
  if (!playbackCommitStillCurrent(event, generation)) {
    cancelProPlaybackPreparation(authority);
    return null;
  }
  if (prepared.status !== 'ready') {
    cancelProPlaybackPreparation(authority);
    return null;
  }
  const timing = playbackCommitTiming(event, receivedAtMs);
  return commitProPlaybackAuthority({
    authority,
    committedPlaybackRevision: playback.revision,
    queueItemId: playback.queueItemId,
    state: playback.state,
    positionSeconds: timing.positionSeconds,
    scheduleDelayMs: timing.scheduleDelayMs,
    // Catch-up is already following a committed running checkpoint; applying
    // the one-time zero-start lead here would move a late endpoint ahead.
    timingMode: 'scheduled-control',
    youtubeSubIndex: playback.youtubeSubIndex,
    youtubeVideoId: playback.youtubeVideoId,
    isCurrent: () => playbackCommitStillCurrent(event, generation),
  });
}

async function applyPlaybackCommit(
  event: ProRoomPlaybackCommitEvent,
  receivedAtMs: number,
  generation: number,
): Promise<void> {
  const context = getState('room.context');
  const playback = event.playback;
  if (
    !active ||
    context.kind !== 'pro' ||
    !context.roomId ||
    playback.coordinatorEpoch !== context.epoch ||
    playback.revision <= lastAppliedPlaybackRevision ||
    playback.revision < highestKnownPlaybackRevision
  ) {
    return;
  }
  if (!playbackCommitStillCurrent(event, generation)) return;

  highestKnownPlaybackRevision = Math.max(highestKnownPlaybackRevision, playback.revision);
  let authority: ProPlaybackAuthorityToken;
  let preparation: ReturnType<typeof prepareProPlaybackAuthority> | null = null;
  let preparedFromMatchingTransition = false;
  const activeTransition = activeServerPlaybackTransition;
  if (
    event.transitionId !== null &&
    activeTransition?.event.transitionId === event.transitionId &&
    activeTransition.event.target.revision === playback.revision
  ) {
    authority = activeTransition.authority;
    preparation = activeTransition.preparation;
    preparedFromMatchingTransition = true;
  } else if (event.transitionId !== null && playback.queueItemId) {
    if (activeTransition) cancelProPlaybackPreparation(activeTransition.authority);
    authority = playbackAuthorityFor(
      context.roomId,
      context.epoch,
      playback.revision,
      event.transitionId,
    );
    const request = playbackPrepareRequest(authority, playback);
    preparation = request ? prepareProPlaybackAuthority(request) : null;
  } else {
    authority = playbackAuthorityFor(context.roomId, context.epoch, playback.revision, null);
  }

  if (preparation) {
    const prepared = await preparation;
    if (!playbackCommitStillCurrent(event, generation)) return;
    if (prepared.status !== 'ready') {
      if (activeTransition) clearServerPlaybackTransition(activeTransition);
      const catchup = await catchUpExactPlaybackCheckpoint(
        event,
        receivedAtMs,
        generation,
        context.roomId,
        context.epoch,
      );
      if (!playbackCommitStillCurrent(event, generation) || catchup?.status !== 'applied') return;
      lastAppliedPlaybackRevision = playback.revision;
      void runHeartbeat(true);
      return;
    }
  }

  if (!playbackCommitStillCurrent(event, generation)) return;
  const timing = playbackCommitTiming(event, receivedAtMs);
  let result = await commitProPlaybackAuthority({
    authority,
    committedPlaybackRevision: playback.revision,
    queueItemId: playback.queueItemId,
    state: playback.state,
    positionSeconds: timing.positionSeconds,
    scheduleDelayMs: timing.scheduleDelayMs,
    timingMode: preparedFromMatchingTransition ? timing.timingMode : 'scheduled-control',
    youtubeSubIndex: playback.youtubeSubIndex,
    youtubeVideoId: playback.youtubeVideoId,
    isCurrent: () => playbackCommitStillCurrent(event, generation),
  });
  if (!playbackCommitStillCurrent(event, generation)) return;

  // A direct pause/seek or a canonical transition whose resident media was
  // superseded can reach a freshly resumed endpoint before hydration. Clear
  // the failed transition and catch up from the exact committed checkpoint
  // immediately rather than waiting for the next heartbeat.
  if (result.status !== 'applied' && playback.state !== 'idle' && playback.queueItemId) {
    if (activeTransition) clearServerPlaybackTransition(activeTransition);
    result =
      (await catchUpExactPlaybackCheckpoint(
        event,
        receivedAtMs,
        generation,
        context.roomId,
        context.epoch,
      )) ?? result;
  }

  if (result.status !== 'applied' || !playbackCommitStillCurrent(event, generation)) return;
  lastAppliedPlaybackRevision = playback.revision;
  if (
    activeServerPlaybackTransition?.event.transitionId === event.transitionId ||
    activeServerPlaybackTransition?.authority === authority
  ) {
    activeServerPlaybackTransition.clockAbort.abort();
    activeServerPlaybackTransition = null;
  }
  void runHeartbeat(true);
}

function acceptPlaybackCommit(event: ProRoomPlaybackCommitEvent): void {
  if (event.playback.revision <= lastAppliedPlaybackRevision) return;
  // A lower revision can arrive after a newer WebSocket frame when a heartbeat
  // snapshot and the live channel cross. Reject it before advancing the local
  // generation; otherwise it would cancel the newer COMMIT and then reject
  // itself against highestKnownPlaybackRevision.
  if (event.playback.revision < highestKnownPlaybackRevision) return;
  const existing = playbackCommitInFlight.get(event.playback.revision);
  if (existing) return;
  const receivedAtMs = Date.now();
  highestKnownPlaybackRevision = Math.max(highestKnownPlaybackRevision, event.playback.revision);
  const generation = ++playbackCommitGeneration;
  const operation = playbackCommitTail
    .then(
      () => applyPlaybackCommit(event, receivedAtMs, generation),
      () => applyPlaybackCommit(event, receivedAtMs, generation),
    )
    .finally(() => {
      if (playbackCommitInFlight.get(event.playback.revision) === operation) {
        playbackCommitInFlight.delete(event.playback.revision);
      }
    });
  playbackCommitTail = operation.catch(() => undefined);
  playbackCommitInFlight.set(event.playback.revision, operation);
  void operation.catch((error) => {
    log.warn('[PRO Playback] Canonical COMMIT could not be applied', error);
  });
}

function commandForPlaybackIntent(
  intent: Readonly<ProPlaybackUserIntent>,
  baseRevision: number,
): ProRoomPlaybackCommand {
  if (
    intent.kind === 'play' ||
    intent.kind === 'pause' ||
    intent.kind === 'stop' ||
    intent.kind === 'next' ||
    intent.kind === 'previous'
  ) {
    return { type: intent.kind, baseRevision };
  }
  if (intent.kind === 'advance-sub-video') {
    // The server already owns manifest traversal for `next`. The distinct
    // client intent exists only to preserve the exact observation revision;
    // it deliberately does not add another public Worker command shape.
    return { type: 'next', baseRevision };
  }
  if (intent.kind === 'seek') {
    return { type: 'seek', baseRevision, positionSeconds: intent.positionSeconds };
  }
  if (intent.kind === 'select') {
    const youtubeIdentity = {
      ...(intent.youtubeSubIndex === null ? {} : { youtubeSubIndex: intent.youtubeSubIndex }),
      ...(intent.youtubeVideoId ? { youtubeVideoId: intent.youtubeVideoId } : {}),
    };
    return {
      type: 'select',
      baseRevision,
      queueItemId: intent.queueItemId,
      state: 'playing',
      positionSeconds: intent.positionSeconds,
      ...youtubeIdentity,
    };
  }
  if (intent.kind === 'ended' || intent.kind === 'unavailable') {
    const youtubeIdentity = {
      ...(intent.youtubeSubIndex === null || intent.youtubeSubIndex === undefined
        ? {}
        : { youtubeSubIndex: intent.youtubeSubIndex }),
      ...(intent.youtubeVideoId ? { youtubeVideoId: intent.youtubeVideoId } : {}),
    };
    return {
      type: intent.kind,
      baseRevision,
      queueItemId: intent.queueItemId,
      mediaKind: intent.mediaKind,
      observedPositionSeconds: intent.observedPositionSeconds,
      durationSeconds: intent.durationSeconds,
      ...youtubeIdentity,
    };
  }
  throw new Error('PRO_PLAYBACK_INTENT_UNSUPPORTED');
}

async function submitPlaybackIntent(
  intent: Readonly<ProPlaybackUserIntent>,
  exactBasePlaybackRevision?: number,
): Promise<void> {
  const context = getState('room.context');
  const snapshot = playlistManager?.snapshot ?? controller.snapshot;
  if (
    !active ||
    context.kind !== 'pro' ||
    !context.roomId ||
    context.roomId !== intent.roomId ||
    context.epoch !== intent.roomEpoch ||
    snapshot?.roomCode !== intent.roomId
  ) {
    return;
  }
  const exactRevisionIsCurrent =
    exactBasePlaybackRevision === undefined ||
    (highestKnownPlaybackRevision <= exactBasePlaybackRevision &&
      (intent.kind === 'advance-sub-video'
        ? // COMMIT application precedes the heartbeat that refreshes the
          // playlist snapshot. The local media revision is therefore the
          // exact fence for iframe observations during that short window.
          lastAppliedPlaybackRevision === exactBasePlaybackRevision
        : snapshot.playback.revision === exactBasePlaybackRevision));
  if (!exactRevisionIsCurrent) {
    // Revision-fenced automatic work is intentionally weaker than a human
    // command. Never rebase a delayed media observation over another
    // participant's selection/command.
    await runHeartbeat(true);
    return;
  }
  const baseRevision =
    exactBasePlaybackRevision ?? Math.max(highestKnownPlaybackRevision, snapshot.playback.revision);
  try {
    const result = await api.executePlaybackCommand({
      code: intent.roomId,
      command: commandForPlaybackIntent(intent, baseRevision),
      idempotencyKey: createProRoomIdempotencyKey(),
    });
    highestKnownPlaybackRevision = Math.max(highestKnownPlaybackRevision, result.playback.revision);
    if (result.status === 'preparing' && result.transition) {
      acceptPlaybackPrepare(result.transition);
    } else if (result.status === 'committed') {
      acceptPlaybackCommit({
        type: 'pro-playback-commit',
        transitionId: null,
        serverTimeMs: result.serverTimeMs,
        executeAtMs: result.playback.updatedAtMs,
        playback: result.playback,
      });
    } else if (result.playback.revision > lastAppliedPlaybackRevision) {
      void restorePlaybackCheckpoint(result.playback, intent.roomId, intent.roomEpoch);
    }
  } catch (error) {
    if (
      error instanceof ProRoomApiError &&
      (error.code === 'PLAYBACK_REVISION_CONFLICT' ||
        error.code === 'PLAYBACK_OBSERVATION_STALE' ||
        error.code === 'PLAYBACK_TRANSITION_PENDING')
    ) {
      await runHeartbeat(true);
      return;
    }
    if (isTerminalSessionError(error)) {
      await recoverTerminalSession(error);
      return;
    }
    log.warn('[PRO Playback] Server command failed', error);
  }
}

function enqueueFirstAppendSelection(
  request: Readonly<ProRoomFirstAppendSelectionRequest>,
  lease: PlaylistRuntimeLease,
  signal?: AbortSignal,
): Promise<void> {
  const submit = async () => {
    const context = getState('room.context');
    const snapshot = playlistManager?.snapshot;
    const item = snapshot?.playlist.find(
      (candidate) => candidate.queueItemId === request.queueItemId,
    );
    if (
      signal?.aborted ||
      !active ||
      !isPlaylistLeaseCurrent(lease) ||
      context.kind !== 'pro' ||
      context.roomId !== request.roomCode ||
      context.epoch !== request.coordinatorEpoch ||
      snapshot?.roomCode !== request.roomCode ||
      snapshot.playlist[0]?.queueItemId !== request.queueItemId ||
      snapshot.currentQueueItemId !== null ||
      snapshot.playback.state !== 'idle' ||
      snapshot.playback.queueItemId !== null ||
      snapshot.playback.revision !== request.basePlaybackRevision ||
      !item ||
      (item.source.kind === 'youtube'
        ? item.source.videoId !== request.youtubeVideoId ||
          (item.source.videoIds?.indexOf(item.source.videoId) ?? 0) !== request.youtubeSubIndex
        : request.youtubeVideoId !== null || request.youtubeSubIndex !== null)
    ) {
      return;
    }
    await submitPlaybackIntent(
      {
        kind: 'select',
        roomId: request.roomCode,
        roomEpoch: request.coordinatorEpoch,
        queueItemId: request.queueItemId,
        positionSeconds: 0,
        youtubeVideoId: request.youtubeVideoId,
        youtubeSubIndex: request.youtubeSubIndex,
      },
      request.basePlaybackRevision,
    );
  };
  // A preceding user command failure must not starve a newly committed first
  // row; the exact playback revision fence still prevents selection theft.
  const operation = playbackCommandTail.then(submit, submit);
  playbackCommandTail = operation.catch(() => undefined);
  return operation;
}

/** @internal Exact first-append command seam for coordinator-free regressions. */
export function requestFirstAppendSelectionForTests(
  request: Readonly<ProRoomFirstAppendSelectionRequest>,
  signal?: AbortSignal,
): Promise<void> {
  const lease = playlistRuntimeLease;
  return lease ? enqueueFirstAppendSelection(request, lease, signal) : Promise.resolve();
}

function enqueuePlaybackIntent(intent: Readonly<ProPlaybackUserIntent>): Promise<void> {
  const exactBaseRevision =
    intent.kind === 'ended' || intent.kind === 'unavailable' || intent.kind === 'advance-sub-video'
      ? intent.observedPlaybackRevision
      : undefined;
  const operation = playbackCommandTail.then(
    () => submitPlaybackIntent(intent, exactBaseRevision),
    () => submitPlaybackIntent(intent, exactBaseRevision),
  );
  playbackCommandTail = operation.catch(() => undefined);
  return operation;
}

async function restorePlaybackCheckpoint(
  playback: ProRoomPlaybackCheckpoint,
  roomCode: string,
  roomEpoch: number,
): Promise<void> {
  const context = getState('room.context');
  if (
    context.kind !== 'pro' ||
    context.roomId !== roomCode ||
    context.epoch !== roomEpoch ||
    playback.coordinatorEpoch !== roomEpoch ||
    playback.revision <= lastAppliedPlaybackRevision ||
    playback.revision < highestKnownPlaybackRevision
  ) {
    return;
  }
  if (playback.revision === 0) {
    if (playback.state === 'idle') lastAppliedPlaybackRevision = 0;
    return;
  }
  const transition = activeServerPlaybackTransition;
  if (transition && transition.event.target.revision > playback.revision) return;
  acceptPlaybackCommit({
    type: 'pro-playback-commit',
    transitionId:
      transition?.event.target.revision === playback.revision
        ? transition.event.transitionId
        : `snapshot_${playback.revision}`,
    serverTimeMs: getProRoomServerNow(),
    executeAtMs: playback.updatedAtMs,
    playback,
  });
}

async function restorePersistedPlayback(snapshot: ProRoomSnapshot): Promise<void> {
  const lease = playlistRuntimeLease;
  if (!lease || lease.roomCode !== snapshot.roomCode || !isPlaylistLeaseCurrent(lease)) return;
  highestKnownPlaybackRevision = Math.max(highestKnownPlaybackRevision, snapshot.playback.revision);
  await restorePlaybackCheckpoint(
    snapshot.playback,
    snapshot.roomCode,
    snapshot.presence.coordinatorEpoch,
  );
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
  unregisterPlaybackCommandHandler?.();
  unregisterPlaybackCommandHandler = null;
  if (activeServerPlaybackTransition) {
    activeServerPlaybackTransition.clockAbort.abort();
    cancelProPlaybackPreparation(activeServerPlaybackTransition.authority);
  }
  activeServerPlaybackTransition = null;
  playbackCommitGeneration += 1;
  resetProPlaybackAuthorityHooks();
  heartbeatSingleFlight.reset();
  refreshInFlight = false;
  controlChannelRecoveryAttempt = 0;
  clearManagedTimer(HEARTBEAT_TIMER);
  clearManagedTimer(QUEUE_MODE_CHECKPOINT_DEBOUNCE_TIMER);
}

const observer: ProRoomSessionObserver = {
  snapshot(snapshot) {
    // Runtime entry points accept playlist state transactionally. The observer
    // only refreshes session-scoped adjunct state, avoiding a duplicate async
    // playlist projection of the same snapshot racing that explicit accept.
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
        const localDisplayName = getState('network.myDeviceLabel').trim();
        const snapshot = await controller.heartbeat(
          undefined,
          localDisplayName || controller.snapshot?.viewer?.displayName,
        );
        await acceptPlaylistSnapshot(snapshot);
        if (
          !acceptedEffects ||
          acceptedEffects.roomCode !== snapshot.roomCode ||
          snapshot.effectsRevision > acceptedEffects.revision
        ) {
          await refreshPersistedEffects(snapshot).catch((error) => {
            // Effects are a dedicated rolling-deploy resource. A transient
            // read failure must not tear down presence or media playback.
            log.warn('[PRO] Room effects refresh failed', error);
          });
        }
        if (
          !acceptedQueueMode ||
          acceptedQueueMode.roomCode !== snapshot.roomCode ||
          snapshot.queueModeRevision > acceptedQueueMode.revision ||
          !queueModeMatchesPlaylist(acceptedQueueMode, snapshot)
        ) {
          await refreshPersistedQueueMode(snapshot).catch((error) => {
            log.warn('[PRO] Queue mode refresh failed', error);
          });
        }
        await refreshProSystemAudioState().catch((error) => {
          // The media lease is intentionally independent from presence.
          // A transient state refresh must not tear down a healthy room.
          log.warn('[PRO] System-audio state refresh failed', error);
        });
        void restorePersistedPlayback(snapshot).catch((error) => {
          log.warn('[PRO] Server playback reconciliation failed', error);
          bus.emit('ui:show-toast', t('pro.resume_tap'));
        });
      },
      { forceFollowUp },
    );
  } catch (error) {
    if (isTerminalSessionError(error)) {
      await recoverTerminalSession(error);
    } else {
      // Presence is eventually reconciled by the DO TTL. A transient heartbeat
      // failure must not tear down healthy local media during the ordinary loop.
      log.warn('[PRO] Presence heartbeat failed', error);
    }
    if (propagateFailure) throw error;
  } finally {
    if (isPlaylistLeaseCurrent(lease) && active) {
      setManagedTimer(HEARTBEAT_TIMER, () => void runHeartbeat(), HEARTBEAT_INTERVAL_MS);
    }
  }
}

async function runControlChannelRecovery(): Promise<void> {
  const lease = playlistRuntimeLease;
  if (!active || !lease) return;
  clearManagedTimer(HEARTBEAT_TIMER);
  try {
    await runHeartbeat(true, true);
    // A transition may have started while this socket was offline. Its exact
    // descriptor is carried by the replacement one-use ticket, not by the
    // heartbeat snapshot, so consume it only after the channel is installed.
    const pendingTransition = bridge.consumePendingPlaybackTransition();
    if (pendingTransition) acceptPlaybackPrepare(pendingTransition);
    controlChannelRecoveryAttempt = 0;
  } catch {
    if (!active || !isPlaylistLeaseCurrent(lease)) return;
    const delay =
      CONTROL_CHANNEL_RECOVERY_RETRY_MS[
        Math.min(controlChannelRecoveryAttempt, CONTROL_CHANNEL_RECOVERY_RETRY_MS.length - 1)
      ] ?? HEARTBEAT_INTERVAL_MS;
    controlChannelRecoveryAttempt += 1;
    // Every ticket is a one-use server-control-channel credential. Retry via
    // heartbeat to mint a fresh ticket until this participant's channel is
    // attached again or the authenticated presence expires.
    setManagedTimer(HEARTBEAT_TIMER, () => void runControlChannelRecovery(), delay);
  }
}

function beginControlChannelRecovery(): Promise<void> {
  controlChannelRecoveryAttempt = 0;
  clearManagedTimer(HEARTBEAT_TIMER);
  const transition = activeServerPlaybackTransition;
  if (transition && !playbackCommitInFlight.has(transition.event.target.revision)) {
    // A PREPARE received on a dead channel cannot safely become audible: its
    // COMMIT may have been missed. Cancel it locally and let the replacement
    // ticket either reintroduce the still-pending transition or let the fresh
    // snapshot catch up an already-committed revision.
    transition.clockAbort.abort();
    cancelProPlaybackPreparation(transition.authority);
    if (activeServerPlaybackTransition === transition) activeServerPlaybackTransition = null;
  }
  // The authenticated server channel is known dead even when the room
  // incarnation is unchanged. Force the next accepted heartbeat to rebuild it.
  controller.invalidateControlChannel();
  return runControlChannelRecovery();
}

async function refreshSignalingCredential(): Promise<boolean> {
  const lease = playlistRuntimeLease;
  if (!active || refreshInFlight || !lease) return false;
  // A signaling ticket is a one-use WebSocket handshake credential, not a
  // renewable socket session. Mint one only for a disconnected channel;
  // periodic creation while connected produced unused server-side tickets.
  if (bridge.connected) return true;
  refreshInFlight = true;
  try {
    await controller.refreshSignaling();
    const pendingTransition = bridge.consumePendingPlaybackTransition();
    if (pendingTransition) acceptPlaybackPrepare(pendingTransition);
    return true;
  } catch (error) {
    if (isTerminalSessionError(error)) {
      await recoverTerminalSession(error);
      return false;
    }
    // A disconnected server control channel cannot receive canonical room
    // events. Retry soon with a fresh one-use credential.
    log.warn('[PRO] Signaling credential refresh failed', error);
    return false;
  } finally {
    if (isPlaylistLeaseCurrent(lease)) {
      refreshInFlight = false;
    }
  }
}

function bindVisibilityRefresh(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (!active || document.visibilityState !== 'visible') return;
    clearManagedTimer(HEARTBEAT_TIMER);
    void runHeartbeat();
  });
}

function startLifecycle(): void {
  active = true;
  unregisterPlaybackCommandHandler?.();
  unregisterPlaybackCommandHandler = registerProPlaybackCommandHandler(enqueuePlaybackIntent);
  terminalRecoveryInFlight = false;
  bindVisibilityRefresh();
  clearManagedTimer(HEARTBEAT_TIMER);
  setManagedTimer(HEARTBEAT_TIMER, () => void runHeartbeat(), HEARTBEAT_INTERVAL_MS);
  // Reconcile the authenticated display name immediately so queue notices
  // never stay pinned to the login-time generic "Peer" value.
  void runHeartbeat(true);
}

export function getProRoomBootstrap(code: string, signal?: AbortSignal): Promise<ProRoomBootstrap> {
  return api.getBootstrap(code, signal);
}

/** Submit a BOT request through the already-authenticated tab-local API client. */
export async function requestActiveProRoomBotCommand(
  expectedRoomCode: string,
  prompt: string,
  requestIdOrSignal?: string | AbortSignal,
  maybeSignal?: AbortSignal,
): Promise<ProRoomBotCommandResult> {
  const code = controller.snapshot?.roomCode;
  if (!code || code !== expectedRoomCode) throw new ProRoomApiError('BOT_UNAVAILABLE');
  const lease = controller.captureSessionLease();
  const requestId =
    typeof requestIdOrSignal === 'string' ? requestIdOrSignal : createProRoomIdempotencyKey();
  const signal = typeof requestIdOrSignal === 'string' ? maybeSignal : requestIdOrSignal;
  const result = await api.runBotCommand({ code, prompt, requestId }, signal);
  if (!controller.isSessionLeaseCurrent(lease, code)) {
    throw new ProRoomApiError('BOT_SESSION_SUPERSEDED');
  }
  return result;
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
  const pendingTransition = bridge.consumePendingPlaybackTransition();
  if (pendingTransition) acceptPlaybackPrepare(pendingTransition);
  void refreshProSystemAudioState().catch((error) => {
    log.warn('[PRO] Initial system-audio state refresh failed', error);
  });
  if (!pendingTransition) {
    void restorePersistedPlayback(snapshot).catch((error) => {
      log.warn('[PRO] Persistent playback restore failed', error);
      bus.emit('ui:show-toast', t('pro.resume_tap'));
    });
  }
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
    // report success until a new-incarnation member ticket has rebuilt the
    // server control channel and closed every revoked old-incarnation socket.
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

  // The DO derives the freeze position from its own canonical server-time
  // anchor when the final presence leaves. A browser observation here would
  // reintroduce browser authority and background-tab clock drift.
  const checkpoint = { currentQueueItemId: null, playback: null };
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
  // abort managers, timers, and the server control channel.
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

bus.on('state:playlist.currentQueueItemId', () => {
  cancelSupersededFileDownload(getState('playlist.currentQueueItemId'));
  pruneNonCurrentProRoomFileRows();
});

for (const event of ['state:playlist.repeatMode', 'state:playlist.isShuffle'] as const) {
  bus.on(event, () => scheduleQueueModeCheckpoint());
}
bus.on('playlist:shuffle-order-changed', () => scheduleQueueModeCheckpoint());

bus.on('state:network.myDeviceLabel', () => {
  if (active) void runHeartbeat(true);
});

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

function acceptQueueAddition(frame: ProQueueAdditionFrame): void {
  const context = getState('room.context');
  if (
    context.kind !== 'pro' ||
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
}

bus.on('network:pro-queue-addition', acceptQueueAddition);

onProRoomRealtimeConnection((connected) => {
  if (!active) return;
  if (connected) {
    markProRoomTransportRecovered();
    return;
  }
  requestProRoomTransportRecovery();
});

function acceptProRoomRealtimeFrame(
  frame: ProServerEventEnvelope | ProRealtimeRelayEnvelope,
): void {
  if (!active) return;
  const context = getState('room.context');
  if (
    context.kind !== 'pro' ||
    context.roomId !== frame.roomCode ||
    context.epoch !== frame.coordinatorEpoch
  ) {
    return;
  }

  if (frame.type === 'pro-realtime') {
    receiveProRoomRealtimeChat(frame);
    return;
  }

  const prepareEvent = parseProRoomPlaybackPrepareEvent(frame.event);
  if (prepareEvent) {
    acceptPlaybackPrepare(prepareEvent, Date.now());
    return;
  }
  const commitEvent = parseProRoomPlaybackCommitEvent(frame.event);
  if (commitEvent) {
    acceptPlaybackCommit(commitEvent);
    return;
  }
  const cancelEvent = parseProRoomPlaybackCancelEvent(frame.event);
  if (cancelEvent) {
    acceptPlaybackCancel(cancelEvent.transitionId);
    return;
  }

  const queueAddition = parseProQueueAdditionFrame(frame.event.addition);
  if (queueAddition) acceptQueueAddition(queueAddition);

  if (frame.event.type === 'pro-room-invalidated' || frame.event.type === 'pro-presence-snapshot') {
    void runHeartbeat(true);
    return;
  }
  if (frame.event.type === 'system-audio-invalidated') {
    void refreshProSystemAudioState().catch((error) => {
      log.warn('[PRO] Realtime system-audio refresh failed', error);
    });
  }
}

/** @internal Exact server-channel seam for runtime integration regressions. */
export function acceptProRoomRealtimeFrameForTests(
  frame: ProServerEventEnvelope | ProRealtimeRelayEnvelope,
): void {
  acceptProRoomRealtimeFrame(frame);
}

onProRoomRealtimeEvent(acceptProRoomRealtimeFrame);

bus.on('pro-room:kick-member', (participantId) => {
  const context = getState('room.context');
  if (!active || context.kind !== 'pro' || !context.roomId) return;
  void api
    .kickPresence(context.roomId, participantId)
    .then(async (snapshot) => {
      await acceptPlaylistSnapshot(snapshot);
      reconcileAuthoritativePeers(snapshot);
    })
    .catch((error) => {
      if (isTerminalSessionError(error)) {
        void recoverTerminalSession(error);
        return;
      }
      log.warn('[PRO] Could not remove participant', error);
    });
});

registerProRoomHardCloseHandler(() => hardCloseActiveProRoom());
registerProRoomLeaveHandler(() => leaveActiveProRoom());
registerProRoomSignalingReconnectHandler(() => refreshSignalingCredential());
registerProRoomSignalingEpochAdvanceHandler(() => beginControlChannelRecovery());
