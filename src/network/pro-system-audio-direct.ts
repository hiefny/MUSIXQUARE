/**
 * LAN-only media transport for persistent PRO-room system audio.
 *
 * The authenticated PRO realtime socket carries only targeted SDP/ICE. Media
 * peer connections deliberately use host candidates exclusively: this module
 * never loads TURN credentials or calls the Cloudflare Realtime media API.
 */

import { MAX_SYSTEM_AUDIO_DEVICES } from '../core/constants.ts';
import { log } from '../core/log.ts';
import { clearManagedTimer, delay, setManagedTimer } from '../core/timers.ts';
import {
  onProRoomRealtimeEvent,
  sendProRoomRealtime,
  type ProRealtimeRelayEnvelope,
  type ProServerEventEnvelope,
} from '../pro-room/network-bridge.ts';

const DIRECT_NEGOTIATION_TIMEOUT_MS = 5_000;
const DIRECT_PAIR_POLL_MS = 25;
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

type DirectDirection = 'publisher' | 'subscriber';
type DirectCloseReason = 'stopped' | 'fallback' | 'superseded';
type DirectSignalKind = 'offer' | 'answer' | 'candidate' | 'close';
type DirectNegotiationPhase = 'probe' | 'media';

interface DirectSignalBase {
  kind: DirectSignalKind;
  targetParticipantId: string;
  direction: DirectDirection;
  generation: number;
  publicationId: string;
  negotiationId: string;
}

interface DirectProbeOfferSignal extends DirectSignalBase {
  kind: 'offer';
  direction: 'publisher';
  phase: 'probe';
  description: { type: 'offer'; sdp: string };
}

interface DirectMediaOfferSignal extends DirectSignalBase {
  kind: 'offer';
  direction: 'publisher';
  phase: 'media';
  description: { type: 'offer'; sdp: string };
  trackIds: { L: string; R: string };
}

type DirectOfferSignal = DirectProbeOfferSignal | DirectMediaOfferSignal;

interface DirectAnswerSignal extends DirectSignalBase {
  kind: 'answer';
  direction: 'subscriber';
  phase: DirectNegotiationPhase;
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
  | DirectOfferSignal
  | DirectAnswerSignal
  | DirectCandidateSignal
  | DirectCloseSignal;

interface ProSystemAudioDirectPublicationDescriptor {
  publicationId: string;
  transport: 'lan-direct';
  protocolVersion: 1;
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
  phase: DirectNegotiationPhase;
  trackIds: { L: string; R: string } | null;
}

export interface ProSystemAudioDirectTracksReadyEvent {
  ownerParticipantId: string;
  generation: number;
  publicationId: string;
  negotiationId: string;
  leftTrack: MediaStreamTrack;
  rightTrack: MediaStreamTrack;
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

interface ProSystemAudioDirectTransportCallbacks {
  getLocalIdentity: () => { participantId: string } | null;
  authorizeInboundOffer: (context: ProSystemAudioDirectInboundOfferContext) => boolean;
  authorizeInboundSignal: (context: ProSystemAudioDirectInboundSignalContext) => boolean;
  onReceiverTracksReady: (event: ProSystemAudioDirectTracksReadyEvent) => void | Promise<void>;
  onLiveRouteFallback: (event: ProSystemAudioDirectFallbackEvent) => void;
}

interface ProSystemAudioDirectAttemptOptions {
  leftTrack: MediaStreamTrack;
  rightTrack: MediaStreamTrack;
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
  remoteCandidateCount: number;
  offerSent: boolean;
  remoteDescriptionReady: boolean;
  provenLocal: boolean;
  failed: boolean;
  closed: boolean;
  reproofFlight: Promise<boolean> | null;
  probeAnswered: boolean;
  mediaAnswered: boolean;
  mediaTracksAdded: boolean;
  committed: boolean;
}

interface PublisherSession {
  generation: number;
  publicationId: string;
  leftTrack: MediaStreamTrack;
  rightTrack: MediaStreamTrack;
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
  trackIds: { L: string; R: string } | null;
  tracks: Partial<Record<'L' | 'R', MediaStreamTrack>>;
  queuedLocalCandidates: RTCIceCandidateInit[];
  queuedRemoteCandidates: RTCIceCandidateInit[];
  localCandidateTuples: Set<string>;
  remoteCandidateTuples: Set<string>;
  acceptedRemoteMdnsKeys: Set<string>;
  localCandidateCount: number;
  remoteCandidateCount: number;
  answerSent: boolean;
  remoteDescriptionReady: boolean;
  tracksDelivered: boolean;
  mediaAnswerSent: boolean;
  live: boolean;
  fallbackSent: boolean;
  closed: boolean;
  phase: DirectNegotiationPhase;
  provenLocal: boolean;
  mediaOfferPending: boolean;
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

function sdpHasAudioMedia(sdp: string): boolean {
  return sdp.split(/\r?\n/).some((line) => /^m=audio(?:\s|$)/i.test(line.trim()));
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
  if (value.kind === 'offer' && value.direction === 'publisher') {
    if (value.phase !== 'probe' && value.phase !== 'media') return null;
    const requiredKeys =
      value.phase === 'probe'
        ? [...commonKeys, 'phase', 'description']
        : [...commonKeys, 'phase', 'description', 'trackIds'];
    if (!hasExactKeys(value, requiredKeys)) return null;
    const description = parseDescription(value.description, 'offer');
    if (!description) return null;
    if (value.phase === 'probe') {
      if (sdpHasAudioMedia(description.sdp)) return null;
      return {
        ...base,
        kind: 'offer',
        direction: 'publisher',
        phase: 'probe',
        description,
      };
    }
    if (!sdpHasAudioMedia(description.sdp)) return null;
    if (!hasExactKeys(value.trackIds, ['L', 'R'])) return null;
    const leftId = value.trackIds.L;
    const rightId = value.trackIds.R;
    if (!validTrackId(leftId) || !validTrackId(rightId) || leftId === rightId) return null;
    return {
      ...base,
      kind: 'offer',
      direction: 'publisher',
      phase: 'media',
      description,
      trackIds: { L: leftId, R: rightId },
    };
  }
  if (value.kind === 'answer' && value.direction === 'subscriber') {
    if (
      (value.phase !== 'probe' && value.phase !== 'media') ||
      !hasExactKeys(value, [...commonKeys, 'phase', 'description'])
    ) {
      return null;
    }
    const description = parseDescription(value.description, 'answer');
    if (
      description &&
      ((value.phase === 'probe' && sdpHasAudioMedia(description.sdp)) ||
        (value.phase === 'media' && !sdpHasAudioMedia(description.sdp)))
    ) {
      return null;
    }
    return description
      ? {
          ...base,
          kind: 'answer',
          direction: 'subscriber',
          phase: value.phase,
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
  return `pro-system-audio-direct-tracks-ready:${route.negotiationId}`;
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

async function selectedPairLocality(
  pc: RTCPeerConnection,
  acceptedRemoteMdnsKeys: ReadonlySet<string>,
): Promise<'same-subnet' | 'non-local' | 'pending'> {
  try {
    const stats = await pc.getStats();
    const selectedPairIds = new Set<string>();
    for (const report of stats.values()) {
      if (report.type === 'transport') {
        const selectedPairId = statsString(report, 'selectedCandidatePairId');
        if (selectedPairId) selectedPairIds.add(selectedPairId);
      }
    }
    if (selectedPairIds.size > 1) return 'non-local';
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
    if (!pair || statsString(pair, 'state') !== 'succeeded') return 'pending';
    const localCandidate = stats.get(statsString(pair, 'localCandidateId') ?? '');
    const remoteCandidate = stats.get(statsString(pair, 'remoteCandidateId') ?? '');
    const localType = statsString(localCandidate, 'candidateType');
    const remoteType = statsString(remoteCandidate, 'candidateType');
    if (!localType || !remoteType) return 'pending';
    if (localType !== 'host' || remoteType !== 'host') return 'non-local';
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
    const localAddress = candidateAddress(localCandidate);
    const remoteAddress = candidateAddress(remoteCandidate);
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
  } catch (error) {
    log.debug('[ProSysAudioDirect] ICE stats unavailable', error);
    return 'pending';
  }
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
  route.pc.close();
  route.queuedLocalCandidates.length = 0;
  route.queuedRemoteCandidates.length = 0;
  route.localCandidateTuples.clear();
  route.remoteCandidateTuples.clear();
  route.acceptedRemoteMdnsKeys.clear();
  route.tracks = {};
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
  publisherSession = null;
  closePublisherSession(session, 'fallback', true);
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
    if (receiverRoute === route) receiverRoute = null;
    closeReceiverRoute(route, 'fallback', true);
  }
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
    void reproveLivePublisherRoute(session, route, 'connection-locality-changed');
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

async function flushPublisherRemoteCandidates(route: PublisherRoute): Promise<void> {
  if (!route.remoteDescriptionReady || route.closed) return;
  const candidates = route.queuedRemoteCandidates.splice(0);
  for (const candidate of candidates) {
    await route.pc.addIceCandidate(candidate);
    const parsed = candidate.candidate ? parseLanCandidateLine(candidate.candidate) : null;
    const session = publisherSession;
    if (parsed && session && publisherRouteIsCurrent(session, route)) {
      route.acceptedRemoteMdnsKeys.add(parsed.ledgerKey);
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
      route.acceptedRemoteMdnsKeys.add(parsed.ledgerKey);
    }
  }
}

function tuneAudioSender(sender: RTCRtpSender): void {
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings) parameters.encodings = [{}];
    if (parameters.encodings[0]) parameters.encodings[0].maxBitrate = 128_000;
    void sender.setParameters(parameters).catch(() => undefined);
  } catch {
    // Sender tuning is best-effort and must not demote an otherwise local route.
  }
}

function createPublisherRoute(
  session: PublisherSession,
  participantId: string,
  routeToken: string,
): PublisherRoute {
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const probeChannel = pc.createDataChannel('MUSIXQUARE-lan-probe', { ordered: false });
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
    remoteCandidateCount: 0,
    offerSent: false,
    remoteDescriptionReady: false,
    provenLocal: false,
    failed: false,
    closed: false,
    reproofFlight: null,
    probeAnswered: false,
    mediaAnswered: false,
    mediaTracksAdded: false,
    committed: false,
  };
  session.routes.set(participantId, route);
  pc.onicecandidate = (event) => {
    if (!event.candidate || route.closed) return;
    const candidate = sanitizeLanCandidateInit(candidateInit(event.candidate));
    const parsedCandidate = candidate?.candidate
      ? parseLanCandidateLine(candidate.candidate)
      : null;
    if (!candidate || !parsedCandidate) return;
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

async function waitForLocalPair(
  session: PublisherSession,
  route: PublisherRoute,
  timeoutMs: number,
): Promise<boolean> {
  const expiresAt = Date.now() + timeoutMs;
  while (publisherRouteIsCurrent(session, route) && Date.now() <= expiresAt) {
    if (pcDisconnected(route.pc)) return false;
    if (pcConnected(route.pc)) {
      const locality = await selectedPairLocality(route.pc, route.acceptedRemoteMdnsKeys);
      if (!publisherRouteIsCurrent(session, route)) return false;
      if (locality === 'same-subnet') {
        route.provenLocal = true;
        return true;
      }
      if (locality === 'non-local') return false;
    }
    await delay(Math.min(DIRECT_PAIR_POLL_MS, Math.max(1, expiresAt - Date.now())));
  }
  return false;
}

async function waitForPublisherAnswer(
  session: PublisherSession,
  route: PublisherRoute,
  phase: DirectNegotiationPhase,
  timeoutMs: number,
): Promise<boolean> {
  const expiresAt = Date.now() + timeoutMs;
  while (publisherRouteIsCurrent(session, route) && Date.now() <= expiresAt) {
    if (phase === 'probe' ? route.probeAnswered : route.mediaAnswered) return true;
    await delay(Math.min(DIRECT_PAIR_POLL_MS, Math.max(1, expiresAt - Date.now())));
  }
  return false;
}

async function sendPublisherOffer(
  session: PublisherSession,
  route: PublisherRoute,
  phase: DirectNegotiationPhase,
): Promise<void> {
  const offer = await route.pc.createOffer();
  if (!publisherRouteIsCurrent(session, route)) throw new Error('DIRECT_ROUTE_SUPERSEDED');
  const previousOfferSent = route.offerSent;
  route.offerSent = false;
  await route.pc.setLocalDescription(offer);
  if (!publisherRouteIsCurrent(session, route)) throw new Error('DIRECT_ROUTE_SUPERSEDED');
  const description = route.pc.localDescription ?? offer;
  const sanitizedSdp = description.sdp ? sanitizeLanSdp(description.sdp) : '';
  if (
    description.type !== 'offer' ||
    !sanitizedSdp ||
    (phase === 'probe' && sdpHasAudioMedia(sanitizedSdp)) ||
    (phase === 'media' && !sdpHasAudioMedia(sanitizedSdp))
  ) {
    throw new Error('DIRECT_OFFER_INVALID');
  }
  const sent =
    phase === 'probe'
      ? sendSignal({
          kind: 'offer',
          targetParticipantId: route.participantId,
          direction: 'publisher',
          phase: 'probe',
          generation: session.generation,
          publicationId: session.publicationId,
          negotiationId: route.negotiationId,
          description: { type: 'offer', sdp: sanitizedSdp },
        })
      : sendSignal({
          kind: 'offer',
          targetParticipantId: route.participantId,
          direction: 'publisher',
          phase: 'media',
          generation: session.generation,
          publicationId: session.publicationId,
          negotiationId: route.negotiationId,
          description: { type: 'offer', sdp: sanitizedSdp },
          trackIds: { L: session.leftTrack.id, R: session.rightTrack.id },
        });
  route.offerSent = previousOfferSent || sent;
  if (!sent) throw new Error('DIRECT_OFFER_SEND_FAILED');
  flushPublisherLocalCandidates(route);
}

async function provePublisherRouteCurrent(
  session: PublisherSession,
  route: PublisherRoute,
): Promise<boolean> {
  if (!publisherRouteIsCurrent(session, route) || pcDisconnected(route.pc)) return false;
  if (route.reproofFlight) return route.reproofFlight;
  const flight = (async () => {
    const locality = await selectedPairLocality(route.pc, route.acceptedRemoteMdnsKeys);
    if (!publisherRouteIsCurrent(session, route) || pcDisconnected(route.pc)) return false;
    route.provenLocal = locality === 'same-subnet';
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
  if (
    session.phase !== 'live' ||
    !route.committed ||
    !publisherRouteIsCurrent(session, route) ||
    session.fallbackSent
  ) {
    return;
  }
  setManagedTimer(
    publisherRouteTimerName(route),
    () => void reproveLivePublisherRoute(session, route, 'periodic-locality-check-failed'),
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

async function negotiatePublisherRoute(
  session: PublisherSession,
  participantId: string,
  routeToken: string,
  timeoutMs: number,
): Promise<boolean> {
  let route: PublisherRoute | null = null;
  try {
    route = createPublisherRoute(session, participantId, routeToken);
    const expiresAt = Date.now() + timeoutMs;
    const remaining = () => Math.max(1, expiresAt - Date.now());
    await sendPublisherOffer(session, route, 'probe');
    if (!(await waitForPublisherAnswer(session, route, 'probe', remaining()))) return false;
    if (!(await waitForLocalPair(session, route, remaining()))) return false;
    if (!publisherRouteIsCurrent(session, route)) return false;

    const stream = new MediaStream([session.leftTrack, session.rightTrack]);
    tuneAudioSender(route.pc.addTrack(session.leftTrack, stream));
    tuneAudioSender(route.pc.addTrack(session.rightTrack, stream));
    route.mediaTracksAdded = true;
    route.remoteDescriptionReady = false;
    await sendPublisherOffer(session, route, 'media');
    if (!(await waitForPublisherAnswer(session, route, 'media', remaining()))) return false;
    const proven = await waitForLocalPair(session, route, remaining());
    return proven && route.mediaTracksAdded;
  } catch (error) {
    log.debug('[ProSysAudioDirect] Publisher negotiation failed', error);
    if (route) {
      route.failed = true;
      if (session.routes.get(participantId) === route) session.routes.delete(participantId);
      closePublisherRoute(route, 'fallback', route.offerSent);
    }
    return false;
  }
}

function receiverPublicationMatches(route: ReceiverRoute): boolean {
  return Boolean(
    activePublication &&
    activePublication.ownerParticipantId === route.ownerParticipantId &&
    samePublication(activePublication, route.generation, route.publicationId),
  );
}

function maybeDeliverReceiverTracks(route: ReceiverRoute): void {
  const leftTrack = route.tracks.L;
  const rightTrack = route.tracks.R;
  if (
    route.closed ||
    route.tracksDelivered ||
    !route.live ||
    receiverRoute !== route ||
    !receiverPublicationMatches(route) ||
    !callbacks
  ) {
    return;
  }
  if (!route.mediaAnswerSent || !leftTrack || !rightTrack) {
    if (route.mediaAnswerSent) {
      setManagedTimer(
        receiverTrackReadyTimerName(route),
        () => {
          if (
            receiverRoute === route &&
            !route.closed &&
            route.live &&
            route.mediaAnswerSent &&
            !route.tracksDelivered &&
            (!route.tracks.L || !route.tracks.R)
          ) {
            notifyReceiverFallback(route, 'receiver-tracks-timeout');
          }
        },
        RECEIVER_TRACK_READY_TIMEOUT_MS,
      );
    }
    return;
  }
  clearManagedTimer(receiverTrackReadyTimerName(route));
  route.tracksDelivered = true;
  void Promise.resolve()
    .then(() =>
      callbacks?.onReceiverTracksReady({
        ownerParticipantId: route.ownerParticipantId,
        generation: route.generation,
        publicationId: route.publicationId,
        negotiationId: route.negotiationId,
        leftTrack,
        rightTrack,
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
  if (
    route.closed ||
    route.phase !== 'media' ||
    !route.provenLocal ||
    !route.trackIds ||
    track.kind !== 'audio'
  ) {
    return;
  }
  const channel = track.id === route.trackIds.L ? 'L' : track.id === route.trackIds.R ? 'R' : null;
  if (!channel || route.tracks[channel]) return;
  route.tracks[channel] = track;
  track.addEventListener('ended', () => {
    if (receiverRoute === route && route.live) failReceiverRoute(route, `track-${channel}-ended`);
  });
  maybeDeliverReceiverTracks(route);
}

function createReceiverRoute(
  signal: DirectProbeOfferSignal,
  ownerParticipantId: string,
): ReceiverRoute {
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const route: ReceiverRoute = {
    ownerParticipantId,
    generation: signal.generation,
    publicationId: signal.publicationId,
    negotiationId: signal.negotiationId,
    pc,
    trackIds: null,
    tracks: {},
    queuedLocalCandidates: [],
    queuedRemoteCandidates: [],
    localCandidateTuples: new Set(),
    remoteCandidateTuples: new Set(),
    acceptedRemoteMdnsKeys: new Set(),
    localCandidateCount: 0,
    remoteCandidateCount: 0,
    answerSent: false,
    remoteDescriptionReady: false,
    tracksDelivered: false,
    mediaAnswerSent: false,
    live: false,
    fallbackSent: false,
    closed: false,
    phase: 'probe',
    provenLocal: false,
    mediaOfferPending: false,
  };
  pc.onicecandidate = (event) => {
    if (!event.candidate || route.closed) return;
    const candidate = sanitizeLanCandidateInit(candidateInit(event.candidate));
    const parsedCandidate = candidate?.candidate
      ? parseLanCandidateLine(candidate.candidate)
      : null;
    if (!candidate || !parsedCandidate) return;
    if (route.localCandidateTuples.has(parsedCandidate.tuple)) return;
    route.localCandidateTuples.add(parsedCandidate.tuple);
    route.localCandidateCount += 1;
    if (route.localCandidateCount > MAX_LOCAL_ICE_CANDIDATES) {
      failReceiverRoute(route, 'local-candidate-limit');
      return;
    }
    if (!route.answerSent || route.mediaOfferPending) route.queuedLocalCandidates.push(candidate);
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
  return route;
}

async function waitForReceiverLocalPair(
  route: ReceiverRoute,
  timeoutMs = DIRECT_NEGOTIATION_TIMEOUT_MS,
): Promise<boolean> {
  const expiresAt = Date.now() + timeoutMs;
  while (
    receiverRoute === route &&
    !route.closed &&
    route.phase === 'probe' &&
    Date.now() <= expiresAt
  ) {
    if (pcDisconnected(route.pc)) return false;
    if (pcConnected(route.pc)) {
      const locality = await selectedPairLocality(route.pc, route.acceptedRemoteMdnsKeys);
      if (receiverRoute !== route || route.closed || route.phase !== 'probe') return false;
      if (locality === 'same-subnet') return true;
      if (locality === 'non-local') return false;
    }
    await delay(Math.min(DIRECT_PAIR_POLL_MS, Math.max(1, expiresAt - Date.now())));
  }
  return false;
}

function sendReceiverAnswer(
  route: ReceiverRoute,
  phase: DirectNegotiationPhase,
  description: RTCSessionDescriptionInit,
): boolean {
  const sanitizedSdp = description.sdp ? sanitizeLanSdp(description.sdp) : '';
  return Boolean(
    description.type === 'answer' &&
    sanitizedSdp &&
    (phase === 'media') === sdpHasAudioMedia(sanitizedSdp) &&
    sendSignal({
      kind: 'answer',
      targetParticipantId: route.ownerParticipantId,
      direction: 'subscriber',
      phase,
      generation: route.generation,
      publicationId: route.publicationId,
      negotiationId: route.negotiationId,
      description: { type: 'answer', sdp: sanitizedSdp },
    }),
  );
}

async function acceptMediaOffer(
  signal: DirectMediaOfferSignal,
  ownerParticipantId: string,
): Promise<void> {
  const route = receiverRoute;
  if (
    !route ||
    route.closed ||
    route.mediaOfferPending ||
    route.phase !== 'probe' ||
    route.ownerParticipantId !== ownerParticipantId ||
    !samePublication(route, signal.generation, signal.publicationId) ||
    route.negotiationId !== signal.negotiationId
  ) {
    return;
  }
  route.mediaOfferPending = true;
  try {
    if (!(await waitForReceiverLocalPair(route))) {
      failReceiverRoute(route, 'receiver-locality-unproven');
      return;
    }
    if (receiverRoute !== route || route.closed || route.phase !== 'probe') return;
    route.provenLocal = true;
    route.phase = 'media';
    route.trackIds = signal.trackIds;
    route.remoteDescriptionReady = false;
    await route.pc.setRemoteDescription(signal.description);
    if (receiverRoute !== route || route.closed || route.phase !== 'media') return;
    route.remoteDescriptionReady = true;
    await flushReceiverRemoteCandidates(route);
    const answer = await route.pc.createAnswer();
    if (receiverRoute !== route || route.closed || route.phase !== 'media') return;
    await route.pc.setLocalDescription(answer);
    if (receiverRoute !== route || route.closed || route.phase !== 'media') return;
    const description = route.pc.localDescription ?? answer;
    if (!sendReceiverAnswer(route, 'media', description)) {
      throw new Error('DIRECT_MEDIA_ANSWER_SEND_FAILED');
    }
    route.mediaAnswerSent = true;
    flushReceiverLocalCandidates(route);
    maybeDeliverReceiverTracks(route);
  } catch (error) {
    log.debug('[ProSysAudioDirect] Receiver media negotiation failed', error);
    if (receiverRoute === route) failReceiverRoute(route, 'receiver-media-negotiation-failed');
  } finally {
    route.mediaOfferPending = false;
  }
}

async function acceptOffer(signal: DirectOfferSignal, ownerParticipantId: string): Promise<void> {
  if (signal.phase === 'media') {
    await acceptMediaOffer(signal, ownerParticipantId);
    return;
  }
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
    await route.pc.setRemoteDescription(signal.description);
    if (receiverRoute !== route || route.closed) return;
    route.remoteDescriptionReady = true;
    await flushReceiverRemoteCandidates(route);
    const answer = await route.pc.createAnswer();
    if (receiverRoute !== route || route.closed) return;
    await route.pc.setLocalDescription(answer);
    if (receiverRoute !== route || route.closed) return;
    const description = route.pc.localDescription ?? answer;
    if (description.type !== 'answer' || !description.sdp) {
      throw new Error('DIRECT_ANSWER_INVALID');
    }
    route.answerSent = sendReceiverAnswer(route, 'probe', description);
    if (!route.answerSent) throw new Error('DIRECT_ANSWER_SEND_FAILED');
    flushReceiverLocalCandidates(route);
    maybeDeliverReceiverTracks(route);
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
    (signal.phase === 'probe' && (route.probeAnswered || route.mediaTracksAdded)) ||
    (signal.phase === 'media' &&
      (!route.probeAnswered || !route.mediaTracksAdded || route.mediaAnswered))
  ) {
    return;
  }
  try {
    await route.pc.setRemoteDescription(signal.description);
    if (!publisherRouteIsCurrent(session, route)) return;
    route.remoteDescriptionReady = true;
    await flushPublisherRemoteCandidates(route);
    if (!publisherRouteIsCurrent(session, route)) return;
    if (signal.phase === 'probe') route.probeAnswered = true;
    else route.mediaAnswered = true;
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
          route.acceptedRemoteMdnsKeys.add(parsed.ledgerKey);
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
        route.acceptedRemoteMdnsKeys.add(parsed.ledgerKey);
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
        phase: signal.phase,
        trackIds: signal.phase === 'media' ? signal.trackIds : null,
      })
    ) {
      return;
    }
    void acceptOffer(signal, senderParticipantId);
  } else if (signal.kind === 'answer') {
    void acceptAnswer(signal, senderParticipantId);
  } else if (signal.kind === 'candidate') {
    void acceptCandidate(signal, senderParticipantId);
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
    !validTrackId(options.leftTrack.id) ||
    !validTrackId(options.rightTrack.id) ||
    options.leftTrack.id === options.rightTrack.id
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
    leftTrack: options.leftTrack,
    rightTrack: options.rightTrack,
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
    [...targets].map(([participantId, routeToken]) =>
      negotiatePublisherRoute(session, participantId, routeToken, timeoutMs),
    ),
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
    protocolVersion: 1,
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
    maybeDeliverReceiverTracks(receiverRoute);
  }
  return true;
}

async function runPublisherTargetReconcile(
  session: PublisherSession,
  localParticipantId: string,
): Promise<boolean> {
  while (publisherSession === session && !session.closed && session.phase === 'live') {
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
