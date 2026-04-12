/**
 * MUSIXQUARE 3.0 — Message Protocol & Dispatch
 *
 * Manages: Message validation, handler registry, dispatch (handleData),
 * relay command routing (upstream/downstream), RELAYABLE_COMMANDS list.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG, RELAYABLE_MSG_TYPES } from '../core/constants.ts';
import type { MsgType } from '../core/constants.ts';
import { sendToHost } from './peer.ts';
import { isAssignedRelay } from './orchestrator.ts';
import type { DataConnection, ProtocolMsg, AnyProtocolMsg } from '../types/index.ts';

// ─── Message Validation ─────────────────────────────────────────────

/**
 * Validate message structure — must be an object with a `type` field.
 * Optionally checks for required fields.
 */
export function validateMessage(data: unknown, requiredFields: string[] = []): data is Record<string, unknown> {
  if (!data || typeof data !== 'object') return false;
  const msg = data as Record<string, unknown>;
  if (!msg.type) return false;
  for (const field of requiredFields) {
    if (msg[field] === undefined || msg[field] === null) {
      log.warn(`[Network] Missing required field '${field}' in message:`, msg.type);
      return false;
    }
  }
  return true;
}

// ─── Relayable Commands ─────────────────────────────────────────────

/** Commands that should be automatically relayed through the chain.
 *  3.0: Source of truth is RELAYABLE_MSG_TYPES in constants.ts (satisfies MsgType[]).
 */
export const RELAYABLE_COMMANDS: ReadonlySet<string> = new Set<string>(RELAYABLE_MSG_TYPES);

/** Relay-local requests that should NOT be forwarded upstream (handled from local OPFS). */
const RELAY_LOCAL_REQUESTS: ReadonlySet<string> = new Set([
  'request-current-file', 'request-data-recovery',
]);

// ─── Lightweight Protocol Validators ─────────────────────────────────
// 3.0: Validate high-risk message payloads before dispatch.
// Only critical messages need validators — not all 40+ types.

const isArrayBufferLike = (v: unknown): boolean =>
  v instanceof ArrayBuffer ||
  v instanceof Uint8Array ||
  (v != null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object ArrayBuffer]');

// Tight numeric validator — rejects NaN, Infinity, -Infinity, and out-of-range
// values. Without this, Number(undefined) → NaN silently passes typeof===number,
// and a malicious peer could send index=Infinity to explode a reorder buffer Map.
const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const isNonNegInt = (v: unknown): v is number =>
  isFiniteNumber(v) && v >= 0 && Number.isInteger(v);

// Max 200,000 chunks ≈ 3.2 GB at 16 KB/chunk — prevents DoS via unbounded total
const MAX_FILE_TOTAL = 200_000;

const PROTOCOL_VALIDATORS: Partial<Record<MsgType, (data: Record<string, unknown>) => boolean>> = {
  [MSG.PLAY]: (d) => d.time === undefined || isFiniteNumber(d.time),
  [MSG.PAUSE]: (d) => d.time === undefined || isFiniteNumber(d.time),
  [MSG.VOLUME]: (d) => isFiniteNumber(d.value) && (d.value as number) >= 0 && (d.value as number) <= 1,
  [MSG.FILE_CHUNK]: (d) => isArrayBufferLike(d.chunk) && isNonNegInt(d.index),
  [MSG.FILE_START]: (d) => typeof d.name === 'string' && isNonNegInt(d.total) && (d.total as number) <= MAX_FILE_TOTAL,
  [MSG.FILE_END]: (d) => typeof d.name === 'string',
  [MSG.PRELOAD_CHUNK]: (d) => isArrayBufferLike(d.chunk) && isNonNegInt(d.index),
  [MSG.PRELOAD_START]: (d) => typeof d.name === 'string' && isNonNegInt(d.total) && (d.total as number) <= MAX_FILE_TOTAL,
  [MSG.WELCOME]: (d) => typeof d.label === 'string',
  [MSG.EQ_UPDATE]: (d) => isFiniteNumber(d.band) && (d.band as number) >= 0 && (d.band as number) < 16 && isFiniteNumber(d.value),

  // YouTube messages — validate numeric fields that flow into player APIs / state
  [MSG.YOUTUBE_PLAY]: (d) =>
    (d.videoId === undefined || d.videoId === null || typeof d.videoId === 'string') &&
    (d.index === undefined || isNonNegInt(d.index)) &&
    (d.subIndex === undefined || isNonNegInt(d.subIndex)),
  [MSG.YOUTUBE_SYNC]: (d) =>
    isFiniteNumber(d.time) && isFiniteNumber(d.state) &&
    (d.subIndex === undefined || isFiniteNumber(d.subIndex)),
  [MSG.YOUTUBE_STATE]: (d) =>
    isFiniteNumber(d.state) && (d.time === undefined || isFiniteNumber(d.time)) &&
    (d.hostPlayAt === undefined || isFiniteNumber(d.hostPlayAt)),
  [MSG.YOUTUBE_SUB_TITLE_UPDATE]: (d) =>
    typeof d.playlistId === 'string' && isNonNegInt(d.subIdx) && typeof d.title === 'string',
  [MSG.REQUEST_YOUTUBE_SUB_SEEK]: (d) =>
    isNonNegInt(d.subIdx),

  // File transfer — validate session IDs and indices
  [MSG.FILE_PREPARE]: (d) =>
    (d.name === undefined || typeof d.name === 'string') &&
    (d.index === undefined || isNonNegInt(d.index)) &&
    (d.sessionId === undefined || isFiniteNumber(d.sessionId)),
  [MSG.FILE_RESUME]: (d) =>
    isFiniteNumber(d.sessionId) && isNonNegInt(d.startChunk),

  // Chat — validate text field exists and cap length
  [MSG.CHAT]: (d) => typeof d.text === 'string',

  // Playlist — validate list is an array (individual items checked in handler)
  [MSG.PLAYLIST_UPDATE]: (d) =>
    Array.isArray(d.list) && (d.list as unknown[]).length <= 1000,
};

// ─── Handler Registry ───────────────────────────────────────────────

type MessageHandler = (data: ProtocolMsg<any>, conn: DataConnection) => void | Promise<void>;
const _handlers = new Map<string, MessageHandler>();

/**
 * Register a handler for a specific message type.
 * Can be called from any module during initialization.
 */
export function registerHandler<T extends MsgType>(type: T, handler: (data: ProtocolMsg<T>, conn: DataConnection) => void | Promise<void>): void {
  if (_handlers.has(type)) {
    log.warn(`[Protocol] Overwriting handler for: ${type}`);
  }
  _handlers.set(type, handler as MessageHandler);
}

/**
 * Register multiple handlers at once.
 * Each handler receives a typed payload matching its message type key.
 */
export function registerHandlers(handlers: { [T in MsgType]?: (data: ProtocolMsg<T>, conn: DataConnection) => void | Promise<void> }): void {
  for (const [type, handler] of Object.entries(handlers)) {
    if (handler) registerHandler(type as MsgType, handler as MessageHandler);
  }
}

/**
 * Check if a handler is registered for a given message type.
 */
export function hasHandler(type: MsgType): boolean {
  return _handlers.has(type);
}

// ─── Message Dispatch ───────────────────────────────────────────────

/**
 * Main message dispatcher. Validates, dispatches to registered handler,
 * then handles relay routing (downstream/upstream).
 */
export async function handleData(data: unknown, conn: DataConnection): Promise<void> {
  // Generic validation
  if (!validateMessage(data, [])) return;

  const msg = data as Record<string, unknown>;
  const msgType = msg.type as MsgType;

  // Security: validate _originPeer to prevent spoofing.
  // If _originPeer is set and differs from conn.peer, the message must
  // be arriving through a known relay node. Verify the sender is actually
  // the assigned relay for the claimed origin — prevents any guest from
  // impersonating an operator by setting _originPeer to an operator's ID.
  if (msg._originPeer && msg._originPeer !== conn?.peer) {
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      // Host side: verify sender is the assigned relay for the claimed _originPeer
      if (!isAssignedRelay(msg._originPeer as string, conn?.peer)) {
        log.warn(`[Protocol] Stripping spoofed _originPeer=${msg._originPeer} from ${conn?.peer} (not assigned relay)`);
        delete msg._originPeer;
      }
    }
  }

  // 3.0: Validate high-risk message payloads before dispatch
  const validator = PROTOCOL_VALIDATORS[msgType];
  if (validator && !validator(msg)) {
    log.warn(`[Protocol] Invalid payload for ${msgType}`, Object.keys(msg));
    return;
  }

  // Dispatch to registered handler
  const handler = _handlers.get(msgType);
  if (handler) {
    try {
      await handler(msg as ProtocolMsg<any>, conn);
    } catch (e) {
      log.error(`Error handling ${msgType}:`, e);
    }
  }

  // Relay Architecture (only applies to guests with a host connection)
  const hostConn = getState('network.hostConn');
  if (!hostConn) return;

  // 1. RELAY DOWNSTREAM (Control commands from Upstream → Downstream)
  const downstreamDataPeers = getState('relay.downstreamDataPeers');
  if (downstreamDataPeers.length > 0 && RELAYABLE_COMMANDS.has(msgType)) {
    const senderPeerId = conn?.peer;
    downstreamDataPeers.forEach(p => {
      // Prevent infinite loop: do not relay back to sender (compare by peer ID, not reference)
      if (p.open && (!senderPeerId || p.peer !== senderPeerId)) {
        try { p.send(data); } catch { /* peer might have closed */ }
      }
    });
  }

  // 2. RELAY UPSTREAM (Operator requests from Downstream → Upstream)
  //    Attach _originPeer so the host can verify the actual sender, not the relay.
  //    Exclude relay-local messages that the relay node handles itself
  //    (e.g. request-current-file, request-data-recovery are served from OPFS).
  if (conn && conn !== hostConn) {
    if (msgType.startsWith('request-') && !RELAY_LOCAL_REQUESTS.has(msgType)) {
      const raw = data as Record<string, unknown>;
      // Always overwrite _originPeer with actual sender — never trust downstream value
      // (prevents spoofing: malicious peer could set _originPeer to an operator's ID)
      const forwarded = { ...raw, _originPeer: conn.peer };
      log.debug(`[Relay] Forwarding request downstream->upstream: ${msgType} (origin: ${forwarded._originPeer})`);
      sendToHost(forwarded as unknown as AnyProtocolMsg);
    }
  }
}

// ─── Operator Verification ──────────────────────────────────────────

/**
 * Check whether the peer behind `conn` has been granted Operator privileges.
 * Called by Host-side `request-*` handlers before executing commands.
 * When `data` contains `_originPeer` (relay-forwarded), verify the original sender.
 */
export function verifyOperator(conn: DataConnection, data?: Record<string, unknown>): boolean {
  const peerId = (typeof data?._originPeer === 'string' && data._originPeer) || conn?.peer;
  if (!peerId) return false;
  const connectedPeers = getState('network.connectedPeers');
  const peer = connectedPeers.find(p => p.id === peerId);
  return !!(peer && peer.isOp);
}

// ─── Initialize Protocol ────────────────────────────────────────────

/**
 * Wire up the EventBus → handleData bridge.
 * Call once at app bootstrap after all handlers are registered.
 */
export function initProtocol(): void {
  bus.on('network:data', (data: unknown, conn: unknown) => {
    handleData(data, conn as DataConnection).catch(e =>
      log.error('[Protocol] handleData error:', e)
    );
  });

  log.info('[Protocol] Message router initialized');
}
