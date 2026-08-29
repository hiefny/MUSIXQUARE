import { initAudio, getWidener } from '../audio/engine.ts';
import { getAudioContext } from '../audio/context.ts';
import { broadcastSystemMessage } from '../chat/protocol.ts';
import { MAX_SYSTEM_AUDIO_DEVICES, SYSTEM_AUDIO_SHARE_LIMIT_MS } from '../core/constants.ts';
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
import {
  activateProSystemAudioDirectPublication,
  attemptProSystemAudioDirectPublication,
  configureProSystemAudioDirectTransport,
  reconcileProSystemAudioDirectTargets,
  resetProSystemAudioDirectTransport as resetProSystemAudioDirectTransportInternal,
  type ProSystemAudioDirectFallbackEvent,
  type ProSystemAudioDirectInboundOfferContext,
  type ProSystemAudioDirectInboundSignalContext,
  type ProSystemAudioDirectTarget,
  type ProSystemAudioDirectTrackReadyEvent,
} from '../network/pro-system-audio-direct.ts';
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
  ProRoomSystemAudioPublicationTrack,
  ProRoomSystemAudioState,
} from './contracts.ts';
import {
  isProRoomSystemAudioDirectPublication,
  isProRoomSystemAudioSfuPublication,
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
const DIRECT_PROMOTION_RETRY_TIMER = 'pro-system-audio-direct-promotion-retry';
const SUBSCRIBER_DISCONNECT_TIMER = 'pro-system-audio-subscriber-disconnect';
const LEASE_HEARTBEAT_MS = 15_000;
// LAN-direct has no duration cap, so a lost Cloudflare authority plane must
// not leave an orphaned local publication running forever. Four missed normal
// heartbeat intervals allow brief edge/API recovery while remaining bounded.
const DIRECT_AUTHORITY_LOSS_GRACE_MS = LEASE_HEARTBEAT_MS * 4;
const RECOVERY_DELAY_MS = 2_500;
const MAX_DIRECT_TARGETS = MAX_SYSTEM_AUDIO_DEVICES - 1;

let controller: ProRoomSystemAudioController | null = null;
let latestSnapshot: ProRoomSnapshot | null = null;
let latestView: ProRoomSystemAudioViewState = idleView();
let remoteOwnerDisplayName: string | null = null;
let refreshFlight: Promise<ProRoomSystemAudioState> | null = null;
let queuedForcedRefresh: Promise<ProRoomSystemAudioState> | null = null;
let listenersRegistered = false;
let serviceSessionEpoch = 0;
const expectedLeaseTransitions = new Map<number, number>();
let localTrack: MediaStreamTrack | null = null;
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
let directAuthorityHeartbeatFailureStartedAt: number | null = null;
let subscriberFailureGeneration: number | null = null;
let localLeaseAttemptOwner: LocalLeaseAttemptOwner | null = null;
let directPromotionFlight: Promise<void> | null = null;
let activeLocalDirectPublicationKey: string | null = null;
let oversizedDirectRefreshFlight: Promise<ProRoomSystemAudioState | void> | null = null;
let ambiguousDirectPromotionPublicationId: string | null = null;
let failedSfuPublisherSessionId: string | null = null;

let coordinatorSource: MediaStreamAudioSourceNode | null = null;
let coordinatorSubscriptionKey: string | null = null;
let coordinatorSubscriptionFlight: { key: string; promise: Promise<void> } | null = null;
let coordinatorPrimer: WebRtcAudioDecoderPrimer | null = null;

function observeSystemAudioTask(operation: Promise<unknown>, context: string): void {
  operation.catch((error) => {
    log.warn(`[PRO SystemAudio] ${context} escaped its operation boundary`, error);
  });
}

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
  publication: ProRoomSystemAudioPublication;
}

function clonePublication(
  publication: ProRoomSystemAudioPublication,
): ProRoomSystemAudioPublication {
  return isProRoomSystemAudioSfuPublication(publication)
    ? {
        publicationId: publication.publicationId,
        sessionId: publication.sessionId,
        track: { ...publication.track },
      }
    : { ...publication };
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
    publication: clonePublication(state.publication),
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
    JSON.stringify(state.publication) !== JSON.stringify(identity.publication)
  ) {
    return false;
  }
  return true;
}

function descriptorMatchesPublication(
  descriptor: ProSystemAudioSfuPublicationDescriptor,
  state: Extract<ProRoomSystemAudioState, { status: 'live' }>,
): boolean {
  const publication = state.publication;
  if (!isProRoomSystemAudioSfuPublication(publication)) return false;
  if (
    descriptor.generation !== state.generation ||
    descriptor.sessionId !== publication.sessionId ||
    descriptor.expiresAt !== state.liveExpiresAt
  ) {
    return false;
  }
  return (
    publication.track.trackName === descriptor.track.trackName &&
    (publication.track.mid ?? null) === (descriptor.track.mid ?? null)
  );
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

function directPublicationKey(
  ownerParticipantId: string,
  generation: number,
  publicationId: string,
): string {
  return `${ownerParticipantId}:${generation}:${publicationId}`;
}

function resetProSystemAudioDirectTransport(
  options: {
    notifyPeers?: boolean;
    reason?: 'stopped' | 'fallback' | 'superseded';
  } = {},
): void {
  activeLocalDirectPublicationKey = null;
  resetProSystemAudioDirectTransportInternal(options);
}

function rejectOversizedDirectPresence(): void {
  resetProSystemAudioDirectTransport({ notifyPeers: true, reason: 'fallback' });
  if (oversizedDirectRefreshFlight) return;
  const flight = refreshProSystemAudioState(undefined, true)
    .catch((error) => log.warn('[PRO SystemAudio] Oversized presence refresh failed', error))
    .finally(() => {
      if (oversizedDirectRefreshFlight === flight) oversizedDirectRefreshFlight = null;
    });
  oversizedDirectRefreshFlight = flight;
}

function canPublishProSystemAudioWithCurrentCoordinator(): boolean {
  return Boolean(
    isActiveProRoom() && latestSnapshot?.viewer?.capabilities.includes('playback.control'),
  );
}

function currentDirectTargets(): ProSystemAudioDirectTarget[] {
  const localId = localParticipantId();
  if (!localId) return [];
  return (
    latestSnapshot?.presence.participants
      .filter((participant) => participant.participantId !== localId)
      .map((participant) => ({
        participantId: participant.participantId,
        routeToken: `joined-at:${participant.joinedAtMs}`,
      })) ?? []
  );
}

function isCurrentPresenceParticipant(participantId: string): boolean {
  return Boolean(
    latestSnapshot?.presence.participants.some(
      (participant) => participant.participantId === participantId,
    ),
  );
}

function authorizeInboundDirectSignal(context: ProSystemAudioDirectInboundSignalContext): boolean {
  const localId = localParticipantId();
  if (
    !isActiveProRoom() ||
    !localId ||
    context.targetParticipantId !== localId ||
    context.senderParticipantId === localId ||
    !isCurrentPresenceParticipant(context.senderParticipantId)
  ) {
    return false;
  }

  const state = controller?.getCurrentState() ?? null;
  if (context.direction === 'subscriber') {
    return Boolean(
      state &&
      state.status !== 'idle' &&
      state.ownerParticipantId === localId &&
      state.generation === context.generation &&
      localPublicationId === context.publicationId &&
      (state.status === 'preparing' ||
        (isProRoomSystemAudioDirectPublication(state.publication) &&
          state.publication.publicationId === context.publicationId)),
    );
  }

  if (state && state.generation > context.generation) return false;
  if (!state || state.status === 'idle' || state.generation < context.generation) {
    // The signaling Worker has already checked the exact active lease owner.
    // A local invalidation/GET can trail the targeted offer by one task.
    void refreshProSystemAudioState().catch(() => undefined);
    return !state || context.generation >= state.generation;
  }
  if (
    state.generation !== context.generation ||
    state.ownerParticipantId !== context.senderParticipantId
  ) {
    return false;
  }
  return (
    state.status === 'preparing' ||
    (isProRoomSystemAudioDirectPublication(state.publication) &&
      state.publication.publicationId === context.publicationId)
  );
}

function authorizeInboundDirectOffer(context: ProSystemAudioDirectInboundOfferContext): boolean {
  return (
    context.direction === 'publisher' &&
    context.ownerParticipantId === context.senderParticipantId &&
    authorizeInboundDirectSignal(context)
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
    identity.publication,
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
  track: MediaStreamTrack,
): void {
  if (!ownsPublisherRecovery(flight) || localTrack !== track) {
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
  resetProSystemAudioDirectTransport({ notifyPeers: true, reason: 'fallback' });
  directPromotionFlight = null;
  localPublishFlight = null;
  localTrack = null;
  localPublicationId = null;
  leaseHeartbeatFailureNotified = false;
  directAuthorityHeartbeatFailureStartedAt = null;
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
  reconcileCoordinatorState(state);
}

function cleanupCoordinatorAudioNodes(): void {
  try {
    coordinatorSource?.disconnect();
  } catch {
    /* already disconnected */
  }
  coordinatorSource = null;
  cleanupWebRtcAudioDecoderPrimer(coordinatorPrimer);
  coordinatorPrimer = null;
}

function cleanupCoordinatorGraph(): void {
  clearManagedTimer(SUBSCRIBER_RETRY_TIMER);
  clearManagedTimer(SUBSCRIBER_DISCONNECT_TIMER);
  cleanupCoordinatorAudioNodes();
  coordinatorSubscriptionKey = null;
  coordinatorSubscriptionFlight = null;
  stopProSystemAudioSfuSubscriber();
  if (getState('playback.mode') === 'system-audio' && !latestView.isLocalOwner) {
    cleanupGuestSystemAudio();
  }
}

function cleanupCoordinatorSubscriptionForRetry(): void {
  clearManagedTimer(SUBSCRIBER_RETRY_TIMER);
  clearManagedTimer(SUBSCRIBER_DISCONNECT_TIMER);
  cleanupCoordinatorAudioNodes();
  coordinatorSubscriptionKey = null;
  coordinatorSubscriptionFlight = null;
  stopProSystemAudioSfuSubscriber();
  cleanupSystemAudioSfuGuestRoute();
}

async function attachCoordinatorTrack(
  identity: CoordinatorPublicationIdentity,
  descriptorTrack: ProRoomSystemAudioPublicationTrack | null,
  track: MediaStreamTrack,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return;
  const trustedReceptionReady = await awaitTrustedSystemAudioReceptionBoundary('pro-stereo');
  if (!trustedReceptionReady || !isCurrent() || !coordinatorPublicationMatches(identity)) {
    return;
  }
  await initAudio();
  if (!isCurrent()) return;
  const state = controller?.getCurrentState();
  if (
    !coordinatorPublicationMatches(identity, state) ||
    (descriptorTrack !== null &&
      (!isProRoomSystemAudioSfuPublication(identity.publication) ||
        identity.publication.track.trackName !== descriptorTrack.trackName ||
        (identity.publication.track.mid ?? null) !== (descriptorTrack.mid ?? null))) ||
    state.ownerParticipantId === localParticipantId() ||
    !isCurrent()
  ) {
    return;
  }
  const ctx = getAudioContext();
  const widener = getWidener();
  if (!widener) throw new Error('PRO_SYSTEM_AUDIO_GRAPH_UNAVAILABLE');
  try {
    coordinatorSource?.disconnect();
  } catch {
    /* already disconnected */
  }
  coordinatorPrimer = primeWebRtcAudioDecoder(
    coordinatorPrimer,
    [track],
    getAudioTrackStreamKey('pro-stereo', [track]),
    'stereo',
    '[ProSysAudio]',
  );
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  source.connect(widener.input);
  coordinatorSource = source;
  setSystemAudioReceiving(true);
  claimPlaybackOwner('system-audio');
  bus.emit('visualizer:start');
}

async function attachDirectCoordinatorTrack(
  event: ProSystemAudioDirectTrackReadyEvent,
): Promise<void> {
  if (!event.isCurrent()) return;
  const state = controller?.getCurrentState();
  if (
    state?.status !== 'live' ||
    !isProRoomSystemAudioDirectPublication(state.publication) ||
    state.generation !== event.generation ||
    state.ownerParticipantId !== event.ownerParticipantId ||
    state.publication.publicationId !== event.publicationId
  ) {
    return;
  }
  const identity = captureCoordinatorPublicationIdentity(state);
  if (!identity || !event.isCurrent() || !coordinatorPublicationMatches(identity, state)) return;
  await attachCoordinatorTrack(identity, null, event.track, event.isCurrent);
}

function sfuDescriptor(
  state: Extract<ProRoomSystemAudioState, { status: 'live' }>,
): ProSystemAudioSfuPublicationDescriptor {
  if (!isProRoomSystemAudioSfuPublication(state.publication)) {
    throw new Error('PRO_SYSTEM_AUDIO_SFU_PUBLICATION_REQUIRED');
  }
  return {
    version: 2,
    sessionId: state.publication.sessionId,
    track: { ...state.publication.track },
    generation: state.generation,
    expiresAt: state.liveExpiresAt,
  };
}

function stateMatchesSfuPublication(
  state: ProRoomSystemAudioState,
  publication: ProRoomSystemAudioPublication,
): state is Extract<ProRoomSystemAudioState, { status: 'live' }> {
  if (state.status !== 'live') return false;
  const currentPublication = state.publication;
  if (
    !isProRoomSystemAudioSfuPublication(currentPublication) ||
    !isProRoomSystemAudioSfuPublication(publication) ||
    currentPublication.publicationId !== publication.publicationId ||
    currentPublication.sessionId !== publication.sessionId
  ) {
    return false;
  }
  return (
    currentPublication.track.trackName === publication.track.trackName &&
    (currentPublication.track.mid ?? null) === (publication.track.mid ?? null)
  );
}

function scheduleFailedSfuPublisherRecheck(sessionId: string): void {
  clearManagedTimer(PUBLISHER_RETRY_TIMER);
  setManagedTimer(
    PUBLISHER_RETRY_TIMER,
    () => {
      const current = controller?.getCurrentState();
      if (failedSfuPublisherSessionId !== sessionId) return;
      if (localPublishFlight || directPromotionFlight || ambiguousDirectPromotionPublicationId) {
        scheduleFailedSfuPublisherRecheck(sessionId);
        return;
      }
      const failedSessionIsCanonical = Boolean(
        current?.status === 'live' &&
        current.ownerParticipantId === localParticipantId() &&
        isProRoomSystemAudioSfuPublication(current.publication) &&
        current.publication.sessionId === sessionId,
      );
      failedSfuPublisherSessionId = null;
      if (failedSessionIsCanonical) {
        observeSystemAudioTask(recoverLocalPublisher(), 'publisher recovery');
      }
    },
    RECOVERY_DELAY_MS,
  );
}

function settleCanonicalSfuPublisher(
  state: Extract<ProRoomSystemAudioState, { status: 'live' }>,
): void {
  if (!isProRoomSystemAudioSfuPublication(state.publication)) return;
  const sessionId = state.publication.sessionId;
  updateProSystemAudioSfuPublisherExpiry(state.liveExpiresAt);
  clearManagedTimer(PUBLISHER_RETRY_TIMER);
  if (failedSfuPublisherSessionId !== sessionId) {
    failedSfuPublisherSessionId = null;
    return;
  }
  scheduleFailedSfuPublisherRecheck(sessionId);
}

interface DirectPromotionReconciliation {
  controller: ProRoomSystemAudioController;
  identity: LocalLeaseIdentity;
  localParticipantId: string;
  publication: ProRoomSystemAudioPublication;
  reason: string;
}

function isDirectPromotionSourceCurrent(context: DirectPromotionReconciliation): boolean {
  const current = context.controller.getCurrentState();
  return Boolean(
    controller === context.controller &&
    isLocalLeaseCurrent(context.identity) &&
    current?.status === 'live' &&
    current.generation === context.identity.generation &&
    current.ownerParticipantId === context.localParticipantId &&
    isProRoomSystemAudioDirectPublication(current.publication) &&
    current.publication.publicationId === context.publication.publicationId,
  );
}

function isCanonicalPromotedState(
  context: DirectPromotionReconciliation,
  state: ProRoomSystemAudioState | null,
): state is Extract<ProRoomSystemAudioState, { status: 'live' }> {
  return Boolean(
    controller === context.controller &&
    state &&
    state.generation === context.identity.generation &&
    state.ownerParticipantId === context.localParticipantId &&
    stateMatchesSfuPublication(state, context.publication),
  );
}

function acceptPromotedSfuPublication(
  state: Extract<ProRoomSystemAudioState, { status: 'live' }>,
  reason: string,
  reconciledAfterLostResponse = false,
): void {
  ambiguousDirectPromotionPublicationId = null;
  settleCanonicalSfuPublisher(state);
  resetProSystemAudioDirectTransport({ notifyPeers: false });
  clearManagedTimer(DIRECT_PROMOTION_RETRY_TIMER);
  leaseHeartbeatFailureNotified = false;
  directAuthorityHeartbeatFailureStartedAt = null;
  notifyMutation(state);
  log.info(
    `[PRO SystemAudio] Promoted LAN-direct publication to SFU (${reason}${
      reconciledAfterLostResponse ? ', reconciled' : ''
    })`,
  );
}

function scheduleDirectPromotionRetry(reason: string): void {
  clearManagedTimer(DIRECT_PROMOTION_RETRY_TIMER);
  setManagedTimer(
    DIRECT_PROMOTION_RETRY_TIMER,
    () => requestDirectPromotion(reason),
    RECOVERY_DELAY_MS,
  );
}

async function reconcileAmbiguousDirectPromotion(
  context: DirectPromotionReconciliation,
): Promise<void> {
  const publicationId = context.publication.publicationId;
  if (ambiguousDirectPromotionPublicationId !== publicationId) return;

  let authoritative: ProRoomSystemAudioState;
  try {
    authoritative = await refreshProSystemAudioState(undefined, true);
  } catch (error) {
    if (ambiguousDirectPromotionPublicationId !== publicationId) return;
    const current = context.controller.getCurrentState();
    if (isCanonicalPromotedState(context, current)) {
      acceptPromotedSfuPublication(current, context.reason, true);
      return;
    }
    if (!isDirectPromotionSourceCurrent(context)) {
      ambiguousDirectPromotionPublicationId = null;
      stopProSystemAudioSfuPublisher();
      return;
    }
    log.warn('[PRO SystemAudio] Failed to reconcile an ambiguous SFU promotion', error);
    clearManagedTimer(DIRECT_PROMOTION_RETRY_TIMER);
    setManagedTimer(
      DIRECT_PROMOTION_RETRY_TIMER,
      () => reconcileAmbiguousDirectPromotion(context),
      RECOVERY_DELAY_MS,
    );
    return;
  }

  if (ambiguousDirectPromotionPublicationId !== publicationId) return;
  if (isCanonicalPromotedState(context, authoritative)) {
    acceptPromotedSfuPublication(authoritative, context.reason, true);
    return;
  }

  ambiguousDirectPromotionPublicationId = null;
  stopProSystemAudioSfuPublisher();
  if (isDirectPromotionSourceCurrent(context)) {
    scheduleDirectPromotionRetry('promotion-retry');
  }
}

async function ensureCoordinatorSubscription(
  state: Extract<ProRoomSystemAudioState, { status: 'live' }>,
  identity = captureCoordinatorPublicationIdentity(state),
): Promise<void> {
  if (!isActiveProRoom() || !identity || !coordinatorPublicationMatches(identity)) return;
  const key = coordinatorPublicationKey(identity);
  cleanupSystemAudioSfuGuestRoute();
  if (
    isProRoomSystemAudioDirectPublication(state.publication) &&
    currentDirectTargets().length > MAX_DIRECT_TARGETS
  ) {
    rejectOversizedDirectPresence();
    return;
  }
  if (subscriberFailureGeneration !== null && subscriberFailureGeneration !== state.generation) {
    subscriberFailureGeneration = null;
  }
  if (state.ownerParticipantId === localParticipantId()) {
    cleanupCoordinatorGraph();
    if (isProRoomSystemAudioDirectPublication(state.publication)) {
      const targets = currentDirectTargets();
      const publicationKey = directPublicationKey(
        state.ownerParticipantId,
        state.generation,
        state.publication.publicationId,
      );
      if (activeLocalDirectPublicationKey === publicationKey) {
        const reconciled = await reconcileProSystemAudioDirectTargets(targets);
        if (!reconciled) requestDirectPromotion('direct-target-fallback');
        return;
      }
      const activationTargets = currentDirectTargets();
      const activated = await activateProSystemAudioDirectPublication({
        ownerParticipantId: state.ownerParticipantId,
        generation: state.generation,
        publicationId: state.publication.publicationId,
        targets: activationTargets,
      });
      if (!activated) {
        requestDirectPromotion('direct-activation-failed');
        return;
      }
      activeLocalDirectPublicationKey = publicationKey;
      const reconciled = await reconcileProSystemAudioDirectTargets(currentDirectTargets());
      if (!reconciled) requestDirectPromotion('direct-target-fallback');
    } else {
      resetProSystemAudioDirectTransport({ notifyPeers: false });
    }
    return;
  }
  if (isProRoomSystemAudioDirectPublication(state.publication)) {
    stopProSystemAudioSfuSubscriber();
    if (coordinatorSubscriptionKey !== key) {
      cleanupCoordinatorGraph();
      coordinatorSubscriptionKey = key;
      beginTrustedSystemAudioReception();
    }
    await activateProSystemAudioDirectPublication({
      ownerParticipantId: state.ownerParticipantId,
      generation: state.generation,
      publicationId: state.publication.publicationId,
    });
    subscriberFailureGeneration = null;
    return;
  }
  resetProSystemAudioDirectTransport({ notifyPeers: false });
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

function handleDirectRouteFallback(event: ProSystemAudioDirectFallbackEvent): void {
  const state = controller?.getCurrentState();
  if (
    state?.status !== 'live' ||
    !isProRoomSystemAudioDirectPublication(state.publication) ||
    state.generation !== event.generation ||
    state.publication.publicationId !== event.publicationId
  ) {
    return;
  }
  if (event.role === 'publisher' && state.ownerParticipantId === localParticipantId()) {
    requestDirectPromotion(event.reason);
    return;
  }
  if (event.role === 'receiver' && state.ownerParticipantId !== localParticipantId()) {
    cleanupCoordinatorAudioNodes();
    setSystemAudioReceiving(false);
    notifySubscriberFailure(state);
  }
}

function promoteLocalDirectPublicationToSfu(reason: string): Promise<void> {
  if (directPromotionFlight) return directPromotionFlight;
  if (ambiguousDirectPromotionPublicationId) return Promise.resolve();
  const activeController = controller;
  const state = activeController?.getCurrentState();
  const lease = activeController?.getCurrentLease();
  const track = localTrack;
  const localId = localParticipantId();
  if (
    !activeController ||
    state?.status !== 'live' ||
    !isProRoomSystemAudioDirectPublication(state.publication) ||
    !lease?.hasCredential ||
    lease.status !== 'live' ||
    lease.generation !== state.generation ||
    state.ownerParticipantId !== localId ||
    !track
  ) {
    return Promise.resolve();
  }

  const identity: LocalLeaseIdentity = {
    epoch: serviceSessionEpoch,
    roomCode: lease.roomCode,
    generation: lease.generation,
  };
  const publicationId = state.publication.publicationId;
  let attemptedPublication: ProRoomSystemAudioPublication | null = null;
  const flight = Promise.resolve().then(async () => {
    try {
      const descriptor = await publishProSystemAudioSfu({
        track,
        generation: identity.generation,
        // The direct state's numeric value is compatibility-only. Use a
        // provisional future timer while creating the SFU session; the commit
        // response below immediately replaces it with the server-owned
        // promotion deadline through settleCanonicalSfuPublisher().
        expiresAt: Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
        roomId: identity.roomCode,
      });
      const current = activeController.getCurrentState();
      if (
        directPromotionFlight !== flight ||
        controller !== activeController ||
        !isLocalLeaseCurrent(identity) ||
        current?.status !== 'live' ||
        current.ownerParticipantId !== localId ||
        !isProRoomSystemAudioDirectPublication(current.publication) ||
        current.publication.publicationId !== publicationId
      ) {
        throw new ProRoomSystemAudioControllerError('OPERATION_SUPERSEDED');
      }

      const publication: ProRoomSystemAudioPublication = {
        publicationId,
        sessionId: descriptor.sessionId,
        track: { ...descriptor.track },
      };
      attemptedPublication = publication;
      const promoted = await activeController.commitProSystemAudioPublication(publication);
      if (
        directPromotionFlight !== flight ||
        !isLocalLeaseCurrent(identity) ||
        promoted.status !== 'live' ||
        !isProRoomSystemAudioSfuPublication(promoted.publication) ||
        promoted.publication.publicationId !== publicationId
      ) {
        throw new ProRoomSystemAudioControllerError('OPERATION_SUPERSEDED');
      }
      acceptPromotedSfuPublication(promoted, reason);
    } catch (error) {
      if (directPromotionFlight !== flight) return;
      log.warn(`[PRO SystemAudio] LAN-direct to SFU promotion failed (${reason})`, error);
      if (attemptedPublication) {
        ambiguousDirectPromotionPublicationId = publicationId;
        await reconcileAmbiguousDirectPromotion({
          controller: activeController,
          identity,
          localParticipantId: localId,
          publication: attemptedPublication,
          reason,
        });
      } else {
        stopProSystemAudioSfuPublisher();
        const current = activeController.getCurrentState();
        if (
          isLocalLeaseCurrent(identity) &&
          current?.status === 'live' &&
          current.ownerParticipantId === localId &&
          isProRoomSystemAudioDirectPublication(current.publication) &&
          current.publication.publicationId === publicationId
        ) {
          scheduleDirectPromotionRetry('promotion-retry');
        }
      }
    } finally {
      if (directPromotionFlight === flight) directPromotionFlight = null;
    }
  });
  directPromotionFlight = flight;
  return flight;
}

function requestDirectPromotion(reason: string): void {
  observeSystemAudioTask(
    promoteLocalDirectPublicationToSfu(reason),
    `LAN-direct to SFU promotion (${reason})`,
  );
}

function reconcileCoordinatorState(state: ProRoomSystemAudioState): void {
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
    resetProSystemAudioDirectTransport({ notifyPeers: false });
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
  if (state) reconcileCoordinatorState(state);
}

function onLocalLeaseLost(reason: ProRoomSystemAudioLeaseLossReason): void {
  clearManagedTimer(LEASE_HEARTBEAT_TIMER);
  clearManagedTimer(LEASE_RELEASE_RETRY_TIMER);
  clearManagedTimer(PUBLISHER_RETRY_TIMER);
  clearManagedTimer(DIRECT_PROMOTION_RETRY_TIMER);
  stopProSystemAudioSfuPublisher();
  resetProSystemAudioDirectTransport({ notifyPeers: true, reason: 'superseded' });
  directPromotionFlight = null;
  ambiguousDirectPromotionPublicationId = null;
  failedSfuPublisherSessionId = null;
  localPublishFlight = null;
  localPublicationId = null;
  directAuthorityHeartbeatFailureStartedAt = null;
  if ((expectedLeaseTransitions.get(serviceSessionEpoch) ?? 0) > 0) return;
  localTrack = null;
  leaseHeartbeatFailureNotified = false;
  bus.emit('pro-system-audio:lease-lost', reason);
}

function onLocalLeaseAuthorityConfirmed(): void {
  // A failed heartbeat POST may have lost only its response. The controller's
  // fallback authenticated GET still proves the exact generation/owner lease,
  // so that proof resets direct's bounded authority-loss window while the
  // normal heartbeat retry continues.
  directAuthorityHeartbeatFailureStartedAt = null;
}

export function configureProSystemAudioService(api: ProRoomApiClient): void {
  if (controller) return;
  controller = new ProRoomSystemAudioController(api, {
    state: onControllerState,
    localLeaseLost: onLocalLeaseLost,
    localLeaseAuthorityConfirmed: onLocalLeaseAuthorityConfirmed,
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
  configureProSystemAudioDirectTransport({
    getLocalIdentity: () => {
      const participantId = localParticipantId();
      return isActiveProRoom() && participantId ? { participantId } : null;
    },
    authorizeInboundOffer: authorizeInboundDirectOffer,
    authorizeInboundSignal: authorizeInboundDirectSignal,
    onReceiverTrackReady: attachDirectCoordinatorTrack,
    onLiveRouteFallback: handleDirectRouteFallback,
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
    const hadLocalActivity = Boolean(localTrack || localPublishFlight || publisherRecoveryFlight);
    const controllerWillNotifyLeaseLoss = Boolean(controller?.getCurrentLease());
    refreshFlight = null;
    queuedForcedRefresh = null;
    oversizedDirectRefreshFlight = null;
    serviceSessionEpoch += 1;
    localLeaseAttemptOwner = null;
    expectedLeaseTransitions.clear();
    cancelPublisherRecovery();
    localPublishFlight = null;
    clearManagedTimer(LEASE_HEARTBEAT_TIMER);
    clearManagedTimer(LEASE_RELEASE_RETRY_TIMER);
    clearManagedTimer(PUBLISHER_RETRY_TIMER);
    clearManagedTimer(DIRECT_PROMOTION_RETRY_TIMER);
    stopProSystemAudioSfuPublisher();
    resetProSystemAudioDirectTransport({ notifyPeers: false });
    directPromotionFlight = null;
    ambiguousDirectPromotionPublicationId = null;
    failedSfuPublisherSessionId = null;
    localTrack = null;
    localPublicationId = null;
    leaseHeartbeatFailureNotified = false;
    directAuthorityHeartbeatFailureStartedAt = null;
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
  if (state) reconcileCoordinatorState(state);
}

export function resetProSystemAudioService(): void {
  const hadLocalActivity = Boolean(localTrack || localPublishFlight || publisherRecoveryFlight);
  const controllerWillNotifyLeaseLoss = Boolean(controller?.getCurrentLease());
  serviceSessionEpoch += 1;
  localLeaseAttemptOwner = null;
  expectedLeaseTransitions.clear();
  cancelPublisherRecovery();
  clearManagedTimer(LEASE_HEARTBEAT_TIMER);
  clearManagedTimer(LEASE_RELEASE_RETRY_TIMER);
  clearManagedTimer(SUBSCRIBER_RETRY_TIMER);
  clearManagedTimer(PUBLISHER_RETRY_TIMER);
  clearManagedTimer(DIRECT_PROMOTION_RETRY_TIMER);
  cleanupCoordinatorGraph();
  stopProSystemAudioSfuPublisher();
  resetProSystemAudioDirectTransport({ notifyPeers: false });
  directPromotionFlight = null;
  ambiguousDirectPromotionPublicationId = null;
  failedSfuPublisherSessionId = null;
  controller?.reset();
  if (hadLocalActivity && !controllerWillNotifyLeaseLoss) {
    bus.emit('pro-system-audio:lease-lost', 'reset');
  }
  latestSnapshot = null;
  latestView = idleView();
  remoteOwnerDisplayName = null;
  refreshFlight = null;
  queuedForcedRefresh = null;
  oversizedDirectRefreshFlight = null;
  localTrack = null;
  localPublicationId = null;
  localPublishFlight = null;
  boundSessionKey = null;
  leaseHeartbeatFailureNotified = false;
  directAuthorityHeartbeatFailureStartedAt = null;
  subscriberFailureGeneration = null;
}

export function getProSystemAudioViewState(): ProRoomSystemAudioViewState {
  return {
    ...latestView,
    publication: latestView.publication ? clonePublication(latestView.publication) : null,
  };
}

export function getProSystemAudioOwnerDisplayName(): string | null {
  return ownerDisplayName(controller?.getCurrentState() ?? null);
}

export function isLocalProSystemAudioOwner(): boolean {
  return latestView.isLocalOwner;
}

function beginProSystemAudioRefresh(signal?: AbortSignal): Promise<ProRoomSystemAudioState> {
  if (!controller) return Promise.reject(new Error('PRO_SYSTEM_AUDIO_NOT_CONFIGURED'));
  if (refreshFlight) return refreshFlight;
  const flight = controller.refreshProSystemAudioState(signal).finally(() => {
    if (refreshFlight === flight) refreshFlight = null;
  });
  refreshFlight = flight;
  return flight;
}

export function refreshProSystemAudioState(
  signal?: AbortSignal,
  forceAfterCurrent = false,
): Promise<ProRoomSystemAudioState> {
  if (!controller) return Promise.reject(new Error('PRO_SYSTEM_AUDIO_NOT_CONFIGURED'));
  if (!refreshFlight || !forceAfterCurrent) return beginProSystemAudioRefresh(signal);
  if (queuedForcedRefresh) return queuedForcedRefresh;
  const epoch = serviceSessionEpoch;
  const currentFlight = refreshFlight;
  const queued = currentFlight
    .catch(() => undefined)
    .then(() => {
      if (!isServiceSessionCurrent(epoch)) throw new Error('PRO_SYSTEM_AUDIO_REFRESH_SUPERSEDED');
      return beginProSystemAudioRefresh(signal);
    })
    .finally(() => {
      if (queuedForcedRefresh === queued) queuedForcedRefresh = null;
    });
  queuedForcedRefresh = queued;
  return queued;
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
          directAuthorityHeartbeatFailureStartedAt = null;
          notifyMutation(state);
          if (isLocalLeaseCurrent(identity) && controller?.getCurrentLease()?.status === 'live') {
            scheduleLeaseHeartbeat();
          }
        })
        .catch((error) => {
          if (!isLocalLeaseCurrent(identity)) return;
          log.warn('[PRO SystemAudio] Lease heartbeat failed', error);
          const current = activeController.getCurrentState();
          const currentIsDirect = Boolean(
            current?.status === 'live' &&
            current.generation === identity.generation &&
            isProRoomSystemAudioDirectPublication(current.publication),
          );
          if (currentIsDirect) {
            const nowMs = Date.now();
            directAuthorityHeartbeatFailureStartedAt ??= nowMs;
            if (
              nowMs - directAuthorityHeartbeatFailureStartedAt >=
              DIRECT_AUTHORITY_LOSS_GRACE_MS
            ) {
              log.warn(
                '[PRO SystemAudio] LAN-direct authority heartbeat grace elapsed; stopping publication',
              );
              onLocalLeaseLost('authoritative-revocation');
              return;
            }
          } else {
            // SFU still has its fixed authoritative media deadline. Do not
            // carry a previous direct-route watchdog window across promotion.
            directAuthorityHeartbeatFailureStartedAt = null;
          }
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
  track: MediaStreamTrack,
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
  localTrack = track;
  localPublicationId = publicationId;
  try {
    const directTargets = currentDirectTargets();
    activeLocalDirectPublicationKey = null;
    let publication: ProRoomSystemAudioPublication | null = null;
    try {
      publication = await attemptProSystemAudioDirectPublication({
        track,
        generation: lease.generation,
        publicationId,
        targets: directTargets,
      });
    } catch (error) {
      // Local discovery is an optimization. Any unsupported or isolated LAN
      // topology must fall back to the established SFU publication path.
      log.debug('[PRO SystemAudio] LAN-direct probe unavailable; using SFU', error);
    }
    if (!ownsLocalPublishFlight(flight) || !isLocalLeaseCurrent(flight.identity)) {
      throw new ProRoomSystemAudioControllerError('OPERATION_SUPERSEDED');
    }
    if (!publication) {
      const descriptor = await publishProSystemAudioSfu({
        track,
        generation: lease.generation,
        expiresAt: Date.now() + SYSTEM_AUDIO_SHARE_LIMIT_MS,
        roomId: lease.roomCode,
      });
      publication = {
        publicationId,
        sessionId: descriptor.sessionId,
        track: { ...descriptor.track },
      };
    }
    if (!ownsLocalPublishFlight(flight) || !isLocalLeaseCurrent(flight.identity)) {
      throw new ProRoomSystemAudioControllerError('OPERATION_SUPERSEDED');
    }
    const state = await activeController.commitProSystemAudioPublication(publication);
    if (!ownsLocalPublishFlight(flight) || !isLocalLeaseCurrent(flight.identity)) {
      throw new ProRoomSystemAudioControllerError('OPERATION_SUPERSEDED');
    }
    if (state.status === 'live' && isProRoomSystemAudioSfuPublication(state.publication)) {
      settleCanonicalSfuPublisher(state);
    } else if (state.status === 'live') {
      const activationTargets = currentDirectTargets();
      const activated = await activateProSystemAudioDirectPublication({
        ownerParticipantId: state.ownerParticipantId,
        generation: state.generation,
        publicationId: state.publication.publicationId,
        targets: activationTargets,
      });
      if (!activated) requestDirectPromotion('post-commit-activation-failed');
      else {
        activeLocalDirectPublicationKey = directPublicationKey(
          state.ownerParticipantId,
          state.generation,
          state.publication.publicationId,
        );
        const reconciled = await reconcileProSystemAudioDirectTargets(currentDirectTargets());
        if (!reconciled) requestDirectPromotion('post-commit-target-fallback');
      }
    }
    notifyMutation(state);
    if (state.status === 'live') {
      broadcastSystemMessage('chat.system_audio_started_system_message');
    }
    if (state.status !== 'live' || !isProRoomSystemAudioSfuPublication(state.publication)) {
      clearManagedTimer(PUBLISHER_RETRY_TIMER);
    }
    clearManagedTimer(DIRECT_PROMOTION_RETRY_TIMER);
    leaseHeartbeatFailureNotified = false;
    directAuthorityHeartbeatFailureStartedAt = null;
    scheduleLeaseHeartbeat();
    return state;
  } catch (error) {
    // A superseded publish can finish after a new tab incarnation has already
    // acquired and published. Only the flight that still owns the singleton
    // SFU publisher may tear it down or release its exact lease.
    if (ownsLocalPublishFlight(flight)) {
      resetProSystemAudioDirectTransport({ notifyPeers: true, reason: 'fallback' });
      stopProSystemAudioSfuPublisher();
      localTrack = null;
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
  clearManagedTimer(DIRECT_PROMOTION_RETRY_TIMER);
  leaseHeartbeatFailureNotified = false;
  directAuthorityHeartbeatFailureStartedAt = null;
  directPromotionFlight = null;
  ambiguousDirectPromotionPublicationId = null;
  failedSfuPublisherSessionId = null;
  resetProSystemAudioDirectTransport({ notifyPeers: true, reason: 'stopped' });
  stopProSystemAudioSfuPublisher();
  localTrack = null;
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
  if (!activeController || publisherRecoveryFlight || !localTrack || !lease?.hasCredential) {
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
  const track = localTrack;
  const name = latestSnapshot?.viewer?.displayName ?? 'Peer';
  bus.emit('ui:show-toast', t('system_audio.connection_unstable', { name }));
  beginExpectedLeaseTransition(epoch);
  let reacquiredIdentity: LocalLeaseIdentity | null = null;
  try {
    if (!ownsPublisherRecovery(flight) || !isLocalLeaseCurrent(flight.initialLease)) return;
    const idle = await activeController.releaseProSystemAudioLease(flight.abortController.signal);
    if (!ownsPublisherRecovery(flight)) return;
    if (idle.status !== 'idle' || idle.generation < flight.initialLease.generation) {
      terminateOwnedPublisherRecovery(flight, track);
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
      // recovery lease, fence it without touching a newer local publication
      // or a capture attempt that adopted the controller's shared acquire.
      if (
        isServiceSessionCurrent(epoch) &&
        controller === activeController &&
        !localPublishFlight &&
        !localLeaseAttemptOwner &&
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
      terminateOwnedPublisherRecovery(flight, track);
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
    localTrack = track;
    await publishLocalProSystemAudio(track);
  } catch (error) {
    if (!ownsPublisherRecovery(flight)) return;
    const current = activeController.getCurrentState();
    const recoveryStateStillCurrent = reacquiredIdentity
      ? isLocalLeaseCurrent(reacquiredIdentity) ||
        Boolean(current?.status === 'idle' && current.generation >= reacquiredIdentity.generation)
      : isLocalLeaseCurrent(flight.initialLease) ||
        Boolean(current?.status === 'idle' && current.generation >= flight.initialLease.generation);
    if (!recoveryStateStillCurrent) {
      terminateOwnedPublisherRecovery(flight, track);
      return;
    }
    log.warn('[PRO SystemAudio] Publisher recovery failed', error);
    localTrack = null;
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
      resetProSystemAudioDirectTransport({ notifyPeers: false });
      directPromotionFlight = null;
      ambiguousDirectPromotionPublicationId = null;
      failedSfuPublisherSessionId = null;
      subscriberFailureGeneration = null;
      return;
    }
    cleanupSystemAudioSfuGuestRoute();
    const state = controller?.getCurrentState();
    if (state) reconcileCoordinatorState(state);
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
      const descriptorTrack = event.descriptor.track;
      if (!identity || !descriptorTrack) return;
      void attachCoordinatorTrack(identity, descriptorTrack, event.track).catch((error) =>
        log.warn('[PRO SystemAudio] Track attach failed', error),
      );
      return;
    }
    if (
      event.type === 'subscriber-state' &&
      (event.state === 'disconnected' || event.state === 'subscribed')
    ) {
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
      if (event.state === 'subscribed') {
        clearManagedTimer(SUBSCRIBER_DISCONNECT_TIMER);
        if (coordinatorSource) {
          setSystemAudioReceiving(true);
          claimPlaybackOwner('system-audio');
          bus.emit('visualizer:start');
        }
        return;
      }
      setManagedTimer(
        SUBSCRIBER_DISCONNECT_TIMER,
        () => {
          if (!coordinatorPublicationMatches(identity)) return;
          setSystemAudioReceiving(false);
        },
        RECOVERY_DELAY_MS,
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
      cleanupCoordinatorSubscriptionForRetry();
      setSystemAudioReceiving(false);
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
    if (event.type === 'publisher-state' && event.state === 'published') {
      if (
        event.descriptor &&
        failedSfuPublisherSessionId !== null &&
        failedSfuPublisherSessionId !== event.descriptor.sessionId
      ) {
        failedSfuPublisherSessionId = null;
        clearManagedTimer(PUBLISHER_RETRY_TIMER);
      }
      return;
    }
    if (event.type === 'publisher-state' && event.state === 'failed') {
      const state = controller?.getCurrentState();
      const descriptorMatchesCurrent = Boolean(
        event.descriptor &&
        state?.status === 'live' &&
        isProRoomSystemAudioSfuPublication(state.publication) &&
        descriptorMatchesPublication(event.descriptor, state),
      );
      const currentIsLocalSfuPublisher = Boolean(
        state?.status === 'live' &&
        state.ownerParticipantId === localParticipantId() &&
        isProRoomSystemAudioSfuPublication(state.publication),
      );
      if (
        !localPublishFlight &&
        !directPromotionFlight &&
        !(state?.status === 'live' && isProRoomSystemAudioDirectPublication(state.publication)) &&
        !descriptorMatchesCurrent &&
        !currentIsLocalSfuPublisher
      ) {
        return;
      }
      if (event.descriptor) {
        failedSfuPublisherSessionId = event.descriptor.sessionId;
        scheduleFailedSfuPublisherRecheck(event.descriptor.sessionId);
        return;
      }
      if (
        localPublishFlight ||
        directPromotionFlight ||
        (state?.status === 'live' && isProRoomSystemAudioDirectPublication(state.publication))
      ) {
        clearManagedTimer(PUBLISHER_RETRY_TIMER);
        return;
      }
      setManagedTimer(PUBLISHER_RETRY_TIMER, () => recoverLocalPublisher(), RECOVERY_DELAY_MS);
    }
  });
}
