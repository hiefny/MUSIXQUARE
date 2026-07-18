const ROOM_PATH = /^\/api\/rooms\/(\d{6})\/ws$/;
const PRO_ROOM_PATH = /^\/api\/pro-rooms\/(\d{6})\/ws$/;
const PRO_ROOM_CODE_PATTERN = /^0\d{5}$/;
const HOST_RECLAIM_GRACE_MS = 60_000;
const HOST_AUTH_TIMEOUT_MS = 10_000;
const GUEST_AUTH_TIMEOUT_MS = 10_000;
const ROOM_META_KEY = 'roomMeta';
const ATTACHMENT_VERSION = 1;
const WS_RATE_LIMIT_PER_MINUTE = 120;
const WS_MESSAGE_MAX_BYTES = 64 * 1024;
const SDP_MAX_BYTES = 48 * 1024;
const ICE_CANDIDATE_MAX_BYTES = 4 * 1024;
// One host/coordinator plus 99 guests/members keeps the public room ceiling at
// 100 connected devices. Pending sockets use a separate, short-lived budget
// for simultaneous unauthenticated handshakes.
const MAX_ROOM_GUESTS = 99;
// Host ownership is authenticated after the WebSocket upgrade so its bearer
// secret never appears in the URL. Keep this pre-auth surface small and rotate
// only another unauthenticated host candidate; an authenticated host is never
// displaced before the new candidate proves the same room secret.
const MAX_PENDING_HOST_SOCKETS = 4;
// Every guest briefly occupies this unauthenticated state while proving its
// reconnect secret, including passwordless rooms. Keep the burst budget equal
// to the public guest capacity so a legitimate 100-device venue is not
// rejected merely because many devices scan the invite at once.
const MAX_PENDING_GUEST_SOCKETS = MAX_ROOM_GUESTS;
const GUEST_MESSAGE_BUCKET_CAPACITY = 120;
const GUEST_MESSAGE_REFILL_PER_MS = GUEST_MESSAGE_BUCKET_CAPACITY / 60_000;
const GUEST_BINDINGS_KEY = 'guestReconnectBindings';
const PRO_ROOM_META_KEY = 'proRoomMeta';
const PRO_TICKET_USES_KEY = 'proSignalingTicketUses';
const PRO_PARTICIPANT_HIGH_WATER_KEY = 'proSignalingParticipantHighWater';
const PRO_DECOMMISSIONED_KEY = 'proRoomDecommissioned';
const PRO_SIGNALING_TICKET_KIND = 'pro-signaling';
const PRO_SIGNALING_TICKET_VERSION = 1;
const PRO_SIGNALING_TICKET_MAX_SECONDS = 5 * 60;
const PRO_SIGNALING_CLOCK_SKEW_SECONDS = 30;
const DEVELOPER_CONTROL_VERSION = 1;
const DEVELOPER_EFFECTS_CONTROL_VERSION = 2;
const DEVELOPER_NEXT_CONTROL_VERSION = 3;
const DEVELOPER_CONTROL_MAX_VERSION = DEVELOPER_NEXT_CONTROL_VERSION;
const DEVELOPER_COMMAND_BODY_MAX_BYTES = 4 * 1024;
const INTERNAL_ADMIN_BODY_MAX_BYTES = 1024;
const ADMIN_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEVELOPER_COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{22}$/;
const QUEUE_ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PRO_TICKET_USES = 1024;
const MAX_PRO_PARTICIPANT_HIGH_WATER = 256;
const MAX_GUEST_BINDINGS = 256;
// The client exhausts its automatic signaling reconnect backoff in about 30s,
// and a host can reclaim its room for 60s. Five minutes leaves a conservative
// margin for mobile radio/foreground recovery without retaining every departed
// identity for the lifetime of a long-running room. Unexpired ownership is
// never evicted to make room for a new identity; capacity therefore fails
// closed until an inactive binding expires.
const GUEST_BINDING_RECONNECT_TTL_MS = 5 * 60_000;
const METRICS_TABLE = 'mxqr_metric_buckets';
const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function isAllowedOrigin(origin, env = {}) {
  // Browser WebSocket clients always set Origin. An empty Origin signals a
  // non-browser tool (curl, wscat, custom scripts) — no production scenario
  // should trust it for room signaling.
  if (!origin) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const configured = String(env.ALLOWED_ORIGINS || env.TRUSTED_ORIGINS || '')
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (configured.includes(url.origin)) return true;
    return (
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url.origin) ||
      /^https:\/\/musixquare\.com$/i.test(url.origin) ||
      /^https:\/\/www\.musixquare\.com$/i.test(url.origin) ||
      /^https:\/\/(?:[^/]+\.)?toss\.im$/i.test(url.origin) ||
      /^https:\/\/(?:[^/]+\.)?toss-internal\.com$/i.test(url.origin) ||
      /^https:\/\/(?:[^/]+\.)?tossmini\.com$/i.test(url.origin)
    );
  } catch {
    return false;
  }
}

function isValidPeerId(peerId) {
  return typeof peerId === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(peerId);
}

function isValidProEpoch(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function isProNamespaceRoomCode(roomId) {
  return typeof roomId === 'string' && PRO_ROOM_CODE_PATTERN.test(roomId);
}

function isValidGuestReconnectSecret(secret) {
  return typeof secret === 'string' && /^[A-Za-z0-9_-]{43}$/.test(secret);
}

function bytesToBase64Url(bytes) {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeBytesEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < right.byteLength; index++) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

function normalizeProTicketPayload(value, expectedRoomId, nowSeconds) {
  if (!isRecord(value)) return null;
  const allowedTicketKeys = new Set([
    'v',
    'kind',
    'roomCode',
    'participantId',
    'role',
    'coordinatorEpoch',
    'presenceIncarnationId',
    'ticketSequence',
    'developerControlVersion',
    'jti',
    'iat',
    'exp',
  ]);
  if (Object.keys(value).some((key) => !allowedTicketKeys.has(key))) return null;
  if (
    Object.prototype.hasOwnProperty.call(value, 'developerControlVersion') &&
    (!Number.isSafeInteger(value.developerControlVersion) ||
      value.developerControlVersion < 0 ||
      value.developerControlVersion > DEVELOPER_CONTROL_MAX_VERSION)
  ) {
    return null;
  }
  if (value.v !== PRO_SIGNALING_TICKET_VERSION || value.kind !== PRO_SIGNALING_TICKET_KIND) {
    return null;
  }
  if (value.roomCode !== expectedRoomId || !/^\d{6}$/.test(value.roomCode)) return null;
  if (!isValidPeerId(value.participantId)) return null;
  if (value.role !== 'coordinator' && value.role !== 'member') return null;
  if (!isValidProEpoch(value.coordinatorEpoch)) return null;
  if (
    typeof value.presenceIncarnationId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value.presenceIncarnationId)
  ) {
    return null;
  }
  if (!Number.isSafeInteger(value.ticketSequence) || value.ticketSequence < 1) return null;
  if (typeof value.jti !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.jti)) return null;
  if (!Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp)) return null;
  if (value.exp <= value.iat || value.exp - value.iat > PRO_SIGNALING_TICKET_MAX_SECONDS)
    return null;
  if (value.iat > nowSeconds + PRO_SIGNALING_CLOCK_SKEW_SECONDS || value.exp <= nowSeconds) {
    return null;
  }
  return {
    v: PRO_SIGNALING_TICKET_VERSION,
    kind: PRO_SIGNALING_TICKET_KIND,
    roomCode: value.roomCode,
    participantId: value.participantId,
    role: value.role,
    coordinatorEpoch: value.coordinatorEpoch,
    presenceIncarnationId: value.presenceIncarnationId,
    ticketSequence: value.ticketSequence,
    developerControlVersion: value.developerControlVersion || 0,
    jti: value.jti,
    iat: value.iat,
    exp: value.exp,
  };
}

async function verifyProSignalingTicket(ticket, expectedRoomId, env, now = Date.now()) {
  const secret = typeof env?.PRO_SIGNALING_SECRET === 'string' ? env.PRO_SIGNALING_SECRET : '';
  if (!secret || typeof ticket !== 'string' || ticket.length > 4096) return null;
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0].length > 3072) return null;

  const presentedSignature = base64UrlToBytes(parts[1]);
  const payloadBytes = base64UrlToBytes(parts[0]);
  if (!presentedSignature || presentedSignature.byteLength !== 32 || !payloadBytes) return null;

  let expectedSignature;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    expectedSignature = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(parts[0])),
    );
  } catch {
    return null;
  }
  if (!constantTimeBytesEqual(presentedSignature, expectedSignature)) return null;

  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    return normalizeProTicketPayload(JSON.parse(decoded), expectedRoomId, Math.floor(now / 1000));
  } catch {
    return null;
  }
}

async function hashGuestReconnectSecret(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return bytesToBase64Url(new Uint8Array(digest));
}

function constantTimeStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < right.length; index++) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function workerVersionFields(env) {
  const workerVersionId = env?.CF_VERSION_METADATA?.id;
  return typeof workerVersionId === 'string' && workerVersionId ? { workerVersionId } : {};
}

function defaultGuestBindings() {
  return { v: 1, entries: [] };
}

function normalizeGuestBindings(value) {
  const normalized = defaultGuestBindings();
  if (!isRecord(value) || !Array.isArray(value.entries)) return normalized;
  const seen = new Set();
  for (const entry of value.entries) {
    if (normalized.entries.length >= MAX_GUEST_BINDINGS) break;
    if (!isRecord(entry) || !isValidPeerId(entry.peerId) || seen.has(entry.peerId)) continue;
    if (typeof entry.secretHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(entry.secretHash)) {
      continue;
    }
    seen.add(entry.peerId);
    normalized.entries.push({
      peerId: entry.peerId,
      secretHash: entry.secretHash,
      updatedAt: Number.isFinite(entry.updatedAt) ? Math.max(0, entry.updatedAt) : 0,
    });
  }
  return normalized;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, required, optional = []) {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function normalizeRoomEffectsPatch(value) {
  if (!isRecord(value)) return null;
  const allowed = ['reverb', 'equalizer', 'virtualBass', 'virtualSurround'];
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !allowed.includes(key))) return null;

  const normalized = {};
  if (value.reverb !== undefined) {
    const reverb = value.reverb;
    const fields = [
      ['mixPercent', 0, 100],
      ['decaySeconds', 0.1, 30],
      ['preDelaySeconds', 0, 1],
      ['lowCutPercent', 0, 100],
      ['highCutPercent', 0, 100],
    ];
    if (
      !isRecord(reverb) ||
      Object.keys(reverb).length === 0 ||
      !hasExactKeys(reverb, [], fields.map(([field]) => field))
    ) {
      return null;
    }
    const next = {};
    for (const [field, min, max] of fields) {
      if (reverb[field] === undefined) continue;
      const number = reverb[field];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) {
        return null;
      }
      next[field] = number;
    }
    normalized.reverb = next;
  }
  if (value.equalizer !== undefined) {
    const equalizer = value.equalizer;
    if (
      !hasExactKeys(equalizer, ['bandsDb']) ||
      !Array.isArray(equalizer.bandsDb) ||
      equalizer.bandsDb.length !== 5 ||
      equalizer.bandsDb.some(
        (band) => typeof band !== 'number' || !Number.isFinite(band) || band < -12 || band > 12,
      )
    ) {
      return null;
    }
    normalized.equalizer = { bandsDb: [...equalizer.bandsDb] };
  }
  if (value.virtualBass !== undefined) {
    const virtualBass = value.virtualBass;
    if (
      !hasExactKeys(virtualBass, ['strengthPercent']) ||
      typeof virtualBass.strengthPercent !== 'number' ||
      !Number.isFinite(virtualBass.strengthPercent) ||
      virtualBass.strengthPercent < 0 ||
      virtualBass.strengthPercent > 100
    ) {
      return null;
    }
    normalized.virtualBass = { strengthPercent: virtualBass.strengthPercent };
  }
  if (value.virtualSurround !== undefined) {
    const virtualSurround = value.virtualSurround;
    if (
      !hasExactKeys(virtualSurround, ['widthPercent']) ||
      typeof virtualSurround.widthPercent !== 'number' ||
      !Number.isFinite(virtualSurround.widthPercent) ||
      virtualSurround.widthPercent < 0 ||
      virtualSurround.widthPercent > 200
    ) {
      return null;
    }
    normalized.virtualSurround = { widthPercent: virtualSurround.widthPercent };
  }
  return normalized;
}

function normalizeDeveloperCommand(value) {
  if (!isRecord(value)) return null;
  if (value.type === 'play' || value.type === 'pause' || value.type === 'next') {
    return hasExactKeys(value, ['type']) ? { type: value.type } : null;
  }
  if (value.type === 'seek') {
    return hasExactKeys(value, ['type', 'positionSeconds']) &&
      Number.isFinite(value.positionSeconds) &&
      value.positionSeconds >= 0 &&
      value.positionSeconds <= 7 * 24 * 60 * 60
      ? { type: 'seek', positionSeconds: value.positionSeconds }
      : null;
  }
  if (value.type === 'play_item') {
    return hasExactKeys(value, ['type', 'queueItemId']) &&
      QUEUE_ITEM_ID_RE.test(value.queueItemId || '')
      ? { type: 'play_item', queueItemId: value.queueItemId }
      : null;
  }
  if (value.type === 'set_effects' && hasExactKeys(value, ['type', 'effects'])) {
    const effects = normalizeRoomEffectsPatch(value.effects);
    return effects ? { type: 'set_effects', effects } : null;
  }
  return null;
}

function normalizeDeveloperCommandFrame(value) {
  if (
    !hasExactKeys(value, [
      'type',
      'version',
      'roomCode',
      'coordinatorEpoch',
      'commandId',
      'expiresAtMs',
      'expected',
      'command',
    ]) ||
    value.type !== 'developer-command' ||
    (value.version !== DEVELOPER_CONTROL_VERSION &&
      value.version !== DEVELOPER_EFFECTS_CONTROL_VERSION &&
      value.version !== DEVELOPER_NEXT_CONTROL_VERSION) ||
    !isProNamespaceRoomCode(value.roomCode) ||
    !isValidProEpoch(value.coordinatorEpoch) ||
    !DEVELOPER_COMMAND_ID_RE.test(value.commandId || '') ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    !hasExactKeys(value.expected, ['queueItemId', 'playlistRevision', 'playbackRevision']) ||
    (value.expected.queueItemId !== null &&
      !QUEUE_ITEM_ID_RE.test(value.expected.queueItemId || '')) ||
    !Number.isSafeInteger(value.expected.playlistRevision) ||
    value.expected.playlistRevision < 0 ||
    !Number.isSafeInteger(value.expected.playbackRevision) ||
    value.expected.playbackRevision < 0
  ) {
    return null;
  }
  const command = normalizeDeveloperCommand(value.command);
  if (!command) return null;
  const requiredVersion =
    command.type === 'next'
      ? DEVELOPER_NEXT_CONTROL_VERSION
      : command.type === 'set_effects'
        ? DEVELOPER_EFFECTS_CONTROL_VERSION
        : DEVELOPER_CONTROL_VERSION;
  if (value.version !== requiredVersion) return null;
  return {
    type: 'developer-command',
    version: requiredVersion,
    roomCode: value.roomCode,
    coordinatorEpoch: value.coordinatorEpoch,
    commandId: value.commandId,
    expiresAtMs: value.expiresAtMs,
    expected: {
      queueItemId: value.expected.queueItemId,
      playlistRevision: value.expected.playlistRevision,
      playbackRevision: value.expected.playbackRevision,
    },
    command,
  };
}

function normalizeDeveloperInvalidationFrame(value) {
  if (
    !hasExactKeys(value, [
      'type',
      'version',
      'roomCode',
      'coordinatorEpoch',
      'revision',
      'playlistRevision',
    ]) ||
    value.type !== 'developer-invalidation' ||
    value.version !== DEVELOPER_CONTROL_VERSION ||
    !isProNamespaceRoomCode(value.roomCode) ||
    !isValidProEpoch(value.coordinatorEpoch) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Number.isSafeInteger(value.playlistRevision) ||
    value.playlistRevision < 0
  ) {
    return null;
  }
  return {
    type: 'developer-invalidation',
    version: DEVELOPER_CONTROL_VERSION,
    roomCode: value.roomCode,
    coordinatorEpoch: value.coordinatorEpoch,
    revision: value.revision,
    playlistRevision: value.playlistRevision,
  };
}

function normalizeProQueueAdditionFrame(value) {
  if (
    !hasExactKeys(value, [
      'type',
      'version',
      'roomCode',
      'coordinatorEpoch',
      'playlistRevision',
      'eventId',
      'actorName',
      'count',
    ]) ||
    value.type !== 'pro-queue-addition' ||
    value.version !== DEVELOPER_CONTROL_VERSION ||
    !isProNamespaceRoomCode(value.roomCode) ||
    !isValidProEpoch(value.coordinatorEpoch) ||
    !Number.isSafeInteger(value.playlistRevision) ||
    value.playlistRevision < 1 ||
    typeof value.eventId !== 'string' ||
    !/^qa_0\d{5}_\d+_\d+$/.test(value.eventId) ||
    typeof value.actorName !== 'string' ||
    value.actorName.length < 1 ||
    value.actorName.length > 30 ||
    !Number.isSafeInteger(value.count) ||
    value.count < 1 ||
    value.count > 1000
  ) {
    return null;
  }
  return {
    type: 'pro-queue-addition',
    version: DEVELOPER_CONTROL_VERSION,
    roomCode: value.roomCode,
    coordinatorEpoch: value.coordinatorEpoch,
    playlistRevision: value.playlistRevision,
    eventId: value.eventId,
    actorName: value.actorName,
    count: value.count,
  };
}

async function readBoundedJson(request, maxBytes) {
  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) return null;
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return null;
  try {
    const text = await request.text();
    if (!text || utf8ByteLength(text) > maxBytes) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function defaultProTicketUses() {
  return { v: 1, entries: [] };
}

function normalizeProTicketUses(value) {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.entries)) return null;
  if (value.entries.length > MAX_PRO_TICKET_USES) return null;
  const entries = [];
  const seen = new Set();
  for (const entry of value.entries) {
    if (!isRecord(entry)) return null;
    if (typeof entry.jti !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(entry.jti)) return null;
    if (!Number.isSafeInteger(entry.exp) || entry.exp < 0 || seen.has(entry.jti)) return null;
    seen.add(entry.jti);
    entries.push({ jti: entry.jti, exp: entry.exp });
  }
  return { v: 1, entries };
}

function defaultProParticipantHighWater() {
  return { v: 1, entries: [] };
}

function normalizeProParticipantHighWater(value) {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.entries)) return null;
  if (value.entries.length > MAX_PRO_PARTICIPANT_HIGH_WATER) return null;
  const entries = [];
  const seen = new Set();
  for (const entry of value.entries) {
    if (
      !isRecord(entry) ||
      !isValidPeerId(entry.participantId) ||
      seen.has(entry.participantId) ||
      typeof entry.presenceIncarnationId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(entry.presenceIncarnationId) ||
      !Number.isSafeInteger(entry.ticketSequence) ||
      entry.ticketSequence < 1 ||
      !Number.isSafeInteger(entry.exp) ||
      entry.exp < 0
    ) {
      return null;
    }
    seen.add(entry.participantId);
    entries.push({
      participantId: entry.participantId,
      presenceIncarnationId: entry.presenceIncarnationId,
      ticketSequence: entry.ticketSequence,
      exp: entry.exp,
    });
  }
  return { v: 1, entries };
}

function utf8ByteLength(value) {
  if (typeof value !== 'string') return null;
  return new TextEncoder().encode(value).byteLength;
}

function rawMessageByteLength(raw) {
  if (typeof raw === 'string') {
    // UTF-8 is never shorter than the JavaScript code-unit length, so avoid
    // allocating a second huge buffer once the limit is already exceeded.
    if (raw.length > WS_MESSAGE_MAX_BYTES) return raw.length;
    return utf8ByteLength(raw);
  }
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (ArrayBuffer.isView(raw)) return raw.byteLength;
  return null;
}

function isValidSdp(value, expectedType) {
  if (!isRecord(value) || value.type !== expectedType || typeof value.sdp !== 'string') {
    return false;
  }
  const bytes = utf8ByteLength(value.sdp);
  return bytes !== null && bytes <= SDP_MAX_BYTES;
}

function isOversizedSdp(value) {
  if (!isRecord(value) || typeof value.sdp !== 'string') return false;
  const bytes = utf8ByteLength(value.sdp);
  return bytes !== null && bytes > SDP_MAX_BYTES;
}

function isValidIceCandidate(value) {
  if (!isRecord(value) || typeof value.candidate !== 'string') return false;
  const candidateBytes = utf8ByteLength(JSON.stringify(value));
  if (candidateBytes === null || candidateBytes > ICE_CANDIDATE_MAX_BYTES) return false;
  if (value.sdpMid !== undefined && value.sdpMid !== null && typeof value.sdpMid !== 'string') {
    return false;
  }
  if (
    value.sdpMLineIndex !== undefined &&
    value.sdpMLineIndex !== null &&
    (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0)
  ) {
    return false;
  }
  if (
    value.usernameFragment !== undefined &&
    value.usernameFragment !== null &&
    typeof value.usernameFragment !== 'string'
  ) {
    return false;
  }
  return true;
}

function isOversizedIceCandidate(value) {
  if (!isRecord(value)) return false;
  const bytes = utf8ByteLength(JSON.stringify(value));
  return bytes !== null && bytes > ICE_CANDIDATE_MAX_BYTES;
}

function validateIncomingMessage(message, role) {
  if (!isRecord(message) || typeof message.type !== 'string' || message.type.length > 64) {
    return 'ignore';
  }

  if (role === 'host-pending') {
    return hasExactKeys(message, ['type', 'secret']) &&
      message.type === 'host-auth' &&
      isValidPeerId(message.secret)
      ? 'valid'
      : 'ignore';
  }

  if (role === 'pending') {
    if (message.type !== 'guest-auth') return 'ignore';
    if (typeof message.password !== 'string') return 'ignore';
    if (
      message.reconnectSecret !== undefined &&
      !isValidGuestReconnectSecret(message.reconnectSecret)
    ) {
      return 'ignore';
    }
    return 'valid';
  }

  if (role === 'guest') {
    // The current client sends this on every guest socket, including rooms
    // without a password. Once the guest is admitted it is intentionally a
    // harmless no-op, preserving the existing wire contract.
    if (message.type === 'guest-auth') return 'ignore';
    if (message.to !== 'host') return 'ignore';
    if (message.type === 'signal-offer') {
      if (isOversizedSdp(message.sdp)) return 'oversized';
      return isValidSdp(message.sdp, 'offer') ? 'valid' : 'ignore';
    }
    if (message.type === 'signal-candidate') {
      if (isOversizedIceCandidate(message.candidate)) return 'oversized';
      return isValidIceCandidate(message.candidate) ? 'valid' : 'ignore';
    }
    if (message.type === 'media-answer') {
      if (isOversizedSdp(message.sdp)) return 'oversized';
      return isValidPeerId(message.callId) && isValidSdp(message.sdp, 'answer')
        ? 'valid'
        : 'ignore';
    }
    if (message.type === 'media-close') {
      return isValidPeerId(message.callId) ? 'valid' : 'ignore';
    }
    return 'ignore';
  }

  if (role !== 'host') return 'ignore';
  if (message.type === 'room-password-set') {
    return typeof message.password === 'string' ? 'valid' : 'ignore';
  }
  if (!isValidPeerId(message.to)) return 'ignore';
  if (message.type === 'signal-answer') {
    if (isOversizedSdp(message.sdp)) return 'oversized';
    return isValidSdp(message.sdp, 'answer') ? 'valid' : 'ignore';
  }
  if (message.type === 'signal-candidate') {
    if (isOversizedIceCandidate(message.candidate)) return 'oversized';
    return isValidIceCandidate(message.candidate) ? 'valid' : 'ignore';
  }
  if (message.type === 'media-offer') {
    if (isOversizedSdp(message.sdp)) return 'oversized';
    return isValidPeerId(message.callId) && isValidSdp(message.sdp, 'offer') ? 'valid' : 'ignore';
  }
  if (message.type === 'media-close') {
    return isValidPeerId(message.callId) ? 'valid' : 'ignore';
  }
  return 'ignore';
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'
  );
}

async function checkRateLimit(request, key, limit = WS_RATE_LIMIT_PER_MINUTE, windowSec = 60) {
  if (typeof caches === 'undefined' || !caches?.default) return true;
  const ip = getClientIp(request);
  const window = Math.floor(Date.now() / (windowSec * 1000));
  const cacheKey = new Request(
    `https://ratelimit.internal/${encodeURIComponent(key)}/${encodeURIComponent(ip)}/${window}`,
  );
  try {
    const current = await caches.default.match(cacheKey);
    const count = current ? Number(await current.text()) || 0 : 0;
    if (count >= limit) return false;
    await caches.default.put(
      cacheKey,
      new Response(String(count + 1), {
        headers: { 'Cache-Control': `public, max-age=${windowSec * 2}` },
      }),
    );
  } catch {
    /* best-effort */
  }
  return true;
}

function send(ws, message) {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* noop */
  }
}

function sendChecked(ws, message) {
  try {
    // Cloudflare exposes the standard numeric readyState values. A closed
    // hibernatable socket may discard send() without throwing, so a successful
    // call alone is not proof that peer-open can reach the candidate.
    if (typeof ws.readyState === 'number' && ws.readyState !== 1) return false;
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function closeWithError(ws, errorType, message, code = 1011) {
  send(ws, { type: 'error', errorType, message });
  try {
    ws.close(code, message);
  } catch {
    /* noop */
  }
}

function getMetricsDb(env) {
  return env?.MUSIXQUARE_ADMIN_DB || env?.ADMIN_METRICS_DB || null;
}

async function recordMetric(env, event, now = Date.now()) {
  const db = getMetricsDb(env);
  if (!db?.prepare || typeof event !== 'string' || !event) return;
  const bucketMinute = Math.floor(now / 60000);
  try {
    await db
      .prepare(
        `INSERT INTO ${METRICS_TABLE} (bucket_minute, event, count)
         VALUES (?1, ?2, 1)
         ON CONFLICT(bucket_minute, event)
         DO UPDATE SET count = count + 1`,
      )
      .bind(bucketMinute, event)
      .run();
  } catch (error) {
    console.warn('[Metrics] Failed to record signaling metric', event, error);
  }
}

function defaultRoomMeta() {
  return {
    v: 1,
    roomSecret: null,
    roomPassword: '',
    hostPeerId: null,
    hostReleaseAt: 0,
  };
}

function normalizeRoomMeta(value) {
  if (!value || typeof value !== 'object') return defaultRoomMeta();
  return {
    v: 1,
    roomSecret: typeof value.roomSecret === 'string' && value.roomSecret ? value.roomSecret : null,
    roomPassword: typeof value.roomPassword === 'string' ? value.roomPassword : '',
    hostPeerId: typeof value.hostPeerId === 'string' && value.hostPeerId ? value.hostPeerId : null,
    hostReleaseAt: Number.isFinite(value.hostReleaseAt) ? Math.max(0, value.hostReleaseAt) : 0,
  };
}

function normalizeProRoomMeta(value) {
  if (!isRecord(value) || value.v !== 1 || value.kind !== 'pro') return null;
  if (typeof value.roomId !== 'string' || !/^\d{6}$/.test(value.roomId)) return null;
  if (!isValidProEpoch(value.coordinatorEpoch)) return null;
  if (!isValidPeerId(value.coordinatorParticipantId)) return null;
  if (
    typeof value.coordinatorJti !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.coordinatorJti)
  ) {
    return null;
  }
  return {
    v: 1,
    kind: 'pro',
    roomId: value.roomId,
    coordinatorEpoch: value.coordinatorEpoch,
    coordinatorParticipantId: value.coordinatorParticipantId,
    coordinatorJti: value.coordinatorJti,
    coordinatorPresenceIncarnationId:
      typeof value.coordinatorPresenceIncarnationId === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value.coordinatorPresenceIncarnationId)
        ? value.coordinatorPresenceIncarnationId
        : `legacy_${value.coordinatorJti.slice(0, 120)}`,
    coordinatorTicketSequence:
      Number.isSafeInteger(value.coordinatorTicketSequence) && value.coordinatorTicketSequence >= 1
        ? value.coordinatorTicketSequence
        : 0,
    coordinatorTicketIat: Number.isSafeInteger(value.coordinatorTicketIat)
      ? Math.max(0, value.coordinatorTicketIat)
      : 0,
  };
}

function normalizeAttachment(value) {
  if (!value || typeof value !== 'object' || value.v !== ATTACHMENT_VERSION) return null;
  if (value.role !== 'host' && value.role !== 'guest') return null;
  if (typeof value.roomId !== 'string' || !value.roomId) return null;
  if (typeof value.peerId !== 'string' || !value.peerId) return null;

  if (value.roomKind === 'pro') {
    if (!isValidProEpoch(value.coordinatorEpoch)) return null;
    if (!isValidPeerId(value.participantId)) return null;
    if (typeof value.ticketJti !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.ticketJti)) {
      return null;
    }
    if (value.auth !== 'ok') return null;
    const proAttachment = {
      v: ATTACHMENT_VERSION,
      roomKind: 'pro',
      role: value.role,
      roomId: value.roomId,
      peerId: value.peerId,
      participantId: value.participantId,
      coordinatorEpoch: value.coordinatorEpoch,
      ticketJti: value.ticketJti,
      presenceIncarnationId:
        typeof value.presenceIncarnationId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value.presenceIncarnationId)
          ? value.presenceIncarnationId
          : `legacy_${value.ticketJti.slice(0, 120)}`,
      ticketSequence:
        Number.isSafeInteger(value.ticketSequence) && value.ticketSequence >= 1
          ? value.ticketSequence
          : 0,
      developerControlVersion:
        Number.isSafeInteger(value.developerControlVersion) &&
        value.developerControlVersion >= 0 &&
        value.developerControlVersion <= DEVELOPER_CONTROL_MAX_VERSION
          ? value.developerControlVersion
          : 0,
      auth: 'ok',
    };
    if (value.role === 'guest') {
      if (
        Number.isFinite(value.guestMessageTokens) &&
        Number.isFinite(value.guestMessageUpdatedAt)
      ) {
        proAttachment.guestMessageTokens = Math.min(
          GUEST_MESSAGE_BUCKET_CAPACITY,
          Math.max(0, value.guestMessageTokens),
        );
        proAttachment.guestMessageUpdatedAt = Math.max(0, value.guestMessageUpdatedAt);
      }
    }
    return proAttachment;
  }

  if (value.role === 'host') {
    if (value.auth === 'ok' && typeof value.secret === 'string' && value.secret) {
      return {
        v: ATTACHMENT_VERSION,
        role: 'host',
        roomId: value.roomId,
        peerId: value.peerId,
        secret: value.secret,
        auth: 'ok',
      };
    }
    if (value.auth === 'pending') {
      return {
        v: ATTACHMENT_VERSION,
        role: 'host',
        roomId: value.roomId,
        peerId: value.peerId,
        auth: 'pending',
        authDeadline: Number.isFinite(value.authDeadline) ? value.authDeadline : 0,
        authStarted: value.authStarted === true,
      };
    }
    return null;
  }

  const guestMessageBucket =
    Number.isFinite(value.guestMessageTokens) && Number.isFinite(value.guestMessageUpdatedAt)
      ? {
          guestMessageTokens: Math.min(
            GUEST_MESSAGE_BUCKET_CAPACITY,
            Math.max(0, value.guestMessageTokens),
          ),
          guestMessageUpdatedAt: Math.max(0, value.guestMessageUpdatedAt),
        }
      : {};
  if (value.auth === 'ok') {
    return {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId: value.roomId,
      peerId: value.peerId,
      auth: 'ok',
      ...guestMessageBucket,
    };
  }

  if (value.auth === 'pending') {
    return {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId: value.roomId,
      peerId: value.peerId,
      auth: 'pending',
      authDeadline: Number.isFinite(value.authDeadline) ? value.authDeadline : 0,
      authStarted: value.authStarted === true,
      ...guestMessageBucket,
    };
  }

  return null;
}

function readAttachment(ws) {
  try {
    return normalizeAttachment(ws.deserializeAttachment?.());
  } catch {
    return null;
  }
}

function closeSocket(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {
    /* noop */
  }
}

export class MusixquareRoom {
  constructor(state, env = {}) {
    this.state = state;
    this.env = env;
    this.roomMeta = null;
    this.proRoomMeta = null;
    this.host = null;
    this.hostPeerId = null;
    this.pendingHosts = new Set();
    this.guests = new Map();
    this.pendingGuests = new Set();
    this.guestBindings = null;
    this.proTicketUses = null;
    this.proParticipantHighWater = null;
    // Standard-room host metadata and guest reconnect bindings describe one
    // room epoch. Serialize their admission/leave mutations together so an
    // awaited host reconnect write cannot be overwritten by a stale host close
    // or an overlapping empty-room cleanup.
    this.standardAdmissionSync = Promise.resolve();
    this.proAdmissionSync = Promise.resolve();
    this.alarmSync = Promise.resolve();
    this.proSocketsValidated = false;
    this.rehydrateSockets();
  }

  defer(task) {
    try {
      if (typeof this.state.waitUntil === 'function') {
        this.state.waitUntil(task);
        return;
      }
    } catch {
      // The task is already running and owns its error handling. This fallback
      // keeps local/test runtimes without DurableObjectState.waitUntil working.
    }
    void task;
  }

  recordMetric(event, now = Date.now()) {
    this.defer(recordMetric(this.env, event, now));
  }

  admittedGuestIds() {
    // Pending sockets are handshake attempts, not connected devices. Counting
    // them here lets silent unauthenticated clients consume all 99 legitimate
    // guest slots for the full authentication timeout.
    return new Set(this.guests.keys());
  }

  consumeGuestMessageToken(ws, now = Date.now()) {
    const attachment = readAttachment(ws);
    if (!attachment || attachment.role !== 'guest') return false;
    const previousTokens = Number.isFinite(attachment.guestMessageTokens)
      ? attachment.guestMessageTokens
      : GUEST_MESSAGE_BUCKET_CAPACITY;
    const previousUpdatedAt = Number.isFinite(attachment.guestMessageUpdatedAt)
      ? attachment.guestMessageUpdatedAt
      : now;
    const elapsed = Math.max(0, now - previousUpdatedAt);
    const tokens = Math.min(
      GUEST_MESSAGE_BUCKET_CAPACITY,
      previousTokens + elapsed * GUEST_MESSAGE_REFILL_PER_MS,
    );
    const remainingTokens = tokens < 1 ? tokens : tokens - 1;
    // WebSocket attachments survive Durable Object hibernation, unlike an
    // in-memory Map/WeakMap. Persisting this tiny bucket state on each frame
    // keeps one active guest from receiving a fresh burst after rehydration.
    // A genuinely new connection still starts a new burst; reconnect churn is
    // separately bounded by the outer per-IP `ws-open` limiter.
    ws.serializeAttachment({
      ...attachment,
      guestMessageTokens: remainingTokens,
      guestMessageUpdatedAt: now,
    });
    if (tokens < 1) {
      return false;
    }
    return true;
  }

  rehydrateSockets() {
    const sockets =
      typeof this.state.getWebSockets === 'function' ? this.state.getWebSockets() : [];
    for (const ws of sockets) {
      this.indexSocket(ws);
    }
  }

  indexSocket(ws) {
    const attachment = readAttachment(ws);
    if (!attachment) return;
    if (attachment.role === 'host') {
      if (attachment.auth === 'pending') {
        if (this.pendingHosts.size >= MAX_PENDING_HOST_SOCKETS) {
          closeWithError(ws, 'room-full', 'HOST_PENDING_LIMIT_REACHED', 1008);
          return;
        }
        if (Date.now() > attachment.authDeadline) {
          closeSocket(ws, 1011, 'host auth timeout (hibernation)');
          return;
        }
        this.pendingHosts.add(ws);
        return;
      }
      this.host = ws;
      this.hostPeerId = attachment.peerId;
      return;
    }
    const admitted = this.admittedGuestIds();
    if (!admitted.has(attachment.peerId) && admitted.size >= MAX_ROOM_GUESTS) {
      closeWithError(ws, 'room-full', 'ROOM_GUEST_LIMIT_REACHED', 1008);
      return;
    }
    if (attachment.auth === 'ok') {
      this.guests.set(attachment.peerId, ws);
      return;
    }
    if (attachment.auth === 'pending') {
      if (this.pendingGuests.size >= MAX_PENDING_GUEST_SOCKETS) {
        closeWithError(ws, 'room-full', 'ROOM_PENDING_LIMIT_REACHED', 1008);
        this.recordMetric('guest_pending_capacity');
        return;
      }
      // If the DO slept past the pending guest's authDeadline, don't leak
      // the slot — close immediately on hibernation wake so a real guest
      // can take its place.
      if (typeof attachment.authDeadline === 'number' && Date.now() > attachment.authDeadline) {
        try {
          ws.close(1011, 'auth timeout (hibernation)');
        } catch {
          /* ignore */
        }
        return;
      }
      this.pendingGuests.add(ws);
    }
  }

  async loadProRoomMeta() {
    if (!this.proRoomMeta) {
      const stored = await this.state.storage.get(PRO_ROOM_META_KEY);
      this.proRoomMeta = normalizeProRoomMeta(stored);
    }
    return this.proRoomMeta;
  }

  async saveProRoomMeta(meta) {
    const normalized = normalizeProRoomMeta(meta);
    if (!normalized) throw new Error('INVALID_PRO_ROOM_META');
    await this.state.storage.put(PRO_ROOM_META_KEY, normalized);
    this.proRoomMeta = normalized;
    return normalized;
  }

  async loadProTicketUses(nowSeconds = Math.floor(Date.now() / 1000)) {
    if (this.proTicketUses) return this.proTicketUses;
    const stored = await this.state.storage.get(PRO_TICKET_USES_KEY);
    if (stored !== undefined && stored !== null) {
      const normalized = normalizeProTicketUses(stored);
      if (!normalized) throw new Error('INVALID_PRO_SIGNALING_TICKET_LEDGER');
      this.proTicketUses = normalized;
      return normalized;
    }

    // Rolling-deploy safety: attachments created by the previous Worker already
    // carry their JTI, while no persistent one-use ledger exists yet. Seed those
    // live tickets for one maximum ticket lifetime so a replay cannot replace a
    // hibernated participant immediately after deployment.
    const seeded = defaultProTicketUses();
    for (const socket of typeof this.state.getWebSockets === 'function'
      ? this.state.getWebSockets()
      : []) {
      const attachment = readAttachment(socket);
      if (attachment?.roomKind !== 'pro' || seeded.entries.length >= MAX_PRO_TICKET_USES) continue;
      if (seeded.entries.some((entry) => entry.jti === attachment.ticketJti)) continue;
      seeded.entries.push({
        jti: attachment.ticketJti,
        exp: nowSeconds + PRO_SIGNALING_TICKET_MAX_SECONDS,
      });
    }
    if (seeded.entries.length > 0) await this.state.storage.put(PRO_TICKET_USES_KEY, seeded);
    this.proTicketUses = seeded;
    return seeded;
  }

  async consumeProTicket(ticket, nowSeconds = Math.floor(Date.now() / 1000)) {
    const current = await this.loadProTicketUses(nowSeconds);
    const entries = current.entries.filter((entry) => entry.exp > nowSeconds);
    if (entries.some((entry) => entry.jti === ticket.jti)) return false;
    if (entries.length >= MAX_PRO_TICKET_USES) {
      throw new Error('PRO_SIGNALING_TICKET_LEDGER_FULL');
    }
    const next = {
      v: 1,
      entries: [...entries, { jti: ticket.jti, exp: ticket.exp }],
    };
    // Persist before replacing any live socket. A failed write therefore fails
    // closed instead of admitting a replayable credential.
    await this.state.storage.put(PRO_TICKET_USES_KEY, next);
    this.proTicketUses = next;
    return true;
  }

  async loadProParticipantHighWater(nowSeconds = Math.floor(Date.now() / 1000)) {
    if (this.proParticipantHighWater) return this.proParticipantHighWater;
    const stored = await this.state.storage.get(PRO_PARTICIPANT_HIGH_WATER_KEY);
    if (stored !== undefined && stored !== null) {
      const normalized = normalizeProParticipantHighWater(stored);
      if (!normalized) throw new Error('INVALID_PRO_SIGNALING_PARTICIPANT_HIGH_WATER');
      this.proParticipantHighWater = normalized;
      return normalized;
    }

    // Recover the monotonic fence from hibernated sockets before accepting a
    // fresh credential. This prevents a delayed, lower-sequence ticket from
    // reverse-replacing the socket that survived Worker eviction/deployment.
    const byParticipant = new Map();
    for (const socket of typeof this.state.getWebSockets === 'function'
      ? this.state.getWebSockets()
      : []) {
      const attachment = readAttachment(socket);
      if (attachment?.roomKind !== 'pro' || attachment.ticketSequence < 1) continue;
      const current = byParticipant.get(attachment.participantId);
      if (!current || attachment.ticketSequence > current.ticketSequence) {
        byParticipant.set(attachment.participantId, {
          participantId: attachment.participantId,
          presenceIncarnationId: attachment.presenceIncarnationId,
          ticketSequence: attachment.ticketSequence,
          exp: nowSeconds + PRO_SIGNALING_TICKET_MAX_SECONDS,
        });
      }
    }
    const seeded = {
      v: 1,
      entries: [...byParticipant.values()].slice(0, MAX_PRO_PARTICIPANT_HIGH_WATER),
    };
    if (seeded.entries.length > 0) {
      await this.state.storage.put(PRO_PARTICIPANT_HIGH_WATER_KEY, seeded);
    }
    this.proParticipantHighWater = seeded;
    return seeded;
  }

  async advanceProParticipantHighWater(ticket, nowSeconds = Math.floor(Date.now() / 1000)) {
    const current = await this.loadProParticipantHighWater(nowSeconds);
    const entries = current.entries.filter(
      (entry) => entry.exp > nowSeconds || entry.participantId === ticket.participantId,
    );
    const previous = entries.find((entry) => entry.participantId === ticket.participantId);
    if (previous && ticket.ticketSequence <= previous.ticketSequence) return false;
    const remaining = entries.filter((entry) => entry.participantId !== ticket.participantId);
    if (remaining.length >= MAX_PRO_PARTICIPANT_HIGH_WATER) {
      throw new Error('PRO_SIGNALING_PARTICIPANT_HIGH_WATER_FULL');
    }
    const next = {
      v: 1,
      entries: [
        ...remaining,
        {
          participantId: ticket.participantId,
          presenceIncarnationId: ticket.presenceIncarnationId,
          ticketSequence: ticket.ticketSequence,
          exp: ticket.exp,
        },
      ],
    };
    await this.state.storage.put(PRO_PARTICIPANT_HIGH_WATER_KEY, next);
    this.proParticipantHighWater = next;
    return true;
  }

  enqueueProAdmission(task) {
    const run = this.proAdmissionSync.then(task, task);
    this.proAdmissionSync = run.catch(() => {});
    return run;
  }

  async acceptProSocket(ws, ticket) {
    try {
      if (!(await this.consumeProTicket(ticket))) {
        this.acceptSocket(ws, null, [
          'kind:pro',
          ticket.role === 'coordinator' ? 'role:host' : 'role:guest',
          'rejected:ticket-replay',
        ]);
        closeWithError(ws, 'peer-unavailable', 'PRO_SIGNALING_TICKET_REPLAYED', 1008);
        this.recordMetric('pro_ticket_replayed');
        return;
      }
    } catch {
      this.acceptSocket(ws, null, [
        'kind:pro',
        ticket.role === 'coordinator' ? 'role:host' : 'role:guest',
        'rejected:ticket-state',
      ]);
      closeWithError(ws, 'unavailable', 'PRO_SIGNALING_TICKET_STATE_UNAVAILABLE', 1013);
      this.recordMetric('pro_ticket_state_unavailable');
      return;
    }

    try {
      if (!(await this.advanceProParticipantHighWater(ticket))) {
        this.acceptSocket(ws, null, [
          'kind:pro',
          ticket.role === 'coordinator' ? 'role:host' : 'role:guest',
          'rejected:ticket-sequence',
        ]);
        closeWithError(ws, 'peer-unavailable', 'PRO_SIGNALING_TICKET_STALE', 1008);
        this.recordMetric('pro_ticket_stale_sequence');
        return;
      }
    } catch {
      this.acceptSocket(ws, null, [
        'kind:pro',
        ticket.role === 'coordinator' ? 'role:host' : 'role:guest',
        'rejected:ticket-state',
      ]);
      closeWithError(ws, 'unavailable', 'PRO_SIGNALING_TICKET_STATE_UNAVAILABLE', 1013);
      this.recordMetric('pro_ticket_state_unavailable');
      return;
    }

    if (ticket.role === 'coordinator') {
      await this.acceptProCoordinator(ws, ticket);
    } else {
      await this.acceptProMember(ws, ticket);
    }
  }

  async validateRehydratedProSockets() {
    if (this.proSocketsValidated) return;
    const meta = await this.loadProRoomMeta();
    for (const socket of typeof this.state.getWebSockets === 'function'
      ? this.state.getWebSockets()
      : []) {
      const attachment = readAttachment(socket);
      if (attachment?.roomKind !== 'pro') continue;
      const current =
        meta?.kind === 'pro' &&
        meta.roomId === attachment.roomId &&
        meta.coordinatorEpoch === attachment.coordinatorEpoch &&
        (attachment.role !== 'host' ||
          (meta.coordinatorParticipantId === attachment.participantId &&
            meta.coordinatorPresenceIncarnationId === attachment.presenceIncarnationId &&
            meta.coordinatorTicketSequence === attachment.ticketSequence));
      if (current) continue;
      closeSocket(socket, 1012, 'PRO_COORDINATOR_EPOCH_STALE');
      if (attachment.role === 'host' && this.host === socket) {
        this.host = null;
        this.hostPeerId = null;
      } else if (this.guests.get(attachment.peerId) === socket) {
        this.guests.delete(attachment.peerId);
      }
    }
    this.proSocketsValidated = true;
  }

  async loadRoomMeta() {
    if (!this.roomMeta) {
      const stored = await this.state.storage.get(ROOM_META_KEY);
      this.roomMeta = normalizeRoomMeta(stored);
    }
    return this.roomMeta;
  }

  async saveRoomMeta(meta) {
    const normalized = normalizeRoomMeta(meta);
    await this.state.storage.put(ROOM_META_KEY, normalized);
    this.roomMeta = normalized;
    return normalized;
  }

  async clearRoomMeta() {
    return this.saveRoomMeta(defaultRoomMeta());
  }

  async loadGuestBindings() {
    if (!this.guestBindings) {
      const stored = await this.state.storage.get(GUEST_BINDINGS_KEY);
      this.guestBindings = normalizeGuestBindings(stored);
    }
    return this.guestBindings;
  }

  async saveGuestBindings(bindings) {
    const normalized = normalizeGuestBindings(bindings);
    await this.state.storage.put(GUEST_BINDINGS_KEY, normalized);
    this.guestBindings = normalized;
    return normalized;
  }

  async clearGuestBindings() {
    return this.saveGuestBindings(defaultGuestBindings());
  }

  pruneGuestBindings(bindings, now = Date.now()) {
    const activePeerIds = new Set(this.guests.keys());
    const entries = bindings.entries.filter(
      (entry) =>
        activePeerIds.has(entry.peerId) || now - entry.updatedAt <= GUEST_BINDING_RECONNECT_TTL_MS,
    );
    return { v: 1, entries };
  }

  enqueueStandardAdmission(task) {
    const run = this.standardAdmissionSync.then(task, task);
    this.standardAdmissionSync = run.catch(() => {});
    return run;
  }

  enqueueHostAdmission(task) {
    return this.enqueueStandardAdmission(task);
  }

  enqueueGuestAdmission(task) {
    return this.enqueueStandardAdmission(task);
  }

  async clearExpiredHostRelease() {
    const meta = await this.loadRoomMeta();
    if (this.host || !meta.hostReleaseAt || meta.hostReleaseAt > Date.now()) return meta;

    // A room epoch ends when the host reclaim grace expires. Any hibernated
    // guest sockets from that epoch must not survive into a new host that later
    // claims the same six-digit room ID.
    for (const socket of new Set([...this.guests.values(), ...this.pendingGuests])) {
      closeSocket(socket, 1012, 'ROOM_EXPIRED');
    }
    this.guests.clear();
    this.pendingGuests.clear();
    await this.clearGuestBindings();
    return this.clearRoomMeta();
  }

  nextMaintenanceAlarmAt() {
    let earliest = null;
    for (const sock of [...this.pendingHosts, ...this.pendingGuests]) {
      const attachment = readAttachment(sock);
      if (typeof attachment?.authDeadline !== 'number') continue;
      // Fire just after the deadline so the strict `now > authDeadline`
      // timeout check has definitely elapsed on wake.
      const authSweepAt = attachment.authDeadline + 1000;
      if (earliest === null || authSweepAt < earliest) earliest = authSweepAt;
    }

    const hostReleaseAt = !this.host ? this.roomMeta?.hostReleaseAt : 0;
    if (hostReleaseAt && (earliest === null || hostReleaseAt < earliest)) {
      earliest = hostReleaseAt;
    }
    return earliest;
  }

  async syncMaintenanceAlarm() {
    try {
      const nextAlarmAt = this.nextMaintenanceAlarmAt();
      const currentAlarm = await this.state.storage.getAlarm();
      if (nextAlarmAt === null) {
        if (currentAlarm !== null) await this.state.storage.deleteAlarm();
        return;
      }
      if (currentAlarm !== nextAlarmAt) await this.state.storage.setAlarm(nextAlarmAt);
    } catch (error) {
      console.warn('[Room] Failed to synchronize maintenance alarm', error);
    }
  }

  scheduleMaintenanceAlarm() {
    // Alarm updates may be requested by overlapping WebSocket callbacks. Keep
    // them ordered and recompute from the latest in-memory state at execution
    // time so an older request cannot overwrite a newer deadline.
    this.alarmSync = this.alarmSync.then(
      () => this.syncMaintenanceAlarm(),
      () => this.syncMaintenanceAlarm(),
    );
    this.defer(this.alarmSync);
    return this.alarmSync;
  }

  acceptSocket(ws, attachment, tags) {
    this.state.acceptWebSocket(ws, tags);
    if (attachment) ws.serializeAttachment(attachment);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/internal/')) {
      if (request.method !== 'POST' || url.search || url.hash) {
        return json({ error: 'NOT_FOUND' }, 404);
      }
      if (url.pathname === '/internal/developer/v1/dispatch') {
        return this.handleInternalDeveloperDispatch(request);
      }
      if (url.pathname === '/internal/developer/v1/invalidate') {
        return this.handleInternalDeveloperInvalidation(request);
      }
      if (url.pathname === '/internal/admin/v1/decommission') {
        return this.enqueueProAdmission(() => this.handleInternalAdminDecommission(request));
      }
      return json({ error: 'NOT_FOUND' }, 404);
    }
    const upgrade = request.headers.get('Upgrade') || '';
    if (upgrade.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket upgrade required' }, 426);
    }

    const proRoomId = url.pathname.match(PRO_ROOM_PATH)?.[1];
    if (proRoomId) {
      if (!isProNamespaceRoomCode(proRoomId)) {
        return json({ error: 'PRO_ROOM_NOT_CONFIGURED' }, 404);
      }
      // The signed ticket must never be included in application logs. It is
      // intentionally read once here and represented only by its JTI afterward.
      const ticket = await verifyProSignalingTicket(
        url.searchParams.get('ticket') || '',
        proRoomId,
        this.env,
      );
      if (!ticket) return json({ error: 'INVALID_PRO_SIGNALING_TICKET' }, 401);

      return this.enqueueProAdmission(async () => {
        // Keep the tombstone read in the same queue as ticket consumption and
        // permanent decommission. A connection that passed an earlier check
        // must never repopulate signaling storage after the deletion sweep.
        const decommissioned = await this.state.storage.get(PRO_DECOMMISSIONED_KEY);
        if (decommissioned?.roomCode === proRoomId) {
          return json({ error: 'PRO_ROOM_DECOMMISSIONED' }, 410);
        }
        await this.validateRehydratedProSockets();
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        await this.acceptProSocket(server, ticket);
        return new Response(null, { status: 101, webSocket: client });
      });
    }

    const roomId = url.pathname.match(ROOM_PATH)?.[1];
    const role = url.searchParams.get('role');
    const peerId = url.searchParams.get('peerId');
    const secret = url.searchParams.get('secret') || '';
    if (!roomId || (role !== 'host' && role !== 'guest') || !isValidPeerId(peerId)) {
      return json({ error: 'Bad request' }, 400);
    }
    if (isProNamespaceRoomCode(roomId)) {
      return json({ error: 'ROOM_RESERVED' }, 403);
    }
    if (role === 'host' && secret && !isValidPeerId(secret)) {
      return json({ error: 'Bad request' }, 400);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'host') {
      if (secret) {
        // Temporary rolling compatibility for cached app shells that still put
        // the host secret in the query. Current clients use first-frame auth.
        await this.enqueueHostAdmission(() => this.acceptHost(server, roomId, peerId, secret));
      } else {
        this.acceptPendingHost(server, roomId, peerId);
      }
    } else if (role === 'guest') {
      await this.acceptGuest(server, roomId, peerId);
    } else {
      this.acceptSocket(server, null, ['role:invalid']);
      closeWithError(server, 'invalid-id', 'INVALID_ROLE');
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleInternalAdminDecommission(request) {
    const value = await readBoundedJson(request, INTERNAL_ADMIN_BODY_MAX_BYTES);
    if (
      !hasExactKeys(value, ['roomCode', 'requestId']) ||
      !isProNamespaceRoomCode(value.roomCode) ||
      request.headers.get('x-mxqr-pro-room-code') !== value.roomCode ||
      !ADMIN_REQUEST_ID_RE.test(value.requestId)
    ) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }

    const existing = await this.state.storage.get(PRO_DECOMMISSIONED_KEY);
    const changed = existing?.roomCode !== value.roomCode;
    const tombstone = changed
      ? {
          v: 1,
          roomCode: value.roomCode,
          requestId: value.requestId,
          decommissionedAtMs: Date.now(),
        }
      : existing;

    // Persist the admission fence before deleting any other key. If cleanup is
    // interrupted, old signaling tickets remain rejected and an idempotent
    // retry repairs the residue without a deleteAll -> put crash window.
    await this.state.storage.put(PRO_DECOMMISSIONED_KEY, tombstone);

    for (const socket of typeof this.state.getWebSockets === 'function'
      ? this.state.getWebSockets()
      : []) {
      closeSocket(socket, 1012, 'PRO_ROOM_DECOMMISSIONED');
    }
    this.host = null;
    this.hostPeerId = null;
    this.pendingHosts.clear();
    this.guests.clear();
    this.pendingGuests.clear();
    this.roomMeta = null;
    this.proRoomMeta = null;
    this.guestBindings = null;
    this.proTicketUses = null;
    this.proParticipantHighWater = null;
    this.proSocketsValidated = true;

    const stored =
      typeof this.state.storage.list === 'function' ? await this.state.storage.list() : null;
    const keys = stored
      ? [...stored.keys()]
      : [
          ROOM_META_KEY,
          GUEST_BINDINGS_KEY,
          PRO_ROOM_META_KEY,
          PRO_TICKET_USES_KEY,
          PRO_PARTICIPANT_HIGH_WATER_KEY,
        ];
    for (const key of keys) {
      if (key !== PRO_DECOMMISSIONED_KEY && typeof this.state.storage.delete === 'function') {
        await this.state.storage.delete(key);
      }
    }
    if (typeof this.state.storage.deleteAlarm === 'function') {
      await this.state.storage.deleteAlarm();
    }
    return json({
      ok: true,
      roomCode: value.roomCode,
      status: 'decommissioned',
      changed,
    });
  }

  async handleInternalDeveloperDispatch(request) {
    const value = await readBoundedJson(request, DEVELOPER_COMMAND_BODY_MAX_BYTES);
    if (
      !hasExactKeys(value, [
        'roomCode',
        'coordinatorEpoch',
        'coordinatorParticipantId',
        'coordinatorPresenceIncarnationId',
        'developerControlVersion',
        'frame',
      ]) ||
      !isProNamespaceRoomCode(value.roomCode) ||
      !isValidProEpoch(value.coordinatorEpoch) ||
      !isValidPeerId(value.coordinatorParticipantId) ||
      typeof value.coordinatorPresenceIncarnationId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value.coordinatorPresenceIncarnationId) ||
      !Number.isSafeInteger(value.developerControlVersion) ||
      value.developerControlVersion < DEVELOPER_CONTROL_VERSION ||
      value.developerControlVersion > DEVELOPER_CONTROL_MAX_VERSION
    ) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }
    const frame = normalizeDeveloperCommandFrame(value.frame);
    if (
      !frame ||
      frame.version !== value.developerControlVersion ||
      frame.roomCode !== value.roomCode ||
      frame.coordinatorEpoch !== value.coordinatorEpoch ||
      frame.expiresAtMs <= Date.now()
    ) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }

    await this.validateRehydratedProSockets();
    const meta = await this.loadProRoomMeta();
    const attachment = readAttachment(this.host);
    if (
      !meta ||
      meta.roomId !== value.roomCode ||
      meta.coordinatorEpoch !== value.coordinatorEpoch ||
      meta.coordinatorParticipantId !== value.coordinatorParticipantId ||
      meta.coordinatorPresenceIncarnationId !== value.coordinatorPresenceIncarnationId ||
      !this.host ||
      attachment?.roomKind !== 'pro' ||
      attachment.role !== 'host' ||
      attachment.roomId !== value.roomCode ||
      attachment.participantId !== value.coordinatorParticipantId ||
      attachment.coordinatorEpoch !== value.coordinatorEpoch ||
      attachment.presenceIncarnationId !== value.coordinatorPresenceIncarnationId ||
      attachment.developerControlVersion < value.developerControlVersion
    ) {
      return json({ error: 'COORDINATOR_UNAVAILABLE' }, 409);
    }
    return sendChecked(this.host, frame)
      ? json({ dispatched: true })
      : json({ error: 'COORDINATOR_UNAVAILABLE' }, 409);
  }

  async handleInternalDeveloperInvalidation(request) {
    const value = await readBoundedJson(request, DEVELOPER_COMMAND_BODY_MAX_BYTES);
    if (
      !hasExactKeys(
        value,
        [
          'roomCode',
          'coordinatorEpoch',
          'coordinatorParticipantId',
          'coordinatorPresenceIncarnationId',
          'developerControlVersion',
          'frame',
        ],
        ['addition'],
      ) ||
      !isProNamespaceRoomCode(value.roomCode) ||
      !isValidProEpoch(value.coordinatorEpoch) ||
      !isValidPeerId(value.coordinatorParticipantId) ||
      typeof value.coordinatorPresenceIncarnationId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value.coordinatorPresenceIncarnationId) ||
      value.developerControlVersion !== DEVELOPER_CONTROL_VERSION
    ) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }
    const frame = normalizeDeveloperInvalidationFrame(value.frame);
    const addition = value.addition === undefined
      ? null
      : normalizeProQueueAdditionFrame(value.addition);
    if (
      !frame ||
      (value.addition !== undefined && !addition) ||
      frame.roomCode !== value.roomCode ||
      frame.coordinatorEpoch !== value.coordinatorEpoch ||
      (addition !== null &&
        (addition.roomCode !== value.roomCode ||
          addition.coordinatorEpoch !== value.coordinatorEpoch ||
          addition.playlistRevision !== frame.playlistRevision))
    ) {
      return json({ error: 'INVALID_REQUEST' }, 400);
    }

    await this.validateRehydratedProSockets();
    const meta = await this.loadProRoomMeta();
    const attachment = readAttachment(this.host);
    if (
      !meta ||
      meta.roomId !== value.roomCode ||
      meta.coordinatorEpoch !== value.coordinatorEpoch ||
      meta.coordinatorParticipantId !== value.coordinatorParticipantId ||
      meta.coordinatorPresenceIncarnationId !== value.coordinatorPresenceIncarnationId ||
      !this.host ||
      attachment?.roomKind !== 'pro' ||
      attachment.role !== 'host' ||
      attachment.roomId !== value.roomCode ||
      attachment.participantId !== value.coordinatorParticipantId ||
      attachment.coordinatorEpoch !== value.coordinatorEpoch ||
      attachment.presenceIncarnationId !== value.coordinatorPresenceIncarnationId ||
      attachment.developerControlVersion < DEVELOPER_CONTROL_VERSION
    ) {
      return json({ error: 'COORDINATOR_UNAVAILABLE' }, 409);
    }
    // The addition is meaningful only after the coordinator has been told to
    // refresh the authoritative snapshot. Never emit it when that first send
    // failed; doing so could create a system row for state the client never
    // accepted.
    if (!sendChecked(this.host, frame)) {
      return json({ error: 'COORDINATOR_UNAVAILABLE' }, 409);
    }
    if (addition !== null && !sendChecked(this.host, addition)) {
      return json({ error: 'COORDINATOR_UNAVAILABLE' }, 409);
    }
    return json({ dispatched: true });
  }

  async resetForProEpoch(ticket) {
    for (const socket of typeof this.state.getWebSockets === 'function'
      ? this.state.getWebSockets()
      : []) {
      closeSocket(socket, 1012, 'PRO_COORDINATOR_EPOCH_ADVANCED');
    }
    this.host = null;
    this.hostPeerId = null;
    this.pendingHosts.clear();
    this.guests.clear();
    this.pendingGuests.clear();
    await this.clearGuestBindings();
    await this.clearRoomMeta();
    await this.scheduleMaintenanceAlarm();
    return this.saveProRoomMeta({
      v: 1,
      kind: 'pro',
      roomId: ticket.roomCode,
      coordinatorEpoch: ticket.coordinatorEpoch,
      coordinatorParticipantId: ticket.participantId,
      coordinatorJti: ticket.jti,
      coordinatorPresenceIncarnationId: ticket.presenceIncarnationId,
      coordinatorTicketSequence: ticket.ticketSequence,
      coordinatorTicketIat: ticket.iat,
    });
  }

  async acceptProCoordinator(ws, ticket) {
    let meta = await this.loadProRoomMeta();
    if (meta && meta.roomId !== ticket.roomCode) {
      this.acceptSocket(ws, null, ['kind:pro', 'role:host', 'rejected:room-mismatch']);
      closeWithError(ws, 'invalid-id', 'PRO_ROOM_MISMATCH', 1008);
      return;
    }
    if (meta && ticket.coordinatorEpoch < meta.coordinatorEpoch) {
      this.acceptSocket(ws, null, ['kind:pro', 'role:host', 'rejected:stale-epoch']);
      closeWithError(ws, 'peer-unavailable', 'PRO_COORDINATOR_EPOCH_STALE', 1008);
      return;
    }

    if (!meta || ticket.coordinatorEpoch > meta.coordinatorEpoch) {
      meta = await this.resetForProEpoch(ticket);
    } else {
      if (meta.coordinatorParticipantId !== ticket.participantId) {
        this.acceptSocket(ws, null, ['kind:pro', 'role:host', 'rejected:coordinator-mismatch']);
        closeWithError(ws, 'id-taken', 'PRO_COORDINATOR_MISMATCH', 1008);
        return;
      }
      if (ticket.ticketSequence <= meta.coordinatorTicketSequence) {
        this.acceptSocket(ws, null, ['kind:pro', 'role:host', 'rejected:ticket-replay']);
        closeWithError(ws, 'peer-unavailable', 'PRO_SIGNALING_TICKET_REPLAYED', 1008);
        return;
      }
      meta = await this.saveProRoomMeta({
        ...meta,
        coordinatorJti: ticket.jti,
        coordinatorPresenceIncarnationId: ticket.presenceIncarnationId,
        coordinatorTicketSequence: ticket.ticketSequence,
        coordinatorTicketIat: ticket.iat,
      });
    }

    if (this.host && this.host !== ws) closeSocket(this.host, 1012, 'HOST_REPLACED');
    const attachment = {
      v: ATTACHMENT_VERSION,
      roomKind: 'pro',
      role: 'host',
      roomId: ticket.roomCode,
      peerId: ticket.roomCode,
      participantId: ticket.participantId,
      coordinatorEpoch: meta.coordinatorEpoch,
      ticketJti: ticket.jti,
      presenceIncarnationId: ticket.presenceIncarnationId,
      ticketSequence: ticket.ticketSequence,
      developerControlVersion: ticket.developerControlVersion,
      auth: 'ok',
    };
    this.acceptSocket(ws, attachment, [
      'kind:pro',
      'role:host',
      `peer:${ticket.roomCode}`,
      `epoch:${meta.coordinatorEpoch}`,
    ]);
    this.host = ws;
    this.hostPeerId = ticket.roomCode;
    this.recordMetric('pro_coordinator_connected');
    send(ws, {
      type: 'peer-open',
      peerId: ticket.roomCode,
      roomId: ticket.roomCode,
      ...workerVersionFields(this.env),
    });
  }

  async acceptProMember(ws, ticket) {
    const meta = await this.loadProRoomMeta();
    const hostAttachment = readAttachment(this.host);
    if (
      !meta ||
      meta.roomId !== ticket.roomCode ||
      meta.coordinatorEpoch !== ticket.coordinatorEpoch
    ) {
      this.acceptSocket(ws, null, ['kind:pro', 'role:guest', 'rejected:stale-epoch']);
      closeWithError(ws, 'peer-unavailable', 'PRO_COORDINATOR_EPOCH_STALE', 1008);
      return;
    }
    if (
      !this.host ||
      hostAttachment?.roomKind !== 'pro' ||
      hostAttachment.coordinatorEpoch !== ticket.coordinatorEpoch
    ) {
      this.acceptSocket(ws, null, ['kind:pro', 'role:guest', 'rejected:no-coordinator']);
      closeWithError(ws, 'peer-unavailable', 'HOST_NOT_AVAILABLE');
      return;
    }

    const admitted = this.admittedGuestIds();
    if (!admitted.has(ticket.participantId) && admitted.size >= MAX_ROOM_GUESTS) {
      this.acceptSocket(ws, null, ['kind:pro', 'role:guest', 'rejected:room-full']);
      closeWithError(ws, 'room-full', 'ROOM_GUEST_LIMIT_REACHED', 1008);
      this.recordMetric('guest_room_full');
      return;
    }

    const previous = this.guests.get(ticket.participantId);
    const previousAttachment = readAttachment(previous);
    if (previous && previous !== ws) closeSocket(previous, 1012, 'GUEST_REPLACED');
    const attachment = {
      v: ATTACHMENT_VERSION,
      roomKind: 'pro',
      role: 'guest',
      roomId: ticket.roomCode,
      peerId: ticket.participantId,
      participantId: ticket.participantId,
      coordinatorEpoch: ticket.coordinatorEpoch,
      ticketJti: ticket.jti,
      presenceIncarnationId: ticket.presenceIncarnationId,
      ticketSequence: ticket.ticketSequence,
      developerControlVersion: ticket.developerControlVersion,
      auth: 'ok',
      ...(Number.isFinite(previousAttachment?.guestMessageTokens) &&
      Number.isFinite(previousAttachment?.guestMessageUpdatedAt)
        ? {
            guestMessageTokens: previousAttachment.guestMessageTokens,
            guestMessageUpdatedAt: previousAttachment.guestMessageUpdatedAt,
          }
        : {}),
    };
    this.acceptSocket(ws, attachment, [
      'kind:pro',
      'role:guest',
      `peer:${ticket.participantId}`,
      `epoch:${ticket.coordinatorEpoch}`,
    ]);
    this.guests.set(ticket.participantId, ws);
    this.recordMetric('pro_member_joined');
    send(ws, {
      type: 'peer-open',
      peerId: ticket.participantId,
      roomId: ticket.roomCode,
      ...workerVersionFields(this.env),
    });
  }

  acceptPendingHost(ws, roomId, peerId) {
    if (!this.reservePendingHostSlot()) {
      this.acceptSocket(ws, null, ['role:host', 'rejected:pending-capacity']);
      closeWithError(ws, 'room-full', 'HOST_PENDING_LIMIT_REACHED', 1008);
      return;
    }

    const attachment = {
      v: ATTACHMENT_VERSION,
      role: 'host',
      roomId,
      peerId,
      auth: 'pending',
      authDeadline: Date.now() + HOST_AUTH_TIMEOUT_MS,
    };
    this.acceptSocket(ws, attachment, ['role:host', `peer:${peerId}`, 'auth:pending']);
    this.pendingHosts.add(ws);
    this.scheduleMaintenanceAlarm();
  }

  reservePendingHostSlot() {
    if (this.pendingHosts.size < MAX_PENDING_HOST_SOCKETS) return true;
    for (const pending of this.pendingHosts) {
      const attachment = readAttachment(pending);
      if (attachment?.auth !== 'pending' || attachment.authStarted) continue;
      this.pendingHosts.delete(pending);
      closeSocket(pending, 1013, 'HOST_AUTH_CANDIDATE_REPLACED');
      this.scheduleMaintenanceAlarm();
      return true;
    }
    return false;
  }

  async acceptHost(ws, roomId, peerId, secret) {
    const accepted = await this.completeHostAccept(ws, roomId, peerId, secret, false);
    if (accepted) this.recordMetric('host_legacy_url_auth');
  }

  async completeHostAccept(ws, roomId, peerId, secret, alreadyAccepted) {
    // The caller owns standardAdmissionSync. Expire the previous epoch in the
    // same queue before reading the ownership snapshot used by this claim.
    const meta = await this.clearExpiredHostRelease();
    if (!secret) {
      if (!alreadyAccepted) this.acceptSocket(ws, null, ['role:host']);
      this.pendingHosts.delete(ws);
      closeWithError(ws, 'invalid-id', 'MISSING_ROOM_SECRET');
      this.scheduleMaintenanceAlarm();
      return false;
    }
    if (meta.roomSecret && meta.roomSecret !== secret) {
      if (!alreadyAccepted) this.acceptSocket(ws, null, ['role:host']);
      this.pendingHosts.delete(ws);
      closeWithError(ws, 'id-taken', 'ROOM_ALREADY_ACTIVE');
      this.scheduleMaintenanceAlarm();
      return false;
    }

    const isNewRoom = !meta.roomSecret;
    if (isNewRoom) await this.clearGuestBindings();
    const attachment = {
      v: ATTACHMENT_VERSION,
      role: 'host',
      roomId,
      peerId,
      secret,
      auth: 'ok',
    };
    // Persist the authenticated owner before replacing the live host. A failed
    // storage write must leave the already-authenticated host untouched.
    await this.saveRoomMeta({
      ...meta,
      roomSecret: secret,
      hostPeerId: peerId,
      hostReleaseAt: 0,
    });
    if (alreadyAccepted) ws.serializeAttachment(attachment);
    else this.acceptSocket(ws, attachment, ['role:host', `peer:${peerId}`]);

    // A socket can close while the Durable Object storage write is awaited.
    // Prove the accepted candidate is still reachable before replacing the
    // live host; otherwise restore the prior metadata inside the same queue.
    if (
      (alreadyAccepted && !this.pendingHosts.has(ws)) ||
      !sendChecked(ws, {
        type: 'peer-open',
        peerId: roomId,
        roomId,
        ...workerVersionFields(this.env),
      })
    ) {
      this.pendingHosts.delete(ws);
      await this.saveRoomMeta(meta);
      closeSocket(ws, 1011, 'HOST_AUTH_SOCKET_CLOSED');
      this.scheduleMaintenanceAlarm();
      return false;
    }

    this.pendingHosts.delete(ws);
    const previous = this.host;
    this.host = ws;
    this.hostPeerId = peerId;
    if (previous && previous !== ws) closeSocket(previous, 1012, 'HOST_REPLACED');
    this.scheduleMaintenanceAlarm();
    this.recordMetric(isNewRoom ? 'room_opened' : 'host_reconnected');
    return true;
  }

  async acceptGuest(ws, roomId, peerId) {
    const meta = await this.loadRoomMeta();
    if (!this.host) {
      this.acceptSocket(ws, null, ['role:guest']);
      this.recordMetric('guest_host_unavailable');
      closeWithError(ws, 'peer-unavailable', 'HOST_NOT_AVAILABLE');
      return;
    }

    const admitted = this.admittedGuestIds();
    if (!admitted.has(peerId) && admitted.size >= MAX_ROOM_GUESTS) {
      this.acceptSocket(ws, null, ['role:guest', 'rejected:room-full']);
      closeWithError(ws, 'room-full', 'ROOM_GUEST_LIMIT_REACHED', 1008);
      this.recordMetric('guest_room_full');
      return;
    }
    if (!this.reservePendingGuestSlot()) {
      this.acceptSocket(ws, null, ['role:guest', 'rejected:pending-capacity']);
      closeWithError(ws, 'room-full', 'ROOM_PENDING_LIMIT_REACHED', 1008);
      this.recordMetric('guest_pending_capacity');
      return;
    }

    // Every guest authenticates its reconnect secret over the WebSocket frame,
    // never in the URL. Current and previous clients already send guest-auth
    // for passwordless rooms, so this adds no user-visible round trip.
    this.acceptPendingGuest(ws, roomId, peerId);
    if (meta.roomPassword) this.recordMetric('guest_auth_pending');
  }

  reservePendingGuestSlot() {
    if (this.pendingGuests.size < MAX_PENDING_GUEST_SOCKETS) return true;

    // Give every new connection one bounded chance to present its first auth
    // frame. Rotate the oldest *silent* candidate, but never a socket whose
    // validated guest-auth frame is already serialized in the admission queue.
    // This keeps the pending set bounded while preventing 99 silent sockets
    // from starving a legitimate join or reconnect for the full 10 seconds.
    for (const pending of this.pendingGuests) {
      const attachment = readAttachment(pending);
      if (attachment?.auth !== 'pending' || attachment.authStarted) continue;
      this.pendingGuests.delete(pending);
      closeSocket(pending, 1013, 'PENDING_GUEST_SLOT_ROTATED');
      this.scheduleMaintenanceAlarm();
      return true;
    }
    return false;
  }

  acceptPendingGuest(ws, roomId, peerId) {
    const attachment = {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId,
      peerId,
      auth: 'pending',
      authDeadline: Date.now() + GUEST_AUTH_TIMEOUT_MS,
    };
    this.acceptSocket(ws, attachment, ['role:guest', `peer:${peerId}`, 'auth:pending']);
    this.pendingGuests.add(ws);
    this.scheduleAuthSweep();
  }

  // Active sweep for unauthenticated pending guests. handleGuestAuth (on a guest
  // message) and indexSocket (on hibernation wake) already close expired pending
  // sockets, but a guest that connects and then stays silent triggers neither —
  // its socket would linger until something else wakes the DO. Schedule a DO
  // alarm at the earliest pending authDeadline so the slot is reclaimed even with
  // no further traffic. The shared scheduler also preserves the host-release
  // deadline because Durable Objects expose one alarm per object.
  scheduleAuthSweep() {
    this.scheduleMaintenanceAlarm();
  }

  async alarm() {
    const now = Date.now();
    await this.enqueueStandardAdmission(async () => {
      for (const sock of [...this.pendingHosts]) {
        const att = readAttachment(sock);
        if (typeof att?.authDeadline === 'number' && now > att.authDeadline) {
          this.pendingHosts.delete(sock);
          closeSocket(sock, 1011, 'host auth timeout (sweep)');
        }
      }
      for (const sock of [...this.pendingGuests]) {
        const att = readAttachment(sock);
        if (typeof att?.authDeadline === 'number' && now > att.authDeadline) {
          this.pendingGuests.delete(sock);
          this.recordMetric('guest_auth_timeout', now);
          try {
            sock.close(1011, 'auth timeout (sweep)');
          } catch {
            /* already closed */
          }
        }
      }
      // The same alarm also expires host metadata after reconnect grace.
      await this.clearExpiredHostRelease();
    });
    await this.scheduleMaintenanceAlarm();
  }

  async completeGuestAccept(ws, roomId, peerId) {
    const previous = this.guests.get(peerId);
    const currentAttachment = readAttachment(ws);
    const previousAttachment = readAttachment(previous);
    const bucketAttachment = Number.isFinite(previousAttachment?.guestMessageTokens)
      ? previousAttachment
      : currentAttachment;
    if (previous && previous !== ws) {
      closeSocket(previous, 1012, 'GUEST_REPLACED');
    }
    for (const pending of [...this.pendingGuests]) {
      if (pending === ws) continue;
      const pendingAttachment = readAttachment(pending);
      if (pendingAttachment?.peerId !== peerId) continue;
      this.pendingGuests.delete(pending);
      closeSocket(pending, 1012, 'GUEST_REPLACED');
    }

    const attachment = {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId,
      peerId,
      auth: 'ok',
      ...(Number.isFinite(bucketAttachment?.guestMessageTokens) &&
      Number.isFinite(bucketAttachment?.guestMessageUpdatedAt)
        ? {
            guestMessageTokens: bucketAttachment.guestMessageTokens,
            guestMessageUpdatedAt: bucketAttachment.guestMessageUpdatedAt,
          }
        : {}),
    };
    ws.serializeAttachment(attachment);

    this.pendingGuests.delete(ws);
    this.guests.set(peerId, ws);
    this.scheduleMaintenanceAlarm();
    this.recordMetric('guest_joined');
    send(ws, {
      type: 'peer-open',
      peerId,
      roomId,
      ...workerVersionFields(this.env),
    });
  }

  async webSocketMessage(ws, raw) {
    const attachment = readAttachment(ws);
    if (!attachment) return;

    const isPendingHost = attachment.role === 'host' && attachment.auth === 'pending';
    const isPendingGuest = attachment.role === 'guest' && attachment.auth === 'pending';

    if (attachment.roomKind === 'pro') {
      const meta = await this.loadProRoomMeta();
      const current =
        meta?.roomId === attachment.roomId &&
        meta.coordinatorEpoch === attachment.coordinatorEpoch &&
        (attachment.role !== 'host' || meta.coordinatorParticipantId === attachment.participantId);
      if (!current) {
        closeSocket(ws, 1012, 'PRO_COORDINATOR_EPOCH_STALE');
        await this.webSocketClose(ws);
        return;
      }
    }

    const rawBytes = rawMessageByteLength(raw);
    if (rawBytes !== null && rawBytes > WS_MESSAGE_MAX_BYTES) {
      closeWithError(ws, 'message-too-large', 'SIGNALING_MESSAGE_TOO_LARGE', 1009);
      await this.webSocketClose(ws);
      this.recordMetric('ws_message_oversized');
      return;
    }

    if (attachment.role === 'guest' && !this.consumeGuestMessageToken(ws)) {
      closeWithError(ws, 'rate-limited', 'SIGNALING_RATE_LIMITED', 1008);
      await this.webSocketClose(ws);
      this.recordMetric('ws_message_rate_limited');
      return;
    }

    // Authentication is a one-frame protocol. Once a validated attempt owns
    // the serialized admission queue, do not parse or enqueue any later frame.
    // Keep this check after the absolute frame-size boundary and guest bucket:
    // in-flight auth must not become a temporary ingress exemption.
    if ((isPendingHost || isPendingGuest) && attachment.authStarted) return;

    const message = this.parse(raw);
    if (!message) {
      if (isPendingHost || isPendingGuest) {
        const reason = isPendingHost
          ? 'HOST_AUTH_FIRST_FRAME_INVALID'
          : 'GUEST_AUTH_FIRST_FRAME_INVALID';
        closeWithError(ws, 'invalid-id', reason, 1008);
        await this.webSocketClose(ws);
      }
      return;
    }
    const role =
      attachment.role === 'host'
        ? attachment.auth === 'pending'
          ? 'host-pending'
          : 'host'
        : attachment.auth === 'pending'
          ? 'pending'
          : 'guest';
    const validation = validateIncomingMessage(message, role);
    if (validation === 'oversized') {
      closeWithError(ws, 'message-too-large', 'SIGNALING_MESSAGE_TOO_LARGE', 1009);
      await this.webSocketClose(ws);
      this.recordMetric('ws_message_oversized');
      return;
    }
    if (validation !== 'valid') {
      if (isPendingHost || isPendingGuest) {
        const reason = isPendingHost
          ? 'HOST_AUTH_FIRST_FRAME_INVALID'
          : 'GUEST_AUTH_FIRST_FRAME_INVALID';
        closeWithError(ws, 'invalid-id', reason, 1008);
        await this.webSocketClose(ws);
      }
      return;
    }

    if (attachment.role === 'host') {
      if (attachment.auth === 'pending') {
        if (!this.pendingHosts.has(ws)) return;
        await this.handleHostAuth(ws, message, attachment);
        return;
      }
      if (attachment.roomKind !== 'pro') await this.loadRoomMeta();
      if (this.host !== ws) return;
      await this.handleHostMessage(ws, message, attachment);
      return;
    }

    if (attachment.auth === 'pending') {
      if (!this.pendingGuests.has(ws)) return;
      await this.handleGuestAuth(ws, message, attachment);
      return;
    }

    if (attachment.roomKind !== 'pro') await this.loadRoomMeta();

    if (this.guests.get(attachment.peerId) !== ws) return;
    this.handleGuestMessage(attachment.peerId, message);
  }

  async handleHostAuth(ws, message, attachment) {
    const currentAttachment = readAttachment(ws) || attachment;
    if (currentAttachment.authStarted) return;
    ws.serializeAttachment({ ...currentAttachment, authStarted: true });
    try {
      return await this.enqueueHostAdmission(() => this.finishHostAuth(ws, message, attachment));
    } catch (error) {
      // A transient storage failure did not consume the one allowed attempt.
      // Reset the marker only if this exact candidate is still pending so a
      // deliberate retry can be accepted without allowing an in-flight queue
      // amplification.
      const latest = readAttachment(ws);
      if (this.pendingHosts.has(ws) && latest?.role === 'host' && latest.auth === 'pending') {
        ws.serializeAttachment({ ...latest, authStarted: false });
      }
      throw error;
    }
  }

  async finishHostAuth(ws, message, attachment) {
    if (!this.pendingHosts.has(ws)) return;
    if (Date.now() > attachment.authDeadline) {
      this.pendingHosts.delete(ws);
      this.scheduleMaintenanceAlarm();
      closeWithError(ws, 'host-auth-timeout', 'HOST_AUTH_TIMEOUT', 1008);
      return;
    }
    await this.completeHostAccept(ws, attachment.roomId, attachment.peerId, message.secret, true);
  }

  async handleGuestAuth(ws, message, attachment) {
    // consumeGuestMessageToken() may have persisted a newer bucket earlier in
    // this event. Merge the marker into that attachment instead of restoring
    // the stale pre-consumption snapshot passed by webSocketMessage().
    const currentAttachment = readAttachment(ws) || attachment;
    if (currentAttachment.authStarted) return;
    ws.serializeAttachment({ ...currentAttachment, authStarted: true });
    try {
      return await this.enqueueGuestAdmission(() => this.finishGuestAuth(ws, message, attachment));
    } catch (error) {
      const latest = readAttachment(ws);
      if (this.pendingGuests.has(ws) && latest?.role === 'guest' && latest.auth === 'pending') {
        ws.serializeAttachment({ ...latest, authStarted: false });
      }
      throw error;
    }
  }

  async finishGuestAuth(ws, message, attachment) {
    if (!this.pendingGuests.has(ws)) return;
    if (!this.host) {
      this.pendingGuests.delete(ws);
      closeWithError(ws, 'peer-unavailable', 'HOST_NOT_AVAILABLE');
      return;
    }
    if (Date.now() > attachment.authDeadline) {
      this.pendingGuests.delete(ws);
      this.scheduleMaintenanceAlarm();
      this.recordMetric('guest_auth_timeout');
      closeWithError(ws, 'room-password-auth-timeout', 'ROOM_PASSWORD_AUTH_TIMEOUT');
      return;
    }

    const meta = await this.loadRoomMeta();
    const password = typeof message.password === 'string' ? message.password : '';
    if (meta.roomPassword && !password) {
      this.pendingGuests.delete(ws);
      this.scheduleMaintenanceAlarm();
      this.recordMetric('guest_auth_failed');
      closeWithError(ws, 'room-password-required', 'ROOM_PASSWORD_REQUIRED');
      return;
    }
    if (meta.roomPassword && password !== meta.roomPassword) {
      this.pendingGuests.delete(ws);
      this.scheduleMaintenanceAlarm();
      this.recordMetric('guest_auth_failed');
      closeWithError(ws, 'room-password-invalid', 'ROOM_PASSWORD_INVALID');
      return;
    }

    // Socket admission and frame authentication are separate events. Recheck
    // the admitted-device ceiling inside the serialized auth queue so a burst
    // of valid pending guests can never race past the 99-guest product limit.
    if (!this.guests.has(attachment.peerId) && this.guests.size >= MAX_ROOM_GUESTS) {
      this.pendingGuests.delete(ws);
      this.scheduleMaintenanceAlarm();
      this.recordMetric('guest_room_full');
      closeWithError(ws, 'room-full', 'ROOM_GUEST_LIMIT_REACHED', 1008);
      return;
    }

    const storedBindings = await this.loadGuestBindings();
    let bindings = this.pruneGuestBindings(storedBindings);
    const existingBinding = bindings.entries.find((entry) => entry.peerId === attachment.peerId);
    const reconnectSecret = isValidGuestReconnectSecret(message.reconnectSecret)
      ? message.reconnectSecret
      : '';
    if (existingBinding) {
      const presentedHash = reconnectSecret ? await hashGuestReconnectSecret(reconnectSecret) : '';
      if (!constantTimeStringEqual(presentedHash, existingBinding.secretHash)) {
        this.pendingGuests.delete(ws);
        this.scheduleMaintenanceAlarm();
        this.recordMetric('guest_reconnect_denied');
        closeWithError(ws, 'guest-reconnect-denied', 'GUEST_RECONNECT_DENIED', 1008);
        return;
      }
      await this.saveGuestBindings({
        ...bindings,
        entries: bindings.entries.map((entry) =>
          entry.peerId === attachment.peerId ? { ...entry, updatedAt: Date.now() } : entry,
        ),
      });
    } else if (this.guests.has(attachment.peerId)) {
      // A rolling-deploy legacy guest has no persisted binding. Do not let a
      // candidate retroactively claim and evict that live ID. Unlike a real
      // secret mismatch, this is transient: the established client should retry
      // after the legacy signaling socket has gone away.
      this.pendingGuests.delete(ws);
      this.scheduleMaintenanceAlarm();
      this.recordMetric('guest_reconnect_conflict');
      closeWithError(ws, 'guest-reconnect-conflict', 'GUEST_RECONNECT_CONFLICT', 1013);
      return;
    } else if (reconnectSecret) {
      if (bindings.entries.length >= MAX_GUEST_BINDINGS) {
        this.pendingGuests.delete(ws);
        this.scheduleMaintenanceAlarm();
        this.recordMetric('guest_identity_capacity');
        closeWithError(ws, 'room-full', 'ROOM_IDENTITY_LIMIT_REACHED', 1008);
        return;
      }
      const secretHash = await hashGuestReconnectSecret(reconnectSecret);
      await this.saveGuestBindings({
        ...bindings,
        entries: [
          ...bindings.entries,
          { peerId: attachment.peerId, secretHash, updatedAt: Date.now() },
        ],
      });
    } else if (bindings.entries.length !== storedBindings.entries.length) {
      await this.saveGuestBindings(bindings);
    }

    await this.completeGuestAccept(ws, attachment.roomId, attachment.peerId);
  }

  handleGuestMessage(peerId, message) {
    if (!this.host) return;
    const { to: _to, ...rest } = message;
    send(this.host, { ...rest, from: peerId });
  }

  async handleHostMessage(ws, message, attachment) {
    if (message.type === 'room-password-set') {
      if (attachment.roomKind === 'pro') return;
      const password = typeof message.password === 'string' ? message.password : '';
      return this.enqueueHostAdmission(async () => {
        if (this.host !== ws) return;
        const meta = await this.loadRoomMeta();
        if (
          this.host !== ws ||
          meta.roomSecret !== attachment.secret ||
          meta.hostPeerId !== attachment.peerId
        ) {
          return;
        }
        await this.saveRoomMeta({
          ...meta,
          roomPassword: /^\d{8}$/.test(password) ? password : '',
        });
      });
    }
    if (this.host !== ws) return;
    const guest = this.guests.get(message.to);
    if (!guest) return;
    const { to: _to, ...rest } = message;
    send(guest, { ...rest, from: attachment.peerId });
  }

  async webSocketClose(ws) {
    const attachment = readAttachment(ws);
    if (!attachment) return;

    if (attachment.role === 'host') {
      if (attachment.roomKind === 'pro') {
        if (this.host === ws) {
          this.host = null;
          this.hostPeerId = null;
        }
        return;
      }
      return this.enqueueHostAdmission(async () => {
        // Re-read after queued authentication: the close event may have
        // captured a pending attachment that was promoted while awaiting this
        // same admission queue.
        const current = readAttachment(ws) || attachment;
        if (current.auth === 'pending') {
          this.pendingHosts.delete(ws);
          await this.scheduleMaintenanceAlarm();
          return;
        }
        await this.releaseHost(ws, current);
      });
    }

    if (attachment.roomKind === 'pro') {
      if (this.guests.get(attachment.peerId) !== ws) return;
      this.guests.delete(attachment.peerId);
      if (this.host) send(this.host, { type: 'peer-left', peerId: attachment.peerId });
      return;
    }

    return this.enqueueGuestAdmission(async () => {
      // A close can arrive while guest-auth is awaiting its reconnect binding.
      // Re-read after that queued admission: if it won, remove the promoted
      // socket; otherwise reclaim only the still-pending slot. This prevents a
      // closed socket from becoming a permanent admitted guest.
      const current = readAttachment(ws) || attachment;
      if (current.auth === 'pending') {
        this.pendingGuests.delete(ws);
        await this.scheduleMaintenanceAlarm();
        return;
      }
      await this.finishRemoveGuest(current.peerId, ws);
    });
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async releaseHost(ws, attachment) {
    // The caller owns standardAdmissionSync. Exact identity prevents a stale
    // close from releasing a replacement host that won while the event waited.
    if (this.host !== ws) return;
    const meta = await this.loadRoomMeta();
    if (
      this.host !== ws ||
      meta.roomSecret !== attachment.secret ||
      meta.hostPeerId !== attachment.peerId
    ) {
      return;
    }

    this.host = null;
    this.hostPeerId = null;
    await this.saveRoomMeta({
      ...meta,
      hostPeerId: null,
      hostReleaseAt: Date.now() + HOST_RECLAIM_GRACE_MS,
    });
    await this.scheduleMaintenanceAlarm();
  }

  removeGuest(peerId, ws) {
    // Serialize close-time binding refreshes with reconnect admissions. A late
    // close from a replaced socket must not overwrite the replacement's newer
    // ownership timestamp or remove its live guest index.
    return this.enqueueGuestAdmission(() => this.finishRemoveGuest(peerId, ws));
  }

  async finishRemoveGuest(peerId, ws) {
    if (this.guests.get(peerId) !== ws) return;
    const bindings = await this.loadGuestBindings();
    if (bindings.entries.some((entry) => entry.peerId === peerId)) {
      await this.saveGuestBindings({
        ...bindings,
        entries: bindings.entries.map((entry) =>
          entry.peerId === peerId ? { ...entry, updatedAt: Date.now() } : entry,
        ),
      });
    }
    this.guests.delete(peerId);
    if (this.host) {
      send(this.host, { type: 'peer-left', peerId });
      return;
    }
    if (this.guests.size === 0) {
      const meta = await this.loadRoomMeta();
      if (this.host) {
        // A host may have reclaimed the room while the metadata read yielded.
        // Treat the departure exactly like a normal hosted guest close instead
        // of clearing the newly reconnected room epoch.
        send(this.host, { type: 'peer-left', peerId });
        return;
      }
      if (meta.hostReleaseAt > Date.now()) {
        // The room epoch still belongs to the disconnected host. Keep both the
        // host secret and guest reconnect ownership until its grace alarm ends.
        await this.scheduleMaintenanceAlarm();
        return;
      }
      await this.clearGuestBindings();
      if (this.host) return;
      await this.clearRoomMeta();
      await this.scheduleMaintenanceAlarm();
    }
  }

  parse(raw) {
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/internal/')) {
      return json({ error: 'NOT_FOUND' }, 404);
    }
    const match = url.pathname.match(ROOM_PATH);
    const proMatch = url.pathname.match(PRO_ROOM_PATH);
    if (!match && !proMatch) {
      return json({
        ok: true,
        service: 'musixquare-signaling',
        websocket: '/api/rooms/:roomId/ws',
        proWebsocket: '/api/pro-rooms/:roomId/ws?ticket=...',
      });
    }

    const upgrade = request.headers.get('Upgrade') || '';
    if (upgrade.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket upgrade required' }, 426);
    }

    if (!isAllowedOrigin(request.headers.get('Origin') || '', env)) {
      return json({ error: 'Forbidden' }, 403);
    }

    const roomId = (match || proMatch)[1];
    if (proMatch) {
      if (!isProNamespaceRoomCode(roomId)) {
        return json({ error: 'PRO_ROOM_NOT_CONFIGURED' }, 404);
      }
      // Do not log `request.url` in this branch: it contains the bearer ticket.
      const ticket = await verifyProSignalingTicket(
        url.searchParams.get('ticket') || '',
        roomId,
        env,
      );
      if (!ticket) return json({ error: 'INVALID_PRO_SIGNALING_TICKET' }, 401);
      if (!(await checkRateLimit(request, 'pro-ws-open'))) {
        return json({ error: 'Too Many Requests' }, 429);
      }
      const id = env.MUSIXQUARE_ROOMS.idFromName(roomId);
      const room = env.MUSIXQUARE_ROOMS.get(id);
      return room.fetch(request);
    }

    const role = url.searchParams.get('role');
    const peerId = url.searchParams.get('peerId');
    const secret = url.searchParams.get('secret') || '';
    if (!roomId || (role !== 'host' && role !== 'guest') || !isValidPeerId(peerId)) {
      return json({ error: 'Bad request' }, 400);
    }
    if (isProNamespaceRoomCode(roomId)) {
      return json({ error: 'ROOM_RESERVED' }, 403);
    }
    if (role === 'host' && secret && !isValidPeerId(secret)) {
      return json({ error: 'Bad request' }, 400);
    }
    if (!(await checkRateLimit(request, 'ws-open'))) {
      return json({ error: 'Too Many Requests' }, 429);
    }

    const id = env.MUSIXQUARE_ROOMS.idFromName(roomId);
    const room = env.MUSIXQUARE_ROOMS.get(id);
    return room.fetch(request);
  },
};
