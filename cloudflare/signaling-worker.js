const ROOM_PATH = /^\/api\/rooms\/(\d{6})\/ws$/;
const HOST_RECLAIM_GRACE_MS = 60_000;
const GUEST_AUTH_TIMEOUT_MS = 10_000;
const ROOM_META_KEY = 'roomMeta';
const ATTACHMENT_VERSION = 1;
const WS_RATE_LIMIT_PER_MINUTE = 120;
const WS_MESSAGE_MAX_BYTES = 64 * 1024;
const SDP_MAX_BYTES = 48 * 1024;
const ICE_CANDIDATE_MAX_BYTES = 4 * 1024;
const MAX_ROOM_GUESTS = 32;
const GUEST_MESSAGE_BUCKET_CAPACITY = 120;
const GUEST_MESSAGE_REFILL_PER_MS = GUEST_MESSAGE_BUCKET_CAPACITY / 60_000;
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

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

  if (role === 'pending') {
    if (message.type !== 'guest-auth') return 'ignore';
    return typeof message.password === 'string' ? 'valid' : 'ignore';
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
    };
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
    this.host = null;
    this.hostPeerId = null;
    this.guests = new Map();
    this.pendingGuests = new Map();
    this.alarmSync = Promise.resolve();
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
    return new Set([...this.guests.keys(), ...this.pendingGuests.keys()]);
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

    // A room epoch ends when the host reclaim grace expires. Any hibernated
    // guest sockets from that epoch must not survive into a new host that later
    // claims the same six-digit room ID.
    for (const socket of new Set([...this.guests.values(), ...this.pendingGuests.values()])) {
      closeSocket(socket, 1012, 'ROOM_EXPIRED');
    }
    this.guests.clear();
    this.pendingGuests.clear();
    return this.clearRoomMeta();
  }

  nextMaintenanceAlarmAt() {
    let earliest = null;
    for (const sock of this.pendingGuests.values()) {
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

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === 'host') {
      await this.acceptHost(server, roomId, peerId, secret);
    } else if (role === 'guest') {
      await this.acceptGuest(server, roomId, peerId);
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
    this.scheduleMaintenanceAlarm();
    this.recordMetric(isNewRoom ? 'room_opened' : 'host_reconnected');
    send(ws, { type: 'peer-open', peerId: roomId, roomId });
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

    if (meta.roomPassword) {
      // Reserve the slot before metrics I/O can yield to another request.
      this.acceptPendingGuest(ws, roomId, peerId);
      this.recordMetric('guest_auth_pending');
      return;
    }

    await this.completeGuestAccept(ws, roomId, peerId, false);
  }

  acceptPendingGuest(ws, roomId, peerId) {
    const previousPending = this.pendingGuests.get(peerId);
    const previousAccepted = this.guests.get(peerId);
    const previousAttachment = readAttachment(previousPending || previousAccepted);
    if (previousPending && previousPending !== ws) {
      closeSocket(previousPending, 1012, 'GUEST_REPLACED');
    }

    const attachment = {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId,
      peerId,
      auth: 'pending',
      authDeadline: Date.now() + GUEST_AUTH_TIMEOUT_MS,
      ...(Number.isFinite(previousAttachment?.guestMessageTokens) &&
      Number.isFinite(previousAttachment?.guestMessageUpdatedAt)
        ? {
            guestMessageTokens: previousAttachment.guestMessageTokens,
            guestMessageUpdatedAt: previousAttachment.guestMessageUpdatedAt,
          }
        : {}),
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
  // no further traffic. The shared scheduler also preserves the host-release
  // deadline because Durable Objects expose one alarm per object.
  scheduleAuthSweep() {
    this.scheduleMaintenanceAlarm();
  }

  async alarm() {
    const now = Date.now();
    for (const [peerId, sock] of [...this.pendingGuests]) {
      const att = readAttachment(sock);
      if (typeof att?.authDeadline === 'number' && now > att.authDeadline) {
        this.pendingGuests.delete(peerId);
        this.recordMetric('guest_auth_timeout', now);
        try {
          sock.close(1011, 'auth timeout (sweep)');
        } catch {
          /* already closed */
        }
      }
    }
    // The same alarm also expires host metadata after reconnect grace.
    await this.loadRoomMeta();
    await this.scheduleMaintenanceAlarm();
  }

  async completeGuestAccept(ws, roomId, peerId, alreadyAccepted) {
    const previous = this.guests.get(peerId);
    const currentAttachment = readAttachment(ws);
    const previousAttachment = readAttachment(previous);
    const bucketAttachment = Number.isFinite(currentAttachment?.guestMessageTokens)
      ? currentAttachment
      : previousAttachment;
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
      auth: 'ok',
      ...(Number.isFinite(bucketAttachment?.guestMessageTokens) &&
      Number.isFinite(bucketAttachment?.guestMessageUpdatedAt)
        ? {
            guestMessageTokens: bucketAttachment.guestMessageTokens,
            guestMessageUpdatedAt: bucketAttachment.guestMessageUpdatedAt,
          }
        : {}),
    };
    if (alreadyAccepted) ws.serializeAttachment(attachment);
    else this.acceptSocket(ws, attachment, ['role:guest', `peer:${peerId}`]);

    this.pendingGuests.delete(peerId);
    this.guests.set(peerId, ws);
    this.scheduleMaintenanceAlarm();
    this.recordMetric('guest_joined');
    send(ws, { type: 'peer-open', peerId, roomId });
  }

  async webSocketMessage(ws, raw) {
    const attachment = readAttachment(ws);
    if (!attachment) return;

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

    const message = this.parse(raw);
    if (!message) return;
    const role =
      attachment.role === 'host' ? 'host' : attachment.auth === 'pending' ? 'pending' : 'guest';
    const validation = validateIncomingMessage(message, role);
    if (validation === 'oversized') {
      closeWithError(ws, 'message-too-large', 'SIGNALING_MESSAGE_TOO_LARGE', 1009);
      await this.webSocketClose(ws);
      this.recordMetric('ws_message_oversized');
      return;
    }
    if (validation !== 'valid') return;

    await this.loadRoomMeta();

    if (attachment.role === 'host') {
      if (this.host !== ws) return;
      await this.handleHostMessage(ws, message, attachment);
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
    if (!this.host) {
      this.pendingGuests.delete(attachment.peerId);
      closeWithError(ws, 'peer-unavailable', 'HOST_NOT_AVAILABLE');
      return;
    }
    if (Date.now() > attachment.authDeadline) {
      this.pendingGuests.delete(attachment.peerId);
      this.scheduleMaintenanceAlarm();
      this.recordMetric('guest_auth_timeout');
      closeWithError(ws, 'room-password-auth-timeout', 'ROOM_PASSWORD_AUTH_TIMEOUT');
      return;
    }

    const meta = await this.loadRoomMeta();
    const password = typeof message.password === 'string' ? message.password : '';
    if (!password) {
      this.pendingGuests.delete(attachment.peerId);
      this.scheduleMaintenanceAlarm();
      this.recordMetric('guest_auth_failed');
      closeWithError(ws, 'room-password-required', 'ROOM_PASSWORD_REQUIRED');
      return;
    }
    if (password !== meta.roomPassword) {
      this.pendingGuests.delete(attachment.peerId);
      this.scheduleMaintenanceAlarm();
      this.recordMetric('guest_auth_failed');
      closeWithError(ws, 'room-password-invalid', 'ROOM_PASSWORD_INVALID');
      return;
    }

    await this.completeGuestAccept(ws, attachment.roomId, attachment.peerId, true);
  }

  handleGuestMessage(peerId, message) {
    if (!this.host) return;
    const { to: _to, ...rest } = message;
    send(this.host, { ...rest, from: peerId });
  }

  async handleHostMessage(ws, message, attachment) {
    if (message.type === 'room-password-set') {
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
      await this.scheduleMaintenanceAlarm();
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
    await this.scheduleMaintenanceAlarm();
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

    if (!(await checkRateLimit(request, 'ws-open'))) {
      return json({ error: 'Too Many Requests' }, 429);
    }

    const id = env.MUSIXQUARE_ROOMS.idFromName(roomId);
    const room = env.MUSIXQUARE_ROOMS.get(id);
    return room.fetch(request);
  },
};
