/**
 * MUSIXQUARE 3.0 — PeerJS Coordinator
 *
 * Orchestrates: network initialization, PeerJS event wiring, session cleanup.
 * Re-exports public API from peer-state.ts, host.ts, guest.ts so that
 * external imports from '../network/peer.ts' continue to work unchanged.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState, batchSetState } from '../core/state.ts';
import { MSG, DEFAULT_MAX_GUEST_SLOTS, APP_STATE, TRANSFER_STATE } from '../core/constants.ts';
import { clearAllManagedTimers, setManagedTimer } from '../core/timers.ts';
import { stopBackgroundWorkerTimers } from '../storage/opfs.ts';
import type { DataConnection, AnyProtocolMsg } from '../types/index.ts';

import { Peer, type PeerOptions } from 'peerjs';

// ─── Sub-module imports (only names used locally in this file) ───────

import {
  getPeer,
  setPeer,
  generateSessionCode,
  broadcast,
  broadcastExcept,
} from './peer-state.ts';

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
  hasActiveRelay,
  waitForGuestConnectionType,
} from './peer-state.ts';

export { joinSession } from './guest.ts';

// ─── Network Initialization ─────────────────────────────────────────

/**
 * Initialize PeerJS with optional requested ID.
 * Returns the assigned peer ID.
 */
export async function initNetwork(requestedId: string | null = null): Promise<string> {
  if (typeof Peer === 'undefined') {
    log.error('[Network] PeerJS not found on window.');
    throw new Error('PEERJS_NOT_LOADED');
  }

  // Clean up existing peer instance
  const oldPeer = getPeer();
  if (oldPeer) {
    try { oldPeer.destroy(); } catch { /* noop */ }
    setPeer(null);
  }

  // ICE servers: STUN always, TURN only for remote (Metered.ca via Netlify Function)
  const iceServers: Record<string, unknown>[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
  ];

  // Fetch TURN credentials from Netlify Function
  // Try relative path first (same-origin Netlify), then absolute URL fallback (Toss in-app etc.)
  const turnEndpoints = [
    '/.netlify/functions/get-turn-config',
    'https://musixquare.netlify.app/.netlify/functions/get-turn-config',
  ];

  for (const url of turnEndpoints) {
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const { username, credential } = await resp.json() as { username: string; credential: string };
        if (username && credential) {
          iceServers.push(
            { urls: 'turn:standard.relay.metered.ca:443', username, credential },
            { urls: 'turn:standard.relay.metered.ca:443?transport=tcp', username, credential },
            { urls: 'turns:standard.relay.metered.ca:443?transport=tcp', username, credential },
          );
          log.info('[Network] TURN credentials loaded (Metered.ca)');
          break;
        }
      }
    } catch {
      // Try next endpoint
    }
  }
  if (iceServers.length <= 2) {
    log.debug('[Network] TURN config unavailable — STUN only');
  }

  const peerOpts: PeerOptions = {
    debug: 2,
    config: {
      iceServers,
      sdpSemantics: 'unified-plan',
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 0,
    },
  };

  // Allow custom PeerJS signaling server injection
  const customPeerServer = (window as unknown as Record<string, unknown>).__MUSIXQUARE_PEER_SERVER__ as
    Record<string, unknown> | undefined;
  if (customPeerServer && typeof customPeerServer === 'object') {
    if (customPeerServer.host) peerOpts.host = customPeerServer.host as string;
    if (customPeerServer.port) peerOpts.port = customPeerServer.port as number;
    if (customPeerServer.path) peerOpts.path = customPeerServer.path as string;
    if (typeof customPeerServer.secure === 'boolean') peerOpts.secure = customPeerServer.secure;
    if (customPeerServer.key) peerOpts.key = customPeerServer.key as string;
  }

  const newPeer = requestedId ? new Peer(requestedId, peerOpts) : new Peer(peerOpts);
  setPeer(newPeer);
  setupPeerEvents();

  // Wait for open (or fail fast on error)
  const id = await new Promise<string>((resolve, reject) => {
    const onOpen = (id: string) => { newPeer.off('open', onOpen); newPeer.off('error', onError); resolve(id); };
    const onError = (err: unknown) => { newPeer.off('open', onOpen); newPeer.off('error', onError); reject(err); };
    newPeer.on('open', onOpen);
    newPeer.on('error', onError);
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

// ─── PeerJS Event Setup ─────────────────────────────────────────────

function setupPeerEvents(): void {
  const peer = getPeer();
  if (!peer) return;

  peer.on('error', (err: unknown) => {
    log.error('[PeerJS] Error:', err);
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
      log.warn('[PeerJS] Guest peer error surfaced:', err);
      bus.emit('network:error', err);
    }
  });

  peer.on('disconnected', () => {
    log.warn('[PeerJS] Disconnected from signaling server');
  });

  // System Audio: handle incoming media calls (WebRTC audio stream)
  peer.on('call', (mediaConn: unknown) => {
    const mc = mediaConn as { metadata?: Record<string, unknown>; close: () => void };
    if (mc.metadata?.type === 'system-audio' || mc.metadata?.type === 'system-audio-dual') {
      const channel = mc.metadata.type === 'system-audio-dual' ? 'DUAL' : ((mc.metadata.channel as string) || 'L');
      bus.emit('system-audio:incoming-call', mediaConn, channel);
    } else {
      try { mc.close(); } catch { /* noop */ }
    }
  });

  peer.on('connection', (conn: DataConnection) => {
    // Check if this is a relay connection from a downstream peer
    const connMeta = conn.metadata as Record<string, unknown> | undefined;
    if (connMeta?.type === MSG.DATA_RELAY) {
      // Route to relay handler via bus (any peer can be a relay node)
      bus.emit('relay:incoming-connection', conn);
      return;
    }

    const appRole = getState('network.appRole');
    if (appRole !== 'host') {
      try { conn.close(); } catch { /* noop */ }
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
  stopBackgroundWorkerTimers();
  clearAllManagedTimers();

  // ── 2. Stop media playback ──
  bus.emit('player:stop-all-media');

  // ── 3. Close network connections ──
  const hostConn = getState('network.hostConn');
  if (hostConn) {
    try { hostConn.close(); } catch { /* noop */ }
  }

  const connectedPeers = getState('network.connectedPeers');
  connectedPeers.forEach(p => {
    try {
      const conn = p.conn as DataConnection | null;
      if (conn) conn.close();
    } catch { /* noop */ }
  });

  // Close upstream relay connection (guest→relay link)
  const upstreamDataConn = getState('relay.upstreamDataConn');
  if (upstreamDataConn) {
    try { upstreamDataConn.close(); } catch { /* noop */ }
  }

  // Close downstream relay connections
  const downstreamDataPeers = getState('relay.downstreamDataPeers');
  downstreamDataPeers.forEach(p => {
    try { p.close(); } catch { /* noop */ }
  });

  // Destroy peer AFTER all connections are closed
  const peer = getPeer();
  if (peer) {
    try { peer.destroy(); } catch { /* noop */ }
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
    // Relay
    'relay.upstreamDataConn': null,
    'relay.downstreamDataPeers': [],
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
    'transfer.skipIncomingFile': false,
    'transfer.waitingForPreload': false,
    // Recovery
    'recovery.pending': false,
    'recovery.retryCount': 0,
    'recovery.pendingFileName': '',
    'recovery.pendingFileIndex': undefined,
    // Files
    'files.currentFileBlob': null,
    'files.currentFileOpfs': { name: null },
    // Preload
    'preload.nextFileBlob': null,
    'preload.meta': null,
    // Sync
    'sync.localOffset': 0,
    'sync.autoSyncOffset': 0,
    // Player
    'player.pausedAt': 0,
    // YouTube
    'youtube.subItemsMap': {},
    // App state
    'appState': APP_STATE.IDLE,
  });

  // ── 8. Reset UI ──
  setState('appState', APP_STATE.IDLE);

  // Delayed reset: allow async close handlers to read the flag first
  setManagedTimer('intentional-disconnect-reset', () => setState('network.isIntentionalDisconnect', false), 200);

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
