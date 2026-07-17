/**
 * Private service-binding facade for the MUSIXQUARE Developer API.
 *
 * This Worker has no public route. It is the only Developer API component
 * bound to MusixquareProRoom and accepts one fixed read intent. It never
 * forwards caller headers, cookies, API keys, or caller-selected paths.
 */

const REQUEST_MAX_BYTES = 1_024;
const RESPONSE_MAX_BYTES = 1_500 * 1024;
const ROOM_CODE_RE = /^0\d{5}$/;
const QUEUE_ITEM_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy':
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});
const decoder = new TextDecoder('utf-8', { fatal: true });

function hasExactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
  });
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function boundedString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function boundedMetadataString(value, maxLength) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= maxLength) return value;
  const truncated = value.slice(0, maxLength);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}

async function readJsonBody(request, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    return null;
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
}

async function readJsonResponse(response, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
    return null;
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
}

function sanitizeQueueItem(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.queueItemId !== 'string' ||
    !QUEUE_ITEM_ID_RE.test(value.queueItemId) ||
    (value.kind !== 'youtube' && value.kind !== 'audio') ||
    boundedMetadataString(value.name, 512) === null
  ) {
    return null;
  }
  const optional = {};
  for (const key of ['title', 'artist']) {
    if (value[key] !== undefined) {
      const parsed = boundedMetadataString(value[key], 512);
      if (parsed === null) return null;
      optional[key] = parsed;
    }
  }
  if (value.thumbnail !== undefined) {
    const thumbnail = boundedString(value.thumbnail, 2_048);
    if (thumbnail === null) return null;
    optional.thumbnail = thumbnail;
  }
  if (value.kind === 'audio') {
    if (!Number.isSafeInteger(value.byteLength) || value.byteLength <= 0) return null;
    return {
      queueItemId: value.queueItemId,
      kind: 'audio',
      name: boundedMetadataString(value.name, 512),
      ...optional,
      byteLength: value.byteLength,
    };
  }
  return {
    queueItemId: value.queueItemId,
    kind: 'youtube',
    name: boundedMetadataString(value.name, 512),
    ...optional,
  };
}

function sanitizeProjection(value, projection, roomCode) {
  if (!value || typeof value !== 'object' || value.roomCode !== roomCode) return null;
  if (value.schemaVersion !== 1 || value.view !== projection) return null;
  if (projection === 'room') {
    if (
      !['unactivated', 'active', 'suspended'].includes(value.status) ||
      (value.runtime !== 'awake' && value.runtime !== 'sleeping') ||
      !isSafeNonNegativeInteger(value.revision) ||
      !isSafeNonNegativeInteger(value.participantCount) ||
      typeof value.controlAvailable !== 'boolean' ||
      !value.quota ||
      !['limitBytes', 'perAssetLimitBytes', 'usedBytes', 'reservedBytes'].every((key) =>
        isSafeNonNegativeInteger(value.quota[key]),
      )
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      view: 'room',
      roomCode,
      status: value.status,
      runtime: value.runtime,
      revision: value.revision,
      participantCount: value.participantCount,
      controlAvailable: value.controlAvailable,
      quota: {
        limitBytes: value.quota.limitBytes,
        perAssetLimitBytes: value.quota.perAssetLimitBytes,
        usedBytes: value.quota.usedBytes,
        reservedBytes: value.quota.reservedBytes,
      },
    };
  }
  if (projection === 'playback') {
    const item = value.item === null ? null : sanitizeQueueItem(value.item);
    if (
      !isSafeNonNegativeInteger(value.revision) ||
      !isSafeNonNegativeInteger(value.playlistRevision) ||
      !['idle', 'playing', 'paused'].includes(value.state) ||
      (value.queueItemId !== null &&
        (typeof value.queueItemId !== 'string' || !QUEUE_ITEM_ID_RE.test(value.queueItemId))) ||
      !isFiniteNonNegative(value.positionSeconds) ||
      !isSafeNonNegativeInteger(value.observedAtMs) ||
      (value.item !== null && item === null) ||
      (item === null) !== (value.queueItemId === null) ||
      (item && item.queueItemId !== value.queueItemId) ||
      (value.state === 'idle' &&
        (value.queueItemId !== null || value.item !== null || value.positionSeconds !== 0)) ||
      (value.state !== 'idle' && (value.queueItemId === null || value.item === null))
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      view: 'playback',
      roomCode,
      revision: value.revision,
      playlistRevision: value.playlistRevision,
      state: value.state,
      queueItemId: value.queueItemId,
      positionSeconds: value.positionSeconds,
      observedAtMs: value.observedAtMs,
      item,
    };
  }
  if (projection === 'queue') {
    if (
      !isSafeNonNegativeInteger(value.playlistRevision) ||
      (value.currentQueueItemId !== null &&
        (typeof value.currentQueueItemId !== 'string' ||
          !QUEUE_ITEM_ID_RE.test(value.currentQueueItemId))) ||
      !Array.isArray(value.items) ||
      value.items.length > 1_000
    ) {
      return null;
    }
    const items = value.items.map(sanitizeQueueItem);
    if (
      items.some((item) => item === null) ||
      new Set(items.map((item) => item.queueItemId)).size !== items.length ||
      (value.currentQueueItemId !== null &&
        !items.some((item) => item.queueItemId === value.currentQueueItemId))
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      view: 'queue',
      roomCode,
      playlistRevision: value.playlistRevision,
      currentQueueItemId: value.currentQueueItemId,
      items,
    };
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      request.method !== 'POST' ||
      url.pathname !== '/internal/v1/read' ||
      url.search ||
      url.hash ||
      request.headers.has('authorization') ||
      request.headers.has('cookie') ||
      request.headers.has('origin')
    ) {
      return jsonResponse({ error: 'NOT_FOUND' }, 404);
    }
    const body = await readJsonBody(request, REQUEST_MAX_BYTES);
    if (
      !hasExactKeys(body, ['roomCode', 'projection']) ||
      !ROOM_CODE_RE.test(body.roomCode) ||
      !['room', 'playback', 'queue'].includes(body.projection)
    ) {
      return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
    }
    const namespace = env.PRO_ROOM_DEVELOPER_ROOMS;
    if (!namespace?.idFromName || !namespace?.get) {
      return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
    }
    let response;
    try {
      const stub = namespace.get(namespace.idFromName(body.roomCode));
      response = await stub.fetch(
        new Request('https://pro-room.internal/internal/developer/v1/read', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-mxqr-pro-room-code': body.roomCode,
          },
          body: JSON.stringify({ projection: body.projection }),
        }),
      );
    } catch {
      return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
    }
    const value = await readJsonResponse(response, RESPONSE_MAX_BYTES);
    if (response.status === 404) return jsonResponse({ error: 'NOT_FOUND' }, 404);
    if (!response.ok || !value) return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
    const sanitized = sanitizeProjection(value, body.projection, body.roomCode);
    return sanitized
      ? jsonResponse(sanitized)
      : jsonResponse({ error: 'INVALID_BACKEND_RESPONSE' }, 503);
  },
};
