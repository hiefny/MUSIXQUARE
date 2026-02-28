/**
 * MUSIXQUARE 2.0 — Message Protocol & Dispatch
 * Extracted from original app.js lines 8935-9027, 9175-9223
 *
 * Manages: Message validation, handler registry, dispatch (handleData),
 * relay command routing (upstream/downstream), RELAYABLE_COMMANDS list.
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG } from '../core/constants.ts';
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

/** Commands that should be automatically relayed through the chain */
export const RELAYABLE_COMMANDS: MsgType[] = [
  MSG.PLAY, MSG.PAUSE, MSG.VOLUME,
  MSG.EQ_UPDATE, MSG.PREAMP, MSG.EQ_RESET,
  MSG.REVERB, MSG.REVERB_TYPE, MSG.REVERB_DECAY,
  MSG.REVERB_PREDELAY, MSG.REVERB_LOWCUT, MSG.REVERB_HIGHCUT,
  MSG.STEREO_WIDTH, MSG.VBASS,
  MSG.REPEAT_MODE, MSG.SHUFFLE_MODE,
  MSG.YOUTUBE_PLAY, MSG.YOUTUBE_SYNC, MSG.YOUTUBE_STATE,
  MSG.YOUTUBE_STOP, MSG.YOUTUBE_SUB_TITLE_UPDATE,
  MSG.SYS_TOAST, MSG.STATUS_SYNC, MSG.CHAT,
  MSG.PLAYLIST_UPDATE, MSG.PLAYLIST,
];

// ─── Handler Registry ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // Dispatch to registered handler
  const handler = _handlers.get(msgType);
  if (handler) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  if (downstreamDataPeers.length > 0 && (RELAYABLE_COMMANDS as string[]).includes(msgType)) {
    downstreamDataPeers.forEach(p => {
      // Prevent infinite loop: do not relay back to sender
      if (p.open && p !== conn) {
        try { p.send(data); } catch { /* peer might have closed */ }
      }
    });
  }

  // 2. RELAY UPSTREAM (Operator requests from Downstream → Upstream)
  if (conn && conn !== hostConn) {
    if (msgType.startsWith('request-')) {
      log.debug(`[Relay] Forwarding request downstream->upstream: ${msgType}`);
      sendToHost(data as AnyProtocolMsg);
    }
  }
}

// ─── Operator Verification ──────────────────────────────────────────

/**
 * Check whether the peer behind `conn` has been granted Operator privileges.
 * Called by Host-side `request-*` handlers before executing commands.
 */
export function verifyOperator(conn: DataConnection): boolean {
  if (!conn?.peer) return false;
  const connectedPeers = getState('network.connectedPeers');
  const peer = connectedPeers.find(p => p.id === conn.peer);
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
