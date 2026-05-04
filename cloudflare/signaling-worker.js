const ROOM_PATH = /^\/api\/rooms\/([A-Za-z0-9_-]+)\/ws$/;
const HOST_RECLAIM_GRACE_MS = 60_000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
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

export class MusixquareRoom {
  constructor(state) {
    this.state = state;
    this.roomSecret = null;
    this.host = null;
    this.hostPeerId = null;
    this.guests = new Map();
    this.hostReleaseTimer = null;
  }

  async fetch(request) {
    const upgrade = request.headers.get('Upgrade') || '';
    if (upgrade.toLowerCase() !== 'websocket') {
      return json({ ok: true, service: 'musixquare-signaling' });
    }

    const url = new URL(request.url);
    const roomId = url.pathname.match(ROOM_PATH)?.[1];
    const role = url.searchParams.get('role');
    const peerId = url.searchParams.get('peerId');
    const secret = url.searchParams.get('secret') || '';
    if (!roomId || !role || !peerId) return new Response('Bad request', { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (role === 'host') {
      this.acceptHost(server, roomId, peerId, secret);
    } else if (role === 'guest') {
      this.acceptGuest(server, roomId, peerId);
    } else {
      closeWithError(server, 'invalid-id', 'INVALID_ROLE');
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  acceptHost(ws, roomId, peerId, secret) {
    if (!secret) {
      closeWithError(ws, 'invalid-id', 'MISSING_ROOM_SECRET');
      return;
    }
    if (this.roomSecret && this.roomSecret !== secret) {
      closeWithError(ws, 'id-taken', 'ROOM_ALREADY_ACTIVE');
      return;
    }

    if (this.host && this.host !== ws) {
      try {
        this.host.close(1012, 'HOST_REPLACED');
      } catch {
        /* noop */
      }
    }

    this.roomSecret = secret;
    this.host = ws;
    this.hostPeerId = peerId;
    this.clearHostReleaseTimer();
    send(ws, { type: 'peer-open', peerId: roomId, roomId });

    ws.addEventListener('message', (event) => this.handleHostMessage(event.data));
    ws.addEventListener('close', () => {
      if (this.host === ws) this.releaseHostLater();
    });
    ws.addEventListener('error', () => {
      if (this.host === ws) this.releaseHostLater();
    });
  }

  acceptGuest(ws, roomId, peerId) {
    if (!this.host) {
      closeWithError(ws, 'peer-unavailable', 'HOST_NOT_AVAILABLE');
      return;
    }

    const previous = this.guests.get(peerId);
    if (previous && previous !== ws) {
      try {
        previous.close(1012, 'GUEST_REPLACED');
      } catch {
        /* noop */
      }
    }

    this.guests.set(peerId, ws);
    send(ws, { type: 'peer-open', peerId, roomId });

    ws.addEventListener('message', (event) => this.handleGuestMessage(peerId, event.data));
    ws.addEventListener('close', () => this.removeGuest(peerId, ws));
    ws.addEventListener('error', () => this.removeGuest(peerId, ws));
  }

  removeGuest(peerId, ws) {
    if (this.guests.get(peerId) !== ws) return;
    this.guests.delete(peerId);
    if (this.host) send(this.host, { type: 'peer-left', peerId });
    else if (this.guests.size === 0) this.clearRoomSecret();
  }

  releaseHostLater() {
    this.host = null;
    this.hostPeerId = null;
    this.clearHostReleaseTimer();
    this.hostReleaseTimer = setTimeout(() => {
      if (!this.host) this.clearRoomSecret();
    }, HOST_RECLAIM_GRACE_MS);
  }

  clearHostReleaseTimer() {
    if (!this.hostReleaseTimer) return;
    clearTimeout(this.hostReleaseTimer);
    this.hostReleaseTimer = null;
  }

  clearRoomSecret() {
    this.clearHostReleaseTimer();
    this.roomSecret = null;
    this.hostPeerId = null;
  }

  handleGuestMessage(peerId, raw) {
    if (!this.host) return;
    const message = this.parse(raw);
    if (!message) return;
    if (message.to !== 'host') return;
    const { to: _to, ...rest } = message;
    send(this.host, { ...rest, from: peerId });
  }

  handleHostMessage(raw) {
    const message = this.parse(raw);
    if (!message || typeof message.to !== 'string') return;
    const guest = this.guests.get(message.to);
    if (!guest) return;
    const { to: _to, ...rest } = message;
    send(guest, { ...rest, from: this.hostPeerId });
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

    const roomId = match[1];
    const id = env.MUSIXQUARE_ROOMS.idFromName(roomId);
    const room = env.MUSIXQUARE_ROOMS.get(id);
    return room.fetch(request);
  },
};
