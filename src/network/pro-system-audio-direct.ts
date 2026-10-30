/**
 * LAN-only media transport for persistent PRO-room system audio.
 *
 * The authenticated PRO realtime socket carries only targeted SDP/ICE. Media
 * peer connections deliberately use host candidates exclusively: this module
 * never loads TURN credentials or calls the Cloudflare Realtime media API.
 *
 * One signaling round trip per route: the publisher's single offer carries the
 * audio m-section (its sender holds no track yet) and the probe data channel.
 * Once its selected pair is a proven LAN pair the receiver says so on that
 * channel; once both ends have proven it the publisher attaches the track and
 * says so on the same channel, and only then does the receiver hand the track
 * to playback. No audio leaves before both proofs, and the publisher reports
 * the route only after both. The offer and answer keep the relay's
 * `phase: 'media'` shape; a receiver ignores the retired probe offer.
 */

import { MAX_SYSTEM_AUDIO_DEVICES } from '../core/constants.ts';
import { log } from '../core/log.ts';
import { clearManagedTimer, delay, setManagedTimer } from '../core/timers.ts';
import {
  onProRoomRealtimeEvent,
  type ProRealtimeRelayEnvelope,
  type ProServerEventEnvelope,
} from '../pro-room/network-bridge.ts';
import { sendProRoomRealtime } from '../pro-room/realtime-sender.ts';
import { findRefinedHostPair, nativePairIdentity, visibleIceAddress } from './ice-selected-pair.ts';
import { forceStereoSdp } from './opus-stereo-sdp.ts';
import { tuneSystemAudioLanDirectSender } from './system-audio-media.ts';

/**
 * From the publisher's offer to its answer. Also the receiver's own proof
 * window and the bound on one locality reproof's statistics read.
 */
const DIRECT_NEGOTIATION_TIMEOUT_MS = 2_000;
/** From the answer to both ends' LAN pair proofs. */
const DIRECT_PAIR_PROOF_TIMEOUT_MS = 1_000;
const DIRECT_PAIR_POLL_MS = 25;
const DIRECT_CHANNEL_LABEL = 'MUSIXQUARE-lan-probe';
/** Sent once by the receiver on the probe channel after its own LAN pair proof. */
const RECEIVER_PAIR_PROVEN_MESSAGE = 'receiver-pair-proven';
/** Sent once by the publisher on the probe channel after it attached the track. */
const PUBLISHER_TRACK_ATTACHED_MESSAGE = 'publisher-track-attached';
const SIGNAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const PARTICIPANT_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const ROUTE_TOKEN_RE = /^[A-Za-z0-9._:-]{1,192}$/;
const MAX_TRACK_ID_LENGTH = 160;
const MAX_DIRECT_TARGETS = MAX_SYSTEM_AUDIO_DEVICES - 1;
const MAX_LOCAL_ICE_CANDIDATES = 2;
const MAX_REMOTE_ICE_CANDIDATES = 2;
const MAX_PRE_OFFER_CANDIDATES_PER_KEY = 2;
const MAX_PRE_OFFER_CANDIDATES_TOTAL = 8;
const MAX_SEEN_RECEIVER_NEGOTIATIONS = 64;
const PRE_OFFER_CANDIDATE_TTL_MS = 5_000;
const LIVE_PAIR_REPROOF_INTERVAL_MS = 5_000;
const RECEIVER_TRACK_READY_TIMEOUT_MS = 5_000;

function observeDirectTask(task: Promise<void>, label: string): void {
  task.catch((error: unknown) => {
    log.debug(`[ProSysAudioDirect] ${label} rejected`, error);
  });
}

async function withinDirectDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timer = globalThis.setTimeout(() => resolve(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

type DirectDirection = 'publisher' | 'subscriber';
type DirectCloseReason = 'stopped' | 'fallback' | 'superseded';
type DirectSignalKind = 'offer' | 'answer' | 'candidate' | 'close';
type PairWaitResult = 'proven' | 'non-local' | 'disconnected' | 'closed' | 'deadline';
type PublisherNegotiationStage = 'offer' | 'answer' | 'pair' | 'receiver-proof' | 'attach';

interface DirectSignalBase {
  kind: DirectSignalKind;
  targetParticipantId: string;
  direction: DirectDirection;
  generation: number;
  publicationId: string;
  negotiationId: string;
}

interface DirectOfferSignal extends DirectSignalBase {
  kind: 'offer';
  direction: 'publisher';
  phase: 'media';
  description: { type: 'offer'; sdp: string };
  trackId: string;
}

interface DirectAnswerSignal extends DirectSignalBase {
  kind: 'answer';
  direction: 'subscriber';
  phase: 'media';
  description: { type: 'answer'; sdp: string };
}

interface DirectCandidateSignal extends DirectSignalBase {
  kind: 'candidate';
  candidate: RTCIceCandidateInit;
}

interface DirectCloseSignal extends DirectSignalBase {
  kind: 'close';
  reason: DirectCloseReason;
}

type DirectSignal =
  DirectOfferSignal | DirectAnswerSignal | DirectCandidateSignal | DirectCloseSignal;

interface ProSystemAudioDirectPublicationDescriptor {
  publicationId: string;
  transport: 'lan-direct';
  protocolVersion: 2;
}

/** A participant incarnation fence used only by the local publisher. */
export interface ProSystemAudioDirectTarget {
  participantId: string;
  routeToken: string;
}

export interface ProSystemAudioDirectInboundSignalContext {
  kind: DirectSignalKind;
  senderParticipantId: string;
  targetParticipantId: string;
  direction: DirectDirection;
  generation: number;
  publicationId: string;
  negotiationId: string;
}

export interface ProSystemAudioDirectInboundOfferContext extends ProSystemAudioDirectInboundSignalContext {
  kind: 'offer';
  ownerParticipantId: string;
  trackId: string;
}

export interface ProSystemAudioDirectTrackReadyEvent {
  ownerParticipantId: string;
  generation: number;
  publicationId: string;
  negotiationId: string;
  track: MediaStreamTrack;
  /** False as soon as this negotiation is superseded, closed, or reset. */
  isCurrent: () => boolean;
}

export interface ProSystemAudioDirectFallbackEvent {
  role: 'publisher' | 'receiver';
  reason: string;
  participantId: string;
  generation: number;
  publicationId: string;
}

/** The publisher whose 'stopped' close ended this receiver's current route. */
export interface ProSystemAudioDirectRouteStoppedEvent {
  participantId: string;
  generation: number;
  publicationId: string;
}

interface ProSystemAudioDirectTransportCallbacks {
  getLocalIdentity: () => { participantId: string } | null;
  authorizeInboundOffer: (context: ProSystemAudioDirectInboundOfferContext) => boolean;
  authorizeInboundSignal: (context: ProSystemAudioDirectInboundSignalContext) => boolean;
  onReceiverTrackReady: (event: ProSystemAudioDirectTrackReadyEvent) => void | Promise<void>;
  onLiveRouteFallback: (event: ProSystemAudioDirectFallbackEvent) => void;
  /**
   * The publisher closed this receiver's current route with 'stopped' (its
   * explicit stop), live or not; the route is already closed (5B-G6).
   */
  onLiveRouteStopped: (event: ProSystemAudioDirectRouteStoppedEvent) => void;
}

interface ProSystemAudioDirectAttemptOptions {
  track: MediaStreamTrack;
  generation: number;
  publicationId: string;
  targets: readonly ProSystemAudioDirectTarget[];
  timeoutMs?: number;
}

interface ProSystemAudioDirectActivation {
  ownerParticipantId: string;
  generation: number;
  publicationId: string;
  targets?: readonly ProSystemAudioDirectTarget[];
}

interface ActivePublication {
  ownerParticipantId: string;
  generation: number;
  publicationId: string;
}

interface PublisherRoute {
  participantId: string;
  routeToken: string;
  generation: number;
  publicationId: string;
  negotiationId: string;
  pc: RTCPeerConnection;
  probeChannel: RTCDataChannel;
  queuedLocalCandidates: RTCIceCandidateInit[];
  queuedRemoteCandidates: RTCIceCandidateInit[];
  localCandidateTuples: Set<string>;
  remoteCandidateTuples: Set<string>;
  acceptedRemoteMdnsKeys: Set<string>;
  localCandidateCount: number;
  /** UDP candidates this end gathered that the LAN rule refused, for the pair-check line. */
  refusedLocalCandidateCount: number;
  /** Remote mDNS ledger keys added; unlike the ledger it survives the route's close. */
  addedRemoteCandidateCount: number;
  /** When the first remote mDNS ledger key was added, for the pair-check line. */
  firstRemoteCandidateAddedAt: number | null;
  remoteCandidateCount: number;
  offerSent: boolean;
  remoteDescriptionReady: boolean;
  provenLocal: boolean;
  failed: boolean;
  closed: boolean;
  /** Why the route ended before its negotiation finished, for the result line. */
  endReason: string | null;
  reproofFlight: Promise<boolean> | null;
  /** 'applying' fences a duplicate answer while the first one is applied. */
  answer: 'none' | 'applying' | 'applied';
  /** The receiver's own LAN pair proof arrived on the probe channel. */
  receiverProven: boolean;
  committed: boolean;
}

interface PublisherSession {
  generation: number;
  publicationId: string;
  track: MediaStreamTrack;
  targets: Map<string, string>;
  routes: Map<string, PublisherRoute>;
  phase: 'probing' | 'live';
  fallbackSent: boolean;
  closed: boolean;
  reconcileRevision: number;
  reconcileDesiredTargets: Map<string, string> | null;
  reconcileTimeoutMs: number;
  reconcileFlight: Promise<boolean> | null;
}

interface ReceiverRoute {
  ownerParticipantId: string;
  generation: number;
  publicationId: string;
  negotiationId: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
  track: MediaStreamTrack | null;
  queuedLocalCandidates: RTCIceCandidateInit[];
  queuedRemoteCandidates: RTCIceCandidateInit[];
  localCandidateTuples: Set<string>;
  remoteCandidateTuples: Set<string>;
  acceptedRemoteMdnsKeys: Set<string>;
  localCandidateCount: number;
  /** UDP candidates this end gathered that the LAN rule refused, for the pair-check line. */
  refusedLocalCandidateCount: number;
  /** Remote mDNS ledger keys added; unlike the ledger it survives the route's close. */
  addedRemoteCandidateCount: number;
  /** When the first remote mDNS ledger key was added, for the pair-check line. */
  firstRemoteCandidateAddedAt: number | null;
  remoteCandidateCount: number;
  answerSent: boolean;
  remoteDescriptionReady: boolean;
  trackDelivered: boolean;
  live: boolean;
  fallbackSent: boolean;
  closed: boolean;
  provenLocal: boolean;
  proofSent: boolean;
  /** The publisher's track-attached message arrived: the track carries audio. */
  publisherAttached: boolean;
  /** ICE gathering ended with no LAN candidate before the answer went out. */
  gatheringEndedWithoutLanCandidate: boolean;
}

interface PreOfferCandidateBucket {
  expiresAt: number;
  candidates: RTCIceCandidateInit[];
}

let callbacks: ProSystemAudioDirectTransportCallbacks | null = null;
let unsubscribeRealtime: (() => void) | null = null;
let publisherSession: PublisherSession | null = null;
let receiverRoute: ReceiverRoute | null = null;
let activePublication: ActivePublication | null = null;
let lifecycleEpoch = 0;
const seenReceiverNegotiations = new Set<string>();
const preOfferCandidates = new Map<string, PreOfferCandidateBucket>();
let preOfferCandidateCount = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function validParticipantId(value: unknown): value is string {
  return typeof value === 'string' && PARTICIPANT_ID_RE.test(value);
}

function validRouteToken(value: unknown): value is string {
  return typeof value === 'string' && ROUTE_TOKEN_RE.test(value);
}

function validSignalId(value: unknown): value is string {
  return typeof value === 'string' && SIGNAL_ID_RE.test(value);
}

function validTrackId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TRACK_ID_LENGTH;
}

function parseDescription<T extends 'offer' | 'answer'>(
  value: unknown,
  type: T,
): { type: T; sdp: string } | null {
  if (
    hasExactKeys(value, ['type', 'sdp']) &&
    value.type === type &&
    typeof value.sdp === 'string' &&
    value.sdp.length > 0
  ) {
    const sdp = sanitizeLanSdp(value.sdp);
    return sdp ? { type, sdp } : null;
  }
  return null;
}

/** A route carries exactly one audio m-section: the publisher's track. */
function sdpHasOneAudioMedia(sdp: string): boolean {
  return sdp.split(/\r?\n/).filter((line) => /^m=audio(?:\s|$)/i.test(line.trim())).length === 1;
}

function forceDirectStereoSdp(sdp: string): string {
  return forceStereoSdp(sdp);
}

function parseCandidate(value: unknown): RTCIceCandidateInit | null {
  if (
    !hasExactKeys(value, ['candidate'], ['sdpMid', 'sdpMLineIndex', 'usernameFragment']) ||
    typeof value.candidate !== 'string' ||
    !candidateLineIsLanSafe(value.candidate) ||
    (value.sdpMid !== undefined && value.sdpMid !== null && typeof value.sdpMid !== 'string') ||
    (value.sdpMLineIndex !== undefined &&
      value.sdpMLineIndex !== null &&
      (!Number.isSafeInteger(value.sdpMLineIndex) || Number(value.sdpMLineIndex) < 0)) ||
    (value.usernameFragment !== undefined &&
      value.usernameFragment !== null &&
      typeof value.usernameFragment !== 'string')
  ) {
    return null;
  }
  return {
    candidate: value.candidate,
    ...(value.sdpMid === undefined ? {} : { sdpMid: value.sdpMid as string | null }),
    ...(value.sdpMLineIndex === undefined
      ? {}
      : { sdpMLineIndex: value.sdpMLineIndex as number | null }),
    ...(value.usernameFragment === undefined
      ? {}
      : { usernameFragment: value.usernameFragment as string | null }),
  };
}

function parseSignal(value: unknown): DirectSignal | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  const commonKeys = [
    'kind',
    'targetParticipantId',
    'direction',
    'generation',
    'publicationId',
    'negotiationId',
  ];
  if (
    !validParticipantId(value.targetParticipantId) ||
    (value.direction !== 'publisher' && value.direction !== 'subscriber') ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !validSignalId(value.publicationId) ||
    !validSignalId(value.negotiationId)
  ) {
    return null;
  }
  const base = {
    targetParticipantId: value.targetParticipantId,
    generation: value.generation,
    publicationId: value.publicationId,
    negotiationId: value.negotiationId,
  };
  // The retired two-round-trip protocol's 'probe' offer and answer parse to
  // null, so a mixed-version pair never builds a route and uses the SFU.
  if (value.kind === 'offer' && value.direction === 'publisher') {
    if (
      value.phase !== 'media' ||
      !hasExactKeys(value, [...commonKeys, 'phase', 'description', 'trackId']) ||
      !validTrackId(value.trackId)
    ) {
      return null;
    }
    const description = parseDescription(value.description, 'offer');
    if (!description || !sdpHasOneAudioMedia(description.sdp)) return null;
    return {
      ...base,
      kind: 'offer',
      direction: 'publisher',
      phase: 'media',
      description,
      trackId: value.trackId,
    };
  }
  if (value.kind === 'answer' && value.direction === 'subscriber') {
    if (value.phase !== 'media' || !hasExactKeys(value, [...commonKeys, 'phase', 'description'])) {
      return null;
    }
    const description = parseDescription(value.description, 'answer');
    return description && sdpHasOneAudioMedia(description.sdp)
      ? {
          ...base,
          kind: 'answer',
          direction: 'subscriber',
          phase: 'media',
          description,
        }
      : null;
  }
  if (value.kind === 'candidate') {
    if (!hasExactKeys(value, [...commonKeys, 'candidate'])) return null;
    const candidate = parseCandidate(value.candidate);
    return candidate ? { ...base, kind: 'candidate', direction: value.direction, candidate } : null;
  }
  if (value.kind === 'close') {
    if (
      !hasExactKeys(value, [...commonKeys, 'reason']) ||
      (value.reason !== 'stopped' && value.reason !== 'fallback' && value.reason !== 'superseded')
    ) {
      return null;
    }
    return {
      ...base,
      kind: 'close',
      direction: value.direction,
      reason: value.reason,
    };
  }
  return null;
}

function signalContext(
  signal: DirectSignal,
  senderParticipantId: string,
): ProSystemAudioDirectInboundSignalContext {
  return {
    kind: signal.kind,
    senderParticipantId,
    targetParticipantId: signal.targetParticipantId,
    direction: signal.direction,
    generation: signal.generation,
    publicationId: signal.publicationId,
    negotiationId: signal.negotiationId,
  };
}

function randomNegotiationId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const values = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(values);
  const suffix = Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
  return `direct_${suffix || `${Date.now()}00000000`}`;
}

function normalizedTargets(
  targets: readonly ProSystemAudioDirectTarget[],
  localParticipantId: string,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const target of targets) {
    if (!validParticipantId(target?.participantId) || !validRouteToken(target?.routeToken)) {
      throw new Error('PRO_SYSTEM_AUDIO_DIRECT_TARGET_INVALID');
    }
    if (target.participantId === localParticipantId) continue;
    const previousToken = result.get(target.participantId);
    if (previousToken !== undefined && previousToken !== target.routeToken) {
      throw new Error('PRO_SYSTEM_AUDIO_DIRECT_TARGET_DUPLICATE');
    }
    result.set(target.participantId, target.routeToken);
    if (result.size > MAX_DIRECT_TARGETS) {
      throw new Error('PRO_SYSTEM_AUDIO_DIRECT_TARGET_LIMIT');
    }
  }
  return result;
}

function candidateInit(candidate: RTCIceCandidate): RTCIceCandidateInit {
  if (typeof candidate.toJSON === 'function') return candidate.toJSON();
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  };
}

function sendSignal(signal: DirectSignal): boolean {
  try {
    return sendProRoomRealtime('system-audio-signal', { ...signal });
  } catch (error) {
    log.debug('[ProSysAudioDirect] Signaling send failed', error);
    return false;
  }
}

function samePublication(
  value: { generation: number; publicationId: string },
  generation: number,
  publicationId: string,
): boolean {
  return value.generation === generation && value.publicationId === publicationId;
}

function receiverNegotiationKey(
  ownerParticipantId: string,
  generation: number,
  publicationId: string,
  negotiationId: string,
): string {
  return `${ownerParticipantId}:${generation}:${publicationId}:${negotiationId}`;
}

function rememberReceiverNegotiation(key: string): boolean {
  if (
    seenReceiverNegotiations.has(key) ||
    seenReceiverNegotiations.size >= MAX_SEEN_RECEIVER_NEGOTIATIONS
  ) {
    return false;
  }
  seenReceiverNegotiations.add(key);
  return true;
}

function prunePreOfferCandidates(now = Date.now()): void {
  for (const [key, bucket] of preOfferCandidates) {
    if (bucket.expiresAt > now) continue;
    preOfferCandidateCount -= bucket.candidates.length;
    preOfferCandidates.delete(key);
  }
}

function queuePreOfferCandidate(ownerParticipantId: string, signal: DirectCandidateSignal): void {
  prunePreOfferCandidates();
  const candidate = sanitizeLanCandidateInit(signal.candidate);
  const tuple = candidate ? candidateTuple(candidate) : null;
  if (!candidate || !tuple) return;
  const key = receiverNegotiationKey(
    ownerParticipantId,
    signal.generation,
    signal.publicationId,
    signal.negotiationId,
  );
  if (
    seenReceiverNegotiations.has(key) ||
    preOfferCandidateCount >= MAX_PRE_OFFER_CANDIDATES_TOTAL
  ) {
    return;
  }
  let bucket = preOfferCandidates.get(key);
  if (!bucket) {
    bucket = { expiresAt: Date.now() + PRE_OFFER_CANDIDATE_TTL_MS, candidates: [] };
    preOfferCandidates.set(key, bucket);
  }
  if (bucket.candidates.length >= MAX_PRE_OFFER_CANDIDATES_PER_KEY) return;
  if (bucket.candidates.some((queued) => candidateTuple(queued) === tuple)) return;
  bucket.candidates.push(candidate);
  bucket.expiresAt = Date.now() + PRE_OFFER_CANDIDATE_TTL_MS;
  preOfferCandidateCount += 1;
}

function takePreOfferCandidates(
  ownerParticipantId: string,
  signal: DirectOfferSignal,
): RTCIceCandidateInit[] {
  prunePreOfferCandidates();
  const key = receiverNegotiationKey(
    ownerParticipantId,
    signal.generation,
    signal.publicationId,
    signal.negotiationId,
  );
  const bucket = preOfferCandidates.get(key);
  if (!bucket) return [];
  preOfferCandidates.delete(key);
  preOfferCandidateCount -= bucket.candidates.length;
  return bucket.candidates;
}

function clearPreOfferCandidates(): void {
  preOfferCandidates.clear();
  preOfferCandidateCount = 0;
}

function pcConnected(pc: RTCPeerConnection): boolean {
  return (
    pc.connectionState === 'connected' ||
    pc.iceConnectionState === 'connected' ||
    pc.iceConnectionState === 'completed'
  );
}

function pcDisconnected(pc: RTCPeerConnection): boolean {
  return (
    pc.connectionState === 'disconnected' ||
    pc.connectionState === 'failed' ||
    pc.connectionState === 'closed' ||
    pc.iceConnectionState === 'disconnected' ||
    pc.iceConnectionState === 'failed' ||
    pc.iceConnectionState === 'closed'
  );
}

function publisherRouteTimerName(route: PublisherRoute): string {
  return `pro-system-audio-direct-reproof:${route.negotiationId}`;
}

function receiverTrackReadyTimerName(route: ReceiverRoute): string {
  return `pro-system-audio-direct-track-ready:${route.negotiationId}`;
}

function publisherRouteIsCurrent(session: PublisherSession, route: PublisherRoute): boolean {
  return (
    publisherSession === session &&
    !session.closed &&
    !route.closed &&
    !route.failed &&
    session.routes.get(route.participantId) === route &&
    session.targets.get(route.participantId) === route.routeToken &&
    (!session.reconcileDesiredTargets ||
      session.reconcileDesiredTargets.get(route.participantId) === route.routeToken) &&
    samePublication(session, route.generation, route.publicationId)
  );
}

function publisherSessionHasExactCoverage(session: PublisherSession): boolean {
  if (!publisherSessionHasExactRouteSet(session)) return false;
  for (const [participantId, routeToken] of session.targets) {
    const route = session.routes.get(participantId);
    if (
      !route ||
      route.routeToken !== routeToken ||
      !publisherRouteIsCurrent(session, route) ||
      !route.provenLocal ||
      pcDisconnected(route.pc)
    ) {
      return false;
    }
  }
  return true;
}

function publisherSessionHasExactRouteSet(session: PublisherSession): boolean {
  if (session.routes.size !== session.targets.size) return false;
  for (const [participantId, routeToken] of session.targets) {
    const route = session.routes.get(participantId);
    if (!route || route.routeToken !== routeToken || !publisherRouteIsCurrent(session, route)) {
      return false;
    }
  }
  return true;
}

function statsString(report: unknown, key: string): string | null {
  const value = isRecord(report) ? report[key] : null;
  return typeof value === 'string' ? value : null;
}

function statsNumber(report: unknown, key: string): number | null {
  const value = isRecord(report) ? report[key] : null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function candidateAddress(report: unknown): string | null {
  for (const key of ['address', 'ip', 'ipAddress']) {
    const value = statsString(report, key);
    if (value) return value;
  }
  return null;
}

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^(?:0|[1-9]\d{0,2})$/.test(part) ? Number(part) : -1));
  return octets.every((octet) => octet >= 0 && octet <= 255)
    ? (octets as [number, number, number, number])
    : null;
}

function isRfc1918Ipv4(octets: readonly number[]): boolean {
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function parseIpv6(rawAddress: string): number[] | null {
  let address = rawAddress.toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  address = address.split('%', 1)[0] ?? '';
  if (!address || address.includes('.') || !/^[0-9a-f:]+$/.test(address)) return null;
  const compression = address.indexOf('::');
  if (compression !== -1 && compression !== address.lastIndexOf('::')) return null;
  const parseSide = (value: string): number[] | null => {
    if (!value) return [];
    const parts = value.split(':');
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };
  if (compression === -1) {
    const words = parseSide(address);
    return words?.length === 8 ? words : null;
  }
  const left = parseSide(address.slice(0, compression));
  const right = parseSide(address.slice(compression + 2));
  if (!left || !right || left.length + right.length >= 8) return null;
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function isIpv6LinkLocal(words: readonly number[]): boolean {
  return ((words[0] ?? 0) & 0xffc0) === 0xfe80;
}

function isIpv6UniqueLocal(words: readonly number[]): boolean {
  return ((words[0] ?? 0) & 0xfe00) === 0xfc00;
}

function isUuidLikeMdnsAddress(address: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.local$/i.test(
    address,
  );
}

function isPrivateNumericAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) return isRfc1918Ipv4(ipv4);
  const ipv6 = parseIpv6(address);
  return Boolean(ipv6 && (isIpv6LinkLocal(ipv6) || isIpv6UniqueLocal(ipv6)));
}

function parseLanCandidateLine(
  candidateLine: string,
): { address: string; tuple: string; ledgerKey: string; candidate: string } | null {
  const normalized = candidateLine.trim().replace(/^a=/i, '');
  const fields = normalized.split(/\s+/);
  if (
    fields.length < 8 ||
    !/^candidate:[^\s]+$/i.test(fields[0] ?? '') ||
    fields[1] !== '1' ||
    fields[2]?.toLowerCase() !== 'udp' ||
    !/^\d+$/.test(fields[3] ?? '') ||
    !/^\d{1,5}$/.test(fields[5] ?? '')
  ) {
    return null;
  }
  const priority = Number(fields[3]);
  const port = Number(fields[5]);
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 0xffff_ffff) return null;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  const typeIndex = fields.findIndex((field) => field.toLowerCase() === 'typ');
  if (typeIndex !== 6 || fields[typeIndex + 1]?.toLowerCase() !== 'host') return null;
  const address = fields[4] ?? '';
  const foundation = (fields[0] ?? '').slice('candidate:'.length);
  return isUuidLikeMdnsAddress(address)
    ? {
        address,
        tuple: `${address.toLowerCase()}:${port}`,
        ledgerKey: `${foundation}:${port}`,
        candidate: [
          fields[0],
          '1',
          'udp',
          fields[3],
          address.toLowerCase(),
          port,
          'typ',
          'host',
        ].join(' '),
      }
    : null;
}

function sanitizeLanCandidateInit(candidate: RTCIceCandidateInit): RTCIceCandidateInit | null {
  if (!candidate || typeof candidate.candidate !== 'string') return null;
  const parsed = parseLanCandidateLine(candidate.candidate);
  if (!parsed) return null;
  const sanitized: RTCIceCandidateInit = { candidate: parsed.candidate };
  if (candidate.sdpMid === null || typeof candidate.sdpMid === 'string') {
    sanitized.sdpMid = candidate.sdpMid;
  }
  if (
    candidate.sdpMLineIndex === null ||
    (Number.isSafeInteger(candidate.sdpMLineIndex) && (candidate.sdpMLineIndex ?? -1) >= 0)
  ) {
    sanitized.sdpMLineIndex = candidate.sdpMLineIndex;
  }
  if (candidate.usernameFragment === null || typeof candidate.usernameFragment === 'string') {
    sanitized.usernameFragment = candidate.usernameFragment;
  }
  return sanitized;
}

function candidateLineIsLanSafe(candidateLine: string): boolean {
  return parseLanCandidateLine(candidateLine) !== null;
}

/** A gathered UDP candidate line of any address or type, for the refused count only. */
function isUdpCandidateLine(candidateLine: string | undefined): boolean {
  const fields = (candidateLine ?? '').trim().replace(/^a=/i, '').split(/\s+/);
  return /^candidate:/i.test(fields[0] ?? '') && fields[2]?.toLowerCase() === 'udp';
}

function sanitizeLanSdp(sdp: string): string {
  const separator = sdp.includes('\r\n') ? '\r\n' : '\n';
  const sourceLines = sdp.split(/\r?\n/);
  return sourceLines
    .filter((line) => {
      const trimmed = line.trim();
      return !/^a=(?:candidate:|remote-candidates:|end-of-candidates$)/i.test(trimmed);
    })
    .map((line) => {
      const match = /^c=IN\s+(IP4|IP6)\s+(\S+)(.*)$/i.exec(line.trim());
      if (!match) return line;
      const family = match[1]?.toUpperCase();
      const address = match[2] ?? '';
      const suffix = match[3] ?? '';
      const unspecified = address === '0.0.0.0' || address === '::';
      if (unspecified) return line;
      return `c=IN ${family} ${family === 'IP6' ? '::' : '0.0.0.0'}${suffix}`;
    })
    .join(separator);
}

function candidateTuple(candidate: RTCIceCandidateInit): string | null {
  return candidate.candidate ? (parseLanCandidateLine(candidate.candidate)?.tuple ?? null) : null;
}

function addressesProveSameLan(localAddress: string, remoteAddress: string): boolean {
  return Boolean(
    isUuidLikeMdnsAddress(remoteAddress) &&
    (isPrivateNumericAddress(localAddress) || isUuidLikeMdnsAddress(localAddress)),
  );
}

type SelectedPairLocality = 'same-subnet' | 'non-local' | 'pending';

/**
 * Which check decided one reading of the selected pair. A diagnostic name for
 * the pair-check line only; the reading's locality is what callers act on.
 */
type PairRule =
  | 'native-host'
  | 'native-key-pending'
  | 'native-type'
  | 'native-address'
  | 'refined-host'
  | 'refined-key-pending'
  | 'refined-address'
  | 'prflx-unrefined'
  | 'prflx-still-listed'
  | 'snapshot-changed'
  | 'stats-host'
  | 'stats-key-pending'
  | 'stats-type'
  | 'stats-address'
  | 'stats-ambiguous'
  | 'stats-missing'
  | 'unavailable'
  | 'read-deadline';

type IceAddressKind =
  'mdns' | 'private-ipv4' | 'private-ipv6' | 'link-local' | 'public' | 'other' | 'none';

/** Candidate types and address kinds of one view of the pair: never an address or port. */
interface PairView {
  localType: string;
  localKind: IceAddressKind;
  remoteType: string;
  remoteKind: IceAddressKind;
}

/** One reading of an end's selected pair: its locality, the deciding rule and both views. */
interface PairReading {
  locality: SelectedPairLocality;
  rule: PairRule;
  native: PairView | null;
  stats: PairView | null;
}

const ICE_CANDIDATE_TYPES: ReadonlySet<string> = new Set(['host', 'srflx', 'prflx', 'relay']);

function iceCandidateTypeName(type: string | null | undefined): string {
  if (!type) return 'none';
  return ICE_CANDIDATE_TYPES.has(type) ? type : 'other';
}

/** The kind of a candidate address, for diagnostics: the address itself is never logged. */
function iceAddressKind(address: string | null | undefined): IceAddressKind {
  const visible = visibleIceAddress(address);
  if (!visible) return 'none';
  if (isUuidLikeMdnsAddress(visible)) return 'mdns';
  const ipv4 = parseIpv4(visible);
  if (ipv4) {
    if (isRfc1918Ipv4(ipv4)) return 'private-ipv4';
    return ipv4[0] === 169 && ipv4[1] === 254 ? 'link-local' : 'public';
  }
  const ipv6 = parseIpv6(visible);
  if (ipv6) {
    if (isIpv6LinkLocal(ipv6)) return 'link-local';
    return isIpv6UniqueLocal(ipv6) ? 'private-ipv6' : 'public';
  }
  return 'other';
}

function pairView(
  localType: string | null | undefined,
  localAddress: string | null | undefined,
  remoteType: string | null | undefined,
  remoteAddress: string | null | undefined,
): PairView {
  return {
    localType: iceCandidateTypeName(localType),
    localKind: iceAddressKind(localAddress),
    remoteType: iceCandidateTypeName(remoteType),
    remoteKind: iceAddressKind(remoteAddress),
  };
}

/** The address part of the host rule, the same for the native, refined and statistics views. */
function hostAddressesLocality(
  localAddress: string | null | undefined,
  remoteAddress: string | null | undefined,
): 'same-subnet' | 'non-local' {
  if (
    localAddress &&
    !isPrivateNumericAddress(localAddress) &&
    !isUuidLikeMdnsAddress(localAddress)
  ) {
    return 'non-local';
  }
  if (remoteAddress && !isUuidLikeMdnsAddress(remoteAddress)) return 'non-local';
  if (!remoteAddress || !localAddress) return 'same-subnet';
  return addressesProveSameLan(localAddress, remoteAddress) ? 'same-subnet' : 'non-local';
}

function authoritativePairLocality(
  pair: RTCIceCandidatePair,
  acceptedRemoteMdnsKeys: ReadonlySet<string>,
): SelectedPairLocality | null {
  const localCandidate = pair.local;
  const remoteCandidate = pair.remote;
  if (!localCandidate || !remoteCandidate) return null;

  const localType = localCandidate.type;
  const remoteType = remoteCandidate.type;
  if ((localType && localType !== 'host') || (remoteType && remoteType !== 'host')) {
    return 'non-local';
  }
  if (!localType || !remoteType) return null;

  const remoteFoundation = remoteCandidate.foundation;
  const remotePort = remoteCandidate.port;
  const remoteProtocol = remoteCandidate.protocol;
  if (
    !remoteFoundation ||
    !Number.isSafeInteger(remotePort) ||
    (remotePort ?? 0) < 1 ||
    (remotePort ?? 0) > 65_535 ||
    !remoteProtocol
  ) {
    return null;
  }
  if (
    remoteProtocol.toLowerCase() !== 'udp' ||
    !acceptedRemoteMdnsKeys.has(`${remoteFoundation}:${remotePort}`)
  ) {
    return 'pending';
  }
  return hostAddressesLocality(localCandidate.address, remoteCandidate.address);
}

/** The host rule on statistics candidates: the remote must be an mDNS candidate added here. */
function statsHostLocality(
  localCandidate: unknown,
  remoteCandidate: unknown,
  acceptedRemoteMdnsKeys: ReadonlySet<string>,
): SelectedPairLocality {
  const remoteFoundation = statsString(remoteCandidate, 'foundation');
  const remotePort = statsNumber(remoteCandidate, 'port');
  const remoteProtocol = statsString(remoteCandidate, 'protocol');
  if (
    !remoteFoundation ||
    remotePort === null ||
    (remoteProtocol !== null && remoteProtocol.toLowerCase() !== 'udp') ||
    !acceptedRemoteMdnsKeys.has(`${remoteFoundation}:${remotePort}`)
  ) {
    return 'pending';
  }
  return hostAddressesLocality(candidateAddress(localCandidate), candidateAddress(remoteCandidate));
}

function hostRule(locality: SelectedPairLocality, view: 'refined' | 'stats'): PairRule {
  if (view === 'refined') {
    return locality === 'same-subnet'
      ? 'refined-host'
      : locality === 'pending'
        ? 'refined-key-pending'
        : 'refined-address';
  }
  return locality === 'same-subnet'
    ? 'stats-host'
    : locality === 'pending'
      ? 'stats-key-pending'
      : 'stats-address';
}

function nativeRule(locality: SelectedPairLocality, pair: RTCIceCandidatePair): PairRule {
  if (locality === 'same-subnet') return 'native-host';
  if (locality === 'pending') return 'native-key-pending';
  return pair.local.type !== 'host' || pair.remote.type !== 'host'
    ? 'native-type'
    : 'native-address';
}

/** The candidate-pair id each statistics transport selects, one entry per transport. */
function transportSelectedPairIds(stats: RTCStatsReport): string[] {
  const ids: string[] = [];
  for (const report of stats.values()) {
    if (report.type !== 'transport') continue;
    const selectedPairId = statsString(report, 'selectedCandidatePairId');
    if (selectedPairId) ids.push(selectedPairId);
  }
  return ids;
}

/**
 * Whether the statistics still list a connection from this local candidate to
 * a prflx remote on the native snapshot's remote port (or one without a port).
 * An in-place refinement replaces the connection's prflx remote, so the stats
 * no longer list it; while one is listed, the native snapshot may be that
 * connection rather than the refined one, whose address cannot be compared.
 */
function prflxStillListed(
  stats: RTCStatsReport,
  localCandidateId: string,
  nativeRemotePort: number | null,
): boolean {
  for (const report of stats.values()) {
    if (
      report.type !== 'candidate-pair' ||
      statsString(report, 'localCandidateId') !== localCandidateId
    ) {
      continue;
    }
    const remote = stats.get(statsString(report, 'remoteCandidateId') ?? '');
    if (statsString(remote, 'candidateType') !== 'prflx') continue;
    const port = statsNumber(remote, 'port');
    if (port === null || port === nativeRemotePort) return true;
  }
  return false;
}

/** The uniquely transport-selected statistics pair's view, for the pair-check line only. */
function selectedStatsView(stats: RTCStatsReport): PairView | null {
  const selectedPairIds = transportSelectedPairIds(stats);
  if (selectedPairIds.length !== 1) return null;
  const pair = stats.get(selectedPairIds[0]!);
  if (pair?.type !== 'candidate-pair') return null;
  const local = stats.get(statsString(pair, 'localCandidateId') ?? '');
  const remote = stats.get(statsString(pair, 'remoteCandidateId') ?? '');
  return pairView(
    statsString(local, 'candidateType'),
    candidateAddress(local),
    statsString(remote, 'candidateType'),
    candidateAddress(remote),
  );
}

/**
 * A native host-to-prflx snapshot. The browser may have refined that same
 * connection to a signaled host candidate without a new selected-pair event
 * (ice-selected-pair.ts): iOS Safari, the ICE-controlled answerer, meets the
 * publisher's checks before it has resolved the publisher's mDNS name. Only
 * that refined statistics pair, held to the full host rule, can prove it.
 * Until then the reading is pending, never non-local, so the existing proof
 * windows can see the refinement; an unrefined pair never proves.
 */
async function refinedPairReading(
  pc: RTCPeerConnection,
  iceTransport: RTCIceTransport,
  pair: RTCIceCandidatePair,
  acceptedRemoteMdnsKeys: ReadonlySet<string>,
  native: PairView,
): Promise<PairReading> {
  // Any address the snapshot exposes must already meet the host rule: a
  // private or mDNS local, and at most a private numeric prflx remote. This
  // check carries weight: the refined match never compares the remote address.
  const localAddress = visibleIceAddress(pair.local.address);
  const remoteAddress = visibleIceAddress(pair.remote.address);
  if (
    (localAddress &&
      !isPrivateNumericAddress(localAddress) &&
      !isUuidLikeMdnsAddress(localAddress)) ||
    (remoteAddress && !isPrivateNumericAddress(remoteAddress))
  ) {
    return { locality: 'non-local', rule: 'native-address', native, stats: null };
  }
  const pending = (rule: PairRule, stats: PairView | null = null): PairReading => ({
    locality: 'pending',
    rule,
    native,
    stats,
  });
  const identity = nativePairIdentity(pair);
  let stats: RTCStatsReport;
  let current: RTCIceCandidatePair | null = null;
  try {
    stats = await pc.getStats();
    const currentTransport = pc.sctp?.transport?.iceTransport;
    if (currentTransport === iceTransport) current = currentTransport.getSelectedCandidatePair();
  } catch (error) {
    log.debug('[ProSysAudioDirect] Refined ICE pair unavailable', error);
    return pending('unavailable');
  }
  // Never combine evidence from two objects: the snapshot must be unchanged.
  if (!current?.local || !current.remote || nativePairIdentity(current) !== identity) {
    return pending('snapshot-changed');
  }
  // As on the statistics-only path: two selected pairs are no evidence.
  if (new Set(transportSelectedPairIds(stats)).size > 1) {
    return { locality: 'non-local', rule: 'stats-ambiguous', native, stats: null };
  }
  // A live reproof can meet the selected connection's consent check in flight.
  const refined = findRefinedHostPair(stats, pair, { allowAnsweredInProgress: true });
  if (!refined) return pending('prflx-unrefined', selectedStatsView(stats));
  const view = pairView(
    statsString(refined.local, 'candidateType'),
    candidateAddress(refined.local),
    statsString(refined.remote, 'candidateType'),
    candidateAddress(refined.remote),
  );
  const nativeRemotePort = typeof pair.remote.port === 'number' ? pair.remote.port : null;
  if (prflxStillListed(stats, refined.local.id, nativeRemotePort)) {
    return pending('prflx-still-listed', view);
  }
  const locality = statsHostLocality(refined.local, refined.remote, acceptedRemoteMdnsKeys);
  return { locality, rule: hostRule(locality, 'refined'), native, stats: view };
}

/**
 * One reading of an end's selected pair. The publisher's negotiation, the
 * receiver's proof, the activation reproof and the live reproofs all use it,
 * so the two ends of a route apply one rule.
 */
async function readSelectedPair(
  pc: RTCPeerConnection,
  acceptedRemoteMdnsKeys: ReadonlySet<string>,
): Promise<PairReading> {
  let native: PairView | null = null;
  let prflxSnapshot: { iceTransport: RTCIceTransport; pair: RTCIceCandidatePair } | null = null;
  try {
    const iceTransport = pc.sctp?.transport?.iceTransport;
    if (typeof iceTransport?.getSelectedCandidatePair === 'function') {
      const pair = iceTransport.getSelectedCandidatePair();
      if (pair?.local && pair.remote) {
        native = pairView(
          pair.local.type,
          pair.local.address,
          pair.remote.type,
          pair.remote.address,
        );
        if (pair.local.type === 'host' && pair.remote.type === 'prflx') {
          prflxSnapshot = { iceTransport, pair };
        } else {
          const locality = authoritativePairLocality(pair, acceptedRemoteMdnsKeys);
          if (locality) return { locality, rule: nativeRule(locality, pair), native, stats: null };
        }
      }
    }
  } catch (error) {
    log.debug('[ProSysAudioDirect] Selected ICE pair unavailable', error);
  }
  if (prflxSnapshot && native) {
    return refinedPairReading(
      pc,
      prflxSnapshot.iceTransport,
      prflxSnapshot.pair,
      acceptedRemoteMdnsKeys,
      native,
    );
  }

  try {
    const stats = await pc.getStats();
    const selectedPairIds = new Set(transportSelectedPairIds(stats));
    if (selectedPairIds.size > 1) {
      return { locality: 'non-local', rule: 'stats-ambiguous', native, stats: null };
    }
    const selectedPairId = selectedPairIds.values().next().value as string | undefined;
    let pair: RTCStats | null = null;
    if (selectedPairId !== undefined) {
      const selected = stats.get(selectedPairId);
      if (selected?.type === 'candidate-pair') pair = selected;
    } else {
      const nominated = [...stats.values()].filter(
        (report) =>
          report.type === 'candidate-pair' &&
          statsString(report, 'state') === 'succeeded' &&
          isRecord(report) &&
          report.nominated === true,
      );
      if (nominated.length === 1) pair = nominated[0] ?? null;
    }
    if (!pair || statsString(pair, 'state') !== 'succeeded') {
      return { locality: 'pending', rule: 'stats-missing', native, stats: null };
    }
    const localCandidate = stats.get(statsString(pair, 'localCandidateId') ?? '');
    const remoteCandidate = stats.get(statsString(pair, 'remoteCandidateId') ?? '');
    const localType = statsString(localCandidate, 'candidateType');
    const remoteType = statsString(remoteCandidate, 'candidateType');
    const view = pairView(
      localType,
      candidateAddress(localCandidate),
      remoteType,
      candidateAddress(remoteCandidate),
    );
    if (!localType || !remoteType) {
      return { locality: 'pending', rule: 'stats-missing', native, stats: view };
    }
    // A selected host-to-prflx statistics pair has not refined yet: wait, never prove.
    if (localType === 'host' && remoteType === 'prflx') {
      return { locality: 'pending', rule: 'prflx-unrefined', native, stats: view };
    }
    if (localType !== 'host' || remoteType !== 'host') {
      return { locality: 'non-local', rule: 'stats-type', native, stats: view };
    }
    const locality = statsHostLocality(localCandidate, remoteCandidate, acceptedRemoteMdnsKeys);
    return { locality, rule: hostRule(locality, 'stats'), native, stats: view };
  } catch (error) {
    log.debug('[ProSysAudioDirect] ICE stats unavailable', error);
    return { locality: 'pending', rule: 'unavailable', native, stats: null };
  }
}

/** One end's pair proof, kept for its pair-check line. */
interface PairProof {
  startedAt: number;
  connectedAt: number | null;
  reading: PairReading | null;
  result: PairWaitResult | null;
  endedAt: number | null;
}

function startPairProof(): PairProof {
  return { startedAt: Date.now(), connectedAt: null, reading: null, result: null, endedAt: null };
}

function describePairView(view: PairView | null): string {
  return view
    ? `${view.localType}/${view.localKind} to ${view.remoteType}/${view.remoteKind}`
    : 'none';
}

/**
 * Candidates this end signalled, gathered but refused by the LAN rule,
 * received from the other end, and added remote. With `proofStartedAt`, also
 * when the first remote candidate was added, from the start of that proof
 * (negative when before it): a refinement can follow only that add.
 */
function routeCandidateCounts(
  route: PublisherRoute | ReceiverRoute,
  proofStartedAt?: number,
): string {
  const firstAdded =
    proofStartedAt !== undefined && route.firstRemoteCandidateAddedAt !== null
      ? `, first at ${route.firstRemoteCandidateAddedAt - proofStartedAt} ms`
      : '';
  return (
    `candidates sent ${route.localCandidateCount}, ` +
    `refused ${route.refusedLocalCandidateCount}, received ${route.remoteCandidateCount}, ` +
    `added ${route.addedRemoteCandidateCount}${firstAdded}`
  );
}

function pairReadingDetail(reading: PairReading | null, counts: string): string {
  return (
    `native ${describePairView(reading?.native ?? null)}; ` +
    `stats ${describePairView(reading?.stats ?? null)}; ${counts}`
  );
}

/**
 * One privacy-safe line when an end's pair proof ends: the deciding rule of
 * its last reading, candidate types and address kinds, and candidate counts.
 * Never an address, port, foundation, username fragment, room code or full id.
 */
function pairCheckLine(
  subject: string,
  outcome: PairWaitResult,
  proof: PairProof,
  counts: string,
): string {
  const endedAt = proof.endedAt ?? Date.now();
  const connected =
    proof.connectedAt === null
      ? 'never connected'
      : `connected at ${proof.connectedAt - proof.startedAt} ms`;
  const rule = proof.reading?.rule ?? (proof.connectedAt === null ? 'not-connected' : 'no-reading');
  return (
    `[ProSysAudioDirect] ${subject} ${outcome} after ${endedAt - proof.startedAt} ms by ${rule} ` +
    `(${connected}; ${pairReadingDetail(proof.reading, counts)})`
  );
}

function publisherCloseSignal(route: PublisherRoute, reason: DirectCloseReason): DirectCloseSignal {
  return {
    kind: 'close',
    targetParticipantId: route.participantId,
    direction: 'publisher',
    generation: route.generation,
    publicationId: route.publicationId,
    negotiationId: route.negotiationId,
    reason,
  };
}

function receiverCloseSignal(route: ReceiverRoute, reason: DirectCloseReason): DirectCloseSignal {
  return {
    kind: 'close',
    targetParticipantId: route.ownerParticipantId,
    direction: 'subscriber',
    generation: route.generation,
    publicationId: route.publicationId,
    negotiationId: route.negotiationId,
    reason,
  };
}

function closePublisherRoute(
  route: PublisherRoute,
  reason: DirectCloseReason,
  notifyPeer: boolean,
): void {
  if (route.closed) return;
  route.closed = true;
  clearManagedTimer(publisherRouteTimerName(route));
  if (notifyPeer && route.offerSent) sendSignal(publisherCloseSignal(route, reason));
  route.pc.onicecandidate = null;
  route.pc.onconnectionstatechange = null;
  route.pc.oniceconnectionstatechange = null;
  route.probeChannel.onmessage = null;
  try {
    route.probeChannel.close();
  } catch {
    // The probe channel may already have closed with the peer connection.
  }
  route.pc.close();
  route.queuedLocalCandidates.length = 0;
  route.queuedRemoteCandidates.length = 0;
  route.localCandidateTuples.clear();
  route.remoteCandidateTuples.clear();
  route.acceptedRemoteMdnsKeys.clear();
  route.reproofFlight = null;
}

function closePublisherSession(
  session: PublisherSession,
  reason: DirectCloseReason,
  notifyPeers: boolean,
): void {
  if (session.closed) return;
  session.closed = true;
  for (const route of session.routes.values()) closePublisherRoute(route, reason, notifyPeers);
  session.routes.clear();
  session.targets.clear();
}

function closeReceiverRoute(
  route: ReceiverRoute,
  reason: DirectCloseReason,
  notifyPeer: boolean,
): void {
  if (route.closed) return;
  route.closed = true;
  clearManagedTimer(receiverTrackReadyTimerName(route));
  if (notifyPeer && route.answerSent) sendSignal(receiverCloseSignal(route, reason));
  route.pc.onicecandidate = null;
  route.pc.onconnectionstatechange = null;
  route.pc.oniceconnectionstatechange = null;
  route.pc.ontrack = null;
  route.pc.ondatachannel = null;
  if (route.channel) {
    route.channel.onopen = null;
    route.channel.onmessage = null;
  }
  route.channel = null;
  route.pc.close();
  route.queuedLocalCandidates.length = 0;
  route.queuedRemoteCandidates.length = 0;
  route.localCandidateTuples.clear();
  route.remoteCandidateTuples.clear();
  route.acceptedRemoteMdnsKeys.clear();
  route.track = null;
}

function notifyPublisherSessionFallback(
  session: PublisherSession,
  participantId: string,
  reason: string,
): void {
  if (
    publisherSession !== session ||
    session.phase !== 'live' ||
    session.fallbackSent ||
    session.closed
  ) {
    return;
  }
  session.fallbackSent = true;
  // A newcomer can require SFU delivery without invalidating the LAN routes
  // already carrying audio. Keep those routes until the service accepts the
  // SFU publication; provisioning or retrying that replacement may fail.
  // Uncommitted, stale, and unproven routes must never survive this boundary.
  for (const [peerId, route] of [...session.routes]) {
    if (
      route.committed &&
      route.provenLocal &&
      publisherRouteIsCurrent(session, route) &&
      !pcDisconnected(route.pc)
    ) {
      continue;
    }
    session.routes.delete(peerId);
    closePublisherRoute(route, 'fallback', true);
  }
  try {
    callbacks?.onLiveRouteFallback({
      role: 'publisher',
      reason,
      participantId,
      generation: session.generation,
      publicationId: session.publicationId,
    });
  } catch (error) {
    log.warn('[ProSysAudioDirect] Publisher fallback callback failed', error);
  }
}

function notifyPublisherFallback(route: PublisherRoute, reason: string): void {
  const session = publisherSession;
  if (
    !session ||
    session.routes.get(route.participantId) !== route ||
    !samePublication(session, route.generation, route.publicationId)
  ) {
    return;
  }
  session.routes.delete(route.participantId);
  closePublisherRoute(route, 'fallback', true);
  notifyPublisherSessionFallback(session, route.participantId, reason);
}

function notifyReceiverFallback(route: ReceiverRoute, reason: string): void {
  if (!route.live || route.fallbackSent || route.closed || receiverRoute !== route) return;
  route.fallbackSent = true;
  receiverRoute = null;
  closeReceiverRoute(route, 'fallback', true);
  try {
    callbacks?.onLiveRouteFallback({
      role: 'receiver',
      reason,
      participantId: route.ownerParticipantId,
      generation: route.generation,
      publicationId: route.publicationId,
    });
  } catch (error) {
    log.warn('[ProSysAudioDirect] Receiver fallback callback failed', error);
  }
}

function failPublisherRoute(route: PublisherRoute, reason: string): void {
  if (route.closed) return;
  route.failed = true;
  route.endReason ??= reason;
  const session = publisherSession;
  const newestDesiredStillOwnsRoute = Boolean(
    session &&
    (!session.reconcileDesiredTargets ||
      session.reconcileDesiredTargets.get(route.participantId) === route.routeToken),
  );
  if (session?.phase === 'live' && route.committed && newestDesiredStillOwnsRoute) {
    notifyPublisherFallback(route, reason);
    return;
  }
  if (session?.routes.get(route.participantId) === route) {
    session.routes.delete(route.participantId);
  }
  closePublisherRoute(route, 'fallback', true);
}

function failReceiverRoute(route: ReceiverRoute, reason: string): void {
  if (route.closed) return;
  if (route.live) notifyReceiverFallback(route, reason);
  else {
    // A live route's fallback reaches the service; nothing else reports this one.
    log.info(`[ProSysAudioDirect] Receiver route ended before live (${reason})`);
    if (receiverRoute === route) receiverRoute = null;
    closeReceiverRoute(route, 'fallback', true);
  }
}

/**
 * An end whose ICE gathering ended without one LAN candidate has sent the
 * other end nothing to add, so the other end can never prove the pair. The
 * route ends at that event instead of at the pair-proof window; no timer.
 */
function failPublisherRouteWithoutLanCandidate(route: PublisherRoute): void {
  if (route.closed) return;
  log.info(
    `[ProSysAudioDirect] Publisher gathering to ${route.participantId.slice(-4)} ` +
      `ended with no LAN candidate (${routeCandidateCounts(route)})`,
  );
  failPublisherRoute(route, 'no-lan-candidate');
}

/** The receiver's side of failPublisherRouteWithoutLanCandidate, once its answer is out. */
function failReceiverRouteWithoutLanCandidate(route: ReceiverRoute): void {
  if (route.closed) return;
  log.info(
    `[ProSysAudioDirect] Receiver gathering ended with no LAN candidate (${routeCandidateCounts(route)})`,
  );
  failReceiverRoute(route, 'no-lan-candidate');
}

function handlePublisherConnectionState(route: PublisherRoute): void {
  if (route.closed) return;
  if (pcDisconnected(route.pc)) {
    failPublisherRoute(
      route,
      `connection-${route.pc.connectionState || route.pc.iceConnectionState}`,
    );
    return;
  }
  const session = publisherSession;
  if (
    session?.phase === 'live' &&
    route.committed &&
    route.provenLocal &&
    publisherRouteIsCurrent(session, route)
  ) {
    observeDirectTask(
      reproveLivePublisherRoute(session, route, 'connection-locality-changed'),
      'Publisher locality reproof',
    );
  }
}

function handleReceiverConnectionState(route: ReceiverRoute): void {
  if (route.closed || !pcDisconnected(route.pc)) return;
  failReceiverRoute(route, `connection-${route.pc.connectionState || route.pc.iceConnectionState}`);
}

function sendPublisherCandidate(route: PublisherRoute, candidate: RTCIceCandidateInit): boolean {
  const sanitized = sanitizeLanCandidateInit(candidate);
  if (!sanitized) return true;
  return sendSignal({
    kind: 'candidate',
    targetParticipantId: route.participantId,
    direction: 'publisher',
    generation: route.generation,
    publicationId: route.publicationId,
    negotiationId: route.negotiationId,
    candidate: sanitized,
  });
}

function sendReceiverCandidate(route: ReceiverRoute, candidate: RTCIceCandidateInit): boolean {
  const sanitized = sanitizeLanCandidateInit(candidate);
  if (!sanitized) return true;
  return sendSignal({
    kind: 'candidate',
    targetParticipantId: route.ownerParticipantId,
    direction: 'subscriber',
    generation: route.generation,
    publicationId: route.publicationId,
    negotiationId: route.negotiationId,
    candidate: sanitized,
  });
}

function flushPublisherLocalCandidates(route: PublisherRoute): void {
  if (!route.offerSent || route.closed) return;
  const candidates = route.queuedLocalCandidates.splice(0);
  if (candidates.some((candidate) => !sendPublisherCandidate(route, candidate))) {
    failPublisherRoute(route, 'candidate-send-failed');
  }
}

function flushReceiverLocalCandidates(route: ReceiverRoute): void {
  if (!route.answerSent || route.closed) return;
  const candidates = route.queuedLocalCandidates.splice(0);
  if (candidates.some((candidate) => !sendReceiverCandidate(route, candidate))) {
    failReceiverRoute(route, 'candidate-send-failed');
  }
}

/** Records an added remote mDNS candidate's foundation:port key in this route's ledger. */
function acceptRemoteMdnsKey(route: PublisherRoute | ReceiverRoute, ledgerKey: string): void {
  if (route.acceptedRemoteMdnsKeys.has(ledgerKey)) return;
  route.acceptedRemoteMdnsKeys.add(ledgerKey);
  route.addedRemoteCandidateCount += 1;
  route.firstRemoteCandidateAddedAt ??= Date.now();
}

async function flushPublisherRemoteCandidates(route: PublisherRoute): Promise<void> {
  if (!route.remoteDescriptionReady || route.closed) return;
  const candidates = route.queuedRemoteCandidates.splice(0);
  for (const candidate of candidates) {
    await route.pc.addIceCandidate(candidate);
    const parsed = candidate.candidate ? parseLanCandidateLine(candidate.candidate) : null;
    const session = publisherSession;
    if (parsed && session && publisherRouteIsCurrent(session, route)) {
      acceptRemoteMdnsKey(route, parsed.ledgerKey);
    }
  }
}

async function flushReceiverRemoteCandidates(route: ReceiverRoute): Promise<void> {
  if (!route.remoteDescriptionReady || route.closed) return;
  const candidates = route.queuedRemoteCandidates.splice(0);
  for (const candidate of candidates) {
    await route.pc.addIceCandidate(candidate);
    const parsed = candidate.candidate ? parseLanCandidateLine(candidate.candidate) : null;
    if (parsed && receiverRoute === route && !route.closed) {
      acceptRemoteMdnsKey(route, parsed.ledgerKey);
    }
  }
}

function createPublisherRoute(
  session: PublisherSession,
  participantId: string,
  routeToken: string,
): PublisherRoute {
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const probeChannel = pc.createDataChannel(DIRECT_CHANNEL_LABEL, { ordered: false });
  const route: PublisherRoute = {
    participantId,
    routeToken,
    generation: session.generation,
    publicationId: session.publicationId,
    negotiationId: randomNegotiationId(),
    pc,
    probeChannel,
    queuedLocalCandidates: [],
    queuedRemoteCandidates: [],
    localCandidateTuples: new Set(),
    remoteCandidateTuples: new Set(),
    acceptedRemoteMdnsKeys: new Set(),
    localCandidateCount: 0,
    refusedLocalCandidateCount: 0,
    addedRemoteCandidateCount: 0,
    firstRemoteCandidateAddedAt: null,
    remoteCandidateCount: 0,
    offerSent: false,
    remoteDescriptionReady: false,
    provenLocal: false,
    failed: false,
    closed: false,
    endReason: null,
    reproofFlight: null,
    answer: 'none',
    receiverProven: false,
    committed: false,
  };
  session.routes.set(participantId, route);
  probeChannel.onmessage = (event) => {
    if (!route.closed && event.data === RECEIVER_PAIR_PROVEN_MESSAGE) route.receiverProven = true;
  };
  pc.onicecandidate = (event) => {
    if (route.closed) return;
    if (!event.candidate) {
      // Gathering ended: with no LAN candidate sent the receiver can never prove the pair.
      if (route.localCandidateCount === 0) failPublisherRouteWithoutLanCandidate(route);
      return;
    }
    const candidate = sanitizeLanCandidateInit(candidateInit(event.candidate));
    const parsedCandidate = candidate?.candidate
      ? parseLanCandidateLine(candidate.candidate)
      : null;
    if (!candidate || !parsedCandidate) {
      if (isUdpCandidateLine(event.candidate.candidate)) route.refusedLocalCandidateCount += 1;
      return;
    }
    if (route.localCandidateTuples.has(parsedCandidate.tuple)) return;
    route.localCandidateTuples.add(parsedCandidate.tuple);
    route.localCandidateCount += 1;
    if (route.localCandidateCount > MAX_LOCAL_ICE_CANDIDATES) {
      failPublisherRoute(route, 'local-candidate-limit');
      return;
    }
    if (!route.offerSent) route.queuedLocalCandidates.push(candidate);
    else if (!sendPublisherCandidate(route, candidate)) {
      failPublisherRoute(route, 'candidate-send-failed');
    }
    void flushPublisherRemoteCandidates(route).catch(() =>
      failPublisherRoute(route, 'candidate-rejected'),
    );
  };
  pc.onconnectionstatechange = () => handlePublisherConnectionState(route);
  pc.oniceconnectionstatechange = () => handlePublisherConnectionState(route);
  return route;
}

/**
 * Polls one end's selected pair until it is a proven LAN pair or the wait
 * ends, recording the first connected moment and the last reading in `proof`.
 */
async function waitForProvenPair(
  pc: RTCPeerConnection,
  acceptedRemoteMdnsKeys: ReadonlySet<string>,
  isCurrent: () => boolean,
  timeoutMs: number,
  proof: PairProof,
): Promise<PairWaitResult> {
  const finish = (result: PairWaitResult): PairWaitResult => {
    proof.result = result;
    proof.endedAt = Date.now();
    return result;
  };
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() <= expiresAt) {
    if (!isCurrent()) return finish('closed');
    if (pcDisconnected(pc)) return finish('disconnected');
    if (pcConnected(pc)) {
      proof.connectedAt ??= Date.now();
      const reading = await readSelectedPair(pc, acceptedRemoteMdnsKeys);
      // A read that ends after the route closed saw a closed transport and a
      // cleared ledger: the line keeps the last reading taken while current.
      if (!isCurrent()) return finish('closed');
      proof.reading = reading;
      if (reading.locality === 'same-subnet') return finish('proven');
      if (reading.locality === 'non-local') return finish('non-local');
    }
    await delay(Math.min(DIRECT_PAIR_POLL_MS, Math.max(1, expiresAt - Date.now())));
  }
  return finish(isCurrent() ? 'deadline' : 'closed');
}

async function waitForPublisherRoute(
  session: PublisherSession,
  route: PublisherRoute,
  done: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const expiresAt = Date.now() + timeoutMs;
  while (publisherRouteIsCurrent(session, route) && Date.now() <= expiresAt) {
    if (done()) return true;
    await delay(Math.min(DIRECT_PAIR_POLL_MS, Math.max(1, expiresAt - Date.now())));
  }
  return false;
}

async function sendPublisherOffer(session: PublisherSession, route: PublisherRoute): Promise<void> {
  const offer = await route.pc.createOffer();
  if (!publisherRouteIsCurrent(session, route)) throw new Error('DIRECT_ROUTE_SUPERSEDED');
  const localOffer = offer.sdp ? { ...offer, sdp: forceDirectStereoSdp(offer.sdp) } : offer;
  await route.pc.setLocalDescription(localOffer);
  if (!publisherRouteIsCurrent(session, route)) throw new Error('DIRECT_ROUTE_SUPERSEDED');
  const description = route.pc.localDescription ?? localOffer;
  const outboundSdp = description.sdp ? forceDirectStereoSdp(description.sdp) : description.sdp;
  const sanitizedSdp = outboundSdp ? sanitizeLanSdp(outboundSdp) : '';
  if (description.type !== 'offer' || !sanitizedSdp || !sdpHasOneAudioMedia(sanitizedSdp)) {
    throw new Error('DIRECT_OFFER_INVALID');
  }
  route.offerSent = sendSignal({
    kind: 'offer',
    targetParticipantId: route.participantId,
    direction: 'publisher',
    phase: 'media',
    generation: session.generation,
    publicationId: session.publicationId,
    negotiationId: route.negotiationId,
    description: { type: 'offer', sdp: sanitizedSdp },
    trackId: session.track.id,
  });
  if (!route.offerSent) throw new Error('DIRECT_OFFER_SEND_FAILED');
  flushPublisherLocalCandidates(route);
}

async function provePublisherRouteCurrent(
  session: PublisherSession,
  route: PublisherRoute,
): Promise<boolean> {
  if (!publisherRouteIsCurrent(session, route) || pcDisconnected(route.pc)) return false;
  if (route.reproofFlight) return route.reproofFlight;
  const flight = (async () => {
    const reading = await withinDirectDeadline(
      readSelectedPair(route.pc, route.acceptedRemoteMdnsKeys),
      DIRECT_NEGOTIATION_TIMEOUT_MS,
      (): PairReading => ({
        locality: 'pending',
        rule: 'read-deadline',
        native: null,
        stats: null,
      }),
    );
    if (!publisherRouteIsCurrent(session, route) || pcDisconnected(route.pc)) return false;
    route.provenLocal = reading.locality === 'same-subnet';
    if (!route.provenLocal) {
      log.info(
        `[ProSysAudioDirect] Publisher pair reproof to ${route.participantId.slice(-4)} ` +
          `${reading.locality} by ${reading.rule} ` +
          `(${pairReadingDetail(reading, routeCandidateCounts(route))})`,
      );
    }
    return route.provenLocal;
  })();
  route.reproofFlight = flight;
  try {
    return await flight;
  } finally {
    if (route.reproofFlight === flight) route.reproofFlight = null;
  }
}

function scheduleLivePublisherRouteReproof(session: PublisherSession, route: PublisherRoute): void {
  if (session.phase !== 'live' || !route.committed || !publisherRouteIsCurrent(session, route)) {
    return;
  }
  setManagedTimer(
    publisherRouteTimerName(route),
    () =>
      observeDirectTask(
        reproveLivePublisherRoute(session, route, 'periodic-locality-check-failed'),
        'Periodic publisher locality reproof',
      ),
    LIVE_PAIR_REPROOF_INTERVAL_MS,
  );
}

async function reproveLivePublisherRoute(
  session: PublisherSession,
  route: PublisherRoute,
  reason: string,
): Promise<void> {
  if (session.phase !== 'live' || !route.committed || !publisherRouteIsCurrent(session, route)) {
    return;
  }
  const proven = await provePublisherRouteCurrent(session, route);
  if (session.phase !== 'live' || !publisherRouteIsCurrent(session, route)) return;
  if (!proven) {
    failPublisherRoute(route, reason);
    return;
  }
  scheduleLivePublisherRouteReproof(session, route);
}

/** Ends a route whose negotiation failed, keeping a replacement route in place. */
function retireNegotiatingRoute(session: PublisherSession, route: PublisherRoute): void {
  route.failed = true;
  if (session.routes.get(route.participantId) === route) session.routes.delete(route.participantId);
  closePublisherRoute(route, 'fallback', route.offerSent);
}

function sendPublisherTrackAttached(route: PublisherRoute): boolean {
  if (route.probeChannel.readyState !== 'open') return false;
  try {
    route.probeChannel.send(PUBLISHER_TRACK_ATTACHED_MESSAGE);
    return true;
  } catch (error) {
    log.debug('[ProSysAudioDirect] Publisher track-attached send failed', error);
    return false;
  }
}

/**
 * One route's single round trip: the offer must be answered within
 * `answerTimeoutMs`, then both ends must prove the LAN pair within
 * DIRECT_PAIR_PROOF_TIMEOUT_MS. A route that never answers or never connects
 * therefore fails as fast as before, one whose end gathered no LAN candidate
 * fails when that gathering ends ('no-lan-candidate'), and one result line per
 * route names the stage it reached.
 */
async function negotiatePublisherRoute(
  session: PublisherSession,
  participantId: string,
  routeToken: string,
  answerTimeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  const marks: string[] = [];
  const mark = (name: string) => marks.push(`${name} ${Date.now() - startedAt}`);
  let stage: PublisherNegotiationStage = 'offer';
  let cause = 'deadline';
  let route: PublisherRoute | null = null;
  let pairProof: PairProof | null = null;
  let proven = false;
  try {
    route = createPublisherRoute(session, participantId, routeToken);
    const negotiatingRoute = route;
    const isCurrent = () => publisherRouteIsCurrent(session, negotiatingRoute);
    const endedCause = () => negotiatingRoute.endReason ?? (isCurrent() ? 'deadline' : 'closed');
    // Native SDP/statistics promises may outlive a stage deadline. Retire
    // only this route so the existing caller can select its single SFU fallback.
    const retire = (): boolean => {
      cause = 'deadline';
      retireNegotiatingRoute(session, negotiatingRoute);
      return false;
    };
    const sender = negotiatingRoute.pc.addTrack(session.track, new MediaStream([session.track]));
    tuneSystemAudioLanDirectSender(sender);
    const answered = await withinDirectDeadline(
      (async () => {
        // The sender carries no audio until both ends prove the LAN pair.
        await sender.replaceTrack(null);
        if (!isCurrent()) throw new Error('DIRECT_ROUTE_SUPERSEDED');
        await sendPublisherOffer(session, negotiatingRoute);
        stage = 'answer';
        const answerExpiresAt = startedAt + answerTimeoutMs;
        if (
          !(await waitForPublisherRoute(
            session,
            negotiatingRoute,
            () => negotiatingRoute.answer === 'applied',
            Math.max(1, answerExpiresAt - Date.now()),
          ))
        ) {
          cause = endedCause();
          return false;
        }
        mark('answer');
        return true;
      })(),
      answerTimeoutMs,
      retire,
    );
    if (answered) {
      stage = 'pair';
      const proofExpiresAt = Date.now() + DIRECT_PAIR_PROOF_TIMEOUT_MS;
      const proof = startPairProof();
      pairProof = proof;
      proven = await withinDirectDeadline(
        (async () => {
          const pair = await waitForProvenPair(
            negotiatingRoute.pc,
            negotiatingRoute.acceptedRemoteMdnsKeys,
            isCurrent,
            DIRECT_PAIR_PROOF_TIMEOUT_MS,
            proof,
          );
          if (pair !== 'proven') {
            cause = pair === 'closed' ? endedCause() : pair;
            return false;
          }
          mark('pair');
          stage = 'receiver-proof';
          if (
            !(await waitForPublisherRoute(
              session,
              negotiatingRoute,
              () => negotiatingRoute.receiverProven,
              Math.max(1, proofExpiresAt - Date.now()),
            ))
          ) {
            cause = endedCause();
            return false;
          }
          mark('receiver');
          stage = 'attach';
          await sender.replaceTrack(session.track);
          if (!isCurrent()) {
            cause = endedCause();
            return false;
          }
          // The receiver hands its track to playback only once audio flows.
          if (!sendPublisherTrackAttached(negotiatingRoute)) {
            cause = 'attach-signal-failed';
            return false;
          }
          // Only a fully established route may ever be committed.
          negotiatingRoute.provenLocal = true;
          return true;
        })(),
        DIRECT_PAIR_PROOF_TIMEOUT_MS,
        retire,
      );
    }
  } catch (error) {
    cause =
      route && !publisherRouteIsCurrent(session, route) ? (route.endReason ?? 'closed') : 'error';
    log.debug('[ProSysAudioDirect] Publisher negotiation failed', error);
    if (route) retireNegotiatingRoute(session, route);
  }
  // A stage that gives up before its deadline timer leaves the route open;
  // retire it so a later reconcile pass cannot commit a route without audio.
  if (!proven && route && publisherRouteIsCurrent(session, route)) {
    retireNegotiatingRoute(session, route);
  }
  if (route && pairProof) {
    // Before the result line. The stage deadline may have cut the proof short
    // (and its retired route then reads as closed to the proof).
    const result = pairProof.result;
    log.info(
      pairCheckLine(
        `Publisher pair check to ${participantId.slice(-4)}`,
        result && result !== 'closed' ? result : cause === 'deadline' ? 'deadline' : 'closed',
        pairProof,
        routeCandidateCounts(route, pairProof.startedAt),
      ),
    );
  }
  const elapsedMs = Date.now() - startedAt;
  const detail = marks.length > 0 ? marks.join(', ') : 'no answer';
  log.info(
    proven
      ? `[ProSysAudioDirect] LAN route to ${participantId.slice(-4)} proven in ${elapsedMs} ms (${detail})`
      : `[ProSysAudioDirect] LAN route to ${participantId.slice(-4)} not proven at ${stage} after ${elapsedMs} ms (${cause}; ${detail})`,
  );
  return proven;
}

function receiverPublicationMatches(route: ReceiverRoute): boolean {
  return Boolean(
    activePublication &&
    activePublication.ownerParticipantId === route.ownerParticipantId &&
    samePublication(activePublication, route.generation, route.publicationId),
  );
}

function maybeDeliverReceiverTrack(route: ReceiverRoute): void {
  const track = route.track;
  if (
    route.closed ||
    route.trackDelivered ||
    !route.live ||
    receiverRoute !== route ||
    !receiverPublicationMatches(route) ||
    !callbacks
  ) {
    return;
  }
  // The receiver's own pair proof comes first; it delivers again once done.
  if (!route.answerSent || !route.provenLocal) return;
  // Then both the remote track and the publisher's word that audio flows on it.
  if (!track || !route.publisherAttached) {
    setManagedTimer(
      receiverTrackReadyTimerName(route),
      () => {
        if (
          receiverRoute === route &&
          !route.closed &&
          route.live &&
          !route.trackDelivered &&
          (!route.track || !route.publisherAttached)
        ) {
          notifyReceiverFallback(route, 'receiver-track-timeout');
        }
      },
      RECEIVER_TRACK_READY_TIMEOUT_MS,
    );
    return;
  }
  clearManagedTimer(receiverTrackReadyTimerName(route));
  route.trackDelivered = true;
  void Promise.resolve()
    .then(() =>
      callbacks?.onReceiverTrackReady({
        ownerParticipantId: route.ownerParticipantId,
        generation: route.generation,
        publicationId: route.publicationId,
        negotiationId: route.negotiationId,
        track,
        isCurrent: () =>
          receiverRoute === route &&
          !route.closed &&
          route.live &&
          receiverPublicationMatches(route),
      }),
    )
    .catch((error) => {
      log.warn('[ProSysAudioDirect] Receiver track handoff failed', error);
      if (receiverRoute === route && route.live) failReceiverRoute(route, 'track-handoff-failed');
    });
}

function acceptReceiverTrack(route: ReceiverRoute, track: MediaStreamTrack): void {
  // The route's one audio m-section is the publisher's track, whatever id this
  // browser gives the remote track. It waits here for the pair proof.
  if (route.closed || route.track || track.kind !== 'audio') return;
  route.track = track;
  track.addEventListener('ended', () => {
    if (receiverRoute === route && route.live) failReceiverRoute(route, 'track-ended');
  });
  maybeDeliverReceiverTrack(route);
}

function sendReceiverPairProof(route: ReceiverRoute): void {
  const channel = route.channel;
  if (route.closed || route.proofSent || !route.provenLocal || channel?.readyState !== 'open') {
    return;
  }
  try {
    channel.send(RECEIVER_PAIR_PROVEN_MESSAGE);
    route.proofSent = true;
  } catch (error) {
    log.debug('[ProSysAudioDirect] Receiver pair proof send failed', error);
    failReceiverRoute(route, 'receiver-proof-send-failed');
  }
}

function createReceiverRoute(signal: DirectOfferSignal, ownerParticipantId: string): ReceiverRoute {
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const route: ReceiverRoute = {
    ownerParticipantId,
    generation: signal.generation,
    publicationId: signal.publicationId,
    negotiationId: signal.negotiationId,
    pc,
    channel: null,
    track: null,
    queuedLocalCandidates: [],
    queuedRemoteCandidates: [],
    localCandidateTuples: new Set(),
    remoteCandidateTuples: new Set(),
    acceptedRemoteMdnsKeys: new Set(),
    localCandidateCount: 0,
    refusedLocalCandidateCount: 0,
    addedRemoteCandidateCount: 0,
    firstRemoteCandidateAddedAt: null,
    remoteCandidateCount: 0,
    answerSent: false,
    remoteDescriptionReady: false,
    trackDelivered: false,
    live: false,
    fallbackSent: false,
    closed: false,
    provenLocal: false,
    proofSent: false,
    publisherAttached: false,
    gatheringEndedWithoutLanCandidate: false,
  };
  pc.onicecandidate = (event) => {
    if (route.closed) return;
    if (!event.candidate) {
      // Gathering ended: with no LAN candidate sent the publisher can never
      // prove the pair. A close goes out only after the answer, so a route
      // still answering fails right after it (acceptOffer).
      if (route.localCandidateCount > 0) return;
      if (route.answerSent) failReceiverRouteWithoutLanCandidate(route);
      else route.gatheringEndedWithoutLanCandidate = true;
      return;
    }
    const candidate = sanitizeLanCandidateInit(candidateInit(event.candidate));
    const parsedCandidate = candidate?.candidate
      ? parseLanCandidateLine(candidate.candidate)
      : null;
    if (!candidate || !parsedCandidate) {
      if (isUdpCandidateLine(event.candidate.candidate)) route.refusedLocalCandidateCount += 1;
      return;
    }
    if (route.localCandidateTuples.has(parsedCandidate.tuple)) return;
    route.localCandidateTuples.add(parsedCandidate.tuple);
    route.localCandidateCount += 1;
    if (route.localCandidateCount > MAX_LOCAL_ICE_CANDIDATES) {
      failReceiverRoute(route, 'local-candidate-limit');
      return;
    }
    if (!route.answerSent) route.queuedLocalCandidates.push(candidate);
    else if (!sendReceiverCandidate(route, candidate)) {
      failReceiverRoute(route, 'candidate-send-failed');
    }
    void flushReceiverRemoteCandidates(route).catch(() =>
      failReceiverRoute(route, 'candidate-rejected'),
    );
  };
  pc.onconnectionstatechange = () => handleReceiverConnectionState(route);
  pc.oniceconnectionstatechange = () => handleReceiverConnectionState(route);
  pc.ontrack = (event) => acceptReceiverTrack(route, event.track);
  pc.ondatachannel = (event) => {
    if (route.closed || route.channel || event.channel.label !== DIRECT_CHANNEL_LABEL) return;
    route.channel = event.channel;
    event.channel.onopen = () => sendReceiverPairProof(route);
    event.channel.onmessage = (message) => {
      if (route.closed || message.data !== PUBLISHER_TRACK_ATTACHED_MESSAGE) return;
      route.publisherAttached = true;
      maybeDeliverReceiverTrack(route);
    };
    sendReceiverPairProof(route);
  };
  return route;
}

/** The receiver proves its own selected pair after answering, then tells the publisher. */
async function proveReceiverRoute(route: ReceiverRoute): Promise<void> {
  const proof = startPairProof();
  const result = await waitForProvenPair(
    route.pc,
    route.acceptedRemoteMdnsKeys,
    () => receiverRoute === route && !route.closed,
    DIRECT_NEGOTIATION_TIMEOUT_MS,
    proof,
  );
  // Every outcome, 'closed' too: the publisher's own deadline can end the
  // route before this window does.
  log.info(
    pairCheckLine(
      'Receiver pair check',
      result,
      proof,
      routeCandidateCounts(route, proof.startedAt),
    ),
  );
  if (result === 'closed') return;
  const elapsedMs = Date.now() - proof.startedAt;
  if (result !== 'proven') {
    log.info(`[ProSysAudioDirect] Receiver LAN pair not proven (${result} after ${elapsedMs} ms)`);
    failReceiverRoute(route, 'receiver-locality-unproven');
    return;
  }
  log.info(`[ProSysAudioDirect] Receiver LAN pair proven in ${elapsedMs} ms`);
  route.provenLocal = true;
  sendReceiverPairProof(route);
  maybeDeliverReceiverTrack(route);
}

function sendReceiverAnswer(route: ReceiverRoute, description: RTCSessionDescriptionInit): boolean {
  const outboundSdp = description.sdp ? forceDirectStereoSdp(description.sdp) : description.sdp;
  const sanitizedSdp = outboundSdp ? sanitizeLanSdp(outboundSdp) : '';
  return Boolean(
    description.type === 'answer' &&
    sanitizedSdp &&
    sdpHasOneAudioMedia(sanitizedSdp) &&
    sendSignal({
      kind: 'answer',
      targetParticipantId: route.ownerParticipantId,
      direction: 'subscriber',
      phase: 'media',
      generation: route.generation,
      publicationId: route.publicationId,
      negotiationId: route.negotiationId,
      description: { type: 'answer', sdp: sanitizedSdp },
    }),
  );
}

async function acceptOffer(signal: DirectOfferSignal, ownerParticipantId: string): Promise<void> {
  const previous = receiverRoute;
  const negotiationKey = receiverNegotiationKey(
    ownerParticipantId,
    signal.generation,
    signal.publicationId,
    signal.negotiationId,
  );
  if (
    previous &&
    previous.ownerParticipantId === ownerParticipantId &&
    previous.generation === signal.generation &&
    previous.publicationId === signal.publicationId &&
    previous.negotiationId === signal.negotiationId
  ) {
    return;
  }
  if (!rememberReceiverNegotiation(negotiationKey)) return;
  const earlyCandidates = takePreOfferCandidates(ownerParticipantId, signal);
  if (previous) {
    receiverRoute = null;
    closeReceiverRoute(previous, 'superseded', true);
  }
  let route: ReceiverRoute | null = null;
  try {
    route = createReceiverRoute(signal, ownerParticipantId);
    route.queuedRemoteCandidates.push(...earlyCandidates);
    route.remoteCandidateCount = earlyCandidates.length;
    for (const candidate of earlyCandidates) {
      const tuple = candidateTuple(candidate);
      if (tuple) route.remoteCandidateTuples.add(tuple);
    }
    receiverRoute = route;
    route.live = receiverPublicationMatches(route);
    await route.pc.setRemoteDescription({
      ...signal.description,
      sdp: forceDirectStereoSdp(signal.description.sdp),
    });
    if (receiverRoute !== route || route.closed) return;
    route.remoteDescriptionReady = true;
    await flushReceiverRemoteCandidates(route);
    const answer = await route.pc.createAnswer();
    if (receiverRoute !== route || route.closed) return;
    const localAnswer = answer.sdp ? { ...answer, sdp: forceDirectStereoSdp(answer.sdp) } : answer;
    await route.pc.setLocalDescription(localAnswer);
    if (receiverRoute !== route || route.closed) return;
    const description = route.pc.localDescription ?? localAnswer;
    if (description.type !== 'answer' || !description.sdp) {
      throw new Error('DIRECT_ANSWER_INVALID');
    }
    route.answerSent = sendReceiverAnswer(route, description);
    if (!route.answerSent) throw new Error('DIRECT_ANSWER_SEND_FAILED');
    flushReceiverLocalCandidates(route);
    // Defensive: libwebrtc gathers only once setLocalDescription completes, so
    // no browser is known to end gathering before this answer. A LAN candidate
    // that still followed that end has just gone out, so the route stays.
    if (route.gatheringEndedWithoutLanCandidate && route.localCandidateCount === 0) {
      failReceiverRouteWithoutLanCandidate(route);
      return;
    }
    observeDirectTask(proveReceiverRoute(route), 'Receiver pair proof');
  } catch (error) {
    log.debug('[ProSysAudioDirect] Receiver negotiation failed', error);
    if (route && receiverRoute === route) failReceiverRoute(route, 'receiver-negotiation-failed');
  }
}

async function acceptAnswer(
  signal: DirectAnswerSignal,
  senderParticipantId: string,
): Promise<void> {
  const session = publisherSession;
  const route = session?.routes.get(senderParticipantId);
  if (
    !session ||
    !route ||
    route.closed ||
    signal.targetParticipantId !== callbacks?.getLocalIdentity()?.participantId ||
    !samePublication(route, signal.generation, signal.publicationId) ||
    route.negotiationId !== signal.negotiationId ||
    !route.offerSent ||
    route.answer !== 'none'
  ) {
    return;
  }
  route.answer = 'applying';
  try {
    await route.pc.setRemoteDescription({
      ...signal.description,
      sdp: forceDirectStereoSdp(signal.description.sdp),
    });
    if (!publisherRouteIsCurrent(session, route)) return;
    route.remoteDescriptionReady = true;
    await flushPublisherRemoteCandidates(route);
    if (!publisherRouteIsCurrent(session, route)) return;
    route.answer = 'applied';
  } catch (error) {
    log.debug('[ProSysAudioDirect] Answer rejected', error);
    failPublisherRoute(route, 'answer-rejected');
  }
}

async function acceptCandidate(
  signal: DirectCandidateSignal,
  senderParticipantId: string,
): Promise<void> {
  const candidate = sanitizeLanCandidateInit(signal.candidate);
  if (!candidate) return;
  if (signal.direction === 'subscriber') {
    const route = publisherSession?.routes.get(senderParticipantId);
    if (
      !route ||
      route.closed ||
      !samePublication(route, signal.generation, signal.publicationId) ||
      route.negotiationId !== signal.negotiationId
    ) {
      return;
    }
    const tuple = candidateTuple(candidate);
    if (!tuple || route.remoteCandidateTuples.has(tuple)) return;
    route.remoteCandidateTuples.add(tuple);
    route.remoteCandidateCount += 1;
    if (route.remoteCandidateCount > MAX_REMOTE_ICE_CANDIDATES) {
      failPublisherRoute(route, 'remote-candidate-limit');
      return;
    }
    if (!route.remoteDescriptionReady) route.queuedRemoteCandidates.push(candidate);
    else {
      try {
        await route.pc.addIceCandidate(candidate);
        const parsed = candidate.candidate ? parseLanCandidateLine(candidate.candidate) : null;
        if (
          parsed &&
          publisherSession?.routes.get(senderParticipantId) === route &&
          !route.closed
        ) {
          acceptRemoteMdnsKey(route, parsed.ledgerKey);
        }
      } catch {
        failPublisherRoute(route, 'candidate-rejected');
      }
    }
    return;
  }
  const route = receiverRoute;
  if (
    !route ||
    route.closed ||
    route.ownerParticipantId !== senderParticipantId ||
    !samePublication(route, signal.generation, signal.publicationId) ||
    route.negotiationId !== signal.negotiationId
  ) {
    queuePreOfferCandidate(senderParticipantId, signal);
    return;
  }
  const tuple = candidateTuple(candidate);
  if (!tuple || route.remoteCandidateTuples.has(tuple)) return;
  route.remoteCandidateTuples.add(tuple);
  route.remoteCandidateCount += 1;
  if (route.remoteCandidateCount > MAX_REMOTE_ICE_CANDIDATES) {
    failReceiverRoute(route, 'remote-candidate-limit');
    return;
  }
  if (!route.remoteDescriptionReady) route.queuedRemoteCandidates.push(candidate);
  else {
    try {
      await route.pc.addIceCandidate(candidate);
      const parsed = candidate.candidate ? parseLanCandidateLine(candidate.candidate) : null;
      if (parsed && receiverRoute === route && !route.closed) {
        acceptRemoteMdnsKey(route, parsed.ledgerKey);
      }
    } catch {
      failReceiverRoute(route, 'candidate-rejected');
    }
  }
}

function acceptClose(signal: DirectCloseSignal, senderParticipantId: string): void {
  if (signal.direction === 'subscriber') {
    const session = publisherSession;
    const route = session?.routes.get(senderParticipantId);
    if (
      !session ||
      !route ||
      !samePublication(route, signal.generation, signal.publicationId) ||
      route.negotiationId !== signal.negotiationId
    ) {
      return;
    }
    if (signal.reason === 'fallback' && session.phase === 'live') {
      notifyPublisherFallback(route, 'receiver-requested-fallback');
      return;
    }
    route.endReason ??= `receiver-${signal.reason}`;
    closePublisherRoute(route, signal.reason, false);
    session.routes.delete(senderParticipantId);
    return;
  }
  const route = receiverRoute;
  if (
    !route ||
    route.ownerParticipantId !== senderParticipantId ||
    !samePublication(route, signal.generation, signal.publicationId) ||
    route.negotiationId !== signal.negotiationId
  ) {
    return;
  }
  if (signal.reason === 'fallback' && route.live) {
    notifyReceiverFallback(route, 'publisher-requested-fallback');
    return;
  }
  receiverRoute = null;
  closeReceiverRoute(route, signal.reason, false);
  // A publisher sends 'stopped' only from its explicit stop, before it
  // releases the share, so the server's idle state follows. Tell the service,
  // which ends the reception now (5B-G6, gap 11); 'superseded' and a
  // non-live 'fallback' close the route only, as before.
  if (signal.reason !== 'stopped') return;
  try {
    callbacks?.onLiveRouteStopped({
      participantId: route.ownerParticipantId,
      generation: route.generation,
      publicationId: route.publicationId,
    });
  } catch (error) {
    log.warn('[ProSysAudioDirect] Receiver stop callback failed', error);
  }
}

function handleRealtimeFrame(frame: ProServerEventEnvelope | ProRealtimeRelayEnvelope): void {
  if (!callbacks || frame.type !== 'pro-realtime') return;
  const relay = frame;
  if (relay.channel !== 'system-audio-signal' || !isRecord(relay.sender)) return;
  const senderParticipantId = relay.sender.participantId;
  if (!validParticipantId(senderParticipantId)) return;
  const signal = parseSignal(relay.payload);
  const localParticipantId = callbacks.getLocalIdentity()?.participantId;
  if (!signal || !localParticipantId || signal.targetParticipantId !== localParticipantId) return;
  const context = signalContext(signal, senderParticipantId);
  if (!callbacks.authorizeInboundSignal(context)) return;
  if (signal.kind === 'offer') {
    if (
      !callbacks.authorizeInboundOffer({
        ...context,
        kind: 'offer',
        ownerParticipantId: senderParticipantId,
        trackId: signal.trackId,
      })
    ) {
      return;
    }
    observeDirectTask(acceptOffer(signal, senderParticipantId), 'Inbound offer handling');
  } else if (signal.kind === 'answer') {
    observeDirectTask(acceptAnswer(signal, senderParticipantId), 'Inbound answer handling');
  } else if (signal.kind === 'candidate') {
    observeDirectTask(acceptCandidate(signal, senderParticipantId), 'Inbound candidate handling');
  } else {
    acceptClose(signal, senderParticipantId);
  }
}

export function configureProSystemAudioDirectTransport(
  nextCallbacks: ProSystemAudioDirectTransportCallbacks,
): void {
  resetProSystemAudioDirectTransport({ notifyPeers: false });
  callbacks = nextCallbacks;
  if (!unsubscribeRealtime) unsubscribeRealtime = onProRoomRealtimeEvent(handleRealtimeFrame);
}

export async function attemptProSystemAudioDirectPublication(
  options: ProSystemAudioDirectAttemptOptions,
): Promise<ProSystemAudioDirectPublicationDescriptor | null> {
  const identity = callbacks?.getLocalIdentity();
  if (!callbacks || !identity) throw new Error('PRO_SYSTEM_AUDIO_DIRECT_NOT_CONFIGURED');
  if (
    !Number.isSafeInteger(options.generation) ||
    options.generation < 1 ||
    !validSignalId(options.publicationId) ||
    !validTrackId(options.track.id)
  ) {
    throw new Error('PRO_SYSTEM_AUDIO_DIRECT_IDENTITY_INVALID');
  }
  lifecycleEpoch += 1;
  if (publisherSession) closePublisherSession(publisherSession, 'superseded', true);
  if (receiverRoute) closeReceiverRoute(receiverRoute, 'superseded', true);
  publisherSession = null;
  receiverRoute = null;
  activePublication = null;
  const targets = normalizedTargets(options.targets, identity.participantId);
  const session: PublisherSession = {
    generation: options.generation,
    publicationId: options.publicationId,
    track: options.track,
    targets,
    routes: new Map(),
    phase: 'probing',
    fallbackSent: false,
    closed: false,
    reconcileRevision: 0,
    reconcileDesiredTargets: null,
    reconcileTimeoutMs: DIRECT_NEGOTIATION_TIMEOUT_MS,
    reconcileFlight: null,
  };
  publisherSession = session;
  const epoch = lifecycleEpoch;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DIRECT_NEGOTIATION_TIMEOUT_MS);
  const results = await Promise.all(
    [...targets].map(async ([participantId, routeToken]) => {
      const proven = await negotiatePublisherRoute(session, participantId, routeToken, timeoutMs);
      // The publication needs every route, so the first failure ends the
      // attempt: a remote listener need not wait for a slow LAN route.
      if (!proven && publisherSession === session) closePublisherSession(session, 'fallback', true);
      return proven;
    }),
  );
  if (
    publisherSession !== session ||
    lifecycleEpoch !== epoch ||
    session.closed ||
    results.some((result) => !result) ||
    !publisherSessionHasExactCoverage(session)
  ) {
    if (publisherSession === session) publisherSession = null;
    closePublisherSession(session, 'fallback', true);
    return null;
  }
  return {
    publicationId: options.publicationId,
    transport: 'lan-direct',
    protocolVersion: 2,
  };
}

export async function activateProSystemAudioDirectPublication(
  publication: ProSystemAudioDirectActivation,
): Promise<boolean> {
  if (
    !callbacks ||
    !validParticipantId(publication.ownerParticipantId) ||
    !Number.isSafeInteger(publication.generation) ||
    publication.generation < 1 ||
    !validSignalId(publication.publicationId)
  ) {
    return false;
  }
  const previous = activePublication;
  if (
    previous &&
    (previous.ownerParticipantId !== publication.ownerParticipantId ||
      !samePublication(previous, publication.generation, publication.publicationId))
  ) {
    const publisher = publisherSession;
    if (
      publisher &&
      !samePublication(publisher, publication.generation, publication.publicationId)
    ) {
      publisherSession = null;
      closePublisherSession(publisher, 'superseded', true);
    }
    const receiver = receiverRoute;
    if (
      receiver &&
      (receiver.ownerParticipantId !== publication.ownerParticipantId ||
        !samePublication(receiver, publication.generation, publication.publicationId))
    ) {
      receiverRoute = null;
      closeReceiverRoute(receiver, 'superseded', true);
    }
    activePublication = null;
  }
  activePublication = {
    ownerParticipantId: publication.ownerParticipantId,
    generation: publication.generation,
    publicationId: publication.publicationId,
  };
  const localParticipantId = callbacks.getLocalIdentity()?.participantId;
  if (!localParticipantId) return false;
  if (publication.ownerParticipantId === localParticipantId) {
    const session = publisherSession;
    if (
      !session ||
      session.closed ||
      !samePublication(session, publication.generation, publication.publicationId)
    ) {
      return false;
    }
    if (publication.targets) {
      try {
        session.targets = normalizedTargets(publication.targets, localParticipantId);
      } catch {
        return false;
      }
    }
    session.phase = 'live';
    if (!publisherSessionHasExactRouteSet(session)) {
      const missingParticipantId =
        [...session.targets.keys()].find((participantId) => {
          const route = session.routes.get(participantId);
          return !route || route.routeToken !== session.targets.get(participantId);
        }) ??
        [...session.routes.keys()][0] ??
        localParticipantId;
      notifyPublisherSessionFallback(session, missingParticipantId, 'activation-route-coverage');
      return false;
    }
    const routes = [...session.routes.values()];
    const reproved = await Promise.all(
      routes.map((route) => provePublisherRouteCurrent(session, route)),
    );
    if (
      publisherSession !== session ||
      session.closed ||
      reproved.some((proven) => !proven) ||
      !publisherSessionHasExactCoverage(session)
    ) {
      const invalidRoute = routes.find(
        (route) =>
          !publisherRouteIsCurrent(session, route) ||
          !route.provenLocal ||
          pcDisconnected(route.pc),
      );
      if (publisherSession === session && !session.closed) {
        if (invalidRoute) notifyPublisherFallback(invalidRoute, 'activation-locality-unproven');
        else {
          notifyPublisherSessionFallback(
            session,
            [...session.targets.keys()][0] ?? localParticipantId,
            'activation-route-unavailable',
          );
        }
      }
      return false;
    }
    for (const route of routes) {
      route.committed = true;
      scheduleLivePublisherRouteReproof(session, route);
    }
    return true;
  }
  if (
    receiverRoute &&
    receiverRoute.ownerParticipantId === publication.ownerParticipantId &&
    samePublication(receiverRoute, publication.generation, publication.publicationId)
  ) {
    receiverRoute.live = true;
    if (pcDisconnected(receiverRoute.pc)) {
      notifyReceiverFallback(receiverRoute, 'activation-route-unavailable');
      return false;
    }
    maybeDeliverReceiverTrack(receiverRoute);
  }
  return true;
}

async function runPublisherTargetReconcile(
  session: PublisherSession,
  localParticipantId: string,
): Promise<boolean> {
  while (publisherSession === session && !session.closed && session.phase === 'live') {
    if (session.fallbackSent) return false;
    const revision = session.reconcileRevision;
    const desired = session.reconcileDesiredTargets;
    if (!desired) return false;
    const timeoutMs = session.reconcileTimeoutMs;
    session.targets = desired;
    for (const [participantId, route] of [...session.routes]) {
      if (desired.get(participantId) === route.routeToken) continue;
      session.routes.delete(participantId);
      closePublisherRoute(route, 'superseded', true);
    }
    const additions = [...desired].filter(([participantId]) => !session.routes.has(participantId));
    const results = await Promise.all(
      additions.map(async ([participantId, routeToken]) => ({
        participantId,
        routeToken,
        success: await negotiatePublisherRoute(session, participantId, routeToken, timeoutMs),
      })),
    );
    if (publisherSession !== session || session.closed || session.phase !== 'live') return false;
    // Presence may change again while a route is proving locality. Only the
    // newest desired set is authoritative; a superseded pass must neither run
    // exact-coverage checks nor demote an otherwise healthy LAN publication.
    if (session.reconcileRevision !== revision) continue;
    const failed = results.find(
      (result) =>
        !result.success && session.targets.get(result.participantId) === result.routeToken,
    );
    if (failed) {
      const route = session.routes.get(failed.participantId);
      if (route) notifyPublisherFallback(route, 'late-join-negotiation-failed');
      else {
        notifyPublisherSessionFallback(
          session,
          failed.participantId,
          'late-join-negotiation-failed',
        );
      }
      return false;
    }
    if (!publisherSessionHasExactCoverage(session)) {
      notifyPublisherSessionFallback(
        session,
        [...session.targets.keys()][0] ?? localParticipantId,
        'target-route-coverage-failed',
      );
      return false;
    }
    for (const route of session.routes.values()) {
      route.committed = true;
      scheduleLivePublisherRouteReproof(session, route);
    }
    return true;
  }
  return false;
}

export async function reconcileProSystemAudioDirectTargets(
  targets: readonly ProSystemAudioDirectTarget[],
  timeoutMs = DIRECT_NEGOTIATION_TIMEOUT_MS,
): Promise<boolean> {
  const session = publisherSession;
  const localParticipantId = callbacks?.getLocalIdentity()?.participantId;
  if (!session || session.phase !== 'live' || session.closed || !localParticipantId) return false;
  session.reconcileDesiredTargets = normalizedTargets(targets, localParticipantId);
  session.reconcileTimeoutMs = Math.max(1, timeoutMs);
  session.reconcileRevision += 1;
  for (const [participantId, route] of [...session.routes]) {
    if (session.reconcileDesiredTargets.get(participantId) === route.routeToken) continue;
    session.routes.delete(participantId);
    closePublisherRoute(route, 'superseded', true);
  }
  // Once promotion is requested, roster changes still retire departed or
  // superseded incumbents, but must not start more direct negotiations. The
  // authenticated SFU commit or ordinary stop/lease-loss lifecycle ends them.
  if (session.fallbackSent) return false;
  if (session.reconcileFlight) return session.reconcileFlight;

  const flight = runPublisherTargetReconcile(session, localParticipantId);
  session.reconcileFlight = flight;
  try {
    return await flight;
  } finally {
    if (session.reconcileFlight === flight) session.reconcileFlight = null;
  }
}

export function resetProSystemAudioDirectTransport(
  options: { notifyPeers?: boolean; reason?: DirectCloseReason } = {},
): void {
  lifecycleEpoch += 1;
  const notifyPeers = options.notifyPeers ?? true;
  const reason = options.reason ?? 'stopped';
  const publisher = publisherSession;
  const receiver = receiverRoute;
  publisherSession = null;
  receiverRoute = null;
  activePublication = null;
  seenReceiverNegotiations.clear();
  clearPreOfferCandidates();
  if (publisher) closePublisherSession(publisher, reason, notifyPeers);
  if (receiver) closeReceiverRoute(receiver, reason, notifyPeers);
}
