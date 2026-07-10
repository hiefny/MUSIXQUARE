const ROOM_PATH = /^\/api\/rooms\/(\d{6})\/ws$/;
const HOST_RECLAIM_GRACE_MS = 60_000;
const GUEST_AUTH_TIMEOUT_MS = 10_000;
const ROOM_META_KEY = 'roomMeta';
const ATTACHMENT_VERSION = 1;
const WS_RATE_LIMIT_PER_MINUTE = 120;
const WS_MESSAGE_MAX_BYTES = 64 * 1024;
const WS_MESSAGE_BUCKET_CAPACITY = 120;
const WS_MESSAGE_REFILL_PER_MS = WS_MESSAGE_BUCKET_CAPACITY / 60_000;
const MAX_ROOM_GUESTS = 32;
// A host multiplexes every admitted peer over one socket. Reserve a complete
// per-target bucket for all 32 peers plus one control bucket so a fair maximum
// room can never trip the aggregate ceiling merely by negotiating together.
const HOST_MESSAGE_BUCKET_CAPACITY = (MAX_ROOM_GUESTS + 1) * WS_MESSAGE_BUCKET_CAPACITY;
const HOST_MESSAGE_REFILL_PER_MS = HOST_MESSAGE_BUCKET_CAPACITY / 60_000;
const SDP_MAX_BYTES = 48 * 1024;
const METADATA_MAX_BYTES = 8 * 1024;
const ICE_CANDIDATE_MAX_BYTES = 4096;
const SMALL_FIELD_MAX_LENGTH = 256;
const GUEST_RECONNECT_SECRET_MIN_LENGTH = 32;
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

function isValidGuestReconnectSecret(secret) {
  return (
    typeof secret === 'string' &&
    secret.length >= GUEST_RECONNECT_SECRET_MIN_LENGTH &&
    secret.length <= 96 &&
    /^[A-Za-z0-9_-]+$/.test(secret)
  );
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function utf8LengthWithin(value, maxBytes) {
  if (typeof value !== 'string' || value.length > maxBytes) return false;
  return new TextEncoder().encode(value).byteLength <= maxBytes;
}

function isValidMetadata(value) {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  try {
    return utf8LengthWithin(JSON.stringify(value), METADATA_MAX_BYTES);
  } catch {
    return false;
  }
}

function isValidSdp(value, expectedType) {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'sdp']) &&
    value.type === expectedType &&
    utf8LengthWithin(value.sdp, SDP_MAX_BYTES)
  );
}

function isOptionalBoundedString(value) {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.length <= SMALL_FIELD_MAX_LENGTH)
  );
}

function isValidCandidate(value) {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'])) {
    return false;
  }
  return (
    utf8LengthWithin(value.candidate, ICE_CANDIDATE_MAX_BYTES) &&
    isOptionalBoundedString(value.sdpMid) &&
    isOptionalBoundedString(value.usernameFragment) &&
    (value.sdpMLineIndex === undefined ||
      value.sdpMLineIndex === null ||
      (Number.isInteger(value.sdpMLineIndex) &&
        value.sdpMLineIndex >= 0 &&
        value.sdpMLineIndex <= 65_535))
  );
}

function isValidGuestTarget(message) {
  return message.to === 'host';
}

function isValidHostTarget(message) {
  return isValidPeerId(message.to);
}

function isValidCallId(value) {
  return isValidPeerId(value);
}

function isValidIncomingMessage(message, role) {
  if (!isRecord(message) || typeof message.type !== 'string' || message.type.length > 32) {
    return false;
  }

  if (role === 'pending') {
    return (
      message.type === 'guest-auth' &&
      hasOnlyKeys(message, ['type', 'password']) &&
      typeof message.password === 'string' &&
      message.password.length <= 8
    );
  }

  if (role === 'guest') {
    if (!isValidGuestTarget(message)) return false;
    if (message.type === 'signal-offer') {
      return (
        hasOnlyKeys(message, ['type', 'to', 'sdp', 'metadata']) &&
        isValidSdp(message.sdp, 'offer') &&
        isValidMetadata(message.metadata)
      );
    }
    if (message.type === 'signal-candidate') {
      return (
        hasOnlyKeys(message, ['type', 'to', 'candidate']) && isValidCandidate(message.candidate)
      );
    }
    if (message.type === 'media-answer') {
      return (
        hasOnlyKeys(message, ['type', 'to', 'callId', 'sdp']) &&
        isValidCallId(message.callId) &&
        isValidSdp(message.sdp, 'answer')
      );
    }
    if (message.type === 'media-close') {
      return hasOnlyKeys(message, ['type', 'to', 'callId']) && isValidCallId(message.callId);
    }
    return false;
  }

  if (role !== 'host') return false;
  if (message.type === 'room-password-set') {
    return (
      hasOnlyKeys(message, ['type', 'password']) &&
      typeof message.password === 'string' &&
      message.password.length <= 8
    );
  }
  if (!isValidHostTarget(message)) return false;
  if (message.type === 'signal-answer') {
    return hasOnlyKeys(message, ['type', 'to', 'sdp']) && isValidSdp(message.sdp, 'answer');
  }
  if (message.type === 'signal-candidate') {
    return hasOnlyKeys(message, ['type', 'to', 'candidate']) && isValidCandidate(message.candidate);
  }
  if (message.type === 'media-offer') {
    return (
      hasOnlyKeys(message, ['type', 'to', 'callId', 'sdp', 'metadata', 'audioTrackCount']) &&
      isValidCallId(message.callId) &&
      isValidSdp(message.sdp, 'offer') &&
      isValidMetadata(message.metadata) &&
      (message.audioTrackCount === undefined ||
        (Number.isInteger(message.audioTrackCount) &&
          message.audioTrackCount >= 1 &&
          message.audioTrackCount <= 8))
    );
  }
  if (message.type === 'media-close') {
    return hasOnlyKeys(message, ['type', 'to', 'callId']) && isValidCallId(message.callId);
  }
  return false;
}

function isAcceptableRawMessage(raw) {
  return typeof raw === 'string' && utf8LengthWithin(raw, WS_MESSAGE_MAX_BYTES);
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

const ATTACHMENT_RATE_BUCKETS = [
  'sourceRate',
  'hostTotalRate',
  'hostControlRate',
  'hostTargetRate',
];

function normalizeAttachmentRateBuckets(value) {
  const result = {};
  for (const prefix of ATTACHMENT_RATE_BUCKETS) {
    const tokens = value[`${prefix}Tokens`];
    const updatedAt = value[`${prefix}UpdatedAt`];
    if (Number.isFinite(tokens) && tokens >= 0 && Number.isFinite(updatedAt) && updatedAt >= 0) {
      result[`${prefix}Tokens`] = tokens;
      result[`${prefix}UpdatedAt`] = updatedAt;
    }
  }
  return result;
}

function normalizeAttachment(value) {
  if (!value || typeof value !== 'object' || value.v !== ATTACHMENT_VERSION) return null;
  if (value.role !== 'host' && value.role !== 'guest') return null;
  if (typeof value.roomId !== 'string' || !value.roomId) return null;
  if (typeof value.peerId !== 'string' || !value.peerId) return null;

  if (value.role === 'host') {
    if (value.auth !== 'ok' || typeof value.secret !== 'string' || !value.secret) return null;
    return {
      v: ATTACHMENT_VERSION,
      role: 'host',
      roomId: value.roomId,
      peerId: value.peerId,
      secret: value.secret,
      auth: 'ok',
      ...normalizeAttachmentRateBuckets(value),
    };
  }

  if (!isValidGuestReconnectSecret(value.secret)) return null;

  if (value.auth === 'ok') {
    return {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId: value.roomId,
      peerId: value.peerId,
      secret: value.secret,
      auth: 'ok',
      ...normalizeAttachmentRateBuckets(value),
    };
  }

  if (value.auth === 'pending') {
    return {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId: value.roomId,
      peerId: value.peerId,
      secret: value.secret,
      auth: 'pending',
      authDeadline: Number.isFinite(value.authDeadline) ? value.authDeadline : 0,
      ...normalizeAttachmentRateBuckets(value),
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
    this.host = null;
    this.hostPeerId = null;
    this.guests = new Map();
    this.pendingGuests = new Map();
    this.socketBuckets = new WeakMap();
    this.hostTotalBuckets = new WeakMap();
    this.hostControlBuckets = new WeakMap();
    this.hostTargetBuckets = new WeakMap();
    this.rehydrateSockets();
  }

  consumeBucket(store, key, capacity, refillPerMs, attachmentPrefix, now = Date.now()) {
    const attachment = readAttachment(key);
    const persistedTokens = attachment?.[`${attachmentPrefix}Tokens`];
    const persistedUpdatedAt = attachment?.[`${attachmentPrefix}UpdatedAt`];
    const previous =
      store.get(key) ||
      (Number.isFinite(persistedTokens) && Number.isFinite(persistedUpdatedAt)
        ? { tokens: persistedTokens, updatedAt: persistedUpdatedAt }
        : { tokens: capacity, updatedAt: now });
    const elapsed = Math.max(0, now - previous.updatedAt);
    const tokens = Math.min(capacity, previous.tokens + elapsed * refillPerMs);
    if (tokens < 1) {
      store.set(key, { tokens, updatedAt: now });
      if (attachment) {
        key.serializeAttachment({
          ...attachment,
          [`${attachmentPrefix}Tokens`]: tokens,
          [`${attachmentPrefix}UpdatedAt`]: now,
        });
      }
      return false;
    }
    const remaining = tokens - 1;
    store.set(key, { tokens: remaining, updatedAt: now });
    if (attachment) {
      key.serializeAttachment({
        ...attachment,
        [`${attachmentPrefix}Tokens`]: remaining,
        [`${attachmentPrefix}UpdatedAt`]: now,
      });
    }
    return true;
  }

  consumeSocketToken(ws, now = Date.now()) {
    return this.consumeBucket(
      this.socketBuckets,
      ws,
      WS_MESSAGE_BUCKET_CAPACITY,
      WS_MESSAGE_REFILL_PER_MS,
      'sourceRate',
      now,
    );
  }

  consumeHostTotalToken(ws, now = Date.now()) {
    return this.consumeBucket(
      this.hostTotalBuckets,
      ws,
      HOST_MESSAGE_BUCKET_CAPACITY,
      HOST_MESSAGE_REFILL_PER_MS,
      'hostTotalRate',
      now,
    );
  }

  consumeHostTargetToken(guest, now = Date.now()) {
    return this.consumeBucket(
      this.hostTargetBuckets,
      guest,
      WS_MESSAGE_BUCKET_CAPACITY,
      WS_MESSAGE_REFILL_PER_MS,
      'hostTargetRate',
      now,
    );
  }

  consumeHostControlToken(ws, now = Date.now()) {
    return this.consumeBucket(
      this.hostControlBuckets,
      ws,
      WS_MESSAGE_BUCKET_CAPACITY,
      WS_MESSAGE_REFILL_PER_MS,
      'hostControlRate',
      now,
    );
  }

  admittedGuestIds() {
    return new Set([...this.guests.keys(), ...this.pendingGuests.keys()]);
  }

  guestIdentityMatches(peerId, secret, excludedSocket = null) {
    for (const socket of [this.guests.get(peerId), this.pendingGuests.get(peerId)]) {
      if (!socket || socket === excludedSocket) continue;
      if (readAttachment(socket)?.secret !== secret) return false;
    }
    return true;
  }

  rejectGuestIdentity(ws) {
    this.acceptSocket(ws, null, ['role:guest', 'rejected:identity-mismatch']);
    closeWithError(ws, 'id-taken', 'GUEST_IDENTITY_MISMATCH', 1008);
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
      this.host = ws;
      this.hostPeerId = attachment.peerId;
      return;
    }
    if (attachment.auth === 'ok') {
      if (!this.guestIdentityMatches(attachment.peerId, attachment.secret, ws)) {
        closeWithError(ws, 'id-taken', 'GUEST_IDENTITY_MISMATCH', 1008);
        return;
      }
      const admitted = this.admittedGuestIds();
      if (!admitted.has(attachment.peerId) && admitted.size >= MAX_ROOM_GUESTS) {
        closeWithError(ws, 'room-full', 'ROOM_GUEST_LIMIT_REACHED', 1008);
        return;
      }
      const previous = this.guests.get(attachment.peerId);
      if (previous && previous !== ws) closeSocket(previous, 1012, 'GUEST_REPLACED');
      const previousPending = this.pendingGuests.get(attachment.peerId);
      if (previousPending && previousPending !== ws) {
        closeSocket(previousPending, 1012, 'GUEST_REPLACED');
        this.pendingGuests.delete(attachment.peerId);
      }
      this.guests.set(attachment.peerId, ws);
      return;
    }
    if (attachment.auth === 'pending') {
      // If the DO slept past the pending guest's authDeadline, don't leak
      // the slot — close immediately on hibernation wake so a real guest
      // can take its place. (10차 audit Phase 6 finding.)
      if (typeof attachment.authDeadline === 'number' && Date.now() > attachment.authDeadline) {
        try {
          ws.close(1011, 'auth timeout (hibernation)');
        } catch {
          /* ignore */
        }
        return;
      }
      if (!this.guestIdentityMatches(attachment.peerId, attachment.secret, ws)) {
        closeWithError(ws, 'id-taken', 'GUEST_IDENTITY_MISMATCH', 1008);
        return;
      }
      const admitted = this.admittedGuestIds();
      if (!admitted.has(attachment.peerId) && admitted.size >= MAX_ROOM_GUESTS) {
        closeWithError(ws, 'room-full', 'ROOM_GUEST_LIMIT_REACHED', 1008);
        return;
      }
      const previous = this.pendingGuests.get(attachment.peerId);
      if (previous && previous !== ws) closeSocket(previous, 1012, 'GUEST_REPLACED');
      this.pendingGuests.set(attachment.peerId, ws);
    }
  }

  async loadRoomMeta() {
    if (!this.roomMeta) {
      const stored = await this.state.storage.get(ROOM_META_KEY);
      this.roomMeta = normalizeRoomMeta(stored);
    }
    await this.clearExpiredHostRelease();
    return this.roomMeta;
  }

  async saveRoomMeta(meta) {
    this.roomMeta = normalizeRoomMeta(meta);
    await this.state.storage.put(ROOM_META_KEY, this.roomMeta);
    return this.roomMeta;
  }

  async clearRoomMeta() {
    return this.saveRoomMeta(defaultRoomMeta());
  }

  async clearExpiredHostRelease() {
    const meta = this.roomMeta || defaultRoomMeta();
    if (this.host || !meta.hostReleaseAt || meta.hostReleaseAt > Date.now()) return meta;
    return this.clearRoomMeta();
  }

  acceptSocket(ws, attachment, tags) {
    this.state.acceptWebSocket(ws, tags);
    if (attachment) ws.serializeAttachment(attachment);
  }

  async fetch(request) {
    const upgrade = request.headers.get('Upgrade') || '';
    if (upgrade.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket upgrade required' }, 426);
    }

    const url = new URL(request.url);
    const roomId = url.pathname.match(ROOM_PATH)?.[1];
    const role = url.searchParams.get('role');
    const peerId = url.searchParams.get('peerId');
    const secret = url.searchParams.get('secret') || '';
    if (!roomId || (role !== 'host' && role !== 'guest') || !isValidPeerId(peerId)) {
      return json({ error: 'Bad request' }, 400);
    }
    if (role === 'host' && !isValidPeerId(secret)) {
      return json({ error: 'Bad request' }, 400);
    }
    if (role === 'guest' && !isValidGuestReconnectSecret(secret)) {
      return json({ error: 'Bad request' }, 400);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'host') {
      await this.acceptHost(server, roomId, peerId, secret);
    } else if (role === 'guest') {
      await this.acceptGuest(server, roomId, peerId, secret);
    } else {
      this.acceptSocket(server, null, ['role:invalid']);
      closeWithError(server, 'invalid-id', 'INVALID_ROLE');
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async acceptHost(ws, roomId, peerId, secret) {
    const meta = await this.loadRoomMeta();
    if (!secret) {
      this.acceptSocket(ws, null, ['role:host']);
      closeWithError(ws, 'invalid-id', 'MISSING_ROOM_SECRET');
      return;
    }
    if (meta.roomSecret && meta.roomSecret !== secret) {
      this.acceptSocket(ws, null, ['role:host']);
      closeWithError(ws, 'id-taken', 'ROOM_ALREADY_ACTIVE');
      return;
    }

    const isNewRoom = !meta.roomSecret;
    if (this.host && this.host !== ws) {
      closeSocket(this.host, 1012, 'HOST_REPLACED');
    }

    const attachment = {
      v: ATTACHMENT_VERSION,
      role: 'host',
      roomId,
      peerId,
      secret,
      auth: 'ok',
    };
    this.acceptSocket(ws, attachment, ['role:host', `peer:${peerId}`]);
    this.host = ws;
    this.hostPeerId = peerId;
    await this.saveRoomMeta({
      ...meta,
      roomSecret: secret,
      hostPeerId: peerId,
      hostReleaseAt: 0,
    });
    await recordMetric(this.env, isNewRoom ? 'room_opened' : 'host_reconnected');
    send(ws, { type: 'peer-open', peerId: roomId, roomId });
  }

  async acceptGuest(ws, roomId, peerId, secret) {
    const meta = await this.loadRoomMeta();
    if (!this.host) {
      this.acceptSocket(ws, null, ['role:guest']);
      await recordMetric(this.env, 'guest_host_unavailable');
      closeWithError(ws, 'peer-unavailable', 'HOST_NOT_AVAILABLE');
      return;
    }

    if (!this.guestIdentityMatches(peerId, secret)) {
      this.rejectGuestIdentity(ws);
      await recordMetric(this.env, 'guest_identity_rejected');
      return;
    }

    const admittedGuestIds = this.admittedGuestIds();
    if (!admittedGuestIds.has(peerId) && admittedGuestIds.size >= MAX_ROOM_GUESTS) {
      this.acceptSocket(ws, null, ['role:guest', 'rejected:room-full']);
      closeWithError(ws, 'room-full', 'ROOM_GUEST_LIMIT_REACHED', 1008);
      await recordMetric(this.env, 'guest_room_full');
      return;
    }

    if (meta.roomPassword) {
      // Reserve the unique peer slot before yielding to metrics I/O. Durable
      // Object requests can interleave at awaits, so recording first allowed
      // concurrent password joins to all pass the same capacity snapshot.
      this.acceptPendingGuest(ws, roomId, peerId, secret);
      await recordMetric(this.env, 'guest_auth_pending');
      return;
    }

    await this.completeGuestAccept(ws, roomId, peerId, secret, false);
  }

  acceptPendingGuest(ws, roomId, peerId, secret) {
    const previousPending = this.pendingGuests.get(peerId);
    if (previousPending && previousPending !== ws) {
      closeSocket(previousPending, 1012, 'GUEST_REPLACED');
    }

    const attachment = {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId,
      peerId,
      secret,
      auth: 'pending',
      authDeadline: Date.now() + GUEST_AUTH_TIMEOUT_MS,
    };
    this.acceptSocket(ws, attachment, ['role:guest', `peer:${peerId}`, 'auth:pending']);
    this.pendingGuests.set(peerId, ws);
    this.scheduleAuthSweep();
  }

  // Active sweep for unauthenticated pending guests. handleGuestAuth (on a guest
  // message) and indexSocket (on hibernation wake) already close expired pending
  // sockets, but a guest that connects and then stays silent triggers neither —
  // its socket would linger until something else wakes the DO. Schedule a DO
  // alarm at the earliest pending authDeadline so the slot is reclaimed even with
  // no further traffic. (setAlarm overwrites; we re-arm after each sweep.)
  scheduleAuthSweep() {
    let earliest = null;
    for (const sock of this.pendingGuests.values()) {
      const att = readAttachment(sock);
      if (
        typeof att?.authDeadline === 'number' &&
        (earliest === null || att.authDeadline < earliest)
      ) {
        earliest = att.authDeadline;
      }
    }
    if (earliest !== null) {
      // Fire just after the deadline so it has definitely elapsed on wake.
      Promise.resolve(this.state.storage.setAlarm(earliest + 1000)).catch(() => {});
    }
  }

  async alarm() {
    const now = Date.now();
    for (const [peerId, sock] of [...this.pendingGuests]) {
      const att = readAttachment(sock);
      if (typeof att?.authDeadline === 'number' && now > att.authDeadline) {
        this.pendingGuests.delete(peerId);
        await recordMetric(this.env, 'guest_auth_timeout');
        try {
          sock.close(1011, 'auth timeout (sweep)');
        } catch {
          /* already closed */
        }
      }
    }
    // Re-arm for any guests still inside their auth window.
    this.scheduleAuthSweep();
  }

  async completeGuestAccept(ws, roomId, peerId, secret, alreadyAccepted) {
    if (!this.guestIdentityMatches(peerId, secret, ws)) {
      if (!alreadyAccepted) this.rejectGuestIdentity(ws);
      else closeWithError(ws, 'id-taken', 'GUEST_IDENTITY_MISMATCH', 1008);
      await recordMetric(this.env, 'guest_identity_rejected');
      return;
    }
    const previous = this.guests.get(peerId);
    if (previous && previous !== ws) {
      closeSocket(previous, 1012, 'GUEST_REPLACED');
    }
    const previousPending = this.pendingGuests.get(peerId);
    if (previousPending && previousPending !== ws) {
      closeSocket(previousPending, 1012, 'GUEST_REPLACED');
    }

    const attachment = {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId,
      peerId,
      secret,
      auth: 'ok',
    };
    if (alreadyAccepted) ws.serializeAttachment(attachment);
    else this.acceptSocket(ws, attachment, ['role:guest', `peer:${peerId}`]);

    this.pendingGuests.delete(peerId);
    this.guests.set(peerId, ws);
    await recordMetric(this.env, 'guest_joined');
    send(ws, { type: 'peer-open', peerId, roomId });
  }

  async webSocketMessage(ws, raw) {
    const attachment = readAttachment(ws);
    if (!attachment) return;

    if (!isAcceptableRawMessage(raw)) {
      await recordMetric(this.env, 'ws_message_oversized');
      closeWithError(ws, 'message-too-large', 'SIGNALING_MESSAGE_TOO_LARGE', 1009);
      await this.webSocketClose(ws);
      return;
    }
    const messageRole =
      attachment.role === 'host' ? 'host' : attachment.auth === 'pending' ? 'pending' : 'guest';
    const message = this.parse(raw, messageRole);
    if (!message) {
      await recordMetric(this.env, 'ws_message_invalid');
      closeWithError(ws, 'invalid-message', 'INVALID_SIGNALING_MESSAGE', 1008);
      await this.webSocketClose(ws);
      return;
    }

    await this.loadRoomMeta();

    if (attachment.role === 'host') {
      if (this.host !== ws) return;
      await this.handleHostMessage(ws, message, attachment);
      return;
    }

    // Guests each own a socket, so exceeding this bucket identifies the
    // sender precisely. Host traffic is multiplexed and is limited separately
    // by total + target below; closing the host would let one abusive joiner
    // disconnect signaling for every healthy peer.
    if (!this.consumeSocketToken(ws)) {
      closeWithError(ws, 'rate-limited', 'SIGNALING_RATE_LIMITED', 1008);
      await this.webSocketClose(ws);
      await recordMetric(this.env, 'ws_message_rate_limited');
      return;
    }

    if (attachment.auth === 'pending') {
      if (this.pendingGuests.get(attachment.peerId) !== ws) return;
      await this.handleGuestAuth(ws, message, attachment);
      return;
    }

    if (this.guests.get(attachment.peerId) !== ws) return;
    this.handleGuestMessage(attachment.peerId, message);
  }

  async handleGuestAuth(ws, message, attachment) {
    if (this.pendingGuests.get(attachment.peerId) !== ws) return;
    if (!this.host) {
      if (this.pendingGuests.get(attachment.peerId) === ws) {
        this.pendingGuests.delete(attachment.peerId);
      }
      closeWithError(ws, 'peer-unavailable', 'HOST_NOT_AVAILABLE');
      return;
    }
    if (Date.now() > attachment.authDeadline) {
      if (this.pendingGuests.get(attachment.peerId) === ws) {
        this.pendingGuests.delete(attachment.peerId);
      }
      await recordMetric(this.env, 'guest_auth_timeout');
      closeWithError(ws, 'room-password-auth-timeout', 'ROOM_PASSWORD_AUTH_TIMEOUT');
      return;
    }

    const meta = await this.loadRoomMeta();
    if (this.pendingGuests.get(attachment.peerId) !== ws) return;
    const password = typeof message.password === 'string' ? message.password : '';
    if (!password) {
      this.pendingGuests.delete(attachment.peerId);
      await recordMetric(this.env, 'guest_auth_failed');
      closeWithError(ws, 'room-password-required', 'ROOM_PASSWORD_REQUIRED');
      return;
    }
    if (password !== meta.roomPassword) {
      this.pendingGuests.delete(attachment.peerId);
      await recordMetric(this.env, 'guest_auth_failed');
      closeWithError(ws, 'room-password-invalid', 'ROOM_PASSWORD_INVALID');
      return;
    }

    await this.completeGuestAccept(
      ws,
      attachment.roomId,
      attachment.peerId,
      attachment.secret,
      true,
    );
  }

  handleGuestMessage(peerId, message) {
    if (!this.host) return;
    const { to: _to, ...rest } = message;
    send(this.host, { ...rest, from: peerId });
  }

  async handleHostMessage(ws, message, attachment) {
    if (!this.consumeHostTotalToken(ws)) {
      if (typeof message.to === 'string') {
        const guest = this.guests.get(message.to);
        if (guest) {
          closeWithError(guest, 'rate-limited', 'SIGNALING_PEER_RATE_LIMITED', 1008);
          await this.removeGuest(message.to, guest);
        }
      }
      await recordMetric(this.env, 'ws_host_total_rate_limited');
      return;
    }

    if (message.type === 'room-password-set') {
      if (!this.consumeHostControlToken(ws)) {
        await recordMetric(this.env, 'ws_host_control_rate_limited');
        return;
      }
      const password = typeof message.password === 'string' ? message.password : '';
      const meta = await this.loadRoomMeta();
      await this.saveRoomMeta({
        ...meta,
        roomPassword: /^\d{8}$/.test(password) ? password : '',
      });
      return;
    }
    if (this.host !== ws) return;
    const guest = this.guests.get(message.to);
    if (!guest) return;
    if (!this.consumeHostTargetToken(guest)) {
      closeWithError(guest, 'rate-limited', 'SIGNALING_PEER_RATE_LIMITED', 1008);
      await this.removeGuest(message.to, guest);
      await recordMetric(this.env, 'ws_host_target_rate_limited');
      return;
    }
    const { to: _to, ...rest } = message;
    send(guest, { ...rest, from: attachment.peerId });
  }

  async webSocketClose(ws) {
    const attachment = readAttachment(ws);
    if (!attachment) return;

    if (attachment.role === 'host') {
      await this.releaseHost(ws, attachment);
      return;
    }

    if (attachment.auth === 'pending') {
      if (this.pendingGuests.get(attachment.peerId) === ws) {
        this.pendingGuests.delete(attachment.peerId);
      }
      return;
    }

    await this.removeGuest(attachment.peerId, ws);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async releaseHost(ws, attachment) {
    if (this.host && this.host !== ws) return;
    const meta = await this.loadRoomMeta();
    if (meta.roomSecret !== attachment.secret || meta.hostPeerId !== attachment.peerId) return;

    this.host = null;
    this.hostPeerId = null;
    await this.saveRoomMeta({
      ...meta,
      hostPeerId: null,
      hostReleaseAt: Date.now() + HOST_RECLAIM_GRACE_MS,
    });
  }

  async removeGuest(peerId, ws) {
    if (this.guests.get(peerId) !== ws) return;
    this.guests.delete(peerId);
    if (this.host) {
      send(this.host, { type: 'peer-left', peerId });
      return;
    }
    if (this.guests.size === 0) {
      await this.clearRoomMeta();
    }
  }

  parse(raw, role) {
    if (typeof raw !== 'string') return null;
    try {
      const message = JSON.parse(raw);
      return isValidIncomingMessage(message, role) ? message : null;
    } catch {
      return null;
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(ROOM_PATH);
    if (!match) {
      return json({
        ok: true,
        service: 'musixquare-signaling',
        websocket: '/api/rooms/:roomId/ws',
      });
    }

    const upgrade = request.headers.get('Upgrade') || '';
    if (upgrade.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket upgrade required' }, 426);
    }

    if (!isAllowedOrigin(request.headers.get('Origin') || '', env)) {
      return json({ error: 'Forbidden' }, 403);
    }

    const role = url.searchParams.get('role');
    const peerId = url.searchParams.get('peerId');
    const secret = url.searchParams.get('secret') || '';
    const roomId = match[1];
    if (!roomId || (role !== 'host' && role !== 'guest') || !isValidPeerId(peerId)) {
      return json({ error: 'Bad request' }, 400);
    }
    if (role === 'host' && !isValidPeerId(secret)) {
      return json({ error: 'Bad request' }, 400);
    }
    if (role === 'guest' && !isValidGuestReconnectSecret(secret)) {
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
