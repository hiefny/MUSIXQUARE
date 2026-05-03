/**
 * Cloudflare Realtime SFU bridge for remote system-audio guests.
 *
 * PeerJS stays responsible for presence/control. This module only moves the
 * host's L/R system-audio MediaStreamTracks through Cloudflare Realtime when a
 * guest is remote, leaving local guests on the existing PeerJS media path.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { APP_STATE, MSG } from '../core/constants.ts';
import { setManagedTimer } from '../core/timers.ts';
import { getAudioContext } from '../audio/context.ts';
import { initAudio, getWidener } from '../audio/engine.ts';
import { getStreamL, getStreamR, isSystemAudioActive } from '../audio/system-capture.ts';
import { registerHandler } from './protocol.ts';
import { broadcast, safeSend } from './peer-state.ts';
import { forceStereoSdp } from './peer.ts';
import type { DataConnection, ProtocolMsg } from '../types/index.ts';

const SYSTEM_AUDIO_PLAYOUT_DELAY_S = 0.5;
const ICE_GATHERING_TIMEOUT_MS = 3000;
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
  sessionId: string;
  tracks: SfuReadyTrack[];
}

interface HostPublication {
  sessionId: string;
  tracks: SfuReadyTrack[];
}

let hostPc: RTCPeerConnection | null = null;
let hostSessionId: string | null = null;
let hostPublishedTracks: SfuReadyTrack[] = [];
let hostPublishPromise: Promise<HostPublication | null> | null = null;
let hostSfuUnavailable = false;

let guestPc: RTCPeerConnection | null = null;
let guestSessionId: string | null = null;
let guestSubscriptionKey: string | null = null;
let guestConnectPromise: Promise<void> | null = null;
let guestSourceL: MediaStreamAudioSourceNode | null = null;
let guestSourceR: MediaStreamAudioSourceNode | null = null;
let guestMerger: ChannelMergerNode | null = null;
let guestReceiving = false;

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

function getRealtimeEndpoints(): string[] {
  return [
    '/.netlify/functions/cloudflare-realtime',
    'https://musixquare.com/.netlify/functions/cloudflare-realtime',
  ];
}

function getTurnConfigEndpoints(): string[] {
  return [
    '/.netlify/functions/get-turn-config',
    'https://musixquare.com/.netlify/functions/get-turn-config',
  ];
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

async function loadSfuRtcConfig(): Promise<RTCConfiguration> {
  const iceServers = [...BASE_SFU_ICE_SERVERS];

  for (const url of getTurnConfigEndpoints()) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;

      const payload = (await response.json()) as TurnConfigResponse;
      if (payload.provider !== 'cloudflare') continue;

      const cloudflareIceServers = normalizeRemoteIceServers(payload.iceServers);
      if (cloudflareIceServers.length === 0) continue;

      iceServers.push(...cloudflareIceServers);
      break;
    } catch {
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
    payload?: Record<string, unknown>;
    correlationId?: string;
  } = {},
): Promise<RealtimeResponse> {
  let lastError: unknown = null;

  for (const url of getRealtimeEndpoints()) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          sessionId: options.sessionId,
          correlationId: options.correlationId,
          payload: options.payload || {},
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as RealtimeResponse;
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
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'SFU request failed'));
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

function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };

    pc.addEventListener('icegatheringstatechange', onStateChange);
    window.setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
  });
}

function sessionDescriptionFromLocal(pc: RTCPeerConnection): RealtimeSessionDescription {
  const desc = pc.localDescription;
  if (!desc || !desc.sdp || (desc.type !== 'offer' && desc.type !== 'answer')) {
    throw new Error('Missing local SDP');
  }
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
    params.encodings[0].maxBitrate = 128000;
    sender.setParameters(params).catch(() => {
      /* noop */
    });
  } catch {
    /* noop */
  }
}

function makeReadyMessage(publication: HostPublication): ProtocolMsg<typeof MSG.SYSTEM_AUDIO_SFU_READY> {
  return {
    type: MSG.SYSTEM_AUDIO_SFU_READY,
    version: 1,
    sessionId: publication.sessionId,
    tracks: publication.tracks,
  };
}

function isRemoteHostPeer(peerId: string): boolean {
  const peer = getState('network.connectedPeers').find((p) => p.id === peerId);
  return !!peer && peer.status === 'connected' && peer.connectionType === 'remote';
}

function broadcastSfuReady(publication: HostPublication): void {
  const msg = makeReadyMessage(publication);
  const peers = getState('network.connectedPeers');
  for (const peer of peers) {
    if (peer.status !== 'connected' || peer.connectionType !== 'remote') continue;
    safeSend(peer.conn, msg);
  }
}

function sendSfuReadyToPeer(peerId: string, publication: HostPublication): void {
  if (!isRemoteHostPeer(peerId)) return;
  const peer = getState('network.connectedPeers').find((p) => p.id === peerId);
  if (!peer) return;
  safeSend(peer.conn, makeReadyMessage(publication));
}

async function publishHostTracks(): Promise<HostPublication | null> {
  const streamL = getStreamL();
  const streamR = getStreamR();
  const trackL = streamL?.getAudioTracks()[0];
  const trackR = streamR?.getAudioTracks()[0];
  if (!trackL || !trackR) return null;

  const pc = new RTCPeerConnection(await loadSfuRtcConfig());
  hostPc = pc;
  pc.addEventListener('connectionstatechange', () => {
    log.info(`[SysAudioSFU] Host SFU connection: ${pc.connectionState}`);
  });

  const session = await callRealtime('new-session', {
    correlationId: buildCorrelationId('host-system-audio'),
  });
  assertRealtimeOk(session);
  if (!session.sessionId) throw new Error('Realtime API did not return a sessionId');

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
  await pc.setLocalDescription({ type: offer.type, sdp: forceStereoSdp(offer.sdp || '') });
  await waitForIceGatheringComplete(pc);

  const trackNameL = buildTrackName('L');
  const trackNameR = buildTrackName('R');
  const requestedTracks: RealtimeTrack[] = [
    { location: 'local', mid: txL.mid || '0', trackName: trackNameL, kind: 'audio' },
    { location: 'local', mid: txR.mid || '1', trackName: trackNameR, kind: 'audio' },
  ];

  const tracksResponse = await callRealtime('tracks-new', {
    sessionId: session.sessionId,
    payload: {
      sessionDescription: sessionDescriptionFromLocal(pc),
      tracks: requestedTracks,
    },
  });
  assertRealtimeOk(tracksResponse, requestedTracks.length);

  const answer = tracksResponse.sessionDescription;
  if (!answer || answer.type !== 'answer') throw new Error('Realtime API did not return an answer');
  await pc.setRemoteDescription(answer);

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

  hostSessionId = session.sessionId;
  hostPublishedTracks = publishedTracks;
  log.info(`[SysAudioSFU] Published system audio to Cloudflare SFU (${hostSessionId})`);
  return { sessionId: hostSessionId, tracks: publishedTracks };
}

async function ensureHostPublication(): Promise<HostPublication | null> {
  if (hostSfuUnavailable) return null;
  if (hostSessionId && hostPublishedTracks.length > 0) {
    return { sessionId: hostSessionId, tracks: hostPublishedTracks };
  }
  if (hostPublishPromise) return hostPublishPromise;

  hostPublishPromise = publishHostTracks()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('REALTIME_SFU_UNAVAILABLE')) {
        hostSfuUnavailable = true;
        log.info('[SysAudioSFU] Cloudflare Realtime SFU env not configured; using P2P paths only');
      } else {
        log.warn('[SysAudioSFU] Host publish failed:', error);
      }
      cleanupHostSfu(false);
      return null;
    })
    .finally(() => {
      hostPublishPromise = null;
    });

  return hostPublishPromise;
}

function cleanupHostSfu(closeRemoteTracks = true): void {
  if (closeRemoteTracks && hostSessionId && hostPublishedTracks.length > 0) {
    const tracks = hostPublishedTracks
      .filter((track) => track.mid)
      .map((track) => ({ mid: track.mid }));
    if (tracks.length > 0) {
      callRealtime('tracks-close', {
        sessionId: hostSessionId,
        payload: { tracks, force: true },
      }).catch((error) => log.debug('[SysAudioSFU] tracks-close failed:', error));
    }
  }

  if (hostPc) {
    hostPc.close();
    hostPc = null;
  }
  hostSessionId = null;
  hostPublishedTracks = [];
  hostPublishPromise = null;
  hostSfuUnavailable = false;
}

function setReceiverDelay(event: RTCTrackEvent): void {
  if (event.track.kind !== 'audio') return;
  const receiver = event.receiver as RTCRtpReceiver & { playoutDelayHint?: number };
  receiver.playoutDelayHint = SYSTEM_AUDIO_PLAYOUT_DELAY_S;
}

async function connectGuestTrack(channel: Channel, track: MediaStreamTrack): Promise<void> {
  await initAudio();
  const ctx = getAudioContext();
  const widener = getWidener();
  if (!widener) {
    log.error('[SysAudioSFU] Audio graph not ready');
    return;
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

  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  source.connect(guestMerger, 0, channel === 'L' ? 0 : 1);
  if (channel === 'L') guestSourceL = source;
  else guestSourceR = source;

  if (!guestReceiving) {
    guestReceiving = true;
    setState('systemAudio.isReceiving', true);
    setState('appState', APP_STATE.PLAYING_SYSTEM_AUDIO);
    bus.emit('visualizer:start');
    log.info('[SysAudioSFU] Remote system audio connected through Cloudflare SFU');
  }
}

function cleanupGuestSfu(updateState = true): void {
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
  if (guestPc) {
    guestPc.close();
    guestPc = null;
  }

  guestSessionId = null;
  guestSubscriptionKey = null;
  guestConnectPromise = null;
  if (guestReceiving && updateState) {
    setState('systemAudio.isReceiving', false);
    if (getState('appState') === APP_STATE.PLAYING_SYSTEM_AUDIO) {
      setState('appState', APP_STATE.IDLE);
    }
  }
  guestReceiving = false;
}

function buildSubscriptionKey(payload: SfuReadyPayload): string {
  return `${payload.sessionId}:${payload.tracks.map((track) => track.trackName).join(',')}`;
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
  return { version: 1, sessionId: data.sessionId, tracks };
}

async function subscribeGuestToSfu(payload: SfuReadyPayload): Promise<void> {
  const subscriptionKey = buildSubscriptionKey(payload);
  if (guestSubscriptionKey === subscriptionKey && guestPc) return;
  cleanupGuestSfu(false);

  const pc = new RTCPeerConnection(await loadSfuRtcConfig());
  guestPc = pc;
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

  pc.ontrack = (event) => {
    setReceiverDelay(event);
    const mid = event.transceiver.mid;
    const channel = (mid && channelByMid.get(mid)) || fallbackChannels[fallbackChannelIndex++] || null;
    if (!channel) {
      log.warn(`[SysAudioSFU] Received track with unknown mid: ${mid || 'none'}`);
      return;
    }
    connectGuestTrack(channel, event.track).catch((error) =>
      log.error('[SysAudioSFU] Failed to attach remote track:', error),
    );
  };

  const session = await callRealtime('new-session', {
    correlationId: buildCorrelationId('guest-system-audio'),
  });
  assertRealtimeOk(session);
  if (!session.sessionId) throw new Error('Realtime API did not return a guest sessionId');
  guestSessionId = session.sessionId;

  const trackRequests: RealtimeTrack[] = payload.tracks.map((track) => ({
    location: 'remote',
    sessionId: payload.sessionId,
    trackName: track.trackName,
    kind: 'audio',
  }));

  const tracksResponse = await callRealtime('tracks-new', {
    sessionId: guestSessionId,
    payload: { tracks: trackRequests },
  });
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
  const answer = await pc.createAnswer();
  await pc.setLocalDescription({ type: answer.type, sdp: forceStereoSdp(answer.sdp || '') });
  await waitForIceGatheringComplete(pc);

  const renegotiate = await callRealtime('renegotiate', {
    sessionId: guestSessionId,
    payload: { sessionDescription: sessionDescriptionFromLocal(pc) },
  });
  assertRealtimeOk(renegotiate);

  log.info(`[SysAudioSFU] Subscribed to host system audio via Cloudflare SFU (${guestSessionId})`);
}

function handleSfuReady(
  data: ProtocolMsg<typeof MSG.SYSTEM_AUDIO_SFU_READY>,
  conn?: DataConnection,
): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;
  if (getState('network.connectionType') === 'local') return;

  const payload = normalizeSfuReadyPayload(data);
  if (!payload) return;

  if (guestConnectPromise) return;
  guestConnectPromise = subscribeGuestToSfu(payload)
    .catch((error) => {
      log.warn('[SysAudioSFU] Guest subscribe failed:', error);
      cleanupGuestSfu();
    })
    .finally(() => {
      guestConnectPromise = null;
    });
}

export function registerSystemAudioSfuListeners(): void {
  registerHandler(MSG.SYSTEM_AUDIO_SFU_READY, handleSfuReady);

  bus.on('system-audio:streams-ready', () => {
    if (getState('network.appRole') !== 'host') return;
    ensureHostPublication()
      .then((publication) => {
        if (publication) broadcastSfuReady(publication);
      })
      .catch((error) => log.warn('[SysAudioSFU] Host SFU setup failed:', error));
  });

  bus.on('orchestrator:peer-joined', (peerId: string) => {
    if (!isSystemAudioActive()) return;
    if (getState('network.appRole') !== 'host') return;
    if (!isRemoteHostPeer(peerId)) return;

    ensureHostPublication()
      .then((publication) => {
        if (publication) sendSfuReadyToPeer(peerId, publication);
      })
      .catch((error) => log.warn('[SysAudioSFU] Late-join SFU send failed:', error));
  });

  bus.on('network:peer-connected', () => {
    if (!isSystemAudioActive()) return;
    if (getState('network.appRole') !== 'host') return;

    setManagedTimer(
      'sys-audio-sfu-late-ready',
      () => {
        if (hostSessionId && hostPublishedTracks.length > 0) {
          broadcast({ type: MSG.SYSTEM_AUDIO_START });
          broadcastSfuReady({ sessionId: hostSessionId, tracks: hostPublishedTracks });
        }
      },
      700,
    );
  });

  bus.on('network:peer-disconnected', () => {
    if (getState('network.appRole') !== 'guest') return;
    if (!getState('network.hostConn')) cleanupGuestSfu();
  });

  bus.on('system-audio:host-stopped', () => cleanupGuestSfu());
  bus.on('system-audio:force-stop', () => {
    cleanupHostSfu();
    cleanupGuestSfu();
  });
  bus.on('system-audio:stop', () => {
    cleanupHostSfu();
    cleanupGuestSfu();
  });
}
