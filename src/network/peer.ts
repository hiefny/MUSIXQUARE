/**
 * MUSIXQUARE — WebRTC Transport Coordinator
 *
 * Orchestrates: network initialization, transport event wiring, session cleanup.
 * Re-exports public API from peer-state.ts, host.ts, guest.ts so that
 * external imports from '../network/peer.ts' continue to work unchanged.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState, batchSetState } from '../core/state.ts';
import { markIntentionalNav } from '../core/page-lifecycle.ts';
import { showDialog } from '../ui/dialog.ts';
import {
  DEFAULT_MAX_GUEST_SLOTS,
  APP_STATE,
  TRANSFER_STATE,
  PLAYBACK_STATE,
} from '../core/constants.ts';
import { clearAllManagedTimers, clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { stopWorkerTimer } from './sync-worker.ts';
import type { DataConnection, AnyProtocolMsg } from '../types/index.ts';
import { getRuntimeTransportConfig } from './transport/config.ts';
import { createTransportPeer, type TransportPeerOptions } from './transport/index.ts';

// ─── Sub-module imports (only names used locally in this file) ───────

import { getPeer, setPeer, generateSessionCode, broadcast, broadcastExcept } from './peer-state.ts';

import { handleHostIncomingConnection } from './host.ts';
import { setInitNetwork, initGuestProtocolHandlers } from './guest.ts';

// ─── Re-exports (preserves external import surface) ─────────────────

export { getPeer } from './peer-state.ts';
export {
  broadcast,
  broadcastExcept,
  broadcastDeviceList,
  safeSend,
  sendToHost,
  canSendFileTo,
  filterEligiblePeers,
  isRemoteGuest,
  waitForGuestConnectionType,
} from './peer-state.ts';

export { joinSession } from './guest.ts';

type SystemAudioCallType =
  | 'system-audio'
  | 'system-audio-dual'
  | 'system-audio-stereo'
  | 'system-audio-synced';

type IncomingMediaConnection = {
  peer?: string;
  metadata?: Record<string, unknown>;
  close: () => void;
};

const SYSTEM_AUDIO_CALL_TYPES = new Set<string>([
  'system-audio',
  'system-audio-dual',
  'system-audio-stereo',
  'system-audio-synced',
]);

function isSystemAudioCallType(type: unknown): type is SystemAudioCallType {
  return typeof type === 'string' && SYSTEM_AUDIO_CALL_TYPES.has(type);
}

export function isTrustedSystemAudioMediaCall(mediaConn: {
  peer?: string;
  metadata?: Record<string, unknown>;
}): boolean {
  if (!isSystemAudioCallType(mediaConn.metadata?.type)) return false;

  const hostConn = getState('network.hostConn');
  return !!hostConn && typeof mediaConn.peer === 'string' && mediaConn.peer === hostConn.peer;
}

function closeIncomingMediaCall(mediaConn: IncomingMediaConnection): void {
  try {
    mediaConn.close();
  } catch {
    /* noop */
  }
}

function getSystemAudioCallChannel(
  type: SystemAudioCallType,
  metadata?: Record<string, unknown>,
): string {
  if (type === 'system-audio-dual') return 'DUAL';
  if (type === 'system-audio-stereo') return 'STEREO';
  if (type === 'system-audio-synced') return 'SYNCED';
  return (metadata?.channel as string) || 'L';
}

// ─── SDP Utils ──────────────────────────────────────────────────────

/**
 * Munge SDP to force Opus codec into high-fidelity stereo mode.
 * Fixes Chrome's tendency to downmix to 1-channel mono and limit bitrate.
 */
export function forceStereoSdp(sdp: string): string {
  let modified = sdp;
  // 1. Find opus payload types
  const opusPTs: string[] = [];
  const rtpmapRegex = /a=rtpmap:(\d+) opus\/48000\/2/g;
  let match;
  while ((match = rtpmapRegex.exec(sdp)) !== null) {
    opusPTs.push(match[1]);
  }

  // 2. Add/replace stereo params to ALL fmtp lines for these PTs
  for (const pt of opusPTs) {
    const fmtpRegex = new RegExp(`a=fmtp:${pt}(.*)`, 'g');
    if (fmtpRegex.test(modified)) {
      modified = modified.replace(fmtpRegex, (line) => {
        // Strip out existing stereo-related params
        const newLine = line.replace(
          /;?\s*(stereo|sprop-stereo|maxaveragebitrate|useinbandfec)=[^;]+/g,
          '',
        );
        // Append our high-fidelity stereo params + sweet-spot bitrate (128kbps per track)
        return newLine + '; stereo=1; sprop-stereo=1; maxaveragebitrate=128000; useinbandfec=1';
      });
    } else {
      // If no fmtp line exists, append it after the rtpmap line
      const rtpmapLine = new RegExp(`a=rtpmap:${pt} opus/48000/2`);
      modified = modified.replace(rtpmapLine, (line) => {
        return (
          line +
          `\r\na=fmtp:${pt} stereo=1; sprop-stereo=1; maxaveragebitrate=128000; useinbandfec=1`
        );
      });
    }
  }
  return modified;
}

// ─── TURN Config Helpers ────────────────────────────────────────────

interface TurnConfigResponse {
  provider?: unknown;
  iceServers?: unknown;
  username?: unknown;
  credential?: unknown;
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

function hasTurnServer(server: RTCIceServer): boolean {
  return normalizeIceServerUrls(server.urls).some((url) => /^turns?:/i.test(url));
}

function getProviderLabel(payload: TurnConfigResponse): string {
  return typeof payload.provider === 'string' && payload.provider ? payload.provider : 'remote';
}

function buildLegacyMeteredIceServers(username: string, credential: string): RTCIceServer[] {
  return [
    { urls: 'turn:standard.relay.metered.ca:443', username, credential },
    { urls: 'turn:standard.relay.metered.ca:443?transport=tcp', username, credential },
    { urls: 'turns:standard.relay.metered.ca:443?transport=tcp', username, credential },
  ];
}

// ─── Network Initialization ─────────────────────────────────────────

/**
 * Initialize the configured WebRTC transport with optional requested ID.
 * Returns the assigned peer ID.
 */
export async function initNetwork(requestedId: string | null = null): Promise<string> {
  // Clean up existing peer instance
  const oldPeer = getPeer();
  if (oldPeer) {
    try {
      oldPeer.destroy();
    } catch {
      /* noop */
    }
    setPeer(null);
  }

  // ICE servers: STUN always, TURN via Netlify Function (Cloudflare primary, Metered fallback)
  const iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  // Direct URLs only (no .netlify.app → .com redirect, which breaks CORS in some WebViews)
  const turnEndpoints = [
    '/.netlify/functions/get-turn-config', // same-origin (works for musixquare.com)
    'https://musixquare.com/.netlify/functions/get-turn-config', // cross-origin (Toss WebView, etc.) — direct, no redirect
  ];

  for (const url of turnEndpoints) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        log.warn(`[Network] TURN fetch failed: ${url} → HTTP ${resp.status}`);
        continue;
      }
      const payload = (await resp.json()) as TurnConfigResponse;
      const remoteIceServers = normalizeRemoteIceServers(payload.iceServers);
      if (remoteIceServers.some(hasTurnServer)) {
        iceServers.push(...remoteIceServers);
        log.info(`[Network] TURN ICE servers loaded (${getProviderLabel(payload)}) via ${url}`);
        break;
      }

      // Legacy response shape kept for older local functions and quick rollbacks.
      if (typeof payload.username === 'string' && typeof payload.credential === 'string') {
        iceServers.push(...buildLegacyMeteredIceServers(payload.username, payload.credential));
        log.info(`[Network] TURN credentials loaded (Metered.ca legacy) via ${url}`);
        break;
      }

      log.warn(`[Network] TURN fetch returned no usable ICE servers: ${url}`);
    } catch (e) {
      log.warn(
        `[Network] TURN fetch error: ${url} → ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (!iceServers.some(hasTurnServer)) {
    log.warn(
      '[Network] TURN config unavailable — STUN only (P2P will likely fail behind symmetric NAT)',
    );
  }

  const transportConfig = getRuntimeTransportConfig();
  const peerOpts: TransportPeerOptions = {
    debug: 2,
    provider: transportConfig.provider,
    signalingUrl: transportConfig.signalingUrl,
    peerJsServer: transportConfig.peerJsServer,
    config: {
      iceServers,
      bundlePolicy: 'max-bundle',
    },
  };

  log.info(`[Network] Initializing ${transportConfig.provider} transport`);
  const newPeer = await createTransportPeer(requestedId, peerOpts);
  setPeer(newPeer);
  setupPeerEvents();

  // Wait for open (or fail fast on error)
  const id = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearManagedTimer('peer-open-timeout');
      newPeer.off('open', onOpen);
      newPeer.off('error', onError);
    };
    const onOpen = (id: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(id);
    };
    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    newPeer.on('open', onOpen);
    newPeer.on('error', onError);

    // Cloudflare guest peers can be locally ready before initNetwork attaches
    // this waiter. PeerJS normally opens asynchronously, but the transport
    // facade must tolerate either timing so setup never waits forever.
    if (newPeer.open && newPeer.id) {
      onOpen(newPeer.id);
      return;
    }

    setManagedTimer(
      'peer-open-timeout',
      () => onError(new Error('PEER_OPEN_TIMEOUT')),
      15000,
    );
  });

  setState('network.myId', id);
  log.info('[Network] Peer opened:', id);
  bus.emit('network:peer-ready', id);
  return id;
}

// Inject initNetwork into guest.ts (late binding to avoid circular dep)
setInitNetwork(initNetwork);

// ─── Session Code ───────────────────────────────────────────────────

/**
 * Create a host session with a short 6-digit code.
 * Retries up to maxAttempts if ID is taken.
 */
export async function createHostSessionWithShortCode(maxAttempts = 12): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateSessionCode();
    try {
      await initNetwork(code);
      return code;
    } catch (err) {
      if (err && typeof err === 'object' && (err as Record<string, unknown>).type === 'id-taken') {
        continue;
      }
      throw err;
    }
  }
  throw new Error('SESSION_CODE_UNAVAILABLE');
}

// ─── Transport Event Setup ──────────────────────────────────────────

// ─── Signaling Reconnect ────────────────────────────────────────────
//
// Some transports do not auto-reconnect to their signaling server when the
// WebSocket drops — the application has to call reconnect() manually. Without this,
// a brief network blip leaves the peer stuck disconnected: existing data
// channels keep working (they're direct WebRTC) but new peers can't join
// because the signaling handshake is unavailable.
//
// We retry with exponential backoff. Each retry checks `peer.disconnected`
// before calling reconnect() — if a prior attempt already succeeded (or
// the user left the session), we bail and reset the counter.
//
// Backoff total: 1+2+4+8+15 = 30s across 5 attempts. After that we give up
// and let the existing 5s grace dialog (peer.on('disconnected') below)
// surface the failure to the user IF data channels are also dead. If data
// channels are still alive, we silently degrade: existing playback works,
// just no new joins.
let _reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

function attemptPeerReconnect(): void {
  const peer = getPeer();
  if (!peer || peer.destroyed) {
    _reconnectAttempts = 0;
    return;
  }
  if (!peer.disconnected) {
    if (_reconnectAttempts > 0) {
      log.info('[Transport] Signaling reconnected');
    }
    _reconnectAttempts = 0;
    return;
  }
  if (_reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log.warn(
      `[Transport] Gave up on signaling reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts — new peers can't join until session restart`,
    );
    return;
  }

  const delay = RECONNECT_BACKOFF_MS[_reconnectAttempts] ?? 15000;
  _reconnectAttempts++;
  log.info(
    `[Transport] Scheduling signaling reconnect attempt ${_reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
  );

  setManagedTimer(
    'peer-signaling-reconnect',
    () => {
      const p = getPeer();
      if (!p || p.destroyed) {
        _reconnectAttempts = 0;
        return;
      }
      if (!p.disconnected) {
        log.info('[Transport] Already reconnected before scheduled attempt');
        _reconnectAttempts = 0;
        return;
      }
      log.info(`[Transport] Calling reconnect() (attempt ${_reconnectAttempts})`);
      try {
        if (p.reconnect) p.reconnect();
      } catch (e) {
        log.warn('[Transport] reconnect() threw:', (e as Error)?.message ?? e);
      }
      // Recurse to check after the next backoff window. If reconnect() actually
      // succeeded, this next call sees !peer.disconnected and resets the counter.
      attemptPeerReconnect();
    },
    delay,
  );
}

function setupPeerEvents(): void {
  const peer = getPeer();
  if (!peer) return;

  peer.on('error', (err: unknown) => {
    log.error('[Transport] Error:', err);
    const appRole = getState('network.appRole');
    const hostConn = getState('network.hostConn');

    // During initialization (no role set yet), errors are handled by the
    // initNetwork promise chain — don't emit duplicate error events.
    if (!appRole) return;

    if (appRole === 'host' && !hostConn) {
      if (err && typeof err === 'object' && (err as Record<string, unknown>).type === 'id-taken') {
        return; // Handled by retry loop
      }
      bus.emit('network:error', err);
    } else if (appRole === 'guest') {
      // Surface peer-level errors for guests too (e.g. network-offline, server-error)
      log.warn('[Transport] Guest peer error surfaced:', err);
      bus.emit('network:error', err);
    }
  });

  peer.on('disconnected', () => {
    log.warn('[Transport] Disconnected from signaling server');

    // Auto-reconnect: the active transport may not reconnect to its signaling server on
    // its own. Without this, a brief network blip permanently breaks
    // "new peer can join" until the user reloads. We retry with backoff;
    // existing data channels keep working throughout.
    _reconnectAttempts = 0; // fresh budget per disconnect event
    attemptPeerReconnect();

    // The transport 'disconnected' event fires when the WebSocket to the signaling server
    // drops. CRITICAL: existing peer-to-peer data channels are direct WebRTC
    // and survive this — only NEW peer connections are blocked. So a
    // signaling drop alone does NOT mean the session is dead.
    //
    // The original e7c31d4 commit incorrectly assumed "other peers tear
    // down their data connections" on signaling drop, which produced a
    // false-positive dialog: signaling blip → 5s grace → dialog appears
    // even though host/guest data channels are still alive and audio is
    // playing fine.
    //
    // Refined trigger:
    //   1. appRole must be set (post-bootstrap).
    //   2. After 5s grace, peer.disconnected must STILL be true.
    //   3. AND there must be no functional data connection (host: no live
    //      ConnectedPeer.conn; guest: hostConn closed). If either side
    //      still has a working channel, the session is functional and
    //      the user shouldn't be bounced to a reload.
    const appRole = getState('network.appRole');
    if (!appRole) return;

    setManagedTimer(
      'peer-disconnect-grace',
      () => {
        const currentPeer = getPeer();
        if (!currentPeer || !currentPeer.disconnected) return; // signaling recovered

        // Skip the dialog if we still have a working channel — the session
        // is functional even without signaling (no new peers can join, but
        // sync/playback for existing peers continues normally).
        const role = getState('network.appRole');
        if (role === 'host') {
          const peers = getState('network.connectedPeers') || [];
          const hasLive = peers.some((p) => (p.conn as DataConnection)?.open);
          if (hasLive) {
            log.info(
              '[Transport] Signaling disconnected but host has live data channels — skipping dialog',
            );
            return;
          }
        } else if (role === 'guest') {
          const hostConn = getState('network.hostConn');
          if (hostConn?.open) {
            log.info(
              '[Transport] Signaling disconnected but guest hostConn still open — skipping dialog',
            );
            return;
          }
        }

        showDialog({
          title: t('network.disconnected'),
          message: t('dialog.session_lost_msg'),
          buttonText: t('dialog.session_lost_btn'),
        }).then((res) => {
          if (res.action !== 'ok') return; // ESC / background dismiss
          markIntentionalNav();
          window.location.reload();
        });
      },
      5000,
    );
  });

  // System Audio: handle incoming media calls (WebRTC audio stream)
  peer.on('call', (mediaConn: unknown) => {
    const mc = mediaConn as IncomingMediaConnection;
    const type = mc.metadata?.type;
    if (isSystemAudioCallType(type)) {
      if (!isTrustedSystemAudioMediaCall(mc)) {
        log.warn('[Transport] Rejected system-audio media call from non-host peer');
        closeIncomingMediaCall(mc);
        return;
      }

      bus.emit('system-audio:incoming-call', mediaConn, getSystemAudioCallChannel(type, mc.metadata));
      return;
    }

    closeIncomingMediaCall(mc);
  });

  peer.on('connection', (conn: DataConnection) => {
    const appRole = getState('network.appRole');
    if (appRole !== 'host') {
      try {
        conn.close();
      } catch {
        /* noop */
      }
      return;
    }
    handleHostIncomingConnection(conn);
  });
}

// ─── Leave / Cleanup ────────────────────────────────────────────────

/**
 * Leave the current session and clean up all network state.
 */
export function leaveSession(): void {
  log.debug('[Network] Leaving session — full cleanup...');

  setState('network.isIntentionalDisconnect', true);

  // ── 0. Stop system audio sharing ──
  bus.emit('system-audio:force-stop');

  // ── 1. Stop all background timers ──
  // Guest started the worker `'sync'` timer on session join (guest.ts:220);
  // without an explicit STOP, the worker keeps ticking after leave and the
  // tick handler runs every second as a guarded noop (hostConn=null). Tell
  // the worker to drop the timer so the noop traffic stops.
  stopWorkerTimer('sync');
  clearAllManagedTimers();

  // ── 2. Stop media playback ──
  bus.emit('player:stop-all-media');

  // ── 3. Close network connections ──
  const hostConn = getState('network.hostConn');
  if (hostConn) {
    try {
      hostConn.close();
    } catch {
      /* noop */
    }
  }

  const connectedPeers = getState('network.connectedPeers');
  connectedPeers.forEach((p) => {
    try {
      const conn = p.conn as DataConnection | null;
      if (conn) conn.close();
    } catch {
      /* noop */
    }
  });

  // Destroy peer AFTER all connections are closed
  const peer = getPeer();
  if (peer) {
    try {
      peer.destroy();
    } catch {
      /* noop */
    }
    setPeer(null);
  }

  // ── 4. Clear peer slots and maps ──
  setState('network.activeHostConnByPeerId', new Map());
  setState('network.peerSlotByPeerId', new Map());
  setState('network.peerSlots', Array(DEFAULT_MAX_GUEST_SLOTS + 1).fill(null) as (string | null)[]);

  // ── 5. Clear transfer state ──
  // Note: file/preload reorder buffers are module-local in transfer.ts/preload.ts
  // Clear the state-managed preload session state (correct key: preload.sessionState)
  setState('preload.sessionState', new Map());
  setState('preload.ackSent', new Set());

  // ── 6. Revoke blob URLs ──
  bus.emit('blob:revoke-all');

  // ── 7. Reset all state ──
  batchSetState({
    // Network
    'network.appRole': 'idle',
    'network.myId': null,
    'network.myDeviceLabel': 'HOST',
    'network.hostConn': null,
    'network.connectedPeers': [],
    'network.isOperator': false,
    'network.isConnecting': false,
    'network.connectionType': 'unknown',
    'network.lastKnownDeviceList': null,
    'network.peerLabels': {},
    // Note: isIntentionalDisconnect is NOT reset here — async close handlers
    // may read it after batchSetState. Reset via delayed timer below.
    'network.sessionCode': '',
    'network.peerSlots': Array(DEFAULT_MAX_GUEST_SLOTS + 1).fill(null) as (string | null)[],
    'network.maxGuestSlots': DEFAULT_MAX_GUEST_SLOTS,
    'network.mutedPeers': new Set<string>(),
    'network.chatFrozen': false,
    'network.slowmodeSeconds': 0,
    'network.filterEnabled': false,
    // Playlist
    'playlist.items': [],
    'playlist.currentTrackIndex': -1,
    'preload.nextTrackIndex': -1,
    // Transfer
    'transfer.meta': null,
    'transfer.state': TRANSFER_STATE.IDLE,
    'transfer.receivedCount': 0,
    'transfer.localSessionId': 0,
    'transfer.currentSessionId': 0,
    'transfer.activeBroadcastSession': null,
    // Reset stale-chunk burst detection counters so a reconnect doesn't
    // carry over a mid-burst window from the prior session and trip the
    // early-recovery heuristic prematurely on its first post-reconnect chunk.
    'transfer.staleChunkBurstStart': 0,
    'transfer.staleChunkBurstCount': 0,
    // Recovery
    'recovery.pending': false,
    'recovery.retryCount': 0,
    // Files
    'files.currentFileBlob': null,
    'files.currentTrack': { name: null },
    // Preload
    'preload.nextFileBlob': null,
    'preload.meta': null,
    // Playback lifecycle (new state machine — reset on session leave)
    'playback.lifecycle': PLAYBACK_STATE.IDLE,
    'playback.loadSource': null,
    'playback.pendingPlayTime': undefined,
    'playback.pendingPlayTimeSetAt': 0,
    'playback.pendingPausedAt': undefined,
    'playback.pendingRecoveryTarget': null,
    'playback.failedTrackKeys': new Set<string>(),
    // Sync
    'sync.localOffset': 0,
    // Player
    'player.pausedAt': 0,
    // YouTube
    'youtube.subItemsMap': {},
    // App state
    appState: APP_STATE.IDLE,
  });

  // ── 8. Reset UI ──
  setState('appState', APP_STATE.IDLE);

  // Delayed reset: allow async close handlers to read the flag first
  setManagedTimer(
    'intentional-disconnect-reset',
    () => setState('network.isIntentionalDisconnect', false),
    200,
  );

  log.debug('[Network] Session left — full cleanup complete.');
}

// ─── Bus Event Handlers ─────────────────────────────────────────

bus.on('network:broadcast', (data) => {
  if (data) broadcast(data as AnyProtocolMsg);
});

bus.on('network:broadcast-except', (peerId, data) => {
  if (data) broadcastExcept(peerId, data as AnyProtocolMsg);
});

// ─── Init Peer Protocol Handlers ──────────────────────────────────

export function initPeerHandlers(): void {
  initGuestProtocolHandlers();
  log.info('[Peer] Protocol handlers registered');
}
