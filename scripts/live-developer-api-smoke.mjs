#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_ORIGIN = 'https://api.musixquare.com';
// Cloudflare can report a 100% deployment before every custom-domain edge
// serves that version. Keep the exact version fence, but use the same bounded
// convergence window as the PRO Worker smoke instead of rolling back healthy
// code after only fifteen seconds.
export const DEVELOPER_API_READINESS_RETRY_DELAYS_MS = Object.freeze([
  0, 1_000, 2_000, 4_000, 8_000, 15_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000,
]);
// The exact API version can become healthy before its Worker-to-Worker and
// Durable Object dependencies converge at the edge. Only the first read-only
// canary request receives this narrower retry window; mutations are never
// replayed by the smoke runner.
export const DEVELOPER_API_CANARY_RETRY_DELAYS_MS = Object.freeze([
  0, 1_000, 2_000, 4_000, 8_000, 15_000, 20_000,
]);
const REQUEST_TIMEOUT_MS = 30_000;
const DEVELOPER_API_CANARY_CONVERGENCE_CODES = new Set([
  'API_NOT_CONFIGURED',
  'BACKEND_UNAVAILABLE',
]);
const DEVELOPER_API_REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{22}$/;
const DEVELOPER_API_VERSION_HEADER = 'x-mxqr-developer-api-version';
const DEVELOPER_API_FACADE_VERSION_HEADER = 'x-mxqr-developer-api-facade-version';
const CANARY_INITIAL_REQUEST_TIMEOUT_MS = 10_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fetchWithTimeout(input, init = {}) {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function idempotencyKey(operation) {
  return `smoke.${operation}.${crypto.randomUUID()}`;
}

function authorizationHeaders(apiKey, extra = {}) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  };
}

async function apiJson(path, apiKey, init = {}, expectedStatus = 200) {
  const response = await fetchWithTimeout(`${API_ORIGIN}${path}`, {
    cache: 'no-store',
    ...init,
    headers: authorizationHeaders(apiKey, init.headers),
  });
  const payload = await readJson(response, `Developer API ${path}`);
  if (response.status !== expectedStatus) {
    const code = payload?.error?.code || '<missing>';
    throw new Error(`Developer API ${path} returned HTTP ${response.status} (${code})`);
  }
  return { response, payload };
}

function jsonWrite(method, apiKey, operation, body) {
  return {
    method,
    headers: authorizationHeaders(apiKey, {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey(operation),
    }),
    body: JSON.stringify(body),
  };
}

function emptyWrite(method, apiKey, operation) {
  return {
    method,
    headers: authorizationHeaders(apiKey, {
      'Idempotency-Key': idempotencyKey(operation),
    }),
  };
}

function smokeWav() {
  // 46-byte PCM WAV: mono, 8 kHz, 16-bit, one silent sample.
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x26, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
    0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00,
    0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

function assertQueueProjection(payload, roomCode, label) {
  if (
    payload?.schemaVersion !== 1 ||
    payload?.view !== 'queue' ||
    payload?.roomCode !== roomCode ||
    !Number.isSafeInteger(payload?.playlistRevision) ||
    !Array.isArray(payload?.items)
  ) {
    throw new Error(`${label} returned an invalid queue projection`);
  }
  assertNoPrivateFields(payload, label);
  return payload;
}

function assertEffectsProjection(payload, roomCode, label) {
  const inRange = (value, minimum, maximum) =>
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
  const effects = payload?.effects;
  if (
    payload?.schemaVersion !== 2 ||
    payload?.view !== 'effects' ||
    payload?.roomCode !== roomCode ||
    !Number.isSafeInteger(payload?.revision) ||
    !Number.isSafeInteger(payload?.updatedAtMs) ||
    !inRange(effects?.reverb?.mixPercent, 0, 100) ||
    !inRange(effects?.reverb?.decaySeconds, 0.1, 30) ||
    !inRange(effects?.reverb?.preDelaySeconds, 0, 1) ||
    !inRange(effects?.reverb?.lowCutPercent, 0, 100) ||
    !inRange(effects?.reverb?.highCutPercent, 0, 100) ||
    !Array.isArray(effects?.equalizer?.bandsDb) ||
    effects.equalizer.bandsDb.length !== 5 ||
    !effects.equalizer.bandsDb.every((value) => inRange(value, -12, 12)) ||
    !inRange(effects?.virtualBass?.strengthPercent, 0, 100) ||
    !inRange(effects?.virtualSurround?.widthPercent, 0, 200) ||
    typeof effects?.virtualTreble?.enabled !== 'boolean'
  ) {
    throw new Error(`${label} returned an invalid effects projection`);
  }
  assertNoPrivateFields(payload, label);
  return payload;
}

function assertQueueModeProjection(payload, roomCode, label) {
  if (
    payload?.schemaVersion !== 1 ||
    payload?.view !== 'queue-mode' ||
    payload?.roomCode !== roomCode ||
    !Number.isSafeInteger(payload?.revision) ||
    !Number.isSafeInteger(payload?.playlistRevision) ||
    !Number.isSafeInteger(payload?.updatedAtMs) ||
    !['off', 'all', 'one'].includes(payload?.repeatMode) ||
    typeof payload?.shuffleEnabled !== 'boolean'
  ) {
    throw new Error(`${label} returned an invalid queue-mode projection`);
  }
  assertNoPrivateFields(payload, label);
  return payload;
}

async function deleteQueueItem(apiKey, roomCode, queueItemId, operation) {
  const { payload } = await apiJson(
    `/v1/rooms/${roomCode}/queue/items/${encodeURIComponent(queueItemId)}`,
    apiKey,
    emptyWrite('DELETE', apiKey, operation),
  );
  return assertQueueProjection(payload, roomCode, `Developer API ${operation}`);
}

async function readHealth() {
  const response = await fetchWithTimeout(`${API_ORIGIN}/health`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Developer API health HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Developer API health returned invalid JSON');
  }
  if (payload?.ok !== true || payload?.service !== 'musixquare-developer-api') {
    throw new Error('Developer API health returned an invalid service envelope');
  }
  return payload;
}

async function readJson(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function canaryConvergenceFailure(response, payload) {
  if (response.status !== 503) return '';
  if (
    hasExactKeys(payload, ['error']) &&
    hasExactKeys(payload.error, ['code', 'message', 'requestId', 'retryable']) &&
    DEVELOPER_API_CANARY_CONVERGENCE_CODES.has(payload.error.code) &&
    typeof payload.error.message === 'string' &&
    DEVELOPER_API_REQUEST_ID_RE.test(payload.error.requestId) &&
    payload.error.retryable === true
  ) {
    return `HTTP 503 (${payload.error.code})`;
  }
  if (
    hasExactKeys(payload, ['error', 'maintenance', 'revision', 'activatedAt', 'settlesAt']) &&
    payload.error === 'SERVICE_MAINTENANCE_STATUS_UNAVAILABLE' &&
    payload.maintenance === true &&
    Number.isSafeInteger(payload.revision) &&
    payload.revision >= 0 &&
    (payload.activatedAt === null || Number.isSafeInteger(payload.activatedAt)) &&
    (payload.settlesAt === null || Number.isSafeInteger(payload.settlesAt))
  ) {
    return 'HTTP 503 (SERVICE_MAINTENANCE_STATUS_UNAVAILABLE)';
  }
  return '';
}

function assertNoPrivateFields(value, label) {
  const forbidden = new Set([
    'assetId',
    'objectKey',
    'stagingObjectKey',
    'source',
    'mime',
    'participants',
    'participantId',
    'displayName',
    'ownerMemberId',
    'sessionHash',
  ]);
  const visit = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, child] of Object.entries(candidate)) {
      if (forbidden.has(key)) throw new Error(`${label} exposed private field ${key}`);
      visit(child);
    }
  };
  visit(value);
}

export async function assertDeveloperApiOff() {
  const response = await fetchWithTimeout(`${API_ORIGIN}/v1/rooms/000000`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const payload = await readJson(response, 'Developer API closed-mode probe');
  if (response.status !== 503 || payload?.error?.code !== 'API_DISABLED') {
    throw new Error(`Developer API was expected to be off, received HTTP ${response.status}`);
  }
  if (response.headers.has('access-control-allow-origin')) {
    throw new Error('Developer API closed-mode probe unexpectedly enabled CORS');
  }
}

export async function assertDeveloperApiCanary(
  apiKey,
  roomCode = '000001',
  {
    expectedWorkerVersion = '',
    expectedFacadeVersion = '',
    retryDelaysMs = DEVELOPER_API_CANARY_RETRY_DELAYS_MS,
    wait = delay,
  } = {},
) {
  if (!/^mxqr_live_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/.test(apiKey)) {
    throw new Error('MXQR_DEVELOPER_API_SMOKE_KEY has an invalid format');
  }
  const authorization = `Bearer ${apiKey}`;
  let roomEtag = '';
  let room = null;
  let playback = null;
  let queue = null;
  let effects = null;
  let queueMode = null;
  let effectsEtag = '';
  for (const suffix of ['', '/playback', '/queue', '/effects', '/queue-mode']) {
    const headers = { Accept: 'application/json', Authorization: authorization };
    if (suffix === '/effects') headers['X-MXQR-Effects-Version'] = '2';
    const attemptDelays = suffix ? [0] : retryDelaysMs;
    let response = null;
    let payload = null;
    let lastRetryableFailure = '';
    let converged = false;
    for (let attemptIndex = 0; attemptIndex < attemptDelays.length; attemptIndex += 1) {
      const waitMs = attemptDelays[attemptIndex];
      if (waitMs > 0) await wait(waitMs);
      try {
        response = await fetchWithTimeout(`${API_ORIGIN}/v1/rooms/${roomCode}${suffix}`, {
          cache: 'no-store',
          headers,
          ...(!suffix ? { signal: AbortSignal.timeout(CANARY_INITIAL_REQUEST_TIMEOUT_MS) } : {}),
        });
      } catch (error) {
        if (!suffix) {
          lastRetryableFailure = `request failed (${error instanceof Error ? error.name : 'unknown error'})`;
          continue;
        }
        throw new Error(
          `Developer API ${suffix || '/room'} smoke request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      payload = await readJson(response, `Developer API ${suffix || '/room'} smoke`);
      if (response.status === 200) {
        if (!suffix) {
          const actualWorkerVersion =
            response.headers.get(DEVELOPER_API_VERSION_HEADER)?.trim() || '';
          const actualFacadeVersion =
            response.headers.get(DEVELOPER_API_FACADE_VERSION_HEADER)?.trim() || '';
          if (
            (expectedWorkerVersion && actualWorkerVersion !== expectedWorkerVersion) ||
            (expectedFacadeVersion && actualFacadeVersion !== expectedFacadeVersion)
          ) {
            lastRetryableFailure =
              `data-plane version mismatch (worker ${actualWorkerVersion || '<missing>'}, ` +
              `facade ${actualFacadeVersion || '<missing>'})`;
            continue;
          }
        }
        converged = true;
        break;
      }
      const convergenceFailure = !suffix ? canaryConvergenceFailure(response, payload) : '';
      if (convergenceFailure) {
        lastRetryableFailure = convergenceFailure;
        continue;
      }
      const code =
        typeof payload?.error === 'string' ? payload.error : payload?.error?.code || '<missing>';
      throw new Error(
        `Developer API ${suffix || '/room'} smoke returned HTTP ${response.status} (${code})`,
      );
    }
    if (!converged || response?.status !== 200 || !payload) {
      throw new Error(
        `Developer API /room smoke remained unavailable after ${attemptDelays.length} attempts: ${lastRetryableFailure || '<unknown>'}`,
      );
    }
    assertNoPrivateFields(payload, `Developer API ${suffix || '/room'} smoke`);
    if (payload?.roomCode !== roomCode) throw new Error('Developer API returned the wrong room');
    if (!suffix) {
      roomEtag = response.headers.get('etag') || '';
      room = payload;
    } else if (suffix === '/playback') {
      playback = payload;
    } else if (suffix === '/queue') {
      queue = assertQueueProjection(payload, roomCode, 'Developer API queue smoke');
    } else if (suffix === '/effects') {
      effects = assertEffectsProjection(payload, roomCode, 'Developer API effects smoke');
      effectsEtag = response.headers.get('etag') || '';
      if (response.headers.get('vary') !== 'X-MXQR-Effects-Version') {
        throw new Error('Developer API effects response omitted its representation Vary header');
      }
    } else {
      queueMode = assertQueueModeProjection(payload, roomCode, 'Developer API queue-mode smoke');
    }
  }
  if (!roomEtag) throw new Error('Developer API room response omitted ETag');
  if (!effects || !effectsEtag) throw new Error('Developer API effects response omitted ETag');
  if (!queueMode) throw new Error('Developer API queue-mode response was not observed');
  const notModified = await fetchWithTimeout(`${API_ORIGIN}/v1/rooms/${roomCode}`, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'If-None-Match': roomEtag,
    },
  });
  if (notModified.status !== 304 || notModified.body !== null) {
    throw new Error(`Developer API ETag smoke returned HTTP ${notModified.status}`);
  }
  const browserOrigin = await fetchWithTimeout(`${API_ORIGIN}/v1/rooms/${roomCode}`, {
    cache: 'no-store',
    headers: { Authorization: authorization, Origin: 'https://example.invalid' },
  });
  if (browserOrigin.status !== 403 || browserOrigin.headers.has('access-control-allow-origin')) {
    throw new Error('Developer API browser-origin boundary smoke failed');
  }
  const otherRoom = roomCode === '000000' ? '000001' : '000000';
  const mismatch = await fetchWithTimeout(`${API_ORIGIN}/v1/rooms/${otherRoom}`, {
    cache: 'no-store',
    headers: { Authorization: authorization },
  });
  if (mismatch.status !== 404) throw new Error('Developer API room binding smoke failed');

  const playbackCommand =
    room?.controlAvailable === true && playback?.state === 'playing'
      ? { type: 'play' }
      : room?.controlAvailable === true && playback?.state === 'paused'
        ? { type: 'pause' }
        : null;
  if (playbackCommand) {
    const { payload: command } = await apiJson(
      `/v1/rooms/${roomCode}/commands`,
      apiKey,
      jsonWrite('POST', apiKey, 'playback-same-state', playbackCommand),
      202,
    );
    if (!/^cmd_[A-Za-z0-9_-]{22}$/.test(command?.commandId || '')) {
      throw new Error('Developer API command smoke returned an invalid command id');
    }
    await apiJson(
      `/v1/rooms/${roomCode}/commands/${encodeURIComponent(command.commandId)}`,
      apiKey,
    );
  }

  const beforeYouTubeIds = new Set(queue.items.map((item) => item.queueItemId));
  let youtubeQueueItemId = null;
  try {
    const { payload: addedPayload } = await apiJson(
      `/v1/rooms/${roomCode}/queue/items`,
      apiKey,
      jsonWrite('POST', apiKey, 'youtube-add', {
        videoId: 'dQw4w9WgXcQ',
        name: 'MUSIXQUARE API smoke',
        title: 'MUSIXQUARE API smoke',
      }),
      201,
    );
    const added = assertQueueProjection(addedPayload, roomCode, 'Developer API YouTube add');
    const newItems = added.items.filter((item) => !beforeYouTubeIds.has(item.queueItemId));
    if (newItems.length !== 1 || newItems[0]?.kind !== 'youtube') {
      throw new Error('Developer API YouTube add did not create exactly one queue item');
    }
    youtubeQueueItemId = newItems[0].queueItemId;
    const { payload: reorderedPayload } = await apiJson(
      `/v1/rooms/${roomCode}/queue/order`,
      apiKey,
      jsonWrite('PUT', apiKey, 'queue-order', {
        basePlaylistRevision: added.playlistRevision,
        queueItemIds: added.items.map((item) => item.queueItemId),
      }),
    );
    assertQueueProjection(reorderedPayload, roomCode, 'Developer API queue reorder');
  } finally {
    if (youtubeQueueItemId) {
      await deleteQueueItem(apiKey, roomCode, youtubeQueueItemId, 'youtube-cleanup');
    }
  }

  const wav = smokeWav();
  let uploadedQueueItemId = null;
  const { payload: reservation } = await apiJson(
    `/v1/rooms/${roomCode}/media/uploads`,
    apiKey,
    jsonWrite('POST', apiKey, 'media-reserve', {
      name: 'musixquare-api-smoke.wav',
      byteLength: wav.byteLength,
      mime: 'audio/wav',
      title: 'MUSIXQUARE API smoke',
    }),
    201,
  );
  if (
    reservation?.schemaVersion !== 1 ||
    reservation?.roomCode !== roomCode ||
    !/^asset_[A-Za-z0-9_-]{24,64}$/.test(reservation?.assetId || '') ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      reservation?.queueItemId || '',
    ) ||
    reservation?.byteLength !== wav.byteLength ||
    !Number.isSafeInteger(reservation?.uploadExpiresAtMs) ||
    !Number.isSafeInteger(reservation?.completionExpiresAtMs) ||
    reservation.completionExpiresAtMs < reservation.uploadExpiresAtMs ||
    reservation?.upload?.method !== 'PUT' ||
    typeof reservation?.upload?.url !== 'string' ||
    !reservation?.upload?.headers ||
    typeof reservation.upload.headers !== 'object'
  ) {
    throw new Error('Developer API media reservation returned an invalid envelope');
  }
  // The reservation fixes both identities before completion begins. Treat its
  // queueItemId as the cleanup authority rather than waiting for the completion
  // response: the Worker may commit the append even when that response times
  // out or is damaged in transit.
  uploadedQueueItemId = reservation.queueItemId;
  const uploadUrl = new URL(reservation.upload.url);
  if (uploadUrl.protocol !== 'https:') {
    throw new Error('Developer API media reservation returned an unsafe upload URL');
  }
  const uploadResponse = await fetchWithTimeout(uploadUrl, {
    method: 'PUT',
    headers: reservation.upload.headers,
    body: wav,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Developer API direct media upload returned HTTP ${uploadResponse.status}`);
  }
  try {
    const { payload: completed } = await apiJson(
      `/v1/rooms/${roomCode}/media/uploads/${encodeURIComponent(reservation.assetId)}/complete`,
      apiKey,
      emptyWrite('POST', apiKey, 'media-complete'),
      201,
    );
    if (
      completed?.schemaVersion !== 1 ||
      completed?.roomCode !== roomCode ||
      completed?.asset?.assetId !== reservation.assetId ||
      completed?.asset?.kind !== 'pro-r2' ||
      completed?.asset?.byteLength !== wav.byteLength ||
      completed?.asset?.mime !== 'audio/wav' ||
      completed?.queueItem?.kind !== 'audio' ||
      typeof completed?.queueItem?.queueItemId !== 'string' ||
      completed.queueItem.queueItemId !== reservation.queueItemId ||
      !Number.isSafeInteger(completed?.playlistRevision)
    ) {
      throw new Error('Developer API media completion returned an invalid envelope');
    }
  } finally {
    if (uploadedQueueItemId) {
      await deleteQueueItem(apiKey, roomCode, uploadedQueueItemId, 'media-cleanup');
    }
  }
}

export async function waitForDeveloperApiReady(
  expectedVersion,
  { read = readHealth, retryDelaysMs = DEVELOPER_API_READINESS_RETRY_DELAYS_MS, wait = delay } = {},
) {
  let lastVersion = '';
  let lastError = null;
  for (const waitMs of retryDelaysMs) {
    if (waitMs > 0) await wait(waitMs);
    try {
      const health = await read();
      lastError = null;
      lastVersion = typeof health.workerVersionId === 'string' ? health.workerVersionId.trim() : '';
      if (!expectedVersion || lastVersion === expectedVersion) {
        return {
          service: health.service,
          expectedVersion: expectedVersion || null,
          actualVersion: lastVersion || null,
        };
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    throw new Error(
      `Developer API health remained unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
  throw new Error(
    `Developer API Worker version mismatch: expected ${expectedVersion}, received ${lastVersion || '<missing>'}`,
  );
}

export async function runDeveloperApiSmoke({ env = process.env, stdout = process.stdout } = {}) {
  const expectedVersion = env.MXQR_EXPECTED_DEVELOPER_API_VERSION?.trim() || '';
  const smokeKey = env.MXQR_DEVELOPER_API_SMOKE_KEY?.trim() || '';
  const expectedFacadeVersion = env.MXQR_EXPECTED_DEVELOPER_API_FACADE_VERSION?.trim() || '';
  if (smokeKey && (!expectedVersion || !expectedFacadeVersion)) {
    throw new Error('Developer API canary smoke requires exact public and facade Worker versions');
  }
  const readiness = await waitForDeveloperApiReady(expectedVersion);
  if (smokeKey) {
    await assertDeveloperApiCanary(
      smokeKey,
      env.MXQR_DEVELOPER_API_SMOKE_ROOM?.trim() || '000001',
      {
        expectedWorkerVersion: expectedVersion,
        expectedFacadeVersion,
      },
    );
  } else {
    await assertDeveloperApiOff();
  }
  stdout.write(
    `${JSON.stringify({ ok: true, mode: smokeKey ? 'canary' : 'off', ...readiness })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runDeveloperApiSmoke();
}
