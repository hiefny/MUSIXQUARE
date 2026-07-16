import { initAudio, getWidener } from '../audio/engine.ts';
import { getAudioContext } from '../audio/context.ts';
import { broadcastSystemMessage } from '../chat/protocol.ts';
import { SYSTEM_AUDIO_SHARE_LIMIT_MS, MSG } from '../core/constants.ts';
import { bus } from '../core/events.ts';
import { log } from '../core/log.ts';
import { getState } from '../core/state.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import {
  onProSystemAudioSfuEvent,
  publishProSystemAudioSfu,
  stopProSystemAudioSfuPublisher,
  stopProSystemAudioSfuSubscriber,
  subscribeProSystemAudioSfu,
  updateProSystemAudioSfuPublisherExpiry,
  type ProSystemAudioSfuPublicationDescriptor,
} from '../network/pro-system-audio-sfu.ts';
import { cleanupSystemAudioSfuGuestRoute } from '../network/system-audio-sfu.ts';
import { registerHandler } from '../network/protocol.ts';
import { broadcast, broadcastExcept, safeSend, sendToHost } from '../network/peer-state.ts';
import {
  beginTrustedSystemAudioReception,
  cleanupGuestSystemAudio,
} from '../network/system-audio-guest.ts';
import {
  cleanupWebRtcAudioDecoderPrimer,
  getAudioTrackStreamKey,
  primeWebRtcAudioDecoder,
  type WebRtcAudioDecoderPrimer,
} from '../network/webrtc-audio-decoder-primer.ts';
import { claimPlaybackOwner, setSystemAudioReceiving } from '../player/ownership.ts';
import {
  isAuthoritativeConnection,
  isCoordinator,
  verifyPeerCapability,
} from '../rooms/authority.ts';
import type { DataConnection, ProtocolMsg } from '../types/index.ts';
import type { ProRoomApiClient } from './api.ts';
import type {
  ProRoomSnapshot,
  ProRoomSystemAudioPublication,
  ProRoomSystemAudioState,
} from './contracts.ts';
import {
  ProRoomSystemAudioController,
  ProRoomSystemAudioControllerError,
  type ProRoomSystemAudioLeaseLossReason,
  type ProRoomSystemAudioViewState,
} from './system-audio-controller.ts';
import { configureProSystemAudioBridge } from './system-audio-bridge.ts';

const LEASE_HEARTBEAT_TIMER = 'pro-system-audio-lease-heartbeat';
const LEASE_RELEASE_RETRY_TIMER = 'pro-system-audio-lease-release-retry';
const SUBSCRIBER_RETRY_TIMER = 'pro-system-audio-subscriber-retry';
const PUBLISHER_RETRY_TIMER = 'pro-system-audio-publisher-retry';
const LEASE_HEARTBEAT_MS = 15_000;
const RECOVERY_DELAY_MS = 2_500;

let controller: ProRoomSystemAudioController | null = null;
let latestSnapshot: ProRoomSnapshot | null = null;
let latestView: ProRoomSystemAudioViewState = idleView();
let remoteOwnerDisplayName: string | null = null;
let refreshFlight: Promise<ProRoomSystemAudioState> | null = null;
let listenersRegistered = false;
let lastCoordinatorEpoch = -1;
let lastFanoutKey = '';
let legacyShareLive = false;
let legacyShareOwnerParticipantId: string | null = null;
let expectedLeaseTransition = false;
let localTracks: { left: MediaStreamTrack; right: MediaStreamTrack } | null = null;
let localPublicationId: string | null = null;
let publisherRecoveryInFlight = false;
let boundSessionKey: string | null = null;
let lastObservedState: Pick<ProRoomSystemAudioState, 'generation' | 'status'> | null = null;
let leaseHeartbeatFailureNotified = false;
let subscriberFailureGeneration: number | null = null;

interface CoordinatorSupportProof {
  connection: DataConnection;
  sessionKey: string;
  coordinatorEpoch: number;
  coordinatorParticipantId: string;
}

let coordinatorSupportProof: CoordinatorSupportProof | null = null;

let coordinatorSourceL: MediaStreamAudioSourceNode | null = null;
let coordinatorSourceR: MediaStreamAudioSourceNode | null = null;
let coordinatorMerger: ChannelMergerNode | null = null;
let coordinatorReceivingGeneration: number | null = null;
const coordinatorPrimers = new Map<'L' | 'R', WebRtcAudioDecoderPrimer>();

function idleView(): ProRoomSystemAudioViewState {
  return {
    roomCode: null,
    initialized: false,
    phase: 'idle',
    generation: null,
    ownerParticipantId: null,
    isLocalOwner: false,
    localRequestPending: false,
    canStart: false,
    canStop: false,
    claimExpiresAt: null,
    liveExpiresAt: null,
    publication: null,
  };
}

function isActiveProRoom(): boolean {
  return getState('room.context').kind === 'pro' && latestSnapshot?.status === 'active';
}

function localParticipantId(): string | null {
  return latestSnapshot?.viewer?.participantId ?? null;
}

function clearCoordinatorSupportProof(): void {
  coordinatorSupportProof = null;
}

/**
 * A member may publish only after its exact authoritative connection has sent
 * a validated v1 state frame. This prevents a mixed-version room from
 * accepting a role-independent SFU publication that an older coordinator
 * cannot relay. The proof is intentionally scoped to one room incarnation and
 * coordinator epoch; reconnects and handoffs must negotiate it again.
 */
function canPublishProSystemAudioWithCurrentCoordinator(): boolean {
  if (!isActiveProRoom()) return false;
  if (isCoordinator()) return true;
  const snapshot = latestSnapshot;
  const proof = coordinatorSupportProof;
  const hostConnection = getState('network.hostConn');
  const coordinatorParticipantId = snapshot?.presence.coordinatorParticipantId ?? null;
  return Boolean(
    snapshot?.viewer &&
    proof &&
    hostConnection?.open &&
    proof.connection === hostConnection &&
    proof.sessionKey === boundSessionKey &&
    proof.coordinatorEpoch === snapshot.presence.coordinatorEpoch &&
    proof.coordinatorParticipantId === coordinatorParticipantId,
  );
}

function ownerDisplayName(state: ProRoomSystemAudioState | null): string | null {
  if (!state || state.status === 'idle') return null;
  return (
    latestSnapshot?.presence.participants.find(
      (participant) => participant.participantId === state.ownerParticipantId,
    )?.displayName ??
    remoteOwnerDisplayName ??
    state.ownerParticipantId
  );
}

function wireState(state: ProRoomSystemAudioState): ProtocolMsg<typeof MSG.PRO_SYSTEM_AUDIO_STATE> {
  return {
    type: MSG.PRO_SYSTEM_AUDIO_STATE,
    version: 1,
    generation: state.generation,
    status: state.status,
    ownerParticipantId: state.ownerParticipantId,
    ownerDisplayName: ownerDisplayName(state),
    claimExpiresAt: state.claimExpiresAt,
    liveExpiresAt: state.liveExpiresAt,
    publication: state.publication,
  };
}

function stateFromWire(
  data: ProtocolMsg<typeof MSG.PRO_SYSTEM_AUDIO_STATE>,
): ProRoomSystemAudioState {
  if (data.status === 'idle') {
    return {
      generation: data.generation,
      status: 'idle',
      ownerParticipantId: null,
      claimExpiresAt: null,
      liveExpiresAt: null,
      publication: null,
    };
  }
  if (data.status === 'preparing') {
    return {
      generation: data.generation,
      status: 'preparing',
      ownerParticipantId: data.ownerParticipantId!,
      claimExpiresAt: data.claimExpiresAt!,
      liveExpiresAt: null,
      publication: null,
    };
  }
  return {
    generation: data.generation,
    status: 'live',
    ownerParticipantId: data.ownerParticipantId!,
    claimExpiresAt: null,
    liveExpiresAt: data.liveExpiresAt!,
    publication: {
      publicationId: data.publication!.publicationId,
      sessionId: data.publication!.sessionId,
      tracks: data.publication!.tracks.map((track) => ({
        ...track,
      })) as ProRoomSystemAudioPublication['tracks'],
    },
  };
}

function legacyReadyMessage(
  state: Extract<ProRoomSystemAudioState, { status: 'live' }>,
): ProtocolMsg<typeof MSG.SYSTEM_AUDIO_SFU_READY> {
  return {
    type: MSG.SYSTEM_AUDIO_SFU_READY,
    version: 1,
    audience: 'all',
    sessionId: state.publication.sessionId,
    tracks: state.publication.tracks.map((track) => ({ ...track })),
  };
}

function fanoutKey(state: ProRoomSystemAudioState): string {
  return `${state.generation}:${state.status}:${state.publication?.publicationId ?? '-'}`;
}

function sendLegacyToPeer(conn: DataConnection, state: ProRoomSystemAudioState): void {
  if (state.status !== 'live') return;
  if (conn.peer === state.ownerParticipantId) return;
  safeSend(conn, { type: MSG.SYSTEM_AUDIO_START });
  safeSend(conn, legacyReadyMessage(state));
}

function broadcastAuthoritativeState(state: ProRoomSystemAudioState): void {
  const wire = wireState(state);
  broadcast(wire);
  if (state.status === 'live') {
    const start: ProtocolMsg<typeof MSG.SYSTEM_AUDIO_START> = { type: MSG.SYSTEM_AUDIO_START };
    const ready = legacyReadyMessage(state);
    if (state.ownerParticipantId === localParticipantId()) {
      broadcast(start);
      broadcast(ready);
    } else {
      broadcastExcept(state.ownerParticipantId, start);
      broadcastExcept(state.ownerParticipantId, ready);
    }
    legacyShareLive = true;
    legacyShareOwnerParticipantId = state.ownerParticipantId;
  } else if (legacyShareLive) {
    if (legacyShareOwnerParticipantId) {
      broadcastExcept(legacyShareOwnerParticipantId, { type: MSG.SYSTEM_AUDIO_STOP });
    } else {
      broadcast({ type: MSG.SYSTEM_AUDIO_STOP });
    }
    legacyShareLive = false;
    legacyShareOwnerParticipantId = null;
  }
}

function notifyMutation(state: ProRoomSystemAudioState): void {
  if (isCoordinator()) {
    // The controller observer already reconciles every accepted transition.
    // Keep the idempotency key here so a coordinator-owned mutation cannot
    // deliver duplicate START/READY frames and restart receivers twice.
    void reconcileCoordinatorState(state);
    return;
  }
  sendToHost({ type: MSG.PRO_SYSTEM_AUDIO_HINT, generation: state.generation });
}

function clearCoordinatorPrimers(): void {
  for (const primer of coordinatorPrimers.values()) cleanupWebRtcAudioDecoderPrimer(primer);
  coordinatorPrimers.clear();
}

function cleanupCoordinatorGraph(): void {
  clearManagedTimer(SUBSCRIBER_RETRY_TIMER);
  for (const node of [coordinatorSourceL, coordinatorSourceR, coordinatorMerger]) {
    try {
      node?.disconnect();
    } catch {
      /* already disconnected */
    }
  }
  coordinatorSourceL = null;
  coordinatorSourceR = null;
  coordinatorMerger = null;
  coordinatorReceivingGeneration = null;
  clearCoordinatorPrimers();
  stopProSystemAudioSfuSubscriber();
  if (getState('playback.mode') === 'system-audio' && !latestView.isLocalOwner) {
    cleanupGuestSystemAudio();
  }
}

async function attachCoordinatorTrack(
  generation: number,
  channel: 'L' | 'R',
  track: MediaStreamTrack,
): Promise<void> {
  await initAudio();
  const state = controller?.getCurrentState();
  if (
    !state ||
    state.status !== 'live' ||
    state.generation !== generation ||
    !isCoordinator() ||
    state.ownerParticipantId === localParticipantId()
  ) {
    return;
  }
  const ctx = getAudioContext();
  const widener = getWidener();
  if (!widener) throw new Error('PRO_SYSTEM_AUDIO_GRAPH_UNAVAILABLE');
  if (!coordinatorMerger) {
    coordinatorMerger = ctx.createChannelMerger(2);
    coordinatorMerger.connect(widener.input);
  }
  const previous = channel === 'L' ? coordinatorSourceL : coordinatorSourceR;
  try {
    previous?.disconnect();
  } catch {
    /* already disconnected */
  }
  const primer = primeWebRtcAudioDecoder(
    coordinatorPrimers.get(channel) ?? null,
    [track],
    getAudioTrackStreamKey(`pro-sfu:${channel}`, [track]),
    channel,
    '[ProSysAudio]',
  );
  if (primer) coordinatorPrimers.set(channel, primer);
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  source.connect(coordinatorMerger, 0, channel === 'L' ? 0 : 1);
  if (channel === 'L') coordinatorSourceL = source;
  else coordinatorSourceR = source;
  coordinatorReceivingGeneration = generation;
  setSystemAudioReceiving(true);
  claimPlaybackOwner('system-audio');
  bus.emit('visualizer:start');
}

function sfuDescriptor(
  state: Extract<ProRoomSystemAudioState, { status: 'live' }>,
): ProSystemAudioSfuPublicationDescriptor {
  return {
    version: 1,
    sessionId: state.publication.sessionId,
    tracks: state.publication.tracks.map((track) => ({ ...track })),
    generation: state.generation,
    expiresAt: state.liveExpiresAt,
  };
}

async function ensureCoordinatorSubscription(
  state: Extract<ProRoomSystemAudioState, { status: 'live' }>,
): Promise<void> {
  if (!isActiveProRoom() || !isCoordinator()) return;
  cleanupSystemAudioSfuGuestRoute();
  if (subscriberFailureGeneration !== null && subscriberFailureGeneration !== state.generation) {
    subscriberFailureGeneration = null;
  }
  if (state.ownerParticipantId === localParticipantId()) {
    cleanupCoordinatorGraph();
    return;
  }
  if (coordinatorReceivingGeneration !== state.generation) {
    cleanupCoordinatorGraph();
    beginTrustedSystemAudioReception();
  }
  await subscribeProSystemAudioSfu(sfuDescriptor(state));
  subscriberFailureGeneration = null;
}

function notifySubscriberFailure(
  state: Extract<ProRoomSystemAudioState, { status: 'live' }>,
): void {
  if (subscriberFailureGeneration === state.generation) return;
  subscriberFailureGeneration = state.generation;
  const name = ownerDisplayName(state) ?? state.ownerParticipantId;
  bus.emit('ui:show-toast', t('system_audio.connection_unstable', { name }));
}

async function reconcileCoordinatorState(state: ProRoomSystemAudioState): Promise<void> {
  if (!isActiveProRoom() || !isCoordinator()) return;
  if (state.status === 'live') {
    void ensureCoordinatorSubscription(state).catch((error) => {
      log.warn('[PRO SystemAudio] Coordinator subscription failed', error);
      notifySubscriberFailure(state);
      clearManagedTimer(SUBSCRIBER_RETRY_TIMER);
      setManagedTimer(
        SUBSCRIBER_RETRY_TIMER,
        () => {
          const latest = controller?.getCurrentState();
          if (latest?.status === 'live') void ensureCoordinatorSubscription(latest);
        },
        RECOVERY_DELAY_MS,
      );
    });
  } else {
    cleanupCoordinatorGraph();
    subscriberFailureGeneration = null;
  }
  const nextKey = fanoutKey(state);
  if (lastFanoutKey === nextKey) return;
  lastFanoutKey = nextKey;
  broadcastAuthoritativeState(state);
}

function onControllerState(view: ProRoomSystemAudioViewState): void {
  latestView = view;
  const state = controller?.getCurrentState() ?? null;
  const previous = lastObservedState;
  if (state) {
    if (isActiveProRoom() && isCoordinator() && previous) {
      if (
        previous.status === 'live' &&
        (state.status !== 'live' || state.generation !== previous.generation)
      ) {
        broadcastSystemMessage('chat.system_audio_stopped_system_message');
      }
      if (
        state.status === 'live' &&
        (previous.status !== 'live' || previous.generation !== state.generation)
      ) {
        broadcastSystemMessage('chat.system_audio_started_system_message');
      }
    }
    lastObservedState = { generation: state.generation, status: state.status };
  } else {
    lastObservedState = null;
  }
  bus.emit(
    'pro-system-audio:state-changed',
    {
      roomCode: view.roomCode,
      initialized: view.initialized,
      phase: view.phase,
      generation: view.generation,
      ownerParticipantId: view.ownerParticipantId,
      isLocalOwner: view.isLocalOwner,
      localRequestPending: view.localRequestPending,
      canStart: view.canStart,
      canStop: view.canStop,
      claimExpiresAt: view.claimExpiresAt,
      liveExpiresAt: view.liveExpiresAt,
    },
    ownerDisplayName(state),
  );
  if (state && isCoordinator()) void reconcileCoordinatorState(state);
}

function onLocalLeaseLost(reason: ProRoomSystemAudioLeaseLossReason): void {
  clearManagedTimer(LEASE_HEARTBEAT_TIMER);
  clearManagedTimer(LEASE_RELEASE_RETRY_TIMER);
  clearManagedTimer(PUBLISHER_RETRY_TIMER);
  stopProSystemAudioSfuPublisher();
  localPublicationId = null;
  if (expectedLeaseTransition) return;
  localTracks = null;
  leaseHeartbeatFailureNotified = false;
  bus.emit('pro-system-audio:lease-lost', reason);
}

export function configureProSystemAudioService(api: ProRoomApiClient): void {
  if (controller) return;
  controller = new ProRoomSystemAudioController(api, {
    state: onControllerState,
    localLeaseLost: onLocalLeaseLost,
  });
  configureProSystemAudioBridge({
    acquire: acquireLocalProSystemAudioLease,
    publish: publishLocalProSystemAudio,
    release: releaseLocalProSystemAudioLease,
    view: getProSystemAudioViewState,
    ownerDisplayName: getProSystemAudioOwnerDisplayName,
    isLocalOwner: isLocalProSystemAudioOwner,
    coordinatorSupportsPublishing: canPublishProSystemAudioWithCurrentCoordinator,
  });
}

export function bindProSystemAudioSession(snapshot: ProRoomSnapshot): void {
  const nextSessionKey = snapshot.viewer
    ? `${snapshot.roomCode}:${snapshot.viewer.participantId}:${snapshot.viewer.presenceIncarnationId}`
    : null;
  if (boundSessionKey !== nextSessionKey) {
    // A request issued for the previous tab incarnation must never suppress
    // the first authoritative refresh for the newly bound incarnation.
    refreshFlight = null;
    boundSessionKey = nextSessionKey;
    clearCoordinatorSupportProof();
  }
  const coordinatorChanged =
    latestSnapshot?.presence.coordinatorEpoch !== snapshot.presence.coordinatorEpoch ||
    latestSnapshot?.presence.coordinatorParticipantId !==
      snapshot.presence.coordinatorParticipantId;
  if (coordinatorChanged) clearCoordinatorSupportProof();
  latestSnapshot = snapshot;
  remoteOwnerDisplayName = null;
  if (lastCoordinatorEpoch !== snapshot.presence.coordinatorEpoch) {
    lastCoordinatorEpoch = snapshot.presence.coordinatorEpoch;
    lastFanoutKey = '';
  }
  controller?.bindSession(snapshot);
  const state = controller?.getCurrentState();
  if (state && isCoordinator()) void reconcileCoordinatorState(state);
}

export function resetProSystemAudioService(): void {
  clearManagedTimer(LEASE_HEARTBEAT_TIMER);
  clearManagedTimer(LEASE_RELEASE_RETRY_TIMER);
  clearManagedTimer(SUBSCRIBER_RETRY_TIMER);
  clearManagedTimer(PUBLISHER_RETRY_TIMER);
  cleanupCoordinatorGraph();
  stopProSystemAudioSfuPublisher();
  controller?.reset();
  latestSnapshot = null;
  latestView = idleView();
  remoteOwnerDisplayName = null;
  refreshFlight = null;
  lastCoordinatorEpoch = -1;
  lastFanoutKey = '';
  legacyShareLive = false;
  legacyShareOwnerParticipantId = null;
  localTracks = null;
  localPublicationId = null;
  publisherRecoveryInFlight = false;
  boundSessionKey = null;
  lastObservedState = null;
  leaseHeartbeatFailureNotified = false;
  subscriberFailureGeneration = null;
  clearCoordinatorSupportProof();
}

export function getProSystemAudioViewState(): ProRoomSystemAudioViewState {
  return {
    ...latestView,
    publication: latestView.publication
      ? {
          ...latestView.publication,
          tracks: latestView.publication.tracks.map((track) => ({
            ...track,
          })) as ProRoomSystemAudioPublication['tracks'],
        }
      : null,
  };
}

export function getProSystemAudioOwnerDisplayName(): string | null {
  return ownerDisplayName(controller?.getCurrentState() ?? null);
}

export function isLocalProSystemAudioOwner(): boolean {
  return latestView.isLocalOwner;
}

export function refreshProSystemAudioState(signal?: AbortSignal): Promise<ProRoomSystemAudioState> {
  if (!controller) return Promise.reject(new Error('PRO_SYSTEM_AUDIO_NOT_CONFIGURED'));
  if (refreshFlight) return refreshFlight;
  const flight = controller.refreshProSystemAudioState(signal).finally(() => {
    if (refreshFlight === flight) refreshFlight = null;
  });
  refreshFlight = flight;
  return flight;
}

export async function acquireLocalProSystemAudioLease(
  signal?: AbortSignal,
): Promise<ProRoomSystemAudioState> {
  if (!controller) throw new Error('PRO_SYSTEM_AUDIO_NOT_CONFIGURED');
  if (!canPublishProSystemAudioWithCurrentCoordinator()) {
    throw new Error('PRO_SYSTEM_AUDIO_COORDINATOR_UPDATE_REQUIRED');
  }
  if (!controller.getCurrentState()) await refreshProSystemAudioState(signal);
  try {
    const state = await controller.acquireProSystemAudioLease(signal);
    notifyMutation(state);
    return state;
  } catch (error) {
    if (
      error instanceof ProRoomSystemAudioControllerError &&
      error.code === 'OWNED_BY_ANOTHER_PARTICIPANT'
    ) {
      throw error;
    }
    await refreshProSystemAudioState(signal).catch(() => undefined);
    throw error;
  }
}

function scheduleLeaseHeartbeat(delayMs = LEASE_HEARTBEAT_MS): void {
  clearManagedTimer(LEASE_HEARTBEAT_TIMER);
  setManagedTimer(
    LEASE_HEARTBEAT_TIMER,
    () => {
      const lease = controller?.getCurrentLease();
      if (!lease || lease.status !== 'live') return;
      void controller!
        .heartbeatProSystemAudioLease()
        .then((state) => {
          leaseHeartbeatFailureNotified = false;
          notifyMutation(state);
          if (controller?.getCurrentLease()?.status === 'live') {
            scheduleLeaseHeartbeat();
          }
        })
        .catch((error) => {
          log.warn('[PRO SystemAudio] Lease heartbeat failed', error);
          if (!leaseHeartbeatFailureNotified) {
            leaseHeartbeatFailureNotified = true;
            const name = ownerDisplayName(controller?.getCurrentState() ?? null) ?? 'Peer';
            bus.emit('ui:show-toast', t('system_audio.connection_unstable', { name }));
          }
          scheduleLeaseHeartbeat(RECOVERY_DELAY_MS);
        });
    },
    delayMs,
  );
}

export async function publishLocalProSystemAudio(
  leftTrack: MediaStreamTrack,
  rightTrack: MediaStreamTrack,
): Promise<ProRoomSystemAudioState> {
  if (!controller) throw new Error('PRO_SYSTEM_AUDIO_NOT_CONFIGURED');
  if (!canPublishProSystemAudioWithCurrentCoordinator()) {
    throw new Error('PRO_SYSTEM_AUDIO_COORDINATOR_UPDATE_REQUIRED');
  }
  const lease = controller.getCurrentLease();
  if (!lease || lease.status !== 'preparing') throw new Error('PRO_SYSTEM_AUDIO_LEASE_UNAVAILABLE');
  localTracks = { left: leftTrack, right: rightTrack };
  localPublicationId = localPublicationId ?? crypto.randomUUID();
  try {
    const descriptor = await publishProSystemAudioSfu({
      leftTrack,
      rightTrack,
      generation: lease.generation,
      expiresAt: Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
      roomId: lease.roomCode,
    });
    const publication: ProRoomSystemAudioPublication = {
      publicationId: localPublicationId,
      sessionId: descriptor.sessionId,
      tracks: descriptor.tracks.map((track) => ({
        ...track,
      })) as ProRoomSystemAudioPublication['tracks'],
    };
    const state = await controller.commitProSystemAudioPublication(publication);
    if (state.status === 'live') {
      updateProSystemAudioSfuPublisherExpiry(state.liveExpiresAt);
    }
    notifyMutation(state);
    clearManagedTimer(PUBLISHER_RETRY_TIMER);
    leaseHeartbeatFailureNotified = false;
    scheduleLeaseHeartbeat();
    return state;
  } catch (error) {
    stopProSystemAudioSfuPublisher();
    localTracks = null;
    localPublicationId = null;
    await releaseLocalProSystemAudioLease().catch(() => undefined);
    throw error;
  }
}

export async function releaseLocalProSystemAudioLease(): Promise<ProRoomSystemAudioState | null> {
  clearManagedTimer(LEASE_HEARTBEAT_TIMER);
  clearManagedTimer(LEASE_RELEASE_RETRY_TIMER);
  clearManagedTimer(PUBLISHER_RETRY_TIMER);
  leaseHeartbeatFailureNotified = false;
  stopProSystemAudioSfuPublisher();
  localTracks = null;
  localPublicationId = null;
  if (!controller?.getCurrentLease()) return controller?.getCurrentState() ?? null;
  expectedLeaseTransition = true;
  try {
    const state = await controller.releaseProSystemAudioLease();
    notifyMutation(state);
    return state;
  } catch (error) {
    // The publication is already closed locally, but a dropped release
    // response must not strand a live owner record until its two-hour TTL.
    // Keep the controller's private credential and retry only while it still
    // identifies the same live/preparing lease.
    if (controller.getCurrentLease()) {
      setManagedTimer(
        LEASE_RELEASE_RETRY_TIMER,
        () => {
          void releaseLocalProSystemAudioLease().catch((retryError) =>
            log.warn('[PRO SystemAudio] Lease release retry failed', retryError),
          );
        },
        RECOVERY_DELAY_MS,
      );
    }
    throw error;
  } finally {
    expectedLeaseTransition = false;
  }
}

async function recoverLocalPublisher(): Promise<void> {
  if (publisherRecoveryInFlight || !localTracks || !controller?.getCurrentLease()) return;
  publisherRecoveryInFlight = true;
  const tracks = localTracks;
  const name = latestSnapshot?.viewer?.displayName ?? 'Peer';
  bus.emit('ui:show-toast', t('system_audio.connection_unstable', { name }));
  expectedLeaseTransition = true;
  try {
    const idle = await controller.releaseProSystemAudioLease();
    notifyMutation(idle);
    const preparing = await controller.acquireProSystemAudioLease();
    notifyMutation(preparing);
    localPublicationId = null;
    localTracks = tracks;
    await publishLocalProSystemAudio(tracks.left, tracks.right);
  } catch (error) {
    log.warn('[PRO SystemAudio] Publisher recovery failed', error);
    localTracks = null;
    localPublicationId = null;
    await releaseLocalProSystemAudioLease().catch((releaseError) =>
      log.warn('[PRO SystemAudio] Failed to release after publisher recovery', releaseError),
    );
    bus.emit('pro-system-audio:lease-lost', 'publisher-failed');
  } finally {
    expectedLeaseTransition = false;
    publisherRecoveryInFlight = false;
  }
}

export function registerProSystemAudioServiceListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  registerHandler(MSG.PRO_SYSTEM_AUDIO_HINT, (_data, conn) => {
    if (!isActiveProRoom() || !isCoordinator() || !verifyPeerCapability(conn, 'queue.mutate'))
      return;
    void refreshProSystemAudioState().catch((error) =>
      log.warn('[PRO SystemAudio] Coordinator refresh from hint failed', error),
    );
  });

  registerHandler(MSG.PRO_SYSTEM_AUDIO_STATE, (data, conn) => {
    if (!isActiveProRoom() || isCoordinator() || !isAuthoritativeConnection(conn)) return;
    remoteOwnerDisplayName = data.ownerDisplayName;
    try {
      controller?.acceptProSystemAudioState(stateFromWire(data));
      const snapshot = latestSnapshot;
      const coordinatorParticipantId = snapshot?.presence.coordinatorParticipantId ?? null;
      if (snapshot?.viewer && boundSessionKey && coordinatorParticipantId) {
        coordinatorSupportProof = {
          connection: conn,
          sessionKey: boundSessionKey,
          coordinatorEpoch: snapshot.presence.coordinatorEpoch,
          coordinatorParticipantId,
        };
      }
    } catch (error) {
      log.warn('[PRO SystemAudio] Rejected coordinator state', error);
    }
  });

  bus.on('network:peer-connected', (conn) => {
    if (!isActiveProRoom() || !isCoordinator()) return;
    void refreshProSystemAudioState()
      .catch(() => controller?.getCurrentState() ?? null)
      .then((state) => {
        if (!state) return;
        safeSend(conn, wireState(state));
        sendLegacyToPeer(conn, state);
      });
  });

  bus.on('state:room.context', () => {
    const currentContext = getState('room.context');
    if (currentContext.kind !== 'pro') {
      clearCoordinatorSupportProof();
      cleanupCoordinatorGraph();
      subscriberFailureGeneration = null;
      legacyShareLive = false;
      legacyShareOwnerParticipantId = null;
      return;
    }
    lastFanoutKey = '';
    if (isCoordinator()) {
      cleanupSystemAudioSfuGuestRoute();
      const state = controller?.getCurrentState();
      if (state) void reconcileCoordinatorState(state);
      void refreshProSystemAudioState()
        .then((next) => reconcileCoordinatorState(next))
        .catch(() => undefined);
    } else {
      cleanupCoordinatorGraph();
      subscriberFailureGeneration = null;
      legacyShareLive = false;
      legacyShareOwnerParticipantId = null;
    }
  });

  bus.on('state:network.hostConn', (hostConnection) => {
    if (isCoordinator() || coordinatorSupportProof?.connection === hostConnection) return;
    clearCoordinatorSupportProof();
  });

  onProSystemAudioSfuEvent((event) => {
    if (event.type === 'subscriber-track') {
      void attachCoordinatorTrack(event.descriptor.generation, event.channel, event.track).catch(
        (error) => log.warn('[PRO SystemAudio] Track attach failed', error),
      );
      return;
    }
    if (event.type === 'subscriber-state' && event.state === 'failed') {
      const state = controller?.getCurrentState();
      if (state?.status !== 'live' || !isCoordinator()) return;
      notifySubscriberFailure(state);
      setManagedTimer(
        SUBSCRIBER_RETRY_TIMER,
        () => {
          const current = controller?.getCurrentState();
          if (current?.status === 'live') void ensureCoordinatorSubscription(current);
        },
        RECOVERY_DELAY_MS,
      );
      return;
    }
    if (event.type === 'publisher-state' && event.state === 'failed') {
      setManagedTimer(PUBLISHER_RETRY_TIMER, () => void recoverLocalPublisher(), RECOVERY_DELAY_MS);
    }
  });
}
