import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { batchSetState, getState, setState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { scheduleDocumentReload, scheduleSessionReset } from '../core/session-reset.ts';
import { t } from '../i18n/index.ts';
import { getAccountSnapshot, getAccountStatsScope, subscribeAccount } from '../account/state.ts';
import { ProRoomAccountReconciler } from './account-reconciliation.ts';
import {
  isProRoomAccountDetachRecoveryTarget,
  proRoomAccountCommitIdentityMatchesSnapshot,
  proRoomAccountIdentityProjectionKey,
  projectProRoomAccountCommitIdentity,
  sameProRoomAccountCommitIdentity,
  type ProRoomAccountCommitIdentity,
} from './account-runtime-identity.ts';
import {
  classifyProAccountIdentityLeaseFailure,
  getProAccountIdentityLeaseRenewDelayMs,
  getProAccountIdentityLeaseRetryDelayMs,
  planProAccountIdentityLease,
  PRO_ACCOUNT_IDENTITY_LEASE_RENEW_INTERVAL_MS,
} from './account-lease-policy.ts';
import { announceTracksAddedLocally } from '../chat/queue-events.ts';
import { announceSystemMessageLocally, receiveProRoomRealtimeChat } from '../chat/protocol.ts';
import { showDialog } from '../ui/dialog.ts';
import { showLoader, updateLoader } from '../ui/toast.ts';
import {
  acceptCanonicalRoomSettings,
  canPublishSynchronizedSettings,
  captureRoomEffectsState,
  captureRoomSettingsSyncState,
  isSettingsSyncEnabled,
} from '../audio/effects.ts';
import {
  roomEffectsEqual,
  type ProRoomSettingsSyncSnapshot,
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
import { resolveYouTubePlaylistManifest } from '../youtube/search.ts';
import { resetRoomContext, setRoomContext } from '../rooms/authority.ts';
import type { PlaylistItem, PlaylistWireItem, QueueItemId, RoomContext } from '../types/index.ts';
import {
  parseProQueueAdditionFrame,
  type ProQueueAdditionFrame,
} from '../network/transport/types.ts';
import {
  publishSignalingExhausted,
  publishSignalingReconnectAttempt,
  SIGNALING_RECOVERY_MAX_ATTEMPTS,
} from '../network/signaling-health.ts';
import { prepareRoomSessionFeatures } from '../network/room-session-feature-loader.ts';
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
  type RecoverProRoomOwnerInput,
  type TransferProRoomOwnerInput,
} from './api.ts';
import type {
  ProRoomAdministrator,
  ProRoomPermissionSet,
  ProRoomPresenceParticipant,
  ProRoomR2Source,
  ProRoomSnapshot,
  ProRoomSystemAudioState,
} from './contracts.ts';
import { queueModeMatchesPlaylist, type ProRoomQueueModeSnapshot } from './queue-mode.ts';
import { rebaseRoomSettingsIntent } from './effects-reconciliation.ts';
import {
  isTransientSettingsSyncFailure,
  SettingsSyncCheckpointState,
  type SettingsSyncCheckpointToken,
} from './settings-sync-retry.ts';
import {
  diffProPresenceMembers,
  projectAuthoritativeProDevices,
  projectProPresenceMembers,
  type ProPresenceMemberProjection,
} from './presence-projection.ts';
import {
  claimLegacyYouTubeManifestCandidates,
  hydrateProRoomYouTubeManifests,
  sameStringArray,
} from './youtube-manifest-policy.ts';
import {
  invalidateProRoomMediaHookSession,
  registerProRoomMediaHooks,
  renewProRoomMediaHookSession,
  type ProRoomMediaHooks,
} from './media-hooks.ts';
import { waitForProRoomPresenceClose } from './hard-close.ts';
import { createProRoomIdempotencyKey } from './idempotency.ts';
import {
  ProRoomPlaybackController,
  type ProRoomPlaybackPlaylistLease,
  type ProRoomPlaybackReconciliationLiveness,
} from './playback-controller.ts';
import {
  registerProRoomHardCloseHandler,
  registerProRoomLeaveHandler,
  registerProRoomSignalingEpochAdvanceHandler,
  registerProRoomSignalingReconnectHandler,
} from './lifecycle-hook.ts';
import { ProRoomHeartbeatSingleFlight } from './heartbeat-single-flight.ts';
import { ProRoomMediaTransfer } from './media-transfer.ts';
import {
  onProRoomRealtimeConnection,
  onProRoomRealtimeEvent,
  proRoomServerBridge,
  type ProRealtimeRelayEnvelope,
  type ProServerEventEnvelope,
} from './network-bridge.ts';
import {
  cloneProRoomAdministrators,
  reconcileProRoomAdministratorDirectory,
} from './administrator-directory.ts';
import { completeProRoomPinRotation } from './pin-rotation.ts';
import { ProRoomPlaylistProjection } from './playlist-projection.ts';
import {
  ProRoomPlaylistStateManager,
  type ProRoomFirstAppendSelectionRequest,
} from './playlist-state-manager.ts';
import { ProRoomUploadQueue, setActiveProRoomUploadQueue } from './upload-queue.ts';
import { resolveProRoomUploadFailureDialog } from './upload-failure-dialog.ts';
import {
  findRemovedProRoomQueueItemIds,
  resolveProRoomRemovalTransition,
} from './playlist-transition.ts';
import { ProRoomSessionController, type ProRoomSessionObserver } from './session-controller.ts';
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
const SYSTEM_AUDIO_SAFETY_REFRESH_INTERVAL_MS = 60_000;
const SYSTEM_AUDIO_REFRESH_RETRY_MS = 15_000;
const SYSTEM_AUDIO_EXPIRY_RECHECK_GRACE_MS = 1_000;
const SYSTEM_AUDIO_SAFETY_REFRESH_TIMER = 'pro-room-system-audio-safety-refresh';
const VISIBILITY_PLAYBACK_RECOVERY_RETRY_MS = [1_000, 3_000, 10_000, 15_000] as const;
const VISIBILITY_PLAYBACK_RECOVERY_TIMER = 'pro-room-visibility-playback-recovery';
const CONTROL_CHANNEL_RECOVERY_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const HEARTBEAT_TIMER = 'pro-room-heartbeat';
const ACCOUNT_IDENTITY_LEASE_TIMER = 'pro-room-account-identity-lease';
const EFFECTS_CHECKPOINT_DEBOUNCE_MS = 350;
const EFFECTS_CHECKPOINT_DEBOUNCE_TIMER = 'pro-room-effects-checkpoint-debounce';
const QUEUE_MODE_CHECKPOINT_DEBOUNCE_MS = 350;
const QUEUE_MODE_CHECKPOINT_DEBOUNCE_TIMER = 'pro-room-queue-mode-checkpoint-debounce';
const QUEUE_MODE_CHECKPOINT_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const QUEUE_ADDITION_FLUSH_TIMER = 'pro-room-queue-addition-flush';
const QUEUE_ADDITION_REORDER_WINDOW_MS = 100;
const EXPLICIT_LEAVE_CLOSE_TIMEOUT_MS = 1_200;
const api = new ProRoomApiClient();
configureProSystemAudioService(api);
const bridge = proRoomServerBridge;

function observeProRoomRuntimeTask(operation: Promise<unknown>, context: string): void {
  operation.catch((error) => {
    log.warn(`[PRO] ${context} escaped its operation boundary`, error);
  });
}

let active = false;
let refreshInFlight = false;
let visibilityBound = false;
let visibilityPlaybackRecoveryPending = false;
let visibilityPlaybackRecoveryAttempt = 0;
let playlistManager: ProRoomPlaylistStateManager | null = null;
let playlistProjection: ProRoomPlaylistProjection | null = null;
let mediaTransfer: ProRoomMediaTransfer | null = null;
let playlistRoomCode: string | null = null;
let playlistSignature = '';
let playlistRuntimeAbort: AbortController | null = null;
type PlaylistRuntimeLease = ProRoomPlaybackPlaylistLease;
interface PersistedStateRefreshFlight {
  generation: number;
  roomCode: string;
  pendingSnapshot: ProRoomSnapshot | null;
  promise: Promise<boolean>;
}
let playlistRuntimeGeneration = 0;
let playlistRuntimeLease: PlaylistRuntimeLease | null = null;
let effectsMutationTail: Promise<void> = Promise.resolve();
let effectsRefreshInFlight: PersistedStateRefreshFlight | null = null;
let acceptedEffects: ProRoomSettingsSyncSnapshot | null = null;
let suppressEffectsCheckpoint = false;
let effectsSessionBaseline: ReturnType<typeof captureRoomSettingsSyncState> | null = null;
const effectsCheckpointState = new SettingsSyncCheckpointState();
let queueModeMutationTail: Promise<void> = Promise.resolve();
let queueModeRefreshInFlight: PersistedStateRefreshFlight | null = null;
let acceptedQueueMode: ProRoomQueueModeSnapshot | null = null;
let suppressQueueModeCheckpoint = false;
let queueModeCheckpointDirty = false;
let queueModeCheckpointRetryAttempt = 0;
let terminalRecoveryInFlight = false;
let controlChannelRecoveryAttempt = 0;
let accountAuthorityFailClosed = false;
let accountLeaseRenewalOwner: symbol | null = null;
let accountIdentityLeaseExpiresAtMs: number | null = null;
let accountIdentityLeaseRetryAttempt = 0;
/** Invalidates lease responses issued for an older App-account projection. */
let accountIdentityGeneration = 0;
let accountMediaHookRenewal: ReturnType<typeof invalidateProRoomMediaHookSession> = null;
let accountMediaHookRecovery: {
  renewal: NonNullable<ReturnType<typeof invalidateProRoomMediaHookSession>>;
  identityGeneration: number;
  sessionLease: number;
  roomCode: string;
  playlistLease: PlaylistRuntimeLease;
} | null = null;
let acceptedAccountIdentityProjectionKey = proRoomAccountIdentityProjectionKey(
  getAccountSnapshot(),
  getAccountStatsScope(),
);
let systemAudioSafetyRefreshAtMs = 0;
const heartbeatSingleFlight = new ProRoomHeartbeatSingleFlight();
const playlistProjectionListeners = new Set<() => void>();
let acceptedProPresence:
  | (ProPresenceMemberProjection & {
      roomCode: string;
      revision: number;
    })
  | null = null;
let acceptedProAdministrators: ProRoomAdministrator[] = [];
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
let proRoomUploadQueue: ProRoomUploadQueue | null = null;
let transferLoaderSequence = 0;
const activeTransferLoaderIds = new Set<string>();
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

function renewAccountMediaHooksIfCurrent(
  renewal: ReturnType<typeof invalidateProRoomMediaHookSession>,
  identityGeneration: number,
  sessionLease: number,
  playlistLease: PlaylistRuntimeLease | null,
  expectedIdentity: ProRoomAccountCommitIdentity,
): boolean {
  if (
    !renewal ||
    accountMediaHookRenewal !== renewal ||
    identityGeneration !== accountIdentityGeneration ||
    !active ||
    !controller.isSessionLeaseCurrent(sessionLease, expectedIdentity.roomCode) ||
    !playlistLease ||
    playlistRuntimeLease !== playlistLease ||
    !isPlaylistLeaseCurrent(playlistLease) ||
    !isAccountMediaHookCommitIdentityCurrent(expectedIdentity)
  ) {
    return false;
  }
  const renewed = renewProRoomMediaHookSession(renewal);
  if (accountMediaHookRecovery?.renewal === renewal) accountMediaHookRecovery = null;
  if (accountMediaHookRenewal === renewal) accountMediaHookRenewal = null;
  return renewed;
}

function isAccountMediaHookCommitIdentityCurrent(expected: ProRoomAccountCommitIdentity): boolean {
  return proRoomAccountCommitIdentityMatchesSnapshot(expected, controller.snapshot);
}

function recoverAccountMediaHooksFromCanonicalSnapshot(snapshot: ProRoomSnapshot): void {
  const recovery = accountMediaHookRecovery;
  if (!recovery) return;
  if (
    recovery.renewal !== accountMediaHookRenewal ||
    recovery.identityGeneration !== accountIdentityGeneration ||
    snapshot.roomCode !== recovery.roomCode
  ) {
    if (accountMediaHookRecovery === recovery) accountMediaHookRecovery = null;
    return;
  }
  const viewer = snapshot.viewer;
  const account = getAccountSnapshot();
  // Public PRO snapshots intentionally omit accountId. An authenticated
  // heartbeat therefore cannot distinguish old account A from a same-nickname
  // successor B after an uncertain attach; only an explicit attach retry may
  // renew that transition. A still-current definitive detach target plus a
  // signed anonymous viewer is sufficient proof for a lost detach response.
  // This includes an incomplete successor account shedding old account A
  // before onboarding; it is not evidence that successor B was attached.
  if (
    !isProRoomAccountDetachRecoveryTarget(account) ||
    !viewer ||
    viewer.isAuthenticated === true
  ) {
    return;
  }
  const renewed = renewAccountMediaHooksIfCurrent(
    recovery.renewal,
    recovery.identityGeneration,
    recovery.sessionLease,
    recovery.playlistLease,
    projectProRoomAccountCommitIdentity(snapshot)!,
  );
  if (!renewed) return;
  // The reconciler failed before it could invoke acceptAnonymous(), so the
  // heartbeat observer projected this signed anonymous snapshot through the
  // still-latched fail-closed filter. Restore its legitimate anonymous (and
  // potentially one-shot delegated) capabilities only after the same exact
  // transaction has renewed successfully.
  accountAuthorityFailClosed = false;
  const context = controller.context;
  if (active && context) applyAuthority(context);
}

function projectedSignature(snapshot: ProRoomSnapshot): string {
  return JSON.stringify([snapshot.playlist, snapshot.currentQueueItemId]);
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
        : code === 'ROOM_STATE_CAPACITY_EXCEEDED'
          ? t('playlist.mutation_retry')
          : code === 'PLAYLIST_CAPACITY_EXCEEDED' ||
              code === 'PRO_ROOM_PLAYLIST_LIMIT_REACHED' ||
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

function reconcileAuthoritativePresenceMessages(
  snapshot: ProRoomSnapshot,
  participants: readonly ProRoomPresenceParticipant[],
): void {
  const current = projectProPresenceMembers(participants);
  const previous = acceptedProPresence;

  // The first authenticated snapshot is a baseline, not a burst of historical
  // "joined" messages. A new room also starts from a clean baseline.
  if (!previous || previous.roomCode !== snapshot.roomCode) {
    acceptedProPresence = {
      roomCode: snapshot.roomCode,
      revision: snapshot.presence.revision,
      members: current.members,
      participantMemberKeys: current.participantMemberKeys,
    };
    return;
  }

  // SessionController already rejects stale snapshots. Keep a local fence too
  // because presence messages are user-visible and must never be duplicated by
  // repeated invalidations carrying the same authoritative revision.
  if (snapshot.presence.revision <= previous.revision) return;

  if (active) {
    const delta = diffProPresenceMembers(previous, current);
    for (const member of delta.joined) {
      announceSystemMessageLocally('chat.peer_connected', {
        name: member.displayName,
      });
    }
    for (const member of delta.departed) {
      announceSystemMessageLocally('chat.peer_disconnected', {
        name: member.displayName,
      });
    }
  }

  acceptedProPresence = {
    roomCode: snapshot.roomCode,
    revision: snapshot.presence.revision,
    members: current.members,
    participantMemberKeys: current.participantMemberKeys,
  };
}

function reconcileAuthoritativePeers(snapshot: ProRoomSnapshot): void {
  const { participants, list, ownIndex, ownParticipant } = projectAuthoritativeProDevices(snapshot);
  reconcileAuthoritativePresenceMessages(snapshot, participants);
  batchSetState({
    'network.connectedPeers': [],
    'network.lastKnownDeviceList': list,
    'network.peerLabels': Object.fromEntries(
      participants.map((participant) => [participant.participantId, participant.displayName]),
    ),
    // Apply the server-owned identity in the same synchronous projection as
    // the member directory. Account attach/detach is the only path that
    // changes a live participant's display identity.
    'network.myDeviceLabel':
      snapshot.viewer?.displayName ||
      ownParticipant?.displayName ||
      getState('network.myDeviceLabel') ||
      'Peer',
    'network.myJoinOrder': ownParticipant?.memberDisplayNumber ?? (ownIndex >= 0 ? ownIndex : 0),
    'network.myMemberId': snapshot.viewer?.memberId ?? ownParticipant?.memberId ?? null,
    'network.myMemberDisplayNumber':
      snapshot.viewer?.memberDisplayNumber ?? ownParticipant?.memberDisplayNumber ?? null,
    'network.myMemberAuthenticated':
      snapshot.viewer?.isAuthenticated === true || ownParticipant?.isAuthenticated === true,
  });
  bus.emit('network:device-list-update', list);
}

function publishProRoomAdministratorDirectory(
  administrators: readonly ProRoomAdministrator[],
): ProRoomAdministrator[] {
  const reconciliation = reconcileProRoomAdministratorDirectory(
    acceptedProAdministrators,
    administrators,
  );
  if (!reconciliation.changed) return reconciliation.projection;
  acceptedProAdministrators = reconciliation.accepted;
  bus.emit('pro-room:administrators-updated', reconciliation.projection);
  return reconciliation.projection;
}

function publishProRoomAdministrators(snapshot: ProRoomSnapshot): void {
  const administrators =
    snapshot.authorityVersion === 1 && snapshot.administrators ? snapshot.administrators : [];
  publishProRoomAdministratorDirectory(administrators);
}

function installMediaHooks(
  manager: ProRoomPlaylistStateManager,
  lease: PlaylistRuntimeLease,
): void {
  const reportCurrentPlaylistError = (error: unknown) => {
    if (isPlaylistLeaseCurrent(lease)) reportPlaylistError(error);
  };
  const uploadBatchLoaderIds = new Map<string, string>();
  const queue = new ProRoomUploadQueue({
    signal: playlistRuntimeAbort?.signal,
    run: async ({ id, file }, context) => {
      if (!isPlaylistLeaseCurrent(lease)) return;
      const progressText = t('pro.upload.batch_progress', {
        current: context.current,
        total: context.total,
      });
      let loaderId = uploadBatchLoaderIds.get(context.batchId);
      if (!loaderId) {
        loaderId = openTransferLoader('upload', progressText);
        uploadBatchLoaderIds.set(context.batchId, loaderId);
      } else {
        showLoader(true, progressText, loaderId);
      }
      reportTransferProgress(loaderId, (context.current - 1) / context.total);
      await manager.addLocalFile(
        {
          queueItemId: id,
          file,
          onProgress: (fraction) => {
            context.onProgress(fraction);
            reportTransferProgress(
              loaderId,
              (context.current - 1 + Math.max(0, Math.min(1, fraction))) / context.total,
            );
          },
        },
        {
          signal: context.signal,
          refreshBeforeUpload: context.isRetry,
        },
      );
    },
    reportFailure(error) {
      if (isPlaylistLeaseCurrent(lease)) {
        log.warn('[PRO] Persistent local upload failed', error);
      }
    },
    onBatchSettled(result) {
      const loaderId = uploadBatchLoaderIds.get(result.batchId);
      if (loaderId) {
        uploadBatchLoaderIds.delete(result.batchId);
        closeTransferLoader(loaderId, result.failedCount === 0 && result.cancelledCount === 0);
      }
      if (result.failedCount === 0) return;
      if (!isPlaylistLeaseCurrent(lease)) {
        queue.dismissFailedBatch(result.batchId);
        return;
      }
      observeProRoomRuntimeTask(
        resolveProRoomUploadFailureDialog({
          queue,
          batchId: result.batchId,
          show: () =>
            showDialog({
              title: t('pro.upload.batch_failed_title'),
              message: t('pro.upload.batch_failed_message', {
                total: result.requestedCount,
                failed: result.failedCount,
              }),
              buttonText: t('common.retry'),
              secondaryText: t('common.close'),
              defaultFocus: 'secondary',
              dismissible: true,
            }),
          isCurrent: () => isPlaylistLeaseCurrent(lease),
          reportPresentationFailure: (error) =>
            log.warn('[PRO] Upload failure dialog could not be presented', error),
        }),
        'upload failure dialog',
      );
    },
  });
  proRoomUploadQueue = queue;
  setActiveProRoomUploadQueue(queue);
  const hooks: ProRoomMediaHooks = {
    addFiles(files, rejectedCount) {
      if (!isPlaylistLeaseCurrent(lease)) return true;
      if (files.length === 0) return true;
      if (rejectedCount > 0) {
        bus.emit('ui:show-toast', t('toast.unsupported_files_excluded', { count: rejectedCount }));
      }
      queue.enqueueFiles(files);
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
  accountMediaHookRenewal = null;
  accountMediaHookRecovery = null;
  registerProRoomMediaHooks(hooks);
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
  setActiveProRoomUploadQueue(null);
  proRoomUploadQueue?.reset();
  proRoomUploadQueue = null;
  closeAllTransferLoaders();
  youtubeManifestUpgradeTail = Promise.resolve();
  attemptedYouTubeManifestUpgrades.clear();
  accountMediaHookRenewal = null;
  accountMediaHookRecovery = null;
  registerProRoomMediaHooks(null);
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
  effectsMutationTail = Promise.resolve();
  effectsRefreshInFlight = null;
  acceptedEffects = null;
  suppressEffectsCheckpoint = false;
  effectsSessionBaseline = null;
  effectsCheckpointState.cancel();
  clearManagedTimer(EFFECTS_CHECKPOINT_DEBOUNCE_TIMER);
  queueModeMutationTail = Promise.resolve();
  queueModeRefreshInFlight = null;
  acceptedQueueMode = null;
  suppressQueueModeCheckpoint = false;
  queueModeCheckpointDirty = false;
  queueModeCheckpointRetryAttempt = 0;
  clearManagedTimer(QUEUE_MODE_CHECKPOINT_DEBOUNCE_TIMER);
  playbackController.resetPlaylistRuntime();
}

function ensurePlaylistManager(snapshot: ProRoomSnapshot): ProRoomPlaylistStateManager {
  if (playlistManager && playlistRoomCode === snapshot.roomCode) return playlistManager;
  resetPlaylistRuntime();
  // This is the pre-hydration device baseline. If the initial GET fails and
  // the user edits a control, only the delta from this baseline is rebased
  // onto canonical state; untouched local defaults never overwrite the room.
  effectsSessionBaseline = captureRoomSettingsSyncState();
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
      playbackController.requestFirstAppendSelection(request, signal, lease),
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
  installMediaHooks(manager, lease);
  return manager;
}

async function acceptPlaylistSnapshot(snapshot: ProRoomSnapshot): Promise<void> {
  const manager = ensurePlaylistManager(snapshot);
  const lease = playlistRuntimeLease;
  if (!lease) return;
  await manager.acceptSnapshot(snapshot);
  if (!isPlaylistLeaseCurrent(lease)) return;
  publishProRoomAdministrators(snapshot);
  // Coalesce signaling requests that completed out of order before rendering
  // their rows. The accepted snapshot remains the authority fence.
  scheduleAcceptedQueueAdditionFlush();
  for (const listener of [...playlistProjectionListeners]) listener();
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

function applyCanonicalRoomEffects(effects: RoomEffectsState, masterVolume: number): boolean {
  suppressEffectsCheckpoint = true;
  try {
    // PRO settings state is server-fanned-out. Applying it locally must never
    // create a second browser-originated broadcast path.
    return acceptCanonicalRoomSettings(effects, masterVolume);
  } finally {
    suppressEffectsCheckpoint = false;
  }
}

function cancelEffectsCheckpoint(): void {
  clearManagedTimer(EFFECTS_CHECKPOINT_DEBOUNCE_TIMER);
  effectsCheckpointState.cancel();
}

function isCurrentEffectsCheckpointToken(token: SettingsSyncCheckpointToken): boolean {
  return effectsCheckpointState.dirty && token.revision === effectsCheckpointState.revision;
}

/**
 * Cancel only the attempt that still owns the current local intent. An older
 * request may settle after a newer audio edit has already installed its own
 * dirty revision and debounce timer; that stale result must be a no-op.
 */
function cancelCurrentEffectsCheckpoint(token: SettingsSyncCheckpointToken): boolean {
  if (!isCurrentEffectsCheckpointToken(token)) return false;
  cancelEffectsCheckpoint();
  return true;
}

function hasEffectsCheckpointAuthority(lease: PlaylistRuntimeLease | null): boolean {
  return !!(
    active &&
    lease &&
    isPlaylistLeaseCurrent(lease) &&
    isSettingsSyncEnabled() &&
    canPublishSynchronizedSettings()
  );
}

function armEffectsCheckpoint(delayMs: number, lease = playlistRuntimeLease): void {
  if (!hasEffectsCheckpointAuthority(lease) || !lease || !effectsCheckpointState.dirty) {
    cancelEffectsCheckpoint();
    return;
  }
  const generation = lease.generation;
  const roomCode = lease.roomCode;
  setManagedTimer(
    EFFECTS_CHECKPOINT_DEBOUNCE_TIMER,
    () => {
      const currentLease = playlistRuntimeLease;
      if (
        !currentLease ||
        currentLease.generation !== generation ||
        currentLease.roomCode !== roomCode ||
        !hasEffectsCheckpointAuthority(currentLease)
      ) {
        cancelEffectsCheckpoint();
        return;
      }
      return persistRoomEffects();
    },
    delayMs,
  );
}

function scheduleEffectsCheckpointRetry(
  token: SettingsSyncCheckpointToken,
  error: unknown,
  lease: PlaylistRuntimeLease,
): void {
  if (!hasEffectsCheckpointAuthority(lease)) {
    cancelEffectsCheckpoint();
    return;
  }
  // A newer edit already installed its own debounce timer and reset backoff.
  if (token.revision !== effectsCheckpointState.revision) return;
  const retryAfterMs =
    error instanceof ProRoomApiError && error.retryAfterSeconds !== null
      ? error.retryAfterSeconds * 1_000
      : 0;
  const delay = effectsCheckpointState.nextRetryDelay(token, retryAfterMs);
  if (delay === null) return;
  armEffectsCheckpoint(delay, lease);
}

function reconcileEffectsCheckpointEpoch(
  token: SettingsSyncCheckpointToken,
  error: ProRoomApiError,
  lease: PlaylistRuntimeLease,
): void {
  void runHeartbeat(true, true)
    .then(() => {
      if (!hasEffectsCheckpointAuthority(lease)) {
        cancelEffectsCheckpoint();
        return;
      }
      // The heartbeat repaired room authority for the runtime, but this
      // request no longer owns retry scheduling when a newer edit exists.
      if (!isCurrentEffectsCheckpointToken(token)) return;
      armEffectsCheckpoint(EFFECTS_CHECKPOINT_DEBOUNCE_MS, lease);
    })
    .catch((heartbeatError) => {
      if (hasEffectsCheckpointAuthority(lease)) {
        scheduleEffectsCheckpointRetry(token, heartbeatError, lease);
      } else {
        cancelEffectsCheckpoint();
      }
      log.warn('[PRO] Settings checkpoint epoch reconciliation failed', error);
    });
}

function rebaseEffectsCheckpointIntent(
  previousBase: ProRoomSettingsSyncSnapshot | null,
  desiredBeforeRead: RoomEffectsState,
  desiredVolumeBeforeRead: number,
  canonical: ProRoomSettingsSyncSnapshot,
  latestLocal: RoomEffectsState,
  latestLocalVolume: number,
  forceFullPublish: boolean,
): { effects: RoomEffectsState; masterVolume: number } {
  const attributableBase = previousBase ?? effectsSessionBaseline;
  const rebased = rebaseRoomSettingsIntent(
    attributableBase,
    { effects: desiredBeforeRead, masterVolume: desiredVolumeBeforeRead },
    canonical,
    forceFullPublish,
  );
  return rebaseRoomSettingsIntent(
    { effects: desiredBeforeRead, masterVolume: desiredVolumeBeforeRead },
    { effects: latestLocal, masterVolume: latestLocalVolume },
    rebased,
  );
}

async function persistRoomEffects(): Promise<void> {
  const lease = playlistRuntimeLease;
  if (!hasEffectsCheckpointAuthority(lease) || !lease || suppressEffectsCheckpoint) {
    cancelEffectsCheckpoint();
    return;
  }
  const token = effectsCheckpointState.begin();
  if (!token) return;
  await enqueueEffectsMutation(async () => {
    const snapshot = effectsRuntimeSnapshot();
    if (
      !hasEffectsCheckpointAuthority(lease) ||
      suppressEffectsCheckpoint ||
      snapshot?.roomCode !== lease.roomCode
    ) {
      cancelEffectsCheckpoint();
      return;
    }
    let desired = captureRoomEffectsState();
    let desiredVolume = getState('audio.masterVolume');
    const forceFullPublish = token.fullPublishIntent !== 0;
    let base = acceptedEffects?.roomCode === snapshot.roomCode ? acceptedEffects : null;
    try {
      if (!base || snapshot.effectsRevision > base.revision) {
        const previousBase = base;
        const desiredBeforeRead = desired;
        const desiredVolumeBeforeRead = desiredVolume;
        const canonical = await api.getSettingsSync(
          snapshot.roomCode,
          playlistRuntimeAbort?.signal,
        );
        if (!hasEffectsCheckpointAuthority(lease)) {
          cancelEffectsCheckpoint();
          return;
        }
        const latestLocal = captureRoomEffectsState();
        const latestLocalVolume = getState('audio.masterVolume');
        const rebased = rebaseEffectsCheckpointIntent(
          previousBase,
          desiredBeforeRead,
          desiredVolumeBeforeRead,
          canonical,
          latestLocal,
          latestLocalVolume,
          forceFullPublish,
        );
        desired = rebased.effects;
        desiredVolume = rebased.masterVolume;
        base = canonical;
        acceptedEffects = canonical;
        if (!roomEffectsEqual(latestLocal, desired) || latestLocalVolume !== desiredVolume) {
          applyCanonicalRoomEffects(desired, desiredVolume);
        }
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!hasEffectsCheckpointAuthority(lease)) {
          cancelEffectsCheckpoint();
          return;
        }
        if (roomEffectsEqual(base.effects, desired) && base.masterVolume === desiredVolume) {
          effectsCheckpointState.succeed(token);
          return;
        }
        try {
          const accepted = await api.updateSettingsSync(
            {
              code: snapshot.roomCode,
              coordinatorEpoch: snapshot.presence.coordinatorEpoch,
              baseRevision: base.revision,
              masterVolume: desiredVolume,
              effects: desired,
            },
            playlistRuntimeAbort?.signal,
          );
          if (hasEffectsCheckpointAuthority(lease)) {
            acceptedEffects = accepted;
            effectsCheckpointState.succeed(token);
          } else {
            cancelEffectsCheckpoint();
          }
          return;
        } catch (error) {
          const revisionConflict =
            error instanceof ProRoomApiError && error.code === 'SETTINGS_SYNC_REVISION_CONFLICT';
          const transient = isTransientSettingsSyncFailure(error);
          if (!revisionConflict && !transient) {
            if (error instanceof ProRoomApiError && error.code === 'ROOM_EPOCH_MISMATCH') {
              reconcileEffectsCheckpointEpoch(token, error, lease);
              return;
            }
            if (!cancelCurrentEffectsCheckpoint(token)) return;
            throw error;
          }
          if (revisionConflict && attempt !== 0) {
            scheduleEffectsCheckpointRetry(token, error, lease);
            return;
          }

          const previousBase = base;
          const desiredBeforeRead = desired;
          const desiredVolumeBeforeRead = desiredVolume;
          let canonical: ProRoomSettingsSyncSnapshot;
          try {
            // A transient PUT may have committed before its response was lost.
            // Read canonical first; only retry if local intent is still absent.
            canonical = await api.getSettingsSync(snapshot.roomCode, playlistRuntimeAbort?.signal);
          } catch (reconcileError) {
            if (transient && isTransientSettingsSyncFailure(reconcileError)) {
              scheduleEffectsCheckpointRetry(token, error, lease);
              return;
            }
            if (!cancelCurrentEffectsCheckpoint(token)) return;
            throw reconcileError;
          }
          if (!hasEffectsCheckpointAuthority(lease)) {
            cancelEffectsCheckpoint();
            return;
          }
          const latestLocal = captureRoomEffectsState();
          const latestLocalVolume = getState('audio.masterVolume');
          const rebased = rebaseEffectsCheckpointIntent(
            previousBase,
            desiredBeforeRead,
            desiredVolumeBeforeRead,
            canonical,
            latestLocal,
            latestLocalVolume,
            forceFullPublish,
          );
          desired = rebased.effects;
          desiredVolume = rebased.masterVolume;
          base = canonical;
          acceptedEffects = canonical;
          if (!roomEffectsEqual(latestLocal, desired) || latestLocalVolume !== desiredVolume) {
            applyCanonicalRoomEffects(desired, desiredVolume);
          }
          if (transient) {
            if (roomEffectsEqual(base.effects, desired) && base.masterVolume === desiredVolume) {
              effectsCheckpointState.succeed(token);
            } else {
              scheduleEffectsCheckpointRetry(token, error, lease);
            }
            return;
          }
          // A true CAS conflict gets one immediate retry against the accepted
          // canonical revision; repeated conflict is terminal for this pass.
        }
      }
    } catch (error) {
      if (!hasEffectsCheckpointAuthority(lease)) {
        // Actual authority/room-lease loss invalidates every pending intent.
        cancelEffectsCheckpoint();
      } else if (!isCurrentEffectsCheckpointToken(token)) {
        // A newer edit owns dirty state and retry scheduling.
      } else if (isTransientSettingsSyncFailure(error)) {
        scheduleEffectsCheckpointRetry(token, error, lease);
      } else {
        cancelCurrentEffectsCheckpoint(token);
      }
      if (active && isPlaylistLeaseCurrent(lease)) {
        log.warn('[PRO] Room effects checkpoint failed', error);
      }
    }
  });
}

function scheduleEffectsCheckpoint(): void {
  if (suppressEffectsCheckpoint) return;
  const lease = playlistRuntimeLease;
  if (!hasEffectsCheckpointAuthority(lease)) {
    if (effectsCheckpointState.dirty) cancelEffectsCheckpoint();
    return;
  }
  effectsCheckpointState.markDirty();
  armEffectsCheckpoint(EFFECTS_CHECKPOINT_DEBOUNCE_MS, lease);
}

async function refreshPersistedEffectsUnlocked(snapshot: ProRoomSnapshot): Promise<boolean> {
  const lease = playlistRuntimeLease;
  if (!lease || !isPlaylistLeaseCurrent(lease) || lease.roomCode !== snapshot.roomCode)
    return false;
  const previousBase = acceptedEffects?.roomCode === snapshot.roomCode ? acceptedEffects : null;
  const localBeforeRead = captureRoomEffectsState();
  const localVolumeBeforeRead = getState('audio.masterVolume');
  const accepted = await api.getSettingsSync(snapshot.roomCode, playlistRuntimeAbort?.signal);
  const current = effectsRuntimeSnapshot();
  if (!isPlaylistLeaseCurrent(lease) || current?.roomCode !== snapshot.roomCode) return false;
  const latestLocal = captureRoomEffectsState();
  const latestLocalVolume = getState('audio.masterVolume');
  let desired = accepted.effects;
  let desiredVolume = accepted.masterVolume;
  // A controller can have a debounced local edit while an invalidation GET is
  // queued ahead of its checkpoint. Rebase that intent instead of erasing it.
  if (isSettingsSyncEnabled() && canPublishSynchronizedSettings() && effectsCheckpointState.dirty) {
    const rebased = rebaseEffectsCheckpointIntent(
      previousBase,
      localBeforeRead,
      localVolumeBeforeRead,
      accepted,
      latestLocal,
      latestLocalVolume,
      effectsCheckpointState.pendingFullPublishIntent !== 0,
    );
    desired = rebased.effects;
    desiredVolume = rebased.masterVolume;
  }
  acceptedEffects = accepted;
  if (!applyCanonicalRoomEffects(desired, desiredVolume)) return false;
  if (
    isSettingsSyncEnabled() &&
    canPublishSynchronizedSettings() &&
    (!roomEffectsEqual(desired, accepted.effects) || desiredVolume !== accepted.masterVolume)
  ) {
    armEffectsCheckpoint(EFFECTS_CHECKPOINT_DEBOUNCE_MS, lease);
  }
  return true;
}

function effectsRefreshStillRequired(snapshot: ProRoomSnapshot): boolean {
  return (
    !acceptedEffects ||
    acceptedEffects.roomCode !== snapshot.roomCode ||
    snapshot.effectsRevision > acceptedEffects.revision
  );
}

function newerEffectsRefreshSnapshot(
  current: ProRoomSnapshot,
  candidate: ProRoomSnapshot,
): ProRoomSnapshot {
  if (candidate.roomCode !== current.roomCode) return candidate;
  if (candidate.effectsRevision !== current.effectsRevision) {
    return candidate.effectsRevision > current.effectsRevision ? candidate : current;
  }
  return candidate.revision > current.revision ? candidate : current;
}

async function refreshPersistedEffects(snapshot: ProRoomSnapshot): Promise<boolean> {
  const generation = playlistRuntimeGeneration;
  const existing = effectsRefreshInFlight;
  if (existing && existing.generation === generation && existing.roomCode === snapshot.roomCode) {
    existing.pendingSnapshot = existing.pendingSnapshot
      ? newerEffectsRefreshSnapshot(existing.pendingSnapshot, snapshot)
      : snapshot;
    return existing.promise;
  }

  const flight: PersistedStateRefreshFlight = {
    generation,
    roomCode: snapshot.roomCode,
    pendingSnapshot: null,
    promise: Promise.resolve(false),
  };
  flight.promise = (async () => {
    let target = snapshot;
    let applied = false;
    try {
      for (;;) {
        let failure: unknown = null;
        try {
          applied =
            (await enqueueEffectsMutation(() => refreshPersistedEffectsUnlocked(target))) ||
            applied;
        } catch (error) {
          failure = error;
        }

        if (flight.generation !== playlistRuntimeGeneration) {
          if (failure) throw failure;
          return applied;
        }
        const pending = flight.pendingSnapshot;
        flight.pendingSnapshot = null;
        if (
          pending &&
          pending.roomCode === flight.roomCode &&
          effectsRefreshStillRequired(pending)
        ) {
          target = newerEffectsRefreshSnapshot(target, pending);
          continue;
        }
        if (failure) throw failure;
        return applied;
      }
    } finally {
      if (effectsRefreshInFlight === flight) effectsRefreshInFlight = null;
    }
  })();
  effectsRefreshInFlight = flight;
  return flight.promise;
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

function queueModeRefreshStillRequired(snapshot: ProRoomSnapshot): boolean {
  return (
    !acceptedQueueMode ||
    acceptedQueueMode.roomCode !== snapshot.roomCode ||
    snapshot.queueModeRevision > acceptedQueueMode.revision ||
    !queueModeMatchesPlaylist(acceptedQueueMode, snapshot)
  );
}

function newerQueueModeRefreshSnapshot(
  current: ProRoomSnapshot,
  candidate: ProRoomSnapshot,
): ProRoomSnapshot {
  if (candidate.roomCode !== current.roomCode) return candidate;
  if (candidate.queueModeRevision !== current.queueModeRevision) {
    return candidate.queueModeRevision > current.queueModeRevision ? candidate : current;
  }
  if (candidate.playlistRevision !== current.playlistRevision) {
    return candidate.playlistRevision > current.playlistRevision ? candidate : current;
  }
  return candidate.revision > current.revision ? candidate : current;
}

async function refreshPersistedQueueMode(
  snapshot: ProRoomSnapshot,
  options: { broadcast?: boolean } = {},
): Promise<boolean> {
  const generation = playlistRuntimeGeneration;
  const existing = queueModeRefreshInFlight;
  if (existing && existing.generation === generation && existing.roomCode === snapshot.roomCode) {
    existing.pendingSnapshot = existing.pendingSnapshot
      ? newerQueueModeRefreshSnapshot(existing.pendingSnapshot, snapshot)
      : snapshot;
    return existing.promise;
  }

  const flight: PersistedStateRefreshFlight = {
    generation,
    roomCode: snapshot.roomCode,
    pendingSnapshot: null,
    promise: Promise.resolve(false),
  };
  flight.promise = (async () => {
    let target = snapshot;
    let applied = false;
    try {
      for (;;) {
        let failure: unknown = null;
        try {
          applied =
            (await enqueueQueueModeMutation(() =>
              refreshPersistedQueueModeUnlocked(target, options),
            )) || applied;
        } catch (error) {
          failure = error;
        }

        if (flight.generation !== playlistRuntimeGeneration) {
          if (failure) throw failure;
          return applied;
        }
        const pending = flight.pendingSnapshot;
        flight.pendingSnapshot = null;
        if (
          pending &&
          pending.roomCode === flight.roomCode &&
          queueModeRefreshStillRequired(pending)
        ) {
          target = newerQueueModeRefreshSnapshot(target, pending);
          continue;
        }
        if (failure) throw failure;
        return applied;
      }
    } finally {
      if (queueModeRefreshInFlight === flight) queueModeRefreshInFlight = null;
    }
  })();
  queueModeRefreshInFlight = flight;
  return flight.promise;
}

/** @internal Exact first-append command seam for coordinator-free regressions. */
export function requestFirstAppendSelectionForTests(
  request: Readonly<ProRoomFirstAppendSelectionRequest>,
  signal?: AbortSignal,
): Promise<void> {
  return playbackController.requestFirstAppendSelection(request, signal);
}

/**
 * Fetch a fresh canonical PRO checkpoint and align only this participant.
 * No playback command or room revision is created.
 */
export function requestActiveProRoomPlaybackReconciliation(
  options: Readonly<{
    showLoading?: boolean;
    liveness?: ProRoomPlaybackReconciliationLiveness;
  }> = {},
): Promise<boolean> {
  return playbackController.requestReconciliation(options);
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
  const acceptedContext =
    accountAuthorityFailClosed && context.kind === 'pro'
      ? {
          ...context,
          // No account-bound authority may survive a definitive local logout
          // while detachment is in flight. Ordinary PRO members have no
          // implicit control baseline, so fail closed to an empty projection.
          capabilities: [],
        }
      : context;
  setRoomContext(acceptedContext);
  batchSetState({
    'network.sessionCode': acceptedContext.roomId ?? '',
    'network.lastJoinCode': acceptedContext.roomId ?? '',
    // Compatibility flag for legacy controls. Real authorization remains the
    // server-projected capability set in room.context.
    'network.isOperator': acceptedContext.role === 'member',
  });
}

function stopLifecycle(): void {
  active = false;
  visibilityPlaybackRecoveryPending = false;
  visibilityPlaybackRecoveryAttempt = 0;
  playbackController.stopLifecycle();
  accountReconciler.stop();
  accountIdentityGeneration += 1;
  accountAuthorityFailClosed = false;
  accountMediaHookRenewal = null;
  accountMediaHookRecovery = null;
  accountLeaseRenewalOwner = null;
  accountIdentityLeaseExpiresAtMs = null;
  accountIdentityLeaseRetryAttempt = 0;
  systemAudioSafetyRefreshAtMs = 0;
  heartbeatSingleFlight.reset();
  refreshInFlight = false;
  controlChannelRecoveryAttempt = 0;
  clearManagedTimer(HEARTBEAT_TIMER);
  clearManagedTimer(VISIBILITY_PLAYBACK_RECOVERY_TIMER);
  clearManagedTimer(ACCOUNT_IDENTITY_LEASE_TIMER);
  clearManagedTimer(SYSTEM_AUDIO_SAFETY_REFRESH_TIMER);
  clearManagedTimer(QUEUE_MODE_CHECKPOINT_DEBOUNCE_TIMER);
}

const observer: ProRoomSessionObserver = {
  snapshot(snapshot) {
    // Runtime entry points accept playlist state transactionally. The observer
    // only refreshes session-scoped adjunct state, avoiding a duplicate async
    // playlist projection of the same snapshot racing that explicit accept.
    bindProSystemAudioSession(snapshot);
    reconcileAuthoritativePeers(snapshot);
    publishProRoomAdministrators(snapshot);
  },
  authority(context) {
    applyAuthority(context);
  },
  cleared() {
    acceptedProPresence = null;
    acceptedProAdministrators = [];
    bus.emit('pro-room:administrators-updated', []);
    stopLifecycle();
    resetProSystemAudioService();
    resetPlaylistRuntime();
    resetProRoomTransportRecovery();
    resetRoomContext();
  },
};

const controller = new ProRoomSessionController(api, bridge, observer);
const playbackController = new ProRoomPlaybackController({
  isActive: () => active,
  getCanonicalSnapshot: () => playlistManager?.snapshot ?? controller.snapshot,
  getPlaylistSnapshot: () => playlistManager?.snapshot ?? null,
  capturePlaylistLease: () => playlistRuntimeLease,
  isPlaylistLeaseCurrent: (lease) => isPlaylistLeaseCurrent(lease),
  getRoomAbortSignal: () => playlistRuntimeAbort?.signal,
  subscribePlaylistProjection(listener) {
    playlistProjectionListeners.add(listener);
    return () => playlistProjectionListeners.delete(listener);
  },
  runHeartbeat: (force, includePersistedState, playbackIsCurrent) =>
    runHeartbeat(force, includePersistedState, playbackIsCurrent),
  reportPlaybackTransitionReady: (input) => api.reportPlaybackTransitionReady(input),
  executePlaybackCommand: (input, signal) => api.executePlaybackCommand(input, signal),
  recoverTerminalSession: (error) => recoverTerminalSession(error),
});

async function acceptAccountReconciliationSnapshot(
  operation: 'attach' | 'detach',
  signal: AbortSignal,
): Promise<void> {
  let lease = controller.captureSessionLease();
  const identityGeneration = accountIdentityGeneration;
  const playlistLease = playlistRuntimeLease;
  // The App cookie may already name a successor account while the room still
  // projects its predecessor. Keep all account-derived authority closed from
  // the first synchronous edge until one exact final server identity settles.
  accountAuthorityFailClosed = true;
  const initialContext = controller.context;
  if (active && initialContext) applyAuthority(initialContext);
  const renewal = invalidateProRoomMediaHookSession();
  accountMediaHookRecovery = null;
  accountMediaHookRenewal = renewal;
  const finalCommit: { identity: ProRoomAccountCommitIdentity | null } = { identity: null };
  let finalCommitRejected = false;
  const finalCommitIdentity = (committed: ProRoomSnapshot): void => {
    finalCommit.identity = projectProRoomAccountCommitIdentity(committed);
  };
  const acceptCommittedAccountAuthority = (committed: ProRoomSnapshot, isFinalCommit = true) => {
    // Record signed proof only. The awaited channel/playlist acceptance below
    // can still be superseded by a newer canonical identity.
    if (
      signal.aborted ||
      committed.viewer?.isAuthenticated !== true ||
      !controller.isSessionLeaseCurrent(lease, committed.roomCode)
    ) {
      return;
    }
    if (isFinalCommit) finalCommitIdentity(committed);
  };
  const acceptCommittedAnonymousAuthority = (committed: ProRoomSnapshot, isFinalCommit = true) => {
    // Record signed proof only; do not reopen authority while its channel
    // replacement can still be overtaken by a newer authenticated snapshot.
    if (
      signal.aborted ||
      committed.viewer?.isAuthenticated === true ||
      !controller.isSessionLeaseCurrent(lease, committed.roomCode)
    ) {
      return;
    }
    if (isFinalCommit) finalCommitIdentity(committed);
  };
  const recoverMissingDetachedPresence = async (): Promise<ProRoomSnapshot> => {
    // `snapshot:null` proves detachment but says the old presence no longer
    // exists. Keep every account-bound capability revoked while the normal
    // non-takeover enter path establishes a new anonymous incarnation.
    accountAuthorityFailClosed = true;
    const previousContext = controller.context;
    if (active && previousContext) applyAuthority(previousContext);
    const recovered = await controller.reenterAfterDetachedPresence(signal);
    if (recovered.viewer?.isAuthenticated === true) {
      // A recovery path is never authentication evidence. Refuse an
      // unexpected authenticated projection instead of silently restoring
      // the account authority that the server just detached.
      await controller.terminate().catch(() => undefined);
      throw new ProRoomApiError('INVALID_RESPONSE');
    }
    lease = controller.captureSessionLease();
    return recovered;
  };
  let snapshot: ProRoomSnapshot;
  try {
    if (operation === 'attach') {
      try {
        snapshot = await controller.attachCurrentAccount(signal, acceptCommittedAccountAuthority);
      } catch (error) {
        if (!(error instanceof ProRoomApiError) || error.code !== 'SESSION_ACCOUNT_CONFLICT') {
          throw error;
        }
        // A Google callback can replace the global HttpOnly account without an
        // explicit logout in this tab. Public snapshots intentionally do not
        // expose accountId, so atomically shed the old room identity before
        // proving the new one. Persistent grants for both accounts stay server
        // owned; this physical session carries neither across the switch.
        accountAuthorityFailClosed = true;
        const context = controller.context;
        if (active && context) applyAuthority(context);
        let anonymousDetachCommitted = false;
        let detachedSnapshot: ProRoomSnapshot | null | undefined;
        try {
          const detached = await controller.detachCurrentAccount(signal, (committed) => {
            anonymousDetachCommitted = true;
            // This anonymous commit is only an intermediate fence in an
            // account switch. Media hooks remain revoked until the final
            // authenticated account commits and its channel settles.
            acceptCommittedAnonymousAuthority(committed, false);
          });
          anonymousDetachCommitted = true;
          detachedSnapshot = detached.snapshot;
        } catch (detachError) {
          // Once the signed anonymous snapshot is committed, only the optional
          // control-channel replacement can still fail. Continue proving the
          // newly selected account instead of leaving this tab anonymous until
          // the next lease cycle.
          if (!anonymousDetachCommitted) throw detachError;
        }
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (detachedSnapshot === null) {
          await recoverMissingDetachedPresence();
        }
        snapshot = await controller.attachCurrentAccount(signal, acceptCommittedAccountAuthority);
      }
    } else {
      const detached = await controller.detachCurrentAccount(
        signal,
        acceptCommittedAnonymousAuthority,
      );
      snapshot = detached.snapshot ?? (await recoverMissingDetachedPresence());
      if (detached.snapshot === null) acceptCommittedAnonymousAuthority(snapshot);
    }
    const acceptedIdentity = projectProRoomAccountCommitIdentity(snapshot);
    const committedIdentity = finalCommit.identity;
    if (
      signal.aborted ||
      identityGeneration !== accountIdentityGeneration ||
      !controller.isSessionLeaseCurrent(lease, snapshot.roomCode)
    ) {
      return;
    }
    if (
      !acceptedIdentity ||
      !committedIdentity ||
      !sameProRoomAccountCommitIdentity(acceptedIdentity, committedIdentity) ||
      !isAccountMediaHookCommitIdentityCurrent(committedIdentity) ||
      (operation === 'attach' && snapshot.viewer?.isAuthenticated !== true) ||
      (operation === 'detach' && snapshot.viewer?.isAuthenticated === true)
    ) {
      finalCommitRejected = true;
      accountAuthorityFailClosed = true;
      const context = controller.context;
      if (active && context) applyAuthority(context);
      throw new ProRoomApiError('INVALID_RESPONSE');
    }
    await acceptPlaylistSnapshot(snapshot);
    if (
      signal.aborted ||
      identityGeneration !== accountIdentityGeneration ||
      !controller.isSessionLeaseCurrent(lease, snapshot.roomCode) ||
      !isAccountMediaHookCommitIdentityCurrent(committedIdentity)
    ) {
      if (
        !signal.aborted &&
        identityGeneration === accountIdentityGeneration &&
        controller.isSessionLeaseCurrent(lease, snapshot.roomCode)
      ) {
        finalCommitRejected = true;
        throw new ProRoomApiError('INVALID_RESPONSE');
      }
      return;
    }
    refreshHeartbeatAdjunctState(snapshot);
  } finally {
    const committedIdentity = finalCommit.identity;
    if (
      !finalCommitRejected &&
      !signal.aborted &&
      identityGeneration === accountIdentityGeneration &&
      committedIdentity &&
      controller.isSessionLeaseCurrent(lease, committedIdentity.roomCode) &&
      isAccountMediaHookCommitIdentityCurrent(committedIdentity)
    ) {
      accountAuthorityFailClosed = false;
      const context = controller.context;
      if (active && context) applyAuthority(context);
      renewAccountMediaHooksIfCurrent(
        renewal,
        identityGeneration,
        lease,
        playlistLease,
        committedIdentity,
      );
    }
  }
}

function recoverAccountMediaHooksAfterUncertainMutation(operation: 'attach' | 'detach'): void {
  const renewal = accountMediaHookRenewal;
  const snapshot = controller.snapshot;
  const playlistLease = playlistRuntimeLease;
  const account = getAccountSnapshot();
  if (
    operation === 'detach' &&
    isProRoomAccountDetachRecoveryTarget(account) &&
    renewal &&
    snapshot &&
    playlistLease
  ) {
    accountMediaHookRecovery = {
      renewal,
      identityGeneration: accountIdentityGeneration,
      sessionLease: controller.captureSessionLease(),
      roomCode: snapshot.roomCode,
      playlistLease,
    };
  } else {
    accountMediaHookRecovery = null;
  }
  if (renewal) {
    accountIdentityLeaseExpiresAtMs = null;
    accountIdentityLeaseRetryAttempt = 0;
    scheduleAccountIdentityLeaseRenewal();
  }
  // A mutation response can be lost after commit. The accepted canonical
  // heartbeat is the only safe fallback proof for renewing the exact hook
  // handle; ordinary later heartbeats can retry the same fenced recovery.
  observeProRoomRuntimeTask(runHeartbeat(true), 'media-hook recovery heartbeat');
}

const accountReconciler = new ProRoomAccountReconciler({
  isActive: () => active && controller.snapshot !== null,
  viewer: () => controller.snapshot?.viewer ?? null,
  attach: (signal) => acceptAccountReconciliationSnapshot('attach', signal),
  detach: (signal) => acceptAccountReconciliationSnapshot('detach', signal),
  failClosed: () => {
    accountAuthorityFailClosed = true;
    const context = controller.context;
    if (active && context) applyAuthority(context);
  },
  acceptAuthenticated: () => {
    accountAuthorityFailClosed = false;
    const context = controller.context;
    if (active && context) applyAuthority(context);
  },
  acceptAnonymous: () => {
    accountAuthorityFailClosed = false;
    const context = controller.context;
    if (active && context) applyAuthority(context);
  },
  failed: (operation, error) => {
    if (isTerminalSessionError(error)) {
      observeProRoomRuntimeTask(recoverTerminalSession(error), 'terminal account recovery');
      return;
    }
    log.warn(`[PRO] Account identity ${operation} deferred`, error);
    recoverAccountMediaHooksAfterUncertainMutation(operation);
  },
});

onProRoomTabTakeover((roomCode) => {
  if (!active || controller.snapshot?.roomCode !== roomCode) return;
  observeProRoomRuntimeTask(
    recoverTerminalSession(new ProRoomApiError('PRESENCE_SUPERSEDED', 409)),
    'superseded-tab recovery',
  );
});

function isTerminalSessionError(error: unknown): error is ProRoomApiError {
  return (
    error instanceof ProRoomApiError &&
    (error.code === 'SESSION_REQUIRED' ||
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
    scheduleDocumentReload(t('dialog.refreshing_session'));
  }
}

function nextSystemAudioSafetyRefreshAtMs(state: ProRoomSystemAudioState, nowMs: number): number {
  const fallbackAtMs = nowMs + SYSTEM_AUDIO_SAFETY_REFRESH_INTERVAL_MS;
  const expiresAtMs =
    state.status === 'preparing'
      ? state.claimExpiresAt
      : state.status === 'live'
        ? state.liveExpiresAt
        : null;
  // Re-read shortly after a known ownership fence expires so a lost realtime
  // invalidation cannot strand the old owner in this tab. A past timestamp can
  // also be simple client clock skew, so retain the one-minute fallback rather
  // than turning it into a request loop.
  if (expiresAtMs === null || expiresAtMs <= nowMs) return fallbackAtMs;
  return Math.min(fallbackAtMs, expiresAtMs + SYSTEM_AUDIO_EXPIRY_RECHECK_GRACE_MS);
}

async function refreshSystemAudioState(force = false): Promise<void> {
  const lease = playlistRuntimeLease;
  if (!active || !lease) return;
  const startedAtMs = Date.now();
  if (!force && systemAudioSafetyRefreshAtMs > startedAtMs) return;

  // Throttle repeated event/timer callers before entering the service's
  // single-flight. A transient failure gets a bounded 15-second retry; a
  // healthy response installs the longer safety/expiry deadline below.
  clearManagedTimer(SYSTEM_AUDIO_SAFETY_REFRESH_TIMER);
  systemAudioSafetyRefreshAtMs = startedAtMs + SYSTEM_AUDIO_REFRESH_RETRY_MS;
  try {
    const state = await refreshProSystemAudioState(undefined, force);
    if (!active || !isPlaylistLeaseCurrent(lease)) return;
    scheduleSystemAudioSafetyRefresh(nextSystemAudioSafetyRefreshAtMs(state, Date.now()));
  } catch (error) {
    if (active && isPlaylistLeaseCurrent(lease)) {
      scheduleSystemAudioSafetyRefresh(Date.now() + SYSTEM_AUDIO_REFRESH_RETRY_MS);
    }
    throw error;
  }
}

function scheduleSystemAudioSafetyRefresh(refreshAtMs: number): void {
  if (!active) return;
  systemAudioSafetyRefreshAtMs = refreshAtMs;
  clearManagedTimer(SYSTEM_AUDIO_SAFETY_REFRESH_TIMER);
  setManagedTimer(
    SYSTEM_AUDIO_SAFETY_REFRESH_TIMER,
    () => {
      void refreshSystemAudioState().catch((error) => {
        log.warn('[PRO] System-audio safety refresh failed', error);
      });
    },
    Math.max(0, refreshAtMs - Date.now()),
  );
}

function refreshHeartbeatAdjunctState(
  snapshot: ProRoomSnapshot,
  playbackIsCurrent?: () => boolean,
): void {
  if (
    !acceptedEffects ||
    acceptedEffects.roomCode !== snapshot.roomCode ||
    snapshot.effectsRevision > acceptedEffects.revision
  ) {
    void refreshPersistedEffects(snapshot).catch((error) => {
      // Effects are a dedicated rolling-deploy resource. A transient read
      // failure must not tear down presence or media playback.
      log.warn('[PRO] Room effects refresh failed', error);
    });
  }
  if (
    !acceptedQueueMode ||
    acceptedQueueMode.roomCode !== snapshot.roomCode ||
    snapshot.queueModeRevision > acceptedQueueMode.revision ||
    !queueModeMatchesPlaylist(acceptedQueueMode, snapshot)
  ) {
    void refreshPersistedQueueMode(snapshot).catch((error) => {
      log.warn('[PRO] Queue mode refresh failed', error);
    });
  }
  void playbackController.restorePersistedPlayback(snapshot, playbackIsCurrent).catch((error) => {
    log.warn('[PRO] Server playback reconciliation failed', error);
    bus.emit('ui:show-toast', t('pro.resume_tap'));
  });
}

async function runHeartbeat(
  forceFollowUp = false,
  propagateFailure = false,
  playbackIsCurrent?: () => boolean,
): Promise<void> {
  const lease = playlistRuntimeLease;
  if (!active || !lease) return;
  try {
    await heartbeatSingleFlight.run(
      async () => {
        const snapshot = await controller.heartbeat();
        await acceptPlaylistSnapshot(snapshot);
      },
      { forceFollowUp },
    );
    // Keep the heartbeat single-flight critical section limited to the
    // authoritative playlist/presence projection. Every caller consumes the
    // fresh accepted snapshot with its own playback liveness after the shared
    // network flight, so a local recovery cannot lend its owner to another
    // caller (and an ordinary heartbeat remains room-authoritative).
    const snapshot = controller.snapshot;
    if (
      active &&
      snapshot &&
      isPlaylistLeaseCurrent(lease) &&
      snapshot.roomCode === lease.roomCode
    ) {
      recoverAccountMediaHooksFromCanonicalSnapshot(snapshot);
      refreshHeartbeatAdjunctState(snapshot, playbackIsCurrent);
    }
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
      setManagedTimer(HEARTBEAT_TIMER, () => runHeartbeat(), HEARTBEAT_INTERVAL_MS);
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
    if (pendingTransition) playbackController.acceptPrepare(pendingTransition);
    controlChannelRecoveryAttempt = 0;
    if (bridge.connected) markProRoomTransportRecovered();
  } catch {
    if (!active || !isPlaylistLeaseCurrent(lease)) return;
    controlChannelRecoveryAttempt += 1;
    if (controlChannelRecoveryAttempt >= SIGNALING_RECOVERY_MAX_ATTEMPTS) {
      clearManagedTimer(HEARTBEAT_TIMER);
      publishSignalingExhausted(SIGNALING_RECOVERY_MAX_ATTEMPTS);
      return;
    }
    const delay =
      CONTROL_CHANNEL_RECOVERY_RETRY_MS[
        Math.min(controlChannelRecoveryAttempt - 1, CONTROL_CHANNEL_RECOVERY_RETRY_MS.length - 1)
      ] ?? HEARTBEAT_INTERVAL_MS;
    // Every ticket is a one-use server-control-channel credential. Retry via
    // heartbeat to mint a fresh ticket until this participant's channel is
    // attached again, the authenticated presence expires, or the bounded
    // automatic budget is exhausted for an explicit user retry.
    setManagedTimer(
      HEARTBEAT_TIMER,
      () => {
        publishSignalingReconnectAttempt(
          controlChannelRecoveryAttempt + 1,
          SIGNALING_RECOVERY_MAX_ATTEMPTS,
        );
        return runControlChannelRecovery();
      },
      delay,
    );
  }
}

function beginControlChannelRecovery(): Promise<void> {
  controlChannelRecoveryAttempt = 0;
  clearManagedTimer(HEARTBEAT_TIMER);
  playbackController.beginControlChannelRecovery();
  // The authenticated server channel is known dead even when the room
  // incarnation is unchanged. Force the next accepted heartbeat to rebuild it.
  controller.invalidateControlChannel();
  return runControlChannelRecovery();
}

function scheduleAccountIdentityLeaseRenewal(delayMs?: number | null): void {
  if (!active) return;
  clearManagedTimer(ACCOUNT_IDENTITY_LEASE_TIMER);
  const resolvedDelayMs =
    delayMs === undefined
      ? getProAccountIdentityLeaseRenewDelayMs(Date.now(), accountIdentityLeaseExpiresAtMs)
      : delayMs;
  if (resolvedDelayMs === null) return;
  setManagedTimer(ACCOUNT_IDENTITY_LEASE_TIMER, () => renewAccountIdentityLease(), resolvedDelayMs);
}

async function renewAccountIdentityLease(): Promise<void> {
  if (!active || accountLeaseRenewalOwner) return;
  const account = getAccountSnapshot();
  const snapshot = controller.snapshot;
  if (!snapshot) {
    scheduleAccountIdentityLeaseRenewal();
    return;
  }
  if (
    accountMediaHookRenewal &&
    isProRoomAccountDetachRecoveryTarget(account) &&
    snapshot.viewer?.isAuthenticated === true
  ) {
    // A signed authenticated heartbeat cannot prove that a lost detach
    // response committed. Retry the actual detach on this bounded lease pass;
    // the exact media-hook renewal remains fenced until anonymous proof wins.
    accountIdentityLeaseExpiresAtMs = null;
    accountIdentityLeaseRetryAttempt = 0;
    accountReconciler.update(account);
    scheduleAccountIdentityLeaseRenewal();
    return;
  }
  if (
    accountMediaHookRenewal &&
    account.status === 'authenticated' &&
    account.account?.profileComplete === true &&
    !!account.account.nickname
  ) {
    // An authenticated heartbeat cannot prove which HttpOnly App account is
    // attached because the public room projection intentionally omits
    // accountId. Keep hooks fail-closed after an uncertain response and use
    // the bounded lease cadence to issue a real attach request instead.
    accountIdentityLeaseExpiresAtMs = null;
    accountIdentityLeaseRetryAttempt = 0;
    accountReconciler.update(account);
    scheduleAccountIdentityLeaseRenewal();
    return;
  }
  const action = planProAccountIdentityLease(account, snapshot.viewer);
  if (action === 'none') {
    accountIdentityLeaseExpiresAtMs = null;
    accountIdentityLeaseRetryAttempt = 0;
    scheduleAccountIdentityLeaseRenewal();
    return;
  }
  if (action === 'reattach') {
    // A backgrounded document can outlive the server lease. The persistent
    // account member remains in the room, so a normal signed attachment
    // restores this device without touching playback or other participants.
    accountIdentityLeaseExpiresAtMs = null;
    accountIdentityLeaseRetryAttempt = 0;
    accountReconciler.update(account);
    scheduleAccountIdentityLeaseRenewal();
    return;
  }

  const roomCode = snapshot.roomCode;
  const sessionLease = controller.captureSessionLease();
  const identityGeneration = accountIdentityGeneration;
  const renewalOwner = Symbol('account-identity-lease-renewal');
  let nextRenewalDelayMs: number | null | undefined;
  accountLeaseRenewalOwner = renewalOwner;
  try {
    const renewed = await api.renewCurrentAccountLease(roomCode);
    if (
      identityGeneration !== accountIdentityGeneration ||
      !controller.isSessionLeaseCurrent(sessionLease, roomCode)
    ) {
      return;
    }
    accountIdentityLeaseExpiresAtMs = renewed.leaseExpiresAtMs;
    accountIdentityLeaseRetryAttempt = 0;
    nextRenewalDelayMs = getProAccountIdentityLeaseRenewDelayMs(
      Date.now(),
      renewed.leaseExpiresAtMs,
    );
  } catch (error) {
    if (
      identityGeneration !== accountIdentityGeneration ||
      !controller.isSessionLeaseCurrent(sessionLease, roomCode)
    ) {
      return;
    }
    const failure = classifyProAccountIdentityLeaseFailure(error);
    if (failure === 'terminal-room-session' && isTerminalSessionError(error)) {
      await recoverTerminalSession(error);
      return;
    }
    if (failure === 'reattach') {
      accountAuthorityFailClosed = true;
      accountIdentityLeaseExpiresAtMs = null;
      accountIdentityLeaseRetryAttempt = 0;
      const context = controller.context;
      if (active && context) applyAuthority(context);
      accountReconciler.update(account);
      return;
    }
    if (failure === 'revoke-local') {
      // The App account was revoked (possibly by logout-all on another device)
      // or is no longer provable. Stop trusting account-only local controls now;
      // the Worker lease independently removes server authority within its
      // bounded window even if this tab never receives a cross-tab event.
      accountAuthorityFailClosed = true;
      accountIdentityLeaseExpiresAtMs = null;
      accountIdentityLeaseRetryAttempt = 0;
      nextRenewalDelayMs = null;
      const context = controller.context;
      if (active && context) applyAuthority(context);
      return;
    }
    // Preserve the remaining server lease as a short outage grace. Repeated
    // failures cannot extend it and the next heartbeat will accept the
    // server-side anonymous downgrade after expiry.
    log.warn('[PRO] Account identity lease renewal deferred', error);
    const shortRetryDelayMs = getProAccountIdentityLeaseRetryDelayMs(
      accountIdentityLeaseRetryAttempt,
      Date.now(),
      accountIdentityLeaseExpiresAtMs,
    );
    // Once the short retry budget is exhausted, fall back to a quiet recovery
    // cadence. The Worker lease still expires fail-closed; this later pass only
    // notices the anonymous projection and reattaches if App auth recovered.
    nextRenewalDelayMs = shortRetryDelayMs ?? PRO_ACCOUNT_IDENTITY_LEASE_RENEW_INTERVAL_MS;
    accountIdentityLeaseRetryAttempt += 1;
  } finally {
    // stopLifecycle() deliberately clears ownership so a new room incarnation
    // can renew immediately. A late finally from the old request must not
    // release that new flight or schedule a competing timer.
    if (accountLeaseRenewalOwner === renewalOwner) {
      accountLeaseRenewalOwner = null;
      if (controller.isSessionLeaseCurrent(sessionLease, roomCode)) {
        scheduleAccountIdentityLeaseRenewal(nextRenewalDelayMs);
      }
    }
  }
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
    if (pendingTransition) playbackController.acceptPrepare(pendingTransition);
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

function activeSnapshotNeedsYouTubeVisibilityRecovery(): boolean {
  const snapshot = playlistManager?.snapshot ?? controller.snapshot;
  if (!snapshot) return true;
  const playback = snapshot.playback;
  if (playback.state === 'idle' || !playback.queueItemId) return false;
  const item = snapshot.playlist.find(
    (candidate) => candidate.queueItemId === playback.queueItemId,
  );
  // A temporarily missing projection still needs another authoritative pass.
  return !item || item.source.kind === 'youtube';
}

function scheduleVisibilityPlaybackRecoveryRetry(): void {
  if (
    !active ||
    !visibilityPlaybackRecoveryPending ||
    typeof document === 'undefined' ||
    document.visibilityState !== 'visible'
  ) {
    return;
  }
  const delay =
    VISIBILITY_PLAYBACK_RECOVERY_RETRY_MS[
      Math.min(visibilityPlaybackRecoveryAttempt, VISIBILITY_PLAYBACK_RECOVERY_RETRY_MS.length - 1)
    ] ?? HEARTBEAT_INTERVAL_MS;
  visibilityPlaybackRecoveryAttempt += 1;
  clearManagedTimer(VISIBILITY_PLAYBACK_RECOVERY_TIMER);
  setManagedTimer(VISIBILITY_PLAYBACK_RECOVERY_TIMER, () => recoverVisibleProRoomPlayback(), delay);
}

async function recoverVisibleProRoomPlayback(): Promise<void> {
  if (
    !active ||
    !visibilityPlaybackRecoveryPending ||
    typeof document === 'undefined' ||
    document.visibilityState !== 'visible'
  ) {
    return;
  }
  clearManagedTimer(VISIBILITY_PLAYBACK_RECOVERY_TIMER);
  try {
    const reconciled = await playbackController.reconcile({
      showLoading: false,
      youtubeOnly: true,
      rendezvous: false,
    });
    if (!active || document.visibilityState !== 'visible') return;
    if (reconciled || !activeSnapshotNeedsYouTubeVisibilityRecovery()) {
      visibilityPlaybackRecoveryPending = false;
      visibilityPlaybackRecoveryAttempt = 0;
      return;
    }
  } catch (error) {
    log.warn('[PRO Playback] Foreground reconciliation failed', error);
  }
  // Keep the hidden-session repair intent until media actually converges.
  // Retrying on its own timer avoids requiring a second hide/show cycle.
  scheduleVisibilityPlaybackRecoveryRetry();
}

function bindVisibilityRefresh(): void {
  if (visibilityBound || typeof document === 'undefined') return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      if (active) {
        visibilityPlaybackRecoveryPending = true;
        visibilityPlaybackRecoveryAttempt = 0;
        clearManagedTimer(VISIBILITY_PLAYBACK_RECOVERY_TIMER);
      }
      return;
    }
    if (!active) return;
    const recoverPlayback = visibilityPlaybackRecoveryPending;
    clearManagedTimer(HEARTBEAT_TIMER);
    // A hidden WebKit iframe may be locally paused while the exact same server
    // revision keeps advancing. A normal heartbeat intentionally deduplicates
    // that revision, so foreground recovery must explicitly re-apply it.
    if (recoverPlayback) {
      observeProRoomRuntimeTask(recoverVisibleProRoomPlayback(), 'foreground playback recovery');
    } else {
      observeProRoomRuntimeTask(runHeartbeat(), 'foreground heartbeat');
    }
    // WebKit may suspend timeout delivery for a long background interval.
    // Reconcile an overdue safety read immediately on foreground resume while
    // preserving the realtime-first path during normal visible operation.
    if (systemAudioSafetyRefreshAtMs <= Date.now()) {
      void refreshSystemAudioState().catch((error) => {
        log.warn('[PRO] Foreground system-audio safety refresh failed', error);
      });
    }
    clearManagedTimer(ACCOUNT_IDENTITY_LEASE_TIMER);
    observeProRoomRuntimeTask(renewAccountIdentityLease(), 'foreground account lease renewal');
  });
}

function startLifecycle(): void {
  active = true;
  visibilityPlaybackRecoveryPending =
    typeof document !== 'undefined' && document.visibilityState !== 'visible';
  visibilityPlaybackRecoveryAttempt = 0;
  clearManagedTimer(VISIBILITY_PLAYBACK_RECOVERY_TIMER);
  playbackController.startLifecycle();
  terminalRecoveryInFlight = false;
  bindVisibilityRefresh();
  clearManagedTimer(HEARTBEAT_TIMER);
  setManagedTimer(HEARTBEAT_TIMER, () => runHeartbeat(), HEARTBEAT_INTERVAL_MS);
  scheduleAccountIdentityLeaseRenewal();
  // Reconcile the authenticated display name immediately so queue notices
  // never stay pinned to the login-time generic "Peer" value.
  observeProRoomRuntimeTask(runHeartbeat(true), 'initial account-display heartbeat');
  accountReconciler.update(getAccountSnapshot());
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

export function getActiveProRoomAdministrators(): ProRoomAdministrator[] {
  return cloneProRoomAdministrators(acceptedProAdministrators);
}

function requireActiveProRoomAuthorityLease(): { code: string; lease: number } {
  const code = controller.snapshot?.roomCode;
  if (!active || !code) throw new ProRoomApiError('PRO_ROOM_SESSION_INACTIVE');
  return { code, lease: controller.captureSessionLease() };
}

function acceptAdministratorDirectory(
  code: string,
  lease: number,
  administrators: readonly ProRoomAdministrator[],
): ProRoomAdministrator[] {
  if (!controller.isSessionLeaseCurrent(lease, code)) {
    throw new ProRoomApiError('PRO_ROOM_SESSION_SUPERSEDED');
  }
  const projection = publishProRoomAdministratorDirectory(administrators);
  // The directory mutation also changes participant roles/capabilities. A
  // forced heartbeat reconciles those rows without making the committed
  // directory mutation look failed if the follow-up network read is delayed.
  observeProRoomRuntimeTask(runHeartbeat(true), 'administrator-directory heartbeat');
  return projection;
}

export async function updateActiveProRoomAdministrator(
  memberId: string,
  permissions: ProRoomPermissionSet,
  signal?: AbortSignal,
): Promise<ProRoomAdministrator[]> {
  const { code, lease } = requireActiveProRoomAuthorityLease();
  const directory = await api.updateAdministrator(code, memberId, permissions, signal);
  return acceptAdministratorDirectory(code, lease, directory.administrators);
}

export async function revokeActiveProRoomAdministrator(
  memberId: string,
  signal?: AbortSignal,
): Promise<ProRoomAdministrator[]> {
  const { code, lease } = requireActiveProRoomAuthorityLease();
  const directory = await api.revokeAdministrator(code, memberId, signal);
  return acceptAdministratorDirectory(code, lease, directory.administrators);
}

export async function kickActiveProRoomMember(
  memberId: string,
  signal?: AbortSignal,
): Promise<void> {
  const { code, lease } = requireActiveProRoomAuthorityLease();
  const snapshot = await api.kickMember(code, memberId, signal);
  if (!controller.isSessionLeaseCurrent(lease, code)) {
    throw new ProRoomApiError('PRO_ROOM_SESSION_SUPERSEDED');
  }
  await acceptPlaylistSnapshot(snapshot);
  if (!controller.isSessionLeaseCurrent(lease, code)) return;
  reconcileAuthoritativePeers(snapshot);
  publishProRoomAdministrators(snapshot);
}

/** Disconnect exactly one live PRO presence without revoking member authority. */
export async function kickActiveProRoomPresence(
  participantId: string,
  signal?: AbortSignal,
): Promise<void> {
  const { code, lease } = requireActiveProRoomAuthorityLease();
  const snapshot = await api.kickPresence(code, participantId, signal);
  if (!controller.isSessionLeaseCurrent(lease, code)) {
    throw new ProRoomApiError('PRO_ROOM_SESSION_SUPERSEDED');
  }
  await acceptPlaylistSnapshot(snapshot);
  if (!controller.isSessionLeaseCurrent(lease, code)) return;
  reconcileAuthoritativePeers(snapshot);
  publishProRoomAdministrators(snapshot);
}

async function finalizeOpenedRoom(snapshot: ProRoomSnapshot): Promise<ProRoomSnapshot> {
  try {
    await acceptPlaylistSnapshot(snapshot);
  } catch (error) {
    await controller.leave().catch(() => undefined);
    throw error;
  }
  startLifecycle();
  // These dedicated resources are optional adjunct state. In particular, a
  // mobile document can suspend their fetches while an OAuth popup owns the
  // foreground. Never keep an already-authenticated room behind the setup
  // spinner; the heartbeat path coalesces and retries both reads.
  void refreshPersistedEffects(snapshot).catch((error) => {
    log.warn('[PRO] Initial room effects refresh failed', error);
  });
  void refreshPersistedQueueMode(snapshot).catch((error) => {
    log.warn('[PRO] Initial queue mode refresh failed', error);
  });
  const pendingTransition = bridge.consumePendingPlaybackTransition();
  if (pendingTransition) playbackController.acceptPrepare(pendingTransition);
  void refreshSystemAudioState(true).catch((error) => {
    log.warn('[PRO] Initial system-audio state refresh failed', error);
  });
  if (!pendingTransition) {
    void playbackController.restorePersistedPlayback(snapshot).catch((error) => {
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
  await prepareRoomSessionFeatures(options.signal);
  const snapshot = await controller.resume(code, options);
  return finalizeOpenedRoom(snapshot);
}

export async function joinProRoom(
  input: CreateProRoomSessionInput,
  signal?: AbortSignal,
): Promise<ProRoomSnapshot> {
  await prepareRoomSessionFeatures(signal);
  const snapshot = await controller.join(input, signal);
  return finalizeOpenedRoom(snapshot);
}

export async function activateProRoom(
  input: ActivateProRoomInput,
  signal?: AbortSignal,
): Promise<ProRoomSnapshot> {
  await prepareRoomSessionFeatures(signal);
  const snapshot = await controller.activate(input, signal);
  return finalizeOpenedRoom(snapshot);
}

export async function recoverProRoomOwner(
  input: RecoverProRoomOwnerInput,
  signal?: AbortSignal,
): Promise<ProRoomSnapshot> {
  await prepareRoomSessionFeatures(signal);
  const snapshot = await controller.recoverOwner(input, signal);
  return finalizeOpenedRoom(snapshot);
}

export async function transferProRoomOwner(
  input: TransferProRoomOwnerInput,
  signal?: AbortSignal,
): Promise<ProRoomSnapshot> {
  await prepareRoomSessionFeatures(signal);
  const snapshot = await controller.transferOwner(input, signal);
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

subscribeAccount((snapshot) => {
  const projectionKey = proRoomAccountIdentityProjectionKey(snapshot, getAccountStatsScope());
  // `/api/auth/session` can publish the same profile on every foreground
  // refresh. Treat that as lease observation, not an authority transition: it
  // must neither abort an in-flight renewal nor keep postponing the timer.
  if (projectionKey === acceptedAccountIdentityProjectionKey) return;
  acceptedAccountIdentityProjectionKey = projectionKey;
  accountIdentityGeneration += 1;
  accountIdentityLeaseExpiresAtMs = null;
  accountIdentityLeaseRetryAttempt = 0;
  accountReconciler.update(snapshot);
  if (active) scheduleAccountIdentityLeaseRenewal();
});

for (const event of [
  'state:audio.masterVolume',
  'state:audio.reverbMix',
  'state:audio.reverbDecay',
  'state:audio.reverbPreDelay',
  'state:audio.reverbLowCut',
  'state:audio.reverbHighCut',
  'state:audio.eqValues',
  'state:audio.stereoWidth',
  'state:audio.virtualBass',
  'state:audio.exciter',
] as const) {
  bus.on(event, () => scheduleEffectsCheckpoint());
}

// A controller switching ON publishes its complete local snapshot even when
// none of the individual audio fields changed at toggle time.
bus.on('settings-sync:publish-local', () => scheduleEffectsCheckpoint());

bus.on('settings-sync:changed', (enabled) => {
  if (!enabled) {
    cancelEffectsCheckpoint();
    return;
  }
  if (!active) return;
  // Controllers publish their retained local state; applying the previous
  // canonical snapshot here would erase the very state they are promoting.
  if (canPublishSynchronizedSettings()) {
    effectsCheckpointState.beginFullPublishIntent();
    return;
  }
  const snapshot = effectsRuntimeSnapshot();
  if (!snapshot) return;
  if (acceptedEffects?.roomCode === snapshot.roomCode) {
    applyCanonicalRoomEffects(acceptedEffects.effects, acceptedEffects.masterVolume);
    return;
  }
  void refreshPersistedEffects(snapshot).catch((error) => {
    log.warn('[PRO] Settings sync refresh failed', error);
  });
});

bus.on('state:room.context', () => {
  if (
    active &&
    effectsCheckpointState.dirty &&
    !hasEffectsCheckpointAuthority(playlistRuntimeLease)
  ) {
    cancelEffectsCheckpoint();
  }
});

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
    playbackController.acceptPrepare(prepareEvent, Date.now());
    return;
  }
  const commitEvent = parseProRoomPlaybackCommitEvent(frame.event);
  if (commitEvent) {
    playbackController.acceptCommit(commitEvent);
    return;
  }
  const cancelEvent = parseProRoomPlaybackCancelEvent(frame.event);
  if (cancelEvent) {
    playbackController.acceptCancel(cancelEvent.transitionId);
    return;
  }

  const queueAddition = parseProQueueAdditionFrame(frame.event.addition);
  if (queueAddition) acceptQueueAddition(queueAddition);

  if (frame.event.type === 'pro-room-invalidated' || frame.event.type === 'pro-presence-snapshot') {
    observeProRoomRuntimeTask(runHeartbeat(true), 'realtime invalidation heartbeat');
    if (
      frame.event.type === 'pro-room-invalidated' &&
      typeof frame.event.systemAudioGeneration === 'number' &&
      Number.isSafeInteger(frame.event.systemAudioGeneration) &&
      frame.event.systemAudioGeneration >= 0
    ) {
      void refreshSystemAudioState(true).catch((error) => {
        log.warn('[PRO] Realtime system-audio compatibility refresh failed', error);
      });
    }
    return;
  }
  if (frame.event.type === 'system-audio-invalidated') {
    void refreshSystemAudioState(true).catch((error) => {
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

bus.on('pro-room:kick-member', (memberIdOrLegacyParticipantId) => {
  const context = getState('room.context');
  if (!active || context.kind !== 'pro' || !context.roomId) return;
  const snapshot = playlistManager?.snapshot ?? controller.snapshot;
  const memberId = snapshot?.presence.participants.find(
    (participant) =>
      participant.memberId === memberIdOrLegacyParticipantId ||
      participant.participantId === memberIdOrLegacyParticipantId,
  )?.memberId;
  if (!memberId) return;
  void kickActiveProRoomMember(memberId).catch((error) => {
    if (isTerminalSessionError(error)) {
      observeProRoomRuntimeTask(recoverTerminalSession(error), 'terminal kick recovery');
      return;
    }
    log.warn('[PRO] Could not remove participant', error);
  });
});

registerProRoomHardCloseHandler(() => hardCloseActiveProRoom());
registerProRoomLeaveHandler(() => leaveActiveProRoom());
registerProRoomSignalingReconnectHandler(() => refreshSignalingCredential());
registerProRoomSignalingEpochAdvanceHandler(() => beginControlChannelRecovery());
