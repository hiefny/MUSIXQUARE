/**
 * MUSIXQUARE — System Audio Capture
 *
 * Host-side module for capturing system audio via getDisplayMedia.
 * Splits into L/R mono MediaStreams for WebRTC transmission
 * (bypasses Chrome Opus mono limitation via dual-stream approach).
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
import { t } from '../i18n/index.ts';
import { getAudioContext } from './context.ts';
import { initAudio, getWidener, getMasterGain } from './engine.ts';
import {
  applyLegacyBoundedV1HostPausedCheckpoint,
  getTrackPosition,
  stopAllMediaAsync,
} from '../player/transport.ts';
import {
  claimPlaybackOwner,
  createSystemAudioTrackMeta,
  getPlaybackModeActivitySnapshot,
  setPlaybackFilePaused,
  setPlaybackIdle,
  setPlaybackTrackMeta,
} from '../player/ownership.ts';
import { broadcast } from '../network/peer.ts';
import { broadcastSystemMessage } from '../chat/protocol.ts';
import { getQueueItemById } from '../player/queue-model.ts';
import { getRoomContext, isCoordinator } from '../rooms/authority.ts';
import { hasSystemAudioDeviceCapacity } from './system-audio-policy.ts';
import type { QueueItemId, SystemAudioStopReason, TrackMeta } from '../types/index.ts';
import {
  acquireLocalProSystemAudioLease,
  canPublishProSystemAudioWithCurrentCoordinator,
  getProSystemAudioOwnerDisplayName,
  getProSystemAudioViewState,
  publishLocalProSystemAudio,
  releaseLocalProSystemAudioLease,
} from '../pro-room/system-audio-bridge.ts';
import { legacyBoundedFileV1Product } from '../player/legacy-bounded-file-v1-product.ts';

// ─── Module State ─────────────────────────────────────────────────

type SystemAudioRoomIdentity = Readonly<{
  kind: 'standard' | 'pro';
  roomId: string | null;
  epoch: number;
  standardPeerId: string | null;
}>;

let _capturedStream: MediaStream | null = null;
let _sourceNode: MediaStreamAudioSourceNode | null = null;
let _streamL: MediaStream | null = null;
let _streamR: MediaStream | null = null;
let _destL: MediaStreamAudioDestinationNode | null = null;
let _destR: MediaStreamAudioDestinationNode | null = null;
// Retain intermediate graph nodes so cleanupCapture can disconnect every
// connection created by a capture session.
let _splitter: ChannelSplitterNode | null = null;
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
  channelMode: number;
  queueItemId: QueueItemId | null;
  subIndex: number;
  bounded: Readonly<{
    role: 'host' | 'guest';
    queueItemId: QueueItemId;
    legacySessionId: number;
    positionSeconds: number;
    durationSeconds: number;
  }> | null;
}

let _preSysAudioState: PreSystemAudioState | null = null;
let _captureStartPromise: Promise<void> | null = null;
let _captureStartEpoch = 0;
let _captureRoomKind: 'standard' | 'pro' | null = null;
const SYSTEM_AUDIO_SHARE_LIMIT_TIMER = 'system-audio-host-share-limit';

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

function capturePreSystemAudioBoundedState(): PreSystemAudioState['bounded'] {
  const snapshot = legacyBoundedFileV1Product.snapshot();
  const current = snapshot.current;
  const queueItemId = getState('playlist.currentQueueItemId');
  const playback = getPlaybackModeActivitySnapshot();
  if (
    playback.mode !== 'file' ||
    (playback.activity !== 'playing' && playback.activity !== 'paused') ||
    !snapshot.active ||
    (snapshot.role !== 'host' && snapshot.role !== 'guest') ||
    !current ||
    current.state !== 'ready' ||
    current.queueItemId !== queueItemId ||
    !Number.isFinite(current.durationSeconds) ||
    (current.durationSeconds ?? 0) <= 0
  ) {
    return null;
  }

  const livePosition = legacyBoundedFileV1Product.positionSeconds();
  const pausedAt = getState('player.pausedAt');
  const positionSeconds =
    current.phase === 'stopped'
      ? pausedAt
      : livePosition !== null && Number.isFinite(livePosition)
        ? livePosition
        : current.positionSeconds;
  return Object.freeze({
    role: snapshot.role,
    queueItemId: current.queueItemId,
    legacySessionId: current.legacySessionId,
    positionSeconds: Math.min(
      current.durationSeconds!,
      Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0,
    ),
    durationSeconds: current.durationSeconds!,
  });
}

type RestorableBoundedState = Readonly<{
  role: 'host' | 'guest';
  queueItemId: QueueItemId;
  legacySessionId: number;
  positionSeconds: number;
  durationSeconds: number;
  trackMeta: TrackMeta;
}>;

function readLiveRestorableBoundedState(): RestorableBoundedState | null {
  const snapshot = legacyBoundedFileV1Product.snapshot();
  const current = snapshot.current;
  const selectedQueueItemId = getState('playlist.currentQueueItemId');
  const selected = getQueueItemById(current?.queueItemId);
  if (
    !snapshot.active ||
    (snapshot.role !== 'host' && snapshot.role !== 'guest') ||
    !current ||
    current.state !== 'ready' ||
    current.queueItemId !== selectedQueueItemId ||
    !selected ||
    selected.type !== 'file' ||
    !Number.isFinite(current.durationSeconds) ||
    (current.durationSeconds ?? 0) <= 0
  ) {
    return null;
  }

  const durationSeconds = current.durationSeconds!;
  const livePosition = legacyBoundedFileV1Product.positionSeconds();
  const positionSeconds =
    current.phase === 'stopped'
      ? current.positionSeconds
      : livePosition !== null && Number.isFinite(livePosition)
        ? livePosition
        : current.positionSeconds;
  return Object.freeze({
    role: snapshot.role,
    queueItemId: current.queueItemId,
    legacySessionId: current.legacySessionId,
    positionSeconds: Math.min(
      durationSeconds,
      Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0,
    ),
    durationSeconds,
    trackMeta: selected,
  });
}

function projectRestorableBoundedState(
  bounded: RestorableBoundedState,
  positionSeconds = bounded.positionSeconds,
  trackMeta: TrackMeta = bounded.trackMeta,
): void {
  setState('playlist.currentQueueItemId', bounded.queueItemId);
  setState('player.pausedAt', Math.min(bounded.durationSeconds, positionSeconds));
  setPlaybackTrackMeta(trackMeta);
  setPlaybackFilePaused();
  bus.emit('ui:duration-update', bounded.durationSeconds);
  bus.emit('ui:play-btn-state', true);
}

async function compensateStandardBoundedCheckpoint(
  snapshot: Readonly<PreSystemAudioState>,
  captured: NonNullable<PreSystemAudioState['bounded']>,
  isOperationCurrent: () => boolean,
): Promise<boolean> {
  if (
    !isOperationCurrent() ||
    isSystemAudioActive() ||
    captured.role !== 'host' ||
    snapshot.room.kind !== 'standard' ||
    !isCurrentSystemAudioRoom(snapshot.room) ||
    !isCoordinator()
  ) {
    return false;
  }
  const live = readLiveRestorableBoundedState();
  if (
    !live ||
    live.role !== captured.role ||
    live.queueItemId !== captured.queueItemId ||
    live.legacySessionId !== captured.legacySessionId ||
    getState('playlist.currentQueueItemId') !== captured.queueItemId
  ) {
    return false;
  }

  const restoredPosition = Math.min(live.durationSeconds, captured.positionSeconds);
  const compensation = applyLegacyBoundedV1HostPausedCheckpoint(
    captured.queueItemId,
    captured.legacySessionId,
    restoredPosition,
  );
  const applied = compensation ? await compensation : false;
  const restoredLive = readLiveRestorableBoundedState();
  const remainsExact =
    isOperationCurrent() &&
    !isSystemAudioActive() &&
    isCurrentSystemAudioRoom(snapshot.room) &&
    isCoordinator() &&
    restoredLive?.role === captured.role &&
    restoredLive.queueItemId === captured.queueItemId &&
    restoredLive.legacySessionId === captured.legacySessionId &&
    getState('playlist.currentQueueItemId') === captured.queueItemId;
  if (!remainsExact || !restoredLive) return false;

  if (!applied) {
    // Guests already hold the transition STOP. Keep the host on the same
    // product checkpoint instead of displaying an uncommitted local N.
    const productCurrent = legacyBoundedFileV1Product.snapshot().current;
    const productPosition =
      productCurrent?.queueItemId === captured.queueItemId &&
      productCurrent.legacySessionId === captured.legacySessionId &&
      Number.isFinite(productCurrent.positionSeconds)
        ? Math.max(0, productCurrent.positionSeconds)
        : 0;
    projectRestorableBoundedState(
      restoredLive,
      Math.min(restoredLive.durationSeconds, productPosition),
      snapshot.currentTrackMeta ?? restoredLive.trackMeta,
    );
    return false;
  }

  projectRestorableBoundedState(
    restoredLive,
    restoredPosition,
    snapshot.currentTrackMeta ?? restoredLive.trackMeta,
  );
  broadcast({
    type: MSG.PAUSE,
    time: restoredPosition,
    queueItemId: captured.queueItemId,
    reason: 'seek',
  });
  return true;
}

async function restoreRejectedPendingCapture(
  snapshot: Readonly<PreSystemAudioState>,
): Promise<void> {
  if (
    _preSysAudioState !== snapshot ||
    snapshot.room.kind !== 'standard' ||
    !isCurrentSystemAudioRoom(snapshot.room) ||
    !isCoordinator()
  ) {
    return;
  }

  const captured = snapshot.bounded;
  if (captured) {
    // Host-only projection is forbidden: stopAllMediaAsync() already sent
    // transition PAUSE(0) to guests. Rebuild the exact product checkpoint
    // first, then publish only while the same standard-room authority remains.
    await compensateStandardBoundedCheckpoint(
      snapshot,
      captured,
      () => _preSysAudioState === snapshot,
    );
    return;
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
    // A non-bounded successor already owns the visible selection.
    return;
  }

  restorePreSystemAudioPlaybackState(snapshot);
}

type ProLeaseAttempt = Promise<{ ok: true } | { ok: false; error: unknown }>;

function showSystemAudioDeviceLimit(): void {
  bus.emit('ui:show-toast', t('system_audio.device_limit', { count: MAX_SYSTEM_AUDIO_DEVICES }));
}

function discardPendingCapture(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function beginProLeaseAttempt(): ProLeaseAttempt {
  // Convert rejection to data immediately. The native picker can remain open
  // after the request finishes, and an unobserved rejected Promise would
  // otherwise surface as a browser-level unhandled rejection.
  return acquireLocalProSystemAudioLease().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function releaseProLeaseAttempt(attempt: ProLeaseAttempt | null): void {
  if (!attempt) return;
  void attempt.then((result) => {
    if (result.ok) void releaseLocalProSystemAudioLease().catch(() => undefined);
  });
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

// ─── Public API ───────────────────────────────────────────────────

export function isSystemAudioActive(): boolean {
  return _capturedStream !== null && _capturedStream.active;
}

/** Get the L track stream */
export function getStreamL(): MediaStream | null {
  return _streamL;
}
/** Get the R track stream */
export function getStreamR(): MediaStream | null {
  return _streamR;
}

/** Get the original captured audio track as a stereo stream for local P2P fallback. */
export function getCapturedAudioStream(): MediaStream | null {
  const tracks = _capturedStream?.getAudioTracks() || [];
  if (tracks.length === 0) return null;
  return new MediaStream(tracks);
}

function describeTrack(track: MediaStreamTrack | undefined): string {
  if (!track) return 'none';
  return `${track.id.slice(0, 8)}:${track.readyState}${track.muted ? ':muted' : ''}`;
}

export function getSystemAudioCaptureDebugSnapshot(): Record<string, unknown> {
  const capturedTracks = _capturedStream?.getAudioTracks() || [];
  const leftTracks = _streamL?.getAudioTracks() || [];
  const rightTracks = _streamR?.getAudioTracks() || [];

  return {
    active: isSystemAudioActive(),
    capturedStreamActive: _capturedStream?.active ?? false,
    capturedTracks: capturedTracks.map(describeTrack),
    sourceNode: !!_sourceNode,
    splitter: !!_splitter,
    stereoUpmix: !!_stereoUpmix,
    destL: !!_destL,
    destR: !!_destR,
    streamLActive: _streamL?.active ?? false,
    streamRActive: _streamR?.active ?? false,
    streamLTracks: leftTracks.map(describeTrack),
    streamRTracks: rightTracks.map(describeTrack),
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
  const isProRoom = startRoom.kind === 'pro';
  let authoritativeLiveExpiresAt: number | null = null;
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

  // Discard video as soon as the native picker completes. Only the captured
  // audio track belongs in the product graph.
  for (const vt of stream.getVideoTracks()) vt.stop();

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    releaseProLeaseAttempt(proLeaseAttempt);
    discardPendingCapture(stream);
    log.warn('[SystemAudio] No audio track');
    bus.emit('ui:show-toast', t('system_audio.no_audio_track'));
    return;
  }

  if (isProRoom) {
    const leaseResult = await proLeaseAttempt!;
    if (startEpoch !== _captureStartEpoch || !isCurrentSystemAudioRoom(startRoom)) {
      discardPendingCapture(stream);
      if (leaseResult.ok) void releaseLocalProSystemAudioLease().catch(() => undefined);
      return;
    }
    if (!leaseResult.ok) {
      discardPendingCapture(stream);
      await refreshProLeaseFailure(leaseResult.error);
      return;
    }
    if (!canPublishProSystemAudioWithCurrentCoordinator()) {
      discardPendingCapture(stream);
      void releaseLocalProSystemAudioLease().catch(() => undefined);
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
    discardPendingCapture(stream);
    if (isProRoom) void releaseLocalProSystemAudioLease().catch(() => undefined);
    if (!isProRoom && !hasSystemAudioDeviceCapacity()) showSystemAudioDeviceLimit();
    return;
  }

  // Initialize before snapshotting/stopping the current track. This leaves
  // the existing playback untouched if audio setup fails or capacity changes
  // during the asynchronous initialization step.
  try {
    await initAudio();
  } catch (error) {
    discardPendingCapture(stream);
    if (isProRoom) void releaseLocalProSystemAudioLease().catch(() => undefined);
    throw error;
  }

  if (startEpoch !== _captureStartEpoch || !isCurrentSystemAudioRoom(startRoom)) {
    discardPendingCapture(stream);
    if (isProRoom) void releaseLocalProSystemAudioLease().catch(() => undefined);
    return;
  }

  if (!isProRoom && (!isCoordinator() || !hasSystemAudioDeviceCapacity())) {
    discardPendingCapture(stream);
    if (!hasSystemAudioDeviceCapacity()) showSystemAudioDeviceLimit();
    return;
  }
  if (isProRoom && !canPublishProSystemAudioWithCurrentCoordinator()) {
    discardPendingCapture(stream);
    void releaseLocalProSystemAudioLease().catch(() => undefined);
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
    bounded: capturePreSystemAudioBoundedState(),
    positionSeconds: Number.isFinite(rawPositionSeconds) ? Math.max(0, rawPositionSeconds) : 0,
    currentTrackMeta: getState('player.currentTrackMeta'),
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
    discardPendingCapture(stream);
    if (isProRoom) void releaseLocalProSystemAudioLease().catch(() => undefined);
  };

  // 3. Stop all current media
  const stoppedPreviousMedia = await stopAllMediaAsync({
    silent: true,
    cancelInFlight: true,
  });
  if (!stoppedPreviousMedia) {
    discardPendingStart();
    return;
  }

  // stopAllMediaAsync can wait for a renderer teardown. During that boundary
  // the user may cancel sharing, leave/switch rooms, lose coordinator
  // authority, or exceed the standard-room device limit. Revalidate every
  // start precondition before publishing any graph or playback ownership.
  const roomStillCurrent = isCurrentSystemAudioRoom(startRoom);
  const standardStillAuthorized = isProRoom || (isCoordinator() && hasSystemAudioDeviceCapacity());
  const proStillAuthorized = !isProRoom || canPublishProSystemAudioWithCurrentCoordinator();
  if (
    startEpoch !== _captureStartEpoch ||
    !roomStillCurrent ||
    !standardStillAuthorized ||
    !proStillAuthorized
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
      !hasSystemAudioDeviceCapacity();
    if (restoreRejectedStart) {
      await restoreRejectedPendingCapture(preSysAudioState);
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

  // 3.5 UI only: show stereo button as active (actual channelMode unchanged)
  try {
    document
      .querySelectorAll('#grid-standard .ch-opt')
      .forEach((el) => el.classList.remove('active'));
    document.querySelector('#grid-standard .ch-opt[data-ch="0"]')?.classList.add('active');
  } catch {
    /* noop */
  }

  // 4. Audio was initialized before changing the previous playback state.
  const ctx = getAudioContext();
  _capturedStream = stream;
  _captureRoomKind = isProRoom ? 'pro' : 'standard';
  _debugLastCaptureStartedAt = Date.now();
  _sourceNode = ctx.createMediaStreamSource(stream);

  // 5. Connect to L and R mono MediaStream destinations for synced P2P
  _splitter = ctx.createChannelSplitter(2);
  const splitter = _splitter;
  _sourceNode.connect(splitter);

  _destL = ctx.createMediaStreamDestination();
  _destL.channelCount = 1;
  _destL.channelCountMode = 'explicit';
  splitter.connect(_destL, 0);
  _streamL = _destL.stream;

  _destR = ctx.createMediaStreamDestination();
  _destR.channelCount = 1;
  _destR.channelCountMode = 'explicit';
  splitter.connect(_destR, 1);
  _streamR = _destR.stream;

  log.info(
    `[SystemAudio] L/R mono streams created for synced P2P: L=${_streamL.id.slice(0, 8)}, R=${_streamR.id.slice(0, 8)}`,
  );

  // 6. Local graph: upmix for safety
  _stereoUpmix = ctx.createGain();
  const stereoUpmix = _stereoUpmix;
  stereoUpmix.channelCount = 2;
  stereoUpmix.channelCountMode = 'explicit';
  stereoUpmix.channelInterpretation = 'speakers';
  _sourceNode.connect(stereoUpmix);

  const widener = getWidener();
  if (widener) {
    stereoUpmix.connect(widener.input);
  } else {
    log.error('[SystemAudio] No widener found');
    abortPreparedCapture(startEpoch, preSysAudioState);
    if (isProRoom) void releaseLocalProSystemAudioLease().catch(() => undefined);
    return;
  }

  // 7. Host mute local (always mute — avoid double audio)
  muteLocalOutput(true);

  // 8. Update state
  // System audio is a real playback experience. Once it has successfully
  // started, later playlist clicks should behave like post-first-use actions
  // instead of falling back to the initial "ready, press Play" cue flow.
  setState('player.isFirstTrackLoad', false);
  claimPlaybackOwner('system-audio', {
    currentTrackMeta: createSystemAudioTrackMeta('sharing'),
  });
  // 9. Standard rooms keep their bounded direct/SFU hybrid. PRO rooms publish
  // role-independently and only expose the public descriptor after the SFU
  // session and the server-side lease have both committed.
  if (isProRoom) {
    try {
      if (!canPublishProSystemAudioWithCurrentCoordinator()) {
        throw new Error('PRO_SYSTEM_AUDIO_COORDINATOR_UPDATE_REQUIRED');
      }
      const leftTrack = _streamL?.getAudioTracks()[0];
      const rightTrack = _streamR?.getAudioTracks()[0];
      if (!leftTrack || !rightTrack) throw new Error('PRO_SYSTEM_AUDIO_TRACKS_UNAVAILABLE');
      const liveState = await publishLocalProSystemAudio(leftTrack, rightTrack);
      if (startEpoch !== _captureStartEpoch) {
        void releaseLocalProSystemAudioLease().catch(() => undefined);
        return;
      }
      authoritativeLiveExpiresAt = liveState.status === 'live' ? liveState.liveExpiresAt : null;
    } catch (error) {
      if (startEpoch !== _captureStartEpoch) {
        void releaseLocalProSystemAudioLease().catch(() => undefined);
        return;
      }
      log.warn('[SystemAudio] PRO publication failed:', error);
      abortPreparedCapture(startEpoch, preSysAudioState);
      void releaseLocalProSystemAudioLease().catch(() => undefined);
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
    _debugLastStartBroadcastAt = Date.now();
    broadcast({ type: MSG.SYSTEM_AUDIO_START });
    _debugLastStreamsReadyAt = Date.now();
    bus.emit('system-audio:streams-ready');
    broadcastSystemMessage('chat.system_audio_started_system_message');
  }
  startSystemAudioShareLimitTimer(authoritativeLiveExpiresAt ?? undefined);

  // 10. Advisory toast — latency is unavoidable, and the host's
  // desktop speakers would otherwise drown out the distributed feed.
  bus.emit('ui:show-toast', t('system_audio.started'));

  // 11. Start visualizer
  bus.emit('visualizer:start');

  // 11. Listen for browser "Stop sharing" button
  // Use a named function so cleanupCapture can remove it (prevents
  // recursive reentry: explicit stop → track.stop() → ended → stop again).
  const onTrackEnded = (): void => {
    audioTracks[0].removeEventListener('ended', onTrackEnded);
    log.info('[SystemAudio] Audio track ended (user stopped sharing)');
    // Enter the same room-wide lifecycle as the in-app Stop button. Calling
    // stopSystemAudioCapture() directly would leave host media calls, the SFU
    // publication, retry timers, and the frozen delivery policy alive.
    bus.emit('system-audio:stop');
  };
  audioTracks[0].addEventListener('ended', onTrackEnded);

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
  const restoreEpoch = ++_captureStartEpoch;
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
    restorePreSystemAudioPlaybackState(_preSysAudioState, {
      isCurrent: () => _captureStartEpoch === restoreEpoch && !isSystemAudioActive(),
    });
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

export function restorePreSystemAudioPlaybackState(
  snapshot: PreSystemAudioState,
  options: Readonly<{ isCurrent?: () => boolean }> = {},
): void {
  // Restore channel UI to previous selection.
  try {
    document
      .querySelectorAll('#grid-standard .ch-opt')
      .forEach((el) => el.classList.remove('active'));
    document
      .querySelector(`#grid-standard .ch-opt[data-ch="${snapshot.channelMode}"]`)
      ?.classList.add('active');
  } catch {
    /* noop */
  }

  if (snapshot.bounded) {
    const live = readLiveRestorableBoundedState();
    const exact =
      live?.role === snapshot.bounded.role &&
      live.queueItemId === snapshot.bounded.queueItemId &&
      live.legacySessionId === snapshot.bounded.legacySessionId &&
      getState('playlist.currentQueueItemId') === snapshot.bounded.queueItemId;
    if (live && exact) {
      const restoredPosition = Math.min(live.durationSeconds, snapshot.bounded.positionSeconds);
      if (
        snapshot.bounded.role === 'host' &&
        snapshot.room.kind === 'standard' &&
        isCurrentSystemAudioRoom(snapshot.room) &&
        isCoordinator()
      ) {
        const productCurrent = legacyBoundedFileV1Product.snapshot().current;
        const productPosition =
          productCurrent?.queueItemId === snapshot.bounded.queueItemId &&
          productCurrent.legacySessionId === snapshot.bounded.legacySessionId &&
          Number.isFinite(productCurrent.positionSeconds)
            ? Math.max(0, productCurrent.positionSeconds)
            : 0;
        // Guests currently hold this physical STOP checkpoint. Project it
        // locally first so a failed compensation remains consistent; the
        // async helper is the sole writer allowed to promote the room to N.
        projectRestorableBoundedState(
          live,
          Math.min(live.durationSeconds, productPosition),
          snapshot.currentTrackMeta ?? live.trackMeta,
        );
        void compensateStandardBoundedCheckpoint(
          snapshot,
          snapshot.bounded,
          options.isCurrent ?? (() => true),
        );
        return;
      }
      projectRestorableBoundedState(
        live,
        restoredPosition,
        snapshot.currentTrackMeta ?? live.trackMeta,
      );
      return;
    }
    if (live && !exact) {
      // A newer bounded occurrence became authoritative while capture owned
      // the output. Project that live source, never the captured incarnation.
      projectRestorableBoundedState(live);
      return;
    }

    const selectedQueueItemId = getState('playlist.currentQueueItemId');
    const selectedTrackMeta = getState('player.currentTrackMeta');
    const hasSuccessorUi =
      (selectedQueueItemId !== null && selectedQueueItemId !== snapshot.bounded.queueItemId) ||
      (selectedTrackMeta?.queueItemId !== undefined &&
        selectedTrackMeta.queueItemId !== snapshot.bounded.queueItemId);
    if (hasSuccessorUi) {
      // Release system-audio ownership without erasing a successor that has
      // not yet published its own ready bounded source.
      setPlaybackIdle();
      return;
    }

    // The captured bounded source disappeared and no successor owns the UI.
    // Fail closed instead of fabricating duration/position from stale state.
    setPlaybackTrackMeta(null);
    setPlaybackIdle();
    bus.emit('ui:play-btn-state', false);
    return;
  }

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
  const masterGain = getMasterGain();
  const ctx = getAudioContext();
  if (!masterGain) return;

  try {
    if (mute) masterGain.disconnect(ctx.destination);
    else masterGain.connect(ctx.destination);
  } catch (e) {
    log.debug('[SystemAudio] mute/unmute error:', e);
  }
}

// ─── Internals ────────────────────────────────────────────────────

function cleanupCapture(): void {
  if (_sourceNode) {
    try {
      _sourceNode.disconnect();
    } catch {
      /* noop */
    }
    _sourceNode = null;
  }
  // Disconnect every intermediate node retained for this capture session.
  if (_splitter) {
    try {
      _splitter.disconnect();
    } catch {
      /* noop */
    }
    _splitter = null;
  }
  if (_stereoUpmix) {
    try {
      _stereoUpmix.disconnect();
    } catch {
      /* noop */
    }
    _stereoUpmix = null;
  }
  if (_destL) {
    try {
      _destL.disconnect();
    } catch {
      /* noop */
    }
    _destL = null;
  }
  if (_destR) {
    try {
      _destR.disconnect();
    } catch {
      /* noop */
    }
    _destR = null;
  }
  _streamL = null;
  _streamR = null;
  if (_capturedStream) {
    for (const track of _capturedStream.getTracks()) track.stop();
    _capturedStream = null;
  }
}

function abortPreparedCapture(startEpoch: number, snapshot: Readonly<PreSystemAudioState>): void {
  clearManagedTimer(SYSTEM_AUDIO_SHARE_LIMIT_TIMER);
  cleanupCapture();
  _captureRoomKind = null;
  muteLocalOutput(false);
  if (_preSysAudioState === snapshot) {
    if (snapshot.room.kind === 'pro') {
      // PRO playback truth is server-authoritative. Once the prior media STOP
      // has committed, a local-only rollback (file, bounded, or YouTube) would
      // fork this device from the room. Until an authoritative PRO resume
      // command exists, publication/setup aborts must remain fail-closed.
      setPlaybackIdle();
    } else {
      restorePreSystemAudioPlaybackState(snapshot, {
        isCurrent: () => _captureStartEpoch === startEpoch && !isSystemAudioActive(),
      });
    }
    _preSysAudioState = null;
  } else if (!isSystemAudioActive()) {
    setPlaybackIdle();
  }
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
  bus.on('state:room.context', stopAfterCoordinatorAuthorityLoss);
  bus.on('state:network.appRole', stopAfterCoordinatorAuthorityLoss);
  bus.on('state:network.hostConn', stopAfterCoordinatorAuthorityLoss);
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
