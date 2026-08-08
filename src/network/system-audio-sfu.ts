/**
 * Cloudflare Realtime SFU bridge for remote and bounded-overflow system-audio guests.
 *
 * The active transport stays responsible for presence/control. This module only moves the
 * host's L/R system-audio MediaStreamTracks through Cloudflare Realtime. Small
 * LAN rooms keep direct calls; overflow LAN guests and large rooms use SFU.
 */

import { log } from '../core/log.ts';
import { fetchWithCapability, isCapabilityChallengeCancelled } from '../core/capability.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { MSG, SYSTEM_AUDIO_SHARE_LIMIT_MS } from '../core/constants.ts';
import { t } from '../i18n/index.ts';
import { getAudioContext } from '../audio/context.ts';
import { initAudio, getWidener } from '../audio/engine.ts';
import { getStreamL, getStreamR, isSystemAudioActive } from '../audio/system-capture.ts';
import { claimPlaybackOwner, setSystemAudioReceiving } from '../player/ownership.ts';
import { registerHandler } from './protocol.ts';
import { safeSend } from './peer-state.ts';
import {
  awaitTrustedSystemAudioReceptionBoundary,
  cleanupGuestSystemAudio,
} from './system-audio-guest.ts';
import {
  beginSystemAudioShareDelivery,
  claimGuestDirectSystemAudioRoute,
  endSystemAudioShareDelivery,
  freezeGuestSystemAudioSfuRoute,
  getFrozenSystemAudioSfuAudience,
  getGuestSystemAudioShareRoute,
  getSystemAudioShareDeliverySnapshot,
  markLocalSystemAudioSfuCapable,
  resolveSystemAudioPeerDelivery,
  resetGuestSystemAudioShareRoute,
  unmarkLocalSystemAudioSfuCapable,
} from './system-audio-delivery.ts';
import {
  cleanupWebRtcAudioDecoderPrimer,
  getAudioTrackStreamKey,
  primeWebRtcAudioDecoder,
  type WebRtcAudioDecoderPrimer,
} from './webrtc-audio-decoder-primer.ts';
import type { DataConnection, ProtocolMsg } from '../types/index.ts';
import { getRoomContext } from '../rooms/authority.ts';
import {
  cancelResponseBody,
  readBoundedJsonResponse,
  withRequestDeadline,
} from '../core/request-lifetime.ts';
import { localFirstApiEndpoints } from './api-endpoints.ts';

const SYSTEM_AUDIO_PLAYOUT_DELAY_S = 0.5;
const GUEST_SFU_RECEIVE_LIMIT_TIMER = 'system-audio-sfu-guest-limit';
const HOST_SFU_RETRY_TIMER = 'system-audio-sfu-host-retry';
const HOST_SFU_RETRY_DELAY_MS = 2500;
const HOST_SFU_MAX_RETRIES = 1;
const SFU_CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const SFU_CONTROL_RESPONSE_MAX_BYTES = 1024 * 1024;
const BASE_SFU_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

type Channel = 'L' | 'R';

interface RealtimeSessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

interface RealtimeTrack {
  location?: 'local' | 'remote';
  sessionId?: string;
  trackName?: string;
  mid?: string;
  kind?: 'audio' | 'video';
  errorCode?: string;
  errorDescription?: string;
}

interface RealtimeResponse {
  errorCode?: string;
  errorDescription?: string;
  sessionId?: string;
  sessionOwnerToken?: string;
  sessionDescription?: RealtimeSessionDescription;
  requiresImmediateRenegotiation?: boolean;
  tracks?: RealtimeTrack[];
}

interface TurnConfigResponse {
  provider?: unknown;
  iceServers?: unknown;
}

interface SfuReadyTrack {
  trackName: string;
  channel: Channel;
  mid?: string;
}

interface SfuReadyPayload {
  version: 1;
  audience: 'remote' | 'all';
  sessionId: string;
  tracks: SfuReadyTrack[];
}

interface HostPublication {
  sessionId: string;
  tracks: SfuReadyTrack[];
}

let hostPc: RTCPeerConnection | null = null;
let hostSessionId: string | null = null;
// Edge-issued ownership capabilities stay module-local. HostPublication and
// SYSTEM_AUDIO_SFU_READY intentionally expose only the public subscription
// coordinates, so a remote guest cannot mutate the host's SFU session.
let hostSessionOwnerToken: string | null = null;
let hostPublishedTracks: SfuReadyTrack[] = [];
let hostPublishPromise: Promise<HostPublication | null> | null = null;
let hostPublishAbortController: AbortController | null = null;
let hostSfuUnavailable = false;
let hostPublishEpoch = 0;
let hostRetryCount = 0;
let hostRetryPending = false;

let guestPc: RTCPeerConnection | null = null;
let guestSessionId: string | null = null;
let guestSessionOwnerToken: string | null = null;
let guestSubscriptionKey: string | null = null;
let guestConnectPromise: Promise<void> | null = null;
let guestConnectAbortController: AbortController | null = null;
let guestPendingReadyPayload: SfuReadyPayload | null = null;
let guestSubscribedTrackMids: string[] = [];
let guestSubscriptionEpoch = 0;
let guestSourceL: MediaStreamAudioSourceNode | null = null;
let guestSourceR: MediaStreamAudioSourceNode | null = null;
let guestMerger: ChannelMergerNode | null = null;
let guestReceiving = false;
let guestAllowsLocalAudience = false;
let guestLimitTimerActive = false;
let guestLimitBlockedHostConn: DataConnection | null = null;
const guestDecoderPrimers = new Map<Channel, WebRtcAudioDecoderPrimer>();

export function getSystemAudioSfuDebugSnapshot() {
  return {
    host: {
      pcState: hostPc
        ? {
            connectionState: hostPc.connectionState,
            iceConnectionState: hostPc.iceConnectionState,
            signalingState: hostPc.signalingState,
          }
        : null,
      sessionId: hostSessionId,
      publishedTracks: hostPublishedTracks,
      publishInFlight: !!hostPublishPromise,
      unavailable: hostSfuUnavailable,
      publishEpoch: hostPublishEpoch,
      retryCount: hostRetryCount,
      retryPending: hostRetryPending,
      delivery: getSystemAudioShareDeliverySnapshot(),
    },
    guest: {
      pcState: guestPc
        ? {
            connectionState: guestPc.connectionState,
            iceConnectionState: guestPc.iceConnectionState,
            signalingState: guestPc.signalingState,
          }
        : null,
      sessionId: guestSessionId,
      subscriptionKey: guestSubscriptionKey,
      subscribedTrackCount: guestSubscribedTrackMids.length,
      connectInFlight: !!guestConnectPromise,
      sourceL: !!guestSourceL,
      sourceR: !!guestSourceR,
      merger: !!guestMerger,
      receiving: guestReceiving,
      allowsLocalAudience: guestAllowsLocalAudience,
      limitTimerActive: guestLimitTimerActive,
      limitBlocked: !!guestLimitBlockedHostConn,
      shareRoute: getGuestSystemAudioShareRoute(),
      directRouteFrozen: getGuestSystemAudioShareRoute() === 'direct',
      decoderPrimerCount: guestDecoderPrimers.size,
    },
    peerConnections: [
      ...(hostPc ? [{ label: 'sfu:host', pc: hostPc }] : []),
      ...(guestPc ? [{ label: 'sfu:guest', pc: guestPc }] : []),
    ],
  };
}

function shouldUseRealtimeSfu(): boolean {
  return true;
}

function buildCorrelationId(prefix: string): string {
  const room = getState('network.sessionCode') || getState('network.lastJoinCode') || 'session';
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now());
  return `${prefix}-${room}-${id}`.slice(0, 128);
}

function buildTrackName(channel: Channel): string {
  const room = getState('network.sessionCode') || 'session';
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now());
  return `mxqr-system-audio-${room}-${channel}-${id}`.slice(0, 160);
}

function cleanupGuestDecoderPrimer(channel: Channel): void {
  cleanupWebRtcAudioDecoderPrimer(guestDecoderPrimers.get(channel) ?? null);
  guestDecoderPrimers.delete(channel);
}

function cleanupGuestDecoderPrimers(): void {
  cleanupGuestDecoderPrimer('L');
  cleanupGuestDecoderPrimer('R');
}

function primeWindowsSfuAudioDecoder(channel: Channel, track: MediaStreamTrack): void {
  const primer = primeWebRtcAudioDecoder(
    guestDecoderPrimers.get(channel) ?? null,
    [track],
    getAudioTrackStreamKey(`sfu:${channel}`, [track]),
    channel,
    '[SysAudioSFU]',
  );

  if (primer) guestDecoderPrimers.set(channel, primer);
  else guestDecoderPrimers.delete(channel);
}

function clearGuestLimitTimer(): void {
  clearManagedTimer(GUEST_SFU_RECEIVE_LIMIT_TIMER);
  guestLimitTimerActive = false;
}

function startGuestLimitTimer(): void {
  if (guestLimitTimerActive) return;
  guestLimitTimerActive = true;
  setManagedTimer(
    GUEST_SFU_RECEIVE_LIMIT_TIMER,
    () => {
      guestLimitTimerActive = false;
      guestLimitBlockedHostConn = getState('network.hostConn');
      log.info('[SysAudioSFU] Guest receive limit reached; pausing SFU until rejoin');
      bus.emit('ui:show-toast', t('system_audio.remote_receive_limit'));
      cleanupGuestSfu();
    },
    SYSTEM_AUDIO_SHARE_LIMIT_MS,
  );
}

function isGuestLimitedForHost(hostConn: DataConnection | null): boolean {
  if (!guestLimitBlockedHostConn) return false;
  if (hostConn === guestLimitBlockedHostConn) return true;
  guestLimitBlockedHostConn = null;
  return false;
}

function getRealtimeEndpoints(): string[] {
  return localFirstApiEndpoints('/api/cloudflare-realtime');
}

function getTurnConfigEndpoints(): string[] {
  return localFirstApiEndpoints('/api/get-turn-config');
}

function normalizeIceServerUrls(value: unknown): string[] {
  const urls = Array.isArray(value) ? value : [value];
  return urls.filter((url): url is string => {
    return typeof url === 'string' && /^(stun|turn|turns):/i.test(url);
  });
}

function normalizeRemoteIceServers(value: unknown): RTCIceServer[] {
  if (!Array.isArray(value)) return [];

  const result: RTCIceServer[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;

    const server = item as Record<string, unknown>;
    const urls = normalizeIceServerUrls(server.urls);
    if (urls.length === 0) continue;

    const iceServer: RTCIceServer = {
      urls: urls.length === 1 ? urls[0] : urls,
    };
    if (typeof server.username === 'string' && server.username) {
      iceServer.username = server.username;
    }
    if (typeof server.credential === 'string' && server.credential) {
      iceServer.credential = server.credential;
    }

    result.push(iceServer);
  }

  return result;
}

async function loadSfuRtcConfig(signal?: AbortSignal): Promise<RTCConfiguration> {
  const iceServers = [...BASE_SFU_ICE_SERVERS];

  for (const url of getTurnConfigEndpoints()) {
    try {
      const payload = await withRequestDeadline(
        async (requestSignal) => {
          const response = await fetchWithCapability(url, 'turn', { signal: requestSignal });
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
          timeoutReason: 'SFU_TURN_CONFIG_TIMEOUT',
        },
      );
      if (!payload) continue;
      if (payload.provider !== 'cloudflare') continue;

      const cloudflareIceServers = normalizeRemoteIceServers(payload.iceServers);
      if (cloudflareIceServers.length === 0) continue;

      iceServers.push(...cloudflareIceServers);
      break;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      // User-initiated Turnstile cancel must propagate; otherwise the next
      // capability-protected fetch in the same flow re-prompts the widget.
      if (isCapabilityChallengeCancelled(error)) throw error;
      /* SFU can still try direct Cloudflare STUN */
    }
  }

  return {
    iceServers,
    bundlePolicy: 'max-bundle',
  };
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

  for (const url of getRealtimeEndpoints()) {
    try {
      const result = await withRequestDeadline(
        async (requestSignal) => {
          const response = await fetchWithCapability(url, 'realtime', {
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
          const payload = (await readBoundedJsonResponse(
            response,
            SFU_CONTROL_RESPONSE_MAX_BYTES,
            requestSignal,
          )) as RealtimeResponse;
          return { response, payload };
        },
        {
          signal: options.signal,
          timeoutMs: SFU_CONTROL_REQUEST_TIMEOUT_MS,
          timeoutReason: 'SFU_REALTIME_REQUEST_TIMEOUT',
        },
      );
      const { response, payload } = result;
      if (response.ok) return payload;

      const message =
        typeof payload.errorDescription === 'string'
          ? payload.errorDescription
          : typeof (payload as { error?: unknown }).error === 'string'
            ? String((payload as { error: string }).error)
            : `HTTP ${response.status}`;
      lastError = new Error(message);
      if (response.status === 503) break;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      // User-initiated Turnstile cancel must propagate; otherwise the retry
      // loop re-mints capability and re-prompts the widget.
      if (isCapabilityChallengeCancelled(error)) throw error;
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || 'SFU request failed'));
}

function assertRealtimeOk(payload: RealtimeResponse, trackCount = 0): void {
  if (payload.errorCode) {
    throw new Error(`${payload.errorCode}: ${payload.errorDescription || 'Realtime API failed'}`);
  }

  if (trackCount > 0) {
    const tracks = payload.tracks || [];
    if (tracks.length < trackCount) {
      throw new Error('Realtime API returned fewer tracks than requested');
    }
    const failedTrack = tracks.find((track) => track.errorCode);
    if (failedTrack) {
      throw new Error(
        `${failedTrack.errorCode}: ${failedTrack.errorDescription || 'Realtime track failed'}`,
      );
    }
  }
}

function sessionDescriptionFromInit(desc: RTCSessionDescriptionInit): RealtimeSessionDescription {
  if (!desc || !desc.sdp || (desc.type !== 'offer' && desc.type !== 'answer')) {
    throw new Error('Missing SDP');
  }
  return { type: desc.type, sdp: desc.sdp };
}

function applyAudioSenderTuning(sender: RTCRtpSender): void {
  const track = sender.track;
  if (!track || track.kind !== 'audio') return;

  try {
    track
      .applyConstraints({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      })
      .catch(() => {
        /* noop */
      });
  } catch {
    /* noop */
  }

  try {
    const params = sender.getParameters();
    if (!params.encodings) params.encodings = [{}];
    params.encodings[0].maxBitrate = 128000;
    sender.setParameters(params).catch(() => {
      /* noop */
    });
  } catch {
    /* noop */
  }
}

function makeReadyMessage(
  publication: HostPublication,
  audience: 'remote' | 'all',
): ProtocolMsg<typeof MSG.SYSTEM_AUDIO_SFU_READY> {
  return {
    type: MSG.SYSTEM_AUDIO_SFU_READY,
    version: 1,
    audience,
    sessionId: publication.sessionId,
    tracks: publication.tracks,
  };
}

function getSfuAudienceForPeer(peerId: string): 'remote' | 'all' | null {
  const delivery = getSystemAudioShareDeliverySnapshot();
  if (delivery.fallbackDirectPeerIds.includes(peerId)) return null;
  const peer = getState('network.connectedPeers').find((p) => p.id === peerId);
  if (!peer || resolveSystemAudioPeerDelivery(peer) !== 'sfu') return null;
  return getFrozenSystemAudioSfuAudience(peerId);
}

function getSfuHostPeers(): Array<{
  id: string;
  conn: DataConnection;
  audience: 'remote' | 'all';
}> {
  const result: Array<{ id: string; conn: DataConnection; audience: 'remote' | 'all' }> = [];
  for (const peer of getState('network.connectedPeers')) {
    const audience = getSfuAudienceForPeer(peer.id);
    if (!audience || !peer.conn?.open) continue;
    result.push({ id: peer.id, conn: peer.conn, audience });
  }
  return result;
}

function hasSfuHostPeers(): boolean {
  return getSfuHostPeers().length > 0;
}

function hasLocalSfuHostPeers(): boolean {
  return getSfuHostPeers().some((peer) => peer.audience === 'all');
}

function broadcastSfuReady(publication: HostPublication): void {
  for (const peer of getSfuHostPeers()) {
    safeSend(peer.conn, makeReadyMessage(publication, peer.audience));
  }
}

function broadcastSfuReadyToLocalPeers(publication: HostPublication): void {
  for (const peer of getSfuHostPeers()) {
    if (peer.audience === 'all') {
      safeSend(peer.conn, makeReadyMessage(publication, peer.audience));
    }
  }
}

function stopPendingSfuPeers(): void {
  for (const peer of getSfuHostPeers()) {
    safeSend(peer.conn, { type: MSG.SYSTEM_AUDIO_STOP });
  }
}

function sendSfuReadyToPeer(peerId: string, publication: HostPublication): void {
  const audience = getSfuAudienceForPeer(peerId);
  if (!audience) return;
  const peer = getState('network.connectedPeers').find((p) => p.id === peerId);
  if (!peer) return;
  safeSend(peer.conn, makeReadyMessage(publication, audience));
}

function closeOwnedRealtimeTracks(
  sessionId: string | null,
  sessionOwnerToken: string | null,
  mids: readonly (string | undefined)[],
  failureLabel: string,
): void {
  const uniqueMids = [...new Set(mids.filter((mid): mid is string => !!mid))];
  if (!sessionId || !sessionOwnerToken || uniqueMids.length === 0) return;
  callRealtime('tracks-close', {
    sessionId,
    sessionOwnerToken,
    payload: {
      tracks: uniqueMids.map((mid) => ({ mid })),
      force: true,
    },
  }).catch((error) => log.debug(`[SysAudioSFU] ${failureLabel}:`, error));
}

async function publishHostTracks(
  publishEpoch: number,
  signal: AbortSignal,
): Promise<HostPublication | null> {
  const streamL = getStreamL();
  const streamR = getStreamR();
  const trackL = streamL?.getAudioTracks()[0];
  const trackR = streamR?.getAudioTracks()[0];
  if (!trackL || !trackR) return null;

  const pc = new RTCPeerConnection(await loadSfuRtcConfig(signal));
  if (publishEpoch !== hostPublishEpoch) {
    // Superseded while the RTC config was loading (share stopped/restarted —
    // cleanupHostSfu bumped the epoch): adopting this pc into the module slot
    // would hand a foreign pc to the successor's cleanup. Discard quietly.
    pc.close();
    return null;
  }
  hostPc = pc;
  pc.addEventListener('connectionstatechange', () => {
    log.info(`[SysAudioSFU] Host SFU connection: ${pc.connectionState}`);
    // A runtime 'failed' state is terminal. Mirror the publish-time throw path:
    // mark SFU unavailable and use the share's bounded failure policy,
    // and clear the stale publication so late joiners stop getting a dead
    // session. Setting hostSfuUnavailable (NOT auto-republish) is what prevents
    // a re-subscribe storm under a persistent fault — ensureHostPublication
    // gates on it. The hostPc===pc guard keeps a superseded attempt's late
    // failure from poisoning a successor publish (the listener captures the
    // local pc const). Only 'failed' is terminal: 'closed' is reached solely via
    // our own cleanupHostSfu (which nulls hostPc first), so it never matches.
    if (pc.connectionState === 'failed' && hostPc === pc) {
      log.warn('[SysAudioSFU] Host SFU connection failed at runtime');
      handleCurrentHostSfuFailure('HOST_SFU_CONNECTION_FAILED');
    }
  });

  const session = await callRealtime('new-session', {
    correlationId: buildCorrelationId('host-system-audio'),
    signal,
  });
  assertRealtimeOk(session);
  if (!session.sessionId) throw new Error('Realtime API did not return a sessionId');
  if (!session.sessionOwnerToken) {
    throw new Error('Realtime API did not return a session owner capability');
  }
  const sessionOwnerToken = session.sessionOwnerToken;

  const syncedStream = new MediaStream([trackL, trackR]);
  const txL = pc.addTransceiver(trackL, {
    direction: 'sendonly',
    streams: [syncedStream],
  });
  const txR = pc.addTransceiver(trackR, {
    direction: 'sendonly',
    streams: [syncedStream],
  });
  applyAudioSenderTuning(txL.sender);
  applyAudioSenderTuning(txR.sender);

  const offer = await pc.createOffer();
  const offerDescription = sessionDescriptionFromInit(offer);
  await pc.setLocalDescription(offerDescription);

  const trackNameL = buildTrackName('L');
  const trackNameR = buildTrackName('R');
  const requestedTracks: RealtimeTrack[] = [
    { location: 'local', mid: txL.mid || '0', trackName: trackNameL },
    { location: 'local', mid: txR.mid || '1', trackName: trackNameR },
  ];

  let tracksResponse: RealtimeResponse;
  try {
    tracksResponse = await callRealtime('tracks-new', {
      sessionId: session.sessionId,
      sessionOwnerToken,
      payload: {
        sessionDescription: offerDescription,
        tracks: requestedTracks,
      },
      signal,
    });
  } catch (error) {
    // The edge response can be lost after Cloudflare accepted the tracks. The
    // sender mids were part of that request, so they are sufficient for a
    // best-effort close instead of waiting for inactive-track GC.
    closeOwnedRealtimeTracks(
      session.sessionId,
      sessionOwnerToken,
      requestedTracks.map((track) => track.mid),
      'Failed publish tracks-close failed',
    );
    throw error;
  }

  const responseTracks = tracksResponse.tracks || [];
  const publishedTracks: SfuReadyTrack[] = [
    {
      trackName: trackNameL,
      channel: 'L',
      mid: responseTracks.find((track) => track.trackName === trackNameL)?.mid || txL.mid || '0',
    },
    {
      trackName: trackNameR,
      channel: 'R',
      mid: responseTracks.find((track) => track.trackName === trackNameR)?.mid || txR.mid || '1',
    },
  ];

  try {
    assertRealtimeOk(tracksResponse, requestedTracks.length);
    const answer = tracksResponse.sessionDescription;
    if (!answer || answer.type !== 'answer') {
      throw new Error('Realtime API did not return an answer');
    }
    await pc.setRemoteDescription(answer);
  } catch (error) {
    closeOwnedRealtimeTracks(
      session.sessionId,
      sessionOwnerToken,
      publishedTracks.map((track) => track.mid),
      'Failed publish tracks-close failed',
    );
    throw error;
  }

  if (publishEpoch !== hostPublishEpoch) {
    // Superseded mid-publish (the Realtime calls take seconds; the share may
    // have been stopped or restarted meanwhile). Undo OUR server session
    // directly instead of via cleanupHostSfu — the module slots may already
    // belong to a successor publish — and commit nothing.
    try {
      pc.close();
    } catch {
      /* already closed by the supersession cleanup */
    }
    if (hostPc === pc) hostPc = null;
    closeOwnedRealtimeTracks(
      session.sessionId,
      sessionOwnerToken,
      publishedTracks.map((track) => track.mid),
      'Stale publish tracks-close failed',
    );
    return null;
  }

  hostSessionId = session.sessionId;
  hostSessionOwnerToken = sessionOwnerToken;
  hostPublishedTracks = publishedTracks;
  log.info(`[SysAudioSFU] Published system audio to Cloudflare SFU (${hostSessionId})`);
  return { sessionId: hostSessionId, tracks: publishedTracks };
}

async function ensureHostPublication(): Promise<HostPublication | null> {
  if (!hasSfuHostPeers()) {
    if (hostSessionId || hostPublishPromise) {
      log.info('[SysAudioSFU] No SFU peers remain; closing host SFU publication');
      cleanupHostSfu();
    }
    return null;
  }
  if (hostSfuUnavailable) return null;
  if (hostSessionId && hostPublishedTracks.length > 0) {
    return { sessionId: hostSessionId, tracks: hostPublishedTracks };
  }
  if (hostPublishPromise) return hostPublishPromise;

  const publishEpoch = ++hostPublishEpoch;
  const abortController = new AbortController();
  hostPublishAbortController = abortController;
  hostPublishPromise = publishHostTracks(publishEpoch, abortController.signal)
    .then((publication) => {
      // publishHostTracks re-checks the epoch before committing module state
      // and undoes its own server session when superseded, so a null result
      // needs no cleanup here.
      if (!publication) return null;
      if (publishEpoch !== hostPublishEpoch) return null; // belt — never adopt a stale publication
      if (!hasSfuHostPeers()) {
        // Same epoch: the module slots hold THIS publication, so the full
        // cleanup (server tracks-close included) is operating on our own state.
        cleanupHostSfu();
        return null;
      }
      return publication;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (publishEpoch !== hostPublishEpoch) {
        // A late failure from a publish the world already moved past
        // (share stopped/restarted — cleanupHostSfu bumped the epoch) must
        // not poison hostSfuUnavailable for the next share, must not emit a
        // stale fallback, and must not run cleanupHostSfu against module
        // slots that may now belong to a successor. The supersession's own
        // cleanup already closed this attempt's pc.
        log.debug('[SysAudioSFU] Stale host publish failed after supersession (ignored):', message);
        return null;
      }
      if (message.includes('REALTIME_SFU_UNAVAILABLE')) {
        log.info('[SysAudioSFU] Cloudflare Realtime SFU env not configured');
      } else {
        log.warn('[SysAudioSFU] Host publish failed:', error);
      }
      handleCurrentHostSfuFailure(message);
      return null;
    })
    .finally(() => {
      // Only the in-flight owner may clear the memo: a stale finally would
      // null a SUCCESSOR's promise and let a duplicate publish race it.
      if (publishEpoch === hostPublishEpoch) {
        hostPublishPromise = null;
        if (hostPublishAbortController === abortController) hostPublishAbortController = null;
      }
    });

  return hostPublishPromise;
}

function runBoundedHostRetry(localOnly: boolean): void {
  if (!isSystemAudioActive() || getState('network.appRole') !== 'host') return;
  if (!hasSfuHostPeers()) return;
  hostSfuUnavailable = false;
  ensureHostPublication()
    .then((publication) => {
      if (!publication) return;
      if (localOnly) broadcastSfuReadyToLocalPeers(publication);
      else broadcastSfuReady(publication);
    })
    .catch((error) => log.warn('[SysAudioSFU] Bounded host retry failed:', error));
}

function beginBoundedHostRetry(delayMs: number, localOnly = false): boolean {
  if (
    hostRetryCount >= HOST_SFU_MAX_RETRIES ||
    !isSystemAudioActive() ||
    getState('network.appRole') !== 'host' ||
    !hasLocalSfuHostPeers()
  ) {
    return false;
  }

  hostRetryCount += 1;
  if (delayMs <= 0) {
    hostRetryPending = false;
    runBoundedHostRetry(localOnly);
    return true;
  }

  hostRetryPending = true;
  setManagedTimer(
    HOST_SFU_RETRY_TIMER,
    () => {
      hostRetryPending = false;
      runBoundedHostRetry(localOnly);
    },
    delayMs,
  );
  return true;
}

function handleCurrentHostSfuFailure(reason: string): void {
  if (hostSfuUnavailable) return;

  const hadLocalSfuTargets = hasLocalSfuHostPeers();
  hostSfuUnavailable = true;
  bus.emit('system-audio:sfu-fallback', reason);
  cleanupHostSfu({ resetFailureState: false });

  if (hadLocalSfuTargets && beginBoundedHostRetry(HOST_SFU_RETRY_DELAY_MS)) return;

  // The room-wide START was already delivered before SFU setup. Once the one
  // bounded retry is exhausted, explicitly release every participant still
  // waiting on SFU. Remote peers reserved for the bounded P2P fallback are
  // excluded by getSfuAudienceForPeer, so their live direct calls continue.
  stopPendingSfuPeers();
}

function cleanupHostSfu(
  options: { closeRemoteTracks?: boolean; resetFailureState?: boolean } = {},
): void {
  const { closeRemoteTracks = true, resetFailureState = true } = options;
  hostPublishEpoch += 1;
  hostPublishAbortController?.abort();
  hostPublishAbortController = null;

  if (closeRemoteTracks && hostSessionId && hostPublishedTracks.length > 0) {
    closeOwnedRealtimeTracks(
      hostSessionId,
      hostSessionOwnerToken,
      hostPublishedTracks.map((track) => track.mid),
      'Host tracks-close failed',
    );
  }

  if (hostPc) {
    hostPc.close();
    hostPc = null;
  }
  hostSessionId = null;
  hostSessionOwnerToken = null;
  hostPublishedTracks = [];
  hostPublishPromise = null;
  if (resetFailureState) {
    hostSfuUnavailable = false;
    hostRetryCount = 0;
    hostRetryPending = false;
    clearManagedTimer(HOST_SFU_RETRY_TIMER);
  }
}

function setReceiverDelay(receiver: RTCRtpReceiver): void {
  if (receiver.track?.kind !== 'audio') return;
  const delayedReceiver = receiver as RTCRtpReceiver & { playoutDelayHint?: number };
  delayedReceiver.playoutDelayHint = SYSTEM_AUDIO_PLAYOUT_DELAY_S;
}

async function connectGuestTrack(
  channel: Channel,
  track: MediaStreamTrack,
  pc: RTCPeerConnection,
): Promise<void> {
  if (guestPc !== pc) return;
  // SYSTEM_AUDIO_START and the SFU descriptor share a reliable data channel,
  // but the remote media plane can become audible while the trusted start is
  // still waiting for the prior file renderer to stop. Join the same
  // physical-owner barrier used by the direct-call adapter.
  const trustedReceptionReady = await awaitTrustedSystemAudioReceptionBoundary(`sfu-${channel}`);
  if (!trustedReceptionReady || guestPc !== pc) {
    if (guestPc === pc) cleanupGuestSfu();
    return;
  }
  await initAudio();
  // Re-check identity after the await: connectGuestTrack is
  // fire-and-forget, so a teardown (cleanupGuestSfu → guestPc=null) or a new
  // subscription (guestPc=newPc) landing during initAudio() would otherwise let
  // this late attach recreate guestMerger + the source and flip
  // guestReceiving=true — resurrecting a torn-down receive (leaked merger,
  // double audio, masked playback mode). The host publisher guards the
  // same window with an epoch; pc-identity is the right key here since each
  // subscription owns exactly one pc. Must run BEFORE any node is created.
  if (guestPc !== pc) {
    log.debug('[SysAudioSFU] Stale guest track attach (pc superseded during init) — skipping');
    return;
  }
  const ctx = getAudioContext();
  const widener = getWidener();
  if (!widener) {
    log.error('[SysAudioSFU] Audio graph not ready');
    return;
  }

  if (ctx.state !== 'running') {
    log.warn(`[SysAudioSFU] AudioContext is ${ctx.state}; user interaction may be required`);
  }

  if (!guestMerger) {
    guestMerger = ctx.createChannelMerger(2);
    guestMerger.connect(widener.input);
  }

  const existing = channel === 'L' ? guestSourceL : guestSourceR;
  if (existing) {
    try {
      existing.disconnect();
    } catch {
      /* noop */
    }
  }

  primeWindowsSfuAudioDecoder(channel, track);
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  source.connect(guestMerger, 0, channel === 'L' ? 0 : 1);
  if (channel === 'L') guestSourceL = source;
  else guestSourceR = source;

  if (!guestReceiving) {
    guestReceiving = true;
    startGuestLimitTimer();
    setSystemAudioReceiving(true);
    claimPlaybackOwner('system-audio');
    bus.emit('visualizer:start');
    log.info('[SysAudioSFU] Remote system audio connected through Cloudflare SFU');
  }
}

function cleanupGuestSfu(updateState = true): void {
  guestSubscriptionEpoch += 1;
  guestConnectAbortController?.abort();
  guestConnectAbortController = null;
  const shouldCleanupGuestReceiveState = guestReceiving && updateState;
  const pc = guestPc;
  const sessionId = guestSessionId;
  const sessionOwnerToken = guestSessionOwnerToken;
  const subscribedTrackMids = guestSubscribedTrackMids;
  guestPc = null;
  guestReceiving = false;
  guestAllowsLocalAudience = false;
  guestSessionId = null;
  guestSessionOwnerToken = null;
  guestSubscriptionKey = null;
  guestConnectPromise = null;
  guestPendingReadyPayload = null;
  guestSubscribedTrackMids = [];

  clearGuestLimitTimer();
  closeGuestSessionTracks(sessionId, sessionOwnerToken, subscribedTrackMids);

  if (guestSourceL) {
    try {
      guestSourceL.disconnect();
    } catch {
      /* noop */
    }
    guestSourceL = null;
  }
  if (guestSourceR) {
    try {
      guestSourceR.disconnect();
    } catch {
      /* noop */
    }
    guestSourceR = null;
  }
  if (guestMerger) {
    try {
      guestMerger.disconnect();
    } catch {
      /* noop */
    }
    guestMerger = null;
  }
  cleanupGuestDecoderPrimers();
  if (pc) {
    pc.close();
  }

  if (shouldCleanupGuestReceiveState) {
    cleanupGuestSystemAudio();
  }
}

/**
 * Drop only the legacy guest SFU transport when adopting the PRO subscriber.
 * Playback ownership is preserved until the role-independent PRO subscriber
 * replaces it, avoiding both double audio and an unnecessary idle flash.
 */
export function cleanupSystemAudioSfuGuestRoute(): void {
  cleanupGuestSfu(false);
  resetGuestSystemAudioShareRoute();
}

function closeGuestSessionTracks(
  sessionId: string | null,
  sessionOwnerToken: string | null,
  mids: readonly string[],
): void {
  closeOwnedRealtimeTracks(sessionId, sessionOwnerToken, mids, 'Guest tracks-close failed');
}

function buildSubscriptionKey(payload: SfuReadyPayload): string {
  return `${payload.audience}:${payload.sessionId}:${payload.tracks
    .map((track) => track.trackName)
    .join(',')}`;
}

function isPayloadOnFrozenGuestRoute(payload: SfuReadyPayload): boolean {
  return (
    getGuestSystemAudioShareRoute() === (payload.audience === 'all' ? 'sfu-all' : 'sfu-remote')
  );
}

function normalizeSfuReadyPayload(
  data: ProtocolMsg<typeof MSG.SYSTEM_AUDIO_SFU_READY>,
): SfuReadyPayload | null {
  if (data.version !== 1 || !data.sessionId || !Array.isArray(data.tracks)) return null;
  const tracks = data.tracks.filter(
    (track): track is SfuReadyTrack =>
      !!track &&
      typeof track.trackName === 'string' &&
      (track.channel === 'L' || track.channel === 'R'),
  );
  if (tracks.length === 0) return null;
  return {
    version: 1,
    audience: data.audience === 'all' ? 'all' : 'remote',
    sessionId: data.sessionId,
    tracks,
  };
}

async function subscribeGuestToSfu(payload: SfuReadyPayload, signal: AbortSignal): Promise<void> {
  if (!isPayloadOnFrozenGuestRoute(payload)) return;
  const subscriptionKey = buildSubscriptionKey(payload);
  if (guestSubscriptionKey === subscriptionKey && guestPc) return;
  const subscriptionEpoch = guestSubscriptionEpoch;

  const rtcConfig = await loadSfuRtcConfig(signal);
  if (subscriptionEpoch !== guestSubscriptionEpoch) return;
  const pc = new RTCPeerConnection(rtcConfig);
  guestPc = pc;
  guestAllowsLocalAudience = payload.audience === 'all';
  guestSubscriptionKey = subscriptionKey;

  const channelByTrackName = new Map<string, Channel>();
  const channelByMid = new Map<string, Channel>();
  for (const track of payload.tracks) {
    channelByTrackName.set(track.trackName, track.channel);
    if (track.mid) channelByMid.set(track.mid, track.channel);
  }

  pc.addEventListener('connectionstatechange', () => {
    log.info(`[SysAudioSFU] Guest SFU connection: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanupGuestSfu();
    }
  });

  const fallbackChannels = payload.tracks.map((track) => track.channel);
  let fallbackChannelIndex = 0;
  const attachedTrackKeys = new Set<string>();

  const attachReceivedTrack = (
    channel: Channel | null,
    track: MediaStreamTrack,
    receiver: RTCRtpReceiver,
    reason: string,
    mid?: string | null,
  ) => {
    if (!channel) {
      log.warn(`[SysAudioSFU] Received track with unknown mid: ${mid || 'none'}`);
      return;
    }
    if (track.kind !== 'audio') return;

    const key = `${channel}:${track.id}`;
    if (attachedTrackKeys.has(key)) return;
    attachedTrackKeys.add(key);

    setReceiverDelay(receiver);
    log.info(`[SysAudioSFU] Received ${channel} remote track (${reason}, mid=${mid || 'none'})`);
    connectGuestTrack(channel, track, pc).catch((error) =>
      log.error('[SysAudioSFU] Failed to attach remote track:', error),
    );
  };

  const attachExistingReceiverTracks = (reason: string) => {
    pc.getTransceivers().forEach((transceiver, index) => {
      const track = transceiver.receiver.track;
      if (!track || track.kind !== 'audio') return;

      const mid = transceiver.mid;
      const channel = (mid && channelByMid.get(mid)) || fallbackChannels[index] || null;
      attachReceivedTrack(channel, track, transceiver.receiver, reason, mid);
    });
  };

  pc.ontrack = (event) => {
    const mid = event.transceiver.mid;
    const channel =
      (mid && channelByMid.get(mid)) || fallbackChannels[fallbackChannelIndex++] || null;
    attachReceivedTrack(channel, event.track, event.receiver, 'event', mid);
  };

  const session = await callRealtime('new-session', {
    correlationId: buildCorrelationId('guest-system-audio'),
    signal,
  });
  if (subscriptionEpoch !== guestSubscriptionEpoch) return;
  assertRealtimeOk(session);
  if (!session.sessionId) throw new Error('Realtime API did not return a guest sessionId');
  if (!session.sessionOwnerToken) {
    throw new Error('Realtime API did not return a guest session owner capability');
  }
  const sessionId = session.sessionId;
  const sessionOwnerToken = session.sessionOwnerToken;
  guestSessionId = sessionId;
  guestSessionOwnerToken = sessionOwnerToken;

  const trackRequests: RealtimeTrack[] = payload.tracks.map((track) => ({
    location: 'remote',
    sessionId: payload.sessionId,
    trackName: track.trackName,
  }));

  const tracksResponse = await callRealtime('tracks-new', {
    sessionId,
    sessionOwnerToken,
    payload: { tracks: trackRequests },
    signal,
  });
  const subscribedTrackMids = (tracksResponse.tracks || [])
    .map((track) => track.mid)
    .filter((mid): mid is string => typeof mid === 'string' && mid.length > 0);
  if (subscriptionEpoch !== guestSubscriptionEpoch) {
    closeGuestSessionTracks(sessionId, sessionOwnerToken, subscribedTrackMids);
    return;
  }
  // Preserve every exact mid returned by Cloudflare before validating the
  // aggregate response. Partial/error responses may still allocate tracks;
  // the shared failure cleanup can then close those owned tracks instead of
  // leaving them for the server-side orphan TTL.
  guestSubscribedTrackMids = subscribedTrackMids;
  assertRealtimeOk(tracksResponse, trackRequests.length);

  for (const track of tracksResponse.tracks || []) {
    if (!track.mid || !track.trackName) continue;
    const channel = channelByTrackName.get(track.trackName);
    if (channel) channelByMid.set(track.mid, channel);
  }
  const offer = tracksResponse.sessionDescription;
  if (!offer || offer.type !== 'offer') {
    throw new Error('Realtime API did not return a remote-track offer');
  }

  await pc.setRemoteDescription(offer);
  if (subscriptionEpoch !== guestSubscriptionEpoch) return;
  attachExistingReceiverTracks('remote-description');
  const answer = await pc.createAnswer();
  if (subscriptionEpoch !== guestSubscriptionEpoch) return;
  const answerDescription = sessionDescriptionFromInit(answer);
  await pc.setLocalDescription(answerDescription);
  if (subscriptionEpoch !== guestSubscriptionEpoch) return;

  const renegotiate = await callRealtime('renegotiate', {
    sessionId,
    sessionOwnerToken,
    payload: { sessionDescription: answerDescription },
    signal,
  });
  if (subscriptionEpoch !== guestSubscriptionEpoch) return;
  assertRealtimeOk(renegotiate);
  attachExistingReceiverTracks('renegotiate');

  log.info(`[SysAudioSFU] Subscribed to host system audio via Cloudflare SFU (${sessionId})`);
}

function beginGuestSfuSubscription(payload: SfuReadyPayload): void {
  if (!isPayloadOnFrozenGuestRoute(payload)) return;
  // Tear down the previous owner before publishing the successor controller.
  // subscribeGuestToSfu used to perform this cleanup after registration, which
  // made the new attempt abort itself synchronously.
  cleanupGuestSfu(false);
  const abortController = new AbortController();
  guestConnectAbortController = abortController;
  const connectPromise = subscribeGuestToSfu(payload, abortController.signal);
  guestConnectPromise = connectPromise;
  connectPromise
    .catch((error) => {
      if (guestConnectPromise !== connectPromise) {
        log.debug('[SysAudioSFU] Stale guest subscribe failed after supersession:', error);
        return;
      }
      log.warn('[SysAudioSFU] Guest subscribe failed:', error);
      const pendingPayload = guestPendingReadyPayload;
      const canHandoffToPending =
        !!pendingPayload &&
        isPayloadOnFrozenGuestRoute(pendingPayload) &&
        !!getState('network.hostConn');
      if (canHandoffToPending) {
        // Keep the system-audio placeholder while replacing only the failed
        // adapter. The guest receiver re-arms its watchdog so a second failed
        // publication cannot leave a permanent silent "receiving" state.
        cleanupGuestSfu(false);
        bus.emit('system-audio:delivery-handoff');
        beginGuestSfuSubscription(pendingPayload);
      } else {
        cleanupGuestSfu();
      }
    })
    .finally(() => {
      // A teardown can allow a successor subscription to begin before this
      // attempt settles. Never let the stale finally clear that successor's
      // in-flight ownership marker.
      if (guestConnectPromise !== connectPromise) return;
      guestConnectPromise = null;
      if (guestConnectAbortController === abortController) guestConnectAbortController = null;
      const pendingPayload = guestPendingReadyPayload;
      guestPendingReadyPayload = null;
      if (
        pendingPayload &&
        isPayloadOnFrozenGuestRoute(pendingPayload) &&
        buildSubscriptionKey(pendingPayload) !== guestSubscriptionKey &&
        getState('network.hostConn')
      ) {
        beginGuestSfuSubscription(pendingPayload);
      }
    });
}

function handleSfuReady(
  data: ProtocolMsg<typeof MSG.SYSTEM_AUDIO_SFU_READY>,
  conn?: DataConnection,
): void {
  if (!shouldUseRealtimeSfu()) return;

  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;
  if (isGuestLimitedForHost(hostConn)) {
    log.debug('[SysAudioSFU] Ignoring SFU ready until the guest rejoins the room');
    return;
  }

  const payload = normalizeSfuReadyPayload(data);
  if (!payload) return;
  if (getGuestSystemAudioShareRoute() === 'direct') return;
  if (getGuestSystemAudioShareRoute() === 'unselected') {
    if (getState('network.connectionType') === 'local' && payload.audience !== 'all') return;
    // Freeze synchronously, before TURN config or RTCPeerConnection creation.
    // Otherwise a stale direct call can win the await window and cancel the
    // correct all-audience subscription.
  }
  if (!freezeGuestSystemAudioSfuRoute(payload.audience)) {
    return;
  }

  if (guestConnectPromise) {
    guestPendingReadyPayload = payload;
    return;
  }
  beginGuestSfuSubscription(payload);
}

function handleSfuCapability(
  data: ProtocolMsg<typeof MSG.SYSTEM_AUDIO_SFU_CAPABILITY>,
  conn?: DataConnection,
): void {
  if (data.version !== 1 || data.localAudience !== true) return;
  if (getState('network.appRole') !== 'host' || !conn?.peer) return;
  if (getState('network.activeHostConnByPeerId').get(conn.peer) !== conn) return;

  markLocalSystemAudioSfuCapable(conn.peer);
  if (!isSystemAudioActive()) return;
  const peer = getState('network.connectedPeers').find((item) => item.id === conn.peer);
  if (resolveSystemAudioPeerDelivery(peer) === 'sfu') {
    // The host may have already released this late peer as unsupported before
    // its feature frame arrived. Re-arm the room-wide receive placeholder;
    // current receivers treat duplicate START as an idempotent no-op.
    safeSend(conn, { type: MSG.SYSTEM_AUDIO_START });
  }
  publishToEligiblePeer(conn.peer);
}

function publishToEligiblePeer(peerId: string): void {
  if (!shouldUseRealtimeSfu()) return;
  if (!isSystemAudioActive()) return;
  if (getState('network.appRole') !== 'host') return;
  const peer = getState('network.connectedPeers').find((item) => item.id === peerId);
  if (resolveSystemAudioPeerDelivery(peer) !== 'sfu') {
    if (!hasSfuHostPeers()) cleanupHostSfu();
    return;
  }

  // A remote-only SFU outage may already have consumed the eight direct
  // fallback slots. If a capable LAN participant then joins, spend the same
  // single bounded retry on an all-audience publication instead of leaving
  // that participant behind the receive watchdog. Existing fallback calls are
  // route-frozen and excluded from the publication.
  if (hostSfuUnavailable && getFrozenSystemAudioSfuAudience(peerId) === 'all') {
    if (hostRetryPending) return;
    if (!beginBoundedHostRetry(0, true)) stopPendingSfuPeers();
    return;
  }

  ensureHostPublication()
    .then((publication) => {
      if (publication) sendSfuReadyToPeer(peerId, publication);
    })
    .catch((error) => log.warn('[SysAudioSFU] Late-join SFU send failed:', error));
}

export function registerSystemAudioSfuListeners(): void {
  registerHandler(MSG.SYSTEM_AUDIO_SFU_READY, handleSfuReady);
  registerHandler(MSG.SYSTEM_AUDIO_SFU_CAPABILITY, handleSfuCapability);

  bus.on('system-audio:streams-ready', () => {
    if (getRoomContext().kind === 'pro') return;
    if (!shouldUseRealtimeSfu()) return;
    if (getState('network.appRole') !== 'host') return;
    beginSystemAudioShareDelivery(getState('network.connectedPeers'));
    if (!hasSfuHostPeers()) {
      log.info('[SysAudioSFU] No SFU peers; deferring SFU publish');
      return;
    }

    ensureHostPublication()
      .then((publication) => {
        if (publication) broadcastSfuReady(publication);
      })
      .catch((error) => log.warn('[SysAudioSFU] Host SFU setup failed:', error));
  });

  bus.on('orchestrator:peer-joined', (peerId: string) => {
    if (getRoomContext().kind === 'pro') return;
    publishToEligiblePeer(peerId);
  });

  bus.on('orchestrator:peer-evaluated', (peerId: string) => {
    if (getRoomContext().kind === 'pro') return;
    publishToEligiblePeer(peerId);
  });

  bus.on('network:peer-connected', (conn: DataConnection) => {
    if (getRoomContext().kind === 'pro') return;
    if (getState('network.appRole') !== 'guest') return;
    const hostConn = getState('network.hostConn');
    if (!hostConn || conn !== hostConn) return;
    safeSend(hostConn, {
      type: MSG.SYSTEM_AUDIO_SFU_CAPABILITY,
      version: 1,
      localAudience: true,
    });
  });

  bus.on('network:peer-disconnected', (peerId: string) => {
    if (getState('network.appRole') === 'host') {
      unmarkLocalSystemAudioSfuCapable(peerId);
      if (!hasSfuHostPeers()) cleanupHostSfu();
      return;
    }
    if (getState('network.appRole') === 'guest' && !getState('network.hostConn')) {
      guestLimitBlockedHostConn = null;
      cleanupGuestSfu();
    }
  });

  bus.on('network:peer-connection-replaced', (peerId: string) => {
    if (getState('network.appRole') !== 'host') return;
    unmarkLocalSystemAudioSfuCapable(peerId);
    if (!hasSfuHostPeers()) cleanupHostSfu();
  });

  bus.on('system-audio:incoming-call', () => {
    if (getState('network.appRole') !== 'guest') return;
    if (!claimGuestDirectSystemAudioRoute()) return;
    if (!guestPc && !guestConnectPromise) return;
    log.info('[SysAudioSFU] Local P2P system audio arrived; switching away from SFU');
    cleanupGuestSfu(false);
    bus.emit('system-audio:delivery-handoff');
  });

  bus.on('system-audio:host-started', () => {
    resetGuestSystemAudioShareRoute();
  });
  bus.on('system-audio:host-stopped', () => {
    cleanupGuestSfu();
    resetGuestSystemAudioShareRoute();
  });
  bus.on('system-audio:receive-timeout', () => {
    if (getState('network.appRole') !== 'guest') return;
    cleanupGuestSfu();
  });
  bus.on('system-audio:force-stop', () => {
    cleanupHostSfu();
    cleanupGuestSfu();
    resetGuestSystemAudioShareRoute();
    endSystemAudioShareDelivery();
  });
  bus.on('system-audio:stop', () => {
    cleanupHostSfu();
    cleanupGuestSfu();
    resetGuestSystemAudioShareRoute();
    endSystemAudioShareDelivery();
  });
}
