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

function assertSessionPlaybackContext(
  session: RemoteShareSession,
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

async function assertUploadCors(session: RemoteShareSession): Promise<void> {
  const requestedHeaders = Object.keys(session.uploadHeaders).join(',');
  const response = await fetchWithTimeout(session.uploadUrl, {
    method: 'OPTIONS',
    headers: {
      Origin: APP_ORIGIN,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': requestedHeaders,
    },
  });
  if (!response.ok) throw new Error(`R2 CORS preflight HTTP ${response.status}`);
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
  for (const name of Object.keys(session.uploadHeaders)) {
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

async function main(): Promise<void> {
  const byteCount = parseByteCount();
  // Exercise the same namespace the product can actually allocate. The object
  // UUID still makes concurrent smoke objects unique if two runs pick the same
  // six-digit room code.
  const roomId = String(randomInt(100_000, 1_000_000));
  const queueItemId = randomUUID();
  const sessionId = Date.now();
  const sourceBytes = new Uint8Array(randomBytes(byteCount));
  const sourceFile = new File([sourceBytes], FILE_NAME, {
    type: FILE_MIME,
  });
  const expectedSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const encrypted = await encryptFile(sourceFile);
  const token = await requestCapabilityToken();
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
    const completedDescriptor = {
      ...completed,
      queueItemId: session.queueItemId,
      sessionId: session.sessionId,
    };
    if (
      completedDescriptor.objectId !== session.objectId ||
      completedDescriptor.queueItemId !== queueItemId ||
      completedDescriptor.sessionId !== sessionId ||
      typeof completedDescriptor.downloadUrl !== 'string' ||
      !completedDescriptor.downloadUrl
    ) {
      throw new Error('invalid remote-share completion response');
    }

    const download = await fetchWithTimeout(completedDescriptor.downloadUrl, {
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

    const afterDelete = await fetchWithTimeout(completedDescriptor.downloadUrl, {
      headers: { Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(afterDelete, 'remote-share deleted-object lookup');
    if (afterDelete.status !== 404) {
      throw new Error(`deleted object returned HTTP ${afterDelete.status}, expected 404`);
    }

    console.log(
      JSON.stringify({
        ok: true,
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
      }),
    );
  } finally {
    if (session && !cleaned) await cleanup(session, roomId).catch(() => undefined);
  }
}

await main();
