/**
 * MUSIXQUARE — Sync & Latency Management
 *
 * Manages: Heartbeat, ping/pong latency, manual sync (nudge).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { t } from '../i18n/index.ts';
import { getState, setState } from '../core/state.ts';
import {
  MSG,
  MANUAL_SYNC_OFFSET_LIMIT_SEC,
  PLAYBACK_STATE,
  RESERVED_NAMES,
  type PlaybackActivityValue,
  type PlaybackModeValue,
} from '../core/constants.ts';
import type { DataConnection } from '../types/index.ts';
import { registerHandlers } from './protocol.ts';
import { broadcast, broadcastDeviceList } from './peer.ts';
import {
  play,
  getTrackPosition,
  adjustSync,
  setLocalManualSyncOffset,
} from '../player/transport.ts';
import { getCurrentAudioBuffer } from '../player/_state.ts';
import { containsProfanity } from '../chat/profanity.ts';
import { releasePeerSlot } from './peer-state.ts';
import {
  getHostNow,
  registerPing,
  processSyncPong,
  resetClockState,
  setIsHostClock,
} from './shared-clock.ts';
import { setManagedTimer, clearManagedTimer } from '../core/timers.ts';
import { showToast } from '../ui/toast.ts';
import { MAX_MSG_LENGTH, MAX_SENDER_LABEL_LENGTH } from '../ui/chat-render.ts';
import { rememberPinnedNotice } from '../chat/protocol.ts';
import {
  getPlaybackModeActivity,
  isPlaybackActivityValue,
  isPlaybackModeFile,
  isPlaybackModeYouTube,
  isPlaybackModeValue,
  isPlaybackPendingFile,
  isPlaybackPlayingFile,
} from '../player/ownership.ts';

let _syncPingCounter = 0;
let _needsInitialSync = false;
let _wasPlaying = false;

const YOUTUBE_NUDGE_APPLY_DEBOUNCE_MS = 1000;

interface SyncPongPlaybackState {
  mode: PlaybackModeValue;
  activity: PlaybackActivityValue;
}

function resetSyncClockRuntime(): void {
  setState('sync.lastLatencyMs', 0);
  setState('sync.latencyHistory', []);
  resetClockState();
  _syncPingCounter = 0;
  _needsInitialSync = false;
  clearManagedTimer('sync-youtube-nudge-apply');
}

/**
 * Get the total sync offset in milliseconds.
 */
export function getTotalSyncOffsetMs(): number {
  const localOffset = getState('sync.localOffset');
  return Math.round(localOffset * 1000);
}

function getActiveManualOffsetPath(): 'sync.localOffset' | 'sync.youtubeLocalOffset' {
  return isPlaybackModeYouTube() ? 'sync.youtubeLocalOffset' : 'sync.localOffset';
}

function clampManualSyncOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MANUAL_SYNC_OFFSET_LIMIT_SEC, Math.min(MANUAL_SYNC_OFFSET_LIMIT_SEC, value));
}

function canApplyManualSyncAction(): boolean {
  const hostConn = getState('network.hostConn');
  if (!hostConn?.open) return false;
  if (isPlaybackModeYouTube()) return true;
  return isPlaybackModeFile() && !!getCurrentAudioBuffer();
}

function rejectManualSyncAction(): void {
  bus.emit('sync:close-manual');
  showToast(t('toast.sync_not_ready'));
}

function scheduleYouTubeManualSyncApply(): void {
  clearManagedTimer('sync-youtube-nudge-apply');

  const hostConn = getState('network.hostConn');
  if (!hostConn?.open || !isPlaybackModeYouTube()) return;

  setManagedTimer(
    'sync-youtube-nudge-apply',
    () => {
      const currentHostConn = getState('network.hostConn');
      if (!currentHostConn?.open || !isPlaybackModeYouTube()) return;
      bus.emit('youtube:apply-manual-sync');
    },
    YOUTUBE_NUDGE_APPLY_DEBOUNCE_MS,
  );
}

function adjustYouTubeSync(val: number): void {
  const localOffset = getState('sync.youtubeLocalOffset') || 0;
  setState('sync.youtubeLocalOffset', clampManualSyncOffset(localOffset + val));
  bus.emit('sync:display-update');
  scheduleYouTubeManualSyncApply();
}

// ─── Auto Sync ──────────────────────────────────────────────────────

export function handleAutoSync(): void {
  const offsetPath = getActiveManualOffsetPath();
  if (offsetPath === 'sync.localOffset') {
    setLocalManualSyncOffset(0);
  } else {
    setState(offsetPath, 0);
  }
  bus.emit('sync:display-update');
  showToast(t('toast.sync_reset'));
  clearManagedTimer('sync-youtube-nudge-apply');

  if (offsetPath === 'sync.youtubeLocalOffset') {
    const hostConn = getState('network.hostConn');
    if (hostConn?.open && isPlaybackModeYouTube()) {
      bus.emit('youtube:apply-manual-sync');
    }
    return;
  }

  // Cancel any pending nudge replay from a click burst — otherwise its
  // deferred play() could fire AFTER our reset replay and re-introduce
  // whatever (now-zero) offset it captured. Belt-and-suspenders: the
  // zeroing above already means that deferred play() would compute the
  // same position, but explicit cancel removes the extra round trip.
  clearManagedTimer('sync-nudge-replay');

  // Zeroing localOffset only flips the number. The audio buffer source was
  // started with a startedAt that baked in the OLD offset, so it keeps
  // playing from the offset position until a fresh play() recomputes
  // startedAt from the new (zero) offset. Without this, "Reset" just
  // changes the displayed value while the audio remains desynced, and
  // the only recovery is a host seek or pause+play.
  if (!isPlaybackPlayingFile()) return;
  play(getTrackPosition());
}

// ─── Protocol Handlers ──────────────────────────────────────────────

export function getSyncPongPlaybackState(): SyncPongPlaybackState {
  const lifecycle = getState('playback.lifecycle');
  const playback = getPlaybackModeActivity();

  // During host track switches, stopAllMedia({ silent: true }) intentionally
  // leaves playback.mode/activity at file/playing to avoid UI flicker while
  // the new file decodes and waits for autoPlayTimer. That is not audible
  // playback, so the wire view advertises the paused file shadow.
  if (isPlaybackPlayingFile(playback)) {
    if (lifecycle === PLAYBACK_STATE.PLAYING) {
      return { mode: 'file', activity: 'playing' };
    }

    return { mode: 'file', activity: 'paused' };
  }

  // Do not let a stale file lifecycle create a new wire-visible "playing"
  // state.
  if (isPlaybackPendingFile(playback)) {
    return { mode: 'file', activity: 'pending' };
  }

  return {
    mode: playback.mode,
    activity: playback.activity,
  };
}

export function isSyncPongPlayingFile(data: Record<string, unknown>): boolean {
  if (isPlaybackModeValue(data.mode) && isPlaybackActivityValue(data.activity)) {
    return isPlaybackPlayingFile({ mode: data.mode, activity: data.activity });
  }

  return false;
}

function createSyncPongPayload({
  pingId,
  hostTime,
  position,
  playbackState,
}: {
  pingId: unknown;
  hostTime: number;
  position: number;
  playbackState: SyncPongPlaybackState;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: MSG.SYNC_PONG,
    pingId,
    hostTime,
    position,
    mode: playbackState.mode,
    activity: playbackState.activity,
    trackIndex: getState('playlist.currentTrackIndex'),
  };

  return payload;
}

function getSafeSyncPongPosition(isFilePlaying: boolean): number {
  if (!isFilePlaying) return 0;

  try {
    return getTrackPosition();
  } catch (error) {
    log.debug('[Sync] Failed to read track position for SYNC_PONG:', error);
    return 0;
  }
}

function handleSyncPing(data: Record<string, unknown>, conn: DataConnection): void {
  // 1. Liveness update (from old handleHeartbeat)
  try {
    if (conn?.peer) {
      const connectedPeers = getState('network.connectedPeers');
      const p = connectedPeers.find((x) => x.id === conn.peer);
      if (p) {
        setState(
          'network.connectedPeers',
          connectedPeers.map((x) => (x.id === conn.peer ? { ...x, lastHeartbeat: Date.now() } : x)),
        );
      }
    }
  } catch (e) {
    log.debug('[Sync] Liveness update error:', e);
  }

  // 2. Reply with SYNC_PONG including host time + playback state
  if (!conn?.open) return;
  const hostTime = Date.now(); // Capture BEFORE async import
  const playbackState = getSyncPongPlaybackState();
  const isFilePlaying = playbackState.mode === 'file' && playbackState.activity === 'playing';
  const position = getSafeSyncPongPosition(isFilePlaying);

  if (isFilePlaying) {
    if (conn.open) {
      try {
        conn.send(
          createSyncPongPayload({
            pingId: data.pingId,
            hostTime,
            position,
            playbackState,
          }),
        );
      } catch {
        /* closed */
      }
    }
  } else {
    try {
      conn.send(
        createSyncPongPayload({
          pingId: data.pingId,
          hostTime,
          position,
          playbackState,
        }),
      );
    } catch {
      /* closed */
    }
  }
}

function handleSyncPong(data: Record<string, unknown>, conn?: DataConnection): void {
  // SYNC_PONG is host's reply to a guest's SYNC_PING — host never receives
  // it on the legitimate path, and a guest only receives it from hostConn.
  // Without this guard, any non-host peer could inject a fake
  // hostTime/position which feeds processSyncPong (clock-offset poisoning)
  // and play() at L155/161 (file-mode position jump).
  // pingId matching in processSyncPong gives partial protection but pingIds
  // are sequential (L30 _syncPingCounter) and predictable. SYNC_PONG is
  // per-handler defense is required.
  const hostConn = getState('network.hostConn');
  if (!hostConn || conn !== hostConn) return;

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

  // 3. File mode drift correction OR initial-bootstrap kickoff.
  //
  // Two scenarios reach this branch:
  //   (a) Guest is already PLAYING_AUDIO — drift correction (existing).
  //   (b) Guest just finished decoding a buffer (READY/PAUSED/IDLE) but
  //       never received an applicable MSG.PLAY. This happens on the very
  //       first remote-share download: the host had broadcast PLAY before
  //       the guest joined (or before the encrypted blob finished
  //       downloading), so pendingPlayTime was either never set or was
  //       cleared. Without bootstrap, the guest sits at 0:00 until the
  //       host pauses/seeks/re-plays — exactly the "first remote download
  //       won't auto-play" symptom.
  if (!isSyncPongPlayingFile(data)) return;
  if (!Number.isFinite(position)) return;

  const hostElapsed = (getHostNow() - hostTime) / 1000;
  const estimatedHostPos = position + hostElapsed;

  if (!isPlaybackPlayingFile()) {
    const lifecycle = getState('playback.lifecycle');
    if (
      lifecycle === PLAYBACK_STATE.AWAITING_PRELOAD ||
      lifecycle === PLAYBACK_STATE.DOWNLOADING ||
      lifecycle === PLAYBACK_STATE.DECODING
    ) {
      log.debug(`[Sync] Bootstrap skipped while ${lifecycle}; waiting for the new buffer`);
      return;
    }

    // Bootstrap: only if we have a decoded buffer. Otherwise the audio
    // engine has nothing to start, and play() would no-op (or worse,
    // race with an in-flight decode).
    if (getCurrentAudioBuffer()) {
      log.info(
        `[Sync] Initial bootstrap: starting playback at host position ${estimatedHostPos.toFixed(2)}s`,
      );
      play(estimatedHostPos);
      _needsInitialSync = false;
      bus.emit('sync:arm-initial');
    }
    return;
  }

  // First pong after play start: unconditionally lock to host
  if (_needsInitialSync) {
    _needsInitialSync = false;
    play(estimatedHostPos);
    return;
  }
  // Ongoing: correct if drift > 2s
  const drift = Math.abs(estimatedHostPos - getTrackPosition());
  if (drift > 2) {
    play(estimatedHostPos);
  }
}

// ─── Register Handlers ──────────────────────────────────────────────

// ─── Rename Handler (host-only) ─────────────────────────────────────
// Registered here instead of host.ts to avoid circular dependency
// (host.ts → protocol.ts → peer.ts → host.ts).

// Guest-side cooldown to absorb host rapid-click / drag bursts and avoid
// seek storms. Host trusted in threat model, so this is primarily UX
// protection (60Hz pointermove → 60 seeks/s would make audio unlistenable).
// hostConn replacement naturally clears the timestamp via the >1000ms gap.
// (10차 audit Phase 6 finding.)
let _lastSyncRequestAt = 0;
function handleSyncRequest(_data: Record<string, unknown>, conn?: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (!hostConn?.open || conn !== hostConn) return;

  const now = Date.now();
  if (now - _lastSyncRequestAt < 1000) return;
  _lastSyncRequestAt = now;

  bus.emit('sync:force-resync');
}

function handleRequestRename(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host processes this

  const peerId = conn?.peer;
  if (!peerId) return;

  const newLabel = String(data.newLabel || '')
    .trim()
    .slice(0, 20);
  if (!newLabel) return;

  // Reserved name / profanity check
  if (RESERVED_NAMES.some((r) => newLabel.toLowerCase() === r.toLowerCase())) return;
  if (containsProfanity(newLabel)) return;

  // Duplicate name check (including host's own label)
  const hostLabel = getState('network.myDeviceLabel') || '';
  if (hostLabel && newLabel.toLowerCase() === hostLabel.toLowerCase()) return;
  const peers = getState('network.connectedPeers');
  if (peers.some((p) => p.id !== peerId && p.label.toLowerCase() === newLabel.toLowerCase()))
    return;

  setState('network.peerLabels', { ...getState('network.peerLabels'), [peerId]: newLabel });
  setState(
    'network.connectedPeers',
    peers.map((p) => (p.id === peerId ? { ...p, label: newLabel } : p)),
  );

  broadcastDeviceList();
  log.info(`[Sync] Peer ${peerId} renamed to "${newLabel}"`);
}

// ─── Chat Command Request (OP guest → Host) ─────────────────────

function handleRequestChatCommand(data: Record<string, unknown>, conn: DataConnection): void {
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host processes this

  const peerId = conn?.peer;
  if (!peerId) return;

  // Verify OP status
  const peers = getState('network.connectedPeers');
  const peer = peers.find((p) => p.id === peerId);
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
      bus.emit(
        'chat:system-message',
        sec > 0 ? t('chat.cmd_slowmode_on', { sec }) : t('chat.cmd_slowmode_off'),
      );
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
      // Cap length before broadcast so an OP can't amplify a 10MB arg to N peers.
      const text = args.join(' ').trim().slice(0, MAX_MSG_LENGTH);
      if (!text) return;
      const peerLabel = (peer.label || 'OP').substring(0, MAX_SENDER_LABEL_LENGTH);
      const noticePayload = { type: MSG.CHAT_NOTICE, senderLabel: peerLabel, text, ts: Date.now() };
      rememberPinnedNotice(noticePayload);
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
      const p = peers.find((peer) => peer.joinOrder === order);
      if (p) return { peerId: p.id, label: p.label };
    }
    return null;
  }
  const lower = arg.toLowerCase();
  const p = peers.find((peer) => peer.label.toLowerCase() === lower);
  if (p) return { peerId: p.id, label: p.label };
  return null;
}

export function initSync(): void {
  registerHandlers({
    [MSG.SYNC_PING]: handleSyncPing,
    [MSG.SYNC_PONG]: handleSyncPong,
    [MSG.SYNC_REQUEST]: handleSyncRequest,
    [MSG.REQUEST_RENAME]: handleRequestRename,
    [MSG.REQUEST_CHAT_COMMAND]: handleRequestChatCommand,
  });

  // SharedClock role management (replaces old initSharedClock)
  bus.on('state:network.appRole', () => {
    const role = getState('network.appRole');
    setIsHostClock(role === 'host');
    if (role !== 'host' && role !== 'guest') resetClockState();
  });

  bus.on('state:network.hostConn', () => {
    if (getState('network.appRole') !== 'guest') return;
    resetSyncClockRuntime();
  });

  // Guest: arm initial sync 1s after any play command (audio engine stable by then)
  const armInitialSync = () => {
    setManagedTimer(
      'initial-sync-arm',
      () => {
        _needsInitialSync = true;
      },
      1000,
    );
  };

  // Playback state transitions: arm on IDLE/PAUSED → PLAYING, disarm on pause/stop
  const syncInitialArmFromPlayback = () => {
    const isPlaying = isPlaybackPlayingFile();
    if (isPlaying && !_wasPlaying) {
      armInitialSync();
    }
    if (!isPlaying) {
      clearManagedTimer('initial-sync-arm');
      _needsInitialSync = false;
    }
    _wasPlaying = isPlaying;
  };
  bus.on('state:playback.mode', syncInitialArmFromPlayback);
  bus.on('state:playback.activity', syncInitialArmFromPlayback);

  // Host seek/play while already playing (mode/activity may not change)
  bus.on('sync:arm-initial', armInitialSync);

  // Clean up sync state when session ends
  bus.on('state:network.sessionCode', (code: unknown) => {
    if (!code) {
      resetSyncClockRuntime();
      _wasPlaying = false;
    }
  });

  // Bus event handlers for UI-triggered sync actions
  bus.on('sync:nudge', (ms) => {
    if (!Number.isFinite(ms)) return;
    if (!canApplyManualSyncAction()) {
      rejectManualSyncAction();
      return;
    }
    if (isPlaybackModeYouTube()) {
      adjustYouTubeSync(ms / 1000);
      return;
    }
    adjustSync(ms / 1000);
  });

  bus.on('sync:auto-sync', () => {
    if (!canApplyManualSyncAction()) {
      rejectManualSyncAction();
      return;
    }
    handleAutoSync();
  });

  // Fire an out-of-band SYNC_PING immediately. Used by remote-share's
  // first-load bootstrap path so the SYNC_PONG response can kickstart
  // playback at the host's current position before the next 1s worker
  // tick. Without this, a fresh remote guest who finished decoding
  // AFTER the host's MSG.PLAY had already fired would wait up to 1s
  // before bootstrap fires.
  bus.on('sync:request-immediate-ping', () => {
    const hostConn = getState('network.hostConn');
    if (!hostConn || !hostConn.open) return;
    const pingId = ++_syncPingCounter;
    registerPing(pingId);
    try {
      hostConn.send({ type: MSG.SYNC_PING, pingId, guestTime: Date.now() });
    } catch {
      /* noop */
    }
  });

  // Long background resume recovery: force the next valid SYNC_PONG to
  // re-lock local-file playback even when drift is under the normal 2s
  // correction threshold.
  bus.on('sync:force-resync', () => {
    const hostConn = getState('network.hostConn');
    if (!hostConn?.open) return;
    _needsInitialSync = true;
    bus.emit('sync:request-immediate-ping');
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
      try {
        hostConn.send({ type: MSG.SYNC_PING, pingId, guestTime: Date.now() });
      } catch {
        /* noop */
      }
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

const HEARTBEAT_STALE_THRESHOLD = 8000; // 8s without heartbeat = stale
const HEARTBEAT_CHECK_INTERVAL = 5000; // check every 5s

function startHeartbeatMonitor(): void {
  stopHeartbeatMonitor();
  const hostConn = getState('network.hostConn');
  if (hostConn) return; // Only host monitors

  setManagedTimer(
    'heartbeat-monitor',
    () => {
      const hc = getState('network.hostConn');
      if (hc) {
        stopHeartbeatMonitor();
        return;
      } // No longer host

      const now = Date.now();
      const connectedPeers = getState('network.connectedPeers');
      const stalePeerIds: string[] = [];

      for (const p of connectedPeers) {
        if (p.status !== 'connected') continue;
        const elapsed = now - ((p.lastHeartbeat as number) || 0);
        if (elapsed > HEARTBEAT_STALE_THRESHOLD) {
          log.warn(
            `[Heartbeat] Peer ${p.label || p.id} stale (${(elapsed / 1000).toFixed(1)}s) — marking disconnected`,
          );
          stalePeerIds.push(p.id);

          // Try to close the stale connection
          try {
            const conn = p.conn as DataConnection;
            if (conn) conn.close();
          } catch {
            /* noop */
          }
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
        setState(
          'network.connectedPeers',
          connectedPeers.filter((p) => !staleSet.has(p.id)),
        );

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
    },
    HEARTBEAT_CHECK_INTERVAL,
    { interval: true },
  );

  log.info('[Heartbeat] Monitor started');
}

function stopHeartbeatMonitor(): void {
  clearManagedTimer('heartbeat-monitor');
}
