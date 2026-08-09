#!/usr/bin/env node

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

const APP_ORIGIN = 'https://musixquare.com';
const REMOTE_ORIGIN = 'https://share.musixquare.com';
const DEFAULT_BYTES = 32;
const MAX_SMOKE_BYTES = 1024 * 1024;
const FILE_NAME = 'live-remote-share-smoke.wav';
const FILE_MIME = 'audio/wav';
const REQUEST_TIMEOUT_MS = 30_000;
const JSON_RESPONSE_MAX_BYTES = 256 * 1024;
const WORKER_PROPAGATION_TIMEOUT_MS = 120_000;
const WORKER_RETRY_INTERVAL_MS = 1_000;
const R2_CORS_PROPAGATION_TIMEOUT_MS = 45_000;
const R2_CORS_RETRY_INTERVAL_MS = 2_000;

interface RemoteShareSession {
  uploadUrl: string;
  uploadUrlExpiresAt: number;
  uploadHeaders: Record<string, string>;
  completeToken: string;
  objectId: string;
  cleanupToken: string;
  expiresAt: number;
  queueItemId: string;
  sessionId: number;
}

interface UploadTarget {
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
}

function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function parseByteCount(): number {
  const option = process.argv.find((value) => value.startsWith('--bytes='));
  const value = Number(option?.slice('--bytes='.length) || DEFAULT_BYTES);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SMOKE_BYTES) {
    throw new Error(`--bytes must be an integer between 1 and ${MAX_SMOKE_BYTES}`);
  }
  return value;
}

function assertAllowedOrigin(response: Response, label: string): void {
  const allowedOrigin = response.headers.get('access-control-allow-origin');
  if (allowedOrigin !== APP_ORIGIN) {
    throw new Error(`${label} CORS origin mismatch: ${String(allowedOrigin)}`);
  }
}

function cancelResponseBody(response: Response, reason: string): void {
  if (!response.body) return;
  try {
    void response.body.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation is best-effort and must never pin a live release smoke.
  }
}

async function waitForRemoteShareWorkerReady(): Promise<void> {
  const deadline = Date.now() + WORKER_PROPAGATION_TIMEOUT_MS;
  let consecutiveReadyReads = 0;
  let lastObservedContract = 'none';

  for (;;) {
    const readinessUrl = new URL('/security-config', REMOTE_ORIGIN);
    readinessUrl.searchParams.set('readiness', `${Date.now()}-${randomUUID()}`);
    const response = await fetchWithTimeout(readinessUrl, {
      headers: { Accept: 'application/json', Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(response, 'remote-share readiness');
    const config = await readJson(response, 'remote-share readiness');
    if (
      config.capabilityRequired !== true ||
      config.scope !== 'remote-share' ||
      typeof config.ttl !== 'number'
    ) {
      throw new Error('remote-share readiness returned invalid security config');
    }

    const wholeObjectReady =
      config.wholeObjectVersion === 1 && config.downloadAuthorizationVersion === 1;
    lastObservedContract = JSON.stringify({
      workerContractVersion: config.workerContractVersion,
      sessionReplayRequired: config.sessionReplayRequired,
      sessionReplayEnabled: config.sessionReplayEnabled,
      wholeObjectVersion: config.wholeObjectVersion,
      downloadAuthorizationVersion: config.downloadAuthorizationVersion,
    });
    if (
      config.workerContractVersion === 3 &&
      config.sessionReplayRequired === true &&
      config.sessionReplayEnabled === true &&
      wholeObjectReady
    ) {
      consecutiveReadyReads += 1;
      if (consecutiveReadyReads >= 2) return;
    } else consecutiveReadyReads = 0;

    if (Date.now() >= deadline) {
      throw new Error(
        `remote-share readiness did not converge; last contract: ${lastObservedContract}`,
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(WORKER_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now()))),
    );
  }
}

async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > JSON_RESPONSE_MAX_BYTES) {
    cancelResponseBody(response, `${label} response too large`);
    throw new Error(`${label} response exceeded ${JSON_RESPONSE_MAX_BYTES} bytes`);
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        totalBytes += result.value.byteLength;
        if (totalBytes > JSON_RESPONSE_MAX_BYTES) {
          try {
            void reader.cancel(`${label} response too large`).catch(() => undefined);
          } catch {
            // Cancellation is best-effort; preserve the primary cap failure.
          }
          throw new Error(`${label} response exceeded ${JSON_RESPONSE_MAX_BYTES} bytes`);
        }
        chunks.push(result.value);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A failed release cannot change the bounded response outcome.
      }
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} returned invalid UTF-8`);
  }
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function requestCapabilityToken(): Promise<string> {
  if (process.env.MXQR_CAPABILITY_TOKEN) return process.env.MXQR_CAPABILITY_TOKEN.trim();

  const config = await readJson(
    await fetchWithTimeout(`${APP_ORIGIN}/api/security-config`, {
      headers: { Accept: 'application/json', Origin: APP_ORIGIN },
    }),
    'security config',
  );
  if (config.capabilityRequired !== true) {
    throw new Error('production App capability protection is disabled');
  }

  let proofOfWork: { challenge: string; solution: string } | undefined;
  if (config.proofOfWorkRequired === true) {
    const challenge = await readJson(
      await fetchWithTimeout(`${APP_ORIGIN}/api/capability-challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
        body: JSON.stringify({ scopes: ['remote-share'] }),
      }),
      'capability challenge',
    );
    if (
      typeof challenge.challenge !== 'string' ||
      typeof challenge.difficulty !== 'number' ||
      challenge.algorithm !== 'sha256-leading-zero-bits'
    ) {
      throw new Error('invalid capability proof-of-work challenge');
    }
    const prefix = `mxqr-pow-v1:${challenge.challenge}:`;
    let solution = -1;
    for (let candidate = 0; candidate < Number.MAX_SAFE_INTEGER; candidate += 1) {
      const digest = createHash('sha256').update(`${prefix}${candidate}`).digest();
      let remaining = challenge.difficulty;
      let valid = true;
      for (const byte of digest) {
        if (remaining <= 0) break;
        const bits = Math.min(8, remaining);
        if ((byte & (0xff << (8 - bits))) !== 0) {
          valid = false;
          break;
        }
        remaining -= bits;
      }
      if (valid && remaining <= 0) {
        solution = candidate;
        break;
      }
    }
    if (solution < 0) throw new Error('capability proof-of-work solution unavailable');
    proofOfWork = { challenge: challenge.challenge, solution: String(solution) };
  }

  const response = await fetchWithTimeout(`${APP_ORIGIN}/api/capability-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
    body: JSON.stringify({ scopes: ['remote-share'], ...(proofOfWork ? { proofOfWork } : {}) }),
  });
  const payload = await readJson(response, 'capability token');
  if (typeof payload.token !== 'string' || !payload.token) {
    throw new Error('capability token missing');
  }
  return payload.token;
}

async function requestSession(
  token: string,
  roomId: string,
  queueItemId: string,
  sessionId: number,
  sourceFile: File,
  requestId: string,
  actorId: string,
): Promise<RemoteShareSession> {
  const response = await fetchWithTimeout(`${REMOTE_ORIGIN}/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: APP_ORIGIN,
      ...(token ? { 'X-MXQR-Capability': token } : {}),
    },
    body: JSON.stringify({
      roomId,
      sessionId,
      queueItemId,
      name: sourceFile.name,
      mime: sourceFile.type,
      size: sourceFile.size,
      requestId,
      actorId,
    }),
  });
  assertAllowedOrigin(response, 'remote-share session');
  const session = await readJson(response, 'remote-share session');
  if (
    typeof session.uploadUrl !== 'string' ||
    typeof session.uploadUrlExpiresAt !== 'number' ||
    typeof session.completeToken !== 'string' ||
    typeof session.objectId !== 'string' ||
    typeof session.cleanupToken !== 'string' ||
    typeof session.expiresAt !== 'number' ||
    !session.uploadHeaders ||
    typeof session.uploadHeaders !== 'object' ||
    Array.isArray(session.uploadHeaders) ||
    !Object.values(session.uploadHeaders).every((value) => typeof value === 'string')
  ) {
    throw new Error('invalid remote-share session response');
  }
  return { ...session, queueItemId, sessionId } as unknown as RemoteShareSession;
}

async function assertAnonymousSessionRejected(
  roomId: string,
  queueItemId: string,
  sessionId: number,
  sourceFile: File,
): Promise<void> {
  const response = await fetchWithTimeout(`${REMOTE_ORIGIN}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
    body: JSON.stringify({
      roomId,
      sessionId,
      queueItemId,
      name: sourceFile.name,
      mime: sourceFile.type,
      size: sourceFile.size,
    }),
  });
  assertAllowedOrigin(response, 'anonymous remote-share session');
  if (response.status !== 401) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(
      `anonymous remote-share session returned HTTP ${response.status}, expected 401: ${detail}`,
    );
  }
  cancelResponseBody(response, 'anonymous session probe complete');
}

function assertSessionPlaybackContext(
  session: Pick<RemoteShareSession, 'completeToken' | 'queueItemId' | 'sessionId'>,
  queueItemId: string,
  sessionId: number,
): void {
  const [encodedPayload] = session.completeToken.split('.');
  if (!encodedPayload) throw new Error('remote-share complete token payload missing');
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error('remote-share complete token payload is invalid');
  }
  if (
    session.queueItemId !== queueItemId ||
    session.sessionId !== sessionId ||
    payload.queueItemId !== queueItemId ||
    payload.sessionId !== sessionId
  ) {
    throw new Error('remote-share playback context mismatch');
  }
}

function decodeAuthorityPayload(token: string, label: string): Record<string, unknown> {
  const [encodedPayload, encodedSignature] = token.split('.');
  if (!encodedPayload || !encodedSignature) throw new Error(`${label} token shape is invalid`);
  try {
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error(`${label} token payload is invalid`);
  }
}

function assertCleanupAuthority(session: RemoteShareSession, roomId: string): void {
  const payload = decodeAuthorityPayload(session.cleanupToken, 'remote-share cleanup');
  if (
    payload.v !== 1 ||
    payload.kind !== 'cleanup' ||
    payload.aud !== 'musixquare-remote-share' ||
    payload.method !== 'DELETE' ||
    payload.roomId !== roomId ||
    payload.objectId !== session.objectId ||
    payload.key !== `room/${roomId}/${session.objectId}` ||
    payload.exp !== session.expiresAt ||
    typeof payload.iat !== 'number' ||
    typeof payload.nonce !== 'string'
  ) {
    throw new Error('remote-share cleanup authority is not bound to the object incarnation');
  }
}

function assertUploadMetadata(session: RemoteShareSession, sourceFile: File): void {
  const normalized = Object.fromEntries(
    Object.entries(session.uploadHeaders).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const expected: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-amz-meta-name': encodeURIComponent(sourceFile.name),
    'x-amz-meta-mime': encodeURIComponent(sourceFile.type),
    'x-amz-meta-stored-size': String(sourceFile.size),
    'x-amz-meta-format-version': 'whole-object-v1',
    'x-amz-meta-object-id': session.objectId,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (normalized[name] !== value) {
      throw new Error(`remote-share upload metadata mismatch for ${name}`);
    }
  }
  if (!/^"[\x21\x23-\x7e]{1,128}"$/.test(normalized['if-match'] || '')) {
    throw new Error('remote-share upload is not fenced to an exact R2 placeholder ETag');
  }
}

async function assertUploadCors(target: UploadTarget): Promise<void> {
  const requestedHeaders = Object.keys(target.uploadHeaders).join(',');
  const deadline = Date.now() + R2_CORS_PROPAGATION_TIMEOUT_MS;
  let response: Response;
  for (;;) {
    response = await fetchWithTimeout(target.uploadUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: APP_ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': requestedHeaders,
      },
    });
    if (response.ok) break;
    if (response.status !== 403 || Date.now() >= deadline) {
      throw new Error(`R2 CORS preflight HTTP ${response.status}`);
    }

    // R2 documents that an updated bucket CORS policy can take up to 30
    // seconds to reach the data plane. Retry only the no-matching-rule 403;
    // every other status and every malformed successful response stays
    // fail-closed.
    cancelResponseBody(response, 'R2 CORS propagation retry');
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(R2_CORS_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now()))),
    );
  }
  assertAllowedOrigin(response, 'R2 CORS preflight');
  const methods = new Set(
    (response.headers.get('access-control-allow-methods') || '')
      .toLowerCase()
      .split(',')
      .map((value) => value.trim()),
  );
  if (!methods.has('put')) throw new Error('R2 CORS does not allow PUT');
  const headers = new Set(
    (response.headers.get('access-control-allow-headers') || '')
      .toLowerCase()
      .split(',')
      .map((value) => value.trim()),
  );
  for (const name of Object.keys(target.uploadHeaders)) {
    if (!headers.has(name.toLowerCase())) throw new Error(`R2 CORS does not allow ${name}`);
  }
}

async function completeUpload(
  session: RemoteShareSession,
  roomId: string,
): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(`${REMOTE_ORIGIN}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
    body: JSON.stringify({
      roomId,
      objectId: session.objectId,
      completeToken: session.completeToken,
    }),
  });
  assertAllowedOrigin(response, 'remote-share complete');
  return readJson(response, 'remote-share complete');
}

async function cleanup(session: RemoteShareSession, roomId: string): Promise<Response> {
  return fetchWithTimeout(`${REMOTE_ORIGIN}/object/${roomId}/${session.objectId}`, {
    method: 'DELETE',
    headers: {
      Origin: APP_ORIGIN,
      'X-MXQR-Cleanup-Token': session.cleanupToken,
    },
  });
}

async function runWholeObjectSmoke(
  token: string,
  roomId: string,
  sourceBytes: Uint8Array<ArrayBuffer>,
): Promise<Record<string, unknown>> {
  const queueItemId = randomUUID();
  const sessionId = Date.now();
  const sourceFile = new File([sourceBytes], FILE_NAME, { type: FILE_MIME });
  const requestId = `rs3_${randomBytes(32).toString('base64url')}`;
  const actorId = `rsa_${randomBytes(32).toString('base64url')}`;
  const expectedSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  let session: RemoteShareSession | undefined;
  let cleaned = false;

  try {
    session = await requestSession(
      token,
      roomId,
      queueItemId,
      sessionId,
      sourceFile,
      requestId,
      actorId,
    );
    assertSessionPlaybackContext(session, queueItemId, sessionId);
    assertCleanupAuthority(session, roomId);
    assertUploadMetadata(session, sourceFile);

    // A presigned URL is deterministic inside one signing second. Cross the
    // next second before exact replay so a fresh signature is observable while
    // the immutable upload-authority deadline remains unchanged.
    const nextSigningSecond = (Math.floor(Date.now() / 1000) + 1) * 1000;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, nextSigningSecond - Date.now() + 25)),
    );
    const replay = await requestSession(
      token,
      roomId,
      queueItemId,
      sessionId,
      sourceFile,
      requestId,
      actorId,
    );
    if (
      replay.objectId !== session.objectId ||
      replay.cleanupToken !== session.cleanupToken ||
      replay.expiresAt !== session.expiresAt ||
      replay.uploadUrlExpiresAt !== session.uploadUrlExpiresAt ||
      replay.uploadUrl === session.uploadUrl
    ) {
      throw new Error('remote-share durable session replay contract mismatch');
    }
    assertSessionPlaybackContext(replay, queueItemId, sessionId);
    assertCleanupAuthority(replay, roomId);
    assertUploadMetadata(replay, sourceFile);
    session = replay;
    await assertUploadCors(session);

    const upload = await fetchWithTimeout(session.uploadUrl, {
      method: 'PUT',
      headers: { ...session.uploadHeaders, Origin: APP_ORIGIN },
      body: sourceFile,
    });
    if (!upload.ok) throw new Error(`R2 direct PUT HTTP ${upload.status}`);
    assertAllowedOrigin(upload, 'R2 direct PUT');
    cancelResponseBody(upload, 'R2 direct PUT complete');

    const completed = await completeUpload(session, roomId);
    const downloadUrl = completed.downloadUrl;
    const downloadToken = completed.downloadToken;
    if (
      completed.objectId !== session.objectId ||
      typeof downloadUrl !== 'string' ||
      downloadUrl !== `${REMOTE_ORIGIN}/download/${roomId}/${session.objectId}` ||
      typeof downloadToken !== 'string' ||
      downloadToken.length < 32 ||
      completed.cleanupToken !== session.cleanupToken ||
      downloadUrl.includes(downloadToken)
    ) {
      throw new Error('invalid remote-share completion response');
    }

    const unauthorized = await fetchWithTimeout(downloadUrl, {
      headers: { Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(unauthorized, 'unauthorized remote-share download');
    if (unauthorized.status !== 401) {
      throw new Error(`unauthorized remote-share download returned HTTP ${unauthorized.status}`);
    }
    cancelResponseBody(unauthorized, 'unauthorized download probe complete');

    const range = await fetchWithTimeout(downloadUrl, {
      headers: {
        Authorization: `Bearer ${downloadToken}`,
        Origin: APP_ORIGIN,
        Range: 'bytes=0-0',
      },
    });
    assertAllowedOrigin(range, 'remote-share Range rejection');
    if (range.status !== 416) {
      throw new Error(`remote-share Range returned HTTP ${range.status}, expected 416`);
    }
    cancelResponseBody(range, 'range rejection probe complete');

    const download = await fetchWithTimeout(downloadUrl, {
      headers: { Authorization: `Bearer ${downloadToken}`, Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(download, 'authorized remote-share download');
    if (!download.ok) throw new Error(`remote-share download HTTP ${download.status}`);
    if (download.headers.get('cache-control') !== 'no-store') {
      throw new Error('remote-share download is cacheable');
    }
    const downloadedBytes = new Uint8Array(await download.arrayBuffer());
    const actualSha256 = createHash('sha256').update(downloadedBytes).digest('hex');
    if (downloadedBytes.byteLength !== sourceBytes.byteLength || actualSha256 !== expectedSha256) {
      throw new Error('remote-share byte mismatch');
    }

    const forgedCleanup = await fetchWithTimeout(
      `${REMOTE_ORIGIN}/object/${roomId}/${session.objectId}`,
      {
        method: 'DELETE',
        headers: { Origin: APP_ORIGIN, 'X-MXQR-Cleanup-Token': randomUUID() },
      },
    );
    assertAllowedOrigin(forgedCleanup, 'forged remote-share cleanup');
    if (forgedCleanup.status !== 403) {
      throw new Error(`forged remote-share cleanup returned HTTP ${forgedCleanup.status}`);
    }
    cancelResponseBody(forgedCleanup, 'forged cleanup probe complete');

    const deleted = await cleanup(session, roomId);
    assertAllowedOrigin(deleted, 'remote-share cleanup');
    await readJson(deleted, 'remote-share cleanup');
    cleaned = true;

    const afterDelete = await fetchWithTimeout(downloadUrl, {
      headers: { Authorization: `Bearer ${downloadToken}`, Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(afterDelete, 'remote-share deleted-object lookup');
    if (afterDelete.status !== 404) {
      throw new Error(`deleted object returned HTTP ${afterDelete.status}, expected 404`);
    }
    cancelResponseBody(afterDelete, 'deleted object probe complete');

    return {
      wireFormat: 'whole-v1',
      durableSessionReplay: true,
      replayPreservedAllocation: true,
      replayFreshUploadUrl: true,
      bytes: sourceFile.size,
      directR2Put: true,
      corsPreflight: true,
      exactByteRoundTrip: true,
      bearerHeaderOnly: true,
      unauthorizedReadRejected: true,
      rangeRejected: true,
      noStore: true,
      forgedCleanupRejected: true,
      cleanupStatus: deleted.status,
      afterCleanupStatus: afterDelete.status,
    };
  } finally {
    if (session && !cleaned) await cleanup(session, roomId).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const byteCount = parseByteCount();
  // Exercise the same namespace the product can actually allocate. The object
  // UUID still makes concurrent smoke objects unique if two runs pick the same
  // six-digit room code.
  const roomId = String(randomInt(100_000, 1_000_000));
  const sourceBytes = new Uint8Array(randomBytes(byteCount));
  const token = await requestCapabilityToken();
  await waitForRemoteShareWorkerReady();
  const anonymousProbeFile = new File([sourceBytes], FILE_NAME, { type: FILE_MIME });
  await assertAnonymousSessionRejected(roomId, randomUUID(), Date.now(), anonymousProbeFile);
  const wholeObject = await runWholeObjectSmoke(token, roomId, sourceBytes);

  console.log(
    JSON.stringify({
      ok: true,
      anonymousSessionRejected: true,
      wholeObject,
    }),
  );
}

await main();
