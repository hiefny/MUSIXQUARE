// @ts-check
/**
 * MUSIXQUARE 2.0 - Peer Connection Manager
 *
 * PeerJS 래핑. 연결 생성, 수명주기, 초대코드 관리.
 * 1.0의 initPeer(), hostConn, downstreamDataPeers 등을 캡슐화.
 *
 * 외부 의존: PeerJS (vendor, window.Peer)
 *
 * Events emitted:
 *   bus.emit('peer:ready', peerId)          - PeerJS 브로커 연결 완료
 *   bus.emit('peer:connection', conn)       - 새 peer 연결 수립
 *   bus.emit('peer:data', { data, conn })   - 데이터 수신
 *   bus.emit('peer:disconnected', peerId)   - peer 연결 끊김
 *   bus.emit('peer:error', error)           - 연결 오류
 *
 * Events consumed:
 *   (none - 외부에서 메서드를 직접 호출)
 */

import { bus } from '../core/events.js';
import { setState } from '../core/state.js';
import { log } from '../core/log.js';
import { MAX_PEERS } from '../core/constants.js';

let peer = null;
/** @type {any[]} */
let connections = [];

/**
 * Initialize PeerJS and register with signaling server.
 * @param {string} [customId] - Optional custom peer ID
 * @returns {Promise<string>} The assigned peer ID
 */
export async function initPeer(customId) {
  const Peer = /** @type {any} */ (window).Peer;
  if (!Peer) throw new Error('PeerJS not loaded');

  // Destroy previous instance
  if (peer) {
    try { peer.destroy(); } catch (_) {}
    peer = null;
  }

  return new Promise((resolve, reject) => {
    const opts = {
      debug: 0,
      config: {
        iceServers: [],
        sdpSemantics: 'unified-plan',
        bundlePolicy: 'max-bundle',
        iceCandidatePoolSize: 0,
      },
    };

    peer = customId ? new Peer(customId, opts) : new Peer(opts);

    peer.on('open', (id) => {
      log.info('[Peer] Connected with ID:', id);
      setState('session.peerId', id);
      bus.emit('peer:ready', id);
      resolve(id);
    });

    peer.on('connection', (conn) => {
      if (connections.length >= MAX_PEERS) {
        log.warn('[Peer] Max connections reached, rejecting');
        conn.close();
        return;
      }
      _setupConnection(conn);
    });

    peer.on('error', (err) => {
      log.error('[Peer] Error:', err);
      bus.emit('peer:error', err);
      reject(err);
    });

    peer.on('disconnected', () => {
      log.warn('[Peer] Disconnected from signaling server');
    });
  });
}

/**
 * Connect to a remote peer by ID.
 * @param {string} remotePeerId
 * @returns {Promise<any>} The data connection
 */
export function connectTo(remotePeerId) {
  if (!peer) throw new Error('Peer not initialized');

  return new Promise((resolve, reject) => {
    const conn = peer.connect(remotePeerId, { reliable: true });

    conn.on('open', () => {
      _setupConnection(conn);
      resolve(conn);
    });

    conn.on('error', (err) => {
      log.error('[Peer] Connect error:', err);
      reject(err);
    });

    // Timeout
    setTimeout(() => reject(new Error('Connection timeout')), 10000);
  });
}

/**
 * Send data to a specific connection or broadcast to all.
 * @param {any} data
 * @param {any} [conn] - Specific connection. If omitted, broadcasts to all.
 */
export function send(data, conn) {
  if (conn) {
    if (conn.open) conn.send(data);
    return;
  }
  // Broadcast
  for (const c of connections) {
    if (c.open) {
      try { c.send(data); } catch (_) {}
    }
  }
}

/** Destroy the peer instance and all connections. */
export function destroy() {
  for (const c of connections) {
    try { c.close(); } catch (_) {}
  }
  connections = [];
  if (peer) {
    try { peer.destroy(); } catch (_) {}
    peer = null;
  }
  setState('session.peerId', null);
}

/** @returns {any[]} Active connections */
export function getConnections() {
  return connections.filter(c => c.open);
}

// ── Internal ──

function _setupConnection(conn) {
  connections.push(conn);
  bus.emit('peer:connection', conn);

  conn.on('data', (data) => {
    bus.emit('peer:data', { data, conn });
  });

  conn.on('close', () => {
    connections = connections.filter(c => c !== conn);
    bus.emit('peer:disconnected', conn.peer);
    log.info('[Peer] Connection closed:', conn.peer);
  });

  conn.on('error', (err) => {
    log.error('[Peer] Connection error:', err);
    connections = connections.filter(c => c !== conn);
  });

  log.info('[Peer] Connection established:', conn.peer);
}
