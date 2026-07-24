/**
 * Private service-binding facade for the MUSIXQUARE Developer API.
 *
 * This Worker has no public route. It is the only Developer API component
 * bound to MusixquareProRoom and accepts one fixed read intent. It never
 * forwards caller headers, cookies, API keys, or caller-selected paths.
 */

import {
  LEGACY_PRO_ROOM_GENERATION,
  isProRoomGeneration,
  proRoomGenerationHeaderValue,
  proRoomObjectName,
} from './pro-room-generation.js';

const PRO_ROOM_GENERATION_HEADER = 'x-mxqr-pro-room-generation';
const REQUEST_MAX_BYTES = 64 * 1024;
// A valid public 128 KiB queue mutation gains a small authenticated envelope.
const QUEUE_MUTATION_REQUEST_MAX_BYTES = 192 * 1024;
// Room and queue projections can legally contain the bounded 1,000-item list.
// PRO room v2 keeps playlist rows outside the 1.2 MiB core record and bounds
// the public queue projection below 3 MiB. Preserve framing headroom while
// allowing the unchanged Developer API contract to read that larger queue.
const PROJECTION_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const COMMAND_RESPONSE_MAX_BYTES = 8 * 1024;
const MUTATION_RESPONSE_MAX_BYTES = 64 * 1024;
const ROOM_CODE_RE = /^0\d{5}$/;
const QUEUE_ITEM_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const QUEUE_ITEM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const API_KEY_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{14,126})[A-Za-z0-9]$/;
const COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{22}$/;
const PLAYBACK_MAX_POSITION_SECONDS = 7 * 24 * 60 * 60;
const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const SHA256_RE = /^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/;
const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS = 5_000;
const QUEUE_ITEM_ADDED_BY_VALUES = new Set(['participant', 'current_api_key', 'another_api_key']);
const PLAYLIST_MAX_ITEMS = 1_000;
const YOUTUBE_BATCH_MAX_ITEMS = 100;
const ASSET_MAX_BYTES = 200 * 1024 * 1024;
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
  INVALID_REQUEST: { error: 'INVALID_REQUEST', status: 400 },
  INVALID_MEDIA: { error: 'INVALID_REQUEST', status: 400 },
  ROOM_NOT_FOUND: { error: 'NOT_FOUND', status: 404 },
  COMMAND_NOT_FOUND: { error: 'NOT_FOUND', status: 404 },
  QUEUE_ITEM_NOT_FOUND: { error: 'NOT_FOUND', status: 404 },
  ASSET_NOT_FOUND: { error: 'NOT_FOUND', status: 404 },
  ROOM_SLEEPING: { error: 'ROOM_SLEEPING', status: 409 },
  COORDINATOR_INCOMPATIBLE: { error: 'COORDINATOR_INCOMPATIBLE', status: 409 },
  NO_MEDIA: { error: 'NO_MEDIA', status: 409 },
  IDEMPOTENCY_CONFLICT: { error: 'IDEMPOTENCY_CONFLICT', status: 409 },
  COMMAND_CAPACITY_EXCEEDED: { error: 'COMMAND_CAPACITY_EXCEEDED', status: 409 },
  PLAYLIST_CAPACITY_EXCEEDED: { error: 'PLAYLIST_CAPACITY_EXCEEDED', status: 409 },
  PLAYLIST_REVISION_CONFLICT: { error: 'PLAYLIST_REVISION_CONFLICT', status: 409 },
  QUEUE_MODE_REVISION_CONFLICT: { error: 'QUEUE_MODE_REVISION_CONFLICT', status: 409 },
  ASSET_CAPACITY_EXCEEDED: { error: 'ASSET_CAPACITY_EXCEEDED', status: 409 },
  RESERVATION_CAPACITY_EXCEEDED: { error: 'RESERVATION_CAPACITY_EXCEEDED', status: 409 },
  ROOM_QUOTA_EXCEEDED: { error: 'ROOM_QUOTA_EXCEEDED', status: 409 },
  UPLOAD_INCOMPLETE: { error: 'UPLOAD_INCOMPLETE', status: 409 },
  UPLOAD_MISMATCH: { error: 'UPLOAD_MISMATCH', status: 409 },
  PLAYBACK_REVISION_EXHAUSTED: { error: 'ROOM_STATE_CAPACITY_EXCEEDED', status: 409 },
  ROOM_STATE_CAPACITY_EXCEEDED: { error: 'ROOM_STATE_CAPACITY_EXCEEDED', status: 409 },
  MEDIA_NOT_CONFIGURED: { error: 'BACKEND_UNAVAILABLE', status: 503 },
  MEDIA_STORAGE_UNAVAILABLE: { error: 'BACKEND_UNAVAILABLE', status: 503 },
  ROOM_STATE_INVALID: { error: 'BACKEND_UNAVAILABLE', status: 503 },
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

function validActorName(value) {
  return (
    boundedString(value, 64) !== null &&
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)
  );
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
  if (value.addedBy !== undefined && !QUEUE_ITEM_ADDED_BY_VALUES.has(value.addedBy)) return null;
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
  if (value.addedBy !== undefined) optional.addedBy = value.addedBy;
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

function sanitizeProjection(value, projection, roomCode, expectedEffectsVersion = 1) {
  if (!value || typeof value !== 'object' || value.roomCode !== roomCode) return null;
  if (
    value.view !== projection ||
    (projection === 'effects'
      ? value.schemaVersion !== expectedEffectsVersion
      : value.schemaVersion !== 1)
  ) {
    return null;
  }
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
  if (projection === 'effects') {
    const effects =
      value.schemaVersion === 2
        ? parseEffectsState(value.effects)
        : parseLegacyEffectsState(value.effects);
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'view',
        'roomCode',
        'revision',
        'updatedAtMs',
        'effects',
      ]) ||
      !isSafeNonNegativeInteger(value.revision) ||
      !isSafeNonNegativeInteger(value.updatedAtMs) ||
      !effects
    ) {
      return null;
    }
    return {
      schemaVersion: value.schemaVersion,
      view: 'effects',
      roomCode,
      revision: value.revision,
      updatedAtMs: value.updatedAtMs,
      effects,
    };
  }
  if (projection === 'queue-mode') {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'view',
        'roomCode',
        'revision',
        'playlistRevision',
        'updatedAtMs',
        'repeatMode',
        'shuffleEnabled',
      ]) ||
      !isSafeNonNegativeInteger(value.revision) ||
      !isSafeNonNegativeInteger(value.playlistRevision) ||
      !isSafeNonNegativeInteger(value.updatedAtMs) ||
      !['off', 'all', 'one'].includes(value.repeatMode) ||
      typeof value.shuffleEnabled !== 'boolean'
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode,
      revision: value.revision,
      playlistRevision: value.playlistRevision,
      updatedAtMs: value.updatedAtMs,
      repeatMode: value.repeatMode,
      shuffleEnabled: value.shuffleEnabled,
    };
  }
  return null;
}

function parseQueueModeUpdate(value) {
  return hasExactKeys(value, ['baseRevision', 'repeatMode', 'shuffleEnabled']) &&
    isSafeNonNegativeInteger(value.baseRevision) &&
    ['off', 'all', 'one'].includes(value.repeatMode) &&
    typeof value.shuffleEnabled === 'boolean'
    ? {
        baseRevision: value.baseRevision,
        repeatMode: value.repeatMode,
        shuffleEnabled: value.shuffleEnabled,
      }
    : null;
}

function parseDeveloperCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type === 'play' || value.type === 'pause' || value.type === 'next') {
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
  if (value.type === 'set_effects') {
    const effects = hasExactKeys(value, ['type', 'effects'])
      ? parseEffectsPatch(value.effects)
      : null;
    return effects ? { type: 'set_effects', effects } : null;
  }
  return null;
}

const EFFECT_REVERB_FIELDS = Object.freeze({
  mixPercent: [0, 100],
  decaySeconds: [0.1, 30],
  preDelaySeconds: [0, 1],
  lowCutPercent: [0, 100],
  highCutPercent: [0, 100],
});

function boundedFiniteNumber(value, minimum, maximum) {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function parseReverbPatch(value, requireComplete = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const allowed = Object.keys(EFFECT_REVERB_FIELDS);
  if (
    keys.length === 0 ||
    keys.some((key) => !allowed.includes(key)) ||
    (requireComplete &&
      (keys.length !== allowed.length || allowed.some((key) => !keys.includes(key))))
  ) {
    return null;
  }
  const parsed = {};
  for (const key of keys) {
    const [minimum, maximum] = EFFECT_REVERB_FIELDS[key];
    if (!boundedFiniteNumber(value[key], minimum, maximum)) return null;
    parsed[key] = value[key];
  }
  return parsed;
}

function parseEqualizer(value) {
  if (
    !hasExactKeys(value, ['bandsDb']) ||
    !Array.isArray(value.bandsDb) ||
    value.bandsDb.length !== 5 ||
    value.bandsDb.some((band) => !boundedFiniteNumber(band, -12, 12))
  ) {
    return null;
  }
  return { bandsDb: [...value.bandsDb] };
}

function parseVirtualBass(value) {
  return hasExactKeys(value, ['strengthPercent']) &&
    boundedFiniteNumber(value.strengthPercent, 0, 100)
    ? { strengthPercent: value.strengthPercent }
    : null;
}

function parseVirtualSurround(value) {
  return hasExactKeys(value, ['widthPercent']) && boundedFiniteNumber(value.widthPercent, 0, 200)
    ? { widthPercent: value.widthPercent }
    : null;
}

function parseVirtualTreble(value) {
  return hasExactKeys(value, ['enabled']) && typeof value.enabled === 'boolean'
    ? { enabled: value.enabled }
    : null;
}

function parseEffects(value, requireComplete) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = ['reverb', 'equalizer', 'virtualBass', 'virtualSurround', 'virtualTreble'];
  const keys = Object.keys(value);
  if (
    keys.length === 0 ||
    keys.some((key) => !allowed.includes(key)) ||
    (requireComplete &&
      (keys.length !== allowed.length || allowed.some((key) => !keys.includes(key))))
  ) {
    return null;
  }
  const effects = {};
  for (const key of keys) {
    const parsed =
      key === 'reverb'
        ? parseReverbPatch(value.reverb, requireComplete)
        : key === 'equalizer'
          ? parseEqualizer(value.equalizer)
          : key === 'virtualBass'
            ? parseVirtualBass(value.virtualBass)
            : key === 'virtualSurround'
              ? parseVirtualSurround(value.virtualSurround)
              : parseVirtualTreble(value.virtualTreble);
    if (!parsed) return null;
    effects[key] = parsed;
  }
  return effects;
}

function parseEffectsPatch(value) {
  return parseEffects(value, false);
}

function parseEffectsState(value) {
  return parseEffects(value, true);
}

function parseLegacyEffectsState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!hasExactKeys(value, ['reverb', 'equalizer', 'virtualBass', 'virtualSurround'])) {
    return null;
  }
  const reverb = parseReverbPatch(value.reverb, true);
  const equalizer = parseEqualizer(value.equalizer);
  const virtualBass = parseVirtualBass(value.virtualBass);
  const virtualSurround = parseVirtualSurround(value.virtualSurround);
  return reverb && equalizer && virtualBass && virtualSurround
    ? { reverb, equalizer, virtualBass, virtualSurround }
    : null;
}

function parseMetadata(value) {
  const name = boundedString(value?.name, 512);
  if (!name) return null;
  const metadata = { name };
  for (const key of ['title', 'artist', 'thumbnail']) {
    if (value[key] === undefined) continue;
    const parsed = boundedString(value[key], 512);
    if (!parsed) return null;
    metadata[key] = parsed;
  }
  return metadata;
}

function parseYouTubeVideoIds(value, playlistId, videoId) {
  if (value === undefined) return undefined;
  if (
    !playlistId ||
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS ||
    value.some((item) => typeof item !== 'string' || !YOUTUBE_VIDEO_ID_RE.test(item)) ||
    !value.includes(videoId)
  ) {
    return null;
  }
  return [...value];
}

function canonicalizeYouTubeBatchItems(items) {
  const result = [];
  const playlistStates = new Map();
  for (const item of items) {
    if (item.playlistId === undefined) {
      result.push(item);
      continue;
    }
    const state = playlistStates.get(item.playlistId);
    if (state === undefined) {
      playlistStates.set(item.playlistId, {
        index: result.length,
        hasManifest: item.videoIds !== undefined,
      });
      result.push(item);
      continue;
    }

    const existing = result[state.index];
    if (state.hasManifest !== (item.videoIds !== undefined)) return null;
    if (state.hasManifest) {
      if (
        existing.videoIds.length !== item.videoIds.length ||
        existing.videoIds.some((videoId, index) => videoId !== item.videoIds[index])
      ) {
        return null;
      }
      continue;
    }

    const videoIds = [...(existing.videoIds || [existing.videoId]), item.videoId];
    if (videoIds.length > YOUTUBE_PLAYLIST_MANIFEST_MAX_ITEMS) return null;
    result[state.index] = { ...existing, videoIds };
  }
  return result;
}

function parseQueueMutation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type === 'clear') {
    return hasExactKeys(value, ['type']) ? { type: 'clear' } : null;
  }
  if (value.type === 'clear_owned') {
    return hasExactKeys(value, ['type']) ? { type: 'clear_owned' } : null;
  }
  if (value.type === 'add_youtube') {
    if (
      !hasExactKeys(
        value,
        ['type', 'videoId', 'name'],
        ['playlistId', 'videoIds', 'title', 'artist', 'thumbnail'],
      ) ||
      !YOUTUBE_VIDEO_ID_RE.test(value.videoId || '') ||
      (value.playlistId !== undefined && !YOUTUBE_PLAYLIST_ID_RE.test(value.playlistId || ''))
    ) {
      return null;
    }
    const videoIds = parseYouTubeVideoIds(value.videoIds, value.playlistId, value.videoId);
    if (videoIds === null) return null;
    const metadata = parseMetadata(value);
    return metadata
      ? {
          type: 'add_youtube',
          videoId: value.videoId,
          ...(value.playlistId === undefined ? {} : { playlistId: value.playlistId }),
          ...(videoIds === undefined ? {} : { videoIds }),
          ...metadata,
        }
      : null;
  }
  if (value.type === 'add_youtube_batch') {
    if (
      !hasExactKeys(value, ['type', 'items']) ||
      !Array.isArray(value.items) ||
      value.items.length === 0 ||
      value.items.length > YOUTUBE_BATCH_MAX_ITEMS
    ) {
      return null;
    }
    const items = value.items.map((item) => {
      if (
        !hasExactKeys(
          item,
          ['videoId', 'name'],
          ['playlistId', 'videoIds', 'title', 'artist', 'thumbnail'],
        ) ||
        !YOUTUBE_VIDEO_ID_RE.test(item.videoId || '') ||
        (item.playlistId !== undefined && !YOUTUBE_PLAYLIST_ID_RE.test(item.playlistId || ''))
      ) {
        return null;
      }
      const videoIds = parseYouTubeVideoIds(item.videoIds, item.playlistId, item.videoId);
      if (videoIds === null) return null;
      const metadata = parseMetadata(item);
      return metadata
        ? {
            videoId: item.videoId,
            ...(item.playlistId === undefined ? {} : { playlistId: item.playlistId }),
            ...(videoIds === undefined ? {} : { videoIds }),
            ...metadata,
          }
        : null;
    });
    if (items.some((item) => item === null)) return null;
    const canonicalItems = canonicalizeYouTubeBatchItems(items);
    return canonicalItems ? { type: 'add_youtube_batch', items: canonicalItems } : null;
  }
  if (value.type === 'remove') {
    return hasExactKeys(value, ['type', 'queueItemId']) &&
      QUEUE_ITEM_UUID_RE.test(value.queueItemId || '')
      ? { type: 'remove', queueItemId: value.queueItemId }
      : null;
  }
  if (value.type === 'reorder') {
    if (
      !hasExactKeys(value, ['type', 'basePlaylistRevision', 'queueItemIds']) ||
      !isSafeNonNegativeInteger(value.basePlaylistRevision) ||
      !Array.isArray(value.queueItemIds) ||
      value.queueItemIds.length > PLAYLIST_MAX_ITEMS ||
      value.queueItemIds.some((queueItemId) => !QUEUE_ITEM_UUID_RE.test(queueItemId || '')) ||
      new Set(value.queueItemIds).size !== value.queueItemIds.length
    ) {
      return null;
    }
    return {
      type: 'reorder',
      basePlaylistRevision: value.basePlaylistRevision,
      queueItemIds: [...value.queueItemIds],
    };
  }
  return null;
}

function parseMediaUpload(value) {
  if (
    !hasExactKeys(
      value,
      ['name', 'byteLength', 'mime'],
      ['sha256', 'title', 'artist', 'thumbnail'],
    ) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > ASSET_MAX_BYTES ||
    !MIME_RE.test(value.mime || '') ||
    (value.sha256 !== undefined && !SHA256_RE.test(value.sha256 || ''))
  ) {
    return null;
  }
  const metadata = parseMetadata(value);
  return metadata
    ? {
        ...metadata,
        byteLength: value.byteLength,
        mime: value.mime,
        ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
      }
    : null;
}

function sanitizeQuota(value) {
  if (
    !value ||
    !['limitBytes', 'perAssetLimitBytes', 'usedBytes', 'reservedBytes'].every((key) =>
      isSafeNonNegativeInteger(value[key]),
    )
  ) {
    return null;
  }
  return {
    limitBytes: value.limitBytes,
    perAssetLimitBytes: value.perAssetLimitBytes,
    usedBytes: value.usedBytes,
    reservedBytes: value.reservedBytes,
  };
}

function sanitizeUpload(value, roomCode, roomGeneration, expectedMedia) {
  const quota = sanitizeQuota(value?.quota);
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'roomCode',
      'assetId',
      'queueItemId',
      'byteLength',
      'uploadExpiresAtMs',
      'completionExpiresAtMs',
      'upload',
      'quota',
    ]) ||
    value.schemaVersion !== 1 ||
    value.roomCode !== roomCode ||
    !ASSET_ID_RE.test(value.assetId || '') ||
    !QUEUE_ITEM_UUID_RE.test(value.queueItemId || '') ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > ASSET_MAX_BYTES ||
    value.byteLength !== expectedMedia.byteLength ||
    !isSafeNonNegativeInteger(value.uploadExpiresAtMs) ||
    !isSafeNonNegativeInteger(value.completionExpiresAtMs) ||
    value.completionExpiresAtMs < value.uploadExpiresAtMs ||
    !quota ||
    !hasExactKeys(value.upload, ['method', 'url', 'headers']) ||
    value.upload.method !== 'PUT'
  ) {
    return null;
  }
  let uploadUrl;
  try {
    uploadUrl = new URL(value.upload.url);
  } catch {
    return null;
  }
  if (
    uploadUrl.protocol !== 'https:' ||
    uploadUrl.username ||
    uploadUrl.password ||
    uploadUrl.hash ||
    !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(uploadUrl.hostname) ||
    !uploadUrl.searchParams.has('X-Amz-Signature')
  ) {
    return null;
  }
  const headers = value.upload.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null;
  const allowedHeaders = new Set([
    'content-length',
    'content-type',
    'x-amz-meta-mxqr-room',
    'x-amz-meta-mxqr-generation',
    'x-amz-meta-mxqr-asset',
    'x-amz-meta-mxqr-version',
    'x-amz-meta-mxqr-bytes',
    'x-amz-meta-mxqr-sha256',
  ]);
  if (
    Object.keys(headers).some((key) => !allowedHeaders.has(key)) ||
    headers['content-length'] !== String(value.byteLength) ||
    headers['x-amz-meta-mxqr-room'] !== roomCode ||
    (roomGeneration === LEGACY_PRO_ROOM_GENERATION
      ? headers['x-amz-meta-mxqr-generation'] !== undefined &&
        headers['x-amz-meta-mxqr-generation'] !== String(LEGACY_PRO_ROOM_GENERATION)
      : headers['x-amz-meta-mxqr-generation'] !== String(roomGeneration)) ||
    headers['x-amz-meta-mxqr-asset'] !== value.assetId ||
    headers['x-amz-meta-mxqr-version'] !== '1' ||
    headers['x-amz-meta-mxqr-bytes'] !== String(value.byteLength) ||
    !MIME_RE.test(headers['content-type'] || '') ||
    headers['content-type'] !== expectedMedia.mime ||
    (headers['x-amz-meta-mxqr-sha256'] !== undefined &&
      !SHA256_RE.test(headers['x-amz-meta-mxqr-sha256'])) ||
    (expectedMedia.sha256 === undefined
      ? headers['x-amz-meta-mxqr-sha256'] !== undefined
      : headers['x-amz-meta-mxqr-sha256'] !== expectedMedia.sha256)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    roomCode,
    assetId: value.assetId,
    queueItemId: value.queueItemId,
    byteLength: value.byteLength,
    uploadExpiresAtMs: value.uploadExpiresAtMs,
    completionExpiresAtMs: value.completionExpiresAtMs,
    upload: { method: 'PUT', url: uploadUrl.toString(), headers: { ...headers } },
    quota,
  };
}

function sanitizeUploadCompletion(value, roomCode, expectedAssetId) {
  const quota = sanitizeQuota(value?.quota);
  const queueItem = sanitizeQueueItem(value?.queueItem);
  if (
    !hasExactKeys(value, [
      'schemaVersion',
      'roomCode',
      'asset',
      'queueItem',
      'playlistRevision',
      'quota',
    ]) ||
    value.schemaVersion !== 1 ||
    value.roomCode !== roomCode ||
    !isSafeNonNegativeInteger(value.playlistRevision) ||
    !quota ||
    !queueItem ||
    queueItem.kind !== 'audio' ||
    !hasExactKeys(value.asset, ['kind', 'assetId', 'version', 'byteLength', 'mime'], ['sha256']) ||
    value.asset.kind !== 'pro-r2' ||
    !ASSET_ID_RE.test(value.asset.assetId || '') ||
    value.asset.assetId !== expectedAssetId ||
    value.asset.version !== 1 ||
    !Number.isSafeInteger(value.asset.byteLength) ||
    value.asset.byteLength <= 0 ||
    value.asset.byteLength > ASSET_MAX_BYTES ||
    value.asset.byteLength !== queueItem.byteLength ||
    !MIME_RE.test(value.asset.mime || '') ||
    (value.asset.sha256 !== undefined && !SHA256_RE.test(value.asset.sha256 || ''))
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    roomCode,
    asset: { ...value.asset },
    queueItem,
    playlistRevision: value.playlistRevision,
    quota,
  };
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

function exactFacadeRoomGeneration(request, body) {
  const hasBodyGeneration = Object.prototype.hasOwnProperty.call(body || {}, 'roomGeneration');
  const header = request.headers.get(PRO_ROOM_GENERATION_HEADER);
  if (!hasBodyGeneration && header === null) {
    return { valid: true, roomGeneration: LEGACY_PRO_ROOM_GENERATION };
  }
  const roomGeneration = body?.roomGeneration;
  return {
    valid:
      hasBodyGeneration &&
      isProRoomGeneration(roomGeneration) &&
      header === proRoomGenerationHeaderValue(roomGeneration),
    roomGeneration,
  };
}

async function callRoom(namespace, roomCode, roomGeneration, path, body) {
  let response;
  try {
    const stub = namespace.get(namespace.idFromName(proRoomObjectName(roomCode, roomGeneration)));
    response = await stub.fetch(
      new Request(`https://pro-room.internal${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mxqr-pro-room-code': roomCode,
          ...(roomGeneration === LEGACY_PRO_ROOM_GENERATION
            ? {}
            : { [PRO_ROOM_GENERATION_HEADER]: proRoomGenerationHeaderValue(roomGeneration) }),
        },
        body: JSON.stringify({
          ...body,
          ...(roomGeneration === LEGACY_PRO_ROOM_GENERATION ? {} : { roomGeneration }),
        }),
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
        '/internal/v1/queue-mode/update',
        '/internal/v1/queue/mutate',
        '/internal/v1/media/uploads/create',
        '/internal/v1/media/uploads/complete',
      ].includes(url.pathname) ||
      url.search ||
      url.hash ||
      request.headers.has('authorization') ||
      request.headers.has('cookie') ||
      request.headers.has('origin')
    ) {
      return jsonResponse({ error: 'NOT_FOUND' }, 404);
    }
    const body = await readJsonBody(
      request,
      url.pathname === '/internal/v1/queue/mutate'
        ? QUEUE_MUTATION_REQUEST_MAX_BYTES
        : REQUEST_MAX_BYTES,
    );
    const namespace = env.PRO_ROOM_DEVELOPER_ROOMS;
    if (!namespace?.idFromName || !namespace?.get) {
      return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
    }
    const generation = exactFacadeRoomGeneration(request, body);
    if (!generation.valid) {
      return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
    }
    const roomGeneration = generation.roomGeneration;

    if (url.pathname === '/internal/v1/read') {
      if (
        !hasExactKeys(
          body,
          ['roomCode', 'projection'],
          ['keyId', 'effectsVersion', 'roomGeneration'],
        ) ||
        !ROOM_CODE_RE.test(body.roomCode) ||
        (body.keyId !== undefined && !API_KEY_ID_RE.test(body.keyId || '')) ||
        (body.effectsVersion !== undefined && ![1, 2].includes(body.effectsVersion)) ||
        (body.projection !== 'effects' && body.effectsVersion !== undefined) ||
        !['room', 'playback', 'queue', 'effects', 'queue-mode'].includes(body.projection)
      ) {
        return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
      }
      const called = await callRoom(
        namespace,
        body.roomCode,
        roomGeneration,
        '/internal/developer/v1/read',
        {
          ...(body.keyId === undefined ? {} : { keyId: body.keyId }),
          ...(body.effectsVersion === 2 ? { effectsVersion: 2 } : {}),
          projection: body.projection,
        },
      );
      if (!called.response) return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      const value = await readJsonResponse(called.response, PROJECTION_RESPONSE_MAX_BYTES);
      if (called.response.status === 404) return jsonResponse({ error: 'NOT_FOUND' }, 404);
      if (!called.response.ok || !value) {
        return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      }
      const sanitized = sanitizeProjection(
        value,
        body.projection,
        body.roomCode,
        body.effectsVersion || 1,
      );
      return sanitized
        ? jsonResponse(sanitized)
        : jsonResponse({ error: 'INVALID_BACKEND_RESPONSE' }, 503);
    }

    if (url.pathname === '/internal/v1/queue-mode/update') {
      if (
        !hasExactKeys(
          body,
          ['keyId', 'roomCode', 'idempotencyKey', 'queueMode'],
          ['roomGeneration'],
        ) ||
        !API_KEY_ID_RE.test(body.keyId || '') ||
        !ROOM_CODE_RE.test(body.roomCode || '') ||
        !IDEMPOTENCY_KEY_RE.test(body.idempotencyKey || '')
      ) {
        return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
      }
      const queueMode = parseQueueModeUpdate(body.queueMode);
      if (!queueMode) return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
      const called = await callRoom(
        namespace,
        body.roomCode,
        roomGeneration,
        '/internal/developer/v1/queue-mode/update',
        {
          roomCode: body.roomCode,
          keyId: body.keyId,
          idempotencyKey: body.idempotencyKey,
          queueMode,
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
      const sanitized = sanitizeProjection(value, 'queue-mode', body.roomCode);
      return called.response.status === 200 && sanitized
        ? jsonResponse(sanitized)
        : jsonResponse({ error: 'INVALID_BACKEND_RESPONSE' }, 503);
    }

    if (url.pathname === '/internal/v1/commands/create') {
      if (
        !hasExactKeys(
          body,
          ['keyId', 'roomCode', 'idempotencyKey', 'command'],
          ['roomGeneration'],
        ) ||
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
        roomGeneration,
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

    if (url.pathname === '/internal/v1/queue/mutate') {
      if (
        !hasExactKeys(
          body,
          ['keyId', 'roomCode', 'idempotencyKey', 'mutation'],
          ['actorName', 'roomGeneration'],
        ) ||
        !API_KEY_ID_RE.test(body.keyId || '') ||
        !ROOM_CODE_RE.test(body.roomCode || '') ||
        !IDEMPOTENCY_KEY_RE.test(body.idempotencyKey || '') ||
        (body.actorName !== undefined && !validActorName(body.actorName))
      ) {
        return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
      }
      const mutation = parseQueueMutation(body.mutation);
      if (!mutation) return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
      const called = await callRoom(
        namespace,
        body.roomCode,
        roomGeneration,
        '/internal/developer/v1/queue/mutate',
        {
          roomCode: body.roomCode,
          keyId: body.keyId,
          ...(body.actorName === undefined ? {} : { actorName: body.actorName }),
          idempotencyKey: body.idempotencyKey,
          mutation,
        },
      );
      if (!called.response) return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      const value = await readJsonResponse(called.response, PROJECTION_RESPONSE_MAX_BYTES);
      if (!called.response.ok) {
        const mapped = backendError(value, called.response.status);
        return mapped
          ? jsonResponse({ error: mapped.error }, mapped.status)
          : jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      }
      const expectedStatus =
        mutation.type === 'add_youtube' || mutation.type === 'add_youtube_batch' ? 201 : 200;
      const sanitized = sanitizeProjection(value, 'queue', body.roomCode);
      return called.response.status === expectedStatus && sanitized
        ? jsonResponse(sanitized, expectedStatus)
        : jsonResponse({ error: 'INVALID_BACKEND_RESPONSE' }, 503);
    }

    if (url.pathname === '/internal/v1/media/uploads/create') {
      if (
        !hasExactKeys(body, ['keyId', 'roomCode', 'idempotencyKey', 'media'], ['roomGeneration']) ||
        !API_KEY_ID_RE.test(body.keyId || '') ||
        !ROOM_CODE_RE.test(body.roomCode || '') ||
        !IDEMPOTENCY_KEY_RE.test(body.idempotencyKey || '')
      ) {
        return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
      }
      const media = parseMediaUpload(body.media);
      if (!media) return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
      const called = await callRoom(
        namespace,
        body.roomCode,
        roomGeneration,
        '/internal/developer/v1/media/uploads/create',
        { roomCode: body.roomCode, keyId: body.keyId, idempotencyKey: body.idempotencyKey, media },
      );
      if (!called.response) return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      const value = await readJsonResponse(called.response, MUTATION_RESPONSE_MAX_BYTES);
      if (!called.response.ok) {
        const mapped = backendError(value, called.response.status);
        return mapped
          ? jsonResponse({ error: mapped.error }, mapped.status)
          : jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      }
      const sanitized = sanitizeUpload(value, body.roomCode, roomGeneration, media);
      return called.response.status === 201 && sanitized
        ? jsonResponse(sanitized, 201)
        : jsonResponse({ error: 'INVALID_BACKEND_RESPONSE' }, 503);
    }

    if (url.pathname === '/internal/v1/media/uploads/complete') {
      if (
        !hasExactKeys(
          body,
          ['keyId', 'roomCode', 'idempotencyKey', 'assetId'],
          ['actorName', 'roomGeneration'],
        ) ||
        !API_KEY_ID_RE.test(body.keyId || '') ||
        !ROOM_CODE_RE.test(body.roomCode || '') ||
        !IDEMPOTENCY_KEY_RE.test(body.idempotencyKey || '') ||
        !ASSET_ID_RE.test(body.assetId || '') ||
        (body.actorName !== undefined && !validActorName(body.actorName))
      ) {
        return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
      }
      const called = await callRoom(
        namespace,
        body.roomCode,
        roomGeneration,
        '/internal/developer/v1/media/uploads/complete',
        {
          roomCode: body.roomCode,
          keyId: body.keyId,
          ...(body.actorName === undefined ? {} : { actorName: body.actorName }),
          idempotencyKey: body.idempotencyKey,
          assetId: body.assetId,
        },
      );
      if (!called.response) return jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      const value = await readJsonResponse(called.response, MUTATION_RESPONSE_MAX_BYTES);
      if (!called.response.ok) {
        const mapped = backendError(value, called.response.status);
        return mapped
          ? jsonResponse({ error: mapped.error }, mapped.status)
          : jsonResponse({ error: 'BACKEND_UNAVAILABLE' }, 503);
      }
      const sanitized = sanitizeUploadCompletion(value, body.roomCode, body.assetId);
      return called.response.status === 201 && sanitized
        ? jsonResponse(sanitized, 201)
        : jsonResponse({ error: 'INVALID_BACKEND_RESPONSE' }, 503);
    }

    if (
      !hasExactKeys(body, ['roomCode', 'keyId', 'commandId'], ['roomGeneration']) ||
      !ROOM_CODE_RE.test(body.roomCode || '') ||
      !API_KEY_ID_RE.test(body.keyId || '') ||
      !COMMAND_ID_RE.test(body.commandId || '')
    ) {
      return jsonResponse({ error: 'INVALID_REQUEST' }, 400);
    }
    const called = await callRoom(
      namespace,
      body.roomCode,
      roomGeneration,
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
