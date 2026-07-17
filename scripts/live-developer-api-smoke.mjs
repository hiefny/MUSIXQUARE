#!/usr/bin/env node

const API_ORIGIN = 'https://api.musixquare.com';
const RETRY_DELAYS_MS = Object.freeze([0, 1_000, 2_000, 4_000, 8_000]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readHealth() {
  const response = await fetch(`${API_ORIGIN}/health`, {
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
  const response = await fetch(`${API_ORIGIN}/v1/rooms/000001`, {
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

export async function assertDeveloperApiCanary(apiKey, roomCode = '000001') {
  if (!/^mxqr_live_[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/.test(apiKey)) {
    throw new Error('MXQR_DEVELOPER_API_SMOKE_KEY has an invalid format');
  }
  const authorization = `Bearer ${apiKey}`;
  let roomEtag = '';
  for (const suffix of ['', '/playback', '/queue']) {
    const response = await fetch(`${API_ORIGIN}/v1/rooms/${roomCode}${suffix}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: authorization },
    });
    if (response.status !== 200) {
      throw new Error(`Developer API ${suffix || '/room'} smoke returned HTTP ${response.status}`);
    }
    const payload = await readJson(response, `Developer API ${suffix || '/room'} smoke`);
    assertNoPrivateFields(payload, `Developer API ${suffix || '/room'} smoke`);
    if (payload?.roomCode !== roomCode) throw new Error('Developer API returned the wrong room');
    if (!suffix) roomEtag = response.headers.get('etag') || '';
  }
  if (!roomEtag) throw new Error('Developer API room response omitted ETag');
  const notModified = await fetch(`${API_ORIGIN}/v1/rooms/${roomCode}`, {
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
  const browserOrigin = await fetch(`${API_ORIGIN}/v1/rooms/${roomCode}`, {
    cache: 'no-store',
    headers: { Authorization: authorization, Origin: 'https://example.invalid' },
  });
  if (browserOrigin.status !== 403 || browserOrigin.headers.has('access-control-allow-origin')) {
    throw new Error('Developer API browser-origin boundary smoke failed');
  }
  const write = await fetch(`${API_ORIGIN}/v1/rooms/${roomCode}/commands`, {
    method: 'POST',
    headers: { Authorization: authorization },
  });
  if (write.status !== 404) throw new Error('Developer API unexpectedly exposed a write route');
  const otherRoom = roomCode === '000000' ? '000001' : '000000';
  const mismatch = await fetch(`${API_ORIGIN}/v1/rooms/${otherRoom}`, {
    cache: 'no-store',
    headers: { Authorization: authorization },
  });
  if (mismatch.status !== 404) throw new Error('Developer API room binding smoke failed');
}

export async function waitForDeveloperApiReady(
  expectedVersion,
  { read = readHealth, retryDelaysMs = RETRY_DELAYS_MS, wait = delay } = {},
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

const expectedVersion = process.env.MXQR_EXPECTED_DEVELOPER_API_VERSION?.trim() || '';
const readiness = await waitForDeveloperApiReady(expectedVersion);
const smokeKey = process.env.MXQR_DEVELOPER_API_SMOKE_KEY?.trim() || '';
if (smokeKey) {
  await assertDeveloperApiCanary(
    smokeKey,
    process.env.MXQR_DEVELOPER_API_SMOKE_ROOM?.trim() || '000001',
  );
} else {
  await assertDeveloperApiOff();
}
console.log(JSON.stringify({ ok: true, mode: smokeKey ? 'canary' : 'off', ...readiness }));
