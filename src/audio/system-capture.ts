/**
 * MUSIXQUARE — System Audio Capture
 *
 * Captures host system audio via getDisplayMedia and exposes the original
 * audio track for every Standard and PRO delivery transport.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import {
  MAX_SYSTEM_AUDIO_DEVICES,
  MSG,
  SYSTEM_AUDIO_SHARE_LIMIT_MS,
  type PlaybackActivityValue,
  type PlaybackModeValue,
} from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import {
  DEFAULT_SYSTEM_AUDIO_SURFACE,
  normalizeSystemAudioSurface,
  type SystemAudioSurface,
} from '../core/system-audio-profile.ts';
import { t } from '../i18n/index.ts';
import { getAudioContext } from './context.ts';
import { initAudio, getWidener, getMasterGain } from './engine.ts';
import { getTrackPosition, stopAllMediaAsync } from '../player/transport.ts';
import {
  claimPlaybackOwner,
  createSystemAudioTrackMeta,
  getPlaybackModeActivitySnapshot,
  setPlaybackFilePaused,
  setPlaybackIdle,
  setPlaybackTrackMeta,
} from '../player/ownership.ts';
import { broadcast } from '../network/peer.ts';
import { createSystemAudioStartFrame } from '../network/system-audio-start.ts';
import { getSystemAudioShareDeliverySnapshot } from '../network/system-audio-delivery.ts';
import { broadcastSystemMessage } from '../chat/protocol.ts';
import { getQueueItemById } from '../player/queue-model.ts';
import {
  beginPendingBroadcastSuspension,
  discardPendingBroadcastSuspension,
  resumePendingBroadcastSuspension,
} from '../storage/transfer.ts';
import { getRoomContext, isCoordinator } from '../rooms/authority.ts';
import {
  configureSystemAudioCaptureActivityProbe,
  hasSystemAudioDeviceCapacity,
} from './system-audio-policy.ts';
import type { QueueItemId, SystemAudioStopReason, TrackMeta } from '../types/index.ts';
import {
  beginLocalProSystemAudioLeaseAttempt,
  canPublishProSystemAudioWithCurrentCoordinator,
  getProSystemAudioOwnerDisplayName,
  getProSystemAudioViewState,
  publishLocalProSystemAudio,
  releaseLocalProSystemAudioLease,
  type ProSystemAudioLeaseAttempt,
} from '../pro-room/system-audio-bridge.ts';

// ─── Module State ─────────────────────────────────────────────────

type SystemAudioRoomIdentity = Readonly<{
  kind: 'standard' | 'pro';
  roomId: string | null;
  epoch: number;
  standardPeerId: string | null;
}>;

let _capturedStream: MediaStream | null = null;
let _sourceNode: MediaStreamAudioSourceNode | null = null;
// Retain intermediate graph nodes so cleanupCapture can disconnect every
// connection created by a capture session.
let _stereoUpmix: GainNode | null = null;
let _debugLastCaptureStartedAt = 0;
let _debugLastCaptureStoppedAt = 0;
let _debugLastStartBroadcastAt = 0;
let _debugLastStopBroadcastAt = 0;
let _debugLastStreamsReadyAt = 0;

interface PreSystemAudioState {
  room: SystemAudioRoomIdentity;
  playback: {
    mode: PlaybackModeValue;
    activity: PlaybackActivityValue;
  };
  positionSeconds: number;
  currentTrackMeta: TrackMeta | null;
  claimedSystemAudioTrackMeta: TrackMeta | null;
  channelMode: number;
  queueItemId: QueueItemId | null;
  subIndex: number;
}

let _preSysAudioState: PreSystemAudioState | null = null;
let _captureStartPromise: Promise<void> | null = null;
let _captureStartEpoch = 0;
let _captureRoomKind: 'standard' | 'pro' | null = null;
let _standardMeteredRouteExpiresAt: number | null = null;
let _captureTrackEndedCleanup: (() => void) | null = null;
const SYSTEM_AUDIO_SHARE_LIMIT_TIMER = 'system-audio-host-share-limit';

function syncStandardRoleControlState(mode: number): void {
  try {
    document.querySelectorAll<HTMLElement>('#grid-standard .ch-opt[data-ch]').forEach((element) => {
      const selected = Number(element.dataset.ch) === mode;
      element.classList.toggle('active', selected);
      element.setAttribute('aria-pressed', String(selected));
    });
  } catch {
    /* presentation recovery must not change the media outcome */
  }
}

function captureSystemAudioRoomIdentity(): SystemAudioRoomIdentity {
  const room = getRoomContext();
  return Object.freeze({
    kind: room.kind,
    roomId:
      room.kind === 'standard'
        ? (room.roomId ?? (getState('network.sessionCode') || null))
        : room.roomId,
    epoch: room.epoch,
    standardPeerId: room.kind === 'standard' ? getState('network.myId') : null,
  });
}

function isCurrentSystemAudioRoom(expected: Readonly<SystemAudioRoomIdentity>): boolean {
  const current = getRoomContext();
  const currentRoomId =
    current.kind === 'standard'
      ? (current.roomId ?? (getState('network.sessionCode') || null))
      : current.roomId;
  return (
    current.kind === expected.kind &&
    currentRoomId === expected.roomId &&
    current.epoch === expected.epoch &&
    (expected.kind !== 'standard' || getState('network.myId') === expected.standardPeerId)
  );
}

function restoreRejectedPendingCapture(snapshot: Readonly<PreSystemAudioState>): boolean {
  if (
    _preSysAudioState !== snapshot ||
    snapshot.room.kind !== 'standard' ||
    !isCurrentSystemAudioRoom(snapshot.room) ||
    !isCoordinator()
  ) {
    return false;
  }

  const selectedQueueItemId = getState('playlist.currentQueueItemId');
  const currentTrackMeta = getState('player.currentTrackMeta');
  const capturedMetaQueueItemId = snapshot.currentTrackMeta?.queueItemId;
  if (
    selectedQueueItemId !== snapshot.queueItemId ||
    (capturedMetaQueueItemId !== undefined &&
      currentTrackMeta?.queueItemId !== undefined &&
      currentTrackMeta.queueItemId !== capturedMetaQueueItemId)
  ) {
    // A successor already owns the visible selection.
    return false;
  }

  restorePreSystemAudioPlaybackState(snapshot);
  return true;
}

interface ProLeaseAttempt {
  owner: ProSystemAudioLeaseAttempt;
  result: Promise<{ ok: true } | { ok: false; error: unknown }>;
}

function showSystemAudioDeviceLimit(): void {
  bus.emit('ui:show-toast', t('system_audio.device_limit', { count: MAX_SYSTEM_AUDIO_DEVICES }));
}

function discardPendingCapture(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function beginProLeaseAttempt(): ProLeaseAttempt {
  const owner = beginLocalProSystemAudioLeaseAttempt();
  // Convert rejection to data immediately. The native picker can remain open
  // after the request finishes, and an unobserved rejected Promise would
  // otherwise surface as a browser-level unhandled rejection.
  return {
    owner,
    result: owner.result.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  };
}

function releaseProLeaseAttempt(attempt: ProLeaseAttempt | null): void {
  if (!attempt) return;
  void attempt.owner.releaseIfCurrent().catch(() => undefined);
}

function showProLeaseFailure(error?: unknown): void {
  const view = getProSystemAudioViewState();
  const ownerName = getProSystemAudioOwnerDisplayName();
  if (view.phase === 'live' && ownerName) {
    bus.emit('ui:show-toast', t('system_audio.owner_active', { name: ownerName }));
    return;
  }
  if (view.phase === 'preparing' && ownerName) {
    bus.emit('ui:show-toast', t('system_audio.owner_preparing', { name: ownerName }));
    return;
  }
  const code = error instanceof Error ? error.message : String(error ?? '');
  if (code.includes('COORDINATOR_UPDATE_REQUIRED')) {
    showProCoordinatorUpdateRequired();
    return;
  }
  if (code.includes('DEVICE_LIMIT')) {
    showSystemAudioDeviceLimit();
    return;
  }
  bus.emit('ui:show-toast', t('system_audio.pro_publish_failed'));
}

function showProCoordinatorUpdateRequired(): void {
  bus.emit('ui:show-toast', t('system_audio.coordinator_update_required'));
}

function startSystemAudioShareLimitTimer(
  expiresAt = Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
): void {
  const remainingMs = Math.max(0, Math.min(SYSTEM_AUDIO_SHARE_LIMIT_MS, expiresAt - Date.now()));
  setManagedTimer(
    SYSTEM_AUDIO_SHARE_LIMIT_TIMER,
    () => {
      if (!_capturedStream) return;
      log.info('[SystemAudio] Host share duration limit reached');
      bus.emit('system-audio:stop', { reason: 'duration-limit' });
    },
    remainingMs,
  );
}

function syncProSystemAudioShareLimitTimer(): void {
  if (_captureRoomKind !== 'pro' || !_capturedStream) return;
  const view = getProSystemAudioViewState();
  const publication = view.publication;
  if (
    view.phase === 'live' &&
    view.isLocalOwner &&
    publication &&
    'sessionId' in publication &&
    view.liveExpiresAt !== null
  ) {
    startSystemAudioShareLimitTimer(view.liveExpiresAt);
    return;
  }
  // PRO LAN-direct uses Cloudflare only for authority/signaling and carries
  // no metered media packets, so it has no fixed sharing-duration timer.
  clearManagedTimer(SYSTEM_AUDIO_SHARE_LIMIT_TIMER);
}

function syncStandardSystemAudioShareLimitTimer(): void {
  if (_captureRoomKind !== 'standard' || !_capturedStream) return;
  const connectedPeers = getState('network.connectedPeers').filter(
    (peer) => peer.status === 'connected' && peer.conn?.open === true,
  );
  const connectedPeerIds = new Set(connectedPeers.map((peer) => peer.id));
  const hasMeteredOrUnresolvedRoute =
    getSystemAudioShareDeliverySnapshot().sfuPeerIds.some((peerId) =>
      connectedPeerIds.has(peerId),
    ) || connectedPeers.some((peer) => peer.connectionType !== 'local');
  if (hasMeteredOrUnresolvedRoute) {
    _standardMeteredRouteExpiresAt ??= Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS;
    startSystemAudioShareLimitTimer(_standardMeteredRouteExpiresAt);
    return;
  }
  // A LAN-only direct share never sends media through Cloudflare. Keep the
  // safety cutoff for remote/unknown routes, but do not stop an unmetered LAN
  // session merely because the compatibility timestamp elapsed.
  _standardMeteredRouteExpiresAt = null;
  clearManagedTimer(SYSTEM_AUDIO_SHARE_LIMIT_TIMER);
}

// ─── Public API ───────────────────────────────────────────────────

export function isSystemAudioActive(): boolean {
  return _capturedStream !== null && _capturedStream.active;
}

// Keep capture state and listener ownership in this module while exposing the
// exact predicate through the acyclic audio-policy boundary.
configureSystemAudioCaptureActivityProbe(isSystemAudioActive);

/** Return a stream containing the original captured audio track. */
export function getCapturedAudioStream(): MediaStream | null {
  const track = _capturedStream?.getAudioTracks()[0];
  if (!track) return null;
  // Every network transport is a one-original-track contract. Keep that
  // invariant even if a future browser unexpectedly exposes more than one
  // audio track for a display-capture stream.
  return new MediaStream([track]);
}

function describeTrack(track: MediaStreamTrack | undefined): string {
  if (!track) return 'none';
  return `${track.id.slice(0, 8)}:${track.readyState}${track.muted ? ':muted' : ''}`;
}

export function getSystemAudioCaptureDebugSnapshot(): Record<string, unknown> {
  const capturedTracks = _capturedStream?.getAudioTracks() || [];

  return {
    active: isSystemAudioActive(),
    capturedStreamActive: _capturedStream?.active ?? false,
    capturedTracks: capturedTracks.map(describeTrack),
    sourceNode: !!_sourceNode,
    stereoUpmix: !!_stereoUpmix,
    lastCaptureStartedAt: _debugLastCaptureStartedAt,
    lastCaptureStoppedAt: _debugLastCaptureStoppedAt,
    lastStartBroadcastAt: _debugLastStartBroadcastAt,
    lastStopBroadcastAt: _debugLastStopBroadcastAt,
    lastStreamsReadyAt: _debugLastStreamsReadyAt,
  };
}

/**
 * Start system audio capture.
 * MUST be called from a user gesture handler (click event).
 */
export async function startSystemAudioCapture(): Promise<void> {
  if (isSystemAudioActive()) {
    log.warn('[SystemAudio] Already capturing');
    return;
  }
  if (_captureStartPromise) {
    log.warn('[SystemAudio] Capture start already pending');
    return;
  }
  const startRoom = captureSystemAudioRoomIdentity();
  const isProRoom = startRoom.kind === 'pro';
  if (!isProRoom && !isCoordinator()) {
    log.warn('[SystemAudio] Capture start ignored on a non-coordinator device');
    return;
  }

  if (isProRoom) {
    const view = getProSystemAudioViewState();
    if (view.initialized && view.phase !== 'idle') {
      showProLeaseFailure();
      return;
    }
    if (!canPublishProSystemAudioWithCurrentCoordinator()) {
      showProCoordinatorUpdateRequired();
      return;
    }
  }

  // The host counts as one device. Refuse before opening the native picker
  // when four guests (five total devices) are already connected.
  if (!isProRoom && !hasSystemAudioDeviceCapacity()) {
    showSystemAudioDeviceLimit();
    return;
  }

  // Both calls begin in this user-activation turn. Waiting for the server
  // before getDisplayMedia would lose the browser's trusted click gesture.
  const proLeaseAttempt = isProRoom ? beginProLeaseAttempt() : null;
  const startEpoch = ++_captureStartEpoch;
  const attempt = performSystemAudioCaptureStart(startRoom, proLeaseAttempt, startEpoch);
  _captureStartPromise = attempt;
  try {
    await attempt;
  } finally {
    if (_captureStartPromise === attempt) _captureStartPromise = null;
  }
}

async function performSystemAudioCaptureStart(
  startRoom: Readonly<SystemAudioRoomIdentity>,
  proLeaseAttempt: ProLeaseAttempt | null,
  startEpoch: number,
): Promise<void> {
  // Freeze the file debounce before the native picker opens. The picker can
  // remain open for seconds, far longer than the 300 ms transfer debounce.
  // A rejected pre-teardown start resumes the latest valid payload. After the
  // previous media stop commits, keep the payload parked until the transition
  // either owns system audio or explicitly restores standard-room playback.
  const pendingBroadcastSuspension = beginPendingBroadcastSuspension();
  const pendingBroadcastDisposition = { shouldResume: true };
  try {
    await performSystemAudioCaptureStartWithSuspendedBroadcast(
      startRoom,
      proLeaseAttempt,
      startEpoch,
      () => {
        pendingBroadcastDisposition.shouldResume = false;
      },
      () => {
        pendingBroadcastDisposition.shouldResume = true;
      },
    );
  } finally {
    const canResumeForCurrentAuthority =
      isCurrentSystemAudioRoom(startRoom) &&
      (startRoom.kind === 'pro'
        ? canPublishProSystemAudioWithCurrentCoordinator()
        : isCoordinator());
    if (pendingBroadcastDisposition.shouldResume && canResumeForCurrentAuthority) {
      resumePendingBroadcastSuspension(pendingBroadcastSuspension);
    } else {
      discardPendingBroadcastSuspension(pendingBroadcastSuspension);
    }
  }
}

async function performSystemAudioCaptureStartWithSuspendedBroadcast(
  startRoom: Readonly<SystemAudioRoomIdentity>,
  proLeaseAttempt: ProLeaseAttempt | null,
  startEpoch: number,
  onPreviousMediaStopped: () => void,
  onPreviousMediaRestored: () => void,
): Promise<void> {
  const isProRoom = startRoom.kind === 'pro';
  let authoritativeSfuLiveExpiresAt: number | null = null;
  // 1. Capture FIRST (user gesture must be synchronous call stack)
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        channelCount: 2,
        sampleRate: 48000,
        autoGainControl: false,
        noiseSuppression: false,
        echoCancellation: false,
      },
    });
  } catch (e) {
    releaseProLeaseAttempt(proLeaseAttempt);
    if (startEpoch !== _captureStartEpoch) return;
    log.warn('[SystemAudio] getDisplayMedia denied or failed:', e);
    bus.emit('ui:show-toast', t('system_audio.capture_denied'));
    return;
  }

  // getDisplayMedia itself is not abortable. stop/leave invalidates the epoch;
  // when the native picker eventually resolves, discard its tracks and release
  // any lease instead of resurrecting a capture after teardown.
  if (startEpoch !== _captureStartEpoch) {
    releaseProLeaseAttempt(proLeaseAttempt);
    discardPendingCapture(stream);
    return;
  }
  if (!isCurrentSystemAudioRoom(startRoom)) {
    releaseProLeaseAttempt(proLeaseAttempt);
    discardPendingCapture(stream);
    return;
  }

  // Read only the coarse, standardized surface class before stopping video.
  // Never retain the track label, device id, window title, or picker text.
  const videoTracks = stream.getVideoTracks();
  let selectedSurface: SystemAudioSurface = DEFAULT_SYSTEM_AUDIO_SURFACE;
  try {
    const settings = videoTracks[0]?.getSettings() as
      | (MediaTrackSettings & { displaySurface?: unknown })
      | undefined;
    selectedSurface = normalizeSystemAudioSurface(settings?.displaySurface);
  } catch (error) {
    // Legacy engines and test doubles may reject getSettings(). Surface
    // metadata is optional, but ending every video track is not.
    log.debug('[SystemAudio] Display surface class unavailable:', error);
  }
  // Discard video as soon as the native picker completes. Only the captured
  // audio track belongs in the product graph. One broken track must not leave
  // another capture indicator alive.
  for (const videoTrack of videoTracks) {
    try {
      videoTrack.stop();
    } catch (error) {
      log.debug('[SystemAudio] Failed to stop discarded video track:', error);
    }
  }

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    releaseProLeaseAttempt(proLeaseAttempt);
    discardPendingCapture(stream);
    log.warn('[SystemAudio] No audio track');
    bus.emit('ui:show-toast', t('system_audio.no_audio_track'));
    return;
  }

  const audioTrack = audioTracks[0];
  try {
    audioTrack.contentHint = 'music';
  } catch {
    // Older capture implementations may expose contentHint as read-only.
  }
  let captureTrackEnded = false;
  let trackEndLifecycleCommitted = false;
  let trackEndedListenerAttached = false;
  const detachTrackEndedListener = (): void => {
    if (trackEndedListenerAttached) {
      audioTrack.removeEventListener('ended', onTrackEnded);
      trackEndedListenerAttached = false;
    }
    if (_captureTrackEndedCleanup === detachTrackEndedListener) {
      _captureTrackEndedCleanup = null;
    }
  };
  const onTrackEnded = (): void => {
    captureTrackEnded = true;
    if (!trackEndLifecycleCommitted) return;
    detachTrackEndedListener();
    log.info('[SystemAudio] Audio track ended (user stopped sharing)');
    // Enter the same room-wide lifecycle as the in-app Stop button. Calling
    // stopSystemAudioCapture() directly would leave host media calls, the SFU
    // publication, retry timers, and the frozen delivery policy alive.
    bus.emit('system-audio:stop');
  };
  audioTrack.addEventListener('ended', onTrackEnded);
  trackEndedListenerAttached = true;
  // The track can end after getDisplayMedia resolves but before this
  // continuation attaches its listener. Re-reading readyState closes that
  // otherwise unobservable gap.
  if (audioTrack.readyState === 'ended') onTrackEnded();

  const isSelectedCaptureTrackLive = (): boolean =>
    !captureTrackEnded && audioTrack.readyState === 'live';
  const discardSelectedCapture = (): void => {
    detachTrackEndedListener();
    discardPendingCapture(stream);
  };

  if (!isSelectedCaptureTrackLive()) {
    releaseProLeaseAttempt(proLeaseAttempt);
    discardSelectedCapture();
    return;
  }

  if (isProRoom) {
    const leaseResult = await proLeaseAttempt!.result;
    if (
      startEpoch !== _captureStartEpoch ||
      !isCurrentSystemAudioRoom(startRoom) ||
      !isSelectedCaptureTrackLive()
    ) {
      discardSelectedCapture();
      if (leaseResult.ok) releaseProLeaseAttempt(proLeaseAttempt);
      return;
    }
    if (!leaseResult.ok) {
      discardSelectedCapture();
      await refreshProLeaseFailure(leaseResult.error);
      return;
    }
    if (!canPublishProSystemAudioWithCurrentCoordinator()) {
      discardSelectedCapture();
      releaseProLeaseAttempt(proLeaseAttempt);
      showProCoordinatorUpdateRequired();
      return;
    }
  }

  // A fifth device can connect while the browser's native picker is open.
  // Standard rooms enforce locally; PRO rooms use the authoritative lease.
  if (
    !isCurrentSystemAudioRoom(startRoom) ||
    (!isProRoom && (!isCoordinator() || !hasSystemAudioDeviceCapacity()))
  ) {
    discardSelectedCapture();
    if (isProRoom) releaseProLeaseAttempt(proLeaseAttempt);
    if (!isProRoom && !hasSystemAudioDeviceCapacity()) showSystemAudioDeviceLimit();
    return;
  }

  // Initialize before snapshotting/stopping the current track. This leaves
  // the existing playback untouched if audio setup fails or capacity changes
  // during the asynchronous initialization step.
  try {
    await initAudio();
  } catch (error) {
    discardSelectedCapture();
    if (isProRoom) releaseProLeaseAttempt(proLeaseAttempt);
    throw error;
  }

  if (
    startEpoch !== _captureStartEpoch ||
    !isCurrentSystemAudioRoom(startRoom) ||
    !isSelectedCaptureTrackLive()
  ) {
    discardSelectedCapture();
    if (isProRoom) releaseProLeaseAttempt(proLeaseAttempt);
    return;
  }

  if (!isProRoom && (!isCoordinator() || !hasSystemAudioDeviceCapacity())) {
    discardSelectedCapture();
    if (!hasSystemAudioDeviceCapacity()) showSystemAudioDeviceLimit();
    return;
  }
  if (isProRoom && !canPublishProSystemAudioWithCurrentCoordinator()) {
    discardSelectedCapture();
    releaseProLeaseAttempt(proLeaseAttempt);
    showProCoordinatorUpdateRequired();
    return;
  }

  // 2. Save previous state
  // Capture stable identity instead of an array position: the occurrence may
  // move while system audio is active, while stopAllMedia preserves its ID.
  const playback = getPlaybackModeActivitySnapshot();
  const rawPositionSeconds =
    playback.activity === 'playing' || playback.activity === 'paused'
      ? getTrackPosition()
      : getState('player.pausedAt');
  const preSysAudioState: PreSystemAudioState = {
    room: startRoom,
    playback,
    positionSeconds: Number.isFinite(rawPositionSeconds) ? Math.max(0, rawPositionSeconds) : 0,
    currentTrackMeta: getState('player.currentTrackMeta'),
    claimedSystemAudioTrackMeta: null,
    channelMode: getState('audio.channelMode'),
    queueItemId: getState('playlist.currentQueueItemId'),
    subIndex: getState('youtube.currentSubIndex'),
  };
  _preSysAudioState = preSysAudioState;

  const discardPendingStart = (): void => {
    // A force-stop can release the pending-start slot and allow a newer start
    // while this teardown is still awaiting. Never erase that successor's
    // snapshot when the stale continuation eventually settles.
    if (_preSysAudioState === preSysAudioState) _preSysAudioState = null;
    discardSelectedCapture();
    if (isProRoom) releaseProLeaseAttempt(proLeaseAttempt);
  };
  const abortPreparedStart = (): void => {
    if (abortPreparedCapture(preSysAudioState)) onPreviousMediaRestored();
  };

  // 3. Stop all current media
  let stoppedPreviousMedia: boolean;
  try {
    stoppedPreviousMedia = await stopAllMediaAsync({
      silent: true,
      cancelInFlight: true,
    });
  } catch (error) {
    // The STOP contract did not commit. Release the native picker stream and
    // any PRO preparing lease while leaving the parked file eligible to
    // resume under the still-current room authority.
    discardPendingStart();
    throw error;
  }
  if (!stoppedPreviousMedia) {
    discardPendingStart();
    return;
  }
  // The previous media transition committed, so the parked file payload must
  // remain held while system audio prepares. Settlement is deferred because
  // a same-room standard rejection can still restore this exact file.
  onPreviousMediaStopped();

  // stopAllMediaAsync can wait for a renderer teardown. During that boundary
  // the user may cancel sharing, leave/switch rooms, lose coordinator
  // authority, or exceed the standard-room device limit. Revalidate every
  // start precondition before publishing any graph or playback ownership.
  const roomStillCurrent = isCurrentSystemAudioRoom(startRoom);
  const standardStillAuthorized = isProRoom || (isCoordinator() && hasSystemAudioDeviceCapacity());
  const proStillAuthorized = !isProRoom || canPublishProSystemAudioWithCurrentCoordinator();
  const captureTrackStillLive = isSelectedCaptureTrackLive();
  if (
    startEpoch !== _captureStartEpoch ||
    !roomStillCurrent ||
    !standardStillAuthorized ||
    !proStillAuthorized ||
    !captureTrackStillLive
  ) {
    // A force-stop, room transition, coordinator change, or PRO authority
    // change transfers ownership and must not resurrect local media. Only a
    // same-room standard coordinator rejected solely by the device limit can
    // safely repair the exact STOP it already published.
    const restoreRejectedStart =
      !isProRoom &&
      startEpoch === _captureStartEpoch &&
      roomStillCurrent &&
      isCoordinator() &&
      (!hasSystemAudioDeviceCapacity() || !captureTrackStillLive);
    if (restoreRejectedStart) {
      if (restoreRejectedPendingCapture(preSysAudioState)) onPreviousMediaRestored();
    }
    discardPendingStart();
    if (startEpoch === _captureStartEpoch && roomStillCurrent) {
      if (!isProRoom && !hasSystemAudioDeviceCapacity()) {
        showSystemAudioDeviceLimit();
      } else if (isProRoom && !proStillAuthorized) {
        showProCoordinatorUpdateRequired();
      }
    }
    return;
  }

  // Claim cleanup ownership before constructing the graph. WebAudio node
  // factories and connect() may still throw (for example after a device or
  // context transition), and that failure must stop the native track and
  // repair the exact standard-room STOP that already committed.
  _capturedStream = stream;
  _captureTrackEndedCleanup = detachTrackEndedListener;
  _captureRoomKind = isProRoom ? 'pro' : 'standard';
  _standardMeteredRouteExpiresAt = null;
  _debugLastCaptureStartedAt = Date.now();

  try {
    // 3.5 UI only: show stereo button as active (actual channelMode unchanged)
    syncStandardRoleControlState(0);

    // 4. Audio was initialized before changing the previous playback state.
    const ctx = getAudioContext();
    _sourceNode = ctx.createMediaStreamSource(stream);

    // 5. Local graph: upmix mono capture sources for effects while preserving
    // the untouched native capture track for every network transport.
    _stereoUpmix = ctx.createGain();
    const stereoUpmix = _stereoUpmix;
    stereoUpmix.channelCount = 2;
    stereoUpmix.channelCountMode = 'explicit';
    stereoUpmix.channelInterpretation = 'speakers';
    _sourceNode.connect(stereoUpmix);

    const widener = getWidener();
    if (!widener) {
      log.error('[SystemAudio] No widener found');
      abortPreparedStart();
      if (isProRoom) releaseProLeaseAttempt(proLeaseAttempt);
      return;
    }
    stereoUpmix.connect(widener.input);
  } catch (error) {
    abortPreparedStart();
    if (isProRoom) releaseProLeaseAttempt(proLeaseAttempt);
    throw error;
  }

  // 6. Host mute local (always mute — avoid double audio)
  muteLocalOutput(true);

  // 7. Update state
  // System audio is a real playback experience. Once it has successfully
  // started, later playlist clicks should behave like post-first-use actions
  // instead of falling back to the initial "ready, press Play" cue flow.
  setState('player.isFirstTrackLoad', false);
  const systemAudioTrackMeta = createSystemAudioTrackMeta('sharing', undefined, selectedSurface);
  preSysAudioState.claimedSystemAudioTrackMeta = systemAudioTrackMeta;
  claimPlaybackOwner('system-audio', { currentTrackMeta: systemAudioTrackMeta });

  // No dead native track may become observable as an active room share. This
  // is the final common check after graph preparation and immediately before
  // either publication path commits.
  if (
    startEpoch !== _captureStartEpoch ||
    !isCurrentSystemAudioRoom(startRoom) ||
    !isSelectedCaptureTrackLive()
  ) {
    abortPreparedStart();
    if (isProRoom) releaseProLeaseAttempt(proLeaseAttempt);
    return;
  }
  // 8. Standard rooms keep their bounded direct/SFU hybrid. PRO rooms publish
  // role-independently: prepare LAN-direct when eligible, otherwise SFU, and
  // commit the selected route through the server-authoritative lease state.
  if (isProRoom) {
    try {
      if (!canPublishProSystemAudioWithCurrentCoordinator()) {
        throw new Error('PRO_SYSTEM_AUDIO_COORDINATOR_UPDATE_REQUIRED');
      }
      const track = _capturedStream?.getAudioTracks()[0];
      if (!track) throw new Error('PRO_SYSTEM_AUDIO_TRACK_UNAVAILABLE');
      const liveState = await publishLocalProSystemAudio(track);
      if (startEpoch !== _captureStartEpoch) {
        releaseProLeaseAttempt(proLeaseAttempt);
        return;
      }
      if (
        !isCurrentSystemAudioRoom(startRoom) ||
        !isSelectedCaptureTrackLive() ||
        !canPublishProSystemAudioWithCurrentCoordinator()
      ) {
        abortPreparedStart();
        releaseProLeaseAttempt(proLeaseAttempt);
        return;
      }
      trackEndLifecycleCommitted = true;
      authoritativeSfuLiveExpiresAt =
        liveState.status === 'live' && 'sessionId' in liveState.publication
          ? liveState.liveExpiresAt
          : null;
    } catch (error) {
      if (startEpoch !== _captureStartEpoch) {
        releaseProLeaseAttempt(proLeaseAttempt);
        return;
      }
      if (!isCurrentSystemAudioRoom(startRoom) || !isSelectedCaptureTrackLive()) {
        abortPreparedStart();
        releaseProLeaseAttempt(proLeaseAttempt);
        return;
      }
      log.warn('[SystemAudio] PRO publication failed:', error);
      abortPreparedStart();
      releaseProLeaseAttempt(proLeaseAttempt);
      if (
        error instanceof Error &&
        error.message === 'PRO_SYSTEM_AUDIO_COORDINATOR_UPDATE_REQUIRED'
      ) {
        showProCoordinatorUpdateRequired();
      } else {
        showProLeaseFailure(error);
      }
      return;
    }
  } else {
    if (!isCoordinator() || !hasSystemAudioDeviceCapacity() || !isSelectedCaptureTrackLive()) {
      abortPreparedStart();
      return;
    }
    trackEndLifecycleCommitted = true;
    _debugLastStartBroadcastAt = Date.now();
    broadcast(createSystemAudioStartFrame(selectedSurface));
    _debugLastStreamsReadyAt = Date.now();
    bus.emit('system-audio:streams-ready');
    broadcastSystemMessage('chat.system_audio_started_system_message');
  }
  if (!isProRoom) {
    syncStandardSystemAudioShareLimitTimer();
  } else if (authoritativeSfuLiveExpiresAt !== null) {
    startSystemAudioShareLimitTimer(authoritativeSfuLiveExpiresAt);
  } else {
    clearManagedTimer(SYSTEM_AUDIO_SHARE_LIMIT_TIMER);
  }

  // 9. Advisory toast — latency is unavoidable, and the host's
  // desktop speakers would otherwise drown out the distributed feed.
  bus.emit('ui:show-toast', t('system_audio.started'));

  // 10. Start visualizer
  bus.emit('visualizer:start');

  log.info('[SystemAudio] Capture started (stereo-stream)');
}

/**
 * Stop system audio capture.
 *
 * `restore` controls whether the pre-share playback snapshot is restored.
 * Explicit user stops and error cleanup restore by default. Transition and
 * teardown callers pass `restore:false` because another playback flow already
 * owns the target state; restoring the snapshot would overwrite that flow.
 */
function stopSystemAudioCapture(opts?: {
  restore?: boolean;
  reason?: SystemAudioStopReason;
}): void {
  clearManagedTimer(SYSTEM_AUDIO_SHARE_LIMIT_TIMER);
  ++_captureStartEpoch;
  _captureStartPromise = null;
  if (!isSystemAudioActive() && !_capturedStream) {
    // A pending start may already have snapshotted the previous owner while
    // awaiting renderer teardown. Its local snapshot remains identity-guarded,
    // so clearing this global slot cannot clobber a later start.
    _preSysAudioState = null;
    return;
  }
  const shouldRestore = opts?.restore ?? true;
  const captureRoomKind = _captureRoomKind;

  _debugLastStopBroadcastAt = Date.now();
  if (captureRoomKind === 'pro') {
    void releaseLocalProSystemAudioLease().catch((error) => {
      log.debug('[SystemAudio] PRO lease release failed:', error);
    });
  } else {
    broadcast({ type: MSG.SYSTEM_AUDIO_STOP });
    broadcastSystemMessage('chat.system_audio_stopped_system_message');
  }
  cleanupCapture();
  _captureRoomKind = null;
  muteLocalOutput(false);

  if (shouldRestore && _preSysAudioState) {
    restorePreSystemAudioPlaybackState(_preSysAudioState);
  } else if (shouldRestore) {
    setPlaybackTrackMeta(null);
    setPlaybackIdle();
  } else {
    // Transition teardown: release system-audio ownership so the caller's
    // flow (play()/youtube:load) can claim the next mode — but do NOT touch
    // currentTrackMeta: the in-progress selection (e.g. playTrack) already
    // set the new track's meta before reaching us.
    setPlaybackIdle();
  }
  // Discard the snapshot in every path — a stale snapshot surviving a
  // transition would leak into a later explicit stop.
  _preSysAudioState = null;

  // Toast only on explicit stop. The copy promises the playlist resumes,
  // which is only (approximately) true on the restore path; on force-stop
  // transitions another flow's own UI takes over immediately and this toast
  // would stack a false claim on top of it.
  if (shouldRestore) {
    const message =
      opts?.reason === 'device-limit'
        ? t('system_audio.device_limit_stopped', { count: MAX_SYSTEM_AUDIO_DEVICES })
        : opts?.reason === 'duration-limit'
          ? t('system_audio.duration_limit_stopped')
          : t('system_audio.stopped');
    bus.emit('ui:show-toast', message);
  }
  _debugLastCaptureStoppedAt = Date.now();
  log.info('[SystemAudio] Capture stopped');
}

export function restorePreSystemAudioPlaybackState(snapshot: PreSystemAudioState): void {
  // Restore channel UI to previous selection.
  syncStandardRoleControlState(snapshot.channelMode);

  setState('player.pausedAt', snapshot.positionSeconds);
  setPlaybackTrackMeta(snapshot.currentTrackMeta ?? null);

  // YouTube was playing: restore through the room-wide YouTube command path.
  if (snapshot.playback.mode === 'youtube') {
    const meta = snapshot.currentTrackMeta;
    const queueItemId = snapshot.queueItemId ?? meta?.queueItemId ?? null;
    const item = getQueueItemById(queueItemId);
    const videoId = meta?.videoId || item?.videoId || null;
    const playlistId = meta?.playlistId || item?.playlistId || null;
    if (queueItemId && (videoId || playlistId)) {
      bus.emit('youtube:restore-room-playback', {
        videoId,
        playlistId,
        name: meta?.name || meta?.title || item?.name || item?.title || null,
        queueItemId,
        autoplay: snapshot.playback.activity === 'playing',
        positionSeconds: snapshot.positionSeconds,
        subIndex: snapshot.subIndex,
      });
    } else {
      setPlaybackFilePaused();
    }
    return;
  }

  if (snapshot.playback.activity === 'playing' || snapshot.playback.activity === 'paused') {
    setPlaybackFilePaused();
    if (
      snapshot.room.kind === 'standard' &&
      isCurrentSystemAudioRoom(snapshot.room) &&
      isCoordinator() &&
      snapshot.queueItemId
    ) {
      // Guests were transitioned to 0 before system audio took ownership.
      // Restore the exact live checkpoint captured immediately before STOP.
      broadcast({
        type: MSG.PAUSE,
        time: snapshot.positionSeconds,
        queueItemId: snapshot.queueItemId,
        reason: 'seek',
      });
    }
  } else {
    setPlaybackIdle();
  }
}

function muteLocalOutput(mute: boolean): void {
  try {
    const masterGain = getMasterGain();
    if (!masterGain) return;
    const ctx = getAudioContext();
    if (mute) masterGain.disconnect(ctx.destination);
    else masterGain.connect(ctx.destination);
  } catch (e) {
    log.debug('[SystemAudio] mute/unmute error:', e);
  }
}

// ─── Internals ────────────────────────────────────────────────────

function cleanupCapture(): void {
  _standardMeteredRouteExpiresAt = null;
  // Detach before stopping the native track so cleanup cannot recursively
  // re-enter the shared stop lifecycle in browsers that report stop as ended.
  const cleanupTrackEnded = _captureTrackEndedCleanup;
  _captureTrackEndedCleanup = null;
  cleanupTrackEnded?.();
  if (_sourceNode) {
    try {
      _sourceNode.disconnect();
    } catch {
      /* noop */
    }
    _sourceNode = null;
  }
  // Disconnect every intermediate node retained for this capture session.
  if (_stereoUpmix) {
    try {
      _stereoUpmix.disconnect();
    } catch {
      /* noop */
    }
    _stereoUpmix = null;
  }
  if (_capturedStream) {
    for (const track of _capturedStream.getTracks()) track.stop();
    _capturedStream = null;
  }
}

function abortPreparedCapture(snapshot: Readonly<PreSystemAudioState>): boolean {
  let restoredPreviousMedia = false;
  clearManagedTimer(SYSTEM_AUDIO_SHARE_LIMIT_TIMER);
  cleanupCapture();
  _captureRoomKind = null;
  muteLocalOutput(false);
  if (_preSysAudioState === snapshot) {
    if (snapshot.room.kind === 'pro') {
      // PRO playback truth is server-authoritative. Once the prior media STOP
      // has committed, a local-only rollback (file or YouTube) would
      // fork this device from the room. Until an authoritative PRO resume
      // command exists, publication/setup aborts must remain fail-closed.
      const attemptOwnedMeta =
        snapshot.claimedSystemAudioTrackMeta ?? snapshot.currentTrackMeta ?? null;
      if (getState('player.currentTrackMeta') === attemptOwnedMeta) {
        setPlaybackTrackMeta(null);
        setPlaybackIdle();
      }
    } else {
      restorePreSystemAudioPlaybackState(snapshot);
      restoredPreviousMedia = true;
    }
    _preSysAudioState = null;
  } else if (!isSystemAudioActive()) {
    setPlaybackIdle();
  }
  return restoredPreviousMedia;
}

async function refreshProLeaseFailure(error: unknown): Promise<void> {
  // Acquisition errors may carry the winner only in the next authoritative
  // read. The controller already refreshes best-effort; yield once so its
  // resolved view can produce a useful owner-specific message.
  await Promise.resolve();
  showProLeaseFailure(error);
}

// ─── Bus Listeners ────────────────────────────────────────────────

export function registerSystemCaptureListeners(): void {
  const stopAfterCoordinatorAuthorityLoss = (): void => {
    if (!_capturedStream || _captureRoomKind === 'pro' || isCoordinator()) return;
    log.info('[SystemAudio] Coordinator authority lost; force-stopping active share');
    bus.emit('system-audio:force-stop');
  };

  bus.on('system-audio:start', () => {
    startSystemAudioCapture().catch((e) => {
      log.error('[SystemAudio] Unhandled error in startSystemAudioCapture:', e);
      // A late setup failure can happen after streams-ready. Route every
      // failure through the shared stop lifecycle so direct/SFU resources and
      // the frozen delivery policy are not left behind.
      bus.emit('system-audio:stop');
    });
  });
  bus.on('system-audio:stop', (options) => {
    stopSystemAudioCapture(options);
  });
  // force-stop is transition/teardown semantics: another flow is taking over,
  // so the pre-share snapshot must not be restored.
  bus.on('system-audio:force-stop', () => {
    stopSystemAudioCapture({ restore: false });
  });
  bus.on('network:peer-connected', () => {
    if (_captureRoomKind === 'pro') return;
    if (!isCoordinator()) return;
    if (!_capturedStream || hasSystemAudioDeviceCapacity()) return;
    log.info('[SystemAudio] Device limit exceeded; stopping active share');
    bus.emit('system-audio:stop', { reason: 'device-limit' });
  });
  bus.on('network:peer-connected', syncStandardSystemAudioShareLimitTimer);
  bus.on('network:peer-disconnected', syncStandardSystemAudioShareLimitTimer);
  bus.on('state:network.connectedPeers', syncStandardSystemAudioShareLimitTimer);
  bus.on('orchestrator:peer-joined', syncStandardSystemAudioShareLimitTimer);
  bus.on('orchestrator:peer-evaluated', syncStandardSystemAudioShareLimitTimer);
  bus.on('system-audio:sfu-peer-needed', syncStandardSystemAudioShareLimitTimer);
  bus.on('state:room.context', stopAfterCoordinatorAuthorityLoss);
  bus.on('state:network.appRole', stopAfterCoordinatorAuthorityLoss);
  bus.on('state:network.hostConn', stopAfterCoordinatorAuthorityLoss);
  // A live PRO publication can promote one-way from LAN-direct to SFU after a
  // late/non-local participant arrives. Arm the two-hour host cutoff only
  // from that authenticated route state, and disarm it for direct.
  bus.on('pro-system-audio:state-changed', syncProSystemAudioShareLimitTimer);
  bus.on('pro-system-audio:lease-lost', (reason) => {
    if (_captureRoomKind !== 'pro' || !_capturedStream) return;
    log.info(`[SystemAudio] PRO lease lost (${reason}); stopping local capture`);
    if (reason === 'reset' || reason === 'session-changed') {
      bus.emit('system-audio:force-stop');
    } else {
      // The share ended while this room remains active. Resume the exact
      // pre-share item instead of leaving the former owner on an idle screen.
      bus.emit('system-audio:stop');
    }
  });
}
