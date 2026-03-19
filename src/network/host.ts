/**
 * MUSIXQUARE 3.0 — Host-Side Peer Connection Logic
 *
 * Manages: incoming guest connections, welcome messages, device list,
 * operator toggle, kick, max-guests resize.
 *
 * Imports from peer-state.ts (leaf) only — never from peer.ts.
 */

import { log } from '../core/log.ts';
import { t } from '../i18n/index.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import type { DataConnection, DeviceInfo } from '../types/index.ts';

import {
  detectConnectionType,
  getPeerLabelBySlot,
  getAvailablePeerSlot,
  assignPeerSlot,
  releasePeerSlot,
  broadcastDeviceList,
} from './peer-state.ts';

// ─── Host: Incoming Connection ──────────────────────────────────────

export function handleHostIncomingConnection(conn: DataConnection): void {
  const peerId = conn.peer;
  const connectedPeers = getState('network.connectedPeers');
  const activeHostConnByPeerId = getState('network.activeHostConnByPeerId');

  // Duplicate connection handling
  const existingActiveConn = activeHostConnByPeerId.get(peerId);
  if (existingActiveConn && existingActiveConn !== conn) {
    const updatedConns = new Map(activeHostConnByPeerId);
    updatedConns.set(peerId, conn);
    setState('network.activeHostConnByPeerId', updatedConns);
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
    // Clean up activeHostConnByPeerId entry set during duplicate handling above
    const cleanupConns = new Map(getState('network.activeHostConnByPeerId'));
    cleanupConns.delete(peerId);
    setState('network.activeHostConnByPeerId', cleanupConns);

    // Release old peer's slot and label — the old conn's close handler
    // will return early (activeHostConnByPeerId guard), so we must clean up here.
    releasePeerSlot(peerId);
    const currentLabels = getState('network.peerLabels');
    if (currentLabels && currentLabels[peerId]) {
      const { [peerId]: _, ...restLabels } = currentLabels;
      setState('network.peerLabels', restLabels);
    }

    const sendFullAndClose = () => {
      try {
        conn.send({
          type: MSG.SESSION_FULL,
          message: t('network.session_full_detail'),
        });
      } catch { /* noop */ }
      setManagedTimer('conn-close-' + conn.peer, () => { try { conn.close(); } catch { /* noop */ } }, 500);
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
  const activeConns = new Map(getState('network.activeHostConnByPeerId'));
  activeConns.set(peerId, conn);
  setState('network.activeHostConnByPeerId', activeConns);

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

  // Re-check max guests before adding (guards against TOCTOU race with concurrent connections)
  const currentPeers = getState('network.connectedPeers');
  if (currentPeers.length >= getState('network.maxGuestSlots')) {
    log.warn(`[Host] Max guests reached during slot allocation for ${peerId}, rejecting`);
    releasePeerSlot(peerId);
    // Clean up activeHostConnByPeerId to prevent stale entry + spurious close handler
    const cleanupConns = new Map(getState('network.activeHostConnByPeerId'));
    cleanupConns.delete(peerId);
    setState('network.activeHostConnByPeerId', cleanupConns);
    const sendFullAndClose = () => {
      try { conn.send({ type: MSG.SESSION_FULL, message: t('network.session_full_detail') }); } catch { /* noop */ }
      try { conn.close(); } catch { /* noop */ }
    };
    if (conn.open) sendFullAndClose();
    else conn.on('open', sendFullAndClose);
    return;
  }
  setState('network.connectedPeers', [...currentPeers, peerObj]);

  // Timeout: clean up peer if WebRTC open never fires (ICE stall)
  const openTimerName = 'conn-open-timeout-' + peerId;
  setManagedTimer(openTimerName, () => {
    const peers = getState('network.connectedPeers');
    const stale = peers.find(p => p.id === peerId && p.status === 'connecting');
    if (!stale) return;
    log.warn(`[Host] Connection open timeout for ${deviceName} — cleaning up stale peer`);
    setState('network.connectedPeers', peers.filter(p => p.id !== peerId));
    const cleanConns = new Map(getState('network.activeHostConnByPeerId'));
    cleanConns.delete(peerId);
    setState('network.activeHostConnByPeerId', cleanConns);
    releasePeerSlot(peerId);
    const labels = getState('network.peerLabels');
    if (labels && labels[peerId]) {
      const { [peerId]: _, ...rest } = labels;
      setState('network.peerLabels', rest);
    }
    try { conn.close(); } catch { /* noop */ }
    broadcastDeviceList();
  }, 15000);

  conn.on('open', () => {
    clearManagedTimer(openTimerName);
    // Immutable update: replace peer object with updated status/heartbeat
    const peers = getState('network.connectedPeers');
    setState('network.connectedPeers', peers.map(p =>
      p.id === peerId ? { ...p, status: 'connected', lastHeartbeat: Date.now() } : p
    ));

    // Welcome message with host-assigned label
    try {
      conn.send({
        type: MSG.WELCOME,
        lockChannel: false,
        label: deviceName,
        chatFrozen: getState('network.chatFrozen') || false,
        slowmodeSeconds: getState('network.slowmodeSeconds') || 0,
        filterEnabled: getState('network.filterEnabled') || false,
      });
    } catch { /* noop */ }

    bus.emit('ui:show-toast', t('toast.device_connected', { name: deviceName }));
    bus.emit('chat:system-message', t('chat.peer_connected', { name: deviceName }));

    // Emit event for other modules to send late-join bootstrap data
    bus.emit('network:peer-connected', conn);

    // Detect local vs remote for this guest after ICE stabilizes
    setManagedTimer('ice-detect-' + peerId, async () => {
      try {
        const type = await detectConnectionType(conn);
        const peers = getState('network.connectedPeers');
        const livePeer = peers.find(p => p.id === peerId);
        if (livePeer) {
          // Immutable update: replace peer object with detected connection type
          setState('network.connectedPeers', peers.map(p =>
            p.id === peerId ? { ...p, connectionType: type } : p
          ));
        }
        log.info(`[Host] ${deviceName} connection type: ${type}`);
        broadcastDeviceList();
        bus.emit('orchestrator:peer-type-detected', peerId);

        // Re-detect after 10s if classified as 'remote' (ICE may not have stabilized at 1.5s)
        if (type === 'remote' && conn.open) {
          setManagedTimer('ice-redetect-' + peerId, async () => {
            try {
              if (!conn.open) return;
              const recheck = await detectConnectionType(conn);
              if (recheck === 'local') {
                const ps = getState('network.connectedPeers');
                const p = ps.find(x => x.id === peerId);
                if (p && p.connectionType !== 'local') {
                  // Immutable update: replace peer object with reclassified connection type
                  setState('network.connectedPeers', ps.map(x =>
                    x.id === peerId ? { ...x, connectionType: 'local' as const } : x
                  ));
                  log.info(`[Host] ${deviceName} reclassified as local on re-detection`);
                  broadcastDeviceList();
                  bus.emit('orchestrator:peer-type-detected', peerId);
                }
              }
            } catch (e) { log.warn('[Host] ICE re-detection error:', e); }
          }, 8500);
        }
      } catch (e) { log.warn('[Host] ICE detection error:', e); }
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
    if (getState('network.activeHostConnByPeerId').get(peerId) !== conn) return;

    // Clear ICE detection timers to prevent firing on disconnected peer
    clearManagedTimer('ice-detect-' + peerId);
    clearManagedTimer('ice-redetect-' + peerId);

    const closeConns = new Map(getState('network.activeHostConnByPeerId'));
    closeConns.delete(peerId);
    setState('network.activeHostConnByPeerId', closeConns);
    releasePeerSlot(peerId);

    const peerLabelsOnClose = getState('network.peerLabels');
    if (peerLabelsOnClose) {
      const { [peerId]: _, ...restLabels } = peerLabelsOnClose;
      setState('network.peerLabels', restLabels);
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

    if (getState('network.activeHostConnByPeerId').get(peerId) !== conn) {
      try { conn.close(); } catch { /* noop */ }
      return;
    }

    // Clear ICE detection timers to prevent firing on disconnected peer
    clearManagedTimer('ice-detect-' + peerId);
    clearManagedTimer('ice-redetect-' + peerId);

    const errConns = new Map(getState('network.activeHostConnByPeerId'));
    errConns.delete(peerId);
    setState('network.activeHostConnByPeerId', errConns);
    releasePeerSlot(peerId);

    const peerLabelsOnError = getState('network.peerLabels');
    if (peerLabelsOnError) {
      const { [peerId]: _, ...restLabelsErr } = peerLabelsOnError;
      setState('network.peerLabels', restLabelsErr);
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

// ─── Host Bus Event Handlers ────────────────────────────────────────

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
    setManagedTimer('kick-close-' + peerId, () => {
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
  // Preserve existing assignments, kick peers in truncated slots
  const orphanedPeerIds: string[] = [];
  for (let i = 1; i < oldSlots.length; i++) {
    if (i < newSlots.length) {
      newSlots[i] = oldSlots[i];
    } else if (oldSlots[i]) {
      orphanedPeerIds.push(oldSlots[i]!);
      releasePeerSlot(oldSlots[i]!);
    }
  }
  setState('network.peerSlots', newSlots);
  for (const peerId of orphanedPeerIds) {
    bus.emit('network:kick-device', peerId);
  }
  log.info(`[Peer] Max guest slots changed to ${max}`);
});

bus.on('network:device-list', (list) => {
  if (Array.isArray(list)) {
    setState('network.lastKnownDeviceList', list as DeviceInfo[]);
    bus.emit('network:device-list-update', list);
  }
});

// ─── Host: Rename Device ─────────────────────────────────────────

// Host renames itself — no network message needed
bus.on('network:rename-device', (newName: string) => {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host handles this path
  setState('network.myDeviceLabel', newName);
  broadcastDeviceList();
});
