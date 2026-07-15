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
  REMOTE_SHARE_AES_GCM_TAG_BYTES,
  REMOTE_SHARE_MAX_BYTES,
} from '../core/constants.ts';
import type { MsgType } from '../core/constants.ts';
import { isQueueItemId, parsePlaylistSnapshot } from '../player/queue-model.ts';
import type { AnyProtocolMsg, DataConnection, ProtocolMsg } from '../types/index.ts';
import { hasQueueAuthority } from './queue-authority.ts';
import { getRoomContext, verifyPeerCapability } from '../rooms/authority.ts';
import { isFileRequestId } from './file-request-authority.ts';

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

const REMOTE_OBJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Cloudflare signaling's authenticated PRO participant identifier contract.
// Keep member-management requests to one small opaque identifier so callers
// cannot smuggle a connection object or other coordinator-owned state.
const PRO_PEER_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;

// Tight numeric validator — rejects NaN, Infinity, -Infinity, and out-of-range
// values. Without this, Number(undefined) → NaN silently passes typeof===number,
// and a malicious peer could send chunkIndex=Infinity to explode a reorder buffer Map.
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNegInt = (v: unknown): v is number => isFiniteNumber(v) && v >= 0 && Number.isInteger(v);
const isNonNegSafeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPositiveSafeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

// Max 200,000 chunks ≈ 12.2 GiB at 64 KiB/chunk; prevents an unbounded total.
const MAX_FILE_TOTAL = 200_000;

const hasExactFileSizeContract = (d: Record<string, unknown>): boolean =>
  isPositiveSafeInt(d.size) &&
  isPositiveSafeInt(d.total) &&
  (d.total as number) <= MAX_FILE_TOTAL &&
  (d.total as number) === Math.ceil((d.size as number) / CHUNK_SIZE);

// Per-chunk byte cap. Host always sends exactly CHUNK_SIZE (or smaller for
// the tail chunk via file.slice()), so anything larger is a malformed or
// hostile frame. Caps memory cost of the reorder buffer at 500 × CHUNK_SIZE.
const MAX_CHUNK_BYTES = CHUNK_SIZE;
const isBoundedChunk = (v: unknown): boolean =>
  isArrayBufferLike(v) && (v as ArrayBuffer | Uint8Array).byteLength <= MAX_CHUNK_BYTES;

// Frames without a top-level queueItemId that still create/mutate a media
// owner. Queue-scoped frames are detected generically below.
const PRE_AUTHORITY_MEDIA_TYPES: ReadonlySet<string> = new Set([
  MSG.FILE_WAIT,
  MSG.SYSTEM_AUDIO_START,
  MSG.SYSTEM_AUDIO_SFU_READY,
  MSG.SYSTEM_AUDIO_STOP,
  MSG.DEMO_ENTER,
  MSG.DEMO_PLAY,
  MSG.DEMO_PAUSE,
  MSG.DEMO_EXIT,
  MSG.YOUTUBE_PLAYLIST_INFO,
  MSG.YOUTUBE_SUB_TITLE_UPDATE,
]);

function requiresQueueAuthority(msgType: MsgType, msg: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(msg, 'queueItemId') ||
    PRE_AUTHORITY_MEDIA_TYPES.has(msgType)
  );
}
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
  [MSG.PRO_ROOM_INVALIDATED]: (d) =>
    isNonNegSafeInt(d.revision) && isNonNegSafeInt(d.playlistRevision),
  [MSG.PLAY]: (d) =>
    isQueueItemId(d.queueItemId) &&
    isFiniteNumber(d.time) &&
    (d.name === undefined || d.name === null || typeof d.name === 'string') &&
    (d.hostPlayAt === undefined || isFiniteNumber(d.hostPlayAt)),
  [MSG.PAUSE]: (d) =>
    (d.queueItemId === null || isQueueItemId(d.queueItemId)) &&
    isFiniteNumber(d.time) &&
    (d.endOfPlaylist === undefined || typeof d.endOfPlaylist === 'boolean') &&
    (d.reason === undefined ||
      d.reason === 'pause' ||
      d.reason === 'stop' ||
      d.reason === 'seek' ||
      d.reason === 'transition' ||
      d.reason === 'end-of-playlist'),
  [MSG.PLAY_PRELOADED]: (d) =>
    isQueueItemId(d.queueItemId) &&
    typeof d.name === 'string' &&
    d.name.length > 0 &&
    (d.mime === undefined || typeof d.mime === 'string'),
  [MSG.VOLUME]: (d) =>
    isFiniteNumber(d.value) && (d.value as number) >= 0 && (d.value as number) <= 1,
  [MSG.FILE_CHUNK]: (d) =>
    isBoundedChunk(d.chunk) &&
    isNonNegInt(d.chunkIndex) &&
    isQueueItemId(d.queueItemId) &&
    isPositiveSafeInt(d.sessionId) &&
    typeof d.name === 'string' &&
    d.name.length > 0 &&
    hasExactFileSizeContract(d),
  // sessionId must be a positive safe integer. Finite-but-unsafe or fractional
  // values can poison transfer.localSessionId just like Infinity, after which
  // the localSid<incomingSid guards in transfer-receive.ts reject
  // every legitimate inbound transfer until session leave. This keeps
  // FILE_START aligned with FILE_RESUME.
  [MSG.FILE_START]: (d) =>
    typeof d.name === 'string' &&
    d.name.length > 0 &&
    isPositiveSafeInt(d.sessionId) &&
    isQueueItemId(d.queueItemId) &&
    hasExactFileSizeContract(d),
  [MSG.FILE_END]: (d) =>
    typeof d.name === 'string' &&
    d.name.length > 0 &&
    typeof d.mime === 'string' &&
    isQueueItemId(d.queueItemId) &&
    isPositiveSafeInt(d.sessionId),
  [MSG.PRELOAD_CHUNK]: (d) =>
    isBoundedChunk(d.chunk) &&
    isNonNegInt(d.chunkIndex) &&
    isQueueItemId(d.queueItemId) &&
    isPositiveSafeInt(d.sessionId),
  [MSG.PRELOAD_END]: (d) =>
    typeof d.name === 'string' &&
    d.name.length > 0 &&
    isQueueItemId(d.queueItemId) &&
    isPositiveSafeInt(d.sessionId),
  // Every preload data/control frame carries the same positive safe sessionId.
  // Missing/fractional/unsafe IDs are rejected before they can key reorder or
  // sessionState maps; there is no latest-session fallback.
  [MSG.PRELOAD_START]: (d) =>
    typeof d.name === 'string' &&
    d.name.length > 0 &&
    isPositiveSafeInt(d.sessionId) &&
    isQueueItemId(d.queueItemId) &&
    (d.skipped === undefined || typeof d.skipped === 'boolean') &&
    hasExactFileSizeContract(d),
  // sessionId required — handler uses it to scope sessionState/reorder/storage
  // cleanup. Without the guard, an injected abort with no sid would no-op
  // through every guard in handlePreloadAbort but still consume rate-limit
  // budget. Mirrors PRELOAD_END's name-required style.
  [MSG.PRELOAD_ACK]: (d) => isQueueItemId(d.queueItemId) && isPositiveSafeInt(d.sessionId),
  [MSG.PRELOAD_ABORT]: (d) => isQueueItemId(d.queueItemId) && isPositiveSafeInt(d.sessionId),
  [MSG.WELCOME]: (d) => typeof d.label === 'string',
  [MSG.EQ_UPDATE]: (d) =>
    isFiniteNumber(d.band) &&
    (d.band as number) >= 0 &&
    (d.band as number) < 16 &&
    isFiniteNumber(d.value),

  // YouTube messages — validate numeric fields that flow into player APIs / state
  [MSG.YOUTUBE_PLAY]: (d) =>
    isQueueItemId(d.queueItemId) &&
    (d.videoId === undefined || d.videoId === null || typeof d.videoId === 'string') &&
    (d.playlistId === undefined ||
      d.playlistId === null ||
      typeof d.playlistId === 'string' ||
      (Array.isArray(d.playlistId) && d.playlistId.every((id) => typeof id === 'string'))) &&
    typeof d.autoplay === 'boolean' &&
    (d.subIndex === undefined || isNonNegInt(d.subIndex)),
  [MSG.YOUTUBE_STOP]: (d) => isQueueItemId(d.queueItemId),
  [MSG.YOUTUBE_SYNC]: (d) =>
    isQueueItemId(d.queueItemId) &&
    isFiniteNumber(d.time) &&
    isFiniteNumber(d.state) &&
    (d.subIndex === undefined || isFiniteNumber(d.subIndex)),
  [MSG.YOUTUBE_STATE]: (d) =>
    isQueueItemId(d.queueItemId) &&
    isFiniteNumber(d.state) &&
    isFiniteNumber(d.time) &&
    (d.hostPlayAt === undefined || isFiniteNumber(d.hostPlayAt)),
  // subIdx is capped at 5000 (YouTube playlist max, matches YOUTUBE_PLAYLIST_INFO
  // ids cap) — the handler pads youtube.subItemsMap[pid].titles up to subIdx, so
  // an uncapped index would grow that array to billions of empty slots (OOM).
  [MSG.YOUTUBE_SUB_TITLE_UPDATE]: (d) =>
    typeof d.playlistId === 'string' &&
    isNonNegInt(d.subIdx) &&
    (d.subIdx as number) < 5000 &&
    typeof d.title === 'string',
  // Without per-element validation a compromised host or a caller that
  // bypasses the host trust boundary could populate ids[]
  // with attacker-controlled strings; youtube/handlers.ts then calls
  // player.loadVideoById(ids[subIdx]) with whatever's there. videoId is
  // always 11 chars URL-safe base64 in YouTube's spec; matches search.ts
  // search-result normalization. Length cap = 5000 (YouTube's own playlist
  // max), not 200 — large playlists are a first-class app feature (see
  // index-before-add flow).
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
  [MSG.REQUEST_YOUTUBE_SUB_SEEK]: (d) =>
    isQueueItemId(d.queueItemId) && isNonNegInt(d.subIdx) && (d.subIdx as number) < 5000,
  [MSG.REQUEST_YOUTUBE_PLAY]: (d) => isQueueItemId(d.queueItemId),
  [MSG.REQUEST_YOUTUBE_PAUSE]: (d) => isQueueItemId(d.queueItemId),
  [MSG.REQUEST_YOUTUBE_TOGGLE]: (d) => isQueueItemId(d.queueItemId),
  [MSG.REQUEST_YOUTUBE_PLAYLIST_INFO]: (d) =>
    typeof d.playlistId === 'string' && d.playlistId.length > 0 && d.playlistId.length <= 64,
  [MSG.REQUEST_SETTING]: isValidRequestSetting,
  [MSG.REQUEST_KICK_DEVICE]: (d) =>
    Object.keys(d).length === 2 &&
    Object.prototype.hasOwnProperty.call(d, 'type') &&
    Object.prototype.hasOwnProperty.call(d, 'targetPeerId') &&
    typeof d.targetPeerId === 'string' &&
    PRO_PEER_ID_RE.test(d.targetPeerId),

  // File transfer — validate session IDs and indices
  [MSG.FILE_PREPARE]: (d) =>
    typeof d.name === 'string' &&
    d.name.length > 0 &&
    isQueueItemId(d.queueItemId) &&
    isPositiveSafeInt(d.sessionId) &&
    typeof d.mime === 'string' &&
    (d.size === undefined || isPositiveSafeInt(d.size)) &&
    (d.autoPlayDelayMs === undefined || isNonNegSafeInt(d.autoPlayDelayMs)),
  [MSG.REMOTE_FILE_UNAVAILABLE]: (d) =>
    typeof d.name === 'string' &&
    d.name.length > 0 &&
    isQueueItemId(d.queueItemId) &&
    isPositiveSafeInt(d.sessionId) &&
    (d.limited === undefined || typeof d.limited === 'boolean'),
  [MSG.REMOTE_FILE_SHARE]: (d) =>
    typeof d.roomId === 'string' &&
    d.roomId.length > 0 &&
    d.roomId.length <= 80 &&
    typeof d.objectId === 'string' &&
    REMOTE_OBJECT_ID_RE.test(d.objectId) &&
    (d.downloadUrl === undefined ||
      (typeof d.downloadUrl === 'string' &&
        d.downloadUrl.length > 0 &&
        d.downloadUrl.length <= 2048)) &&
    typeof d.keyB64 === 'string' &&
    d.keyB64.length <= 128 &&
    typeof d.ivB64 === 'string' &&
    d.ivB64.length <= 64 &&
    typeof d.name === 'string' &&
    d.name.length > 0 &&
    typeof d.mime === 'string' &&
    isQueueItemId(d.queueItemId) &&
    isPositiveSafeInt(d.sessionId) &&
    Number.isSafeInteger(d.size) &&
    (d.size as number) > 0 &&
    (d.size as number) <= REMOTE_SHARE_MAX_BYTES &&
    Number.isSafeInteger(d.encryptedSize) &&
    (d.encryptedSize as number) === (d.size as number) + REMOTE_SHARE_AES_GCM_TAG_BYTES &&
    isFiniteNumber(d.expiresAt) &&
    d.preload === undefined,
  // Without `name`, a malicious peer can send file-resume with no name to
  // poison the host's transfer.localSessionId (the transfer-receive handler
  // bumps it from any incoming sessionId), blocking subsequent legitimate inbound
  // transfers via the localSid guards in transfer-receive.ts.
  // FILE_START (above) already requires `name` — this brings FILE_RESUME to parity.
  [MSG.FILE_RESUME]: (d) =>
    typeof d.name === 'string' &&
    d.name.length > 0 &&
    isPositiveSafeInt(d.sessionId) &&
    isQueueItemId(d.queueItemId) &&
    hasExactFileSizeContract(d) &&
    isNonNegInt(d.startChunk) &&
    (d.startChunk as number) < (d.total as number),
  [MSG.FILE_WAIT]: (d) =>
    isFileRequestId(d.requestId) &&
    isQueueItemId(d.queueItemId) &&
    (d.sessionId === undefined || isPositiveSafeInt(d.sessionId)) &&
    typeof d.message === 'string' &&
    d.message.length > 0 &&
    d.message.length <= 512 &&
    (d.reason === undefined || (typeof d.reason === 'string' && d.reason.length <= 128)),
  // Recovery binds the stable queue occurrence to a concrete transfer attempt;
  // nextChunk remains a transport offset and sessionId may be absent initially.
  [MSG.REQUEST_DATA_RECOVERY]: (d) =>
    isFileRequestId(d.requestId) &&
    isNonNegInt(d.nextChunk) &&
    (d.sessionId === undefined || isPositiveSafeInt(d.sessionId)) &&
    typeof d.fileName === 'string' &&
    d.fileName.length > 0 &&
    isQueueItemId(d.queueItemId),
  [MSG.REQUEST_CURRENT_FILE]: (d) =>
    isFileRequestId(d.requestId) &&
    isQueueItemId(d.queueItemId) &&
    (d.sessionId === undefined || isPositiveSafeInt(d.sessionId)) &&
    (d.name === undefined || typeof d.name === 'string') &&
    (d.reason === undefined || (typeof d.reason === 'string' && d.reason.length <= 128)),
  [MSG.REQUEST_TRACK_CHANGE]: (d) => isQueueItemId(d.queueItemId),
  [MSG.REQUEST_PLAY]: (d) =>
    isQueueItemId(d.queueItemId) && (d.time === undefined || isFiniteNumber(d.time)),
  [MSG.REQUEST_PAUSE]: (d) => isQueueItemId(d.queueItemId),
  [MSG.REQUEST_SEEK]: (d) => isQueueItemId(d.queueItemId) && isFiniteNumber(d.time),
  [MSG.REQUEST_SKIP_TIME]: (d) => isQueueItemId(d.queueItemId) && isFiniteNumber(d.sec),
  [MSG.REQUEST_NEXT_TRACK]: (d) => d.queueItemId === null || isQueueItemId(d.queueItemId),
  [MSG.REQUEST_PREV_TRACK]: (d) => d.queueItemId === null || isQueueItemId(d.queueItemId),
  [MSG.SYNC_PONG]: (d) =>
    isNonNegSafeInt(d.pingId) &&
    isFiniteNumber(d.hostTime) &&
    isFiniteNumber(d.position) &&
    (d.mode === null || d.mode === 'file' || d.mode === 'youtube' || d.mode === 'system-audio') &&
    (d.activity === 'idle' ||
      d.activity === 'paused' ||
      d.activity === 'playing' ||
      d.activity === 'pending') &&
    (d.queueItemId === null || isQueueItemId(d.queueItemId)) &&
    (d.demoTrackIndex === undefined || isNonNegSafeInt(d.demoTrackIndex)),

  // Chat — validate text field exists and cap length. This validator ceiling
  // (4000) is deliberately above the shared 500-character message cap; its job
  // is killing multi-KB/MB
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

  // Playlist snapshots are validated atomically, including unique IDs/current.
  [MSG.PLAYLIST_UPDATE]: (d) => parsePlaylistSnapshot(d) !== null,

  // Guest decode-failure reports identify the queue occurrence, not a row.
  [MSG.GUEST_DECODE_FAILED]: (d) => isQueueItemId(d.queueItemId),
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

  // On a guest, one concrete DataConnection is the sole host authority. Drop
  // every frame from replaced connections centrally before any handler or
  // rate-limit state can be touched.
  const appRole = getState('network.appRole');
  const isGuest = appRole === 'guest';
  const hostConn = getState('network.hostConn');
  if (isGuest && conn !== hostConn) {
    log.debug(`[Protocol] Ignored frame from stale host connection: ${msgType}`);
    return;
  }

  // A reconnect can replace a guest DataConnection while frames from the old
  // ordered channel are still queued. Peer IDs are intentionally stable, so
  // authorization must belong to the exact live connection, not just peerId.
  if (
    appRole === 'host' &&
    (!conn?.peer || getState('network.activeHostConnByPeerId').get(conn.peer) !== conn)
  ) {
    log.debug(`[Protocol] Ignored frame from stale guest connection: ${msgType}`);
    return;
  }

  // Ordered channels are not enough across reconnects: a new host may restart
  // revisions and transfer SIDs at zero/one. Until its explicit queue baseline
  // has been applied, fail closed for every queue/media-dependent frame.
  if (
    isGuest &&
    hostConn === conn &&
    !hasQueueAuthority(conn) &&
    requiresQueueAuthority(msgType, msg)
  ) {
    log.debug(`[Protocol] Ignored ${msgType} before queue authority bootstrap`);
    return;
  }

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
  if (getRoomContext().kind === 'pro') {
    return verifyPeerCapability(conn, 'playback.control');
  }

  const peerId = conn?.peer;
  if (!peerId) return false;
  if (getState('network.activeHostConnByPeerId').get(peerId) !== conn) return false;
  const connectedPeers = getState('network.connectedPeers');
  const peer = connectedPeers.find((p) => p.id === peerId && p.conn === conn);
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
