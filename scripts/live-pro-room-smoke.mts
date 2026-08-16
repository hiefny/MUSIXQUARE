#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const PRO_ROOM_HEALTH_URL = 'https://musixquare.com/api/pro-room/health';
const PRO_ROOM_BOUNDARY_BASE_URL = 'https://musixquare.com/api/pro-room/v1/rooms';
const PRO_ROOM_ACTIVATION_CANARY = Object.freeze({
  roomCode: '000000',
  expectedStatus: 'activation_required',
});
const PRO_ROOM_PIN_CANARY = Object.freeze({
  roomCode: '000001',
  expectedStatus: 'pin_required',
});
// A newly promoted Worker can become visible through the App Worker service
// binding later than Cloudflare's control plane reports the 100% deployment.
// Keep the exact version check, but allow enough time for that private
// data-plane route to converge before the release workflow rolls back.
export const PRO_ROOM_READINESS_RETRY_DELAYS_MS = Object.freeze([
  0, 1_000, 2_000, 4_000, 8_000, 15_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000,
]);
// Public-boundary probes run only after health/version readiness succeeds. A
// small, separate retry budget absorbs transient service-binding stalls
// without turning a malformed or unexpectedly permissive response into a
// passing release.
const PRO_ROOM_BOUNDARY_RETRY_DELAYS_MS = Object.freeze([0, 1_000, 2_000]);
export const PRO_ROOM_HEALTH_REQUEST_TIMEOUT_MS = 10_000;

const RETRYABLE_BOUNDARY_HTTP_STATUSES = new Set([429]);
const RETRYABLE_TRANSPORT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

type JsonObject = Record<string, unknown>;
type Wait = (milliseconds: number) => Promise<void>;
type Log = (message: string) => void;

interface ProRoomHealth {
  service?: string;
  workerVersionId?: string;
}

interface BoundaryReadResult {
  status: number;
  payload: JsonObject;
}

interface BoundaryCanary {
  roomCode: string;
  expectedStatus: string;
}

interface BoundaryReadOptions {
  read: (path: string) => Promise<BoundaryReadResult>;
  retryDelaysMs?: readonly number[];
  wait?: Wait;
  log?: Log;
}

interface VerifyBoundaryOptions {
  read?: (path: string) => Promise<BoundaryReadResult>;
  retryDelaysMs?: readonly number[];
  wait?: Wait;
  log?: Log;
}

interface ReadinessOptions {
  read?: () => Promise<ProRoomHealth>;
  retryDelaysMs?: readonly number[];
  wait?: Wait;
  log?: Log;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class RetryableProRoomBoundaryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetryableProRoomBoundaryError';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(PRO_ROOM_HEALTH_REQUEST_TIMEOUT_MS),
  });
}

async function readHealth(): Promise<ProRoomHealth> {
  const response = await fetchWithTimeout(PRO_ROOM_HEALTH_URL, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PRO room health HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('PRO room health returned invalid JSON');
  }
  if (
    !isJsonObject(payload) ||
    payload.ok !== true ||
    payload.service !== 'musixquare-pro-room' ||
    (payload.workerVersionId !== undefined && typeof payload.workerVersionId !== 'string')
  ) {
    throw new Error('PRO room health returned an invalid service envelope');
  }
  return {
    service: payload.service,
    ...(typeof payload.workerVersionId === 'string'
      ? { workerVersionId: payload.workerVersionId }
      : {}),
  };
}

async function readJsonBoundary(path: string): Promise<BoundaryReadResult> {
  const response = await fetchWithTimeout(`${PRO_ROOM_BOUNDARY_BASE_URL}${path}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const text = await response.text();
  if (isRetryableBoundaryStatus(response.status)) {
    throw new RetryableProRoomBoundaryError(
      `PRO room boundary ${path} HTTP ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`PRO room boundary ${path} returned invalid JSON`);
  }
  if (!isJsonObject(payload)) {
    throw new Error(`PRO room boundary ${path} returned an invalid envelope`);
  }
  return { status: response.status, payload };
}

function isRetryableBoundaryStatus(status: unknown): boolean {
  return (
    RETRYABLE_BOUNDARY_HTTP_STATUSES.has(Number(status)) ||
    (Number(status) >= 500 && Number(status) <= 599)
  );
}

function transportErrorCode(error: unknown): string {
  let candidate: unknown = error;
  for (let depth = 0; candidate && depth < 4; depth += 1) {
    if (!isJsonObject(candidate)) return '';
    if (typeof candidate.code === 'string') return candidate.code;
    candidate = candidate.cause;
  }
  return '';
}

function isRetryableBoundaryError(error: unknown): boolean {
  if (error instanceof RetryableProRoomBoundaryError) return true;
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return true;
  }
  if (RETRYABLE_TRANSPORT_ERROR_CODES.has(transportErrorCode(error))) return true;
  // Fetch rejects transport failures with TypeError. JSON/schema failures are
  // converted to ordinary Error instances before reaching this boundary.
  return error instanceof TypeError;
}

async function readBoundaryWithRetry(
  path: string,
  {
    read,
    retryDelaysMs = PRO_ROOM_BOUNDARY_RETRY_DELAYS_MS,
    wait = delay,
    log = console.log,
  }: BoundaryReadOptions,
): Promise<BoundaryReadResult> {
  const delays = retryDelaysMs.length > 0 ? retryDelaysMs : [0];
  let lastError = null;

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    const waitMs = delays[attempt];
    if (waitMs !== undefined && waitMs > 0) await wait(waitMs);

    try {
      const result = await read(path);
      if (isRetryableBoundaryStatus(result?.status)) {
        throw new RetryableProRoomBoundaryError(`PRO room boundary ${path} HTTP ${result.status}`);
      }
      return result;
    } catch (error) {
      if (!isRetryableBoundaryError(error)) throw error;
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      log(`[pro-room-smoke] boundary ${path} attempt ${attempt + 1}/${delays.length}: ${message}`);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`PRO room boundary ${path} remained unavailable: ${message}`, {
    cause: lastError,
  });
}

async function verifyBootstrapCanary(
  read: (path: string) => Promise<BoundaryReadResult>,
  canary: BoundaryCanary,
): Promise<BoundaryReadResult> {
  const bootstrap = await read(`/${canary.roomCode}/bootstrap`);
  if (
    bootstrap?.status !== 200 ||
    bootstrap.payload?.roomCode !== canary.roomCode ||
    bootstrap.payload?.status !== canary.expectedStatus
  ) {
    throw new Error(`PRO room ${canary.roomCode} bootstrap must return ${canary.expectedStatus}`);
  }
  return bootstrap;
}

export async function verifyProRoomPublicBoundary({
  read = readJsonBoundary,
  retryDelaysMs = PRO_ROOM_BOUNDARY_RETRY_DELAYS_MS,
  wait = delay,
  log = console.log,
}: VerifyBoundaryOptions = {}): Promise<{
  roomCode: string;
  roomStatus: unknown;
  pinRoomCode: string;
  pinRoomStatus: unknown;
  anonymousSnapshotRejected: true;
}> {
  const readWithRetry = (path: string): Promise<BoundaryReadResult> =>
    readBoundaryWithRetry(path, { read, retryDelaysMs, wait, log });
  const activationBootstrap = await verifyBootstrapCanary(
    readWithRetry,
    PRO_ROOM_ACTIVATION_CANARY,
  );
  const pinBootstrap = await verifyBootstrapCanary(readWithRetry, PRO_ROOM_PIN_CANARY);

  const anonymousSnapshot = await readWithRetry(`/${PRO_ROOM_ACTIVATION_CANARY.roomCode}/snapshot`);
  if (
    anonymousSnapshot?.status !== 401 ||
    anonymousSnapshot.payload?.error !== 'SESSION_REQUIRED'
  ) {
    throw new Error('PRO room snapshot boundary did not reject an anonymous credential');
  }

  return {
    roomCode: PRO_ROOM_ACTIVATION_CANARY.roomCode,
    roomStatus: activationBootstrap.payload.status,
    pinRoomCode: PRO_ROOM_PIN_CANARY.roomCode,
    pinRoomStatus: pinBootstrap.payload.status,
    anonymousSnapshotRejected: true,
  };
}

export async function main(): Promise<void> {
  const expectedVersion = process.env.MXQR_EXPECTED_PRO_ROOM_VERSION?.trim() || '';
  const readiness = await waitForProRoomReady(expectedVersion);
  const boundary = await verifyProRoomPublicBoundary();
  console.log(JSON.stringify({ ok: true, ...readiness, boundary }));
}

export async function waitForProRoomReady(
  expectedVersion: string,
  {
    read = readHealth,
    retryDelaysMs = PRO_ROOM_READINESS_RETRY_DELAYS_MS,
    wait = delay,
    log = console.log,
  }: ReadinessOptions = {},
): Promise<{ service?: string; expectedVersion: string | null; actualVersion: string | null }> {
  let lastActualVersion = '';
  let lastReadError = null;

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    const waitMs = retryDelaysMs[attempt];
    if (waitMs !== undefined && waitMs > 0) await wait(waitMs);

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
        ...(health.service === undefined ? {} : { service: health.service }),
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
