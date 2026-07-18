#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const PRO_ROOM_HEALTH_URL = 'https://musixquare.com/api/pro-room/health';
const RETRY_DELAYS_MS = Object.freeze([0, 1_000, 2_000, 4_000, 8_000, 8_000]);
const REQUEST_TIMEOUT_MS = 30_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fetchWithTimeout(input, init = {}) {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

export async function main() {
  const expectedVersion = process.env.MXQR_EXPECTED_PRO_ROOM_VERSION?.trim() || '';
  const readiness = await waitForProRoomReady(expectedVersion);
  console.log(JSON.stringify({ ok: true, ...readiness }));
}

export async function waitForProRoomReady(
  expectedVersion,
  { read = readHealth, retryDelaysMs = RETRY_DELAYS_MS, wait = delay } = {},
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
      continue;
    }
    const actualVersion =
      typeof health.workerVersionId === 'string' ? health.workerVersionId.trim() : '';
    lastActualVersion = actualVersion;
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
