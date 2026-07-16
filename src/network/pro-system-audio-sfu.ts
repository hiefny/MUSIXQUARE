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

const BASE_SFU_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const SYSTEM_AUDIO_PLAYOUT_DELAY_S = 0.5;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_TRACK_NAME_LENGTH = 160;
const MAX_ROOM_ID_LENGTH = 64;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const PUBLISHER_EXPIRY_TIMER = 'pro-system-audio-sfu:publisher-expiry';
const SUBSCRIBER_EXPIRY_TIMER = 'pro-system-audio-sfu:subscriber-expiry';

type ProSystemAudioSfuChannel = 'L' | 'R';

interface ProSystemAudioSfuTrackDescriptor {
  trackName: string;
  channel: ProSystemAudioSfuChannel;
  mid?: string;
}

/** Safe to persist in PRO room state and broadcast to every participant. */
export interface ProSystemAudioSfuPublicationDescriptor {
  version: 1;
  sessionId: string;
  tracks: ProSystemAudioSfuTrackDescriptor[];
  generation: number;
  expiresAt: number;
}

interface PublishProSystemAudioSfuOptions {
  leftTrack: MediaStreamTrack;
  rightTrack: MediaStreamTrack;
  /** Controller-issued publication generation. Must increase on replacement. */
  generation: number;
  /** Absolute Unix time in milliseconds after which the publication is invalid. */
  expiresAt: number;
  /** Used only to make correlation and track names recognizable in diagnostics. */
  roomId?: string;
}

type ProSystemAudioSfuEvent =
  | {
      type: 'publisher-state';
      state: 'publishing' | 'published' | 'stopped' | 'failed';
      descriptor: ProSystemAudioSfuPublicationDescriptor | null;
      message?: string;
    }
  | {
      type: 'subscriber-state';
      state: 'subscribing' | 'subscribed' | 'stopped' | 'failed';
      descriptor: ProSystemAudioSfuPublicationDescriptor | null;
      message?: string;
    }
  | {
      type: 'subscriber-track';
      descriptor: ProSystemAudioSfuPublicationDescriptor;
      channel: ProSystemAudioSfuChannel;
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

let subscriberEpoch = 0;
let subscriberPc: RTCPeerConnection | null = null;
let subscriberOwnedTracks: OwnedRealtimeTracks | null = null;
let subscriberDescriptor: ProSystemAudioSfuPublicationDescriptor | null = null;
let subscriberPromise: Promise<void> | null = null;
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
  return ['/api/cloudflare-realtime', 'https://musixquare.com/api/cloudflare-realtime'];
}

function getTurnConfigEndpoints(): string[] {
  return ['/api/get-turn-config', 'https://musixquare.com/api/get-turn-config'];
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

async function loadSfuRtcConfig(): Promise<RTCConfiguration> {
  const iceServers = [...BASE_SFU_ICE_SERVERS];
  for (const endpoint of getTurnConfigEndpoints()) {
    try {
      const response = await fetchWithCapability(endpoint, 'turn');
      if (!response.ok) continue;
      const body = (await response.json()) as TurnConfigResponse;
      if (body.provider !== 'cloudflare') continue;
      const remote = normalizeRemoteIceServers(body.iceServers);
      if (remote.length === 0) continue;
      iceServers.push(...remote);
      break;
    } catch (error) {
      if (isCapabilityChallengeCancelled(error)) throw error;
      // Cloudflare's public STUN entry is enough for the initial attempt.
    }
  }
  return { iceServers, bundlePolicy: 'max-bundle' };
}

async function callRealtime(
  action: string,
  options: {
    sessionId?: string;
    sessionOwnerToken?: string;
    payload?: Record<string, unknown>;
    correlationId?: string;
  } = {},
): Promise<RealtimeResponse> {
  let lastError: unknown = null;
  for (const endpoint of getRealtimeEndpoints()) {
    try {
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
      });
      const body = (await response.json().catch(() => ({}))) as RealtimeResponse;
      if (response.ok) return body;
      lastError = new Error(
        body.errorDescription ||
          (typeof (body as { error?: unknown }).error === 'string'
            ? String((body as { error: string }).error)
            : `HTTP ${response.status}`),
      );
      if (response.status === 503) break;
    } catch (error) {
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

function buildTrackName(channel: ProSystemAudioSfuChannel, roomId?: string): string {
  return `mxqr-pro-system-audio-${safeRoomFragment(roomId)}-${channel}-${randomSuffix()}`.slice(
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
    parameters.encodings[0].maxBitrate = 128_000;
    void sender.setParameters(parameters).catch(() => {});
  } catch {
    /* optional sender tuning */
  }
}

function validateAudioTrack(track: MediaStreamTrack, label: string): void {
  if (!track || track.kind !== 'audio') throw new TypeError(`${label} must be an audio track`);
  if (track.readyState === 'ended') throw new TypeError(`${label} has already ended`);
}

function normalizeTrackDescriptors(value: unknown): ProSystemAudioSfuTrackDescriptor[] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const tracks: ProSystemAudioSfuTrackDescriptor[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const track = item as Record<string, unknown>;
    if (
      typeof track.trackName !== 'string' ||
      track.trackName.length === 0 ||
      track.trackName.length > MAX_TRACK_NAME_LENGTH ||
      (track.channel !== 'L' && track.channel !== 'R') ||
      (track.mid !== undefined &&
        (typeof track.mid !== 'string' || track.mid.length === 0 || track.mid.length > 64))
    ) {
      return null;
    }
    tracks.push(
      Object.freeze({
        trackName: track.trackName,
        channel: track.channel,
        ...(typeof track.mid === 'string' ? { mid: track.mid } : {}),
      }),
    );
  }
  if (
    new Set(tracks.map((track) => track.channel)).size !== 2 ||
    new Set(tracks.map((track) => track.trackName)).size !== 2
  ) {
    return null;
  }
  return Object.freeze(tracks) as ProSystemAudioSfuTrackDescriptor[];
}

/** Parse untrusted persisted/controller state into the public SFU contract. */
function parseProSystemAudioSfuPublicationDescriptor(
  value: unknown,
): ProSystemAudioSfuPublicationDescriptor | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const tracks = normalizeTrackDescriptors(candidate.tracks);
  if (
    candidate.version !== 1 ||
    typeof candidate.sessionId !== 'string' ||
    candidate.sessionId.length === 0 ||
    candidate.sessionId.length > MAX_SESSION_ID_LENGTH ||
    !Number.isSafeInteger(candidate.generation) ||
    Number(candidate.generation) < 0 ||
    typeof candidate.expiresAt !== 'number' ||
    !Number.isFinite(candidate.expiresAt) ||
    candidate.expiresAt <= 0 ||
    !tracks
  ) {
    return null;
  }
  return Object.freeze({
    version: 1,
    sessionId: candidate.sessionId,
    tracks,
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
  return `${descriptor.generation}:${descriptor.sessionId}:${descriptor.tracks
    .map((track) => `${track.channel}:${track.trackName}`)
    .join(',')}`;
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
): Promise<ProSystemAudioSfuPublicationDescriptor> {
  const rtcConfig = await loadSfuRtcConfig();
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
    });
    ensurePublisherCurrent(epoch, pc);
    assertRealtimeOk(session);
    if (!session.sessionId || !session.sessionOwnerToken) {
      throw new Error('Cloudflare Realtime did not return publisher ownership credentials');
    }

    const syncedStream = new MediaStream([input.leftTrack, input.rightTrack]);
    const left = pc.addTransceiver(input.leftTrack, {
      direction: 'sendonly',
      streams: [syncedStream],
    });
    const right = pc.addTransceiver(input.rightTrack, {
      direction: 'sendonly',
      streams: [syncedStream],
    });
    applyAudioSenderTuning(left.sender);
    applyAudioSenderTuning(right.sender);
    const offer = sessionDescriptionFromInit(await pc.createOffer());
    ensurePublisherCurrent(epoch, pc);
    await pc.setLocalDescription(offer);
    ensurePublisherCurrent(epoch, pc);

    const leftName = buildTrackName('L', input.roomId);
    const rightName = buildTrackName('R', input.roomId);
    const requested: RealtimeTrack[] = [
      { location: 'local', mid: left.mid || '0', trackName: leftName },
      { location: 'local', mid: right.mid || '1', trackName: rightName },
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
    });
    const responseTracks = tracksResponse.tracks || [];
    const tracks: ProSystemAudioSfuTrackDescriptor[] = Object.freeze([
      Object.freeze({
        trackName: leftName,
        channel: 'L',
        mid: responseTracks.find((track) => track.trackName === leftName)?.mid || left.mid || '0',
      }),
      Object.freeze({
        trackName: rightName,
        channel: 'R',
        mid: responseTracks.find((track) => track.trackName === rightName)?.mid || right.mid || '1',
      }),
    ]) as ProSystemAudioSfuTrackDescriptor[];
    localOwned.mids = tracks.map((track) => track.mid || '').filter(Boolean);
    ensurePublisherCurrent(epoch, pc);
    assertRealtimeOk(tracksResponse, requested.length);
    const answer = tracksResponse.sessionDescription;
    if (!answer || answer.type !== 'answer') {
      throw new Error('Cloudflare Realtime did not return a publisher answer');
    }
    await pc.setRemoteDescription(answer);
    ensurePublisherCurrent(epoch, pc);

    const descriptor: ProSystemAudioSfuPublicationDescriptor = Object.freeze({
      version: 1,
      sessionId: session.sessionId,
      tracks,
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
): Promise<ProSystemAudioSfuPublicationDescriptor> {
  validateAudioTrack(input.leftTrack, 'leftTrack');
  validateAudioTrack(input.rightTrack, 'rightTrack');
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new TypeError('generation must be a non-negative safe integer');
  }
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()) {
    throw new TypeError('expiresAt must be a future Unix timestamp in milliseconds');
  }

  stopPublisherInternal(false);
  const epoch = publisherEpoch;
  emitEvent({ type: 'publisher-state', state: 'publishing', descriptor: null });
  const promise = performPublish(input, epoch)
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
      if (epoch === publisherEpoch && publisherPromise === promise) publisherPromise = null;
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
): Promise<void> {
  const rtcConfig = await loadSfuRtcConfig();
  if (epoch !== subscriberEpoch) throw new ProSystemAudioSfuSupersededError();
  const pc = new RTCPeerConnection(rtcConfig);
  subscriberPc = pc;
  pc.addEventListener('connectionstatechange', () => {
    if (subscriberPc !== pc || subscriberDescriptor === null) return;
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

  const channelByTrackName = new Map(
    descriptor.tracks.map((track) => [track.trackName, track.channel] as const),
  );
  const channelByMid = new Map<string, ProSystemAudioSfuChannel>();
  const fallbackChannels = descriptor.tracks.map((track) => track.channel);
  const emittedTracks = new Set<string>();
  let fallbackIndex = 0;

  const emitTrack = (
    channel: ProSystemAudioSfuChannel | null,
    track: MediaStreamTrack,
    receiver: RTCRtpReceiver,
    mid?: string | null,
  ) => {
    if (!channel || track.kind !== 'audio' || subscriberPc !== pc) return;
    const key = `${channel}:${track.id}`;
    if (emittedTracks.has(key)) return;
    emittedTracks.add(key);
    setReceiverDelay(receiver);
    emitEvent({ type: 'subscriber-track', descriptor, channel, track, receiver });
    log.info(`[ProSysAudioSFU] Received ${channel} track (mid=${mid || 'none'})`);
  };

  const emitExistingTracks = () => {
    pc.getTransceivers().forEach((transceiver, index) => {
      const track = transceiver.receiver.track;
      if (!track || track.kind !== 'audio') return;
      const mid = transceiver.mid;
      emitTrack(
        (mid && channelByMid.get(mid)) || fallbackChannels[index] || null,
        track,
        transceiver.receiver,
        mid,
      );
    });
  };

  pc.ontrack = (event) => {
    const mid = event.transceiver.mid;
    emitTrack(
      (mid && channelByMid.get(mid)) || fallbackChannels[fallbackIndex++] || null,
      event.track,
      event.receiver,
      mid,
    );
  };

  let localOwned: OwnedRealtimeTracks | null = null;
  try {
    const session = await callRealtime('new-session', {
      correlationId: buildCorrelationId('pro-system-audio-subscriber'),
    });
    ensureSubscriberCurrent(epoch, pc);
    assertRealtimeOk(session);
    if (!session.sessionId || !session.sessionOwnerToken) {
      throw new Error('Cloudflare Realtime did not return subscriber ownership credentials');
    }

    const requested: RealtimeTrack[] = descriptor.tracks.map((track) => ({
      location: 'remote',
      sessionId: descriptor.sessionId,
      trackName: track.trackName,
    }));
    const tracksResponse = await callRealtime('tracks-new', {
      sessionId: session.sessionId,
      sessionOwnerToken: session.sessionOwnerToken,
      payload: { tracks: requested },
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
    for (const track of tracksResponse.tracks || []) {
      if (!track.mid || !track.trackName) continue;
      const channel = channelByTrackName.get(track.trackName);
      if (channel) channelByMid.set(track.mid, channel);
    }
    const offer = tracksResponse.sessionDescription;
    if (!offer || offer.type !== 'offer') {
      throw new Error('Cloudflare Realtime did not return a subscriber offer');
    }
    await pc.setRemoteDescription(offer);
    ensureSubscriberCurrent(epoch, pc);
    emitExistingTracks();
    const answer = sessionDescriptionFromInit(await pc.createAnswer());
    ensureSubscriberCurrent(epoch, pc);
    await pc.setLocalDescription(answer);
    ensureSubscriberCurrent(epoch, pc);
    const renegotiate = await callRealtime('renegotiate', {
      sessionId: session.sessionId,
      sessionOwnerToken: session.sessionOwnerToken,
      payload: { sessionDescription: answer },
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
  subscriberKey = nextKey;
  subscriberDescriptor = descriptor;
  emitEvent({ type: 'subscriber-state', state: 'subscribing', descriptor });
  const promise = performSubscribe(descriptor, epoch)
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
      if (epoch === subscriberEpoch && subscriberPromise === promise) subscriberPromise = null;
    });
  subscriberPromise = promise;
  return promise;
}
