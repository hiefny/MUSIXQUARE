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
let expectedLeaseTransition = false;
let localTracks: { left: MediaStreamTrack; right: MediaStreamTrack } | null = null;
let localPublicationId: string | null = null;
let publisherRecoveryInFlight = false;
let boundSessionKey: string | null = null;
let leaseHeartbeatFailureNotified = false;
let subscriberFailureGeneration: number | null = null;

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

function canPublishProSystemAudioWithCurrentCoordinator(): boolean {
  return Boolean(
    isActiveProRoom() && latestSnapshot?.viewer?.capabilities.includes('playback.control'),
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
  if (!isActiveProRoom()) return;
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
  if (!isActiveProRoom()) return;
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
  }
  latestSnapshot = snapshot;
  remoteOwnerDisplayName = null;
  controller?.bindSession(snapshot);
  const state = controller?.getCurrentState();
  if (state) void reconcileCoordinatorState(state);
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
  localTracks = null;
  localPublicationId = null;
  publisherRecoveryInFlight = false;
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
    if (state.status === 'live') {
      broadcastSystemMessage('chat.system_audio_started_system_message');
    }
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
  const wasLive = controller.getCurrentState()?.status === 'live';
  expectedLeaseTransition = true;
  try {
    const state = await controller.releaseProSystemAudioLease();
    notifyMutation(state);
    if (wasLive && state.status === 'idle') {
      broadcastSystemMessage('chat.system_audio_stopped_system_message');
    }
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
    void refreshProSystemAudioState()
      .then((next) => reconcileCoordinatorState(next))
      .catch(() => undefined);
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
      if (state?.status !== 'live' || state.ownerParticipantId === localParticipantId()) return;
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
