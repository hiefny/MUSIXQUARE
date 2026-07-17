/**
 * Private service-binding facade for the MUSIXQUARE Developer API.
 *
 * This Worker has no public route. It is the only Developer API component
 * bound to MusixquareProRoom and accepts one fixed read intent. It never
 * forwards caller headers, cookies, API keys, or caller-selected paths.
 */

const REQUEST_MAX_BYTES = 1_024;
const RESPONSE_MAX_BYTES = 1_500 * 1024;
const COMMAND_RESPONSE_MAX_BYTES = 8 * 1024;
const ROOM_CODE_RE = /^0\d{5}$/;
const QUEUE_ITEM_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const QUEUE_ITEM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const API_KEY_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
const COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{22}$/;
const PLAYBACK_MAX_POSITION_SECONDS = 7 * 24 * 60 * 60;
const COMMAND_STATUSES = new Set(['pending', 'dispatched', 'applied', 'rejected', 'expired']);
const COMMAND_RESULT_CODES = new Set([
  'applied',
  'already_applied',
  'busy',
  'no_media',
  'stale_queue',
  'unsupported_mode',
  'expired',
  'execution_failed',
  'coordinator_changed',
  'coordinator_incompatible',
  'coordinator_unavailable',
]);
const BACKEND_ERROR_MAP = Object.freeze({
  ROOM_NOT_FOUND: { error: 'NOT_FOUND', status: 404 },
  COMMAND_NOT_FOUND: { error: 'NOT_FOUND', status: 404 },
  QUEUE_ITEM_NOT_FOUND: { error: 'NOT_FOUND', status: 404 },
  ROOM_SLEEPING: { error: 'ROOM_SLEEPING', status: 409 },
  COORDINATOR_INCOMPATIBLE: { error: 'COORDINATOR_INCOMPATIBLE', status: 409 },
  NO_MEDIA: { error: 'NO_MEDIA', status: 409 },
  IDEMPOTENCY_CONFLICT: { error: 'IDEMPOTENCY_CONFLICT', status: 409 },
  COMMAND_CAPACITY_EXCEEDED: { error: 'COMMAND_CAPACITY_EXCEEDED', status: 409 },
});
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
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
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

function parseDeveloperCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type === 'play' || value.type === 'pause') {
    return hasExactKeys(value, ['type']) ? { type: value.type } : null;
  }
  if (value.type === 'seek') {
    return hasExactKeys(value, ['type', 'positionSeconds']) &&
      typeof value.positionSeconds === 'number' &&
      Number.isFinite(value.positionSeconds) &&
      value.positionSeconds >= 0 &&
      value.positionSeconds <= PLAYBACK_MAX_POSITION_SECONDS
      ? { type: 'seek', positionSeconds: value.positionSeconds }
      : null;
  }
  if (value.type === 'play_item') {
    return hasExactKeys(value, ['type', 'queueItemId']) &&
      typeof value.queueItemId === 'string' &&
      QUEUE_ITEM_UUID_RE.test(value.queueItemId)
      ? { type: 'play_item', queueItemId: value.queueItemId }
      : null;
  }
  return null;
}

function sanitizeCommand(value, roomCode) {
  if (
    !value ||
    typeof value !== 'object' ||
    !COMMAND_ID_RE.test(value.commandId || '') ||
    !COMMAND_STATUSES.has(value.status) ||
    !isSafeNonNegativeInteger(value.createdAtMs) ||
    !isSafeNonNegativeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= value.createdAtMs
  ) {
    return null;
  }
  const terminal =
    value.status === 'applied' || value.status === 'rejected' || value.status === 'expired';
  const optional = {};
  if (terminal) {
    if (
      !isSafeNonNegativeInteger(value.completedAtMs) ||
      value.completedAtMs < value.createdAtMs ||
      !COMMAND_RESULT_CODES.has(value.resultCode)
    ) {
      return null;
    }
    if (
      value.status === 'applied' &&
      value.resultCode !== 'applied' &&
      value.resultCode !== 'already_applied'
    ) {
      return null;
    }
    if (value.status === 'expired' && value.resultCode !== 'expired') return null;
    if (
      value.status === 'rejected' &&
      ['applied', 'already_applied', 'expired'].includes(value.resultCode)
    ) {
      return null;
    }
    optional.completedAtMs = value.completedAtMs;
    optional.resultCode = value.resultCode;
  } else if (value.completedAtMs !== undefined || value.resultCode !== undefined) {
    return null;
  }
  return {
    schemaVersion: 1,
    roomCode,
    commandId: value.commandId,
    status: value.status,
    createdAtMs: value.createdAtMs,
    expiresAtMs: value.expiresAtMs,
    ...optional,
  };
}

function backendError(value, status) {
  if (!hasExactKeys(value, ['error']) || typeof value.error !== 'string') return null;
  const mapped = BACKEND_ERROR_MAP[value.error];
  return mapped && mapped.status === status ? mapped : null;
}

async function callRoom(namespace, roomCode, path, body) {
  let response;
  try {
    const stub = namespace.get(namespace.idFromName(roomCode));
    response = await stub.fetch(
      new Request(`https://pro-room.internal${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': roomCode,
        },
        body: JSON.stringify(body),
      }),
    );
  } catch {
    return { backendError: true };
  }
  return { response };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      request.method !== 'POST' ||
      ![
        '/internal/v1/read',
        '/internal/v1/commands/create',
        '/internal/v1/commands/status',
      ].includes(url.pathname) ||
      url.search ||
      url.hash ||
      request.headers.has('authorization') ||
      request.headers.has('cookie') ||
      request.headers.has('origin')
    ) {
      return jsonResponse({ error: 'NOT_FOUND' }, 404);
    }
    const body = await readJsonBody(request, REQUEST_MAX_BYTES);
    const namespace = env.PRO_ROOM_DEVELOPER_ROOMS;
    if (!namespace?.idFromName || !namespace?.get) {
      return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
    }

    if (url.pathname === '/internal/v1/read') {
      if (
        !hasExactKeys(body, ['roomCode', 'projection']) ||
        !ROOM_CODE_RE.test(body.roomCode) ||
        !['room', 'playback', 'queue'].includes(body.projection)
      ) {
        return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
      }
      const called = await callRoom(namespace, body.roomCode, '/internal/developer/v1/read', {
        projection: body.projection,
      });
      if (!called.response) return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      const value = await readJsonResponse(called.response, RESPONSE_MAX_BYTES);
      if (called.response.status === 404) return jsonResponse({ error: 'NOT_FOUND' }, 404);
      if (!called.response.ok || !value) {
        return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      }
      const sanitized = sanitizeProjection(value, body.projection, body.roomCode);
      return sanitized
        ? jsonResponse(sanitized)
        : jsonResponse({ error: 'INVALID_BACKEND_RESPONSE' }, 503);
    }

    if (url.pathname === '/internal/v1/commands/create') {
      if (
        !hasExactKeys(body, ['keyId', 'roomCode', 'idempotencyKey', 'command']) ||
        !API_KEY_ID_RE.test(body.keyId || '') ||
        !ROOM_CODE_RE.test(body.roomCode || '') ||
        !IDEMPOTENCY_KEY_RE.test(body.idempotencyKey || '')
      ) {
        return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
      }
      const command = parseDeveloperCommand(body.command);
      if (!command) return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
      const called = await callRoom(
        namespace,
        body.roomCode,
        '/internal/developer/v1/commands/create',
        {
          roomCode: body.roomCode,
          keyId: body.keyId,
          idempotencyKey: body.idempotencyKey,
          command,
        },
      );
      if (!called.response) return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      const value = await readJsonResponse(called.response, COMMAND_RESPONSE_MAX_BYTES);
      if (!called.response.ok) {
        const mapped = backendError(value, called.response.status);
        return mapped
          ? jsonResponse({ error: mapped.error }, mapped.status)
          : jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      }
      if (called.response.status !== 202) {
        return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      }
      const sanitized = sanitizeCommand(value, body.roomCode);
      // An idempotent retry can arrive after the coordinator already ACKed
      // the first accepted request. Preserve that canonical terminal result
      // instead of turning successful response-loss recovery into a 503.
      return sanitized
        ? jsonResponse(sanitized, 202)
        : jsonResponse({ error: 'INVALID_BACKEND_RESPONSE' }, 503);
    }

    if (
      !hasExactKeys(body, ['roomCode', 'keyId', 'commandId']) ||
      !ROOM_CODE_RE.test(body.roomCode || '') ||
      !API_KEY_ID_RE.test(body.keyId || '') ||
      !COMMAND_ID_RE.test(body.commandId || '')
    ) {
      return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
    }
    const called = await callRoom(
      namespace,
      body.roomCode,
      '/internal/developer/v1/commands/status',
      { roomCode: body.roomCode, keyId: body.keyId, commandId: body.commandId },
    );
    if (!called.response) return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
    const value = await readJsonResponse(called.response, COMMAND_RESPONSE_MAX_BYTES);
    if (!called.response.ok) {
      const mapped = backendError(value, called.response.status);
      return mapped
        ? jsonResponse({ error: mapped.error }, mapped.status)
        : jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
    }
    if (called.response.status !== 200) {
      return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
    }
    const sanitized = sanitizeCommand(value, body.roomCode);
    return sanitized
      ? jsonResponse(sanitized)
      : jsonResponse({ error: 'INVALID_BACKEND_RESPONSE' }, 503);
  },
};
