#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const PRO_ROOM_HEALTH_URL = 'https://musixquare.com/api/pro-room/health';
const PRO_ROOM_CANARY_CODE = '000000';
const PRO_ROOM_CANARY_BASE_URL =
  `https://musixquare.com/api/pro-room/v1/rooms/${PRO_ROOM_CANARY_CODE}`;
// A newly promoted Worker can become visible through the App Worker service
// binding later than Cloudflare's control plane reports the 100% deployment.
// Keep the exact version check, but allow enough time for that private
// data-plane route to converge before the release workflow rolls back.
export const PRO_ROOM_READINESS_RETRY_DELAYS_MS = Object.freeze([
  0, 1_000, 2_000, 4_000, 8_000, 15_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000,
]);
export const PRO_ROOM_HEALTH_REQUEST_TIMEOUT_MS = 10_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fetchWithTimeout(input, init = {}) {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(PRO_ROOM_HEALTH_REQUEST_TIMEOUT_MS),
  });
}

async function readHealth() {
  const response = await fetchWithTimeout(PRO_ROOM_HEALTH_URL, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PRO room health HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('PRO room health returned invalid JSON');
  }
  if (payload?.ok !== true || payload?.service !== 'musixquare-pro-room') {
    throw new Error('PRO room health returned an invalid service envelope');
  }
  return payload;
}

async function readJsonBoundary(path) {
  const response = await fetchWithTimeout(`${PRO_ROOM_CANARY_BASE_URL}${path}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`PRO room boundary ${path} returned invalid JSON`);
  }
  return { status: response.status, payload };
}

export async function verifyProRoomPublicBoundary({
  read = readJsonBoundary,
} = {}) {
  const bootstrap = await read('/bootstrap');
  if (
    bootstrap?.status !== 200 ||
    bootstrap.payload?.roomCode !== PRO_ROOM_CANARY_CODE ||
    !['activation_required', 'pin_required'].includes(bootstrap.payload?.status)
  ) {
    throw new Error('PRO room bootstrap boundary returned an invalid public projection');
  }

  const anonymousSnapshot = await read('/snapshot');
  if (
    anonymousSnapshot?.status !== 401 ||
    anonymousSnapshot.payload?.error !== 'SESSION_REQUIRED'
  ) {
    throw new Error('PRO room snapshot boundary did not reject an anonymous credential');
  }

  return {
    roomCode: PRO_ROOM_CANARY_CODE,
    roomStatus: bootstrap.payload.status,
    anonymousSnapshotRejected: true,
  };
}

export async function main() {
  const expectedVersion = process.env.MXQR_EXPECTED_PRO_ROOM_VERSION?.trim() || '';
  const readiness = await waitForProRoomReady(expectedVersion);
  const boundary = await verifyProRoomPublicBoundary();
  console.log(JSON.stringify({ ok: true, ...readiness, boundary }));
}

export async function waitForProRoomReady(
  expectedVersion,
  {
    read = readHealth,
    retryDelaysMs = PRO_ROOM_READINESS_RETRY_DELAYS_MS,
    wait = delay,
    log = console.log,
  } = {},
) {
  let lastActualVersion = '';
  let lastReadError = null;

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const waitMs = retryDelaysMs[attempt];
    if (waitMs > 0) await wait(waitMs);

    let health;
    try {
      health = await read();
      lastReadError = null;
    } catch (error) {
      lastReadError = error;
      const message = error instanceof Error ? error.message : String(error);
      log(`[pro-room-smoke] attempt ${attempt + 1}/${retryDelaysMs.length}: ${message}`);
      continue;
    }
    const actualVersion =
      typeof health.workerVersionId === 'string' ? health.workerVersionId.trim() : '';
    lastActualVersion = actualVersion;
    log(
      `[pro-room-smoke] attempt ${attempt + 1}/${retryDelaysMs.length}: expected=${expectedVersion || '<any>'} actual=${actualVersion || '<missing>'}`,
    );
    if (!expectedVersion || actualVersion === expectedVersion) {
      return {
        service: health.service,
        expectedVersion: expectedVersion || null,
        actualVersion: actualVersion || null,
      };
    }
  }

  if (lastReadError) {
    const message = lastReadError instanceof Error ? lastReadError.message : String(lastReadError);
    throw new Error(`PRO room health remained unavailable: ${message}`);
  }

  throw new Error(
    `PRO room Worker version mismatch: expected ${expectedVersion}, received ${lastActualVersion || '<missing>'}`,
  );
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await main();
}
