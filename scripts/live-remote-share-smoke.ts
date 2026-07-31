#!/usr/bin/env node

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

import { decryptToFile, encryptFile } from '../src/share/crypto.js';

const APP_ORIGIN = 'https://musixquare.com';
const REMOTE_ORIGIN = 'https://share.musixquare.com';
const DEFAULT_BYTES = 32;
const MAX_SMOKE_BYTES = 1024 * 1024;
const FILE_NAME = 'live-remote-share-smoke.wav';
const FILE_MIME = 'audio/wav';
const REQUEST_TIMEOUT_MS = 30_000;
const WORKER_PROPAGATION_TIMEOUT_MS = 30_000;
const WORKER_RETRY_INTERVAL_MS = 1_000;
const R2_CORS_PROPAGATION_TIMEOUT_MS = 45_000;
const R2_CORS_RETRY_INTERVAL_MS = 2_000;

interface RemoteShareSession {
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  completeToken: string;
  objectId: string;
  downloadUrl: string;
  cleanupToken: string;
  queueItemId: string;
  sessionId: number;
}

interface PlainRemoteShareSession {
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  completeToken: string;
  objectId: string;
  cleanupToken: string;
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

async function waitForRemoteShareWorkerReady(): Promise<void> {
  const deadline = Date.now() + WORKER_PROPAGATION_TIMEOUT_MS;
  let consecutiveReadyReads = 0;

  for (;;) {
    const response = await fetchWithTimeout(`${REMOTE_ORIGIN}/security-config`, {
      headers: { Accept: 'application/json', Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(response, 'remote-share readiness');
    const config = await readJson(response, 'remote-share readiness');
    if (
      typeof config.capabilityRequired !== 'boolean' ||
      config.scope !== 'remote-share' ||
      typeof config.ttl !== 'number'
    ) {
      throw new Error('remote-share readiness returned invalid security config');
    }

    const plainWholeReady =
      config.plainWholeObjectVersion === 1 && config.downloadAuthorizationVersion === 1;
    if (config.workerContractVersion === 1 && plainWholeReady) {
      consecutiveReadyReads += 1;
      if (consecutiveReadyReads >= 2) return;
    } else consecutiveReadyReads = 0;

    if (Date.now() >= deadline) {
      throw new Error('remote-share readiness did not converge');
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(WORKER_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now()))),
    );
  }
}

async function readJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
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
  if (config.capabilityRequired !== true) return '';

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
  encryptedBlob: Blob,
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
      encryptedSize: encryptedBlob.size,
    }),
  });
  assertAllowedOrigin(response, 'remote-share session');
  const session = await readJson(response, 'remote-share session');
  if (
    typeof session.uploadUrl !== 'string' ||
    typeof session.completeToken !== 'string' ||
    typeof session.objectId !== 'string' ||
    typeof session.downloadUrl !== 'string' ||
    typeof session.cleanupToken !== 'string' ||
    !session.uploadHeaders ||
    typeof session.uploadHeaders !== 'object' ||
    Array.isArray(session.uploadHeaders) ||
    !Object.values(session.uploadHeaders).every((value) => typeof value === 'string')
  ) {
    throw new Error('invalid remote-share session response');
  }
  return { ...session, queueItemId, sessionId } as unknown as RemoteShareSession;
}

async function requestPlainSession(
  token: string,
  roomId: string,
  queueItemId: string,
  sessionId: number,
  sourceFile: File,
): Promise<PlainRemoteShareSession> {
  const response = await fetchWithTimeout(`${REMOTE_ORIGIN}/v3/plain/session`, {
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
    }),
  });
  assertAllowedOrigin(response, 'plaintext remote-share session');
  const session = await readJson(response, 'plaintext remote-share session');
  if (
    typeof session.uploadUrl !== 'string' ||
    typeof session.completeToken !== 'string' ||
    typeof session.objectId !== 'string' ||
    typeof session.cleanupToken !== 'string' ||
    !session.uploadHeaders ||
    typeof session.uploadHeaders !== 'object' ||
    Array.isArray(session.uploadHeaders) ||
    !Object.values(session.uploadHeaders).every((value) => typeof value === 'string')
  ) {
    throw new Error('invalid plaintext remote-share session response');
  }
  return { ...session, queueItemId, sessionId } as unknown as PlainRemoteShareSession;
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

function assertUploadMetadata(session: RemoteShareSession, sourceFile: File): void {
  const normalized = Object.fromEntries(
    Object.entries(session.uploadHeaders).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const expected: Record<string, string> = {
    'content-type': 'application/octet-stream',
    // The Worker percent-encodes metadata before signing it so R2 headers stay
    // ASCII-safe; the download path decodes these values for product use.
    'x-amz-meta-name': encodeURIComponent(sourceFile.name),
    'x-amz-meta-mime': encodeURIComponent(sourceFile.type),
    'x-amz-meta-size-bytes': String(sourceFile.size),
    'x-amz-meta-encrypted-size': String(sourceFile.size + 16),
    'x-amz-meta-object-id': session.objectId,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (normalized[name] !== value) {
      throw new Error(`remote-share upload metadata mismatch for ${name}`);
    }
  }
}

function assertPlainUploadMetadata(session: PlainRemoteShareSession, sourceFile: File): void {
  const normalized = Object.fromEntries(
    Object.entries(session.uploadHeaders).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const expected: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-amz-meta-name': encodeURIComponent(sourceFile.name),
    'x-amz-meta-mime': encodeURIComponent(sourceFile.type),
    'x-amz-meta-size-bytes': String(sourceFile.size),
    'x-amz-meta-format-version': 'plain-whole-object-v1',
    'x-amz-meta-object-id': session.objectId,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (normalized[name] !== value) {
      throw new Error(`plaintext remote-share upload metadata mismatch for ${name}`);
    }
  }
  if ('x-amz-meta-encrypted-size' in normalized) {
    throw new Error('plaintext remote-share upload exposed encrypted-size metadata');
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
    await response.text();
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

async function completePlainUpload(
  session: PlainRemoteShareSession,
  roomId: string,
): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(`${REMOTE_ORIGIN}/v3/plain/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
    body: JSON.stringify({
      roomId,
      objectId: session.objectId,
      completeToken: session.completeToken,
    }),
  });
  assertAllowedOrigin(response, 'plaintext remote-share complete');
  return readJson(response, 'plaintext remote-share complete');
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

async function cleanupPlain(session: PlainRemoteShareSession, roomId: string): Promise<Response> {
  return fetchWithTimeout(`${REMOTE_ORIGIN}/v3/plain/object/${roomId}/${session.objectId}`, {
    method: 'DELETE',
    headers: {
      Origin: APP_ORIGIN,
      'X-MXQR-Cleanup-Token': session.cleanupToken,
    },
  });
}

async function runEncryptedWholeSmoke(
  token: string,
  roomId: string,
  sourceBytes: Uint8Array<ArrayBuffer>,
): Promise<Record<string, unknown>> {
  const queueItemId = randomUUID();
  const sessionId = Date.now();
  const sourceFile = new File([sourceBytes], FILE_NAME, {
    type: FILE_MIME,
  });
  const expectedSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const encrypted = await encryptFile(sourceFile);
  let session: RemoteShareSession | undefined;
  let cleaned = false;

  try {
    session = await requestSession(
      token,
      roomId,
      queueItemId,
      sessionId,
      sourceFile,
      encrypted.encryptedBlob,
    );
    assertSessionPlaybackContext(session, queueItemId, sessionId);
    assertUploadMetadata(session, sourceFile);
    await assertUploadCors(session);

    const upload = await fetchWithTimeout(session.uploadUrl, {
      method: 'PUT',
      headers: { ...session.uploadHeaders, Origin: APP_ORIGIN },
      body: encrypted.encryptedBlob,
    });
    if (!upload.ok) throw new Error(`R2 direct PUT HTTP ${upload.status}`);
    assertAllowedOrigin(upload, 'R2 direct PUT');

    const completed = await completeUpload(session, roomId);
    const completedObjectId = completed.objectId;
    const completedDownloadUrl = completed.downloadUrl;
    if (
      completedObjectId !== session.objectId ||
      session.queueItemId !== queueItemId ||
      session.sessionId !== sessionId ||
      typeof completedDownloadUrl !== 'string' ||
      !completedDownloadUrl
    ) {
      throw new Error('invalid remote-share completion response');
    }

    const download = await fetchWithTimeout(completedDownloadUrl, {
      headers: { Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(download, 'remote-share download');
    if (!download.ok) throw new Error(`remote-share download HTTP ${download.status}`);
    const downloadedEncrypted = await download.arrayBuffer();
    if (downloadedEncrypted.byteLength !== encrypted.encryptedBlob.size) {
      throw new Error('remote-share encrypted download size mismatch');
    }
    const decrypted = await decryptToFile(
      downloadedEncrypted,
      encrypted.keyB64,
      encrypted.ivB64,
      sourceFile.name,
      sourceFile.type,
    );
    const decryptedBytes = new Uint8Array(await decrypted.arrayBuffer());
    const actualSha256 = createHash('sha256').update(decryptedBytes).digest('hex');
    if (decryptedBytes.byteLength !== sourceBytes.byteLength || actualSha256 !== expectedSha256) {
      throw new Error('remote-share decrypted plaintext mismatch');
    }
    if (decrypted.name !== sourceFile.name || decrypted.type !== sourceFile.type) {
      throw new Error('remote-share decrypted file metadata mismatch');
    }

    const deleted = await cleanup(session, roomId);
    assertAllowedOrigin(deleted, 'remote-share cleanup');
    await readJson(deleted, 'remote-share cleanup');
    cleaned = true;

    const afterDelete = await fetchWithTimeout(completedDownloadUrl, {
      headers: { Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(afterDelete, 'remote-share deleted-object lookup');
    if (afterDelete.status !== 404) {
      throw new Error(`deleted object returned HTTP ${afterDelete.status}, expected 404`);
    }

    return {
      bytes: sourceFile.size,
      encryptedBytes: encrypted.encryptedBlob.size,
      directR2Put: true,
      corsPreflight: true,
      workerCors: ['session', 'complete', 'download', 'cleanup', 'deleted-object'],
      productCryptoRoundTrip: true,
      plaintextSha256Match: true,
      metadataMatch: true,
      cleanupStatus: deleted.status,
      afterCleanupStatus: afterDelete.status,
    };
  } finally {
    if (session && !cleaned) await cleanup(session, roomId).catch(() => undefined);
  }
}

async function runPlainWholeSmoke(
  token: string,
  roomId: string,
  sourceBytes: Uint8Array<ArrayBuffer>,
): Promise<Record<string, unknown>> {
  const queueItemId = randomUUID();
  const sessionId = Date.now() + 1;
  const sourceFile = new File([sourceBytes], FILE_NAME, { type: FILE_MIME });
  const expectedSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  let session: PlainRemoteShareSession | undefined;
  let cleaned = false;

  try {
    session = await requestPlainSession(token, roomId, queueItemId, sessionId, sourceFile);
    assertSessionPlaybackContext(session, queueItemId, sessionId);
    assertPlainUploadMetadata(session, sourceFile);
    await assertUploadCors(session);

    const upload = await fetchWithTimeout(session.uploadUrl, {
      method: 'PUT',
      headers: { ...session.uploadHeaders, Origin: APP_ORIGIN },
      body: sourceFile,
    });
    if (!upload.ok) throw new Error(`plaintext R2 direct PUT HTTP ${upload.status}`);
    assertAllowedOrigin(upload, 'plaintext R2 direct PUT');

    const completed = await completePlainUpload(session, roomId);
    const downloadUrl = completed.downloadUrl;
    const downloadToken = completed.downloadToken;
    if (
      completed.objectId !== session.objectId ||
      typeof downloadUrl !== 'string' ||
      downloadUrl !== `${REMOTE_ORIGIN}/v3/plain/download/${roomId}/${session.objectId}` ||
      typeof downloadToken !== 'string' ||
      downloadToken.length < 32 ||
      downloadUrl.includes(downloadToken)
    ) {
      throw new Error('invalid plaintext remote-share completion response');
    }

    const unauthorized = await fetchWithTimeout(downloadUrl, {
      headers: { Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(unauthorized, 'plaintext unauthorized download');
    if (unauthorized.status !== 401) {
      throw new Error(`unauthorized plaintext download returned HTTP ${unauthorized.status}`);
    }
    await unauthorized.body?.cancel().catch(() => undefined);

    const range = await fetchWithTimeout(downloadUrl, {
      headers: {
        Authorization: `Bearer ${downloadToken}`,
        Origin: APP_ORIGIN,
        Range: 'bytes=0-0',
      },
    });
    assertAllowedOrigin(range, 'plaintext Range rejection');
    if (range.status !== 416) {
      throw new Error(`plaintext Range returned HTTP ${range.status}, expected 416`);
    }
    await range.body?.cancel().catch(() => undefined);

    const download = await fetchWithTimeout(downloadUrl, {
      headers: { Authorization: `Bearer ${downloadToken}`, Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(download, 'plaintext authorized download');
    if (!download.ok) throw new Error(`plaintext remote-share download HTTP ${download.status}`);
    if (download.headers.get('cache-control') !== 'no-store') {
      throw new Error('plaintext remote-share download is cacheable');
    }
    const downloadedBytes = new Uint8Array(await download.arrayBuffer());
    const actualSha256 = createHash('sha256').update(downloadedBytes).digest('hex');
    if (downloadedBytes.byteLength !== sourceBytes.byteLength || actualSha256 !== expectedSha256) {
      throw new Error('plaintext remote-share byte mismatch');
    }

    const deleted = await cleanupPlain(session, roomId);
    assertAllowedOrigin(deleted, 'plaintext remote-share cleanup');
    await readJson(deleted, 'plaintext remote-share cleanup');
    cleaned = true;

    const afterDelete = await fetchWithTimeout(downloadUrl, {
      headers: { Authorization: `Bearer ${downloadToken}`, Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(afterDelete, 'plaintext deleted-object lookup');
    if (afterDelete.status !== 404) {
      throw new Error(`deleted plaintext object returned HTTP ${afterDelete.status}, expected 404`);
    }
    await afterDelete.body?.cancel().catch(() => undefined);

    return {
      storageFormat: 'plain-whole-v1',
      bytes: sourceFile.size,
      directR2Put: true,
      corsPreflight: true,
      exactPlaintextRoundTrip: true,
      bearerHeaderOnly: true,
      unauthorizedReadRejected: true,
      rangeRejected: true,
      noStore: true,
      cleanupStatus: deleted.status,
      afterCleanupStatus: afterDelete.status,
    };
  } finally {
    if (session && !cleaned) await cleanupPlain(session, roomId).catch(() => undefined);
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
  const encryptedWhole = await runEncryptedWholeSmoke(token, roomId, sourceBytes);
  const plainWhole = await runPlainWholeSmoke(token, roomId, sourceBytes);

  console.log(
    JSON.stringify({
      ok: true,
      encryptedWhole,
      plainWhole,
    }),
  );
}

await main();
