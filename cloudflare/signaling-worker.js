const ROOM_PATH = /^\/api\/rooms\/(\d{6})\/ws$/;
const HOST_RECLAIM_GRACE_MS = 60_000;
const GUEST_AUTH_TIMEOUT_MS = 10_000;
const ROOM_META_KEY = 'roomMeta';
const ATTACHMENT_VERSION = 1;
const WS_RATE_LIMIT_PER_MINUTE = 120;
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
  if (!origin) return true;
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

function closeWithError(ws, errorType, message) {
  send(ws, { type: 'error', errorType, message });
  try {
    ws.close(1011, message);
  } catch {
    /* noop */
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

  if (value.auth === 'ok') {
    return {
      v: ATTACHMENT_VERSION,
      role: 'guest',
      roomId: value.roomId,
      peerId: value.peerId,
      auth: 'ok',
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
  constructor(state) {
    this.state = state;
    this.roomMeta = null;
    this.host = null;
    this.hostPeerId = null;
    this.guests = new Map();
    this.pendingGuests = new Map();
    this.rehydrateSockets();
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
      this.guests.set(attachment.peerId, ws);
      return;
    }
    if (attachment.auth === 'pending') {
      // If the DO slept past the pending guest's authDeadline, don't leak
      // the slot — close immediately on hibernation wake so a real guest
      // can take its place. (10차 audit Phase 6 finding.)
      if (
        typeof attachment.authDeadline === 'number' &&
        Date.now() > attachment.authDeadline
      ) {
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
    send(ws, { type: 'peer-open', peerId: roomId, roomId });
  }

  async acceptGuest(ws, roomId, peerId) {
    const meta = await this.loadRoomMeta();
    if (!this.host) {
      this.acceptSocket(ws, null, ['role:guest']);
      closeWithError(ws, 'peer-unavailable', 'HOST_NOT_AVAILABLE');
      return;
    }

    if (meta.roomPassword) {
      this.acceptPendingGuest(ws, roomId, peerId);
      return;
    }

    this.completeGuestAccept(ws, roomId, peerId, false);
  }

  acceptPendingGuest(ws, roomId, peerId) {
    const previousPending = this.pendingGuests.get(peerId);
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
    };
    this.acceptSocket(ws, attachment, ['role:guest', `peer:${peerId}`, 'auth:pending']);
    this.pendingGuests.set(peerId, ws);
  }

  completeGuestAccept(ws, roomId, peerId, alreadyAccepted) {
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
      auth: 'ok',
    };
    if (alreadyAccepted) ws.serializeAttachment(attachment);
    else this.acceptSocket(ws, attachment, ['role:guest', `peer:${peerId}`]);

    this.pendingGuests.delete(peerId);
    this.guests.set(peerId, ws);
    send(ws, { type: 'peer-open', peerId, roomId });
  }

  async webSocketMessage(ws, raw) {
    await this.loadRoomMeta();
    const attachment = readAttachment(ws);
    if (!attachment) return;

    if (attachment.role === 'host') {
      if (this.host !== ws) return;
      await this.handleHostMessage(ws, raw, attachment);
      return;
    }

    if (attachment.auth === 'pending') {
      await this.handleGuestAuth(ws, raw, attachment);
      return;
    }

    if (this.guests.get(attachment.peerId) !== ws) return;
    this.handleGuestMessage(attachment.peerId, raw);
  }

  async handleGuestAuth(ws, raw, attachment) {
    if (!this.host) {
      this.pendingGuests.delete(attachment.peerId);
      closeWithError(ws, 'peer-unavailable', 'HOST_NOT_AVAILABLE');
      return;
    }
    if (Date.now() > attachment.authDeadline) {
      this.pendingGuests.delete(attachment.peerId);
      closeWithError(ws, 'room-password-auth-timeout', 'ROOM_PASSWORD_AUTH_TIMEOUT');
      return;
    }

    const message = this.parse(raw);
    if (!message || message.type !== 'guest-auth') return;

    const meta = await this.loadRoomMeta();
    const password = typeof message.password === 'string' ? message.password : '';
    if (!password) {
      this.pendingGuests.delete(attachment.peerId);
      closeWithError(ws, 'room-password-required', 'ROOM_PASSWORD_REQUIRED');
      return;
    }
    if (password !== meta.roomPassword) {
      this.pendingGuests.delete(attachment.peerId);
      closeWithError(ws, 'room-password-invalid', 'ROOM_PASSWORD_INVALID');
      return;
    }

    this.completeGuestAccept(ws, attachment.roomId, attachment.peerId, true);
  }

  handleGuestMessage(peerId, raw) {
    if (!this.host) return;
    const message = this.parse(raw);
    if (!message) return;
    if (message.to !== 'host') return;
    const { to: _to, ...rest } = message;
    send(this.host, { ...rest, from: peerId });
  }

  async handleHostMessage(ws, raw, attachment) {
    const message = this.parse(raw);
    if (message?.type === 'room-password-set') {
      const password = typeof message.password === 'string' ? message.password : '';
      const meta = await this.loadRoomMeta();
      await this.saveRoomMeta({
        ...meta,
        roomPassword: /^\d{8}$/.test(password) ? password : '',
      });
      return;
    }
    if (!message || typeof message.to !== 'string') return;
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
