/**
 * MUSIXQUARE 2.0 — Sync & Latency Management
 * Extracted from original app.js lines 6034-6092, 7617-7647, 8415-8449, 9298-9364
 *
 * Manages: Heartbeat, ping/pong latency, auto-sync, manual sync (nudge),
 * sync response handling, global resync.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState, setState } from '../core/state.ts';
import { MSG, APP_STATE } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import type { DataConnection } from '../types/index.ts';
import { registerHandlers } from './protocol.ts';
import { broadcast } from './peer.ts';

let _syncBusyRetryCount = 0;

// ─── Sync Button Logic ──────────────────────────────────────────────

/**
 * Handle the main sync button press.
 * Host: broadcasts global resync. Guest: resets offset and requests sync time.
 */
export function handleMainSyncBtn(): void {
  const currentState = getState<string>('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) return;

  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (!hostConn) {
    // Host: Broadcast resync request to all guests
    broadcast({ type: MSG.GLOBAL_RESYNC_REQUEST });
    bus.emit('ui:show-toast', '모든 기기 재동기화 요청...');
  } else {
    // Guest: Perform auto-sync
    setState('sync.localOffset', 0);
    setState('sync.autoSyncOffset', 0);
    bus.emit('sync:display-update');
    bus.emit('ui:show-toast', '최적 싱크 보정 적용 중...');
    syncReset();
  }
}

// ─── Guest: Sync Reset ──────────────────────────────────────────────

function syncReset(): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (!hostConn || !hostConn.open) return;

  bus.emit('sync:display-update');
  const ts = Date.now();
  try { hostConn.send({ type: MSG.GET_SYNC_TIME, ts }); } catch { /* connection closed */ }
}

// ─── Delayed Global Resync (Host-only) ──────────────────────────────

/**
 * Request a global resync after a short delay.
 * Ensures host-side playback state change has settled across the network.
 */
export function requestGlobalResyncDelayed(delay = 1000): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return; // Host only

  const resyncTimer = getState<ReturnType<typeof setTimeout> | null>('sync.resyncTimer');
  if (resyncTimer) clearTimeout(resyncTimer);

  const timer = setTimeout(() => {
    setState('sync.resyncTimer', null);
    const hc = getState<DataConnection | null>('network.hostConn');
    if (!hc) {
      broadcast({ type: MSG.GLOBAL_RESYNC_REQUEST });
      log.debug(`[Sync] Automatic global resync requested (delay: ${delay}ms)`);
    }
  }, delay);

  setState('sync.resyncTimer', timer);
}

// ─── Manual Sync (Nudge) ────────────────────────────────────────────

/**
 * Nudge the sync offset by a given number of milliseconds.
 */
export function nudgeSync(ms: number): void {
  const localOffset = getState<number>('sync.localOffset');
  setState('sync.localOffset', localOffset + (ms / 1000));
  bus.emit('sync:display-update');

  const currentState = getState<string>('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) {
    bus.emit('sync:youtube-nudge', ms);
    return;
  }

  // Debounce hard sync application
  clearManagedTimer('syncDebounce');
  setManagedTimer('syncDebounce', () => {
    const state = getState<string>('appState');
    if (state !== APP_STATE.IDLE && state !== APP_STATE.PAUSED) {
      bus.emit('sync:nudge-apply', ms);
    }
  }, 450);
}

/**
 * Get the total sync offset (localOffset + autoSyncOffset) in milliseconds.
 */
export function getTotalSyncOffsetMs(): number {
  const localOffset = getState<number>('sync.localOffset');
  const autoSyncOffset = getState<number>('sync.autoSyncOffset');
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
  // Update liveness timestamp
  try {
    if (conn && conn.peer) {
      const connectedPeers = getState<Array<Record<string, unknown>>>('network.connectedPeers');
      const p = connectedPeers.find(x => x.id === conn.peer);
      if (p) p.lastHeartbeat = Date.now();
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
  if (typeof data.timestamp !== 'number') return;
  const ms = Date.now() - data.timestamp;
  const latencyHistory = getState<number[]>('sync.latencyHistory');
  latencyHistory.push(ms);
  if (latencyHistory.length > 10) latencyHistory.shift();
  setState('sync.lastLatencyMs', Math.min(...latencyHistory));
  bus.emit('sync:latency-update', ms);
}

function handleSyncResponse(data: Record<string, unknown>): void {
  const currentState = getState<string>('appState');
  if (currentState === APP_STATE.PLAYING_YOUTUBE) return;

  // Host-busy detection
  if (data.reqTs && typeof data.reqTs === 'number' && data.reqTs > 0) {
    const elapsed = Date.now() - data.reqTs;
    if (elapsed > 150) {
      _syncBusyRetryCount++;
      if (_syncBusyRetryCount < 3) {
        log.debug(`[AutoSync] Host was busy (${elapsed}ms). Retry ${_syncBusyRetryCount}/3 in 300ms...`);
        setTimeout(() => syncReset(), 300);
        return;
      }
      log.warn(`[AutoSync] Host busy retries exhausted (${elapsed}ms). Proceeding with stale data.`);
    } else {
      _syncBusyRetryCount = 0;
    }
  }

  // Latency compensation — 비활성화 (로컬 네트워크에서 RTT 보정 시 오히려 어긋남)
  const oneWayLatencySeconds = 0;
  // const usePingCompensation = getState<boolean>('sync.usePingCompensation');
  // if (usePingCompensation) {
  //   const lastLatencyMs = getState<number>('sync.lastLatencyMs');
  //   oneWayLatencySeconds = (lastLatencyMs / 2) / 1000;
  // }

  setState('sync.autoSyncOffset', oneWayLatencySeconds);
  bus.emit('sync:display-update');

  // Emit sync-response event for player module to handle timing
  bus.emit('sync:response', data.time as number, data.isPlaying as boolean, oneWayLatencySeconds);
}

function handleGlobalResyncRequest(): void {
  bus.emit('ui:show-toast', 'Host 요청: 싱크 초기화 및 재설정...');
  setState('sync.localOffset', 0);
  bus.emit('sync:display-update');
  setTimeout(() => syncReset(), Math.random() * 500);
}

function handleGetSyncTime(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState<DataConnection | null>('network.hostConn');
  if (hostConn) return; // Guest ignores

  if (conn && conn.open) {
    bus.emit('sync:get-position', (position: number) => {
      const currentState = getState<string>('appState');
      const isPlaying = currentState === APP_STATE.PLAYING_AUDIO ||
                        currentState === APP_STATE.PLAYING_VIDEO ||
                        currentState === APP_STATE.PLAYING_YOUTUBE;

      conn.send({
        type: MSG.SYNC_RESPONSE,
        time: position,
        isPlaying,
        reqTs: (data.ts as number) || 0,
      });
    });
  }
}

// ─── Register Handlers ──────────────────────────────────────────────

export function initSync(): void {
  registerHandlers({
    [MSG.HEARTBEAT]: handleHeartbeat,
    [MSG.HEARTBEAT_ACK]: handleHeartbeatAck as unknown as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.PING_LATENCY]: handlePingLatency,
    [MSG.PONG_LATENCY]: handlePongLatency as unknown as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.SYNC_RESPONSE]: handleSyncResponse as unknown as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.GLOBAL_RESYNC_REQUEST]: handleGlobalResyncRequest as unknown as (d: Record<string, unknown>, c: DataConnection) => void,
    [MSG.GET_SYNC_TIME]: handleGetSyncTime,
  });

  // Bus event handlers for UI-triggered sync actions
  bus.on('sync:nudge', ((...args: unknown[]) => {
    const val = Number(args[0]);
    if (!Number.isFinite(val)) return;
    // Dynamic import to avoid circular dependency
    import('../player/playback.ts').then(mod => mod.adjustSync(val / 1000));
  }) as (...args: unknown[]) => void);

  bus.on('sync:auto-sync', (() => {
    handleMainSyncBtn();
  }) as (...args: unknown[]) => void);

  bus.on('sync:close-manual', (() => {
    const overlay = document.getElementById('manual-sync-overlay');
    if (overlay) overlay.classList.remove('show');
  }) as (...args: unknown[]) => void);

  bus.on('sync:display-update', (() => {
    const localOffset = getState<number>('sync.localOffset') || 0;
    const autoSyncOffset = getState<number>('sync.autoSyncOffset') || 0;
    const total = localOffset + autoSyncOffset;
    const el = document.getElementById('manual-sync-value');
    if (el) el.innerText = `${total >= 0 ? '+' : ''}${(total * 1000).toFixed(0)}ms`;
  }) as (...args: unknown[]) => void);

  // Worker tick handlers: Guest sends heartbeat/ping to host
  bus.on('worker:timer-tick', ((...args: unknown[]) => {
    const id = args[0] as string;
    const hostConn = getState<DataConnection | null>('network.hostConn');
    if (!hostConn || !hostConn.open) return;

    if (id === 'heartbeat') {
      try { hostConn.send({ type: MSG.HEARTBEAT }); } catch { /* noop */ }
    } else if (id === 'ping') {
      try { hostConn.send({ type: MSG.PING_LATENCY, timestamp: Date.now() }); } catch { /* noop */ }
    }
  }) as (...args: unknown[]) => void);

  log.info('[Sync] Handlers registered');
}
