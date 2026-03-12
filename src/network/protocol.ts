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

// ─── Lightweight Protocol Validators ─────────────────────────────────
// 3.0: Validate high-risk message payloads before dispatch.
// Only critical messages need validators — not all 40+ types.

const isArrayBufferLike = (v: unknown): boolean =>
  v instanceof ArrayBuffer ||
  v instanceof Uint8Array ||
  (v != null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object ArrayBuffer]');

const PROTOCOL_VALIDATORS: Partial<Record<MsgType, (data: Record<string, unknown>) => boolean>> = {
  [MSG.PLAY]: (d) => d.time === undefined || typeof d.time === 'number',
  [MSG.PAUSE]: (d) => d.time === undefined || typeof d.time === 'number',
  [MSG.VOLUME]: (d) => typeof d.value === 'number',
  [MSG.FILE_CHUNK]: (d) => isArrayBufferLike(d.chunk) && typeof d.index === 'number',
  [MSG.FILE_START]: (d) => typeof d.name === 'string' && typeof d.total === 'number',
  [MSG.FILE_END]: (d) => typeof d.name === 'string',
  [MSG.PRELOAD_CHUNK]: (d) => isArrayBufferLike(d.chunk) && typeof d.index === 'number',
  [MSG.PRELOAD_START]: (d) => typeof d.name === 'string' && typeof d.total === 'number',
  [MSG.WELCOME]: (d) => typeof d.peerId === 'string',
  [MSG.EQ_UPDATE]: (d) => typeof d.band === 'number' && typeof d.value === 'number',
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
  // be arriving through a known relay node. Otherwise strip _originPeer
  // so that verifyOperator uses the actual sender.
  if (msg._originPeer && msg._originPeer !== conn?.peer) {
    const hostConn = getState('network.hostConn');
    if (!hostConn) {
      // Host side: verify the direct sender is a connected peer acting as relay
      const connectedPeers = getState('network.connectedPeers');
      const senderPeer = connectedPeers.find(p => p.id === conn?.peer);
      if (!senderPeer) {
        log.warn(`[Protocol] Stripping spoofed _originPeer from unknown sender: ${conn?.peer}`);
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
  if (conn && conn !== hostConn) {
    if (msgType.startsWith('request-')) {
      const raw = data as Record<string, unknown>;
      const forwarded = { ...raw, _originPeer: raw._originPeer || conn.peer };
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
