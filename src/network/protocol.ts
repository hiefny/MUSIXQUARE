/**
 * MUSIXQUARE — Message Protocol & Dispatch
 *
 * Manages: Message validation, handler registry, dispatch (handleData).
 */

import { log } from '../core/log.ts';
import { bus } from '../core/events.ts';
import { getState } from '../core/state.ts';
import {
  MSG,
  CHUNK_SIZE,
  REMOTE_SHARE_CRYPTO_CHUNK_BYTES,
  REMOTE_SHARE_GCM_TAG_BYTES,
  REMOTE_SHARE_LEGACY_MAX_PLAINTEXT_BYTES,
  REMOTE_SHARE_MAX_ENCRYPTED_BYTES,
  REMOTE_SHARE_MAX_PLAINTEXT_BYTES,
} from '../core/constants.ts';
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
const isPositiveInt = (v: unknown): v is number => isNonNegInt(v) && v > 0;

// Max 200,000 chunks ≈ 12.8 GB at 64 KB/chunk — prevents DoS via unbounded total
const MAX_FILE_TOTAL = 200_000;
const MAX_REMOTE_SHARE_ENCRYPTED_BYTES = REMOTE_SHARE_MAX_ENCRYPTED_BYTES;
const MAX_REMOTE_SHARE_BYTES = REMOTE_SHARE_MAX_PLAINTEXT_BYTES;

// Per-chunk byte cap. Host always sends exactly CHUNK_SIZE (or smaller for
// the tail chunk via file.slice()), so anything larger is a malformed or
// hostile frame. Caps memory cost of the reorder buffer at 500 × CHUNK_SIZE.
const MAX_CHUNK_BYTES = CHUNK_SIZE;
const isBoundedChunk = (v: unknown): boolean =>
  isArrayBufferLike(v) && (v as ArrayBuffer | Uint8Array).byteLength <= MAX_CHUNK_BYTES;
const isBoundedNumber = (v: unknown, min: number, max: number): boolean =>
  isFiniteNumber(v) && v >= min && v <= max;
const hasValidRemoteCryptoMetadata = (d: Record<string, unknown>): boolean => {
  if (d.cryptoVersion === undefined || d.cryptoVersion === 1) {
    return (
      (d.cryptoVersion === undefined || d.cryptoVersion === 1) &&
      Number(d.size) <= REMOTE_SHARE_LEGACY_MAX_PLAINTEXT_BYTES &&
      Number(d.encryptedSize) === Number(d.size) + REMOTE_SHARE_GCM_TAG_BYTES &&
      d.chunkSize === undefined &&
      d.chunkCount === undefined &&
      d.tagBytes === undefined
    );
  }
  if (d.cryptoVersion !== 2) return false;
  const size = Number(d.size);
  const encryptedSize = Number(d.encryptedSize);
  const expectedChunks = Math.ceil(size / REMOTE_SHARE_CRYPTO_CHUNK_BYTES);
  return (
    d.chunkSize === REMOTE_SHARE_CRYPTO_CHUNK_BYTES &&
    d.tagBytes === REMOTE_SHARE_GCM_TAG_BYTES &&
    d.chunkCount === expectedChunks &&
    expectedChunks > 0 &&
    encryptedSize === size + expectedChunks * REMOTE_SHARE_GCM_TAG_BYTES
  );
};
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
    case MSG.EXCITER:
      // Toggle-only effect; value is 0 (off) or 1 (on). Reuse the number wire
      // shape so the existing REQUEST_SETTING dispatcher (playlist.ts) and
      // bootstrap path (effects.ts network:peer-connected) work without a
      // boolean special case.
      return data.value === 0 || data.value === 1;
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
  // sessionId finiteness brings PRELOAD_START to FILE_START parity (F-2408): a
  // forged Infinity/NaN sid otherwise keys the handler's per-session reorder and
  // sessionState maps. PRELOAD_CHUNK stays sessionId-optional here (it falls back
  // to the latest preload session — pinned by the rate-limit test), so its sink
  // is hardened instead inside handlePreloadChunk.
  [MSG.PRELOAD_START]: (d) =>
    typeof d.name === 'string' &&
    isFiniteNumber(d.sessionId) &&
    isNonNegInt(d.total) &&
    (d.total as number) <= MAX_FILE_TOTAL,
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
  [MSG.YOUTUBE_SYNC]: (d) =>
    isFiniteNumber(d.time) &&
    isFiniteNumber(d.state) &&
    (d.subIndex === undefined || isFiniteNumber(d.subIndex)),
  [MSG.YOUTUBE_STATE]: (d) =>
    isFiniteNumber(d.state) &&
    (d.time === undefined || isFiniteNumber(d.time)) &&
    (d.hostPlayAt === undefined || isFiniteNumber(d.hostPlayAt)),
  // subIdx is capped at 5000 (YouTube playlist max, matches YOUTUBE_PLAYLIST_INFO
  // ids cap) — the handler pads youtube.subItemsMap[pid].titles up to subIdx, so
  // an uncapped index would grow that array to billions of empty slots (OOM).
  [MSG.YOUTUBE_SUB_TITLE_UPDATE]: (d) =>
    typeof d.playlistId === 'string' &&
    isNonNegInt(d.subIdx) &&
    (d.subIdx as number) < 5000 &&
    typeof d.title === 'string',
  // Without per-element validation a compromised host (or any peer that
  // bypasses isHostBroadcast in some future regression) could populate ids[]
  // with attacker-controlled strings — youtube/handlers.ts:209 then calls
  // player.loadVideoById(ids[subIdx]) with whatever's there. videoId is
  // always 11 chars URL-safe base64 in YouTube's spec; matches search.ts
  // search-result normalization. Length cap = 5000 (YouTube's own playlist
  // max), not 200 — large playlists are a first-class app feature (see
  // index-before-add flow). (10차 audit Phase 4 + 13차 finding 3 cap fix.)
  [MSG.YOUTUBE_PLAYLIST_INFO]: (d) => {
    const ids = d.ids;
    const titles = d.titles;
    return (
      typeof d.playlistId === 'string' &&
      d.playlistId.length > 0 &&
      d.playlistId.length <= 64 &&
      Array.isArray(ids) &&
      ids.length <= 5000 &&
      ids.every((x) => typeof x === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(x)) &&
      Array.isArray(titles) &&
      // Titles are lazy-filled after IDs, so partial arrays are valid.
      titles.length <= ids.length &&
      titles.every((x) => typeof x === 'string' && x.length <= 200)
    );
  },
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
    d.roomId.length > 0 &&
    d.roomId.length <= 80 &&
    typeof d.objectId === 'string' &&
    d.objectId.length > 0 &&
    d.objectId.length <= 160 &&
    (d.downloadUrl === undefined ||
      (typeof d.downloadUrl === 'string' && d.downloadUrl.length <= 2048)) &&
    typeof d.keyB64 === 'string' &&
    d.keyB64.length <= 128 &&
    typeof d.ivB64 === 'string' &&
    d.ivB64.length <= 64 &&
    typeof d.name === 'string' &&
    d.name.length > 0 &&
    d.name.length <= 512 &&
    typeof d.mime === 'string' &&
    d.mime.length <= 256 &&
    isNonNegInt(d.index) &&
    isFiniteNumber(d.sessionId) &&
    isPositiveInt(d.size) &&
    (d.size as number) <= MAX_REMOTE_SHARE_BYTES &&
    isPositiveInt(d.encryptedSize) &&
    (d.encryptedSize as number) <= MAX_REMOTE_SHARE_ENCRYPTED_BYTES &&
    isFiniteNumber(d.expiresAt) &&
    hasValidRemoteCryptoMetadata(d),
  // Without `name`, a malicious peer can send file-resume with no name to
  // poison the host's transfer.localSessionId (handler at transfer-receive.ts:685
  // bumps it from any incoming sessionId), blocking subsequent legitimate inbound
  // transfers via the localSid guards at transfer-receive.ts:678,754,765,790.
  // FILE_START (above) already requires `name` — this brings FILE_RESUME to parity.
  [MSG.FILE_RESUME]: (d) =>
    typeof d.name === 'string' && isFiniteNumber(d.sessionId) && isNonNegInt(d.startChunk),
  // Guest → host recovery ask (previously unvalidated — blind spot ⑥).
  // nextChunk feeds the host's startChunk math and must be a sane index;
  // every field is OPTIONAL on the wire: the FILE_WAIT-timeout
  // (transfer-receive.ts), playback-stall (playback.ts) and preload-decode
  // (preload.ts) senders omit sessionId, and the handler falls back through
  // data.fileName || data.name. index is deliberately NOT isNonNegInt:
  // recovery.ts's freshIndex falls back to playlist.currentTrackIndex which
  // is legitimately -1 before the first track — rejecting it would silently
  // kill real recovery, so only non-finite poison is dropped.
  [MSG.REQUEST_DATA_RECOVERY]: (d) =>
    (d.nextChunk === undefined || isNonNegInt(d.nextChunk)) &&
    (d.sessionId === undefined || isFiniteNumber(d.sessionId)) &&
    (d.fileName === undefined || typeof d.fileName === 'string') &&
    (d.name === undefined || typeof d.name === 'string') &&
    (d.index === undefined || isFiniteNumber(d.index)),

  // Chat — validate text field exists and cap length. The wire cap (4000) is
  // deliberately well above the 500-char render cap so legitimate near-cap
  // multibyte messages never trip it; its job is killing multi-KB/MB
  // amplification frames at the door (defense-in-depth behind the host-side
  // write-back truncation in chat/protocol.ts).
  [MSG.CHAT]: (d) => typeof d.text === 'string' && d.text.length <= 4000,
  [MSG.CHAT_WHISPER]: (d) =>
    typeof d.text === 'string' && d.text.length <= 4000 && typeof d.targetId === 'string',
  // text is required for back-compat fallback; i18nKey/i18nParams are optional
  // and let receivers render in their own locale when sender supplies them.
  [MSG.CHAT_NOTICE]: (d) =>
    typeof d.text === 'string' &&
    d.text.length <= 4000 &&
    (d.i18nKey === undefined || (typeof d.i18nKey === 'string' && d.i18nKey.length < 128)) &&
    (d.i18nParams === undefined || (typeof d.i18nParams === 'object' && d.i18nParams !== null)),
  [MSG.CHAT_SYSTEM]: (d) =>
    typeof d.text === 'string' &&
    d.text.length <= 4000 &&
    (d.i18nKey === undefined || (typeof d.i18nKey === 'string' && d.i18nKey.length < 128)) &&
    (d.i18nParams === undefined || (typeof d.i18nParams === 'object' && d.i18nParams !== null)),
  [MSG.OPERATOR_TOAST]: (d) =>
    typeof d.text === 'string' &&
    d.text.length <= 300 &&
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
