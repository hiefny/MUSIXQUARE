import { initAudio, getWidener } from '../audio/engine.ts';
import { getAudioContext } from '../audio/context.ts';
import { broadcastSystemMessage } from '../chat/protocol.ts';
import { SYSTEM_AUDIO_SHARE_LIMIT_MS } from '../core/constants.ts';
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
import {
  awaitTrustedSystemAudioReceptionBoundary,
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
import {
  configureProSystemAudioBridge,
  type ProSystemAudioLeaseAttempt,
} from './system-audio-bridge.ts';

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
let serviceSessionEpoch = 0;
const expectedLeaseTransitions = new Map<number, number>();
let localTracks: { left: MediaStreamTrack; right: MediaStreamTrack } | null = null;
let localPublicationId: string | null = null;
let localPublishFlight: {
  epoch: number;
  token: symbol;
  controller: ProRoomSystemAudioController;
  identity: LocalLeaseIdentity;
  recoveryToken: symbol | null;
} | null = null;
let publisherRecoveryFlight: PublisherRecoveryFlight | null = null;
let boundSessionKey: string | null = null;
let leaseHeartbeatFailureNotified = false;
let subscriberFailureGeneration: number | null = null;
let localLeaseAttemptOwner: LocalLeaseAttemptOwner | null = null;

let coordinatorSourceL: MediaStreamAudioSourceNode | null = null;
let coordinatorSourceR: MediaStreamAudioSourceNode | null = null;
let coordinatorMerger: ChannelMergerNode | null = null;
let coordinatorSubscriptionKey: string | null = null;
let coordinatorSubscriptionFlight: { key: string; promise: Promise<void> } | null = null;
const coordinatorPrimers = new Map<'L' | 'R', WebRtcAudioDecoderPrimer>();

interface LocalLeaseIdentity {
  epoch: number;
  roomCode: string;
  generation: number;
}

interface LocalLeaseAttemptOwner {
  token: symbol;
  epoch: number;
  controller: ProRoomSystemAudioController | null;
  identity: LocalLeaseIdentity | null;
}

interface CoordinatorPublicationIdentity {
  epoch: number;
  roomCode: string;
  generation: number;
  ownerParticipantId: string;
  liveExpiresAt: number;
  publicationId: string;
  sessionId: string;
  tracks: ProRoomSystemAudioPublication['tracks'];
}

interface PublisherRecoveryFlight {
  epoch: number;
  token: symbol;
  controller: ProRoomSystemAudioController;
  initialLease: LocalLeaseIdentity;
  abortController: AbortController;
}

function beginExpectedLeaseTransition(epoch: number): void {
  expectedLeaseTransitions.set(epoch, (expectedLeaseTransitions.get(epoch) ?? 0) + 1);
}

function endExpectedLeaseTransition(epoch: number): void {
  const count = expectedLeaseTransitions.get(epoch) ?? 0;
  if (count <= 1) expectedLeaseTransitions.delete(epoch);
  else expectedLeaseTransitions.set(epoch, count - 1);
}

function isServiceSessionCurrent(epoch: number): boolean {
  return epoch === serviceSessionEpoch;
}

function isLocalLeaseCurrent(identity: LocalLeaseIdentity): boolean {
  if (!isServiceSessionCurrent(identity.epoch)) return false;
  const lease = controller?.getCurrentLease();
  return Boolean(
    lease &&
    lease.hasCredential &&
    lease.roomCode === identity.roomCode &&
    lease.generation === identity.generation,
  );
}

function ownsLocalPublishFlight(flight: NonNullable<typeof localPublishFlight>): boolean {
  return (
    localPublishFlight?.token === flight.token &&
    controller === flight.controller &&
    isServiceSessionCurrent(flight.epoch)
  );
}

function captureCoordinatorPublicationIdentity(
  state: Extract<ProRoomSystemAudioState, { status: 'live' }>,
): CoordinatorPublicationIdentity | null {
  const roomCode = latestSnapshot?.roomCode;
  if (!roomCode) return null;
  return {
    epoch: serviceSessionEpoch,
    roomCode,
    generation: state.generation,
    ownerParticipantId: state.ownerParticipantId,
    liveExpiresAt: state.liveExpiresAt,
    publicationId: state.publication.publicationId,
    sessionId: state.publication.sessionId,
    tracks: state.publication.tracks.map((track) => ({
      ...track,
    })) as ProRoomSystemAudioPublication['tracks'],
  };
}

function coordinatorPublicationMatches(
  identity: CoordinatorPublicationIdentity,
  state: ProRoomSystemAudioState | null = controller?.getCurrentState() ?? null,
): state is Extract<ProRoomSystemAudioState, { status: 'live' }> {
  if (
    !isActiveProRoom() ||
    !isServiceSessionCurrent(identity.epoch) ||
    latestSnapshot?.roomCode !== identity.roomCode ||
    !state ||
    state.status !== 'live' ||
    state.generation !== identity.generation ||
    state.ownerParticipantId !== identity.ownerParticipantId ||
    state.liveExpiresAt !== identity.liveExpiresAt ||
    state.publication.publicationId !== identity.publicationId ||
    state.publication.sessionId !== identity.sessionId
  ) {
    return false;
  }
  return identity.tracks.every((expected) => {
    const current = state.publication.tracks.find((track) => track.channel === expected.channel);
    return (
      current?.trackName === expected.trackName && (current.mid ?? null) === (expected.mid ?? null)
    );
  });
}

function descriptorMatchesPublication(
  descriptor: ProSystemAudioSfuPublicationDescriptor,
  state: Extract<ProRoomSystemAudioState, { status: 'live' }>,
): boolean {
  if (
    descriptor.generation !== state.generation ||
    descriptor.sessionId !== state.publication.sessionId ||
    descriptor.expiresAt !== state.liveExpiresAt
  ) {
    return false;
  }
  return descriptor.tracks.every((expected) => {
    const current = state.publication.tracks.find((track) => track.channel === expected.channel);
    return (
      current?.trackName === expected.trackName && (current.mid ?? null) === (expected.mid ?? null)
    );
  });
}

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

function canPublishProSystemAudioWithCurrentCoordinator(): boolean {
  return Boolean(
    isActiveProRoom() && latestSnapshot?.viewer?.capabilities.includes('playback.control'),
  );
}

function coordinatorPublicationKey(identity: CoordinatorPublicationIdentity): string {
  return JSON.stringify([
    identity.epoch,
    identity.roomCode,
    identity.generation,
    identity.ownerParticipantId,
    identity.liveExpiresAt,
    identity.publicationId,
    identity.sessionId,
    identity.tracks,
  ]);
}

function ownsPublisherRecovery(flight: PublisherRecoveryFlight): boolean {
  return (
    publisherRecoveryFlight?.token === flight.token &&
    controller === flight.controller &&
    isServiceSessionCurrent(flight.epoch)
  );
}

function cancelPublisherRecovery(abort = true): void {
  const flight = publisherRecoveryFlight;
  if (!flight) return;
  publisherRecoveryFlight = null;
  if (abort) flight.abortController.abort();
}

function terminateOwnedPublisherRecovery(
  flight: PublisherRecoveryFlight,
  tracks: { left: MediaStreamTrack; right: MediaStreamTrack },
): void {
  if (
    !ownsPublisherRecovery(flight) ||
    localTracks?.left !== tracks.left ||
    localTracks.right !== tracks.right
  ) {
    return;
  }
  const state = flight.controller.getCurrentState();
  const reason =
    state &&
    state.status !== 'idle' &&
    state.ownerParticipantId !== latestSnapshot?.viewer?.participantId
      ? 'authoritative-revocation'
      : 'publisher-failed';
  stopProSystemAudioSfuPublisher();
  localPublishFlight = null;
  localTracks = null;
  localPublicationId = null;
  leaseHeartbeatFailureNotified = false;
  publisherRecoveryFlight = null;
  bus.emit('pro-system-audio:lease-lost', reason);
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

function notifyMutation(state: ProRoomSystemAudioState): void {
  // The Durable Object broadcasts a state invalidation. Reconcile locally as
  // well so the initiating endpoint does not wait for the WebSocket echo.
  void reconcileCoordinatorState(state);
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
  coordinatorSubscriptionKey = null;
  coordinatorSubscriptionFlight = null;
  clearCoordinatorPrimers();
  stopProSystemAudioSfuSubscriber();
  if (getState('playback.mode') === 'system-audio' && !latestView.isLocalOwner) {
    cleanupGuestSystemAudio();
  }
}

async function attachCoordinatorTrack(
  identity: CoordinatorPublicationIdentity,
  descriptorTrack: ProRoomSystemAudioPublication['tracks'][number],
  channel: 'L' | 'R',
  track: MediaStreamTrack,
): Promise<void> {
  const trustedReceptionReady = await awaitTrustedSystemAudioReceptionBoundary(
    `pro-sfu-${channel}`,
  );
  if (!trustedReceptionReady || !coordinatorPublicationMatches(identity)) {
    return;
  }
  await initAudio();
  const state = controller?.getCurrentState();
  if (
    !coordinatorPublicationMatches(identity, state) ||
    descriptorTrack.channel !== channel ||
    !identity.tracks.some(
      (current) =>
        current.channel === descriptorTrack.channel &&
        current.trackName === descriptorTrack.trackName &&
        (current.mid ?? null) === (descriptorTrack.mid ?? null),
    ) ||
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
  identity = captureCoordinatorPublicationIdentity(state),
): Promise<void> {
  if (!isActiveProRoom() || !identity || !coordinatorPublicationMatches(identity)) return;
  const key = coordinatorPublicationKey(identity);
  cleanupSystemAudioSfuGuestRoute();
  if (subscriberFailureGeneration !== null && subscriberFailureGeneration !== state.generation) {
    subscriberFailureGeneration = null;
  }
  if (state.ownerParticipantId === localParticipantId()) {
    cleanupCoordinatorGraph();
    return;
  }
  if (coordinatorSubscriptionKey !== key) {
    cleanupCoordinatorGraph();
    coordinatorSubscriptionKey = key;
    beginTrustedSystemAudioReception();
  }
  let flight = coordinatorSubscriptionFlight;
  if (!flight || flight.key !== key) {
    const promise = subscribeProSystemAudioSfu(sfuDescriptor(state));
    flight = { key, promise };
    coordinatorSubscriptionFlight = flight;
  }
  try {
    await flight.promise;
  } finally {
    if (coordinatorSubscriptionFlight === flight) coordinatorSubscriptionFlight = null;
  }
  if (!coordinatorPublicationMatches(identity)) return;
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
  if (!isActiveProRoom()) return;
  if (state.status === 'live') {
    const identity = captureCoordinatorPublicationIdentity(state);
    if (!identity || !coordinatorPublicationMatches(identity, state)) return;
    void ensureCoordinatorSubscription(state, identity).catch((error) => {
      if (!coordinatorPublicationMatches(identity)) return;
      log.warn('[PRO SystemAudio] Coordinator subscription failed', error);
      notifySubscriberFailure(state);
      clearManagedTimer(SUBSCRIBER_RETRY_TIMER);
      setManagedTimer(
        SUBSCRIBER_RETRY_TIMER,
        () => {
          if (!coordinatorPublicationMatches(identity)) return;
          const latest = controller?.getCurrentState();
          if (latest?.status === 'live') {
            void ensureCoordinatorSubscription(latest, identity).catch((retryError) =>
              log.warn('[PRO SystemAudio] Coordinator subscription retry failed', retryError),
            );
          }
        },
        RECOVERY_DELAY_MS,
      );
    });
  } else {
    cleanupCoordinatorGraph();
    subscriberFailureGeneration = null;
  }
}

function onControllerState(view: ProRoomSystemAudioViewState): void {
  latestView = view;
  const state = controller?.getCurrentState() ?? null;
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
  if (state) void reconcileCoordinatorState(state);
}

function onLocalLeaseLost(reason: ProRoomSystemAudioLeaseLossReason): void {
  clearManagedTimer(LEASE_HEARTBEAT_TIMER);
  clearManagedTimer(LEASE_RELEASE_RETRY_TIMER);
  clearManagedTimer(PUBLISHER_RETRY_TIMER);
  stopProSystemAudioSfuPublisher();
  localPublishFlight = null;
  localPublicationId = null;
  if ((expectedLeaseTransitions.get(serviceSessionEpoch) ?? 0) > 0) return;
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
    beginLeaseAttempt: beginLocalProSystemAudioLeaseAttempt,
    publish: publishLocalProSystemAudio,
    release: releaseLocalProSystemAudioLease,
    view: getProSystemAudioViewState,
    ownerDisplayName: getProSystemAudioOwnerDisplayName,
    isLocalOwner: isLocalProSystemAudioOwner,
    coordinatorSupportsPublishing: canPublishProSystemAudioWithCurrentCoordinator,
  });
}

export function bindProSystemAudioSession(snapshot: ProRoomSnapshot): void {
  const nextSessionKey =
    snapshot.status === 'active' && snapshot.viewer
      ? `${snapshot.roomCode}:${snapshot.viewer.participantId}:${snapshot.viewer.presenceIncarnationId}`
      : null;
  if (boundSessionKey !== nextSessionKey) {
    // A request issued for the previous tab incarnation must never suppress
    // the first authoritative refresh for the newly bound incarnation.
    const hadLocalActivity = Boolean(localTracks || localPublishFlight || publisherRecoveryFlight);
    const controllerWillNotifyLeaseLoss = Boolean(controller?.getCurrentLease());
    refreshFlight = null;
    serviceSessionEpoch += 1;
    localLeaseAttemptOwner = null;
    expectedLeaseTransitions.clear();
    cancelPublisherRecovery();
    localPublishFlight = null;
    clearManagedTimer(LEASE_HEARTBEAT_TIMER);
    clearManagedTimer(LEASE_RELEASE_RETRY_TIMER);
    clearManagedTimer(PUBLISHER_RETRY_TIMER);
    stopProSystemAudioSfuPublisher();
    localTracks = null;
    localPublicationId = null;
    leaseHeartbeatFailureNotified = false;
    cleanupCoordinatorGraph();
    subscriberFailureGeneration = null;
    if (hadLocalActivity && !controllerWillNotifyLeaseLoss) {
      bus.emit('pro-system-audio:lease-lost', 'session-changed');
    }
    boundSessionKey = nextSessionKey;
  }
  latestSnapshot = snapshot;
  remoteOwnerDisplayName = null;
  controller?.bindSession(snapshot);
  const state = controller?.getCurrentState();
  if (state) void reconcileCoordinatorState(state);
}

export function resetProSystemAudioService(): void {
  const hadLocalActivity = Boolean(localTracks || localPublishFlight || publisherRecoveryFlight);
  const controllerWillNotifyLeaseLoss = Boolean(controller?.getCurrentLease());
  serviceSessionEpoch += 1;
  localLeaseAttemptOwner = null;
  expectedLeaseTransitions.clear();
  cancelPublisherRecovery();
  clearManagedTimer(LEASE_HEARTBEAT_TIMER);
  clearManagedTimer(LEASE_RELEASE_RETRY_TIMER);
  clearManagedTimer(SUBSCRIBER_RETRY_TIMER);
  clearManagedTimer(PUBLISHER_RETRY_TIMER);
  cleanupCoordinatorGraph();
  stopProSystemAudioSfuPublisher();
  controller?.reset();
  if (hadLocalActivity && !controllerWillNotifyLeaseLoss) {
    bus.emit('pro-system-audio:lease-lost', 'reset');
  }
  latestSnapshot = null;
  latestView = idleView();
  remoteOwnerDisplayName = null;
  refreshFlight = null;
  localTracks = null;
  localPublicationId = null;
  localPublishFlight = null;
  boundSessionKey = null;
  leaseHeartbeatFailureNotified = false;
  subscriberFailureGeneration = null;
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

/**
 * Bind one capture-start request to the exact authenticated lease it acquires.
 * A later request supersedes cleanup ownership even when the controller
 * deduplicates both calls onto the same in-flight server grant.
 */
function beginLocalProSystemAudioLeaseAttempt(signal?: AbortSignal): ProSystemAudioLeaseAttempt {
  const activeController = controller;
  const epoch = serviceSessionEpoch;
  const token = Symbol('local-system-audio-lease-attempt');
  const existingLease = activeController?.getCurrentLease();
  const owner: LocalLeaseAttemptOwner = {
    token,
    epoch,
    controller: activeController,
    identity:
      existingLease?.hasCredential && isServiceSessionCurrent(epoch)
        ? {
            epoch,
            roomCode: existingLease.roomCode,
            generation: existingLease.generation,
          }
        : null,
  };
  localLeaseAttemptOwner = owner;

  const result = acquireLocalProSystemAudioLease(signal).then((state) => {
    const lease = activeController?.getCurrentLease();
    if (
      controller === activeController &&
      isServiceSessionCurrent(epoch) &&
      lease?.hasCredential &&
      state.status !== 'idle' &&
      lease.roomCode === latestSnapshot?.roomCode &&
      lease.generation === state.generation
    ) {
      owner.identity = {
        epoch,
        roomCode: lease.roomCode,
        generation: lease.generation,
      };
    }
    return state;
  });
  let releaseFlight: Promise<ProRoomSystemAudioState | null> | null = null;

  return {
    result,
    releaseIfCurrent: () => {
      if (releaseFlight) return releaseFlight;
      releaseFlight = result
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => releaseLocalProSystemAudioLeaseInternal(null, owner));
      return releaseFlight;
    },
  };
}

function scheduleLeaseHeartbeat(delayMs = LEASE_HEARTBEAT_MS): void {
  clearManagedTimer(LEASE_HEARTBEAT_TIMER);
  setManagedTimer(
    LEASE_HEARTBEAT_TIMER,
    () => {
      const activeController = controller;
      const lease = activeController?.getCurrentLease();
      if (!activeController || !lease?.hasCredential || lease.status !== 'live') return;
      const identity: LocalLeaseIdentity = {
        epoch: serviceSessionEpoch,
        roomCode: lease.roomCode,
        generation: lease.generation,
      };
      void activeController
        .heartbeatProSystemAudioLease()
        .then((state) => {
          if (!isLocalLeaseCurrent(identity)) return;
          leaseHeartbeatFailureNotified = false;
          notifyMutation(state);
          if (isLocalLeaseCurrent(identity) && controller?.getCurrentLease()?.status === 'live') {
            scheduleLeaseHeartbeat();
          }
        })
        .catch((error) => {
          if (!isLocalLeaseCurrent(identity)) return;
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
  const activeController = controller;
  if (!activeController) throw new Error('PRO_SYSTEM_AUDIO_NOT_CONFIGURED');
  if (!canPublishProSystemAudioWithCurrentCoordinator()) {
    throw new Error('PRO_SYSTEM_AUDIO_COORDINATOR_UPDATE_REQUIRED');
  }
  const lease = activeController.getCurrentLease();
  if (!lease?.hasCredential || lease.status !== 'preparing') {
    throw new Error('PRO_SYSTEM_AUDIO_LEASE_UNAVAILABLE');
  }
  if (localPublishFlight && isServiceSessionCurrent(localPublishFlight.epoch)) {
    throw new Error('PRO_SYSTEM_AUDIO_PUBLISH_IN_PROGRESS');
  }
  const epoch = serviceSessionEpoch;
  const publicationId = localPublicationId ?? crypto.randomUUID();
  const flight = {
    epoch,
    token: Symbol('local-system-audio-publish'),
    controller: activeController,
    identity: {
      epoch,
      roomCode: lease.roomCode,
      generation: lease.generation,
    },
    recoveryToken:
      publisherRecoveryFlight && ownsPublisherRecovery(publisherRecoveryFlight)
        ? publisherRecoveryFlight.token
        : null,
  };
  localPublishFlight = flight;
  localTracks = { left: leftTrack, right: rightTrack };
  localPublicationId = publicationId;
  try {
    const descriptor = await publishProSystemAudioSfu({
      leftTrack,
      rightTrack,
      generation: lease.generation,
      expiresAt: Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
      roomId: lease.roomCode,
    });
    if (!ownsLocalPublishFlight(flight) || !isLocalLeaseCurrent(flight.identity)) {
      throw new ProRoomSystemAudioControllerError('OPERATION_SUPERSEDED');
    }
    const publication: ProRoomSystemAudioPublication = {
      publicationId,
      sessionId: descriptor.sessionId,
      tracks: descriptor.tracks.map((track) => ({
        ...track,
      })) as ProRoomSystemAudioPublication['tracks'],
    };
    const state = await activeController.commitProSystemAudioPublication(publication);
    if (!ownsLocalPublishFlight(flight) || !isLocalLeaseCurrent(flight.identity)) {
      throw new ProRoomSystemAudioControllerError('OPERATION_SUPERSEDED');
    }
    if (state.status === 'live') {
      updateProSystemAudioSfuPublisherExpiry(state.liveExpiresAt);
    }
    notifyMutation(state);
    if (state.status === 'live') {
      broadcastSystemMessage('chat.system_audio_started_system_message');
    }
    clearManagedTimer(PUBLISHER_RETRY_TIMER);
    leaseHeartbeatFailureNotified = false;
    scheduleLeaseHeartbeat();
    return state;
  } catch (error) {
    // A superseded publish can finish after a new tab incarnation has already
    // acquired and published. Only the flight that still owns the singleton
    // SFU publisher may tear it down or release its exact lease.
    if (ownsLocalPublishFlight(flight)) {
      stopProSystemAudioSfuPublisher();
      localTracks = null;
      localPublicationId = null;
      localPublishFlight = null;
      if (isLocalLeaseCurrent(flight.identity)) {
        await releaseLocalProSystemAudioLeaseInternal(flight.recoveryToken).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    if (ownsLocalPublishFlight(flight)) localPublishFlight = null;
  }
}

async function releaseLocalProSystemAudioLeaseInternal(
  preserveRecoveryToken: symbol | null,
  scopedOwner: LocalLeaseAttemptOwner | null = null,
): Promise<ProRoomSystemAudioState | null> {
  if (scopedOwner) {
    const identity = scopedOwner.identity;
    if (
      localLeaseAttemptOwner !== scopedOwner ||
      localLeaseAttemptOwner.token !== scopedOwner.token ||
      controller !== scopedOwner.controller ||
      !isServiceSessionCurrent(scopedOwner.epoch) ||
      !identity ||
      !isLocalLeaseCurrent(identity)
    ) {
      return controller?.getCurrentState() ?? null;
    }
    // Consume cleanup ownership before any singleton timer/SFU/flight state is
    // touched. A repeated or late release of this handle is therefore a noop.
    localLeaseAttemptOwner = null;
  }
  const epoch = serviceSessionEpoch;
  const lease = controller?.getCurrentLease();
  const identity: LocalLeaseIdentity | null = lease?.hasCredential
    ? { epoch, roomCode: lease.roomCode, generation: lease.generation }
    : null;
  // Explicit release owns teardown from this point. Invalidate an unfinished
  // publish before aborting the singleton SFU publisher so its rejection
  // cannot observe itself as current and release the same lease a second time.
  if (publisherRecoveryFlight?.token !== preserveRecoveryToken) {
    // Same-session explicit stop must still receive a pending acquire grant so
    // recovery can release its exact private lease instead of stranding the
    // server-side claim until TTL.
    cancelPublisherRecovery(false);
  }
  localPublishFlight = null;
  clearManagedTimer(LEASE_HEARTBEAT_TIMER);
  clearManagedTimer(LEASE_RELEASE_RETRY_TIMER);
  clearManagedTimer(PUBLISHER_RETRY_TIMER);
  leaseHeartbeatFailureNotified = false;
  stopProSystemAudioSfuPublisher();
  localTracks = null;
  localPublicationId = null;
  if (!identity) return controller?.getCurrentState() ?? null;
  const wasLive = controller?.getCurrentState()?.status === 'live';
  beginExpectedLeaseTransition(epoch);
  try {
    const state = await controller!.releaseProSystemAudioLease();
    notifyMutation(state);
    if (wasLive && state.status === 'idle') {
      broadcastSystemMessage('chat.system_audio_stopped_system_message');
    }
    return state;
  } catch (error) {
    if (!isLocalLeaseCurrent(identity)) {
      // The request belonged to a room/tab incarnation that has already been
      // superseded. Its private credential was fenced by the controller; never
      // turn that stale failure into a retry against the new incarnation.
      return controller?.getCurrentState() ?? null;
    }
    // The publication is already closed locally, but a dropped release
    // response must not strand a live owner record until its two-hour TTL.
    // Keep the controller's private credential and retry only while it still
    // identifies the same live/preparing lease.
    if (isLocalLeaseCurrent(identity)) {
      setManagedTimer(
        LEASE_RELEASE_RETRY_TIMER,
        () => {
          if (!isLocalLeaseCurrent(identity)) return;
          void releaseLocalProSystemAudioLease().catch((retryError) =>
            log.warn('[PRO SystemAudio] Lease release retry failed', retryError),
          );
        },
        RECOVERY_DELAY_MS,
      );
    }
    throw error;
  } finally {
    endExpectedLeaseTransition(epoch);
  }
}

export function releaseLocalProSystemAudioLease(): Promise<ProRoomSystemAudioState | null> {
  // Explicit stop owns the current live capture, including a generation that
  // publisher recovery may have rotated beyond its original acquire handle.
  localLeaseAttemptOwner = null;
  return releaseLocalProSystemAudioLeaseInternal(null);
}

async function recoverLocalPublisher(): Promise<void> {
  const activeController = controller;
  const lease = activeController?.getCurrentLease();
  if (!activeController || publisherRecoveryFlight || !localTracks || !lease?.hasCredential) {
    return;
  }
  const epoch = serviceSessionEpoch;
  const flight: PublisherRecoveryFlight = {
    epoch,
    token: Symbol('publisher-recovery'),
    controller: activeController,
    initialLease: {
      epoch,
      roomCode: lease.roomCode,
      generation: lease.generation,
    },
    abortController: new AbortController(),
  };
  publisherRecoveryFlight = flight;
  const tracks = localTracks;
  const name = latestSnapshot?.viewer?.displayName ?? 'Peer';
  bus.emit('ui:show-toast', t('system_audio.connection_unstable', { name }));
  beginExpectedLeaseTransition(epoch);
  let reacquiredIdentity: LocalLeaseIdentity | null = null;
  try {
    if (!ownsPublisherRecovery(flight) || !isLocalLeaseCurrent(flight.initialLease)) return;
    const idle = await activeController.releaseProSystemAudioLease(flight.abortController.signal);
    if (!ownsPublisherRecovery(flight)) return;
    if (idle.status !== 'idle' || idle.generation < flight.initialLease.generation) {
      terminateOwnedPublisherRecovery(flight, tracks);
      return;
    }
    notifyMutation(idle);
    const preparing = await activeController.acquireProSystemAudioLease(
      flight.abortController.signal,
    );
    const reacquired = activeController.getCurrentLease();
    if (!ownsPublisherRecovery(flight)) {
      // A user stop can cancel recovery while the acquire response is already
      // in flight. If that response still installed only the abandoned
      // recovery lease, fence it without touching a newer local publication.
      if (
        isServiceSessionCurrent(epoch) &&
        controller === activeController &&
        !localPublishFlight &&
        reacquired?.hasCredential &&
        reacquired.roomCode === flight.initialLease.roomCode &&
        reacquired.generation === preparing.generation
      ) {
        await releaseLocalProSystemAudioLeaseInternal(null).catch((error) =>
          log.warn('[PRO SystemAudio] Failed to fence cancelled recovery lease', error),
        );
      }
      return;
    }
    if (
      !reacquired?.hasCredential ||
      reacquired.roomCode !== flight.initialLease.roomCode ||
      reacquired.generation !== preparing.generation
    ) {
      terminateOwnedPublisherRecovery(flight, tracks);
      return;
    }
    reacquiredIdentity = {
      epoch,
      roomCode: reacquired.roomCode,
      generation: reacquired.generation,
    };
    if (!isLocalLeaseCurrent(reacquiredIdentity)) return;
    notifyMutation(preparing);
    localPublicationId = null;
    localTracks = tracks;
    await publishLocalProSystemAudio(tracks.left, tracks.right);
  } catch (error) {
    if (!ownsPublisherRecovery(flight)) return;
    const current = activeController.getCurrentState();
    const recoveryStateStillCurrent = reacquiredIdentity
      ? isLocalLeaseCurrent(reacquiredIdentity) ||
        Boolean(current?.status === 'idle' && current.generation >= reacquiredIdentity.generation)
      : isLocalLeaseCurrent(flight.initialLease) ||
        Boolean(current?.status === 'idle' && current.generation >= flight.initialLease.generation);
    if (!recoveryStateStillCurrent) {
      terminateOwnedPublisherRecovery(flight, tracks);
      return;
    }
    log.warn('[PRO SystemAudio] Publisher recovery failed', error);
    localTracks = null;
    localPublicationId = null;
    await releaseLocalProSystemAudioLeaseInternal(flight.token).catch((releaseError) =>
      log.warn('[PRO SystemAudio] Failed to release after publisher recovery', releaseError),
    );
    if (ownsPublisherRecovery(flight)) {
      bus.emit('pro-system-audio:lease-lost', 'publisher-failed');
    }
  } finally {
    endExpectedLeaseTransition(epoch);
    if (publisherRecoveryFlight?.token === flight.token) publisherRecoveryFlight = null;
  }
}

export function registerProSystemAudioServiceListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  bus.on('state:room.context', () => {
    const currentContext = getState('room.context');
    if (currentContext.kind !== 'pro') {
      cleanupCoordinatorGraph();
      subscriberFailureGeneration = null;
      return;
    }
    cleanupSystemAudioSfuGuestRoute();
    const state = controller?.getCurrentState();
    if (state) void reconcileCoordinatorState(state);
    // The PRO runtime owns the authoritative initial read and its safety
    // deadline. Fetching here as well races that read and can issue a second
    // request after a fast response without registering the result with the
    // runtime's realtime-first refresh schedule.
  });

  onProSystemAudioSfuEvent((event) => {
    if (event.type === 'subscriber-track') {
      const state = controller?.getCurrentState();
      if (state?.status !== 'live' || !descriptorMatchesPublication(event.descriptor, state)) {
        return;
      }
      const identity = captureCoordinatorPublicationIdentity(state);
      const descriptorTrack = event.descriptor.tracks.find(
        (track) => track.channel === event.channel,
      );
      if (!identity || !descriptorTrack) return;
      void attachCoordinatorTrack(identity, descriptorTrack, event.channel, event.track).catch(
        (error) => log.warn('[PRO SystemAudio] Track attach failed', error),
      );
      return;
    }
    if (event.type === 'subscriber-state' && event.state === 'failed') {
      const state = controller?.getCurrentState();
      if (
        state?.status !== 'live' ||
        !event.descriptor ||
        !descriptorMatchesPublication(event.descriptor, state) ||
        state.ownerParticipantId === localParticipantId()
      ) {
        return;
      }
      const identity = captureCoordinatorPublicationIdentity(state);
      if (!identity || !coordinatorPublicationMatches(identity, state)) return;
      notifySubscriberFailure(state);
      setManagedTimer(
        SUBSCRIBER_RETRY_TIMER,
        () => {
          if (!coordinatorPublicationMatches(identity)) return;
          const current = controller?.getCurrentState();
          if (current?.status === 'live') {
            void ensureCoordinatorSubscription(current, identity).catch((error) =>
              log.warn('[PRO SystemAudio] Coordinator subscription retry failed', error),
            );
          }
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
