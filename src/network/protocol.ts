/**
 * MUSIXQUARE — Message Protocol & Dispatch
 *
 * Manages: Message validation, handler registry, dispatch (handleData).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import { MSG, CHUNK_SIZE } from '../core/constants.ts';
import type { MsgType } from '../core/constants.ts';
import type { AnyProtocolMsg, DataConnection, ProtocolMsg } from '../types/index.ts';

// ─── Message Validation ─────────────────────────────────────────────

/**
 * Validate message structure — must be an object with a `type` field.
 * Optionally checks for required fields.
 */
export function validateMessage(
  data: unknown,
  requiredFields: string[] = [],
): data is Record<string, unknown> {
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

// ─── Lightweight Protocol Validators ─────────────────────────────────
// 3.0: Validate high-risk message payloads before dispatch.
// Only critical messages need validators — not all 40+ types.

const isArrayBufferLike = (v: unknown): boolean =>
  v instanceof ArrayBuffer ||
  v instanceof Uint8Array ||
  (v != null &&
    typeof v === 'object' &&
    Object.prototype.toString.call(v) === '[object ArrayBuffer]');

// Tight numeric validator — rejects NaN, Infinity, -Infinity, and out-of-range
// values. Without this, Number(undefined) → NaN silently passes typeof===number,
// and a malicious peer could send index=Infinity to explode a reorder buffer Map.
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNegInt = (v: unknown): v is number => isFiniteNumber(v) && v >= 0 && Number.isInteger(v);

// Max 200,000 chunks ≈ 3.2 GB at 16 KB/chunk — prevents DoS via unbounded total
const MAX_FILE_TOTAL = 200_000;
const MAX_REMOTE_SHARE_BYTES = 300 * 1024 * 1024;

// Per-chunk byte cap. Host always sends exactly CHUNK_SIZE (or smaller for
// the tail chunk via file.slice()), so anything larger is a malformed or
// hostile frame. Caps memory cost of the reorder buffer at 500 × CHUNK_SIZE.
const MAX_CHUNK_BYTES = CHUNK_SIZE;
const isBoundedChunk = (v: unknown): boolean =>
  isArrayBufferLike(v) && (v as ArrayBuffer | Uint8Array).byteLength <= MAX_CHUNK_BYTES;
const isBoundedNumber = (v: unknown, min: number, max: number): boolean =>
  isFiniteNumber(v) && v >= min && v <= max;
const isReverbPreset = (v: unknown): boolean => v === 'off' || v === 'studio' || v === 'arena';
const isRepeatMode = (v: unknown): boolean => v === 0 || v === 1 || v === 2;

function isValidRequestSetting(data: Record<string, unknown>): boolean {
  if (typeof data.settingType !== 'string') return false;

  switch (data.settingType) {
    case 'repeat-mode':
      return isRepeatMode(data.value);
    case 'shuffle-mode':
      return typeof data.value === 'boolean';
    case 'eq':
      return isNonNegInt(data.band) && data.band < 5 && isBoundedNumber(data.value, -12, 12);
    case MSG.PREAMP:
      return isBoundedNumber(data.value, -48, 12);
    case MSG.VBASS:
    case MSG.REVERB:
      return isBoundedNumber(data.value, 0, 100);
    case MSG.STEREO_WIDTH:
      return isBoundedNumber(data.value, 0, 200);
    case MSG.REVERB_TYPE:
      return isReverbPreset(data.value);
    case MSG.REVERB_DECAY:
      return isBoundedNumber(data.value, 0.1, 10);
    case MSG.REVERB_PREDELAY:
      return isBoundedNumber(data.value, 0, 0.5);
    case MSG.REVERB_LOWCUT:
    case MSG.REVERB_HIGHCUT:
      return isBoundedNumber(data.value, 0, 100);
    default:
      return false;
  }
}

const PROTOCOL_VALIDATORS: Partial<Record<MsgType, (data: Record<string, unknown>) => boolean>> = {
  [MSG.PLAY]: (d) => d.time === undefined || isFiniteNumber(d.time),
  [MSG.PAUSE]: (d) =>
    (d.time === undefined || isFiniteNumber(d.time)) &&
    (d.reason === undefined ||
      d.reason === 'pause' ||
      d.reason === 'stop' ||
      d.reason === 'seek' ||
      d.reason === 'transition' ||
      d.reason === 'end-of-playlist'),
  [MSG.VOLUME]: (d) =>
    isFiniteNumber(d.value) && (d.value as number) >= 0 && (d.value as number) <= 1,
  [MSG.FILE_CHUNK]: (d) =>
    isBoundedChunk(d.chunk) && isNonNegInt(d.index) && isFiniteNumber(d.sessionId),
  // sessionId must be a finite number — without this guard, a malicious peer
  // can send sessionId=Infinity to poison transfer.localSessionId, after which
  // the localSid<incomingSid guards (transfer-receive.ts:569,678,790,825) reject
  // every legitimate inbound transfer until session leave. Mirrors FILE_RESUME
  // sessionId check (6173597) — brings FILE_START to parity.
  [MSG.FILE_START]: (d) =>
    typeof d.name === 'string' &&
    isFiniteNumber(d.sessionId) &&
    isNonNegInt(d.total) &&
    (d.total as number) <= MAX_FILE_TOTAL,
  [MSG.FILE_END]: (d) => typeof d.name === 'string',
  [MSG.PRELOAD_CHUNK]: (d) => isBoundedChunk(d.chunk) && isNonNegInt(d.index),
  [MSG.PRELOAD_START]: (d) =>
    typeof d.name === 'string' && isNonNegInt(d.total) && (d.total as number) <= MAX_FILE_TOTAL,
  // sessionId required — handler uses it to scope sessionState/reorder/storage
  // cleanup. Without the guard, an injected abort with no sid would no-op
  // through every guard in handlePreloadAbort but still consume rate-limit
  // budget. Mirrors PRELOAD_END's name-required style.
  [MSG.PRELOAD_ABORT]: (d) => isFiniteNumber(d.sessionId),
  [MSG.WELCOME]: (d) => typeof d.label === 'string',
  [MSG.EQ_UPDATE]: (d) =>
    isFiniteNumber(d.band) &&
    (d.band as number) >= 0 &&
    (d.band as number) < 16 &&
    isFiniteNumber(d.value),

  // YouTube messages — validate numeric fields that flow into player APIs / state
  [MSG.YOUTUBE_PLAY]: (d) =>
    (d.videoId === undefined || d.videoId === null || typeof d.videoId === 'string') &&
    (d.index === undefined || isNonNegInt(d.index)) &&
    (d.subIndex === undefined || isNonNegInt(d.subIndex)),
  [MSG.YOUTUBE_ZERO_START_PREPARE]: (d) =>
    typeof d.token === 'string' &&
    d.token.length > 0 &&
    d.token.length <= 80 &&
    isFiniteNumber(d.timeoutMs) &&
    (d.timeoutMs as number) >= 0 &&
    (d.timeoutMs as number) <= 5000 &&
    (d.videoId === undefined || typeof d.videoId === 'string') &&
    (d.subIndex === undefined || isNonNegInt(d.subIndex)),
  [MSG.YOUTUBE_ZERO_START_READY]: (d) =>
    typeof d.token === 'string' &&
    d.token.length > 0 &&
    d.token.length <= 80 &&
    (d.videoId === undefined || typeof d.videoId === 'string') &&
    (d.subIndex === undefined || isNonNegInt(d.subIndex)),
  [MSG.YOUTUBE_SYNC]: (d) =>
    isFiniteNumber(d.time) &&
    isFiniteNumber(d.state) &&
    (d.subIndex === undefined || isFiniteNumber(d.subIndex)),
  [MSG.YOUTUBE_STATE]: (d) =>
    isFiniteNumber(d.state) &&
    (d.time === undefined || isFiniteNumber(d.time)) &&
    (d.hostPlayAt === undefined || isFiniteNumber(d.hostPlayAt)),
  [MSG.YOUTUBE_SUB_TITLE_UPDATE]: (d) =>
    typeof d.playlistId === 'string' && isNonNegInt(d.subIdx) && typeof d.title === 'string',
  [MSG.REQUEST_YOUTUBE_SUB_SEEK]: (d) => isNonNegInt(d.subIdx),
  [MSG.REQUEST_SETTING]: isValidRequestSetting,

  // File transfer — validate session IDs and indices
  [MSG.FILE_PREPARE]: (d) =>
    (d.name === undefined || typeof d.name === 'string') &&
    (d.index === undefined || isNonNegInt(d.index)) &&
    (d.sessionId === undefined || isFiniteNumber(d.sessionId)),
  [MSG.REMOTE_FILE_UNAVAILABLE]: (d) =>
    typeof d.name === 'string' &&
    isNonNegInt(d.index) &&
    isFiniteNumber(d.sessionId) &&
    (d.limited === undefined || typeof d.limited === 'boolean'),
  [MSG.REMOTE_FILE_SHARE]: (d) =>
    typeof d.roomId === 'string' &&
    d.roomId.length <= 80 &&
    typeof d.objectId === 'string' &&
    d.objectId.length <= 160 &&
    (d.downloadUrl === undefined || typeof d.downloadUrl === 'string') &&
    typeof d.keyB64 === 'string' &&
    d.keyB64.length <= 128 &&
    typeof d.ivB64 === 'string' &&
    d.ivB64.length <= 64 &&
    typeof d.name === 'string' &&
    typeof d.mime === 'string' &&
    isNonNegInt(d.index) &&
    isFiniteNumber(d.sessionId) &&
    isFiniteNumber(d.size) &&
    (d.size as number) <= MAX_REMOTE_SHARE_BYTES &&
    isFiniteNumber(d.encryptedSize) &&
    (d.encryptedSize as number) <= MAX_REMOTE_SHARE_BYTES + 4096 &&
    isFiniteNumber(d.expiresAt),
  // Without `name`, a malicious peer can send file-resume with no name to
  // poison the host's transfer.localSessionId (handler at transfer-receive.ts:685
  // bumps it from any incoming sessionId), blocking subsequent legitimate inbound
  // transfers via the localSid guards at transfer-receive.ts:678,754,765,790.
  // FILE_START (above) already requires `name` — this brings FILE_RESUME to parity.
  [MSG.FILE_RESUME]: (d) =>
    typeof d.name === 'string' && isFiniteNumber(d.sessionId) && isNonNegInt(d.startChunk),

  // Chat — validate text field exists and cap length
  [MSG.CHAT]: (d) => typeof d.text === 'string',
  [MSG.CHAT_WHISPER]: (d) => typeof d.text === 'string' && typeof d.targetId === 'string',
  // text is required for back-compat fallback; i18nKey/i18nParams are optional
  // and let receivers render in their own locale when sender supplies them.
  [MSG.CHAT_NOTICE]: (d) =>
    typeof d.text === 'string' &&
    (d.i18nKey === undefined || (typeof d.i18nKey === 'string' && d.i18nKey.length < 128)) &&
    (d.i18nParams === undefined || (typeof d.i18nParams === 'object' && d.i18nParams !== null)),
  [MSG.CHAT_SYSTEM]: (d) =>
    typeof d.text === 'string' &&
    (d.i18nKey === undefined || (typeof d.i18nKey === 'string' && d.i18nKey.length < 128)) &&
    (d.i18nParams === undefined || (typeof d.i18nParams === 'object' && d.i18nParams !== null)),
  [MSG.REQUEST_CHAT_COMMAND]: (d) =>
    typeof d.command === 'string' && Array.isArray(d.args) && (d.args as unknown[]).length <= 32,

  [MSG.SYSTEM_AUDIO_SFU_READY]: (d) =>
    d.version === 1 &&
    typeof d.sessionId === 'string' &&
    d.sessionId.length > 0 &&
    d.sessionId.length <= 128 &&
    Array.isArray(d.tracks) &&
    d.tracks.length > 0 &&
    d.tracks.length <= 4 &&
    d.tracks.every((track) => {
      if (!track || typeof track !== 'object') return false;
      const item = track as Record<string, unknown>;
      return (
        typeof item.trackName === 'string' &&
        item.trackName.length > 0 &&
        item.trackName.length <= 160 &&
        (item.channel === 'L' || item.channel === 'R') &&
        (item.mid === undefined || typeof item.mid === 'string')
      );
    }),

  // Playlist — validate list is an array (individual items checked in handler)
  [MSG.PLAYLIST_UPDATE]: (d) => Array.isArray(d.list) && (d.list as unknown[]).length <= 1000,

  // Guest → host decode-failure report: index identifies the track. Host
  // ignores stale reports (index !== currentTrackIndex) at the handler level,
  // but the validator still requires a sane non-negative integer.
  [MSG.GUEST_DECODE_FAILED]: (d) => isNonNegInt(d.index),
  [MSG.DEMO_ENTER]: (d) =>
    isNonNegInt(d.index) &&
    typeof d.reverbOn === 'boolean' &&
    typeof d.bassBoostOn === 'boolean' &&
    typeof d.trebleBoostOn === 'boolean' &&
    typeof d.surroundOn === 'boolean',
  [MSG.DEMO_PLAY]: (d) =>
    isNonNegInt(d.index) && isFiniteNumber(d.time) && isFiniteNumber(d.hostPlayAt),
  [MSG.DEMO_PAUSE]: (d) => isFiniteNumber(d.time),
  [MSG.DEMO_EXIT]: () => true,
};

// ─── Generic Inbound Rate-Limit (per peer) ──────────────────────────
//
// Chat had its own bucket (`allowChatFromPeer`) but every other message
// type was uncapped — a single malicious guest could flood SYNC_PING or
// REQUEST_* frames and burn host CPU on state mutations + rebroadcast
// amplification. RTCDataChannel backpressure caps raw send-rate in the
// ~1–3k msg/s range, which is still high enough to degrade UX.
//
// Token-bucket per peer: 60 burst, 1 token every 50ms (≈20 msg/s steady
// state). Chunks bypass the bucket — transfer-send already throttles via
// `bufferedAmount` and chunk rates are naturally high-legitimate-traffic.
const INBOUND_BURST = 60;
const INBOUND_REFILL_MS = 50;
const _inboundBuckets = new Map<string, { tokens: number; lastRefill: number }>();

const RATE_LIMIT_EXEMPT: ReadonlySet<string> = new Set<string>([MSG.FILE_CHUNK, MSG.PRELOAD_CHUNK]);

function allowInboundFromPeer(peerId: string): boolean {
  if (!peerId) return true;
  const now = Date.now();
  let bucket = _inboundBuckets.get(peerId);
  if (!bucket) {
    bucket = { tokens: INBOUND_BURST, lastRefill: now };
    _inboundBuckets.set(peerId, bucket);
  }
  const elapsed = now - bucket.lastRefill;
  if (elapsed > 0) {
    const refill = Math.floor(elapsed / INBOUND_REFILL_MS);
    if (refill > 0) {
      bucket.tokens = Math.min(INBOUND_BURST, bucket.tokens + refill);
      bucket.lastRefill = now;
    }
  }
  if (bucket.tokens <= 0) return false;
  bucket.tokens -= 1;
  return true;
}

/** Drop rate-limit state for a peer; call on disconnect to bound the map. */
export function resetInboundRateLimit(peerId: string): void {
  _inboundBuckets.delete(peerId);
}

// ─── Handler Registry ───────────────────────────────────────────────

type TypedMessageHandler<T extends MsgType> = (
  data: ProtocolMsg<T>,
  conn: DataConnection,
) => void | Promise<void>;
type MessageHandler = (data: AnyProtocolMsg, conn: DataConnection) => void | Promise<void>;
type MessageHandlerMap = { [T in MsgType]?: TypedMessageHandler<T> };
const _handlers = new Map<string, MessageHandler>();

function setHandler(type: MsgType, handler: MessageHandler): void {
  if (_handlers.has(type)) {
    log.warn(`[Protocol] Overwriting handler for: ${type}`);
  }
  _handlers.set(type, handler);
}

/**
 * Register a handler for a specific message type.
 * Can be called from any module during initialization.
 */
export function registerHandler<T extends MsgType>(type: T, handler: TypedMessageHandler<T>): void {
  setHandler(type, handler as MessageHandler);
}

/**
 * Register multiple handlers at once.
 * Each handler receives a typed payload matching its message type key.
 */
export function registerHandlers(handlers: MessageHandlerMap): void {
  for (const [type, handler] of Object.entries(handlers) as Array<
    [MsgType, MessageHandler | undefined]
  >) {
    if (handler) setHandler(type, handler);
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
 * Main message dispatcher. Validates and dispatches to registered handlers.
 */
export async function handleData(data: unknown, conn: DataConnection): Promise<void> {
  // Generic validation
  if (!validateMessage(data, [])) return;

  const msg = data as Record<string, unknown>;
  const msgType = msg.type as MsgType;

  // Generic per-peer rate-limit — chunks bypass (high-legitimate-rate, bounded
  // by transfer-layer backpressure). Silently drops frames over the cap.
  if (conn?.peer && !RATE_LIMIT_EXEMPT.has(msgType) && !allowInboundFromPeer(conn.peer)) {
    return;
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
      await handler(msg as AnyProtocolMsg, conn);
    } catch (e) {
      log.error(`Error handling ${msgType}:`, e);
    }
  }
}

// ─── Operator Verification ──────────────────────────────────────────

/**
 * Check whether the peer behind `conn` has been granted Operator privileges.
 * Called by Host-side `request-*` handlers before executing commands.
 */
export function verifyOperator(conn: DataConnection, _data?: Record<string, unknown>): boolean {
  const peerId = conn?.peer;
  if (!peerId) return false;
  const connectedPeers = getState('network.connectedPeers');
  const peer = connectedPeers.find((p) => p.id === peerId);
  return !!(peer && peer.isOp);
}

// ─── Initialize Protocol ────────────────────────────────────────────

/**
 * Wire up the EventBus → handleData bridge.
 * Call once at app bootstrap after all handlers are registered.
 */
export function initProtocol(): void {
  bus.on('network:data', (data: unknown, conn: unknown) => {
    handleData(data, conn as DataConnection).catch((e) =>
      log.error('[Protocol] handleData error:', e),
    );
  });

  // Release per-peer rate-limit buckets on disconnect so the map stays bounded.
  bus.on('network:peer-disconnected', (peerId: string) => {
    resetInboundRateLimit(peerId);
  });

  log.info('[Protocol] Message router initialized');
}
