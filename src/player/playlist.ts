/**
 * MUSIXQUARE — Playlist Management
 *
 * Manages: playlist array, repeat/shuffle modes, playTrack,
 * playNextTrack, playPrevTrack, clearPreloadState.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { batchSetState as publishPreloadPromotion, getState, setState } from '../core/state.ts';
import { MSG, WARN_WHEN_CONNECTED_LOCAL_GUESTS_AT_LEAST } from '../core/constants.ts';
import { nextSessionId } from '../core/session.ts';
import { clearManagedTimer, delay, setManagedTimer } from '../core/timers.ts';
import {
  play,
  pause,
  stopAllMedia,
  getTrackPosition,
  isFilePipelineBusyForPlay,
  applyProPlaybackFileCommit,
  fmtTime,
  startHostFileAndBroadcastPlay,
} from './transport.ts';
import { clearPreviousTrackState, loadAndBroadcastFile, loadPreloadedTrack } from './decode.ts';
import {
  newLoadEpoch,
  isCurrentLoadEpoch,
  getCurrentAudioBuffer,
  setCurrentAudioBuffer,
} from './_state.ts';
import {
  partitionAudioFileCandidates,
  stripRecognizedAudioFileExtension,
} from '../media/audio-file.ts';
import { transition } from './lifecycle.ts';

import {
  schedulePreload,
  cancelPreloadTransfer,
  resetPreloadReceiveAuthority,
} from '../storage/preload.ts';
import {
  setEQ,
  setExciter,
  setPreamp,
  setStereoWidth,
  setVirtualBass,
  setReverbParam,
} from '../audio/effects.ts';
import { postCommand } from '../storage/storage.ts';
import {
  cancelIncomingFileTransfer,
  cancelOutgoingFileTransfers,
  cancelPendingBroadcast,
  resetIncomingTransferAuthority,
  sendFilePrepareByDelivery,
} from '../storage/transfer.ts';
import { broadcast, safeSend, sendToHost } from '../network/peer.ts';
import {
  cancelYtAutoSync,
  getYouTubePlayer,
  applyProPlaybackYouTubeCommit,
  setPendingAutoSyncOnReady,
} from '../youtube/player.ts';
import {
  afterStandardHostManualOffsetTransaction,
  isStandardHostManualOffsetTransactionPending,
} from '../youtube/standard-host-manual-offset-gate.ts';
import {
  cancelYouTubeAuthorityPreparation,
  handoffSameVideoOccurrenceRestart,
  prepareYouTubeAuthorityOccurrence,
  prepareSameVideoOccurrenceRestart,
  waitForPendingYouTubePrimeBounce,
} from '../youtube/iframe.ts';
import { isYtLoadInProgress, isYtPlayerReady } from '../youtube/_state.ts';
import { isGuestBlocked } from '../network/guards.ts';
import { showRoomCapabilityRequired } from '../rooms/permission-feedback.ts';
import { registerHandlers, verifyOperator } from '../network/protocol.ts';
import {
  getPlaybackSelectionTrackMeta,
  isPlaybackIdleCompat,
  isYouTubeOwner,
  setPlaybackTrackMeta,
} from './ownership.ts';
import type { AnyProtocolMsg, DataConnection, PlaylistItem, QueueItemId } from '../types/index.ts';
import { showToast } from '../ui/toast.ts';
import { showDialog } from '../ui/dialog.ts';
import { hasFileShareWarned, markFileShareWarned } from '../ui/large-room-warnings.ts';
import { cancelRemoteShareWait, shareRemoteFileIfNeeded } from '../share/remote-share.ts';
import { getHostNow } from '../network/shared-clock.ts';
import { hasQueueAuthority, markQueueAuthorityReady } from '../network/queue-authority.ts';
import { resetRecoveryAuthority } from '../storage/recovery.ts';
import { getRoomContext, hasRoomCapability } from '../rooms/authority.ts';
import {
  broadcastTracksAdded,
  localQueueActorName,
  queueActorNameForConnection,
} from '../chat/queue-events.ts';
import {
  acceptStandardQueueMutationRequest,
  sendStandardQueueMutationRequest,
  settleStandardQueueMutationRequest,
} from '../network/queue-mutation-authority.ts';
import { uploadStandardOperatorFiles } from '../network/operator-file-uplink.ts';
import {
  cancelProRoomPlaylistFileResolution,
  cancelProRoomPlaylistFilePreload,
  handleProRoomFiles,
  handleProRoomTrackRemoval,
  handleProRoomTrackReorder,
  isProRoomPersistentPlaylistFile,
  resolveProRoomPlaylistFile,
} from '../pro-room/media-hooks.ts';
import { freezeFileDeliveryMode } from '../share/file-delivery-policy.ts';
import {
  getProPlaybackAuthorityKey,
  isProPlaybackAuthorityToken,
  registerProPlaybackMediaEndpoint,
  routeProPlaybackCommand,
  type ProPlaybackAuthorityToken,
  type ProPlaybackCommitRequest,
  type ProPlaybackCommitResult,
  type ProPlaybackPrepareFailureReason,
  type ProPlaybackPrepareRequest,
  type ProPlaybackPrepareResult,
} from '../pro-room/playback-authority-hooks.ts';
import {
  applyPlaylistSnapshot,
  canAppendPlaylistItems,
  commitPlaylistItems,
  createPlaylistSnapshot,
  createQueueItemId,
  findQueueItemIndex,
  getCurrentQueueItemId,
  getCurrentQueueItemIndex,
  getQueueItemById,
  moveQueueItemBefore,
  selectQueueItemById,
} from './queue-model.ts';

const LOCAL_FILE_PLAY_SCHEDULE_AHEAD_MS = 200;

interface DeferredStandardHostManualNavigation {
  token: number;
  sourceQueueItemId: QueueItemId | null;
  sourceSubIndex: number;
  context: string;
  action: () => void | Promise<void>;
}

let _deferredStandardHostManualNavigation: DeferredStandardHostManualNavigation | null = null;
let _deferredStandardHostManualNavigationToken = 0;

function isDeferredStandardHostManualNavigationSourceCurrent(
  navigation: DeferredStandardHostManualNavigation,
): boolean {
  return (
    getCurrentQueueItemId() === navigation.sourceQueueItemId &&
    (getState('youtube.currentSubIndex') ?? -1) === navigation.sourceSubIndex
  );
}

function runDeferredStandardHostManualNavigation(token: number): void {
  const navigation = _deferredStandardHostManualNavigation;
  if (!navigation || navigation.token !== token) return;

  if (!isDeferredStandardHostManualNavigationSourceCurrent(navigation)) {
    _deferredStandardHostManualNavigation = null;
    log.debug(`[Playlist] Dropping deferred ${navigation.context}: source media identity changed`);
    return;
  }

  // Clear ownership before invoking the action so an action that starts a new
  // transaction cannot be mistaken for (or overwrite) this settled intent.
  _deferredStandardHostManualNavigation = null;
  try {
    const result = navigation.action();
    if (result && typeof result.then === 'function') {
      void result.catch((error) => {
        log.warn(`[Playlist] Failed to run deferred ${navigation.context}:`, error);
      });
    }
  } catch (error) {
    log.warn(`[Playlist] Failed to run deferred ${navigation.context}:`, error);
  }
}

/**
 * A Standard host's YouTube offset edit can have a fire-and-forget iframe
 * seek/load in flight. Keep every media-identity mutation out of that window,
 * but retain the latest navigation intent so a one-shot natural ENDED or
 * unavailable-video recovery is not lost. The captured source occurrence
 * fences the replay against room/queue/sub-video changes.
 */
function deferStandardHostManualNavigation(
  context: string,
  action: () => void | Promise<void>,
): boolean {
  if (!isStandardHostManualOffsetTransactionPending()) return false;

  const token = ++_deferredStandardHostManualNavigationToken;
  _deferredStandardHostManualNavigation = {
    token,
    sourceQueueItemId: getCurrentQueueItemId(),
    sourceSubIndex: getState('youtube.currentSubIndex') ?? -1,
    context,
    action,
  };
  afterStandardHostManualOffsetTransaction(() => runDeferredStandardHostManualNavigation(token));
  return true;
}

interface PlayTrackOptions {
  navigateToPlay?: boolean;
  proFilePreparation?: ProRoomFilePreparation;
  /** Treat the selection as an explicit play command, including the first file. */
  explicitPlaybackIntent?: boolean;
  /** Preserve a new same-video occurrence after its previous row was removed. */
  forceNewYouTubeOccurrence?: boolean;
  /** Explicit proof that this invocation applies a canonical PRO frame. */
  proAuthority?: ProPlaybackAuthorityToken;
  /** PREPARE loads/cues this occurrence without starting it. */
  proAuthorityPreparation?: {
    positionSeconds: number;
    youtubeSubIndex: number | null;
    youtubeVideoId: string | null;
    /** The exact video is already resident in the persistent iframe. */
    reuseResidentYouTube?: boolean;
  };
}

interface ProRoomFilePreparation {
  queueItemId: QueueItemId;
  positionSeconds: number;
  state: 'playing' | 'paused';
}

function getLocalFileHostPlayAt(): number {
  return getHostNow() + LOCAL_FILE_PLAY_SCHEDULE_AHEAD_MS;
}

function startLocalFileAndBroadcastPlay({
  time,
  queueItemId,
  name,
  shouldApply,
  context,
}: {
  time: number;
  queueItemId: QueueItemId;
  name?: string;
  shouldApply?: () => boolean;
  context: string;
}): void {
  startHostFileAndBroadcastPlay({
    time,
    queueItemId,
    name,
    // Local/offline playback is valid without a live room. The shared kernel
    // separately snapshots coordinator authority and publishes only while
    // that exact Standard-room authority remains current.
    shouldApply: () => !!getQueueItemById(queueItemId) && shouldApply?.() !== false,
    context,
  }).catch((error) => {
    log.warn(`[Playlist] Failed to start ${context} outside its transport boundary:`, error);
  });
}

function observePlayTrack(promise: Promise<void>, context: string): void {
  void promise.catch((error) => log.warn(`[Playlist] Failed to ${context}:`, error));
}

function clampRestorePosition(positionSeconds: number): number {
  const position = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0;
  const duration = getCurrentAudioBuffer()?.duration;
  if (!duration || !Number.isFinite(duration) || duration <= 0) return position;
  return Math.min(position, Math.max(0, duration - 0.001));
}

// ─── Shuffle Order (Fisher-Yates) ──────────────────────────────────
// A persistent permutation of queue occurrence IDs so that prev/next in shuffle
// mode traverse a stable order — going back and then forward returns to the
// same track. Regenerated on:
//   - shuffle toggled ON
//   - new occurrences are added (removal/reorder preserve surviving ID order)
//   - full shuffle exhausted with repeat-all (reshuffle for a fresh pass)

let _shuffleOrder: QueueItemId[] = [];
let _shufflePosition = 0;
interface PlaylistQueueModeState {
  repeatMode: 0 | 1 | 2;
  shuffleEnabled: boolean;
  shuffleOrder: QueueItemId[];
}
const DEMO_ALLOWED_SETTING_TYPES = new Set<string>([
  'eq',
  MSG.VBASS,
  MSG.EXCITER,
  MSG.STEREO_WIDTH,
  MSG.REVERB_TYPE,
]);

function isQueueIdle(): boolean {
  return isPlaybackIdleCompat();
}

function installShuffleOrder(order: readonly QueueItemId[]): boolean {
  const changed =
    order.length !== _shuffleOrder.length ||
    order.some((queueItemId, index) => queueItemId !== _shuffleOrder[index]);
  _shuffleOrder = [...order];
  const currentQueueItemId = getCurrentQueueItemId();
  const position = currentQueueItemId ? _shuffleOrder.indexOf(currentQueueItemId) : -1;
  _shufflePosition = position >= 0 ? position : 0;
  if (changed) bus.emit('playlist:shuffle-order-changed');
  return changed;
}

function isExactShufflePermutation(order: readonly QueueItemId[]): boolean {
  const playlist = getState('playlist.items') || [];
  if (order.length !== playlist.length) return false;
  const liveIds = new Set(playlist.map((item) => item.queueItemId));
  const seen = new Set<QueueItemId>();
  return order.every((queueItemId) => {
    if (!liveIds.has(queueItemId) || seen.has(queueItemId)) return false;
    seen.add(queueItemId);
    return true;
  });
}

function generateShuffleOrder(): boolean {
  const playlist = getState('playlist.items') || [];
  if (playlist.length === 0) {
    return installShuffleOrder([]);
  }
  const order = playlist.map((item) => item.queueItemId);
  // Fisher-Yates in-place shuffle
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return installShuffleOrder(order);
}

export function reconcileShuffleOrderForCurrentPlaylist(): void {
  const playlist = getState('playlist.items') || [];
  const liveIds = new Set(playlist.map((item) => item.queueItemId));
  if (_shuffleOrder.length === playlist.length && _shuffleOrder.every((id) => liveIds.has(id))) {
    installShuffleOrder(_shuffleOrder);
    return;
  }
  const survivingOrder = _shuffleOrder.filter((queueItemId) => liveIds.has(queueItemId));
  const survivingIds = new Set(survivingOrder);
  const hasNewItems = playlist.some((item) => !survivingIds.has(item.queueItemId));
  // Preserve the established random traversal across removal/reorder. Adding
  // new occurrences intentionally starts a fresh pass, matching the existing
  // MUSIXQUARE shuffle behavior.
  if (!hasNewItems) installShuffleOrder(survivingOrder);
  else generateShuffleOrder();
}

function ensureShuffleOrderValid(): void {
  reconcileShuffleOrderForCurrentPlaylist();
}

/**
 * Expose for tests, preload.ts, and decode recovery to query the next slot in
 * the row-level shuffle order without advancing the cursor.
 */
export function getShuffleNextPlayableQueueItemId(
  isCandidate: (queueItemId: QueueItemId, item: Readonly<PlaylistItem>) => boolean = () => true,
): QueueItemId | null {
  ensureShuffleOrderValid();
  const repeatMode = getState('playlist.repeatMode') || 0;
  const playlist = getState('playlist.items') || [];
  if (playlist.length <= 1) return null;

  const currentQueueItemId = getCurrentQueueItemId();
  const anchor = currentQueueItemId ? _shuffleOrder.indexOf(currentQueueItemId) : -1;
  const startPos = anchor >= 0 ? anchor : currentQueueItemId ? _shufflePosition : -1;

  for (let pos = startPos + 1; pos < _shuffleOrder.length; pos++) {
    const queueItemId = _shuffleOrder[pos];
    const item = queueItemId ? getQueueItemById(queueItemId, playlist) : null;
    if (
      queueItemId &&
      item &&
      queueItemId !== currentQueueItemId &&
      isCandidate(queueItemId, item)
    ) {
      return queueItemId;
    }
  }

  if (repeatMode !== 1) return null;

  for (let pos = 0; pos <= startPos && pos < _shuffleOrder.length; pos++) {
    const queueItemId = _shuffleOrder[pos];
    const item = queueItemId ? getQueueItemById(queueItemId, playlist) : null;
    if (
      queueItemId &&
      item &&
      queueItemId !== currentQueueItemId &&
      isCandidate(queueItemId, item)
    ) {
      return queueItemId;
    }
  }

  return null;
}

/** Expose for tests & for preload.ts to query the "next in shuffle order". */
export function getShuffleNextQueueItemId(): QueueItemId | null {
  return getShuffleNextPlayableQueueItemId();
}

export function advanceToShuffleNextQueueItemId(
  preferredQueueItemId: QueueItemId | null = null,
): QueueItemId | null {
  ensureShuffleOrderValid();
  const repeatMode = getState('playlist.repeatMode') || 0;
  const playlist = getState('playlist.items') || [];
  const currentQueueItemId = getCurrentQueueItemId();
  if (playlist.length <= 1) return null;

  if (
    preferredQueueItemId !== null &&
    preferredQueueItemId !== currentQueueItemId &&
    getQueueItemById(preferredQueueItemId, playlist)
  ) {
    const pos = _shuffleOrder.indexOf(preferredQueueItemId);
    if (pos >= 0) _shufflePosition = pos;
    return preferredQueueItemId;
  }

  const anchor = currentQueueItemId ? _shuffleOrder.indexOf(currentQueueItemId) : -1;
  if (anchor >= 0) _shufflePosition = anchor;
  if (!currentQueueItemId) {
    _shufflePosition = 0;
    return _shuffleOrder[0] ?? null;
  }

  const nextPos = _shufflePosition + 1;
  if (nextPos >= _shuffleOrder.length) {
    if (repeatMode !== 1) return null;

    generateShuffleOrder();
    _shufflePosition = 0;
    let nextQueueItemId =
      _shuffleOrder[0] === currentQueueItemId && _shuffleOrder.length > 1
        ? _shuffleOrder[1]
        : _shuffleOrder[0];
    if (nextQueueItemId === currentQueueItemId && _shuffleOrder.length > 1) {
      nextQueueItemId = _shuffleOrder[1];
      _shufflePosition = 1;
    } else {
      _shufflePosition = nextQueueItemId ? _shuffleOrder.indexOf(nextQueueItemId) : 0;
    }
    return nextQueueItemId ?? null;
  }

  _shufflePosition = nextPos;
  return _shuffleOrder[nextPos] ?? null;
}

export function advanceToShufflePreviousQueueItemId(): QueueItemId | null {
  ensureShuffleOrderValid();
  const repeatMode = getState('playlist.repeatMode') || 0;
  const playlist = getState('playlist.items') || [];
  if (playlist.length <= 1) return null;

  const currentQueueItemId = getCurrentQueueItemId();
  const anchor = currentQueueItemId ? _shuffleOrder.indexOf(currentQueueItemId) : -1;
  if (anchor >= 0) _shufflePosition = anchor;

  let prevPos = _shufflePosition - 1;
  if (prevPos < 0) {
    if (repeatMode !== 1) return null;
    prevPos = _shuffleOrder.length - 1;
  }

  _shufflePosition = prevPos;
  return _shuffleOrder[prevPos] ?? null;
}

function resetShuffleOrder(): boolean {
  return installShuffleOrder([]);
}

export function capturePlaylistQueueModeState(): PlaylistQueueModeState {
  const repeatMode = getState('playlist.repeatMode');
  const normalizedRepeatMode: 0 | 1 | 2 = repeatMode === 1 || repeatMode === 2 ? repeatMode : 0;
  const shuffleEnabled = !!getState('playlist.isShuffle');
  if (shuffleEnabled) ensureShuffleOrderValid();
  return {
    repeatMode: normalizedRepeatMode,
    shuffleEnabled,
    shuffleOrder: shuffleEnabled ? [..._shuffleOrder] : [],
  };
}

export function applyPlaylistQueueModeState(
  state: PlaylistQueueModeState,
  notify = false,
): boolean {
  if (
    (state.repeatMode !== 0 && state.repeatMode !== 1 && state.repeatMode !== 2) ||
    typeof state.shuffleEnabled !== 'boolean' ||
    !Array.isArray(state.shuffleOrder) ||
    (state.shuffleEnabled && !isExactShufflePermutation(state.shuffleOrder)) ||
    (!state.shuffleEnabled && state.shuffleOrder.length !== 0)
  ) {
    return false;
  }
  setRepeatMode(state.repeatMode, notify);
  setShuffle(state.shuffleEnabled, notify, state.shuffleOrder);
  return true;
}

// ─── Repeat / Shuffle ──────────────────────────────────────────────

function setPlaylistPressedState(
  element: Element,
  pressed: boolean,
  visuallyActive = pressed,
): void {
  element.classList.toggle('active', visuallyActive);
  element.setAttribute('aria-pressed', String(pressed));
}

export function toggleRepeat(): void {
  if (!hasRoomCapability('queue.mutate')) {
    showRoomCapabilityRequired('queue.mutate');
    return;
  }
  const hostConn = getState('network.hostConn');
  const repeatMode = getState('playlist.repeatMode') || 0;
  const nextMode = (repeatMode + 1) % 3;
  setRepeatMode(nextMode);

  if (hostConn) {
    sendToHost({ type: MSG.REQUEST_SETTING, settingType: MSG.REPEAT_MODE, value: nextMode });
  } else {
    broadcast({ type: MSG.REPEAT_MODE, value: nextMode });
  }
}

function syncRepeatControl(mode: number): void {
  const btn = document.getElementById('btn-repeat');
  if (!btn) return;
  setPlaylistPressedState(btn, mode !== 0, mode === 1);
  btn.classList.toggle('active-one', mode === 2);
  btn.setAttribute(
    'aria-label',
    t(
      mode === 1
        ? 'playlist.repeat_all'
        : mode === 2
          ? 'playlist.repeat_one'
          : 'playlist.repeat_off',
    ),
  );
}

export function setRepeatMode(mode: number, notify = true): void {
  const prevMode = getState('playlist.repeatMode') || 0;
  setState('playlist.repeatMode', mode);
  syncRepeatControl(mode);

  if (notify) {
    if (mode === 1) showToast(t('playlist.repeat_all'));
    else if (mode === 2) showToast(t('playlist.repeat_one'));
    else showToast(t('playlist.repeat_off'));
  }

  // The "next track" that preload staged was chosen under the previous mode.
  // When repeat-one toggles in/out of 2, the intended next changes (repeat-one
  // means "replay current" which doesn't preload a different track). Also
  // sequential→repeat-all at last track flips from end-of-playlist to wrap-0.
  // Regenerate on the standard host or independently on each PRO participant.
  if (mode !== prevMode) {
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      clearPreloadState();
      schedulePreload();
    }
  }
}

function syncShuffleControl(enabled: boolean): void {
  const btn = document.getElementById('btn-shuffle');
  if (!btn) return;
  setPlaylistPressedState(btn, enabled);
  btn.setAttribute('aria-label', t(enabled ? 'playlist.shuffle_on' : 'playlist.shuffle_off'));
}

export function toggleShuffle(): void {
  if (!hasRoomCapability('queue.mutate')) {
    showRoomCapabilityRequired('queue.mutate');
    return;
  }
  const hostConn = getState('network.hostConn');
  const isShuffle = getState('playlist.isShuffle');
  const nextShuffle = !isShuffle;
  setShuffle(nextShuffle);

  if (hostConn) {
    sendToHost({ type: MSG.REQUEST_SETTING, settingType: MSG.SHUFFLE_MODE, value: nextShuffle });
  } else {
    broadcast({ type: MSG.SHUFFLE_MODE, value: nextShuffle });
  }
}

export function setShuffle(
  enabled: boolean,
  notify = true,
  restoredOrder?: readonly QueueItemId[],
): void {
  const prevEnabled = getState('playlist.isShuffle');
  setState('playlist.isShuffle', enabled);
  syncShuffleControl(enabled);
  if (notify) showToast(enabled ? t('playlist.shuffle_on') : t('playlist.shuffle_off'));

  // Re-seed the Fisher-Yates permutation whenever shuffle turns ON so that
  // prev/next traverse a fresh random order. On OFF, drop the stale order.
  const orderChanged = enabled
    ? restoredOrder !== undefined && isExactShufflePermutation(restoredOrder)
      ? installShuffleOrder(restoredOrder)
      : generateShuffleOrder()
    : resetShuffleOrder();

  // Preload was chosen under the opposite mode — the stale hint may point to
  // a track that is no longer the "next" under the new mode (sequential vs
  // shuffled). Regenerate on the standard host or each PRO participant.
  if (enabled !== prevEnabled || orderChanged) {
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      clearPreloadState();
      schedulePreload();
    }
  }
}

// ─── Clear Preload State ───────────────────────────────────────────

export function clearPreloadState(force = false): void {
  const activeTarget = getState('preload.activeTarget');
  const ready = getState('preload.ready');
  const currentQueueItemId = getCurrentQueueItemId();
  const preloadOwner = ready?.queueItemId ?? activeTarget?.queueItemId ?? null;
  const isPreloadOwnerActive =
    !force && preloadOwner !== null && preloadOwner === currentQueueItemId;

  if (getState('room.context').kind === 'pro' && preloadOwner && !isPreloadOwnerActive) {
    cancelProRoomPlaylistFilePreload(preloadOwner);
  }

  // Cancel any in-flight backgroundTransfer to prevent stale preload data
  // from reaching guests after backward navigation (host-only).
  cancelPreloadTransfer(preloadOwner ?? undefined);
  if (force) resetPreloadReceiveAuthority();

  setState('preload.nextQueueItemId', null);
  if (!isPreloadOwnerActive) {
    setState('preload.ready', null);
    setState('preload.activeTarget', null);
  }
  setState('preload.isPreloading', false);

  // Guests reset preload storage on track change, so invalidate the host's
  // per-peer preload cache as well.
  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    const connectedPeers = getState('network.connectedPeers') || [];
    if (
      connectedPeers.length > 0 &&
      connectedPeers.some((p) => p.preloadedQueueItemIds?.size > 0)
    ) {
      const updatedPeers = connectedPeers.map((p) =>
        p.preloadedQueueItemIds?.size > 0
          ? { ...p, preloadedQueueItemIds: new Set<QueueItemId>() }
          : p,
      );
      setState('network.connectedPeers', updatedPeers);
    }
  }

  // Guest side
  postCommand({ command: 'STORAGE_RESET', isPreload: true });
}

// ─── Play Track ────────────────────────────────────────────────────

export async function playTrack(
  queueItemId: QueueItemId,
  subIndex?: number,
  options: PlayTrackOptions = {},
): Promise<void> {
  if (
    deferStandardHostManualNavigation('track selection', () =>
      playTrack(queueItemId, subIndex, options),
    )
  ) {
    return;
  }
  const playlist = getState('playlist.items') || [];
  const indexHint = findQueueItemIndex(queueItemId, playlist);
  const item = indexHint >= 0 ? playlist[indexHint] : null;
  if (!item) {
    if (playlist.length === 0) showToast(t('toast.no_tracks'));
    return;
  }

  const itemSubMap = getState('youtube.subItemsMap') || {};
  const itemSubIds =
    item.type === 'youtube' && item.playlistId ? itemSubMap[item.playlistId]?.ids : undefined;
  const storedVideoSubIndex =
    item.type === 'youtube' && item.videoId && itemSubIds ? itemSubIds.indexOf(item.videoId) : -1;
  const rawRequestedSubIndex =
    item.type === 'youtube'
      ? (subIndex ?? (storedVideoSubIndex >= 0 ? storedVideoSubIndex : 0))
      : null;
  const requestedTrackSubIndex =
    rawRequestedSubIndex !== null &&
    Number.isInteger(rawRequestedSubIndex) &&
    rawRequestedSubIndex >= 0 &&
    (!itemSubIds?.length || itemSubIds[rawRequestedSubIndex])
      ? rawRequestedSubIndex
      : item.type === 'youtube'
        ? 0
        : null;

  const appliesServerAuthority =
    isProPlaybackAuthorityToken(options.proAuthority) || options.proFilePreparation !== undefined;
  if (!appliesServerAuthority) {
    const requestedVideoId =
      item.type === 'youtube'
        ? ((item.playlistId ? itemSubIds?.[requestedTrackSubIndex ?? 0] : null) ??
          item.videoId ??
          null)
        : null;
    if (
      routeProPlaybackCommand({
        kind: 'select',
        queueItemId,
        positionSeconds: 0,
        youtubeSubIndex: requestedTrackSubIndex,
        youtubeVideoId: requestedVideoId,
      })
    ) {
      return;
    }
  }

  clearManagedTimer('ended-advance-retry');
  clearManagedTimer('ended-advance-next');
  // A direct track choice supersedes any scheduled decode-failure advance.
  // The timer also validates its load epoch when it fires.
  clearManagedTimer('decode-fail-advance');

  const hostConn = getState('network.hostConn');
  const previousQueueItemId = getCurrentQueueItemId();
  const playbackMetaBeforeSelection = getState('player.currentTrackMeta');

  // ─── Fast Path: Host re-clicks currently-playing local file ─────────
  // Skip full reload/rebroadcast/preload-reset. Reset position to 0 and
  // restart immediately. The authoritative PLAY frame restarts guests that
  // already own this exact buffer, so no transfer control frame is needed.
  //
  // Buffer existence alone does not establish ownership: superseded loads may
  // leave the previous track resident while selection has advanced. The
  // resident's queueItemId, not its name or former array slot, proves ownership.
  const _isSameTrack = queueItemId === getCurrentQueueItemId();
  const _resident = getState('files.current');
  const _residentFile =
    _resident?.queueItemId === queueItemId && _resident.blob instanceof File
      ? _resident.blob
      : null;
  const _isLocalFileTrack =
    item.type !== 'youtube' &&
    (!!item.file || (isProRoomPersistentPlaylistFile(queueItemId) && !!_residentFile));
  const _bufferMatchesTrack = !!getCurrentAudioBuffer() && _resident?.queueItemId === queueItemId;

  // Re-clicking the exact YouTube occurrence is a replay request, not a new
  // iframe load. Reusing youtube:load here can stop/cue the already-resident
  // video without a matching occurrence handoff, producing an ENDED/error
  // callback that incorrectly advances the playlist. Keep the iframe intact
  // and restart the synchronized timeline through the existing zero-start
  // barrier (or its established rendezvous fallback).
  if (
    !appliesServerAuthority &&
    !hostConn &&
    _isSameTrack &&
    item.type === 'youtube' &&
    isYouTubeOwner()
  ) {
    const subMap = getState('youtube.subItemsMap') || {};
    const requestedVideoId =
      (item.playlistId ? subMap[item.playlistId]?.ids?.[requestedTrackSubIndex ?? 0] : null) ||
      item.videoId ||
      null;
    const currentSubIndex = getState('youtube.currentSubIndex') ?? 0;
    const player = getYouTubePlayer();
    let residentVideoId: string;
    try {
      residentVideoId = player?.getVideoData?.()?.video_id || '';
    } catch {
      residentVideoId = '';
    }
    const samePlaylistPosition =
      !item.playlistId || currentSubIndex === (requestedTrackSubIndex ?? 0);

    if (requestedVideoId && residentVideoId === requestedVideoId && samePlaylistPosition) {
      cancelYtAutoSync();
      bus.emit('youtube:auto-play', {
        isTrackTransition: false,
        zeroStart: true,
        targetTime: 0,
        videoId: requestedVideoId,
        subIndex: requestedTrackSubIndex ?? 0,
        skipSeek: false,
      });
      return;
    }
  }

  if (
    !appliesServerAuthority &&
    !hostConn &&
    _isSameTrack &&
    _isLocalFileTrack &&
    _bufferMatchesTrack
  ) {
    log.debug('[Host] Same-track re-click: fast replay path (no redecode/rebroadcast)');

    const file = item.file ?? _residentFile;
    if (!file) return;
    const sessionId =
      _resident?.sessionId || getState('transfer.currentSessionId') || nextSessionId();
    freezeFileDeliveryMode(sessionId);
    if (!isProRoomPersistentPlaylistFile(queueItemId)) {
      shareRemoteFileIfNeeded(file, sessionId, undefined, { queueItemId }).catch((error) => {
        log.warn('[Playlist] Same-track Remote Share publication failed', error);
      });
    }

    // Reset the host position before replacing the current source.
    pause(0, { holdVisualizer: false });
    setState('player.pausedAt', 0);
    setState('player.isFirstTrackLoad', false);
    startLocalFileAndBroadcastPlay({
      time: 0,
      queueItemId,
      name: file.name,
      context: 'same-track replay',
    });

    return;
  }

  // Cancel in-flight preload (only for non-fast-path — fast path preserves
  // the preload cache since the next track is unchanged)
  setState('preload.isPreloading', false);

  // Direct track choices still reveal the player. Sequential playback can opt
  // out so a Next/Ended transition never interrupts another visible task such
  // as playlist deletion selection.
  if (!hostConn && options.navigateToPlay !== false) bus.emit('ui:switch-tab', 'play');

  const myLoadEpoch = newLoadEpoch();

  // Check if preloaded
  const nextQueueItemId = getState('preload.nextQueueItemId');
  const readyPreload = getState('preload.ready');
  const activePreloadTarget = getState('preload.activeTarget');

  // A persistent PRO object may still be arriving when its selection is
  // requested. Adopt that exact background promise before clearPreloadState()
  // gets a chance to cancel it; the recursive entry then uses either the completed
  // preload fast path or the already-published foreground File.
  if (
    !appliesServerAuthority &&
    !hostConn &&
    isProRoomPersistentPlaylistFile(queueItemId) &&
    queueItemId === nextQueueItemId &&
    activePreloadTarget?.queueItemId === queueItemId &&
    !readyPreload
  ) {
    const stoppedYouTubeBeforeSelection = isYouTubeOwner();
    if (stoppedYouTubeBeforeSelection) stopAllMedia({ silent: true });
    selectQueueItemById(queueItemId);
    setPlaybackTrackMeta(item);
    if (!stoppedYouTubeBeforeSelection) stopAllMedia({ silent: true });
    // A preload can be promoted before its presigned source resolves. Release
    // both the previous PCM and encoded resident before changing the runtime
    // lane to foreground; otherwise two maximum-size PRO files could overlap
    // outside the byte-bounded cache during the new GET.
    clearPreviousTrackState('pro-preload-promote');
    transition({ type: 'FILE_PREPARE', variant: 'fresh', queueItemId, name: item.name });

    const pendingFile = resolveProRoomPlaylistFile(queueItemId);
    if (pendingFile) {
      try {
        const resolved = await pendingFile;
        if (
          !resolved ||
          !isCurrentLoadEpoch(myLoadEpoch) ||
          getCurrentQueueItemId() !== queueItemId
        ) {
          return;
        }
        const promotedTarget = getState('preload.activeTarget');
        const promotedSessionId = Number(promotedTarget?.sessionId);
        if (
          getState('preload.nextQueueItemId') === queueItemId &&
          promotedTarget?.queueItemId === queueItemId &&
          Number.isSafeInteger(promotedSessionId) &&
          promotedSessionId > 0
        ) {
          const promotedIndexHint = findQueueItemIndex(queueItemId);
          publishPreloadPromotion({
            'preload.activeTarget': {
              ...promotedTarget,
              queueItemId,
              indexHint: promotedIndexHint,
              name: resolved.name || item.name,
              mime: resolved.type || promotedTarget.mime || 'application/octet-stream',
              size: resolved.size,
            },
            // This duplicate reference exists only across the immediate
            // recursive activation; loadPreloadedTrack atomically promotes it
            // to files.current and clears the preload slot.
            'preload.ready': {
              queueItemId,
              indexHint: promotedIndexHint,
              name: resolved.name || item.name,
              sessionId: promotedSessionId,
              blob: resolved,
              mime: resolved.type || promotedTarget.mime || 'application/octet-stream',
              size: resolved.size,
            },
            'preload.isPreloading': false,
          });
        }
        return playTrack(queueItemId, subIndex, options);
      } catch (error) {
        if (isCurrentLoadEpoch(myLoadEpoch) && getCurrentQueueItemId() === queueItemId) {
          log.warn('[Playlist] PRO preload promotion failed', error);
          transition({ type: 'REMOTE_FILE_UNAVAILABLE' });
        }
        return;
      }
    }
  }

  if (
    !appliesServerAuthority &&
    queueItemId === nextQueueItemId &&
    readyPreload?.queueItemId === queueItemId &&
    !hostConn
  ) {
    log.debug('[Host] Using preloaded queue item:', queueItemId);

    // Keep the outgoing YouTube occurrence selected until its teardown has
    // broadcast YOUTUBE_STOP. Selecting the file first would label that stop
    // with the new file queueItemId, so guests still on the old video would
    // reject it as stale and then reject the following FILE_PREPARE while
    // YouTube still owns playback.
    const stoppedYouTubeBeforePreloadSelection = isYouTubeOwner();
    if (stoppedYouTubeBeforePreloadSelection) {
      stopAllMedia({ silent: true });
    }
    selectQueueItemById(queueItemId);
    setPlaybackTrackMeta(item);

    // Advance session ID for recovery
    if (Number.isSafeInteger(readyPreload.sessionId) && readyPreload.sessionId > 0) {
      setState('transfer.currentSessionId', readyPreload.sessionId);
    } else {
      setState('transfer.currentSessionId', nextSessionId());
    }
    freezeFileDeliveryMode(getState('transfer.currentSessionId'));

    if (!stoppedYouTubeBeforePreloadSelection) {
      stopAllMedia({ silent: true }); // suppress IDLE flash — play() follows immediately
    }

    const preloadBlob = readyPreload.blob;
    const preloadFile =
      item.file ??
      (preloadBlob instanceof File
        ? preloadBlob
        : new File([preloadBlob], readyPreload.name || item.name, {
            type: readyPreload.mime || preloadBlob.type || 'application/octet-stream',
          }));
    const fileName = preloadFile.name || readyPreload.name || item.name;
    const isProDirect = isProRoomPersistentPlaylistFile(queueItemId);
    if (isProDirect) {
      broadcast({
        type: MSG.FILE_PREPARE,
        queueItemId,
        name: fileName,
        mime: preloadFile.type || readyPreload.mime || 'application/octet-stream',
        size: preloadFile.size,
        sessionId: getState('transfer.currentSessionId'),
      });
    } else {
      const preloadSessionId = getState('transfer.currentSessionId');
      sendFilePrepareByDelivery(
        {
          type: MSG.FILE_PREPARE,
          queueItemId,
          name: fileName,
          mime: preloadFile.type || readyPreload.mime || 'application/octet-stream',
          size: preloadFile.size,
          sessionId: preloadSessionId,
        },
        preloadSessionId,
        { r2Only: true },
      );
      broadcast({
        type: MSG.PLAY_PRELOADED,
        queueItemId,
        name: fileName,
        mime: item.file?.type,
      });
    }

    // Host must transition to DECODING before decode begins, so that the
    // subsequent DECODE_SUCCESS lands cleanly on READY.
    transition({ type: 'PLAY_PRELOADED', variant: 'blob-ready', queueItemId, name: fileName });

    // Play and broadcast only after the current activation succeeds. Failure
    // owns its auto-advance path; supersession transfers playback ownership to
    // the newer playTrack invocation.
    const activated = await loadPreloadedTrack(queueItemId, myLoadEpoch);
    if (!activated || !isCurrentLoadEpoch(myLoadEpoch) || getCurrentQueueItemId() !== queueItemId) {
      log.debug('[Host] Preloaded activation failed or superseded. Skipping play/broadcast');
      return;
    }
    // Whole-object remote upload is admitted against the active PCM buffer.
    // Start it only after this preloaded track has decoded and published its
    // own AudioBuffer, never while the previous track still owns that slot.
    if (!isProDirect) {
      const remoteShareSessionId = getState('transfer.currentSessionId') || null;
      shareRemoteFileIfNeeded(preloadFile, remoteShareSessionId, undefined, {
        queueItemId,
      }).catch((error) => {
        log.warn('[Playlist] Preloaded Remote Share publication failed', error);
      });
    }
    const started = await startHostFileAndBroadcastPlay({
      time: 0,
      queueItemId,
      name: fileName,
      shouldApply: () => isCurrentLoadEpoch(myLoadEpoch) && !!getQueueItemById(queueItemId),
      onStarted: schedulePreload,
      context: 'activated preload',
    });
    // play() crosses AudioContext resume/engine-init awaits. A newer
    // playTrack() can take ownership during that window; the transport then
    // aborts the stale local start, so this caller must likewise suppress its
    // old network PLAY and preload side effects.
    if (
      !started ||
      !isCurrentLoadEpoch(myLoadEpoch) ||
      getCurrentQueueItemId() !== queueItemId ||
      getState('playback.activity') !== 'playing'
    ) {
      log.debug('[Host] Preloaded play superseded before broadcast');
      return;
    }
    return;
  }

  clearPreloadState();

  // YOUTUBE_STOP is scoped to the queue occurrence currently owned by each
  // guest. End an outgoing YouTube owner before publishing a file selection;
  // otherwise the stop is stamped with the incoming file qid and ignored.
  const stoppedYouTubeBeforeFileSelection = item.type !== 'youtube' && isYouTubeOwner();
  if (stoppedYouTubeBeforeFileSelection) {
    stopAllMedia({ silent: true });
  }
  selectQueueItemById(queueItemId);
  setPlaybackTrackMeta(getPlaybackSelectionTrackMeta(item));

  // YouTube
  if (item.type === 'youtube') {
    // Force-clear any stale audio preload state to prevent incorrect
    // preloaded file being used when switching back from YouTube to audio
    setState('preload.ready', null);
    setState('preload.activeTarget', null);
    setState('preload.nextQueueItemId', null);

    // Cancel a debounced local-file broadcast before entering YouTube. An
    // already in-flight transfer may finish because its bytes remain reusable
    // if the room returns to that file.
    cancelPendingBroadcast();

    if (!hostConn) {
      // Skip stopAllMedia for YouTube→YouTube transitions — loadYouTubeVideo
      // reuses the existing player instance, preserving the iOS user gesture.
      // Destroying the iframe forces a "tap to play" on mobile.
      const isYtToYt = isYouTubeOwner();
      const wasPreparingFile = isFilePipelineBusyForPlay();
      // A new YouTube selection owns the persistent iframe from this point.
      // Cancel any old zero-start release before cueing the incoming video so
      // an already-scheduled playVideo() cannot fire against the new target.
      cancelYtAutoSync();
      if (!isYtToYt) {
        stopAllMedia({ silent: true }); // suppress IDLE flash — youtube:load follows
        if (wasPreparingFile) {
          // A superseded PRO fetch is aborted by the runtime when selection
          // changes. Release its file-only lifecycle too, otherwise the play
          // button would keep showing the file spinner after YouTube takes
          // ownership.
          transition({
            type: 'PAUSE',
            time: 0,
            queueItemId: null,
            endOfPlaylist: true,
          });
        }
      }

      // Broadcast one resolved videoId; playlistId is UI/navigation context,
      // not an instruction to start YouTube's native playlist engine. Prefer
      // the host's sub-item snapshot when available.
      const subMap = getState('youtube.subItemsMap') || {};
      const hostEntry = subMap[item.playlistId as string];
      const hostIds = hostEntry?.ids;
      const resolvedSubIndex = requestedTrackSubIndex ?? 0;
      const broadcastVideoId = (hostIds && hostIds[resolvedSubIndex]) || (item.videoId ?? null);
      const hasIndexedManifest = Boolean(
        item.playlistId && hostIds && (hostEntry?.manifestComplete === true || hostIds.length > 1),
      );
      // A populated manifest already gives us the exact sub-video. Keep the
      // playlistId on queue/meta/network state for navigation, but do not pass
      // it to the iframe: doing so wakes YouTube's native playlist resolver
      // and can outlive the initiating iOS gesture before the first video is
      // ready. The youtube:load listener repeats this normalization for other
      // internal callers that still carry both IDs.
      const iframeVideoId = hasIndexedManifest ? broadcastVideoId : (item.videoId ?? null);
      const iframePlaylistId = hasIndexedManifest ? null : (item.playlistId ?? null);

      if (options.proAuthorityPreparation) {
        const preparedSubIndex = options.proAuthorityPreparation.youtubeSubIndex ?? subIndex ?? 0;
        const preparedVideoId =
          options.proAuthorityPreparation.youtubeVideoId ||
          (hostIds && hostIds[preparedSubIndex]) ||
          item.videoId ||
          null;
        if (!preparedVideoId) return;
        if (getState('player.isFirstTrackLoad')) setState('player.isFirstTrackLoad', false);
        if (options.proAuthorityPreparation.reuseResidentYouTube) {
          // A server-authoritative resume/seek (and a repeated queue
          // occurrence of the same resolved video) only needs a new logical
          // occurrence fence. Keep the physical iframe and its buffered media
          // resident; the authority preparation step below owns mute, seek,
          // stabilization, and the scheduled release.
          schedulePreload();
          return;
        }
        // Server PREPARE carries the exact resolved sub-video. Force
        // single-video mode so a persistent iframe cannot auto-advance its
        // native playlist behind the server's canonical queue occurrence.
        bus.emit('youtube:load', preparedVideoId, null, queueItemId, false, preparedSubIndex);
        schedulePreload();
        return;
      }

      // Every shared YouTube transition is loaded paused first. This keeps a
      // persistent iframe from leaking a short burst of the incoming video
      // before the synchronized start path can choose zero-start or the compatible
      // legacy rendezvous path. An ordinary first entry still waits for the
      // user's explicit play tap; an explicit external play command and later
      // entries arm playback immediately after the paused load becomes usable.
      const isFirstTrackLoad = getState('player.isFirstTrackLoad');
      const isAlreadyYt = isYouTubeOwner();
      const shouldAutoplay = false;
      const isNewYouTubeOccurrence =
        isAlreadyYt &&
        (options.forceNewYouTubeOccurrence === true ||
          (previousQueueItemId !== null && previousQueueItemId !== queueItemId)) &&
        Boolean(broadcastVideoId);
      const sameVideoOccurrenceRestartPrepared =
        isNewYouTubeOccurrence && broadcastVideoId
          ? prepareSameVideoOccurrenceRestart(queueItemId, broadcastVideoId)
          : false;
      if (sameVideoOccurrenceRestartPrepared && playbackMetaBeforeSelection?.type === 'youtube') {
        const selectionTrackMeta = getPlaybackSelectionTrackMeta(item);
        setPlaybackTrackMeta({
          ...selectionTrackMeta,
          title: playbackMetaBeforeSelection.title || selectionTrackMeta.title,
          ...(playbackMetaBeforeSelection.artist
            ? { artist: playbackMetaBeforeSelection.artist }
            : {}),
        });
      }

      broadcast({
        type: MSG.YOUTUBE_PLAY,
        videoId: broadcastVideoId,
        playlistId: item.playlistId ?? null,
        name: item.name || item.title,
        queueItemId,
        autoplay: shouldAutoplay,
        subIndex: resolvedSubIndex,
      });

      // Also send YOUTUBE_PLAYLIST_INFO so guests have the sub-items map
      // for navigation (next/prev/sub-seek) and title display.
      if (hostIds && hostIds.length > 0) {
        const titles = subMap[item.playlistId as string]?.titles || [];
        broadcast({
          type: MSG.YOUTUBE_PLAYLIST_INFO,
          playlistId: item.playlistId as string,
          ids: hostIds,
          titles,
        });
      }

      // Every iframe load remains paused. The ordinary first-load + first-time
      // YouTube path waits for the user; an explicit external play intent uses
      // the same pending zero-start rendezvous as subsequent selections.
      if (isFirstTrackLoad && !isAlreadyYt && !options.explicitPlaybackIntent) {
        setState('player.isFirstTrackLoad', false);
        bus.emit(
          'youtube:load',
          iframeVideoId,
          iframePlaylistId,
          queueItemId,
          shouldAutoplay,
          resolvedSubIndex,
        );
        showToast(t('youtube.ready'));
      } else {
        if (isFirstTrackLoad) setState('player.isFirstTrackLoad', false);
        bus.emit(
          'youtube:load',
          iframeVideoId,
          iframePlaylistId,
          queueItemId,
          shouldAutoplay,
          resolvedSubIndex,
        );
        // Arm after youtube:load: fresh non-YT -> YT loads synchronously
        // stop existing media, which clears stale pending sync first.
        setPendingAutoSyncOnReady(true, {
          isTrackTransition: isAlreadyYt,
          zeroStart: true,
          targetTime: 0,
          subIndex: resolvedSubIndex,
          videoId: broadcastVideoId ?? undefined,
          // Distinct videos are freshly cued at 0, but two queue occurrences
          // may intentionally reuse one resident iframe without cueing it.
          // Zero-start performs its own load in capable cohorts; its legacy
          // fallback must still seek the reused iframe back to 0 explicitly.
          skipSeek: !sameVideoOccurrenceRestartPrepared,
        });
        if (sameVideoOccurrenceRestartPrepared && broadcastVideoId) {
          handoffSameVideoOccurrenceRestart(queueItemId, broadcastVideoId);
        }
      }

      // Keep hybrid playlists warm; preload scanning skips YouTube entries and
      // selects the next preloadable local file.
      schedulePreload();
    }
    return;
  }

  // Local file playback
  if (!stoppedYouTubeBeforeFileSelection) {
    stopAllMedia({ silent: true }); // suppress IDLE flash — play() follows
  }

  const file = item.file;
  if (!file) {
    const pendingFile = resolveProRoomPlaylistFile(queueItemId);
    if (pendingFile) {
      // Playback of the previous row is already stopped. Release its decoded
      // PCM and encoded resident before assembling the R2 body, both to bound
      // peak RAM and to make a later failed fetch incapable of replaying a
      // stale buffer under this newly selected queue ID.
      if (getCurrentAudioBuffer()) setCurrentAudioBuffer(null);
      if (getState('files.current')?.queueItemId !== queueItemId) setState('files.current', null);
      // Persistent PRO media has a network fetch phase before the ordinary
      // decode pipeline begins. Enter the existing file lifecycle immediately
      // so checkpointing preserves this selected row and every play/seek
      // entry point reuses the established spinner + busy guards.
      transition({ type: 'FILE_PREPARE', variant: 'fresh', queueItemId, name: item.name });
      try {
        const resolvedFile = await pendingFile;
        const stillOwnsSelection =
          isCurrentLoadEpoch(myLoadEpoch) && getCurrentQueueItemId() === queueItemId;
        if (!resolvedFile) {
          if (stillOwnsSelection) transition({ type: 'REMOTE_FILE_UNAVAILABLE' });
          return;
        }
        if (!stillOwnsSelection) {
          return;
        }

        // The PRO runtime publishes the verified File onto the authoritative
        // projected row before resolving. Only retry once that publication is
        // visible; otherwise a faulty hook could recurse forever.
        if (!getQueueItemById(queueItemId)?.file) {
          log.warn('[Playlist] PRO media resolver returned without publishing the file');
          return;
        }
        return playTrack(queueItemId, subIndex, options);
      } catch (error) {
        if (isCurrentLoadEpoch(myLoadEpoch)) {
          log.warn('[Playlist] PRO media download failed', error);
          if (getCurrentQueueItemId() === queueItemId) {
            transition({ type: 'REMOTE_FILE_UNAVAILABLE' });
          }
        }
        return;
      }
    }
    log.warn('[Playlist] No file for queue item', queueItemId);
    return;
  }

  if (!hostConn) {
    const sessionId = nextSessionId();
    freezeFileDeliveryMode(sessionId);
    setState('transfer.currentSessionId', sessionId);

    const isFirstTrackLoad = getState('player.isFirstTrackLoad');
    const waitsForManualFirstStart = isFirstTrackLoad && !options.explicitPlaybackIntent;

    // FILE_PREPARE is coalesced into the same debounce as broadcastFile.
    // Sending it eagerly here would flood guests with metadata updates for
    // every track the user clicked through, racing against PLAY messages
    // and surfacing as "Name mismatch on PLAY" with the guest stuck waiting
    // on a FILE_PREPARE that already arrived as a stale earlier one.
    const prepareMsg = {
      type: MSG.FILE_PREPARE,
      name: file.name,
      queueItemId,
      sessionId,
      // Name and size are transport metadata, not media identity.
      size: file.size,
      mime: file.type,
    };
    const didLoad = await loadAndBroadcastFile(
      file,
      queueItemId,
      sessionId,
      myLoadEpoch,
      prepareMsg,
    );
    if (!didLoad) return;

    if (options.proFilePreparation) {
      if (
        options.proFilePreparation.queueItemId !== queueItemId ||
        !isCurrentLoadEpoch(myLoadEpoch) ||
        getCurrentQueueItemId() !== queueItemId
      ) {
        return;
      }

      const restorePosition = clampRestorePosition(options.proFilePreparation.positionSeconds);
      setState('player.isFirstTrackLoad', false);

      if (options.proFilePreparation.state === 'paused') {
        setState('player.pausedAt', restorePosition);
        transition({
          type: 'PAUSE',
          time: restorePosition,
          queueItemId,
          endOfPlaylist: false,
        });
        if (getState('playback.activity') !== 'paused') return;
        const duration = getCurrentAudioBuffer()?.duration ?? 0;
        bus.emit(
          'ui:time-update',
          fmtTime(restorePosition),
          fmtTime(duration),
          restorePosition,
          duration,
        );
        bus.emit('ui:update-play-state', false);
        broadcast({
          type: MSG.PAUSE,
          time: restorePosition,
          queueItemId,
          reason: 'seek',
        });
        return;
      }

      let recoveredStartPublished = false;
      const publishRecoveredRestoredStart = (): void => {
        if (
          recoveredStartPublished ||
          !isCurrentLoadEpoch(myLoadEpoch) ||
          getCurrentQueueItemId() !== queueItemId ||
          getState('playback.activity') !== 'playing'
        ) {
          return;
        }
        recoveredStartPublished = true;
        broadcast({
          type: MSG.PLAY,
          time: restorePosition,
          queueItemId,
          name: file.name,
          hostPlayAt: getLocalFileHostPlayAt(),
        });
      };
      let started: boolean;
      try {
        started = await play(restorePosition, 0, undefined, undefined, {
          timing: 'catch-up',
          onRecoveredStarted: publishRecoveredRestoredStart,
        });
      } catch (error) {
        log.warn('[Playlist] Failed to restore file playback:', error);
        return;
      }
      if (
        !started ||
        !isCurrentLoadEpoch(myLoadEpoch) ||
        getCurrentQueueItemId() !== queueItemId ||
        getState('playback.activity') !== 'playing'
      ) {
        return;
      }
      publishRecoveredRestoredStart();
      return;
    }

    if (isFirstTrackLoad) setState('player.isFirstTrackLoad', false);
    if (waitsForManualFirstStart) {
      showToast(t('toast.file_ready'));
    } else {
      startLocalFileAndBroadcastPlay({
        time: 0,
        queueItemId,
        name: file.name,
        shouldApply: () => isCurrentLoadEpoch(myLoadEpoch),
        context: 'automatic track start',
      });
    }
  }
}

// ─── End Of Playlist Handler ───────────────────────────────────────

/**
 * Uniform cleanup path for "playlist finished, nothing should be selected".
 *
 * Clears track meta, audio buffer, and deselects currentQueueItemId so the
 * UI state ("미디어 없음") is internally consistent with transport state.
 * Broadcasts MSG.PAUSE{endOfPlaylist:true} so guests mirror the reset.
 *
 * Clearing the resident buffer and selecting no queue item ensures a later Play
 * restarts from the top instead of resuming an unselected final track.
 */
function handleEndOfPlaylist(reason: string): void {
  log.debug(`[Host] End of playlist: ${reason}. Resetting to deselected state.`);
  stopAllMedia();
  setCurrentAudioBuffer(null);
  setPlaybackTrackMeta(null);
  selectQueueItemById(null);
  setState('files.current', null);
  setState('player.pausedAt', 0);
  transition({ type: 'PAUSE', time: 0, queueItemId: null, endOfPlaylist: true });
  broadcast({
    type: MSG.PAUSE,
    time: 0,
    queueItemId: null,
    endOfPlaylist: true,
    reason: 'end-of-playlist',
  });
  showToast(t('toast.playlist_ended'));
}

// ─── Play Next Track ───────────────────────────────────────────────

export function playNextTrack(): void {
  if (isGuestBlocked()) return;
  if (deferStandardHostManualNavigation('next-track navigation', () => playNextTrack())) return;

  if (
    routeProPlaybackCommand({
      kind: 'next',
      queueItemId: getCurrentQueueItemId(),
      positionSeconds: getTrackPosition(),
    })
  ) {
    return;
  }

  const hostConn = getState('network.hostConn');
  const canControlPlayback = hasRoomCapability('playback.control');
  if (hostConn && canControlPlayback) {
    sendToHost({ type: MSG.REQUEST_NEXT_TRACK, queueItemId: getCurrentQueueItemId() });
    return;
  }

  // Host: YouTube internal navigation
  const repeatMode = getState('playlist.repeatMode') || 0;

  // Repeat-one intentionally does not short-circuit to "replay
  // current track" here. Natural track-end handles its own repeat-one
  // replay — for local files, the `player:ended` listener at the bottom
  // of this module; for YouTube, the iframe ENDED handler in
  // youtube/iframe.ts. Reaching this function therefore means either
  //   (a) a manual Next button / media-session skip, or
  //   (b) a YouTube error-recovery bus emit on an unavailable video.
  // In both cases the command must advance rather than replay the same track.

  if (isYouTubeOwner()) {
    let handled = false;
    bus.emit('youtube:try-next-internal', (success: boolean) => {
      handled = success;
    });
    if (handled) return;
  }

  const playlist = getState('playlist.items') || [];
  const currentIndex = getCurrentQueueItemIndex();
  const isShuffle = getState('playlist.isShuffle');
  const preloadedQueueItemId = getState('preload.nextQueueItemId');

  if (playlist.length === 0) return;

  let nextQueueItemId: QueueItemId | null;

  if (isShuffle) {
    if (playlist.length === 1) {
      // Single-track + shuffle + repeat OFF → stop (same as sequential behavior)
      if (repeatMode === 0) {
        handleEndOfPlaylist('single-track-shuffle');
        return;
      }
      nextQueueItemId = playlist[0]?.queueItemId ?? null;
    } else {
      nextQueueItemId = advanceToShuffleNextQueueItemId(preloadedQueueItemId);
      if (!nextQueueItemId) {
        handleEndOfPlaylist('shuffle-end');
        return;
      }
    }
  } else {
    let nextIndex = currentIndex + 1;
    if (nextIndex >= playlist.length) {
      if (repeatMode === 1) {
        nextIndex = 0;
      } else {
        handleEndOfPlaylist('sequential-end');
        return;
      }
    }
    nextQueueItemId = playlist[nextIndex]?.queueItemId ?? null;
  }

  if (nextQueueItemId) {
    observePlayTrack(
      playTrack(nextQueueItemId, undefined, { navigateToPlay: false }),
      'play the next track',
    );
  }
}

// ─── Play Previous Track ───────────────────────────────────────────

/**
 * Restart the resident buffer from 0:00 and broadcast (Prev-button
 * "restart current track" semantics).
 *
 * During file preparation the resident AudioBuffer belongs to the prior track.
 * Ignore restart in that window and let decode completion own the new start.
 */
function restartCurrentTrackFromStart(queueItemId: QueueItemId): void {
  if (isFilePipelineBusyForPlay()) {
    log.debug('[Playlist] Ignoring restart-current while file pipeline is preparing');
    return;
  }
  startLocalFileAndBroadcastPlay({
    time: 0,
    queueItemId,
    context: 'current-track restart',
  });
  // SharedClock handles sync
}

export function playPrevTrack(): void {
  if (isGuestBlocked()) return;
  if (deferStandardHostManualNavigation('previous-track navigation', () => playPrevTrack())) return;

  if (
    routeProPlaybackCommand({
      kind: 'previous',
      queueItemId: getCurrentQueueItemId(),
      positionSeconds: getTrackPosition(),
    })
  ) {
    return;
  }

  const hostConn = getState('network.hostConn');
  const canControlPlayback = hasRoomCapability('playback.control');
  if (hostConn && canControlPlayback) {
    sendToHost({ type: MSG.REQUEST_PREV_TRACK, queueItemId: getCurrentQueueItemId() });
    return;
  }

  const currentQueueItemId = getCurrentQueueItemId();
  const currentIndex = getCurrentQueueItemIndex();

  // YouTube mode
  if (isYouTubeOwner()) {
    let handled = false;
    bus.emit('youtube:try-prev-internal', (success: boolean) => {
      handled = success;
    });
    if (handled) return;

    const playlist = getState('playlist.items') || [];
    const repeatMode = getState('playlist.repeatMode') || 0;
    const isShuffle = getState('playlist.isShuffle');

    if (isShuffle && playlist.length > 1) {
      const previousQueueItemId = advanceToShufflePreviousQueueItemId();
      if (previousQueueItemId) {
        observePlayTrack(playTrack(previousQueueItemId), 'play the previous shuffled track');
      } else if (currentQueueItemId) {
        observePlayTrack(playTrack(currentQueueItemId), 'restart the current shuffled track');
      }
      return;
    }

    if (currentIndex > 0) {
      const previousQueueItemId = playlist[currentIndex - 1]?.queueItemId;
      if (previousQueueItemId) {
        observePlayTrack(playTrack(previousQueueItemId), 'play the previous YouTube track');
      }
    } else {
      if (repeatMode === 1 && playlist.length > 1) {
        const lastQueueItemId = playlist[playlist.length - 1]?.queueItemId;
        if (lastQueueItemId) {
          observePlayTrack(playTrack(lastQueueItemId), 'wrap to the last YouTube track');
        }
      } else if (playlist[0]) {
        observePlayTrack(playTrack(playlist[0].queueItemId), 'restart the first YouTube track');
      }
    }
    return;
  }

  // Local mode: restart if > 3s, else previous track
  const pos = getTrackPosition();
  if (pos > 3) {
    // Restart current track from the beginning
    if (currentQueueItemId) restartCurrentTrackFromStart(currentQueueItemId);
    return;
  }

  const playlist = getState('playlist.items') || [];
  const repeatMode = getState('playlist.repeatMode') || 0;
  const isShuffle = getState('playlist.isShuffle');

  // Shuffle: walk the Fisher-Yates permutation BACKWARD so prev→next
  // round-trips return to the same track.
  if (isShuffle && playlist.length > 1) {
    const previousQueueItemId = advanceToShufflePreviousQueueItemId();
    if (previousQueueItemId) {
      observePlayTrack(playTrack(previousQueueItemId), 'play the previous shuffled track');
      return;
    }

    // At start of shuffle pass, no repeat-all → restart current, same as
    // sequential behaviour at first track.
    if (isQueueIdle()) {
      const fallbackQueueItemId = currentQueueItemId ?? playlist[0]?.queueItemId;
      if (fallbackQueueItemId) {
        observePlayTrack(playTrack(fallbackQueueItemId), 'reload the shuffled fallback track');
      }
    } else if (currentQueueItemId) {
      restartCurrentTrackFromStart(currentQueueItemId);
    }
    return;
  }

  if (currentIndex > 0) {
    const previousQueueItemId = playlist[currentIndex - 1]?.queueItemId;
    if (previousQueueItemId) {
      observePlayTrack(playTrack(previousQueueItemId), 'play the previous track');
    }
  } else {
    // At first track: wrap to last if repeat-all, otherwise restart
    if (repeatMode === 1 && playlist.length > 1) {
      const lastQueueItemId = playlist[playlist.length - 1]?.queueItemId;
      if (lastQueueItemId) {
        observePlayTrack(playTrack(lastQueueItemId), 'wrap to the last track');
      }
    } else {
      // In IDLE state (after track ended + stopAllMedia), play(0) silently fails
      // because no media source is available, but broadcast still fires → host-guest desync.
      // Use playTrack to reload the file instead.
      if (isQueueIdle()) {
        const fallbackQueueItemId = currentQueueItemId ?? playlist[0]?.queueItemId;
        if (fallbackQueueItemId) {
          observePlayTrack(playTrack(fallbackQueueItemId), 'reload the fallback track');
        }
      } else if (currentQueueItemId) {
        restartCurrentTrackFromStart(currentQueueItemId);
      }
    }
  }
}

// ─── Network Handlers ──────────────────────────────────────────────

function handleRepeatMode(data: Record<string, unknown>, conn?: DataConnection): void {
  // REPEAT_MODE is an authoritative host→guest broadcast. Host-local changes
  // bypass this handler, and peer frames must not change another client.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  const v = Number(data.value) || 0;
  // _bootstrap frames are a re-baseline (join bootstrap / OPERATOR_REVOKE
  // resync), not a user-visible mode change — skip the toggle toast.
  setRepeatMode(Math.max(0, Math.min(2, v)), !data._bootstrap);
}

function handleShuffleMode(data: Record<string, unknown>, conn?: DataConnection): void {
  // SHUFFLE_MODE is an authoritative host→guest broadcast.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  // Same _bootstrap semantics as handleRepeatMode above.
  setShuffle(!!data.value, !data._bootstrap);
}

function handlePlaylistUpdate(data: Record<string, unknown>, conn?: DataConnection): void {
  // PLAYLIST_UPDATE is an authoritative host→guest snapshot. Peer frames must
  // not replace another participant's queue or trigger its empty-list cleanup.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

  const prevLength = (getState('playlist.items') || []).length;
  const previousCurrentQueueItemId = getCurrentQueueItemId();
  const authorityEstablished = hasQueueAuthority(conn);
  if (!authorityEstablished && data.bootstrap !== true) {
    log.warn('[Playlist] Ignored playlist update before authority bootstrap');
    return;
  }
  if (authorityEstablished && data.bootstrap === true) {
    log.debug('[Playlist] Ignored repeated authority bootstrap on established connection');
    return;
  }
  const outcome = applyPlaylistSnapshot(data, authorityEstablished ? 'monotonic' : 'rebase');

  if (outcome === 'invalid') {
    log.warn('[Playlist] Rejected malformed playlist snapshot');
    return;
  }
  if (outcome === 'conflict') {
    log.warn('[Playlist] Rejected conflicting playlist snapshot at equal revision');
    return;
  }
  if (outcome === 'stale') {
    log.debug('[Playlist] Ignored stale playlist snapshot');
    return;
  }
  if (outcome === 'duplicate') {
    if (data.refresh === true) bus.emit('playlist:refresh-requested');
    return;
  }

  const incoming = getState('playlist.items');
  ensureShuffleOrderValid();

  // A changed connection baseline belongs to a new authority even when queue
  // IDs or positions happen to resemble the previous room. Clear all media
  // owners so no resident/preloaded/partial bytes survive that boundary.
  // An incremental snapshot that removes the currently-owned occurrence must
  // also stop that old media immediately, even when a successor remains in
  // the queue and its authoritative media frame has not arrived yet.
  const authorityChanged = outcome === 'rebased';
  const playlistEmptied = outcome === 'applied' && incoming.length === 0 && prevLength > 0;
  const removedCurrentOwner =
    outcome === 'applied' &&
    previousCurrentQueueItemId !== null &&
    previousCurrentQueueItemId !== getCurrentQueueItemId() &&
    !incoming.some((item) => item.queueItemId === previousCurrentQueueItemId);
  const removedCurrentOwnsPreload =
    removedCurrentOwner &&
    (getState('preload.ready')?.queueItemId === previousCurrentQueueItemId ||
      getState('preload.activeTarget')?.queueItemId === previousCurrentQueueItemId);
  if (authorityChanged || playlistEmptied || removedCurrentOwner) {
    const reason = authorityChanged
      ? 'playlist-authority-rebased'
      : playlistEmptied
        ? 'playlist-emptied'
        : 'playlist-current-removed';
    if (authorityChanged) bus.emit('demo:authority-reset');
    stopAllMedia({ cancelInFlight: true, clearBuffer: true });
    // A successor can already be arriving through the independent preload
    // channel. Keep that live session intact while dropping the deleted
    // current media; a full reset here would strand PLAY_PRELOADED after the
    // snapshot. Only reset preload storage when its bytes belong to the
    // removed occurrence (or when the whole authority/queue is reset).
    if (authorityChanged || playlistEmptied || removedCurrentOwnsPreload) {
      clearPreloadState(authorityChanged);
    } else if (getState('preload.nextQueueItemId') === previousCurrentQueueItemId) {
      setState('preload.nextQueueItemId', null);
    }
    // Abort any in-flight main download — otherwise chunks already in the
    // data channel keep being written to storage to completion.
    cancelIncomingFileTransfer(reason);
    cancelRemoteShareWait(reason);
    if (authorityChanged) {
      resetIncomingTransferAuthority();
      resetRecoveryAuthority();
    }
    clearPreviousTrackState(reason);
    // clearPreviousTrackState doesn't touch player.currentTrackMeta.
    setPlaybackTrackMeta(null);
  }

  if (outcome === 'rebased') markQueueAuthorityReady(conn);
}

function handleTrackChange(data: Record<string, unknown>, conn: DataConnection): void {
  // Host handles OP request
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playlist] Rejected request-track-change from non-OP: ${conn?.peer}`);
    return;
  }

  const queueItemId = data.queueItemId;
  if (typeof queueItemId !== 'string' || !getQueueItemById(queueItemId)) {
    log.warn(`[Playlist] Invalid queue item ID: ${String(queueItemId)}`);
    return;
  }
  observePlayTrack(
    playTrack(queueItemId, undefined, { explicitPlaybackIntent: true }),
    'apply the operator track change',
  );
}

function handleRequestNextTrack(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playlist] Rejected request-next-track from non-OP: ${conn?.peer}`);
    return;
  }
  if (data.queueItemId !== getCurrentQueueItemId()) {
    log.debug('[Playlist] Ignoring stale next-track request');
    return;
  }
  playNextTrack();
}

function handleRequestPrevTrack(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  if (!verifyOperator(conn, data)) {
    log.warn(`[Playlist] Rejected request-prev-track from non-OP: ${conn?.peer}`);
    return;
  }
  if (data.queueItemId !== getCurrentQueueItemId()) {
    log.debug('[Playlist] Ignoring stale previous-track request');
    return;
  }
  playPrevTrack();
}

function handleRequestSetting(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  const st = data.settingType as string;
  const effectSettingTypes = new Set([
    'eq',
    MSG.PREAMP,
    MSG.STEREO_WIDTH,
    MSG.VBASS,
    MSG.EXCITER,
    MSG.REVERB,
    MSG.REVERB_TYPE,
    MSG.REVERB_DECAY,
    MSG.REVERB_PREDELAY,
    MSG.REVERB_LOWCUT,
    MSG.REVERB_HIGHCUT,
  ]);
  const requiredCapability =
    st === MSG.REPEAT_MODE || st === MSG.SHUFFLE_MODE
      ? 'queue.mutate'
      : effectSettingTypes.has(st)
        ? 'effects.control'
        : 'room.configure';
  const isOp = verifyOperator(conn, data, requiredCapability);
  const isDemoAllowed = getState('demo.active') && DEMO_ALLOWED_SETTING_TYPES.has(st);
  if (!isOp && !isDemoAllowed) {
    log.warn(`[Playlist] Rejected request-setting from non-OP: ${conn?.peer}`);
    return;
  }

  const val = data.value;
  let appliedSynchronizedEffect = false;
  switch (st) {
    case 'repeat-mode': {
      const mode = Number(val) || 0;
      setRepeatMode(mode);
      broadcast({ type: MSG.REPEAT_MODE, value: mode });
      break;
    }
    case 'shuffle-mode': {
      const enabled = !!val;
      setShuffle(enabled);
      broadcast({ type: MSG.SHUFFLE_MODE, value: enabled });
      break;
    }
    // ─── Audio Effect Settings (OP → Host apply + broadcast) ──
    case 'eq': {
      const band = parseInt(String(data.band), 10);
      const v = parseFloat(String(val));
      if (!Number.isFinite(band) || !Number.isFinite(v)) break;
      setEQ(band, v);
      broadcast({ type: MSG.EQ_UPDATE, band, value: v });
      appliedSynchronizedEffect = true;
      break;
    }
    case MSG.PREAMP: {
      const v = parseFloat(String(val));
      if (!Number.isFinite(v)) break;
      setPreamp(v);
      broadcast({ type: MSG.PREAMP, value: v });
      break;
    }
    // The ui:sync-* emits below mirror the guest-side network handlers in
    // audio/effects.ts: setters alone don't update the settings UI, so the
    // HOST's own chips/sliders would go stale when an OP's request applies.
    // (eq and REVERB_TYPE are excluded — their setters already emit.)
    case MSG.STEREO_WIDTH: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setStereoWidth(v);
      bus.emit('ui:sync-surround', v > 100);
      broadcast({ type: MSG.STEREO_WIDTH, value: v });
      appliedSynchronizedEffect = true;
      break;
    }
    case MSG.VBASS: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setVirtualBass(v);
      bus.emit('ui:sync-vbass', v > 0);
      broadcast({ type: MSG.VBASS, value: v });
      appliedSynchronizedEffect = true;
      break;
    }
    case MSG.EXCITER: {
      // Wire shape is 0 | 1 to share the REQUEST_SETTING number contract;
      // setExciter takes the boolean form locally.
      const v = Number(val);
      if (v !== 0 && v !== 1) break;
      setExciter(v === 1);
      bus.emit('ui:sync-exciter', v === 1);
      broadcast({ type: MSG.EXCITER, value: v });
      appliedSynchronizedEffect = true;
      break;
    }
    case MSG.REVERB: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('mix', v);
      bus.emit('ui:sync-reverb-param', 'mix', v);
      broadcast({ type: MSG.REVERB, value: v });
      appliedSynchronizedEffect = true;
      break;
    }
    case MSG.REVERB_TYPE: {
      // val is a string preset ('studio'/'arena'/'off') — apply locally on host + broadcast
      bus.emit('audio:reverb-type-change', String(val));
      break;
    }
    case MSG.REVERB_DECAY: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('decay', v);
      bus.emit('ui:sync-reverb-param', 'decay', v);
      broadcast({ type: MSG.REVERB_DECAY, value: v });
      appliedSynchronizedEffect = true;
      break;
    }
    case MSG.REVERB_PREDELAY: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('predelay', v);
      bus.emit('ui:sync-reverb-param', 'predelay', v);
      broadcast({ type: MSG.REVERB_PREDELAY, value: v });
      appliedSynchronizedEffect = true;
      break;
    }
    case MSG.REVERB_LOWCUT: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('lowcut', v);
      bus.emit('ui:sync-reverb-param', 'lowcut', v);
      broadcast({ type: MSG.REVERB_LOWCUT, value: v });
      appliedSynchronizedEffect = true;
      break;
    }
    case MSG.REVERB_HIGHCUT: {
      const v = Number(val);
      if (!Number.isFinite(v)) break;
      setReverbParam('highcut', v);
      bus.emit('ui:sync-reverb-param', 'highcut', v);
      broadcast({ type: MSG.REVERB_HIGHCUT, value: v });
      appliedSynchronizedEffect = true;
      break;
    }
  }
  // Rolling clients still send partial request-setting frames. After applying
  // one, advance the modern atomic authority snapshot so later joins and
  // modern followers cannot observe a stale full-state cache.
  if (appliedSynchronizedEffect) bus.emit('settings-sync:publish-local');
}

// ─── Load Demo Media ──────────────────────────────────────────────

// ─── Handle Files Selected ────────────────────────────────────────

function broadcastPlaylistSnapshot(): void {
  broadcast({ type: MSG.PLAYLIST_UPDATE, ...createPlaylistSnapshot() });
}

function appendStandardHostFiles(
  files: readonly File[],
  rejectedCount = 0,
  actorName = localQueueActorName(),
  announceAddition = true,
): boolean {
  if (
    files.length === 0 ||
    getState('network.appRole') !== 'host' ||
    getState('network.hostConn') ||
    getRoomContext().kind !== 'standard'
  ) {
    return false;
  }

  const playlist = [...(getState('playlist.items') || [])];
  const addedQueueItemIds: QueueItemId[] = [];
  for (const file of files) {
    const queueItemId = createQueueItemId();
    playlist.push({
      queueItemId,
      type: 'file',
      file,
      name: file.name,
      title: stripRecognizedAudioFileExtension(file.name),
      videoId: null,
      playlistId: null,
    });
    addedQueueItemIds.push(queueItemId);
  }

  const firstAddedQueueItemId = addedQueueItemIds[0] ?? null;
  const previousCurrentQueueItemId = getCurrentQueueItemId();
  const shouldAutoPlay =
    firstAddedQueueItemId !== null && isQueueIdle() && previousCurrentQueueItemId === null;

  commitPlaylistItems(playlist, {
    currentQueueItemId: shouldAutoPlay ? firstAddedQueueItemId : previousCurrentQueueItemId,
  });
  if (getState('playlist.isShuffle')) generateShuffleOrder();
  broadcastPlaylistSnapshot();
  bus.emit('playlist:items-added', addedQueueItemIds);
  if (announceAddition) {
    const firstAddedTitle = playlist.find(
      (item) => item.queueItemId === firstAddedQueueItemId,
    )?.title;
    broadcastTracksAdded(actorName, addedQueueItemIds.length, firstAddedTitle);
  }

  const addedMessage = t('toast.added_tracks', { count: addedQueueItemIds.length });
  showToast(
    rejectedCount > 0
      ? `${addedMessage}\n${t('toast.unsupported_files_excluded', { count: rejectedCount })}`
      : addedMessage,
  );

  if (shouldAutoPlay && firstAddedQueueItemId) {
    observePlayTrack(playTrack(firstAddedQueueItemId), 'autoplay the first added track');
  } else {
    schedulePreload(1000);
  }
  return true;
}

async function handleFilesSelected(files: FileList | readonly File[] | null): Promise<void> {
  if (!files || files.length === 0) return;

  const hostConn = getState('network.hostConn');
  if ((getRoomContext().kind === 'pro' || hostConn) && !hasRoomCapability('asset.upload')) {
    showRoomCapabilityRequired('asset.upload');
    return;
  }

  // MUSIXQUARE is music-only — videos are served through the YouTube path.
  // The picker `accept` attribute is only a hint. This shared consumer is the
  // authoritative guard for picker overrides, drops, and future entry points.
  // Native decode still decides whether a candidate is actually playable.
  const { accepted, rejected } = partitionAudioFileCandidates(files);

  if (accepted.length === 0) {
    if (rejected.length > 0) showToast(t('toast.no_supported_audio_files'));
    return;
  }

  // A persistent PRO room owns upload, quota accounting, and authoritative
  // playlist publication. Standard rooms have no registered hook and retain
  // the original in-memory path below.
  if (getRoomContext().kind === 'pro') {
    if (handleProRoomFiles(accepted, rejected.length)) return;
    showToast(t('error.network_generic'));
    return;
  }

  if (hostConn && getRoomContext().kind === 'standard') {
    if (rejected.length > 0) {
      showToast(t('toast.unsupported_files_excluded', { count: rejected.length }));
    }
    uploadStandardOperatorFiles(accepted).catch((error) => {
      log.warn('[Playlist] Standard-room operator upload failed', error);
    });
    return;
  }

  // The bounded direct-file budget counts LAN guests only. Remote guests
  // already use R2 from the first recipient, so they must not make an
  // otherwise-small local fanout look like a nine-device local room.
  const connectedLocalGuestCount = getState('network.connectedPeers').filter(
    (peer) =>
      peer.status === 'connected' && peer.conn?.open === true && peer.connectionType === 'local',
  ).length;
  if (
    connectedLocalGuestCount >= WARN_WHEN_CONNECTED_LOCAL_GUESTS_AT_LEAST &&
    !hasFileShareWarned()
  ) {
    const res = await showDialog({
      title: t('dialog.large_room_file.title'),
      message: t('dialog.large_room_file.message'),
      buttonText: t('dialog.continue'),
      secondaryText: t('common.cancel'),
    });
    if (res.action !== 'ok') return;
    markFileShareWarned();
  }

  appendStandardHostFiles(accepted, rejected.length);
}

// ─── Init ──────────────────────────────────────────────────────────

function findSequentialRemovalSuccessor(
  previousItems: readonly PlaylistItem[],
  currentIndex: number,
  removedQueueItemIds: ReadonlySet<QueueItemId>,
): QueueItemId | null {
  for (let index = currentIndex + 1; index < previousItems.length; index++) {
    const candidate = previousItems[index];
    if (candidate && !removedQueueItemIds.has(candidate.queueItemId)) {
      return candidate.queueItemId;
    }
  }
  for (let index = currentIndex - 1; index >= 0; index--) {
    const candidate = previousItems[index];
    if (candidate && !removedQueueItemIds.has(candidate.queueItemId)) {
      return candidate.queueItemId;
    }
  }
  return null;
}

function findShuffleRemovalSuccessor(
  previousShuffleOrder: readonly QueueItemId[],
  currentQueueItemId: QueueItemId,
  removedQueueItemIds: ReadonlySet<QueueItemId>,
  canWrap: boolean,
): QueueItemId | null {
  const currentPosition = previousShuffleOrder.indexOf(currentQueueItemId);
  if (currentPosition < 0) return null;

  for (let index = currentPosition + 1; index < previousShuffleOrder.length; index++) {
    const candidate = previousShuffleOrder[index];
    if (candidate && !removedQueueItemIds.has(candidate)) return candidate;
  }
  if (!canWrap) return null;
  for (let index = 0; index < currentPosition; index++) {
    const candidate = previousShuffleOrder[index];
    if (candidate && !removedQueueItemIds.has(candidate)) return candidate;
  }
  return null;
}

function handleRequestPlaylistRemove(
  data: {
    requestId: string;
    baseRevision: number;
    queueItemIds: QueueItemId[];
  },
  conn: DataConnection,
): void {
  const fingerprint = JSON.stringify([
    MSG.REQUEST_PLAYLIST_REMOVE,
    data.baseRevision,
    data.queueItemIds,
  ]);
  const outcome = acceptStandardQueueMutationRequest({
    conn,
    requestId: data.requestId,
    requestName: MSG.REQUEST_PLAYLIST_REMOVE,
    fingerprint,
  });
  if (outcome !== 'accepted') {
    if (outcome !== 'unauthorized') {
      safeSend(conn, { type: MSG.PLAYLIST_UPDATE, ...createPlaylistSnapshot(), refresh: true });
    }
    return;
  }

  // Removal is stable-ID based and therefore safely rebases over unrelated
  // appends/reorders. Missing rows are already removed, so retain idempotency.
  const liveQueueItemIds = data.queueItemIds.filter((queueItemId) => getQueueItemById(queueItemId));
  if (liveQueueItemIds.length === 0) {
    safeSend(conn, { type: MSG.PLAYLIST_UPDATE, ...createPlaylistSnapshot(), refresh: true });
    settleStandardQueueMutationRequest(conn, data.requestId, { outcome: 'applied' });
    return;
  }
  try {
    removeQueueItems(liveQueueItemIds);
    settleStandardQueueMutationRequest(conn, data.requestId, { outcome: 'applied' });
  } catch (error) {
    log.warn('[Playlist] Standard operator removal failed:', error);
    safeSend(conn, { type: MSG.PLAYLIST_UPDATE, ...createPlaylistSnapshot(), refresh: true });
    settleStandardQueueMutationRequest(conn, data.requestId, {
      outcome: 'rejected',
      code: 'internal-error',
    });
  }
}

function handleRequestPlaylistReorder(
  data: {
    requestId: string;
    baseRevision: number;
    queueItemId: QueueItemId;
    beforeQueueItemId: QueueItemId | null;
  },
  conn: DataConnection,
): void {
  const fingerprint = JSON.stringify([
    MSG.REQUEST_PLAYLIST_REORDER,
    data.baseRevision,
    data.queueItemId,
    data.beforeQueueItemId,
  ]);
  const outcome = acceptStandardQueueMutationRequest({
    conn,
    requestId: data.requestId,
    requestName: MSG.REQUEST_PLAYLIST_REORDER,
    fingerprint,
  });
  if (outcome !== 'accepted') {
    if (outcome !== 'unauthorized') {
      safeSend(conn, { type: MSG.PLAYLIST_UPDATE, ...createPlaylistSnapshot(), refresh: true });
    }
    return;
  }

  // Rebase by stable identity when concurrent mutations leave both anchors
  // alive. A removed insertion anchor is ambiguous, so reject and converge.
  if (
    !getQueueItemById(data.queueItemId) ||
    (data.beforeQueueItemId !== null && !getQueueItemById(data.beforeQueueItemId))
  ) {
    safeSend(conn, { type: MSG.PLAYLIST_UPDATE, ...createPlaylistSnapshot(), refresh: true });
    settleStandardQueueMutationRequest(conn, data.requestId, {
      outcome: 'rejected',
      code: 'invalid-target',
    });
    return;
  }
  if (!moveQueueItemBefore(data.queueItemId, data.beforeQueueItemId)) {
    // Already in the requested position is an idempotent success, not an
    // invalid target. Repaint the caller after its drag projection and settle
    // without incrementing the authoritative revision.
    safeSend(conn, { type: MSG.PLAYLIST_UPDATE, ...createPlaylistSnapshot(), refresh: true });
    settleStandardQueueMutationRequest(conn, data.requestId, { outcome: 'applied' });
    return;
  }
  try {
    reorderQueueItem(data.queueItemId, data.beforeQueueItemId, getState('playlist.revision'));
    settleStandardQueueMutationRequest(conn, data.requestId, { outcome: 'applied' });
  } catch (error) {
    log.warn('[Playlist] Standard operator reorder failed:', error);
    safeSend(conn, { type: MSG.PLAYLIST_UPDATE, ...createPlaylistSnapshot(), refresh: true });
    settleStandardQueueMutationRequest(conn, data.requestId, {
      outcome: 'rejected',
      code: 'internal-error',
    });
  }
}

function removeQueueItems(queueItemIds: readonly QueueItemId[]): void {
  if (getRoomContext().kind === 'pro') {
    if (!hasRoomCapability('queue.mutate')) {
      showRoomCapabilityRequired('queue.mutate');
      return;
    }
    if (!handleProRoomTrackRemoval(queueItemIds)) showToast(t('error.network_generic'));
    return;
  }
  if (getState('network.hostConn')) {
    if (getRoomContext().kind === 'standard' && hasRoomCapability('queue.mutate')) {
      sendStandardQueueMutationRequest({
        type: MSG.REQUEST_PLAYLIST_REMOVE,
        requestId: createQueueItemId(),
        baseRevision: getState('playlist.revision'),
        queueItemIds: [...new Set(queueItemIds)],
      });
    }
    return;
  }

  const previousItems = getState('playlist.items') || [];
  const requestedIds = new Set(queueItemIds);
  if (requestedIds.size === 0) return;

  const currentQueueItemId = getCurrentQueueItemId();
  if (
    currentQueueItemId &&
    requestedIds.has(currentQueueItemId) &&
    isStandardHostManualOffsetTransactionPending()
  ) {
    return;
  }

  const removedQueueItemIds = new Set<QueueItemId>();
  for (const item of previousItems) {
    if (requestedIds.has(item.queueItemId)) removedQueueItemIds.add(item.queueItemId);
  }
  if (removedQueueItemIds.size === 0) return;

  const currentIndex = findQueueItemIndex(currentQueueItemId, previousItems);
  const wasCurrent = !!currentQueueItemId && removedQueueItemIds.has(currentQueueItemId);
  const previousShuffleOrder = [..._shuffleOrder];
  const nextShuffleOrder = previousShuffleOrder.filter(
    (queueItemId) => !removedQueueItemIds.has(queueItemId),
  );
  const nextItems = previousItems.filter((item) => !removedQueueItemIds.has(item.queueItemId));

  let successorQueueItemId = currentQueueItemId;
  if (wasCurrent) {
    const sequentialSuccessor = findSequentialRemovalSuccessor(
      previousItems,
      currentIndex,
      removedQueueItemIds,
    );
    successorQueueItemId =
      getState('playlist.isShuffle') && nextShuffleOrder.length > 0 && currentQueueItemId
        ? (findShuffleRemovalSuccessor(
            previousShuffleOrder,
            currentQueueItemId,
            removedQueueItemIds,
            (getState('playlist.repeatMode') || 0) === 1,
          ) ?? sequentialSuccessor)
        : sequentialSuccessor;
  }

  commitPlaylistItems(nextItems, { currentQueueItemId: successorQueueItemId });
  _shuffleOrder = nextShuffleOrder;
  if (_shuffleOrder.length === 0) {
    _shufflePosition = 0;
  } else {
    const shuffleAnchor = successorQueueItemId ? _shuffleOrder.indexOf(successorQueueItemId) : -1;
    _shufflePosition =
      shuffleAnchor >= 0 ? shuffleAnchor : Math.min(_shufflePosition, _shuffleOrder.length - 1);
  }

  const preloadOwnsRemovedItem =
    removedQueueItemIds.has(getState('preload.nextQueueItemId') ?? '') ||
    removedQueueItemIds.has(getState('preload.ready')?.queueItemId ?? '') ||
    removedQueueItemIds.has(getState('preload.activeTarget')?.queueItemId ?? '');
  if (preloadOwnsRemovedItem) clearPreloadState();

  const recoveryTarget = getState('playback.pendingRecoveryTarget');
  if (recoveryTarget?.queueItemId && removedQueueItemIds.has(recoveryTarget.queueItemId)) {
    setState('playback.pendingRecoveryTarget', null);
    setState('recovery.pending', false);
  }

  const connectedPeers = getState('network.connectedPeers') || [];
  if (
    connectedPeers.some((peer) =>
      [...removedQueueItemIds].some((queueItemId) => peer.preloadedQueueItemIds.has(queueItemId)),
    )
  ) {
    setState(
      'network.connectedPeers',
      connectedPeers.map((peer) => {
        const preloadedQueueItemIds = new Set(peer.preloadedQueueItemIds);
        let changed = false;
        for (const queueItemId of removedQueueItemIds) {
          changed = preloadedQueueItemIds.delete(queueItemId) || changed;
        }
        if (!changed) return peer;
        return { ...peer, preloadedQueueItemIds };
      }),
    );
  }

  if (nextItems.length === 0) {
    stopAllMedia({ cancelInFlight: true });
    clearPreloadState();
    cancelOutgoingFileTransfers();
    setCurrentAudioBuffer(null);
    setPlaybackTrackMeta(null);
    setState('files.current', null);
    setState('transfer.meta', null);
    bus.emit('ui:play-btn-state', false);
  }

  broadcastPlaylistSnapshot();

  if (wasCurrent && successorQueueItemId) {
    setCurrentAudioBuffer(null);
    setState('files.current', null);
    observePlayTrack(playTrack(successorQueueItemId), 'play the successor after removal');
  } else if (preloadOwnsRemovedItem && nextItems.length > 0) {
    schedulePreload();
  }
}

function reorderQueueItem(
  queueItemId: QueueItemId,
  beforeQueueItemId: QueueItemId | null,
  baseRevision: number,
): void {
  if (getRoomContext().kind === 'pro') {
    if (!hasRoomCapability('queue.mutate')) {
      showRoomCapabilityRequired('queue.mutate');
      return;
    }
    if (!handleProRoomTrackReorder(queueItemId, beforeQueueItemId, baseRevision)) {
      showToast(t('error.network_generic'));
    }
    return;
  }
  if (getState('network.hostConn')) {
    if (getRoomContext().kind === 'standard' && hasRoomCapability('queue.mutate')) {
      sendStandardQueueMutationRequest({
        type: MSG.REQUEST_PLAYLIST_REORDER,
        requestId: createQueueItemId(),
        baseRevision,
        queueItemId,
        beforeQueueItemId,
      });
    }
    return;
  }
  if (baseRevision !== getState('playlist.revision')) {
    log.debug('[Playlist] Ignoring reorder from a stale playlist revision');
    return;
  }

  const reordered = moveQueueItemBefore(queueItemId, beforeQueueItemId);
  if (!reordered) return;

  commitPlaylistItems(reordered);
  broadcastPlaylistSnapshot();

  // Sequential order defines the speculative preload target. Re-evaluate it
  // after every reorder; schedulePreload coalesces rapid drags, while
  // preloadNextTrack preserves an already-ready resident when its stable
  // queue occurrence is still the intended target.
  schedulePreload();
}

function failedAuthorityPrepare(
  request: Readonly<ProPlaybackPrepareRequest>,
  reason: ProPlaybackPrepareFailureReason,
): ProPlaybackPrepareResult {
  return {
    status: 'failed',
    authority: request.authority,
    queueItemId: request.queueItemId,
    reason,
  };
}

function supersededAuthorityPrepare(
  request: Readonly<ProPlaybackPrepareRequest>,
): ProPlaybackPrepareResult {
  return {
    status: 'superseded',
    authority: request.authority,
    queueItemId: request.queueItemId,
    reason: 'superseded',
  };
}

async function prepareAuthoritativePlayback(
  request: Readonly<ProPlaybackPrepareRequest>,
): Promise<ProPlaybackPrepareResult> {
  const item = getQueueItemById(request.queueItemId);
  if (!item) return failedAuthorityPrepare(request, 'missing-track');
  if (getState('room.context').kind !== 'pro' || !isProPlaybackAuthorityToken(request.authority)) {
    return failedAuthorityPrepare(request, 'inactive-room');
  }

  const positionSeconds = Number.isFinite(request.positionSeconds)
    ? Math.max(0, request.positionSeconds)
    : 0;
  const subIndex = request.youtubeSubIndex ?? 0;
  const subMap = getState('youtube.subItemsMap') || {};
  const resolvedVideoId =
    item.type === 'youtube'
      ? request.youtubeVideoId ||
        (item.playlistId ? subMap[item.playlistId]?.ids?.[subIndex] : null) ||
        item.videoId ||
        null
      : null;

  let reuseResidentYouTube = false;
  if (
    item.type === 'youtube' &&
    resolvedVideoId &&
    isYouTubeOwner() &&
    isYtPlayerReady() &&
    !isYtLoadInProgress()
  ) {
    try {
      reuseResidentYouTube =
        (getYouTubePlayer()?.getVideoData?.()?.video_id || '') === resolvedVideoId;
    } catch {
      reuseResidentYouTube = false;
    }
  }

  try {
    if (item.type === 'youtube') {
      // A PRO late-join snapshot can arrive while the join gesture's silent
      // iOS prime bounce is still awaiting PLAYING. Let that exact gesture
      // finish before loadYouTubeVideo replaces the resident occurrence and
      // clears its bounce flag. The wait is bounded and a no-op elsewhere.
      await waitForPendingYouTubePrimeBounce();
      // The bounded wait deliberately happens before playTrack allocates a
      // load epoch. A newer PREPARE or server CANCEL can therefore supersede
      // this request without changing the epoch yet; consult the exact
      // authority-generation fence before the old request touches the iframe.
      if (request.isCurrent?.() === false) return supersededAuthorityPrepare(request);
    }
    await playTrack(request.queueItemId, item.type === 'youtube' ? subIndex : undefined, {
      navigateToPlay: false,
      explicitPlaybackIntent: false,
      forceNewYouTubeOccurrence: item.type === 'youtube',
      proAuthority: request.authority,
      proAuthorityPreparation: {
        positionSeconds,
        youtubeSubIndex: item.type === 'youtube' ? subIndex : null,
        youtubeVideoId: resolvedVideoId,
        reuseResidentYouTube,
      },
      ...(item.type === 'file'
        ? {
            proFilePreparation: {
              queueItemId: request.queueItemId,
              positionSeconds,
              state: 'paused' as const,
            },
          }
        : {}),
    });

    if (request.isCurrent?.() === false) return supersededAuthorityPrepare(request);
    if (item.type === 'youtube') {
      if (!resolvedVideoId) return failedAuthorityPrepare(request, 'identity-mismatch');
      const prepared = await prepareYouTubeAuthorityOccurrence({
        authorityKey: getProPlaybackAuthorityKey(request.authority),
        queueItemId: request.queueItemId,
        videoId: resolvedVideoId,
        subIndex,
        positionSeconds,
      });
      if (!prepared.ready) return failedAuthorityPrepare(request, prepared.reason);
      return {
        status: 'ready',
        authority: request.authority,
        queueItemId: request.queueItemId,
        mediaKind: 'youtube',
        durationSeconds: prepared.durationSeconds,
        youtubeSubIndex: prepared.subIndex,
        youtubeVideoId: prepared.videoId,
      };
    }

    clearManagedTimer('decode-fail-advance');
    const resident = getState('files.current');
    const buffer = getCurrentAudioBuffer();
    if (
      getCurrentQueueItemId() !== request.queueItemId ||
      resident?.queueItemId !== request.queueItemId ||
      !buffer
    ) {
      return failedAuthorityPrepare(request, 'decode-failed');
    }
    return {
      status: 'ready',
      authority: request.authority,
      queueItemId: request.queueItemId,
      mediaKind: 'file',
      durationSeconds:
        Number.isFinite(buffer.duration) && buffer.duration > 0 ? buffer.duration : null,
      youtubeSubIndex: null,
      youtubeVideoId: null,
    };
  } catch (error) {
    if (request.isCurrent?.() === false) return supersededAuthorityPrepare(request);
    clearManagedTimer('decode-fail-advance');
    log.warn('[PRO Playback] Participant preparation failed', error);
    return failedAuthorityPrepare(request, 'unknown');
  }
}

async function commitAuthoritativePlayback(
  request: Readonly<ProPlaybackCommitRequest>,
): Promise<ProPlaybackCommitResult> {
  if (request.state === 'idle') {
    const delayMs = Number.isFinite(request.scheduleDelayMs)
      ? Math.max(0, Math.min(30_000, request.scheduleDelayMs))
      : 0;
    if (delayMs > 0) await delay(delayMs);
    if (
      request.isCurrent?.() === false ||
      getState('room.context').kind !== 'pro' ||
      getState('room.context').roomId !== request.authority.roomId
    ) {
      return { status: 'superseded', authority: request.authority, reason: 'inactive-room' };
    }
    stopAllMedia({ cancelInFlight: true, silent: true });
    setCurrentAudioBuffer(null);
    setPlaybackTrackMeta(null);
    selectQueueItemById(null);
    setState('files.current', null);
    setState('player.pausedAt', 0);
    transition({ type: 'PAUSE', time: 0, queueItemId: null, endOfPlaylist: true });
    bus.emit('ui:seek-reset');
    return { status: 'applied', authority: request.authority };
  }

  const queueItemId = request.queueItemId;
  if (!queueItemId) {
    return { status: 'failed', authority: request.authority, reason: 'missing-track' };
  }
  const item = getQueueItemById(queueItemId);
  if (!item) return { status: 'failed', authority: request.authority, reason: 'missing-track' };

  const applied =
    item.type === 'youtube'
      ? await applyProPlaybackYouTubeCommit(request)
      : await applyProPlaybackFileCommit(request);
  return applied
    ? { status: 'applied', authority: request.authority }
    : { status: 'failed', authority: request.authority, reason: 'media-unavailable' };
}

export function initPlaylist(): void {
  syncRepeatControl(getState('playlist.repeatMode') || 0);
  syncShuffleControl(!!getState('playlist.isShuffle'));
  bus.on('i18n:changed', () => {
    syncRepeatControl(getState('playlist.repeatMode') || 0);
    syncShuffleControl(!!getState('playlist.isShuffle'));
  });

  registerProPlaybackMediaEndpoint({
    prepare: prepareAuthoritativePlayback,
    commit: commitAuthoritativePlayback,
    cancel: () => {
      // Make slow R2/decode work lose ownership immediately. The explicit
      // authority generation in playback-authority-hooks fences any late
      // completion, while these existing cancellation seams release work.
      newLoadEpoch();
      cancelProRoomPlaylistFileResolution();
      clearManagedTimer('decode-fail-advance');
      cancelYouTubeAuthorityPreparation();
    },
  });
  registerHandlers({
    [MSG.REPEAT_MODE]: handleRepeatMode,
    [MSG.SHUFFLE_MODE]: handleShuffleMode,
    [MSG.PLAYLIST_UPDATE]: handlePlaylistUpdate,
    [MSG.REQUEST_TRACK_CHANGE]: handleTrackChange,
    [MSG.REQUEST_NEXT_TRACK]: handleRequestNextTrack,
    [MSG.REQUEST_PREV_TRACK]: handleRequestPrevTrack,
    [MSG.REQUEST_SETTING]: handleRequestSetting,
    [MSG.REQUEST_PLAYLIST_REMOVE]: handleRequestPlaylistRemove,
    [MSG.REQUEST_PLAYLIST_REORDER]: handleRequestPlaylistReorder,
  });

  // Handle track ended auto-advance (guarded against double-fire from overlapping timers)
  // Mechanism M7b in docs/design/playback-concurrency-invariants.md — a
  // module-local generation counter DELIBERATELY separate from the player
  // load epoch (it guards only the two ended-advance timers below; folding it
  // into the global counter would let unrelated epoch bumps cancel a
  // legitimate ended-advance).
  let _endedAdvanceToken = 0;
  bus.on('player:ended', () => {
    const hostConn = getState('network.hostConn');
    if (hostConn) return; // Only Host handles
    if (getState('demo.active')) return;

    // Lifecycle: host-local TRACK_ENDED. Drives host's
    // parallel-observed lifecycle to IDLE. Guests learn via the subsequent
    // PAUSE broadcast, which drives their own transition.
    transition({ type: 'TRACK_ENDED' });

    const token = ++_endedAdvanceToken;
    const repeatMode = getState('playlist.repeatMode') || 0;

    if (repeatMode === 2) {
      log.debug('Repeat One: Replaying current track...');
      setManagedTimer(
        'ended-advance-retry',
        () => {
          if (token !== _endedAdvanceToken) return;
          // Reuse in-memory audio buffer — skip file re-transfer to guests.
          // Same optimized path as playNextTrack() repeat-one branch.
          const replayLoadEpoch = newLoadEpoch();
          const queueItemId = getCurrentQueueItemId();
          if (!queueItemId || !getQueueItemById(queueItemId)) return;
          startLocalFileAndBroadcastPlay({
            time: 0,
            queueItemId,
            shouldApply: () => token === _endedAdvanceToken && isCurrentLoadEpoch(replayLoadEpoch),
            context: 'repeat-one replay',
          });
          // SharedClock handles sync
        },
        300,
      );
    } else {
      log.debug('Auto-advancing to next track...');
      setManagedTimer(
        'ended-advance-next',
        () => {
          if (token === _endedAdvanceToken) playNextTrack();
        },
        500,
      );
    }
  });

  // Handle MediaSession navigation requests
  bus.on('playlist:prev-track', () => playPrevTrack());
  bus.on('playlist:next-track', () => playNextTrack());

  // File selection
  bus.on('app:files-selected', (files) => {
    return handleFilesSelected(files);
  });

  // The operator uplink emits only after the host has received and verified
  // the complete File. Re-run the shared media candidate filter, then append
  // directly without a second large-room confirmation dialog.
  bus.on('standard-room:operator-file-received', (file, acknowledge, sourceConnection) => {
    let outcome: true | false | 'queue-full' = false;
    try {
      const { accepted } = partitionAudioFileCandidates([file]);
      if (accepted.length !== 1) {
        outcome = false;
      } else if (!canAppendPlaylistItems(1)) {
        outcome = 'queue-full';
      } else {
        const actorName = sourceConnection
          ? queueActorNameForConnection(sourceConnection)
          : localQueueActorName();
        outcome = actorName ? appendStandardHostFiles(accepted, 0, actorName, false) : false;
      }
    } finally {
      acknowledge(outcome);
    }
  });

  bus.on('standard-room:operator-files-added', (sourceConnection, count, firstTitle) => {
    const actorName = queueActorNameForConnection(sourceConnection);
    if (actorName) broadcastTracksAdded(actorName, count, firstTitle);
  });

  // Play specific track from playlist view click
  bus.on('playlist:play-track', (queueItemId, subIndex, options) => {
    if (getQueueItemById(queueItemId)) return playTrack(queueItemId, subIndex, options);
  });

  // Host: Remove track from playlist
  bus.on('playlist:remove-tracks', (queueItemIds) => {
    removeQueueItems(queueItemIds);
  });

  bus.on('playlist:reorder-track', (queueItemId, beforeQueueItemId, baseRevision) => {
    reorderQueueItem(queueItemId, beforeQueueItemId, baseRevision);
  });

  // Host: send queue authority during the ordered pre-playback bootstrap phase.
  // The connection layer treats the synchronous acknowledgement as part of the
  // standard-room join boundary: playback/file bootstraps are not published
  // until all three authority frames have been accepted for this exact link.
  bus.on('network:peer-bootstrap', (conn, send, acknowledge) => {
    if (!conn?.open) {
      acknowledge(false);
      return;
    }

    // Only Host bootstraps guests
    const hostConn = getState('network.hostConn');
    if (hostConn) {
      acknowledge(false);
      return;
    }

    try {
      const sendFrame =
        typeof send === 'function'
          ? send
          : (frame: AnyProtocolMsg) => {
              conn.send(frame);
              return true;
            };
      // Full authoritative queue snapshot must be first after WELCOME. Every
      // qid/media frame on the guest is gated until this exact connection's
      // baseline has been applied.
      if (!sendFrame({ type: MSG.PLAYLIST_UPDATE, ...createPlaylistSnapshot(), bootstrap: true })) {
        acknowledge(false);
        return;
      }

      const repeatMode = getState('playlist.repeatMode') || 0;
      if (!sendFrame({ type: MSG.REPEAT_MODE, value: repeatMode, _bootstrap: true })) {
        acknowledge(false);
        return;
      }

      const isShuffle = getState('playlist.isShuffle');
      if (!sendFrame({ type: MSG.SHUFFLE_MODE, value: isShuffle, _bootstrap: true })) {
        acknowledge(false);
        return;
      }

      log.debug('[Playlist] Bootstrap: sent playlist state to new peer');
      acknowledge(true);
    } catch (error) {
      log.warn('[Playlist] Bootstrap send failed:', error);
      acknowledge(false);
    }
  });

  // Guest: apply exactly one ordered authority frame inside the join gate. The
  // caller advances only after this synchronous acknowledgement proves the
  // state mutation (including the queue/media authority reset) completed.
  bus.on('network:peer-bootstrap-apply', (frame, conn, acknowledge) => {
    let applied = false;
    try {
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
        acknowledge(false);
        return;
      }
      const data = frame as Record<string, unknown>;
      if (data.type === MSG.PLAYLIST_UPDATE && data.bootstrap === true) {
        if (hasQueueAuthority(conn)) {
          acknowledge(false);
          return;
        }
        handlePlaylistUpdate(data, conn);
        applied = hasQueueAuthority(conn);
      } else if (
        data.type === MSG.REPEAT_MODE &&
        data._bootstrap === true &&
        (data.value === 0 || data.value === 1 || data.value === 2)
      ) {
        handleRepeatMode(data, conn);
        applied = getState('playlist.repeatMode') === data.value;
      } else if (
        data.type === MSG.SHUFFLE_MODE &&
        data._bootstrap === true &&
        typeof data.value === 'boolean'
      ) {
        handleShuffleMode(data, conn);
        applied = getState('playlist.isShuffle') === data.value;
      }
    } catch (error) {
      log.warn('[Playlist] Bootstrap apply failed:', error);
    }
    acknowledge(applied);
  });

  log.info('[Playlist] Initialized');
}
