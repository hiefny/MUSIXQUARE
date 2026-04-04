/**
 * MUSIXQUARE 3.0 — Sync & Latency Management
 *
 * Manages: Heartbeat, ping/pong latency, auto-sync, manual sync (nudge),
 * sync response handling, global resync.
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
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { showToast } from '../ui/toast.ts';

// ─── Multi-Sample Sync State ─────────────────────────────────────────

const SYNC_SAMPLE_COUNT = 3;
const SYNC_SAMPLE_INTERVAL = 500; // ms between samples

interface SyncSample {
  sentAt: number;       // Date.now() when request was sent
  rtt: number;          // round-trip time in ms
  hostTime: number;     // host playback position in seconds
  isPlaying: boolean;
}

let _syncSamples: SyncSample[] = [];
let _syncSampleExpected = 0;       // how many samples we're still waiting for
// Sync timers now managed via setManagedTimer('sync-sample') / setManagedTimer('sync-timeout')

// ─── Sync Button Logic ──────────────────────────────────────────────

/**
 * Handle the main sync button press.
 * Host: broadcasts global resync. Guest: resets offset and requests sync time.
 */
function handleMainSyncBtn(): void {
  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) return;

  const hostConn = getState('network.hostConn');
  if (!hostConn) {
    // Host: Broadcast resync request to all guests
    broadcast({ type: MSG.GLOBAL_RESYNC_REQUEST });
    showToast(t('toast.resync_all'));
  } else {
    // Guest: Perform multi-sample auto-sync
    setState('sync.localOffset', 0);
    setState('sync.autoSyncOffset', 0);
    bus.emit('sync:display-update');
    showToast(t('toast.optimal_sync'));
    startMultiSampleSync();
  }
}

// ─── Guest: Multi-Sample Sync ────────────────────────────────────────

/**
 * Start a 3-sample sync sequence. Sends GET_SYNC_TIME at 500ms intervals,
 * collects RTT for each response, then picks the sample with the lowest RTT.
 */
function startMultiSampleSync(): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn || !hostConn.open) return;

  // Cancel any in-progress multi-sample sequence
  clearManagedTimer('sync-sample');
  clearManagedTimer('sync-timeout');
  _syncSamples = [];
  _syncSampleExpected = SYNC_SAMPLE_COUNT;

  // Send first sample immediately, rest at intervals
  sendSyncSample(hostConn);
  let sent = 1;
  const scheduleNext = () => {
    if (sent >= SYNC_SAMPLE_COUNT) return;
    setManagedTimer('sync-sample', () => {
      if (!hostConn.open) return;
      sendSyncSample(hostConn);
      sent++;
      scheduleNext();
    }, SYNC_SAMPLE_INTERVAL);
  };
  scheduleNext();

  // Safety timeout: apply whatever we have if not all responses arrive
  setManagedTimer('sync-timeout', () => {
    if (_syncSampleExpected > 0 && _syncSamples.length > 0) {
      log.warn(`[Sync] Timeout: got ${_syncSamples.length}/${_syncSampleExpected} samples, applying best`);
      applyBestSample();
    } else if (_syncSampleExpected > 0) {
      log.warn('[Sync] Timeout: no samples received, aborting');
      _syncSamples = [];
      _syncSampleExpected = 0;
    }
  }, SYNC_SAMPLE_COUNT * SYNC_SAMPLE_INTERVAL + 2000);
}

function sendSyncSample(conn: DataConnection): void {
  const ts = Date.now();
  try { conn.send({ type: MSG.GET_SYNC_TIME, ts }); } catch { /* connection closed */ }
}

/**
 * Called when a SYNC_RESPONSE arrives. Collects samples and applies
 * the best one (lowest RTT) once all samples are in.
 */
function collectSyncSample(data: Record<string, unknown>): void {
  const t4 = Date.now();
  const t1 = (typeof data.reqTs === 'number' && data.reqTs > 0) ? data.reqTs : 0;
  const grossRtt = t1 ? t4 - t1 : Infinity;

  // NTP-style: subtract host processing time to get pure network RTT
  const t2 = (typeof data.t2 === 'number') ? data.t2 : 0;
  const t3 = (typeof data.t3 === 'number') ? data.t3 : 0;
  const hostProcessing = (t2 && t3 && t3 >= t2) ? t3 - t2 : 0;
  const rtt = grossRtt < Infinity ? Math.max(0, grossRtt - hostProcessing) : Infinity;

  const hostTime = (typeof data.time === 'number' && Number.isFinite(data.time)) ? data.time : 0;
  const isPlaying = !!data.isPlaying;

  _syncSamples.push({
    sentAt: t1,
    rtt,
    hostTime,
    isPlaying,
  });

  log.debug(`[Sync] Sample ${_syncSamples.length}/${_syncSampleExpected}: netRTT=${rtt}ms (gross=${grossRtt}ms, hostProc=${hostProcessing}ms), hostTime=${hostTime.toFixed(2)}s`);

  if (_syncSamples.length >= _syncSampleExpected) {
    applyBestSample();
  }
}

/**
 * Pick the sample with the lowest RTT and apply it.
 * Compensate for time elapsed since that sample was taken.
 */
function applyBestSample(): void {
  if (_syncSamples.length === 0) return;

  // Pick lowest RTT
  const best = _syncSamples.reduce((a, b) => a.rtt < b.rtt ? a : b);

  // Guard: if best sample has no usable RTT (all corrupted), abort
  if (!Number.isFinite(best.rtt) || best.sentAt <= 0) {
    log.warn('[Sync] No usable sample (invalid RTT or sentAt), aborting');
    _syncSamples = [];
    _syncSampleExpected = 0;
    return;
  }

  const elapsed = (Date.now() - best.sentAt - best.rtt / 2) / 1000; // seconds since host reported

  log.debug(`[Sync] Best sample: RTT=${best.rtt}ms, hostTime=${best.hostTime.toFixed(2)}s, elapsed=${elapsed.toFixed(3)}s`);

  // Latency compensation — remote + unknown (applied even before ICE classification)
  let oneWayLatencySeconds = 0;
  if (getState('network.connectionType') !== 'local') {
    if (best.rtt > 0 && best.rtt < Infinity) {
      oneWayLatencySeconds = (best.rtt / 2) / 1000;
    }
  }

  setState('sync.autoSyncOffset', oneWayLatencySeconds);
  bus.emit('sync:display-update');

  // Extrapolate: host position + time elapsed since that sample
  const extrapolatedTime = best.isPlaying ? best.hostTime + elapsed : best.hostTime;
  bus.emit('sync:response', extrapolatedTime, best.isPlaying, oneWayLatencySeconds);

  // Cleanup
  _syncSamples = [];
  _syncSampleExpected = 0;
}

// ─── Delayed Global Resync (Host-only) ──────────────────────────────

/**
 * Request a global resync after a short delay.
 * Ensures host-side playback state change has settled across the network.
 */
export function requestGlobalResyncDelayed(delay = 1000): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Host only

  setManagedTimer('global-resync', () => {
    const hc = getState('network.hostConn');
    if (!hc) {
      broadcast({ type: MSG.GLOBAL_RESYNC_REQUEST });
      log.debug(`[Sync] Automatic global resync requested (delay: ${delay}ms)`);
    }
  }, delay);
}

/**
 * Get the total sync offset (localOffset + autoSyncOffset) in milliseconds.
 */
export function getTotalSyncOffsetMs(): number {
  const localOffset = getState('sync.localOffset');
  const autoSyncOffset = getState('sync.autoSyncOffset');
  return Math.round((localOffset + autoSyncOffset) * 1000);
}

// ─── Auto Sync ──────────────────────────────────────────────────────

export function handleAutoSync(): void {
  setState('sync.localOffset', 0);
  setState('sync.autoSyncOffset', 0);
  bus.emit('sync:display-update');
  handleMainSyncBtn();
}

// ─── Protocol Handlers ──────────────────────────────────────────────

function handleHeartbeat(_data: Record<string, unknown>, conn: DataConnection): void {
  // Update liveness timestamp (immutable update)
  try {
    if (conn && conn.peer) {
      const connectedPeers = getState('network.connectedPeers');
      const p = connectedPeers.find(x => x.id === conn.peer);
      if (p) {
        setState('network.connectedPeers', connectedPeers.map(x =>
          x.id === conn.peer ? { ...x, lastHeartbeat: Date.now() } : x
        ));
      }
    }
  } catch { /* ignore */ }

  // Reply to the sender
  if (conn && conn.open) {
    try { conn.send({ type: MSG.HEARTBEAT_ACK }); } catch { /* connection closed */ }
  }
}

function handleHeartbeatAck(): void {
  // Heartbeat ACK received — no action needed currently
}

function handlePingLatency(data: Record<string, unknown>, conn: DataConnection): void {
  if (typeof data.timestamp !== 'number') return;
  if (conn && conn.open) {
    try { conn.send({ type: MSG.PONG_LATENCY, timestamp: data.timestamp }); } catch { /* connection closed */ }
  }
}

function handlePongLatency(data: Record<string, unknown>): void {
  if (!Number.isFinite(data.timestamp)) return;
  const ms = Date.now() - (data.timestamp as number);
  const latencyHistory = getState('sync.latencyHistory');
  const updated = [...latencyHistory, ms];
  if (updated.length > 10) updated.shift();
  setState('sync.latencyHistory', updated);
  setState('sync.lastLatencyMs', Math.min(...updated));
  bus.emit('sync:latency-update', ms);
}

function handleSyncResponse(data: Record<string, unknown>): void {
  const currentState = getState('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) return;

  // If multi-sample sync is active, collect this sample
  if (_syncSampleExpected > 0) {
    collectSyncSample(data);
    return;
  }

  // Fallback: single-shot sync (e.g. post-download auto-sync from playback.ts)
  let oneWayLatencySeconds = 0;
  if (getState('network.connectionType') !== 'local') {
    const reqTs = (typeof data.reqTs === 'number' && data.reqTs > 0) ? data.reqTs : 0;
    const grossRtt = reqTs ? Date.now() - reqTs : 0;
    // NTP-style: subtract host processing time
    const t2 = (typeof data.t2 === 'number') ? data.t2 : 0;
    const t3 = (typeof data.t3 === 'number') ? data.t3 : 0;
    const hostProcessing = (t2 && t3 && t3 >= t2) ? t3 - t2 : 0;
    const networkRtt = Math.max(0, grossRtt - hostProcessing);
    if (networkRtt > 0) oneWayLatencySeconds = (networkRtt / 2) / 1000;
  }

  const syncTime = (typeof data.time === 'number' && Number.isFinite(data.time)) ? data.time : 0;
  setState('sync.autoSyncOffset', oneWayLatencySeconds);
  bus.emit('sync:display-update');
  const extrapolatedTime = data.isPlaying ? syncTime + oneWayLatencySeconds : syncTime;
  bus.emit('sync:response', extrapolatedTime, !!data.isPlaying, oneWayLatencySeconds);
}

function handleGlobalResyncRequest(): void {
  setState('sync.autoSyncOffset', 0);
  showToast(t('toast.host_reset_sync'));
  setState('sync.localOffset', 0);
  bus.emit('sync:display-update');
  setManagedTimer('global-resync-jitter', () => {
    if (!getState('network.sessionCode')) return; // Session ended
    startMultiSampleSync();
  }, 500 + Math.random() * 500);
}

function handleGetSyncTime(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Guest ignores

  if (!conn || !conn.open) return;

  const hostReceiveTs = Date.now(); // NTP t2: when host received the request

  bus.emit('sync:get-position', (position: number) => {
    if (!conn.open) return; // guard against close during callback
    const currentState = getState('appState');
    const isPlaying = currentState === APP_STATE.PLAYING_AUDIO ||
                      currentState === APP_STATE.PLAYING_VIDEO ||
                      currentState === APP_STATE.PLAYING_YOUTUBE;

    const hostSendTs = Date.now(); // NTP t3: when host sends the response

    try {
      conn.send({
        type: MSG.SYNC_RESPONSE,
        time: position,
        isPlaying,
        reqTs: (typeof data.ts === 'number' && Number.isFinite(data.ts)) ? data.ts : 0,
        t2: hostReceiveTs,
        t3: hostSendTs,
      });
    } catch { /* connection closed */ }
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
    [MSG.HEARTBEAT]: handleHeartbeat,
    [MSG.HEARTBEAT_ACK]: handleHeartbeatAck,
    [MSG.PING_LATENCY]: handlePingLatency,
    [MSG.PONG_LATENCY]: handlePongLatency,
    [MSG.SYNC_RESPONSE]: handleSyncResponse,
    [MSG.GLOBAL_RESYNC_REQUEST]: handleGlobalResyncRequest,
    [MSG.GET_SYNC_TIME]: handleGetSyncTime,
    [MSG.REQUEST_RENAME]: handleRequestRename,
    [MSG.REQUEST_CHAT_COMMAND]: handleRequestChatCommand,
  });

  // Clean up module-scoped sync state when session ends
  bus.on('state:network.sessionCode', (code: unknown) => {
    if (!code) {
      _syncSamples = [];
      _syncSampleExpected = 0;
      clearManagedTimer('sync-sample');
      clearManagedTimer('sync-timeout');
      setState('sync.lastLatencyMs', 0);
      setState('sync.latencyHistory', []);
    }
  });

  // Bus event handlers for UI-triggered sync actions
  bus.on('sync:nudge', (ms) => {
    if (!Number.isFinite(ms)) return;
    // Dynamic import to avoid circular dependency
    import('../player/transport.ts').then(mod => mod.adjustSync(ms / 1000));
  });

  bus.on('sync:auto-sync', () => {
    handleMainSyncBtn();
  });

  bus.on('sync:close-manual', () => {
    const overlay = document.getElementById('manual-sync-overlay');
    if (overlay) overlay.classList.remove('show');
  });

  // sync:display-update handler is in player-controls.ts (UI module) to maintain
  // network → UI separation. This module only emits the event.

  // Worker tick handlers: Guest sends heartbeat/ping to host
  bus.on('worker:timer-tick', (id) => {
    const hostConn = getState('network.hostConn');
    if (!hostConn || !hostConn.open) return;

    if (id === 'heartbeat') {
      try { hostConn.send({ type: MSG.HEARTBEAT }); } catch { /* noop */ }
    } else if (id === 'ping') {
      try { hostConn.send({ type: MSG.PING_LATENCY, timestamp: Date.now() }); } catch { /* noop */ }
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
