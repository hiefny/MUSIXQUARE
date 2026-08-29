/**
 * Role-independent Cloudflare Realtime transport for persistent PRO-room
 * system audio.
 *
 * Unlike `system-audio-sfu.ts`, this module has no host/guest or active
 * DataConnection assumptions.  A PRO-room controller owns publication
 * discovery and hands the public descriptor to every participant.  The
 * Cloudflare session owner capabilities never leave this module.
 */

import { fetchWithCapability, isCapabilityChallengeCancelled } from '../core/capability.ts';
import { log } from '../core/log.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { forceStereoSdp, sdpPrefersOpusStereo } from './peer.ts';
import {
  cancelResponseBody,
  readBoundedJsonResponse,
  withRequestDeadline,
} from '../core/request-lifetime.ts';
import { localFirstApiEndpoints } from './api-endpoints.ts';

const BASE_SFU_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const SYSTEM_AUDIO_PLAYOUT_DELAY_S = 0.5;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_TRACK_NAME_LENGTH = 160;
const MAX_ROOM_ID_LENGTH = 64;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const PUBLISHER_EXPIRY_TIMER = 'pro-system-audio-sfu:publisher-expiry';
const SUBSCRIBER_EXPIRY_TIMER = 'pro-system-audio-sfu:subscriber-expiry';
const SFU_CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const SFU_CONTROL_RESPONSE_MAX_BYTES = 1024 * 1024;
const SYSTEM_AUDIO_STEREO_MAX_BITRATE = 256_000;

interface ProSystemAudioSfuTrackDescriptor {
  trackName: string;
  mid?: string;
}

/** Safe to persist in PRO room state and broadcast to every participant. */
export interface ProSystemAudioSfuPublicationDescriptor {
  version: 2;
  sessionId: string;
  track: ProSystemAudioSfuTrackDescriptor;
  generation: number;
  expiresAt: number;
}

interface PublishProSystemAudioSfuOptions {
  track: MediaStreamTrack;
  /** Controller-issued publication generation. Must increase on replacement. */
  generation: number;
  /** Absolute Unix time in milliseconds after which the publication is invalid. */
  expiresAt: number;
  /** Used only to make correlation and track names recognizable in diagnostics. */
  roomId?: string;
}

/**
 * Opaque, one-shot preparation for a possible SFU publisher fallback.
 * This only fetches capability/TURN configuration; it never allocates a
 * Cloudflare Realtime session, so a successful LAN-direct probe stays free of
 * SFU session cost.
 */
export interface ProSystemAudioSfuPublisherPreflight {
  readonly kind: 'pro-system-audio-sfu-publisher-preflight';
}

type PublisherPreflightResult =
  | { ok: true; rtcConfig: RTCConfiguration }
  | { ok: false; error: unknown };

interface PublisherPreflightState {
  controller: AbortController;
  result: Promise<PublisherPreflightResult>;
}

const publisherPreflights = new WeakMap<
  ProSystemAudioSfuPublisherPreflight,
  PublisherPreflightState
>();

type ProSystemAudioSfuEvent =
  | {
      type: 'publisher-state';
      state: 'publishing' | 'published' | 'stopped' | 'failed';
      descriptor: ProSystemAudioSfuPublicationDescriptor | null;
      message?: string;
    }
  | {
      type: 'subscriber-state';
      state: 'subscribing' | 'subscribed' | 'disconnected' | 'stopped' | 'failed';
      descriptor: ProSystemAudioSfuPublicationDescriptor | null;
      message?: string;
    }
  | {
      type: 'subscriber-track';
      descriptor: ProSystemAudioSfuPublicationDescriptor;
      track: MediaStreamTrack;
      receiver: RTCRtpReceiver;
    };

type ProSystemAudioSfuEventListener = (event: ProSystemAudioSfuEvent) => void;

/** Explicit test seam for asserting the transport's emitted event contract. */
export type ProSystemAudioSfuEventForTests = ProSystemAudioSfuEvent;

interface RealtimeSessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

interface RealtimeTrack {
  location?: 'local' | 'remote';
  sessionId?: string;
  trackName?: string;
  mid?: string;
  errorCode?: string;
  errorDescription?: string;
}

interface RealtimeResponse {
  errorCode?: string;
  errorDescription?: string;
  sessionId?: string;
  sessionOwnerToken?: string;
  sessionDescription?: RealtimeSessionDescription;
  tracks?: RealtimeTrack[];
}

interface TurnConfigResponse {
  provider?: unknown;
  iceServers?: unknown;
}

interface OwnedRealtimeTracks {
  sessionId: string;
  sessionOwnerToken: string;
  mids: string[];
}

class ProSystemAudioSfuSupersededError extends Error {
  constructor() {
    super('PRO system-audio SFU operation was superseded');
    this.name = 'AbortError';
  }
}

const eventListeners = new Set<ProSystemAudioSfuEventListener>();

let publisherEpoch = 0;
let publisherPc: RTCPeerConnection | null = null;
let publisherOwnedTracks: OwnedRealtimeTracks | null = null;
let publisherDescriptor: ProSystemAudioSfuPublicationDescriptor | null = null;
let publisherPromise: Promise<ProSystemAudioSfuPublicationDescriptor> | null = null;
let publisherAbortController: AbortController | null = null;

let subscriberEpoch = 0;
let subscriberPc: RTCPeerConnection | null = null;
let subscriberOwnedTracks: OwnedRealtimeTracks | null = null;
let subscriberDescriptor: ProSystemAudioSfuPublicationDescriptor | null = null;
let subscriberPromise: Promise<void> | null = null;
let subscriberAbortController: AbortController | null = null;
let subscriberKey: string | null = null;

export function onProSystemAudioSfuEvent(listener: ProSystemAudioSfuEventListener): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

function emitEvent(event: ProSystemAudioSfuEvent): void {
  for (const listener of [...eventListeners]) {
    try {
      listener(event);
    } catch (error) {
      log.debug('[ProSysAudioSFU] Event listener failed:', error);
    }
  }
}

function getRealtimeEndpoints(): string[] {
  return localFirstApiEndpoints('/api/cloudflare-realtime');
}

function getTurnConfigEndpoints(): string[] {
  return localFirstApiEndpoints('/api/get-turn-config');
}

function normalizeIceServerUrls(value: unknown): string[] {
  const urls = Array.isArray(value) ? value : [value];
  return urls.filter(
    (url): url is string => typeof url === 'string' && /^(stun|turn|turns):/i.test(url),
  );
}

function normalizeRemoteIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) return [];
  const result: RTCIceServer[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    const urls = normalizeIceServerUrls(candidate.urls);
    if (urls.length === 0) continue;
    const server: RTCIceServer = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof candidate.username === 'string' && candidate.username) {
      server.username = candidate.username;
    }
    if (typeof candidate.credential === 'string' && candidate.credential) {
      server.credential = candidate.credential;
    }
    result.push(server);
  }
  return result;
}

async function loadSfuRtcConfig(signal?: AbortSignal): Promise<RTCConfiguration> {
  const iceServers = [...BASE_SFU_ICE_SERVERS];
  for (const endpoint of getTurnConfigEndpoints()) {
    try {
      const body = await withRequestDeadline(
        async (requestSignal) => {
          const response = await fetchWithCapability(endpoint, 'turn', { signal: requestSignal });
          if (!response.ok) {
            await cancelResponseBody(response);
            return null;
          }
          return (await readBoundedJsonResponse(
            response,
            SFU_CONTROL_RESPONSE_MAX_BYTES,
            requestSignal,
          )) as TurnConfigResponse;
        },
        {
          signal,
          timeoutMs: SFU_CONTROL_REQUEST_TIMEOUT_MS,
          timeoutReason: 'PRO_SFU_TURN_CONFIG_TIMEOUT',
        },
      );
      if (!body) continue;
      if (body.provider !== 'cloudflare') continue;
      const remote = normalizeRemoteIceServers(body.iceServers);
      if (remote.length === 0) continue;
      iceServers.push(...remote);
      break;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (isCapabilityChallengeCancelled(error)) throw error;
      // Cloudflare's public STUN entry is enough for the initial attempt.
    }
  }
  return { iceServers, bundlePolicy: 'max-bundle' };
}

export function beginProSystemAudioSfuPublisherPreflight(): ProSystemAudioSfuPublisherPreflight {
  const handle = Object.freeze({
    kind: 'pro-system-audio-sfu-publisher-preflight' as const,
  });
  const controller = new AbortController();
  // Convert rejection to data immediately: a direct success may cancel and
  // discard this handle without ever awaiting the preflight.
  const result = loadSfuRtcConfig(controller.signal).then(
    (rtcConfig): PublisherPreflightResult => ({ ok: true, rtcConfig }),
    (error): PublisherPreflightResult => ({ ok: false, error }),
  );
  publisherPreflights.set(handle, { controller, result });
  return handle;
}

export function cancelProSystemAudioSfuPublisherPreflight(
  handle: ProSystemAudioSfuPublisherPreflight | null | undefined,
): void {
  if (!handle) return;
  const state = publisherPreflights.get(handle);
  if (!state) return;
  publisherPreflights.delete(handle);
  state.controller.abort(new ProSystemAudioSfuSupersededError());
}

async function consumePublisherPreflight(
  handle: ProSystemAudioSfuPublisherPreflight,
  signal: AbortSignal,
): Promise<RTCConfiguration> {
  const state = publisherPreflights.get(handle);
  if (!state) throw new ProSystemAudioSfuSupersededError();
  publisherPreflights.delete(handle);
  const abort = () => state.controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await state.result;
    if (result.ok) return result.rtcConfig;
    throw result.error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function callRealtime(
  action: string,
  options: {
    sessionId?: string;
    sessionOwnerToken?: string;
    payload?: Record<string, unknown>;
    correlationId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<RealtimeResponse> {
  let lastError: unknown = null;
  for (const endpoint of getRealtimeEndpoints()) {
    try {
      const { response, body } = await withRequestDeadline(
        async (requestSignal) => {
          const response = await fetchWithCapability(endpoint, 'realtime', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action,
              sessionId: options.sessionId,
              sessionOwnerToken: options.sessionOwnerToken,
              correlationId: options.correlationId,
              payload: options.payload || {},
            }),
            signal: requestSignal,
          });
          const body = (await readBoundedJsonResponse(
            response,
            SFU_CONTROL_RESPONSE_MAX_BYTES,
            requestSignal,
          )) as RealtimeResponse;
          return { response, body };
        },
        {
          signal: options.signal,
          timeoutMs: SFU_CONTROL_REQUEST_TIMEOUT_MS,
          timeoutReason: 'PRO_SFU_REALTIME_REQUEST_TIMEOUT',
        },
      );
      if (response.ok) return body;
      lastError = new Error(
        body.errorDescription ||
          (typeof (body as { error?: unknown }).error === 'string'
            ? String((body as { error: string }).error)
            : `HTTP ${response.status}`),
      );
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (isCapabilityChallengeCancelled(error)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || 'PRO system-audio SFU request failed'));
}

function assertRealtimeOk(response: RealtimeResponse, expectedTrackCount = 0): void {
  if (response.errorCode) {
    throw new Error(
      `${response.errorCode}: ${response.errorDescription || 'Cloudflare Realtime request failed'}`,
    );
  }
  if (expectedTrackCount === 0) return;
  if ((response.tracks || []).length < expectedTrackCount) {
    throw new Error('Cloudflare Realtime returned fewer tracks than requested');
  }
  const failed = response.tracks?.find((track) => track.errorCode);
  if (failed) {
    throw new Error(
      `${failed.errorCode}: ${failed.errorDescription || 'Cloudflare Realtime track failed'}`,
    );
  }
}

function sessionDescriptionFromInit(
  description: RTCSessionDescriptionInit,
): RealtimeSessionDescription {
  if (!description?.sdp || (description.type !== 'offer' && description.type !== 'answer')) {
    throw new Error('Missing SDP');
  }
  return { type: description.type, sdp: description.sdp };
}

function publicErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomSuffix(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now());
}

function safeRoomFragment(value?: string): string {
  const normalized = String(value || 'pro-room')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .slice(0, MAX_ROOM_ID_LENGTH);
  return normalized || 'pro-room';
}

function buildCorrelationId(prefix: string, roomId?: string): string {
  return `${prefix}-${safeRoomFragment(roomId)}-${randomSuffix()}`.slice(0, 128);
}

function buildTrackName(roomId?: string): string {
  return `mxqr-pro-system-audio-${safeRoomFragment(roomId)}-stereo-${randomSuffix()}`.slice(
    0,
    MAX_TRACK_NAME_LENGTH,
  );
}

function applyAudioSenderTuning(sender: RTCRtpSender): void {
  const track = sender.track;
  if (!track || track.kind !== 'audio') return;
  try {
    void track
      .applyConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      })
      .catch(() => {});
  } catch {
    /* browser does not expose sender-track constraints */
  }
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings) parameters.encodings = [{}];
    parameters.encodings[0].maxBitrate = SYSTEM_AUDIO_STEREO_MAX_BITRATE;
    void sender.setParameters(parameters).catch(() => {});
  } catch {
    /* optional sender tuning */
  }
}

function validateAudioTrack(track: MediaStreamTrack, label: string): void {
  if (!track || track.kind !== 'audio') throw new TypeError(`${label} must be an audio track`);
  if (track.readyState === 'ended') throw new TypeError(`${label} has already ended`);
}

function normalizeTrackDescriptor(value: unknown): ProSystemAudioSfuTrackDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  const track = value as Record<string, unknown>;
  if (
    typeof track.trackName !== 'string' ||
    track.trackName.length === 0 ||
    track.trackName.length > MAX_TRACK_NAME_LENGTH ||
    (track.mid !== undefined &&
      (typeof track.mid !== 'string' || track.mid.length === 0 || track.mid.length > 64))
  ) {
    return null;
  }
  return Object.freeze({
    trackName: track.trackName,
    ...(typeof track.mid === 'string' ? { mid: track.mid } : {}),
  });
}

/** Parse untrusted persisted/controller state into the public SFU contract. */
function parseProSystemAudioSfuPublicationDescriptor(
  value: unknown,
): ProSystemAudioSfuPublicationDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const track = normalizeTrackDescriptor(candidate.track);
  if (
    candidate.version !== 2 ||
    typeof candidate.sessionId !== 'string' ||
    candidate.sessionId.length === 0 ||
    candidate.sessionId.length > MAX_SESSION_ID_LENGTH ||
    !Number.isSafeInteger(candidate.generation) ||
    Number(candidate.generation) < 0 ||
    typeof candidate.expiresAt !== 'number' ||
    !Number.isFinite(candidate.expiresAt) ||
    candidate.expiresAt <= 0 ||
    !track
  ) {
    return null;
  }
  return Object.freeze({
    version: 2,
    sessionId: candidate.sessionId,
    track,
    generation: Number(candidate.generation),
    expiresAt: candidate.expiresAt,
  });
}

/** Explicit test seam for validating the untrusted descriptor boundary. */
export const parseProSystemAudioSfuPublicationDescriptorForTests =
  parseProSystemAudioSfuPublicationDescriptor;

function requireDescriptor(value: unknown): ProSystemAudioSfuPublicationDescriptor {
  const descriptor = parseProSystemAudioSfuPublicationDescriptor(value);
  if (!descriptor) throw new TypeError('Invalid PRO system-audio SFU publication descriptor');
  return descriptor;
}

function descriptorKey(descriptor: ProSystemAudioSfuPublicationDescriptor): string {
  return `${descriptor.generation}:${descriptor.sessionId}:${descriptor.track.trackName}`;
}

function closePeerConnection(pc: RTCPeerConnection | null): void {
  if (!pc) return;
  try {
    pc.close();
  } catch {
    /* already closed */
  }
}

function closeOwnedTracks(owned: OwnedRealtimeTracks | null, label: string): void {
  if (!owned || owned.mids.length === 0) return;
  const mids = [...new Set(owned.mids.filter(Boolean))];
  if (mids.length === 0) return;
  void callRealtime('tracks-close', {
    sessionId: owned.sessionId,
    sessionOwnerToken: owned.sessionOwnerToken,
    payload: { tracks: mids.map((mid) => ({ mid })), force: true },
  }).catch((error) => log.debug(`[ProSysAudioSFU] ${label}:`, error));
}

function clearPublisherExpiryTimer(): void {
  clearManagedTimer(PUBLISHER_EXPIRY_TIMER);
}

function clearSubscriberExpiryTimer(): void {
  clearManagedTimer(SUBSCRIBER_EXPIRY_TIMER);
}

function schedulePublisherExpiry(descriptor: ProSystemAudioSfuPublicationDescriptor): void {
  clearPublisherExpiryTimer();
  const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, descriptor.expiresAt - Date.now()));
  setManagedTimer(
    PUBLISHER_EXPIRY_TIMER,
    () => {
      if (!publisherDescriptor || descriptorKey(publisherDescriptor) !== descriptorKey(descriptor))
        return;
      if (descriptor.expiresAt > Date.now()) return schedulePublisherExpiry(descriptor);
      stopProSystemAudioSfuPublisher();
    },
    delay,
  );
}

function scheduleSubscriberExpiry(descriptor: ProSystemAudioSfuPublicationDescriptor): void {
  clearSubscriberExpiryTimer();
  const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, descriptor.expiresAt - Date.now()));
  setManagedTimer(
    SUBSCRIBER_EXPIRY_TIMER,
    () => {
      if (
        !subscriberDescriptor ||
        descriptorKey(subscriberDescriptor) !== descriptorKey(descriptor)
      )
        return;
      if (descriptor.expiresAt > Date.now()) return scheduleSubscriberExpiry(descriptor);
      stopProSystemAudioSfuSubscriber();
    },
    delay,
  );
}

function stopPublisherInternal(emitStopped: boolean): void {
  publisherEpoch += 1;
  publisherAbortController?.abort();
  publisherAbortController = null;
  const descriptor = publisherDescriptor;
  const hadState = !!publisherPc || !!publisherOwnedTracks || !!publisherPromise || !!descriptor;
  const pc = publisherPc;
  const owned = publisherOwnedTracks;
  publisherPc = null;
  publisherOwnedTracks = null;
  publisherDescriptor = null;
  publisherPromise = null;
  clearPublisherExpiryTimer();
  closePeerConnection(pc);
  closeOwnedTracks(owned, 'Publisher tracks-close failed');
  if (emitStopped && hadState) {
    emitEvent({ type: 'publisher-state', state: 'stopped', descriptor });
  }
}

function stopSubscriberInternal(emitStopped: boolean): void {
  subscriberEpoch += 1;
  subscriberAbortController?.abort();
  subscriberAbortController = null;
  const descriptor = subscriberDescriptor;
  const hadState = !!subscriberPc || !!subscriberOwnedTracks || !!subscriberPromise || !!descriptor;
  const pc = subscriberPc;
  const owned = subscriberOwnedTracks;
  subscriberPc = null;
  subscriberOwnedTracks = null;
  subscriberDescriptor = null;
  subscriberPromise = null;
  subscriberKey = null;
  clearSubscriberExpiryTimer();
  closePeerConnection(pc);
  closeOwnedTracks(owned, 'Subscriber tracks-close failed');
  if (emitStopped && hadState) {
    emitEvent({ type: 'subscriber-state', state: 'stopped', descriptor });
  }
}

export function stopProSystemAudioSfuPublisher(): void {
  stopPublisherInternal(true);
}

/** Align the publisher safety timer with the authoritative committed lease. */
export function updateProSystemAudioSfuPublisherExpiry(expiresAt: number): void {
  if (!publisherDescriptor) return;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    stopProSystemAudioSfuPublisher();
    return;
  }
  publisherDescriptor = Object.freeze({ ...publisherDescriptor, expiresAt });
  schedulePublisherExpiry(publisherDescriptor);
}

export function stopProSystemAudioSfuSubscriber(): void {
  stopSubscriberInternal(true);
}

export function stopProSystemAudioSfu(): void {
  stopPublisherInternal(true);
  stopSubscriberInternal(true);
}

function ensurePublisherCurrent(epoch: number, pc: RTCPeerConnection): void {
  if (epoch !== publisherEpoch || publisherPc !== pc) {
    throw new ProSystemAudioSfuSupersededError();
  }
}

async function performPublish(
  input: PublishProSystemAudioSfuOptions,
  epoch: number,
  signal: AbortSignal,
  preflight?: ProSystemAudioSfuPublisherPreflight,
): Promise<ProSystemAudioSfuPublicationDescriptor> {
  const rtcConfig = preflight
    ? await consumePublisherPreflight(preflight, signal)
    : await loadSfuRtcConfig(signal);
  if (epoch !== publisherEpoch) throw new ProSystemAudioSfuSupersededError();
  const pc = new RTCPeerConnection(rtcConfig);
  publisherPc = pc;
  pc.addEventListener('connectionstatechange', () => {
    if (publisherPc !== pc || publisherDescriptor === null) return;
    if (pc.connectionState !== 'failed') return;
    const descriptor = publisherDescriptor;
    emitEvent({
      type: 'publisher-state',
      state: 'failed',
      descriptor,
      message: 'PRO system-audio SFU publisher connection failed',
    });
    stopPublisherInternal(false);
  });

  let localOwned: OwnedRealtimeTracks | null = null;
  try {
    const session = await callRealtime('new-session', {
      correlationId: buildCorrelationId('pro-system-audio-publisher', input.roomId),
      signal,
    });
    ensurePublisherCurrent(epoch, pc);
    assertRealtimeOk(session);
    if (!session.sessionId || !session.sessionOwnerToken) {
      throw new Error('Cloudflare Realtime did not return publisher ownership credentials');
    }

    const sourceStream = new MediaStream([input.track]);
    const transceiver = pc.addTransceiver(input.track, {
      direction: 'sendonly',
      streams: [sourceStream],
    });
    applyAudioSenderTuning(transceiver.sender);
    const rawOffer = sessionDescriptionFromInit(await pc.createOffer());
    const offer = { ...rawOffer, sdp: forceStereoSdp(rawOffer.sdp) };
    ensurePublisherCurrent(epoch, pc);
    await pc.setLocalDescription(offer);
    ensurePublisherCurrent(epoch, pc);

    const trackName = buildTrackName(input.roomId);
    const requested: RealtimeTrack[] = [
      { location: 'local', mid: transceiver.mid || '0', trackName },
    ];
    localOwned = {
      sessionId: session.sessionId,
      sessionOwnerToken: session.sessionOwnerToken,
      // The sender mids are enough to close a request whose success response
      // was lost after the edge accepted it.
      mids: requested.map((track) => track.mid || '').filter(Boolean),
    };

    const tracksResponse = await callRealtime('tracks-new', {
      sessionId: session.sessionId,
      sessionOwnerToken: session.sessionOwnerToken,
      payload: { sessionDescription: offer, tracks: requested },
      signal,
    });
    const responseTracks = tracksResponse.tracks || [];
    const track: ProSystemAudioSfuTrackDescriptor = Object.freeze({
      trackName,
      mid:
        responseTracks.find((candidate) => candidate.trackName === trackName)?.mid ||
        transceiver.mid ||
        '0',
    });
    localOwned.mids = track.mid ? [track.mid] : [];
    ensurePublisherCurrent(epoch, pc);
    assertRealtimeOk(tracksResponse, requested.length);
    const answer = tracksResponse.sessionDescription;
    if (!answer || answer.type !== 'answer') {
      throw new Error('Cloudflare Realtime did not return a publisher answer');
    }
    if (!sdpPrefersOpusStereo(answer.sdp)) {
      throw new Error('SFU_STEREO_NOT_NEGOTIATED');
    }
    // Keep Cloudflare's answer authoritative. Only client-generated SDP is
    // munged; rewriting the remote transcript can invalidate negotiation.
    await pc.setRemoteDescription(answer);
    ensurePublisherCurrent(epoch, pc);

    const descriptor: ProSystemAudioSfuPublicationDescriptor = Object.freeze({
      version: 2,
      sessionId: session.sessionId,
      track,
      generation: input.generation,
      expiresAt: input.expiresAt,
    });
    publisherOwnedTracks = localOwned;
    publisherDescriptor = descriptor;
    schedulePublisherExpiry(descriptor);
    log.info(`[ProSysAudioSFU] Published generation ${descriptor.generation}`);
    emitEvent({ type: 'publisher-state', state: 'published', descriptor });
    return descriptor;
  } catch (error) {
    closeOwnedTracks(localOwned, 'Incomplete publisher tracks-close failed');
    if (publisherPc === pc) publisherPc = null;
    closePeerConnection(pc);
    throw error;
  }
}

export function publishProSystemAudioSfu(
  input: PublishProSystemAudioSfuOptions,
  preflight?: ProSystemAudioSfuPublisherPreflight,
): Promise<ProSystemAudioSfuPublicationDescriptor> {
  validateAudioTrack(input.track, 'track');
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new TypeError('generation must be a non-negative safe integer');
  }
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()) {
    throw new TypeError('expiresAt must be a future Unix timestamp in milliseconds');
  }

  stopPublisherInternal(false);
  const epoch = publisherEpoch;
  const abortController = new AbortController();
  publisherAbortController = abortController;
  emitEvent({ type: 'publisher-state', state: 'publishing', descriptor: null });
  const promise = performPublish(input, epoch, abortController.signal, preflight)
    .catch((error) => {
      if (epoch === publisherEpoch && !(error instanceof ProSystemAudioSfuSupersededError)) {
        emitEvent({
          type: 'publisher-state',
          state: 'failed',
          descriptor: null,
          message: publicErrorMessage(error),
        });
        stopPublisherInternal(false);
      }
      throw error;
    })
    .finally(() => {
      if (epoch === publisherEpoch && publisherPromise === promise) {
        publisherPromise = null;
        if (publisherAbortController === abortController) publisherAbortController = null;
      }
    });
  publisherPromise = promise;
  return promise;
}

function ensureSubscriberCurrent(epoch: number, pc: RTCPeerConnection): void {
  if (epoch !== subscriberEpoch || subscriberPc !== pc) {
    throw new ProSystemAudioSfuSupersededError();
  }
}

function setReceiverDelay(receiver: RTCRtpReceiver): void {
  if (receiver.track?.kind !== 'audio') return;
  (receiver as RTCRtpReceiver & { playoutDelayHint?: number }).playoutDelayHint =
    SYSTEM_AUDIO_PLAYOUT_DELAY_S;
}

async function performSubscribe(
  descriptor: ProSystemAudioSfuPublicationDescriptor,
  epoch: number,
  signal: AbortSignal,
): Promise<void> {
  const rtcConfig = await loadSfuRtcConfig(signal);
  if (epoch !== subscriberEpoch) throw new ProSystemAudioSfuSupersededError();
  const pc = new RTCPeerConnection(rtcConfig);
  subscriberPc = pc;
  let disconnected = false;
  pc.addEventListener('connectionstatechange', () => {
    if (subscriberPc !== pc || subscriberDescriptor === null) return;
    if (pc.connectionState === 'disconnected') {
      if (disconnected) return;
      disconnected = true;
      emitEvent({
        type: 'subscriber-state',
        state: 'disconnected',
        descriptor: subscriberDescriptor,
        message: 'PRO system-audio SFU subscriber connection interrupted',
      });
      return;
    }
    if (pc.connectionState === 'connected' && disconnected) {
      disconnected = false;
      emitEvent({
        type: 'subscriber-state',
        state: 'subscribed',
        descriptor: subscriberDescriptor,
      });
      return;
    }
    if (pc.connectionState !== 'failed') return;
    const active = subscriberDescriptor;
    emitEvent({
      type: 'subscriber-state',
      state: 'failed',
      descriptor: active,
      message: 'PRO system-audio SFU subscriber connection failed',
    });
    stopSubscriberInternal(false);
  });

  const emittedTracks = new Set<string>();

  const emitTrack = (track: MediaStreamTrack, receiver: RTCRtpReceiver, mid?: string | null) => {
    if (track.kind !== 'audio' || subscriberPc !== pc) return;
    const key = track.id;
    if (emittedTracks.has(key)) return;
    emittedTracks.add(key);
    setReceiverDelay(receiver);
    emitEvent({ type: 'subscriber-track', descriptor, track, receiver });
    log.info(`[ProSysAudioSFU] Received stereo track (mid=${mid || 'none'})`);
  };

  const emitExistingTracks = () => {
    pc.getTransceivers().forEach((transceiver) => {
      const track = transceiver.receiver.track;
      if (!track || track.kind !== 'audio') return;
      emitTrack(track, transceiver.receiver, transceiver.mid);
    });
  };

  pc.ontrack = (event) => {
    emitTrack(event.track, event.receiver, event.transceiver.mid);
  };

  let localOwned: OwnedRealtimeTracks | null = null;
  try {
    const session = await callRealtime('new-session', {
      correlationId: buildCorrelationId('pro-system-audio-subscriber'),
      signal,
    });
    ensureSubscriberCurrent(epoch, pc);
    assertRealtimeOk(session);
    if (!session.sessionId || !session.sessionOwnerToken) {
      throw new Error('Cloudflare Realtime did not return subscriber ownership credentials');
    }

    const requested: RealtimeTrack[] = [
      {
        location: 'remote',
        sessionId: descriptor.sessionId,
        trackName: descriptor.track.trackName,
      },
    ];
    const tracksResponse = await callRealtime('tracks-new', {
      sessionId: session.sessionId,
      sessionOwnerToken: session.sessionOwnerToken,
      payload: { tracks: requested },
      signal,
    });
    const mids = (tracksResponse.tracks || [])
      .map((track) => track.mid)
      .filter((mid): mid is string => typeof mid === 'string' && mid.length > 0);
    localOwned = {
      sessionId: session.sessionId,
      sessionOwnerToken: session.sessionOwnerToken,
      mids,
    };
    ensureSubscriberCurrent(epoch, pc);
    assertRealtimeOk(tracksResponse, requested.length);
    const offer = tracksResponse.sessionDescription;
    if (!offer || offer.type !== 'offer') {
      throw new Error('Cloudflare Realtime did not return a subscriber offer');
    }
    // Keep Cloudflare's offer authoritative and advertise stereo in the local
    // answer sent back below.
    await pc.setRemoteDescription(offer);
    ensureSubscriberCurrent(epoch, pc);
    emitExistingTracks();
    const rawAnswer = sessionDescriptionFromInit(await pc.createAnswer());
    const answer = { ...rawAnswer, sdp: forceStereoSdp(rawAnswer.sdp) };
    ensureSubscriberCurrent(epoch, pc);
    await pc.setLocalDescription(answer);
    ensureSubscriberCurrent(epoch, pc);
    const renegotiate = await callRealtime('renegotiate', {
      sessionId: session.sessionId,
      sessionOwnerToken: session.sessionOwnerToken,
      payload: { sessionDescription: answer },
      signal,
    });
    ensureSubscriberCurrent(epoch, pc);
    assertRealtimeOk(renegotiate);
    emitExistingTracks();

    subscriberOwnedTracks = localOwned;
    subscriberDescriptor = descriptor;
    scheduleSubscriberExpiry(descriptor);
    emitEvent({ type: 'subscriber-state', state: 'subscribed', descriptor });
    log.info(`[ProSysAudioSFU] Subscribed to generation ${descriptor.generation}`);
  } catch (error) {
    closeOwnedTracks(localOwned, 'Incomplete subscriber tracks-close failed');
    if (subscriberPc === pc) subscriberPc = null;
    closePeerConnection(pc);
    throw error;
  }
}

export function subscribeProSystemAudioSfu(value: unknown): Promise<void> {
  const descriptor = requireDescriptor(value);
  if (descriptor.expiresAt <= Date.now()) {
    throw new TypeError('PRO system-audio SFU publication has expired');
  }
  const nextKey = descriptorKey(descriptor);
  if (subscriberDescriptor) {
    if (descriptor.generation < subscriberDescriptor.generation) {
      throw new TypeError('Stale PRO system-audio SFU publication generation');
    }
    const currentKey = descriptorKey(subscriberDescriptor);
    if (descriptor.generation === subscriberDescriptor.generation && nextKey !== currentKey) {
      throw new TypeError('Conflicting PRO system-audio SFU publication generation');
    }
    if (nextKey === currentKey && subscriberPc) {
      scheduleSubscriberExpiry(descriptor);
      return subscriberPromise || Promise.resolve();
    }
  }
  if (subscriberKey === nextKey && subscriberPromise) return subscriberPromise;

  stopSubscriberInternal(false);
  const epoch = subscriberEpoch;
  const abortController = new AbortController();
  subscriberAbortController = abortController;
  subscriberKey = nextKey;
  subscriberDescriptor = descriptor;
  emitEvent({ type: 'subscriber-state', state: 'subscribing', descriptor });
  const promise = performSubscribe(descriptor, epoch, abortController.signal)
    .catch((error) => {
      if (epoch === subscriberEpoch && !(error instanceof ProSystemAudioSfuSupersededError)) {
        emitEvent({
          type: 'subscriber-state',
          state: 'failed',
          descriptor,
          message: publicErrorMessage(error),
        });
        stopSubscriberInternal(false);
      }
      throw error;
    })
    .finally(() => {
      if (epoch === subscriberEpoch && subscriberPromise === promise) {
        subscriberPromise = null;
        if (subscriberAbortController === abortController) subscriberAbortController = null;
      }
    });
  subscriberPromise = promise;
  return promise;
}
