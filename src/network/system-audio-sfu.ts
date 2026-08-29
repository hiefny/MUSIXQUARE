/**
 * Cloudflare Realtime SFU bridge for remote and bounded-overflow system-audio guests.
 *
 * The active transport stays responsible for presence/control. This module only moves the
 * host's original stereo system-audio MediaStreamTrack through Cloudflare
 * Realtime. Small LAN rooms keep direct calls; overflow LAN guests and large
 * rooms use SFU.
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
import { getCapturedAudioStream, isSystemAudioActive } from '../audio/system-capture.ts';
import { claimPlaybackOwner, setSystemAudioReceiving } from '../player/ownership.ts';
import { registerHandler } from './protocol.ts';
import { safeSend } from './peer-state.ts';
import { createSystemAudioStartFrame } from './system-audio-start.ts';
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
import { readBoundedJsonResponse, withRequestDeadline } from '../core/request-lifetime.ts';
import { localFirstApiEndpoints } from './api-endpoints.ts';
import { getStandardRoomTurnCredentials } from './standard-room-prerequisites.ts';
import { forceStereoSdp, sdpPrefersOpusStereo } from './peer.ts';

const SYSTEM_AUDIO_PLAYOUT_DELAY_S = 0.5;
const GUEST_SFU_RECEIVE_LIMIT_TIMER = 'system-audio-sfu-guest-limit';
const HOST_SFU_RETRY_TIMER = 'system-audio-sfu-host-retry';
const HOST_SFU_RETRY_DELAY_MS = 2500;
const HOST_SFU_MAX_RETRIES = 1;
const SFU_CONTROL_REQUEST_TIMEOUT_MS = 15_000;
const SFU_CONTROL_RESPONSE_MAX_BYTES = 1024 * 1024;
const BASE_SFU_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

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

interface SfuReadyTrack {
  trackName: string;
  mid?: string;
}

interface SfuReadyPayload {
  version: 2;
  audience: 'remote' | 'all';
  sessionId: string;
  track: SfuReadyTrack;
}

interface HostPublication {
  sessionId: string;
  track: SfuReadyTrack;
}

let hostPc: RTCPeerConnection | null = null;
let hostSessionId: string | null = null;
// Edge-issued ownership capabilities stay module-local. HostPublication and
// SYSTEM_AUDIO_SFU_READY intentionally expose only the public subscription
// coordinates, so a remote guest cannot mutate the host's SFU session.
let hostSessionOwnerToken: string | null = null;
let hostPublishedTrack: SfuReadyTrack | null = null;
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
let guestSourceStereo: MediaStreamAudioSourceNode | null = null;
let guestReceiving = false;
let guestAllowsLocalAudience = false;
let guestLimitTimerActive = false;
let guestLimitBlockedHostConn: DataConnection | null = null;
let guestDecoderPrimer: WebRtcAudioDecoderPrimer | null = null;

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
      publishedTrack: hostPublishedTrack,
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
      sourceStereo: !!guestSourceStereo,
      receiving: guestReceiving,
      allowsLocalAudience: guestAllowsLocalAudience,
      limitTimerActive: guestLimitTimerActive,
      limitBlocked: !!guestLimitBlockedHostConn,
      shareRoute: getGuestSystemAudioShareRoute(),
      directRouteFrozen: getGuestSystemAudioShareRoute() === 'direct',
      decoderPrimerCount: guestDecoderPrimer ? 1 : 0,
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

function buildTrackName(): string {
  const room = getState('network.sessionCode') || 'session';
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Date.now());
  return `mxqr-system-audio-${room}-stereo-${id}`.slice(0, 160);
}

function cleanupGuestDecoderPrimers(): void {
  cleanupWebRtcAudioDecoderPrimer(guestDecoderPrimer);
  guestDecoderPrimer = null;
}

function primeWindowsSfuAudioDecoder(track: MediaStreamTrack): void {
  const primer = primeWebRtcAudioDecoder(
    guestDecoderPrimer,
    [track],
    getAudioTrackStreamKey('sfu:stereo', [track]),
    'STEREO',
    '[SysAudioSFU]',
  );

  guestDecoderPrimer = primer;
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

async function loadSfuRtcConfig(signal?: AbortSignal): Promise<RTCConfiguration> {
  const turnCredentials = await getStandardRoomTurnCredentials(signal);

  return {
    iceServers: [...BASE_SFU_ICE_SERVERS, ...(turnCredentials?.iceServers ?? [])],
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
  // Opus advertises two channels in rtpmap even when the negotiated encoder is
  // mono. Preserve the captured L/R image by explicitly requesting stereo in
  // SDP created by this client. Cloudflare-returned SDP must stay byte-for-byte
  // authoritative so setRemoteDescription observes the exact answer/offer the
  // SFU generated.
  return { type: desc.type, sdp: forceStereoSdp(desc.sdp) };
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
    // The former L/R contract allocated 128 kbps to each mono sender. Keep the
    // same aggregate quality budget on the single stereo Opus sender.
    params.encodings[0].maxBitrate = 256000;
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
    version: 2,
    audience,
    sessionId: publication.sessionId,
    track: publication.track,
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
  const capturedStream = getCapturedAudioStream();
  const capturedTrack = capturedStream?.getAudioTracks()[0];
  if (!capturedStream || !capturedTrack) return null;

  // TURN minting and the independent Realtime session allocation used to run
  // serially. Starting them together removes one full edge round trip from
  // every remote publication while the shared AbortSignal still retires both
  // when the share is stopped or superseded.
  const sessionPromise = callRealtime('new-session', {
    correlationId: buildCorrelationId('host-system-audio'),
    signal,
  });
  // Mark the concurrently-started branch handled while RTC config is pending;
  // awaiting the original promise below still propagates its exact failure.
  void sessionPromise.catch(() => undefined);
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

  const session = await sessionPromise;
  if (publishEpoch !== hostPublishEpoch) {
    try {
      pc.close();
    } catch {
      /* already closed by supersession cleanup */
    }
    if (hostPc === pc) hostPc = null;
    return null;
  }
  assertRealtimeOk(session);
  if (!session.sessionId) throw new Error('Realtime API did not return a sessionId');
  if (!session.sessionOwnerToken) {
    throw new Error('Realtime API did not return a session owner capability');
  }
  const sessionOwnerToken = session.sessionOwnerToken;

  const transceiver = pc.addTransceiver(capturedTrack, {
    direction: 'sendonly',
    streams: [capturedStream],
  });
  applyAudioSenderTuning(transceiver.sender);

  const offer = await pc.createOffer();
  const offerDescription = sessionDescriptionFromInit(offer);
  await pc.setLocalDescription(offerDescription);

  const trackName = buildTrackName();
  const requestedTracks: RealtimeTrack[] = [
    { location: 'local', mid: transceiver.mid || '0', trackName },
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
  const publishedTrack: SfuReadyTrack = {
    trackName,
    mid:
      responseTracks.find((track) => track.trackName === trackName)?.mid || transceiver.mid || '0',
  };

  try {
    assertRealtimeOk(tracksResponse, requestedTracks.length);
    const answer = tracksResponse.sessionDescription;
    if (!answer || answer.type !== 'answer') {
      throw new Error('Realtime API did not return an answer');
    }
    if (!sdpPrefersOpusStereo(answer.sdp)) {
      throw new Error('SFU_STEREO_NOT_NEGOTIATED');
    }
    await pc.setRemoteDescription(answer);
  } catch (error) {
    closeOwnedRealtimeTracks(
      session.sessionId,
      sessionOwnerToken,
      [publishedTrack.mid],
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
      [publishedTrack.mid],
      'Stale publish tracks-close failed',
    );
    return null;
  }

  hostSessionId = session.sessionId;
  hostSessionOwnerToken = sessionOwnerToken;
  hostPublishedTrack = publishedTrack;
  log.info(`[SysAudioSFU] Published system audio to Cloudflare SFU (${hostSessionId})`);
  return { sessionId: hostSessionId, track: publishedTrack };
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
  if (hostSessionId && hostPublishedTrack) {
    return { sessionId: hostSessionId, track: hostPublishedTrack };
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

  if (closeRemoteTracks && hostSessionId && hostPublishedTrack) {
    closeOwnedRealtimeTracks(
      hostSessionId,
      hostSessionOwnerToken,
      [hostPublishedTrack.mid],
      'Host tracks-close failed',
    );
  }

  if (hostPc) {
    hostPc.close();
    hostPc = null;
  }
  hostSessionId = null;
  hostSessionOwnerToken = null;
  hostPublishedTrack = null;
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

async function connectGuestTrack(track: MediaStreamTrack, pc: RTCPeerConnection): Promise<void> {
  if (guestPc !== pc) return;
  // SYSTEM_AUDIO_START and the SFU descriptor share a reliable data channel,
  // but the remote media plane can become audible while the trusted start is
  // still waiting for the prior file renderer to stop. Join the same
  // physical-owner barrier used by the direct-call adapter.
  const trustedReceptionReady = await awaitTrustedSystemAudioReceptionBoundary('sfu-stereo');
  if (!trustedReceptionReady || guestPc !== pc) {
    if (guestPc === pc) cleanupGuestSfu();
    return;
  }
  await initAudio();
  // Re-check identity after the await: connectGuestTrack is
  // fire-and-forget, so a teardown (cleanupGuestSfu → guestPc=null) or a new
  // subscription (guestPc=newPc) landing during initAudio() would otherwise let
  // this late attach recreate the source and flip guestReceiving=true —
  // resurrecting a torn-down receive (double audio, masked playback mode).
  // The host publisher guards the
  // same window with an epoch; pc-identity is the right key here since each
  // subscription owns exactly one pc. Must run BEFORE any node is created.
  if (guestPc !== pc) {
    log.debug('[SysAudioSFU] Stale guest track attach (pc superseded during init). Skipping');
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

  if (guestSourceStereo) {
    try {
      guestSourceStereo.disconnect();
    } catch {
      /* noop */
    }
  }

  primeWindowsSfuAudioDecoder(track);
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  source.connect(widener.input);
  guestSourceStereo = source;

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

  if (guestSourceStereo) {
    try {
      guestSourceStereo.disconnect();
    } catch {
      /* noop */
    }
    guestSourceStereo = null;
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
  return `${payload.audience}:${payload.sessionId}:${payload.track.trackName}`;
}

function isPayloadOnFrozenGuestRoute(payload: SfuReadyPayload): boolean {
  return (
    getGuestSystemAudioShareRoute() === (payload.audience === 'all' ? 'sfu-all' : 'sfu-remote')
  );
}

function normalizeSfuReadyPayload(
  data: ProtocolMsg<typeof MSG.SYSTEM_AUDIO_SFU_READY>,
): SfuReadyPayload | null {
  if (
    data.version !== 2 ||
    !data.sessionId ||
    !data.track ||
    typeof data.track.trackName !== 'string' ||
    data.track.trackName.length === 0
  ) {
    return null;
  }
  return {
    version: 2,
    audience: data.audience === 'all' ? 'all' : 'remote',
    sessionId: data.sessionId,
    track: data.track,
  };
}

async function subscribeGuestToSfu(payload: SfuReadyPayload, signal: AbortSignal): Promise<void> {
  if (!isPayloadOnFrozenGuestRoute(payload)) return;
  const subscriptionKey = buildSubscriptionKey(payload);
  if (guestSubscriptionKey === subscriptionKey && guestPc) return;
  const subscriptionEpoch = guestSubscriptionEpoch;

  // The subscriber session does not depend on TURN credentials. Resolve both
  // prerequisites concurrently so the receiver can build its PC as soon as
  // the slower of the two is ready instead of paying both waits in sequence.
  const sessionPromise = callRealtime('new-session', {
    correlationId: buildCorrelationId('guest-system-audio'),
    signal,
  });
  void sessionPromise.catch(() => undefined);
  const rtcConfig = await loadSfuRtcConfig(signal);
  if (subscriptionEpoch !== guestSubscriptionEpoch) return;
  const pc = new RTCPeerConnection(rtcConfig);
  guestPc = pc;
  guestAllowsLocalAudience = payload.audience === 'all';
  guestSubscriptionKey = subscriptionKey;

  const publishedTrack = payload.track;

  pc.addEventListener('connectionstatechange', () => {
    log.info(`[SysAudioSFU] Guest SFU connection: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanupGuestSfu();
    }
  });

  const attachedTrackKeys = new Set<string>();

  const attachReceivedTrack = (
    track: MediaStreamTrack,
    receiver: RTCRtpReceiver,
    reason: string,
    mid?: string | null,
  ) => {
    if (track.kind !== 'audio') return;

    const key = track.id;
    if (attachedTrackKeys.has(key)) return;
    attachedTrackKeys.add(key);

    setReceiverDelay(receiver);
    log.info(`[SysAudioSFU] Received stereo remote track (${reason}, mid=${mid || 'none'})`);
    connectGuestTrack(track, pc).catch((error) =>
      log.error('[SysAudioSFU] Failed to attach remote track:', error),
    );
  };

  const attachExistingReceiverTracks = (reason: string) => {
    pc.getTransceivers().forEach((transceiver) => {
      const track = transceiver.receiver.track;
      if (!track || track.kind !== 'audio') return;

      const mid = transceiver.mid;
      if (subscribedMid && mid && subscribedMid !== mid) return;
      attachReceivedTrack(track, transceiver.receiver, reason, mid);
    });
  };

  pc.ontrack = (event) => {
    const mid = event.transceiver.mid;
    if (subscribedMid && mid && subscribedMid !== mid) return;
    attachReceivedTrack(event.track, event.receiver, 'event', mid);
  };

  const session = await sessionPromise;
  if (subscriptionEpoch !== guestSubscriptionEpoch) {
    try {
      pc.close();
    } catch {
      /* already closed by supersession cleanup */
    }
    if (guestPc === pc) {
      guestPc = null;
      guestSubscriptionKey = null;
      guestAllowsLocalAudience = false;
    }
    return;
  }
  assertRealtimeOk(session);
  if (!session.sessionId) throw new Error('Realtime API did not return a guest sessionId');
  if (!session.sessionOwnerToken) {
    throw new Error('Realtime API did not return a guest session owner capability');
  }
  const sessionId = session.sessionId;
  const sessionOwnerToken = session.sessionOwnerToken;
  guestSessionId = sessionId;
  guestSessionOwnerToken = sessionOwnerToken;

  const trackRequests: RealtimeTrack[] = [
    {
      location: 'remote',
      sessionId: payload.sessionId,
      trackName: publishedTrack.trackName,
    },
  ];

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

  // Publication mids belong to the host PC. Cloudflare assigns a separate mid
  // to this subscriber PC, so bind only to the tracks-new result.
  const subscribedMid = (tracksResponse.tracks || []).find(
    (track) => track.trackName === publishedTrack.trackName && !!track.mid,
  )?.mid;
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
  if (data.version !== 2 || data.localAudience !== true) return;
  if (getState('network.appRole') !== 'host' || !conn?.peer) return;
  if (getState('network.activeHostConnByPeerId').get(conn.peer) !== conn) return;

  markLocalSystemAudioSfuCapable(conn.peer);
  if (!isSystemAudioActive()) return;
  const peer = getState('network.connectedPeers').find((item) => item.id === conn.peer);
  if (resolveSystemAudioPeerDelivery(peer) === 'sfu') {
    // The host may have already released this late peer as unsupported before
    // its feature frame arrived. Re-arm the room-wide receive placeholder;
    // current receivers treat duplicate START as an idempotent no-op.
    safeSend(conn, createSystemAudioStartFrame());
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
      version: 2,
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
