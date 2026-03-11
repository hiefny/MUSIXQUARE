/**
 * MUSIXQUARE 3.0 — PeerJS Initialization & Connection Management
 *
 * Manages: PeerJS instance, session creation/joining, peer slot allocation,
 * host incoming connections, guest outbound connection, leave/cleanup.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState, batchSetState } from '../core/state.ts';
import { MSG, DEFAULT_MAX_GUEST_SLOTS, PEER_NAME_PREFIX, APP_STATE, TRANSFER_STATE } from '../core/constants.ts';
import { clearAllManagedTimers, setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { registerHandlers } from './protocol.ts';
import { stopBackgroundWorkerTimers } from '../storage/opfs.ts';
import type { DataConnection, PeerInstance, DeviceInfo, AnyProtocolMsg } from '../types/index.ts';

import { Peer, type PeerOptions } from 'peerjs';

// ─── Module-scoped state ────────────────────────────────────────────
let peer: PeerInstance | null = null;

// ─── Public Getters ─────────────────────────────────────────────────
export function getPeer(): PeerInstance | null { return peer; }

// ─── ICE Connection Type Detection ──────────────────────────────────

async function detectConnectionType(conn: DataConnection): Promise<'local' | 'remote'> {
  try {
    const pc = conn.peerConnection as RTCPeerConnection | undefined;
    if (!pc) return 'remote';

    const stats = await pc.getStats();
    for (const report of stats.values()) {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        const localCandidate = stats.get(report.localCandidateId);
        const remoteCandidate = stats.get(report.remoteCandidateId);

        const localType = localCandidate?.candidateType;
        const remoteType = remoteCandidate?.candidateType;

        log.info(`[Peer] ICE: local=${localType}, remote=${remoteType}`);

        // If either side uses relay (TURN), it's remote
        if (localType === 'relay' || remoteType === 'relay') return 'remote';
        // Both sides host = same LAN
        if (localType === 'host' && remoteType === 'host') return 'local';
        // srflx (STUN) = different networks
        return 'remote';
      }
    }
  } catch {
    log.debug('[Peer] ICE stats unavailable, assuming remote');
  }
  return 'remote';
}

// ─── Peer Slot Management ───────────────────────────────────────────

function getPeerLabelBySlot(slot: number): string {
  return `${PEER_NAME_PREFIX} ${slot}`;
}

function getAvailablePeerSlot(preferredSlot: number | null, peerId: string | null): number | null {
  const peerSlots = getState('network.peerSlots');
  const maxSlots = getState('network.maxGuestSlots');
  const pref = Number(preferredSlot);
  if (Number.isInteger(pref) && pref >= 1 && pref <= maxSlots) {
    const occupant = peerSlots[pref];
    if (!occupant || occupant === peerId) return pref;
  }
  for (let i = 1; i <= maxSlots; i++) {
    if (!peerSlots[i]) return i;
  }
  return null;
}

function assignPeerSlot(peerId: string, slot: number): void {
  if (!peerId) return;
  const s = Number(slot);
  const maxSlots = getState('network.maxGuestSlots');
  if (!Number.isInteger(s) || s < 1 || s > maxSlots) return;
  const peerSlots = [...getState('network.peerSlots')];
  peerSlots[s] = peerId;
  setState('network.peerSlots', peerSlots);
  const map = new Map(getState('network.peerSlotByPeerId'));
  map.set(peerId, s);
  setState('network.peerSlotByPeerId', map);
}

function releasePeerSlot(peerId: string): void {
  if (!peerId) return;
  const map = getState('network.peerSlotByPeerId');
  const slot = map.get(peerId);
  if (slot) {
    const peerSlots = [...getState('network.peerSlots')];
    if (peerSlots[slot] === peerId) {
      peerSlots[slot] = null;
      setState('network.peerSlots', peerSlots);
    }
  }
  const updated = new Map(map);
  updated.delete(peerId);
  setState('network.peerSlotByPeerId', updated);
}

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
  if (peer) {
    try { peer.destroy(); } catch { /* noop */ }
    peer = null;
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

  peer = requestedId ? new Peer(requestedId, peerOpts) : new Peer(peerOpts);
  setupPeerEvents();

  // Wait for open (or fail fast on error)
  const id = await new Promise<string>((resolve, reject) => {
    const onOpen = (id: string) => { peer!.off('open', onOpen); peer!.off('error', onError); resolve(id); };
    const onError = (err: unknown) => { peer!.off('open', onOpen); peer!.off('error', onError); reject(err); };
    peer!.on('open', onOpen);
    peer!.on('error', onError);
  });

  setState('network.myId', id);
  log.info('[Network] Peer opened:', id);
  bus.emit('network:peer-ready', id);
  return id;
}

// ─── Session Code ───────────────────────────────────────────────────

function generateSessionCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

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
  if (!peer) return;

  peer.on('error', (err: unknown) => {
    log.error('[PeerJS] Error:', err);
    const appRole = getState('network.appRole');
    const hostConn = getState('network.hostConn');

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

// ─── Host: Incoming Connection ──────────────────────────────────────

function handleHostIncomingConnection(conn: DataConnection): void {
  const peerId = conn.peer;
  const connectedPeers = getState('network.connectedPeers');
  const activeHostConnByPeerId = getState('network.activeHostConnByPeerId');

  // Duplicate connection handling
  const existingActiveConn = activeHostConnByPeerId.get(peerId);
  if (existingActiveConn && existingActiveConn !== conn) {
    activeHostConnByPeerId.set(peerId, conn);
    try {
      if (existingActiveConn.open) {
        existingActiveConn.send({ type: MSG.FORCE_CLOSE_DUPLICATE });
      }
    } catch { /* noop */ }
    try { existingActiveConn.close(); } catch { /* noop */ }
  }

  // Remove lingering peer object with same id
  const filtered = connectedPeers.filter(p => p.id !== peerId);
  setState('network.connectedPeers', filtered);

  // Enforce max guests
  const maxGuestSlots = getState('network.maxGuestSlots');
  if (filtered.length >= maxGuestSlots) {
    const sendFullAndClose = () => {
      try {
        conn.send({
          type: MSG.SESSION_FULL,
          message: t('network.session_full_detail'),
        });
      } catch { /* noop */ }
      setTimeout(() => { try { conn.close(); } catch { /* noop */ } }, 500);
    };
    if (conn.open) sendFullAndClose();
    else conn.on('open', sendFullAndClose);
    return;
  }

  // Allocate slot
  const peerSlotByPeerId = getState('network.peerSlotByPeerId');
  const preferredSlot = peerSlotByPeerId.get(peerId) || null;
  const slot = getAvailablePeerSlot(preferredSlot, peerId);
  if (!slot) {
    const sendFullAndClose = () => {
      try { conn.send({ type: MSG.SESSION_FULL, message: t('network.session_full_detail') }); } catch { /* noop */ }
      try { conn.close(); } catch { /* noop */ }
    };
    if (conn.open) sendFullAndClose();
    else conn.on('open', sendFullAndClose);
    return;
  }
  assignPeerSlot(peerId, slot);
  const deviceName = getPeerLabelBySlot(slot);

  // Track label (immutable update to trigger state events)
  setState('network.peerLabels', { ...getState('network.peerLabels'), [peerId]: deviceName });

  // New connection becomes active
  activeHostConnByPeerId.set(peerId, conn);

  const peerObj = {
    id: peerId,
    slot,
    label: deviceName,
    status: 'connecting' as string,
    conn,
    isOp: false,
    isDataTarget: false,
    joinOrder: slot,
    lastHeartbeat: Date.now(),
    preloadedIndexes: new Set<number>(),
    connectionType: 'unknown' as 'local' | 'remote' | 'unknown',
  };

  setState('network.connectedPeers', [...getState('network.connectedPeers'), peerObj]);

  conn.on('open', () => {
    peerObj.status = 'connected';
    peerObj.lastHeartbeat = Date.now();
    // Trigger state event after in-place mutation
    setState('network.connectedPeers', [...getState('network.connectedPeers')]);

    // Welcome message with host-assigned label
    try {
      conn.send({
        type: MSG.WELCOME,
        lockChannel: false,
        label: deviceName,
      });
    } catch { /* noop */ }

    bus.emit('ui:show-toast', t('toast.device_connected', { name: deviceName }));
    bus.emit('chat:system-message', t('chat.peer_connected', { name: deviceName }));

    // Emit event for other modules to send late-join bootstrap data
    bus.emit('network:peer-connected', conn);

    // Detect local vs remote for this guest after ICE stabilizes
    setTimeout(async () => {
      const type = await detectConnectionType(conn);
      const peers = getState('network.connectedPeers');
      const livePeer = peers.find(p => p.id === peerId);
      if (livePeer) {
        livePeer.connectionType = type;
        setState('network.connectedPeers', [...peers]);
      }
      log.info(`[Host] ${deviceName} connection type: ${type}`);
      broadcastDeviceList();
      bus.emit('orchestrator:peer-type-detected', peerId);

      // Re-detect after 10s if classified as 'remote' (ICE may not have stabilized at 1.5s)
      if (type === 'remote' && conn.open) {
        setTimeout(async () => {
          if (!conn.open) return;
          const recheck = await detectConnectionType(conn);
          if (recheck === 'local') {
            const ps = getState('network.connectedPeers');
            const p = ps.find(x => x.id === peerId);
            if (p && p.connectionType !== 'local') {
              p.connectionType = 'local';
              setState('network.connectedPeers', [...ps]);
              log.info(`[Host] ${deviceName} reclassified as local on re-detection`);
              broadcastDeviceList();
              bus.emit('orchestrator:peer-type-detected', peerId);
            }
          }
        }, 8500);
      }
    }, 1500);

    // Broadcast updated device list to all peers
    broadcastDeviceList();
    bus.emit('network:role-badge-update');
    log.info(`[Host] ${deviceName} connected (peer: ${peerId})`);
  });

  conn.on('data', (data: unknown) => {
    try { bus.emit('network:data', data, conn); }
    catch (e) { log.error('[Host] Error in handleData', e); }
  });

  conn.on('close', () => {
    log.info(`[Host] Connection closed: ${peerId}`);

    // Ignore stale close events from replaced duplicate connections
    if (activeHostConnByPeerId.get(peerId) !== conn) return;

    activeHostConnByPeerId.delete(peerId);
    releasePeerSlot(peerId);

    const peerLabelsOnClose = getState('network.peerLabels');
    if (peerLabelsOnClose) {
      delete peerLabelsOnClose[peerId];
    }

    const peers = getState('network.connectedPeers');
    setState('network.connectedPeers', peers.filter(p => p.id !== peerId));

    bus.emit('network:peer-disconnected', peerId);
    broadcastDeviceList();

    const sessionStarted = getState('setup.sessionStarted');
    if (sessionStarted) {
      bus.emit('ui:show-toast', t('toast.device_disconnected', { name: deviceName }));
      bus.emit('chat:system-message', t('chat.peer_disconnected', { name: deviceName }));
    }
    log.info(`[Host] ${deviceName} disconnected`);
  });

  conn.on('error', (err: unknown) => {
    log.error('[Host] Connection error:', err);

    if (activeHostConnByPeerId.get(peerId) !== conn) {
      try { conn.close(); } catch { /* noop */ }
      return;
    }

    activeHostConnByPeerId.delete(peerId);
    releasePeerSlot(peerId);

    const peerLabelsOnError = getState('network.peerLabels');
    if (peerLabelsOnError) {
      delete peerLabelsOnError[peerId];
    }

    const peers = getState('network.connectedPeers');
    setState('network.connectedPeers', peers.filter(p => p.id !== peerId));

    bus.emit('network:peer-disconnected', peerId);
    broadcastDeviceList();

    const sessionStarted = getState('setup.sessionStarted');
    if (sessionStarted) {
      bus.emit('ui:show-toast', t('toast.device_conn_error', { name: deviceName }));
      bus.emit('chat:system-message', t('chat.peer_disconnected', { name: deviceName }));
    }
    try { conn.close(); } catch { /* noop */ }
  });
}

// ─── Guest: Join Session ────────────────────────────────────────────

/**
 * Connect to a host session as a guest.
 */
export function joinSession(hostId: string, retryAttempt = 0): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) {
    if (hostConn.open) {
      log.warn('[Join] Already connected to host.');
      return;
    }
    try { hostConn.close(); } catch { /* noop */ }
    setState('network.hostConn', null);
  }

  if (!hostId) {
    bus.emit('network:error', new Error('NO_HOST_ID'));
    return;
  }

  setState('network.lastJoinCode', hostId);

  // Ensure peer exists and is open
  if (!peer) {
    if (retryAttempt > 3) {
      bus.emit('network:error', new Error('NETWORK_INIT_FAILED'));
      return;
    }
    initNetwork(null)
      .then(() => joinSession(hostId, retryAttempt + 1))
      .catch((e) => {
        log.error('[Join] Failed to init peer', e);
        bus.emit('network:error', new Error('NETWORK_INIT_FAILED'));
      });
    return;
  }

  if (!peer.open) {
    if (retryAttempt < 10) {
      setManagedTimer('join-retry', () => joinSession(hostId, retryAttempt + 1), 300);
    } else {
      bus.emit('network:error', new Error('PEER_NOT_READY'));
    }
    return;
  }

  setState('network.isConnecting', true);

  let conn: DataConnection;
  try {
    const channelMode = getState('audio.channelMode');
    conn = peer.connect(hostId, {
      reliable: true,
      metadata: { label: `mode-${channelMode}` },
    });
  } catch (e) {
    log.error('[Join] peer.connect failed', e);
    setState('network.isConnecting', false);
    bus.emit('network:error', new Error('CONNECT_FAILED'));
    return;
  }

  // Own flag — don't trust conn.open (PeerJS can set it true before 'open' event fires)
  let dataChannelOpened = false;

  // Timeout if host is unreachable (15s to allow TURN relay negotiation)
  setManagedTimer('join-timeout', () => {
    if (dataChannelOpened || getState('network.hostConn')) return;
    log.warn('[Join] Connection timeout — data channel did not open in 15s');
    try { conn.close(); } catch { /* noop */ }
    setState('network.isConnecting', false);
    bus.emit('network:error', new Error('HOST_UNREACHABLE'));
  }, 15000);

  conn.on('open', () => {
    dataChannelOpened = true;
    clearManagedTimer('join-timeout');
    log.info('[Join] Connected to host:', hostId);

    setState('network.hostConn', conn);
    setState('network.isConnecting', false);

    // Deduplicate error/close handlers
    (conn as unknown as Record<string, unknown>)._errorHandled = false;

    conn.on('data', (data: unknown) => {
      bus.emit('network:data', data, conn);
    });

    conn.on('close', () => {
      log.warn('[Join] Host connection closed');
      setState('network.hostConn', null);
      setState('network.isConnecting', false);

      if ((conn as unknown as Record<string, unknown>)._errorHandled) {
        // Don't reset isIntentionalDisconnect — the error handler already
        // determined intent. Resetting unconditionally here would mask
        // intentional disconnects (e.g. leaveSession) that race with close.
        return;
      }
      (conn as unknown as Record<string, unknown>)._errorHandled = true;

      const isIntentional = getState('network.isIntentionalDisconnect');
      if (!isIntentional) {
        bus.emit('network:error', new Error('HOST_DISCONNECTED'));
      }
      setState('network.isIntentionalDisconnect', false);
    });

    conn.on('error', (err: unknown) => {
      log.error('[Join] Host connection error', err);
      setState('network.hostConn', null);
      setState('network.isConnecting', false);

      if ((conn as unknown as Record<string, unknown>)._errorHandled) return;
      (conn as unknown as Record<string, unknown>)._errorHandled = true;

      bus.emit('network:error', new Error('HOST_CONNECTION_ERROR'));
    });

    // Start heartbeat & ping timers for guest
    bus.emit('worker:sync-command', { command: 'START_TIMER', id: 'heartbeat', interval: 1000 });
    bus.emit('worker:sync-command', { command: 'START_TIMER', id: 'ping', interval: 2000 });

    // Detect local vs remote connection after ICE stabilizes
    setTimeout(async () => {
      const type = await detectConnectionType(conn);
      setState('network.connectionType', type);
      log.info(`[Peer] Connection type: ${type}`);
      bus.emit('network:role-badge-update');

      // Re-detect after 10s if classified as 'remote' (ICE may not have stabilized at 1.5s)
      if (type === 'remote' && conn.open) {
        setTimeout(async () => {
          if (!conn.open) return;
          const recheck = await detectConnectionType(conn);
          if (recheck === 'local' && getState('network.connectionType') !== 'local') {
            setState('network.connectionType', 'local');
            log.info('[Peer] Reclassified as local on re-detection');
            bus.emit('network:role-badge-update');
          }
        }, 8500);
      }
    }, 1500);

    bus.emit('network:peer-connected', conn);
    bus.emit('setup:guest-join-success');
  });
}

// ─── Leave / Cleanup ────────────────────────────────────────────────

/**
 * Leave the current session and clean up all network state.
 */
export function leaveSession(): void {
  log.debug('[Network] Leaving session — full cleanup...');

  setState('network.isIntentionalDisconnect', true);

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

  // Close downstream relay connections
  const downstreamDataPeers = getState('relay.downstreamDataPeers');
  downstreamDataPeers.forEach(p => {
    try { p.close(); } catch { /* noop */ }
  });

  // Destroy peer AFTER all connections are closed
  if (peer) {
    try { peer.destroy(); } catch { /* noop */ }
    peer = null;
  }

  // ── 4. Clear peer slots and maps ──
  const activeHostConnByPeerId = getState('network.activeHostConnByPeerId');
  const peerSlotByPeerId = getState('network.peerSlotByPeerId');
  activeHostConnByPeerId.clear();
  peerSlotByPeerId.clear();
  setState('network.peerSlots', Array(DEFAULT_MAX_GUEST_SLOTS + 1).fill(null) as (string | null)[]);

  // ── 5. Clear transfer state ──
  // Note: file/preload reorder buffers are module-local in transfer.ts/preload.ts
  // Clear the state-managed preload session state (correct key: preload.sessionState)
  const preloadSessionState = getState('preload.sessionState');
  if (preloadSessionState) preloadSessionState.clear();
  const ackSent = getState('preload.ackSent');
  if (ackSent) ackSent.clear();

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
    // Preload
    'preload.nextFileBlob': null,
    'preload.meta': null,
    // Sync
    'sync.localOffset': 0,
    'sync.autoSyncOffset': 0,
    // Player
    'player.pausedAt': 0,
    // App state
    'appState': APP_STATE.IDLE,
  });

  // ── 8. Reset UI ──
  bus.emit('ui:update-playlist');
  bus.emit('player:state-changed', APP_STATE.IDLE);

  // Delayed reset: allow async close handlers to read the flag first
  setTimeout(() => setState('network.isIntentionalDisconnect', false), 200);

  log.debug('[Network] Session left — full cleanup complete.');
}

// ─── Broadcast Utilities ────────────────────────────────────────────

/**
 * Broadcast a message to all connected peers.
 */
export function broadcast(msg: AnyProtocolMsg, isDataOnly = false): void {
  const connectedPeers = getState('network.connectedPeers');
  connectedPeers.forEach(p => {
    try {
      if (p.status === 'connected' && p.conn) {
        const conn = p.conn as DataConnection;
        if (conn.open) {
          if (!isDataOnly || p.isDataTarget === true) {
            conn.send(msg);
          }
        }
      }
    } catch (e) {
      log.warn(`[broadcast] Send failed for peer ${p.label || p.id}:`, e);
    }
  });
}

/**
 * Broadcast to all peers except one (used for chat relays).
 */
export function broadcastExcept(excludePeerId: string, msg: AnyProtocolMsg, isDataOnly = false): void {
  const connectedPeers = getState('network.connectedPeers');
  connectedPeers.forEach(p => {
    try {
      if (p.status === 'connected' && p.conn) {
        const conn = p.conn as DataConnection;
        if (conn.open) {
          if (excludePeerId && p.id === excludePeerId) return;
          if (!isDataOnly || p.isDataTarget === true) {
            conn.send(msg);
          }
        }
      }
    } catch (e) {
      log.warn(`[broadcastExcept] Send failed for peer ${p.label || p.id}:`, e);
    }
  });
}

/**
 * Build and broadcast device list to all peers.
 */
export function broadcastDeviceList(): void {
  const myId = getState('network.myId');
  const connectedPeers = getState('network.connectedPeers');

  const list = [
    { id: myId, label: 'HOST', status: 'connected', isHost: true },
    ...connectedPeers
      .sort((a, b) => (a.joinOrder as number) - (b.joinOrder as number))
      .map(p => ({
        id: p.id,
        label: p.label,
        status: p.status,
        isHost: false,
        isOp: p.isOp,
        connectionType: (p.connectionType as string) || 'unknown',
      })),
  ];

  const msg = { type: MSG.DEVICE_LIST_UPDATE, list };
  broadcast(msg);
  bus.emit('network:device-list', list);
}

/**
 * Send a message to the host (guest-only helper).
 */
/**
 * Send a message to any DataConnection safely (try/catch + open check).
 */
export function safeSend(conn: DataConnection | null | undefined, msg: AnyProtocolMsg): boolean {
  if (!conn || !conn.open) return false;
  try {
    conn.send(msg);
    return true;
  } catch {
    return false;
  }
}

export function sendToHost(msg: AnyProtocolMsg): boolean {
  const hostConn = getState('network.hostConn');
  return safeSend(hostConn, msg);
}

// ─── Transport Guard (Remote File Transfer Blocking) ────────────

/**
 * Wait for a host-side peer's connectionType to resolve from 'unknown'.
 * Returns the resolved type, or 'remote' on timeout (safety default).
 */
let _peerConnTypeCounter = 0;
function waitForPeerConnectionType(
  peerObj: Record<string, unknown>,
  timeout: number,
): Promise<string> {
  const id = ++_peerConnTypeCounter;
  const intervalName = `peerConnType-interval-${id}`;
  const timeoutName = `peerConnType-timeout-${id}`;

  return new Promise(resolve => {
    const check = () => peerObj.connectionType as string | undefined;
    const current = check();
    if (current && current !== 'unknown') return resolve(current);

    const cleanup = () => {
      clearManagedTimer(intervalName);
      clearManagedTimer(timeoutName);
    };

    setManagedTimer(intervalName, () => {
      const val = check();
      if (val && val !== 'unknown') {
        cleanup();
        resolve(val);
      }
    }, 100, { interval: true });

    setManagedTimer(timeoutName, () => {
      cleanup();
      const final = check();
      resolve(!final || final === 'unknown' ? 'remote' : final);
    }, timeout);
  });
}

/**
 * Host-side transport guard: can we send file data to this peer?
 *
 * TURN cost policy: file data NEVER flows through TURN.
 * Only local (LAN) peers with isDataTarget=true receive file data from host.
 * Remote peers receive file data only via local relay peers, never from host.
 * TODO(pro): Pro tier could relax connectionType check for host-direct TURN.
 */
export async function canSendFileTo(conn: DataConnection): Promise<boolean> {
  if (!conn || !conn.open) return false;
  const connectedPeers = getState('network.connectedPeers');
  const peerObj = connectedPeers.find(p => p.conn === conn);
  if (!peerObj) return false;

  // Orchestrator controls isDataTarget: false = relay-served or no-data, true = host-direct
  if (peerObj.isDataTarget === false) return false;

  const type = peerObj.connectionType as string | undefined;

  // Only local peers can receive file data directly from host (no TURN)
  if (type === 'local') return true;

  // Remote peers: blocked — file data must not flow through TURN
  if (type === 'remote') return false;

  // unknown — wait for ICE detection (up to 3s)
  const resolved = await waitForPeerConnectionType(peerObj, 3000);
  if (!conn.open) return false;
  return resolved === 'local'; // unknown→remote will be handled by orchestrator later
}

/**
 * Host-side: filter connectedPeers to only those eligible for file data.
 *
 * TURN cost policy: double-gated by isDataTarget AND connectionType.
 * - isDataTarget must be true (set by orchestrator after ICE detection)
 * - connectionType must be 'local' (defense-in-depth against TURN leaks)
 * Remote peers NEVER appear here; they receive data only via local relay.
 * TODO(pro): Pro tier could remove connectionType gate for TURN fallback.
 */
export function filterEligiblePeers(): Array<Record<string, unknown>> {
  const connectedPeers = getState('network.connectedPeers');
  return connectedPeers.filter(p =>
    p.status === 'connected' &&
    (p.conn as DataConnection)?.open &&
    p.isDataTarget === true &&
    p.connectionType === 'local',
  );
}

/**
 * Guest-side: am I a remote guest? (remote or unknown = true)
 */
export function isRemoteGuest(): boolean {
  const connType = getState('network.connectionType');
  return connType === 'remote' || connType === 'unknown';
}

/**
 * Guest-side: do I have an active upstream relay connection?
 * Used to relax remote guards when relay is serving data.
 */
export function hasActiveRelay(): boolean {
  const up = getState('relay.upstreamDataConn');
  return !!(up && (up as DataConnection).open);
}

/**
 * Guest-side: wait for own connectionType to resolve from 'unknown'.
 * Returns 'remote' on timeout (safety default).
 */
let _guestConnTypeCounter = 0;
export function waitForGuestConnectionType(timeout: number): Promise<'local' | 'remote'> {
  const id = ++_guestConnTypeCounter;
  const intervalName = `guestConnType-interval-${id}`;
  const timeoutName = `guestConnType-timeout-${id}`;

  return new Promise(resolve => {
    const check = () => getState('network.connectionType');
    if (check() !== 'unknown') return resolve(check() as 'local' | 'remote');

    const cleanup = () => {
      clearManagedTimer(intervalName);
      clearManagedTimer(timeoutName);
    };

    setManagedTimer(intervalName, () => {
      if (check() !== 'unknown') {
        cleanup();
        resolve(check() as 'local' | 'remote');
      }
    }, 100, { interval: true });

    setManagedTimer(timeoutName, () => {
      cleanup();
      resolve(check() === 'unknown' ? 'remote' : check() as 'local' | 'remote');
    }, timeout);
  });
}

// ─── Bus Event Handlers ─────────────────────────────────────────

bus.on('network:broadcast', (data) => {
  if (data) broadcast(data as AnyProtocolMsg);
});

bus.on('network:broadcast-except', (peerId, data) => {
  if (data) broadcastExcept(peerId, data as AnyProtocolMsg);
});

// Host: Toggle operator permission on a peer
bus.on('network:toggle-operator', (peerId) => {
  if (!peerId) return;

  // Only Host can toggle operator
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  const connectedPeers = getState('network.connectedPeers');
  const idx = connectedPeers.findIndex(x => x.id === peerId);
  if (idx !== -1) {
    const p = connectedPeers[idx];
    const newOp = !p.isOp;
    const updated = connectedPeers.map((peer, i) => i === idx ? { ...peer, isOp: newOp } : peer);
    setState('network.connectedPeers', updated);
    const conn = p.conn as DataConnection;
    if (conn && conn.open) {
      try {
        conn.send({ type: newOp ? MSG.OPERATOR_GRANT : MSG.OPERATOR_REVOKE });
      } catch (e) {
        log.warn(`[OP] Failed to send operator status to ${peerId}:`, e);
      }
    } else {
      log.warn(`[OP] Cannot notify peer ${peerId} — connection not open`);
    }
    broadcastDeviceList();
    bus.emit('ui:show-toast', t('toast.op_status', { label: p.label, status: newOp ? t('common.granted') : t('common.revoked') }));
  }
});

// Host: Kick a connected peer from the session
bus.on('network:kick-device', (peerId) => {
  if (!peerId) return;

  // Only host can kick
  const hostConn = getState('network.hostConn');
  if (hostConn) return;

  const connectedPeers = getState('network.connectedPeers');
  const target = connectedPeers.find(x => x.id === peerId);
  if (!target) return;

  const conn = target.conn as DataConnection;
  if (conn && conn.open) {
    try { conn.send({ type: MSG.KICK_DEVICE }); } catch { /* noop */ }
    // Give message time to arrive before closing
    setTimeout(() => {
      try { conn.close(); } catch { /* noop */ }
    }, 300);
  }

  log.info(`[Host] Kicked peer ${target.label || peerId}`);
  bus.emit('ui:show-toast', t('toast.device_kicked', { name: target.label || peerId }));
});

// Expose toggleOperator globally for device-list UI buttons
(window as unknown as Record<string, unknown>).toggleOperator = (peerId: string) => {
  bus.emit('network:toggle-operator', peerId);
};

// Host: resize peer slots when max guests changes
bus.on('network:max-guests-changed', (max: number) => {
  setState('network.maxGuestSlots', max);
  const oldSlots = getState('network.peerSlots');
  const newSlots = Array(max + 1).fill(null) as (string | null)[];
  // Preserve existing assignments
  for (let i = 1; i < Math.min(oldSlots.length, newSlots.length); i++) {
    newSlots[i] = oldSlots[i];
  }
  setState('network.peerSlots', newSlots);
  log.info(`[Peer] Max guest slots changed to ${max}`);
});

bus.on('network:device-list', (list) => {
  if (Array.isArray(list)) {
    setState('network.lastKnownDeviceList', list as DeviceInfo[]);
    bus.emit('network:device-list-update', list);
  }
});

// ─── Guest Protocol Handlers ──────────────────────────────────────

function handleWelcome(data: Record<string, unknown>): void {
  if (data.label) {
    setState('network.myDeviceLabel', String(data.label));
  }
  bus.emit('network:role-badge-update');
}

function handleSessionFull(data: Record<string, unknown>): void {
  const msg = data.message ? String(data.message) : t('network.session_full');

  setState('network.isIntentionalDisconnect', true);

  const hostConn = getState('network.hostConn');
  if (hostConn) {
    try { hostConn.close(); } catch { /* noop */ }
    setState('network.hostConn', null);
  }
  setState('network.isConnecting', false);
  bus.emit('network:role-badge-update');
  bus.emit('network:session-full', msg);
}

function handleDeviceListUpdateMsg(data: Record<string, unknown>): void {
  const list = Array.isArray(data.list) ? data.list as DeviceInfo[] : [];
  setState('network.lastKnownDeviceList', list);

  const myId = getState('network.myId');
  const hostConn = getState('network.hostConn');

  if (hostConn && myId) {
    const amIStillConnected = list.find(p => p && p.id === myId);
    if (!amIStillConnected) {
      log.warn('[Guest] Removed from Host device list. Leaving session...');
      setState('network.isIntentionalDisconnect', true);
      bus.emit('network:kicked-from-session');
      return;
    }
    const me = amIStillConnected;
    if (me && me.label) {
      setState('network.myDeviceLabel', String(me.label));
    }
  }

  bus.emit('network:device-list-update', list);
}

function handleForceCloseDuplicate(): void {
  log.warn('[Guest] Received force-close-duplicate — connection will close');
  // No action needed; the connection close event handles cleanup
}

function handleOperatorGrant(): void {
  setState('network.isOperator', true);
  bus.emit('ui:show-toast', t('network.op_granted'));
  bus.emit('ui:play-btn-state', true);
  bus.emit('network:role-badge-update');
}

function handleOperatorRevoke(): void {
  setState('network.isOperator', false);
  bus.emit('ui:show-toast', t('network.op_revoked'));
  bus.emit('network:role-badge-update');
}

function handleKickDeviceMsg(): void {
  setState('network.isIntentionalDisconnect', true);
  bus.emit('network:kicked-explicitly');
}

// ─── Init Peer Protocol Handlers ──────────────────────────────────

export function initPeerHandlers(): void {
  registerHandlers({
    [MSG.WELCOME]: handleWelcome,
    [MSG.SESSION_FULL]: handleSessionFull,
    [MSG.DEVICE_LIST_UPDATE]: handleDeviceListUpdateMsg,
    [MSG.FORCE_CLOSE_DUPLICATE]: handleForceCloseDuplicate,
    [MSG.OPERATOR_GRANT]: handleOperatorGrant,
    [MSG.OPERATOR_REVOKE]: handleOperatorRevoke,
    [MSG.KICK_DEVICE]: handleKickDeviceMsg,
  });

  log.info('[Peer] Protocol handlers registered');
}
