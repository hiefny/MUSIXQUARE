/**
 * MUSIXQUARE 2.0 — PeerJS Initialization & Connection Management
 * Extracted from original app.js lines 6097-6794
 *
 * Manages: PeerJS instance, session creation/joining, peer slot allocation,
 * host incoming connections, guest outbound connection, leave/cleanup.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState, batchSetState } from '../core/state.ts';
import { MSG, MAX_GUEST_SLOTS, PEER_NAME_PREFIX } from '../core/constants.ts';
import { registerHandlers } from './protocol.ts';
import type { DataConnection, PeerInstance } from '../types/index.ts';

// ─── PeerJS global declaration ──────────────────────────────────────
declare const Peer: new (id?: string, opts?: Record<string, unknown>) => PeerInstance;

// ─── Module-scoped state ────────────────────────────────────────────
let peer: PeerInstance | null = null;

// ─── Public Getters ─────────────────────────────────────────────────
export function getPeer(): PeerInstance | null { return peer; }

// ─── Peer Slot Management ───────────────────────────────────────────

function getPeerLabelBySlot(slot: number): string {
  return `${PEER_NAME_PREFIX} ${slot}`;
}

function getAvailablePeerSlot(preferredSlot: number | null, peerId: string | null): number | null {
  const peerSlots = getState<(string | null)[]>('network.peerSlots');
  const pref = Number(preferredSlot);
  if (Number.isInteger(pref) && pref >= 1 && pref <= MAX_GUEST_SLOTS) {
    const occupant = peerSlots[pref];
    if (!occupant || occupant === peerId) return pref;
  }
  for (let i = 1; i <= MAX_GUEST_SLOTS; i++) {
    if (!peerSlots[i]) return i;
  }
  return null;
}

function assignPeerSlot(peerId: string, slot: number): void {
  if (!peerId) return;
  const s = Number(slot);
  if (!Number.isInteger(s) || s < 1 || s > MAX_GUEST_SLOTS) return;
  const peerSlots = getState<(string | null)[]>('network.peerSlots');
  peerSlots[s] = peerId;
  setState('network.peerSlots', peerSlots);
  const map = getState<Map<string, number>>('network.peerSlotByPeerId');
  map.set(peerId, s);
}

function releasePeerSlot(peerId: string): void {
  if (!peerId) return;
  const map = getState<Map<string, number>>('network.peerSlotByPeerId');
  const slot = map.get(peerId);
  if (slot) {
    const peerSlots = getState<(string | null)[]>('network.peerSlots');
    if (peerSlots[slot] === peerId) peerSlots[slot] = null;
  }
  map.delete(peerId);
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

  // Local-only ICE: no STUN/TURN (forces same LAN / same Wi-Fi)
  const peerOpts: Record<string, unknown> = {
    debug: 2,
    config: {
      iceServers: [],
      sdpSemantics: 'unified-plan',
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 0,
    },
  };

  // Allow custom PeerJS signaling server injection
  const customPeerServer = (window as unknown as Record<string, unknown>).__MUSIXQUARE_PEER_SERVER__ as
    Record<string, unknown> | undefined;
  if (customPeerServer && typeof customPeerServer === 'object') {
    if (customPeerServer.host) peerOpts.host = customPeerServer.host;
    if (customPeerServer.port) peerOpts.port = customPeerServer.port;
    if (customPeerServer.path) peerOpts.path = customPeerServer.path;
    if (typeof customPeerServer.secure === 'boolean') peerOpts.secure = customPeerServer.secure;
    if (customPeerServer.key) peerOpts.key = customPeerServer.key;
  }

  peer = new Peer(requestedId || undefined, peerOpts);
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
    const appRole = getState<string>('network.appRole');
    const hostConn = getState<DataConnection | null>('network.hostConn');

    if (appRole === 'host' && !hostConn) {
      if (err && typeof err === 'object' && (err as Record<string, unknown>).type === 'id-taken') {
        return; // Handled by retry loop
      }
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

    const appRole = getState<string>('network.appRole');
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
  const connectedPeers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
  const activeHostConnByPeerId = getState<Map<string, DataConnection>>('network.activeHostConnByPeerId');

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
  if (filtered.length >= MAX_GUEST_SLOTS) {
    const sendFullAndClose = () => {
      try {
        conn.send({
          type: MSG.SESSION_FULL,
          message: '현재 세션은 연결 가능한 기기 수(방장 제외 3대)에 도달했어요.',
        });
      } catch { /* noop */ }
      setTimeout(() => { try { conn.close(); } catch { /* noop */ } }, 500);
    };
    if (conn.open) sendFullAndClose();
    else conn.on('open', sendFullAndClose);
    return;
  }

  // Allocate slot
  const peerSlotByPeerId = getState<Map<string, number>>('network.peerSlotByPeerId');
  const preferredSlot = peerSlotByPeerId.get(peerId) || null;
  const slot = getAvailablePeerSlot(preferredSlot, peerId);
  if (!slot) {
    try {
      conn.send({
        type: MSG.SESSION_FULL,
        message: '현재 세션은 연결 가능한 기기 수(방장 제외 3대)에 도달했어요.',
      });
    } catch { /* noop */ }
    try { conn.close(); } catch { /* noop */ }
    return;
  }
  assignPeerSlot(peerId, slot);
  const deviceName = getPeerLabelBySlot(slot);

  // Track label
  const peerLabels = getState<Record<string, string>>('network.peerLabels');
  peerLabels[peerId] = deviceName;

  // New connection becomes active
  activeHostConnByPeerId.set(peerId, conn);

  const peerObj = {
    id: peerId,
    slot,
    label: deviceName,
    role: 'guest' as const,
    status: 'connecting' as string,
    conn,
    isOp: false,
    isDataTarget: true,
    joinOrder: slot,
    lastHeartbeat: Date.now(),
    preloadedIndexes: new Set<number>(),
    currentFileId: null as string | null,
  };

  const updatedPeers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
  updatedPeers.push(peerObj as unknown as Record<string, unknown>);
  setState('network.connectedPeers', updatedPeers);

  conn.on('open', () => {
    peerObj.status = 'connected';
    peerObj.lastHeartbeat = Date.now();

    // Welcome message with host-assigned label
    try {
      conn.send({
        type: MSG.WELCOME,
        lockChannel: false,
        label: deviceName,
      });
    } catch { /* noop */ }

    bus.emit('ui:show-toast', `${deviceName}가 연결됐어요`);

    // Emit event for other modules to send late-join bootstrap data
    bus.emit('network:peer-connected', conn);

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

    const peers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
    setState('network.connectedPeers', peers.filter(p => p.id !== peerId));

    bus.emit('network:peer-disconnected', peerId);
    broadcastDeviceList();
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

    const peers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
    setState('network.connectedPeers', peers.filter(p => p.id !== peerId));

    bus.emit('network:peer-disconnected', peerId);
    broadcastDeviceList();
    try { conn.close(); } catch { /* noop */ }
  });
}

// ─── Guest: Join Session ────────────────────────────────────────────

/**
 * Connect to a host session as a guest.
 */
export function joinSession(hostId: string, retryAttempt = 0): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn && hostConn.open) {
    log.warn('[Join] Already connected to host.');
    return;
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
      setTimeout(() => joinSession(hostId, retryAttempt + 1), 300);
    } else {
      bus.emit('network:error', new Error('PEER_NOT_READY'));
    }
    return;
  }

  setState('network.isConnecting', true);

  let conn: DataConnection;
  try {
    const channelMode = getState<number>('audio.channelMode');
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

  // Timeout if host is unreachable
  const timeoutId = setTimeout(() => {
    if (!conn || conn.open || getState<DataConnection | null>('network.hostConn')) return;
    try { conn.close(); } catch { /* noop */ }
    setState('network.isConnecting', false);
    bus.emit('network:error', new Error('HOST_UNREACHABLE'));
  }, 10000);

  conn.on('open', () => {
    clearTimeout(timeoutId);
    log.info('[Join] Connected to host:', hostId);

    setState('network.hostConn', conn);
    setState('network.isConnecting', false);
    setState('session.hostId', hostId);

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
        setState('network.isIntentionalDisconnect', false);
        return;
      }
      (conn as unknown as Record<string, unknown>)._errorHandled = true;

      const isIntentional = getState<boolean>('network.isIntentionalDisconnect');
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

    bus.emit('network:peer-connected', conn);
    bus.emit('setup:guest-join-success');
  });
}

// ─── Leave / Cleanup ────────────────────────────────────────────────

/**
 * Leave the current session and clean up all network state.
 */
export function leaveSession(): void {
  log.debug('[Network] Leaving session and resetting state...');

  setState('network.isIntentionalDisconnect', true);

  // Stop heartbeat & ping timers
  bus.emit('worker:sync-command', { command: 'STOP_TIMER', id: 'heartbeat' });
  bus.emit('worker:sync-command', { command: 'STOP_TIMER', id: 'ping' });

  // Close host connection (guest side)
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) {
    try { hostConn.close(); } catch { /* noop */ }
    setState('network.hostConn', null);
  }

  // Destroy peer instance
  if (peer) {
    try { peer.destroy(); } catch { /* noop */ }
    peer = null;
  }

  // Close all guest connections (host side)
  const connectedPeers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
  connectedPeers.forEach(p => {
    try {
      const conn = p.conn as DataConnection | null;
      if (conn) conn.close();
    } catch { /* noop */ }
  });

  // Reset peer slots
  const activeHostConnByPeerId = getState<Map<string, DataConnection>>('network.activeHostConnByPeerId');
  const peerSlotByPeerId = getState<Map<string, number>>('network.peerSlotByPeerId');
  activeHostConnByPeerId.clear();
  peerSlotByPeerId.clear();
  const peerSlots = getState<(string | null)[]>('network.peerSlots');
  for (let i = 1; i <= MAX_GUEST_SLOTS; i++) peerSlots[i] = null;

  // Reset network state
  batchSetState({
    'network.myId': null,
    'network.myDeviceLabel': 'HOST',
    'network.hostConn': null,
    'network.connectedPeers': [],
    'network.isOperator': false,
    'network.isConnecting': false,
    'network.lastKnownDeviceList': null,
    'network.peerLabels': {},
    'network.isIntentionalDisconnect': false,
  });

  log.debug('[Network] Session left and state reset.');
}

// ─── Broadcast Utilities ────────────────────────────────────────────

/**
 * Broadcast a message to all connected peers.
 */
export function broadcast(msg: unknown, isDataOnly = false): void {
  const connectedPeers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
  connectedPeers.forEach(p => {
    try {
      if (p.status === 'connected' && p.conn) {
        const conn = p.conn as DataConnection;
        if (conn.open) {
          if (!isDataOnly || p.isDataTarget !== false) {
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
export function broadcastExcept(excludePeerId: string, msg: unknown, isDataOnly = false): void {
  const connectedPeers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
  connectedPeers.forEach(p => {
    try {
      if (p.status === 'connected' && p.conn) {
        const conn = p.conn as DataConnection;
        if (conn.open) {
          if (excludePeerId && p.id === excludePeerId) return;
          if (!isDataOnly || p.isDataTarget !== false) {
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
  const myId = getState<string | null>('network.myId');
  const connectedPeers = getState<Array<Record<string, unknown>>>('network.connectedPeers');

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
      })),
  ];

  const msg = { type: MSG.DEVICE_LIST_UPDATE, list };
  broadcast(msg);
  bus.emit('network:device-list', list);
}

/**
 * Send a message to the host (guest-only helper).
 */
export function sendToHost(msg: unknown): boolean {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (!hostConn || !hostConn.open) return false;
  try {
    hostConn.send(msg);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send pause state to a single connection.
 */
export function sendPauseState(conn: DataConnection, time: number): void {
  try {
    if (!conn || !conn.open) return;
    conn.send({
      type: MSG.PAUSE,
      time,
      index: getState<number>('playlist.currentTrackIndex'),
      state: getState<string>('appState'),
      timestamp: Date.now(),
    });
  } catch { /* noop */ }
}

// ─── Bus Event Handlers ─────────────────────────────────────────

bus.on('network:broadcast', ((...args: unknown[]) => {
  const msg = args[0];
  if (msg) broadcast(msg);
}) as (...args: unknown[]) => void);

bus.on('network:broadcast-except', ((...args: unknown[]) => {
  const excludePeerId = args[0] as string;
  const msg = args[1];
  if (msg) broadcastExcept(excludePeerId, msg);
}) as (...args: unknown[]) => void);

// Host: Toggle operator permission on a peer
bus.on('network:toggle-operator', ((...args: unknown[]) => {
  const peerId = args[0] as string;
  if (!peerId) return;

  // Only Host can toggle operator
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return;

  const connectedPeers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
  const p = connectedPeers.find(x => x.id === peerId);
  if (p) {
    p.isOp = !p.isOp;
    const conn = p.conn as DataConnection;
    if (conn && conn.open) {
      conn.send({ type: p.isOp ? MSG.OPERATOR_GRANT : MSG.OPERATOR_REVOKE });
    } else {
      log.warn(`[OP] Cannot notify peer ${peerId} — connection not open`);
    }
    broadcastDeviceList();
    bus.emit('ui:show-toast', `${p.label} 권한 ${p.isOp ? '부여됨' : '회수됨'}`);
  }
}) as (...args: unknown[]) => void);

// Expose toggleOperator globally for device-list UI buttons
(window as unknown as Record<string, unknown>).toggleOperator = (peerId: string) => {
  bus.emit('network:toggle-operator', peerId);
};

bus.on('network:device-list', ((...args: unknown[]) => {
  const list = args[0] as Array<Record<string, unknown>>;
  if (Array.isArray(list)) {
    setState('network.lastKnownDeviceList', list);
    bus.emit('network:device-list-update', list);
  }
}) as (...args: unknown[]) => void);

// ─── Guest Protocol Handlers ──────────────────────────────────────

function handleWelcome(data: Record<string, unknown>): void {
  if (data.label) {
    setState('network.myDeviceLabel', String(data.label));
  }
  bus.emit('network:role-badge-update');
}

function handleSessionFull(data: Record<string, unknown>): void {
  const msg = data.message ? String(data.message) : '세션이 가득 찼어요';

  setState('network.isIntentionalDisconnect', true);

  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) {
    try { hostConn.close(); } catch { /* noop */ }
    setState('network.hostConn', null);
  }
  setState('network.isConnecting', false);
  bus.emit('network:role-badge-update');
  bus.emit('network:session-full', msg);
}

function handleDeviceListUpdateMsg(data: Record<string, unknown>): void {
  const list = Array.isArray(data.list) ? data.list as Array<Record<string, unknown>> : [];
  setState('network.lastKnownDeviceList', list);

  const myId = getState<string | null>('network.myId');
  const hostConn = getState<DataConnection | null>('network.hostConn');

  if (hostConn && myId) {
    const amIStillConnected = list.find(p => p && p.id === myId);
    if (!amIStillConnected) {
      log.warn('[Guest] Removed from Host device list. Leaving session...');
      setState('network.isIntentionalDisconnect', true);
      bus.emit('network:kicked-from-session');
      return;
    }
    const me = list.find(p => p && p.id === myId);
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

function handleSysToast(data: Record<string, unknown>): void {
  if (data.message) {
    bus.emit('ui:show-toast', String(data.message));
  }
}

function handleOperatorGrant(): void {
  setState('network.isOperator', true);
  bus.emit('ui:show-toast', 'Operator 권한이 부여되었습니다.');
  bus.emit('ui:play-btn-state', true);
  bus.emit('network:role-badge-update');
}

function handleOperatorRevoke(): void {
  setState('network.isOperator', false);
  bus.emit('ui:show-toast', 'Operator 권한이 해제되었습니다.');
  bus.emit('network:role-badge-update');
}

function handleSessionStart(): void {
  setState('setup.sessionStarted', true);
  bus.emit('setup:hide-overlay');
  bus.emit('network:role-badge-update');
  log.info('[Peer] Session started');
}

// ─── Init Peer Protocol Handlers ──────────────────────────────────

export function initPeerHandlers(): void {
  registerHandlers({
    [MSG.WELCOME]: handleWelcome,
    [MSG.SESSION_FULL]: handleSessionFull,
    [MSG.SESSION_START]: handleSessionStart as unknown as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.DEVICE_LIST_UPDATE]: handleDeviceListUpdateMsg,
    [MSG.FORCE_CLOSE_DUPLICATE]: handleForceCloseDuplicate as unknown as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.SYS_TOAST]: handleSysToast,
    [MSG.OPERATOR_GRANT]: handleOperatorGrant as unknown as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.OPERATOR_REVOKE]: handleOperatorRevoke as unknown as (d: Record<string, unknown>, c: DataConnection) => void,
  });

  log.info('[Peer] Protocol handlers registered');
}
