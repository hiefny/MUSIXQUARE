/**
 * Standard-room host presence.
 *
 * A Standard room lives in the host's browser tab. A hidden host tab cannot
 * restart local-file audio, so it refuses guest commands that would start or
 * move it and says why. A frozen host tab answers nothing at all. Guests learn
 * both:
 *
 * - every ping reply carries `hostHidden` while the host tab is hidden, so the
 *   guest's view heals with the next reply even after a burst of dropped frames;
 * - guests treat {@link HOST_SILENCE_MS} without any host frame as an
 *   unresponsive host (they ping every second, so a live host always answers).
 *
 * While the host is unresponsive, guests hold room commands with a toast
 * instead of sending them into silence. PRO rooms are server-authoritative and
 * unaffected.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
import type { MsgType } from '../core/constants.ts';
import { clearManagedTimer, setManagedTimer } from '../core/timers.ts';
import { t } from '../i18n/index.ts';
import {
  isActiveStandardRoomCoordinator,
  isStandardRoomMember,
  subscribeRoomAuthorityLifecycle,
  verifyPeerCapability,
} from '../rooms/authority.ts';
import { getQueueItemById } from '../player/queue-model.ts';
import type { DataConnection, HostPresence, ProtocolMsg } from '../types/index.ts';

/** Guests ping every second, so five seconds of silence is several missed answers. */
const HOST_SILENCE_MS = 5_000;
/** After a minute of silence the guest is offered to leave the room. */
const HOST_LONG_SILENCE_MS = 60_000;
const WATCHDOG_TIMER = 'host-presence-watchdog';
const WATCHDOG_INTERVAL_MS = 1_000;

/**
 * Commands a guest sends for a user action. Pings, file chunks, recovery
 * requests and settings sync are not listed: they must keep flowing so the
 * guest notices when the host answers again.
 */
const GUEST_COMMAND_TYPES: ReadonlySet<string> = new Set<MsgType>([
  MSG.REQUEST_PLAY,
  MSG.REQUEST_PAUSE,
  MSG.REQUEST_SEEK,
  MSG.REQUEST_SKIP_TIME,
  MSG.REQUEST_TRACK_CHANGE,
  MSG.REQUEST_NEXT_TRACK,
  MSG.REQUEST_PREV_TRACK,
  MSG.REQUEST_YOUTUBE_PLAY,
  MSG.REQUEST_YOUTUBE_PAUSE,
  MSG.REQUEST_YOUTUBE_TOGGLE,
  MSG.REQUEST_YOUTUBE_SUB_SEEK,
  MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
  MSG.REQUEST_PLAYLIST_REMOVE,
  MSG.REQUEST_PLAYLIST_REORDER,
  MSG.REQUEST_PLAYLIST_SWITCH,
  MSG.REQUEST_PLAYLIST_TRANSFER,
  MSG.OPERATOR_FILE_UPLOAD_BATCH_START,
  MSG.REQUEST_SETTING,
  MSG.CHAT,
  MSG.CHAT_WHISPER,
  MSG.REQUEST_CHAT_COMMAND,
  MSG.REQUEST_KICK_DEVICE,
  MSG.REQUEST_KICK_PHYSICAL_DEVICE,
  MSG.REQUEST_DEMO_ENTER,
  MSG.REQUEST_DEMO_EXIT,
]);

/** Held chat says "message"; every other held command says "request". */
const CHAT_COMMAND_TYPES: ReadonlySet<string> = new Set<MsgType>([
  MSG.CHAT,
  MSG.CHAT_WHISPER,
  MSG.REQUEST_CHAT_COMMAND,
]);

function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

// ─── Guest ──────────────────────────────────────────────────────────

let presence: HostPresence = 'ok';
let hostHidden = false;
/** The join finished; from here on, host silence means something. */
let armed = false;
let lastHostFrameAt = 0;
let longSilenceAnnounced = false;
let watchedConn: DataConnection | null = null;

export function getHostPresence(): HostPresence {
  return presence;
}

/** Whether the watched host has sent nothing for at least `ms`. */
export function isHostSilentFor(ms: number): boolean {
  return watchedConn !== null && armed && Date.now() - lastHostFrameAt >= ms;
}

function setPresence(next: HostPresence, cause: 'host' | 'reset'): void {
  if (next === presence) return;
  const previous = presence;
  presence = next;
  log.info(`[HostPresence] ${previous} -> ${next} (${cause})`);
  bus.emit('host-presence:changed', next, previous, cause);
}

function evaluate(): void {
  if (!watchedConn || !armed) return;
  const silentMs = Date.now() - lastHostFrameAt;
  if (silentMs >= HOST_SILENCE_MS) {
    setPresence('unresponsive', 'host');
    if (!longSilenceAnnounced && silentMs >= HOST_LONG_SILENCE_MS) {
      longSilenceAnnounced = true;
      bus.emit('host-presence:long-unresponsive');
    }
    return;
  }
  longSilenceAnnounced = false;
  setPresence(hostHidden ? 'background' : 'ok', 'host');
}

/**
 * Any frame from the watched host connection proves the host page is running,
 * and each ping reply says whether its tab is hidden.
 */
export function noteHostFrame(conn: DataConnection, msg: Readonly<Record<string, unknown>>): void {
  if (conn !== watchedConn) return;
  lastHostFrameAt = Date.now();
  if (msg.type === MSG.SYNC_PONG) {
    hostHidden = msg.hostHidden === true;
    evaluate();
  } else if (presence === 'unresponsive') {
    evaluate();
  }
}

function watchHostConnection(): void {
  const conn = getState('network.hostConn');
  const next = conn && isStandardRoomMember() ? conn : null;
  if (next === watchedConn) return;
  watchedConn = next;
  hostHidden = false;
  armed = false;
  longSilenceAnnounced = false;
  lastHostFrameAt = 0;
  // A new or closed connection resets quietly: the join and disconnect flows
  // own that UI.
  setPresence('ok', 'reset');
  syncWatchdog();
}

/**
 * The host is judged only while this page is on screen, so the watchdog runs
 * only then. The visibility handler restarts it with an immediate check.
 */
function syncWatchdog(): void {
  if (watchedConn && !isPageHidden()) {
    setManagedTimer(WATCHDOG_TIMER, tick, WATCHDOG_INTERVAL_MS, { interval: true });
  } else {
    clearManagedTimer(WATCHDOG_TIMER);
  }
}

function tick(): void {
  const conn = watchedConn;
  if (!conn || getState('network.hostConn') !== conn) {
    watchHostConnection();
    return;
  }
  // The host is judged only while this page is on screen with an open link.
  if (!armed || !conn.open || isPageHidden()) return;
  evaluate();
}

function armAfterJoin(conn: DataConnection): void {
  if (conn !== watchedConn) return;
  armed = true;
  lastHostFrameAt = Date.now();
}

export function handleHostCommandRejectedMessage(
  data: ProtocolMsg<typeof MSG.HOST_COMMAND_REJECTED>,
  conn: DataConnection,
): void {
  if (conn !== watchedConn || data.reason !== 'host-hidden') return;
  hostHidden = true;
  evaluate();
  bus.emit('ui:show-toast', t('toast.host_background_blocked'));
}

/**
 * Hold a guest command bound for the watched host while that host answers
 * nothing, and tell the user why. Returns true when the command was held.
 */
export function refuseHostCommand(
  conn: DataConnection | null | undefined,
  msg: { readonly type: string },
): boolean {
  if (!conn || conn !== watchedConn || presence !== 'unresponsive') return false;
  if (!GUEST_COMMAND_TYPES.has(msg.type)) return false;
  log.info(`[HostPresence] Held ${msg.type}: the host is not responding`);
  bus.emit(
    'ui:show-toast',
    t(
      CHAT_COMMAND_TYPES.has(msg.type)
        ? 'toast.host_unresponsive_chat'
        : 'toast.host_unresponsive_blocked',
    ),
  );
  return true;
}

// ─── Host ───────────────────────────────────────────────────────────

/** The ping-reply field that tells guests this Standard host tab is hidden. */
export function syncPongHostPresence(): { hostHidden?: true } {
  return isPageHidden() && isActiveStandardRoomCoordinator() ? { hostHidden: true } : {};
}

function isLocalFileItem(queueItemId: unknown): boolean {
  return typeof queueItemId === 'string' && getQueueItemById(queueItemId)?.type === 'file';
}

/**
 * Whether a guest command would start local-file audio or move it while it
 * plays. A hidden host cannot do either: its audio clock only restarts in the
 * foreground. Pause and a paused seek still work, and YouTube commands are
 * left to the iframe, which may keep working in a hidden desktop tab.
 */
function startsOrMovesLocalFile(type: string, msg: Readonly<Record<string, unknown>>): boolean {
  switch (type) {
    case MSG.REQUEST_PLAY:
    case MSG.REQUEST_TRACK_CHANGE:
    case MSG.REQUEST_NEXT_TRACK:
    case MSG.REQUEST_PREV_TRACK:
      return isLocalFileItem(msg.queueItemId);
    case MSG.REQUEST_SEEK:
    case MSG.REQUEST_SKIP_TIME:
      return getState('playback.mode') === 'file' && getState('playback.activity') === 'playing';
    default:
      return false;
  }
}

/**
 * On a hidden Standard host, refuse a permitted guest command that would start
 * or move local-file audio, instead of letting it fail without a word. Returns
 * true when the command was refused and must not run.
 */
export function refuseWhileHostHidden(
  type: string,
  msg: Readonly<Record<string, unknown>>,
  conn: DataConnection,
): boolean {
  if (!isPageHidden() || !isActiveStandardRoomCoordinator()) return false;
  if (!startsOrMovesLocalFile(type, msg)) return false;
  if (!verifyPeerCapability(conn, 'playback.control')) return false;
  try {
    if (conn.open) {
      conn.send({ type: MSG.HOST_COMMAND_REJECTED, reason: 'host-hidden', command: type });
    }
  } catch (error) {
    log.debug('[HostPresence] Rejection send failed', error);
  }
  log.info(`[HostPresence] Refused ${type} while the host tab is hidden`);
  return true;
}

// ─── Init ───────────────────────────────────────────────────────────

let initialized = false;

function handleVisibilityChange(): void {
  syncWatchdog();
  if (!watchedConn || isPageHidden()) return;
  // Back on screen, this page's own pings resume; restart the silence window
  // and settle the presence now instead of on the next tick.
  if (armed) lastHostFrameAt = Date.now();
  tick();
}

export function initHostPresence(): void {
  if (initialized) return;
  initialized = true;
  subscribeRoomAuthorityLifecycle(watchHostConnection);
  bus.on('network:peer-connected', armAfterJoin);
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

export const hostPresenceTimingForTests = {
  silenceMs: HOST_SILENCE_MS,
  longSilenceMs: HOST_LONG_SILENCE_MS,
} as const;

/** Test seam: return the module to its initial state. */
export function resetHostPresenceForTests(): void {
  clearManagedTimer(WATCHDOG_TIMER);
  presence = 'ok';
  hostHidden = false;
  armed = false;
  lastHostFrameAt = 0;
  longSilenceAnnounced = false;
  watchedConn = null;
}
