/**
 * MUSIXQUARE 3.0 — Sync & Latency Management
 *
 * Manages: Heartbeat, ping/pong latency, manual sync (nudge).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE, RESERVED_NAMES } from '../core/constants.ts';
import type { DataConnection } from '../types/index.ts';
import { registerHandlers } from './protocol.ts';
import { broadcast, broadcastDeviceList } from './peer.ts';
import { containsProfanity } from '../chat/profanity.ts';
import { releasePeerSlot } from './peer-state.ts';
import { getHostNow, registerPing, processSyncPong, resetClockState, setIsHostClock } from './shared-clock.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { showToast } from '../ui/toast.ts';

let _syncPingCounter = 0;

/**
 * Get the total sync offset in milliseconds.
 */
export function getTotalSyncOffsetMs(): number {
  const localOffset = getState('sync.localOffset');
  return Math.round(localOffset * 1000);
}

// ─── Auto Sync ──────────────────────────────────────────────────────

export function handleAutoSync(): void {
  setState('sync.localOffset', 0);
  bus.emit('sync:display-update');
  showToast(t('toast.sync_reset'));
}

// ─── Protocol Handlers ──────────────────────────────────────────────

function handleSyncPing(data: Record<string, unknown>, conn: DataConnection): void {
  // 1. Liveness update (from old handleHeartbeat)
  try {
    if (conn?.peer) {
      const connectedPeers = getState('network.connectedPeers');
      const p = connectedPeers.find(x => x.id === conn.peer);
      if (p) {
        setState('network.connectedPeers', connectedPeers.map(x =>
          x.id === conn.peer ? { ...x, lastHeartbeat: Date.now() } : x
        ));
      }
    }
  } catch { /* ignore */ }

  // 2. Reply with SYNC_PONG including host time + playback state
  if (!conn?.open) return;
  const appState = getState('appState');
  const isFilePlaying = appState === APP_STATE.PLAYING_AUDIO || appState === APP_STATE.PLAYING_VIDEO;

  // Dynamic import for getTrackPosition to avoid circular dep
  if (isFilePlaying) {
    import('../player/transport.ts').then(mod => {
      if (!conn.open) return;
      try {
        conn.send({
          type: MSG.SYNC_PONG,
          pingId: data.pingId,
          hostTime: Date.now(),
          position: mod.getTrackPosition(),
          appState,
          trackIndex: getState('playlist.currentTrackIndex'),
        });
      } catch { /* closed */ }
    });
  } else {
    try {
      conn.send({
        type: MSG.SYNC_PONG,
        pingId: data.pingId,
        hostTime: Date.now(),
        position: 0,
        appState,
        trackIndex: getState('playlist.currentTrackIndex'),
      });
    } catch { /* closed */ }
  }
}

function handleSyncPong(data: Record<string, unknown>): void {
  const pingId = data.pingId as number;
  const hostTime = data.hostTime as number;
  const position = data.position as number;

  // 1. Clock offset calculation (from shared-clock processSyncPong)
  const result = processSyncPong(pingId, hostTime);
  if (!result) return;

  // 2. Latency history update (from old handlePongLatency)
  const ms = result.rtt;
  const latencyHistory = getState('sync.latencyHistory');
  const updated = [...latencyHistory, ms];
  if (updated.length > 10) updated.shift();
  setState('sync.latencyHistory', updated);
  setState('sync.lastLatencyMs', Math.min(...updated));
  bus.emit('sync:latency-update', ms);

  // 3. File mode drift correction
  const appState = getState('appState');
  if (appState !== APP_STATE.PLAYING_AUDIO && appState !== APP_STATE.PLAYING_VIDEO) return;

  // Skip if host is not playing (appState in pong tells us)
  const hostAppState = data.appState as string;
  if (hostAppState !== APP_STATE.PLAYING_AUDIO && hostAppState !== APP_STATE.PLAYING_VIDEO) return;
  if (!Number.isFinite(position)) return;

  const hostElapsed = (getHostNow() - hostTime) / 1000;
  const estimatedHostPos = position + hostElapsed;

  import('../player/transport.ts').then(mod => {
    const myPos = mod.getTrackPosition();
    const drift = estimatedHostPos - myPos;

    // Always correct to host position (>50ms to avoid float noise)
    if (Math.abs(drift) > 0.05) {
      mod.seekTo(estimatedHostPos);
    }
  });
}

// ─── Register Handlers ──────────────────────────────────────────────

// ─── Rename Handler (host-only) ─────────────────────────────────────
// Registered here instead of host.ts to avoid circular dependency
// (host.ts → protocol.ts → peer.ts → host.ts).

function handleRequestRename(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host processes this

  const peerId = (data._originPeer as string) || conn?.peer;
  if (!peerId) return;

  const newLabel = String(data.newLabel || '').trim().slice(0, 20);
  if (!newLabel) return;

  // Reserved name / profanity check
  if (RESERVED_NAMES.some(r => newLabel.toLowerCase() === r.toLowerCase())) return;
  if (containsProfanity(newLabel)) return;

  // Duplicate name check (including host's own label)
  const hostLabel = getState('network.myDeviceLabel') || '';
  if (hostLabel && newLabel.toLowerCase() === hostLabel.toLowerCase()) return;
  const peers = getState('network.connectedPeers');
  if (peers.some(p => p.id !== peerId && p.label.toLowerCase() === newLabel.toLowerCase())) return;

  setState('network.peerLabels', { ...getState('network.peerLabels'), [peerId]: newLabel });
  setState('network.connectedPeers', peers.map(p =>
    p.id === peerId ? { ...p, label: newLabel } : p
  ));

  broadcastDeviceList();
  log.info(`[Sync] Peer ${peerId} renamed to "${newLabel}"`);
}

// ─── Chat Command Request (OP guest → Host) ─────────────────────

function handleRequestChatCommand(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host processes this

  const peerId = (data._originPeer as string) || conn?.peer;
  if (!peerId) return;

  // Verify OP status
  const peers = getState('network.connectedPeers');
  const peer = peers.find(p => p.id === peerId);
  if (!peer?.isOp) return;

  const command = data.command as string;
  const args = (data.args as string[]) || [];

  switch (command) {
    case 'mute': {
      const targetArg = args[0];
      if (!targetArg) return;
      const target = _resolveTargetForHost(targetArg);
      if (!target) return;
      const current = getState('network.mutedPeers');
      setState('network.mutedPeers', new Set([...current, target.peerId]));
      broadcast({ type: MSG.CHAT_MUTE, targetId: target.peerId, targetLabel: target.label });
      bus.emit('chat:system-message', t('chat.cmd_muted', { name: target.label }));
      break;
    }
    case 'unmute': {
      const targetArg = args[0];
      if (!targetArg) return;
      const target = _resolveTargetForHost(targetArg);
      if (!target) return;
      const current = getState('network.mutedPeers');
      const next = new Set([...current]);
      next.delete(target.peerId);
      setState('network.mutedPeers', next);
      broadcast({ type: MSG.CHAT_UNMUTE, targetId: target.peerId, targetLabel: target.label });
      bus.emit('chat:system-message', t('chat.cmd_unmuted', { name: target.label }));
      break;
    }
    case 'clear':
      broadcast({ type: MSG.CHAT_CLEAR });
      bus.emit('chat:clear-all');
      break;
    case 'slowmode': {
      const sec = parseInt(args[0] || '0', 10);
      if (isNaN(sec) || sec < 0 || sec > 60) return;
      setState('network.slowmodeSeconds', sec);
      broadcast({ type: MSG.CHAT_SLOWMODE, seconds: sec });
      bus.emit('chat:system-message', sec > 0
        ? t('chat.cmd_slowmode_on', { sec })
        : t('chat.cmd_slowmode_off'));
      break;
    }
    case 'filter': {
      const on = args[0]?.toLowerCase() === 'on';
      setState('network.filterEnabled', on);
      broadcast({ type: MSG.CHAT_FILTER, on });
      bus.emit('chat:system-message', on ? t('chat.cmd_filter_on') : t('chat.cmd_filter_off'));
      break;
    }
    case 'notice': {
      const text = args.join(' ').trim();
      if (!text) return;
      const peerLabel = peer.label || 'OP';
      const noticePayload = { type: MSG.CHAT_NOTICE, senderLabel: peerLabel, text, ts: Date.now() };
      broadcast(noticePayload);
      bus.emit('chat:notice-message', peerLabel, text);
      break;
    }
    default:
      log.warn(`[Sync] Unknown chat command from OP: ${command}`);
  }
}

function _resolveTargetForHost(arg: string): { peerId: string; label: string } | null {
  const peers = getState('network.connectedPeers');
  if (arg.startsWith('#')) {
    const order = parseInt(arg.slice(1), 10);
    if (!isNaN(order)) {
      const p = peers.find(peer => peer.joinOrder === order);
      if (p) return { peerId: p.id, label: p.label };
    }
    return null;
  }
  const lower = arg.toLowerCase();
  const p = peers.find(peer => peer.label.toLowerCase() === lower);
  if (p) return { peerId: p.id, label: p.label };
  return null;
}

export function initSync(): void {
  registerHandlers({
    [MSG.SYNC_PING]: handleSyncPing,
    [MSG.SYNC_PONG]: handleSyncPong,
    [MSG.REQUEST_RENAME]: handleRequestRename,
    [MSG.REQUEST_CHAT_COMMAND]: handleRequestChatCommand,
  });

  // SharedClock role management (replaces old initSharedClock)
  bus.on('state:network.appRole', () => {
    const role = getState('network.appRole');
    setIsHostClock(role === 'host');
    if (role !== 'host' && role !== 'guest') resetClockState();
  });


  // Clean up sync state when session ends
  bus.on('state:network.sessionCode', (code: unknown) => {
    if (!code) {
      setState('sync.lastLatencyMs', 0);
      setState('sync.latencyHistory', []);
      resetClockState();
      _syncPingCounter = 0;
    }
  });

  // Bus event handlers for UI-triggered sync actions
  bus.on('sync:nudge', (ms) => {
    if (!Number.isFinite(ms)) return;
    // Dynamic import to avoid circular dependency
    import('../player/transport.ts').then(mod => mod.adjustSync(ms / 1000));
  });

  bus.on('sync:auto-sync', () => {
    handleAutoSync();
  });

  bus.on('sync:close-manual', () => {
    const overlay = document.getElementById('manual-sync-overlay');
    if (overlay) overlay.classList.remove('show');
  });

  // sync:display-update handler is in player-controls.ts (UI module) to maintain
  // network → UI separation. This module only emits the event.

  // Worker tick handler: Guest sends unified SYNC_PING to host
  bus.on('worker:timer-tick', (id) => {
    const hostConn = getState('network.hostConn');
    if (!hostConn || !hostConn.open) return;

    if (id === 'sync') {
      const pingId = ++_syncPingCounter;
      registerPing(pingId);
      try { hostConn.send({ type: MSG.SYNC_PING, pingId, guestTime: Date.now() }); } catch { /* noop */ }
    }
  });

  // ── Host: Start heartbeat monitor when session starts ──
  bus.on('state:setup.sessionStarted', (started) => {
    if (started) startHeartbeatMonitor();
    else stopHeartbeatMonitor();
  });

  log.info('[Sync] Handlers registered');
}

// ─── Host: Heartbeat Monitor ──────────────────────────────────────
// Checks every 5s for peers whose lastHeartbeat is older than threshold.
// Marks them as disconnected and cleans up.

const HEARTBEAT_STALE_THRESHOLD = 8000;  // 8s without heartbeat = stale
const HEARTBEAT_CHECK_INTERVAL = 5000;   // check every 5s

function startHeartbeatMonitor(): void {
  stopHeartbeatMonitor();
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host monitors

  setManagedTimer('heartbeat-monitor', () => {
    const hc = getState('network.hostConn');
    if (hc) { stopHeartbeatMonitor(); return; } // No longer host

    const now = Date.now();
    const connectedPeers = getState('network.connectedPeers');
    const stalePeerIds: string[] = [];

    for (const p of connectedPeers) {
      if (p.status !== 'connected') continue;
      const elapsed = now - (p.lastHeartbeat as number || 0);
      if (elapsed > HEARTBEAT_STALE_THRESHOLD) {
        log.warn(`[Heartbeat] Peer ${p.label || p.id} stale (${(elapsed / 1000).toFixed(1)}s) — marking disconnected`);
        stalePeerIds.push(p.id);

        // Try to close the stale connection
        try {
          const conn = p.conn as DataConnection;
          if (conn) conn.close();
        } catch { /* noop */ }
      }
    }

    if (stalePeerIds.length > 0) {
      // Remove stale peers entirely and clean up their connection references.
      // This prevents peer.ts close handler from emitting a duplicate
      // 'network:peer-disconnected' — the activeHostConnByPeerId guard
      // (conn !== stored conn) will skip since we delete the entry here.
      const staleSet = new Set(stalePeerIds);
      const updatedConns = new Map(getState('network.activeHostConnByPeerId'));
      for (const id of stalePeerIds) {
        updatedConns.delete(id);
      }
      setState('network.activeHostConnByPeerId', updatedConns);
      setState('network.connectedPeers', connectedPeers.filter(p => !staleSet.has(p.id)));

      // Clean up peerLabels for stale peers — host.ts close handler won't fire
      // because activeHostConnByPeerId was already cleared above (guard skips).
      const currentLabels = getState('network.peerLabels');
      if (currentLabels && Object.keys(currentLabels).length > 0) {
        const cleanedLabels = { ...currentLabels };
        for (const id of stalePeerIds) {
          delete cleanedLabels[id];
        }
        setState('network.peerLabels', cleanedLabels);
      }

      for (const id of stalePeerIds) {
        releasePeerSlot(id);
        bus.emit('network:peer-disconnected', id);
      }
      broadcastDeviceList();
    }
  }, HEARTBEAT_CHECK_INTERVAL, { interval: true });

  log.info('[Heartbeat] Monitor started');
}

function stopHeartbeatMonitor(): void {
  clearManagedTimer('heartbeat-monitor');
}
