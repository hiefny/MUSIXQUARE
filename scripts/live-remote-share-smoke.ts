#!/usr/bin/env node

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

import { decryptToFile, encryptFile } from '../src/share/crypto.js';
import { R2RecordCryptoV2 } from '../src/share/r2-record-crypto-v2.js';

const APP_ORIGIN = 'https://musixquare.com';
const REMOTE_ORIGIN = 'https://share.musixquare.com';
const DEFAULT_BYTES = 32;
const MAX_SMOKE_BYTES = 1024 * 1024;
const FILE_NAME = 'live-remote-share-smoke.wav';
const FILE_MIME = 'audio/wav';
const REQUEST_TIMEOUT_MS = 30_000;
const RECORD_SET_VERSION = 2;
const RECORD_SIZE = R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V8_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

interface RemoteRecordSetRecord {
  index: number;
  objectId: string;
  plaintextSize: number;
  encryptedSize: number;
  downloadUrl: string;
}

interface RemoteRecordSetSession {
  v: typeof RECORD_SET_VERSION;
  setId: string;
  recordSize: number;
  recordCount: number;
  expiresAt: number;
  setToken: string;
  cleanupToken: string;
  records: RemoteRecordSetRecord[];
}

interface RemoteRecordUploadAuthority extends RemoteRecordSetRecord {
  v: typeof RECORD_SET_VERSION;
  setId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
  uploadUrlExpiresAt: number;
  expiresAt: number;
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

async function assertUploadCors(target: UploadTarget): Promise<void> {
  const requestedHeaders = Object.keys(target.uploadHeaders).join(',');
  const response = await fetchWithTimeout(target.uploadUrl, {
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

async function requestRecordSet(
  token: string,
  roomId: string,
  queueItemId: string,
  applicationSessionId: string,
  sourceIdentity: string,
  sourceFile: File,
): Promise<RemoteRecordSetSession> {
  const response = await fetchWithTimeout(`${REMOTE_ORIGIN}/v2/sets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: APP_ORIGIN,
      ...(token ? { 'X-MXQR-Capability': token } : {}),
    },
    body: JSON.stringify({
      roomId,
      sessionId: applicationSessionId,
      queueItemId,
      sourceIdentity,
      name: sourceFile.name,
      mime: sourceFile.type,
      size: sourceFile.size,
      recordSize: RECORD_SIZE,
      recordCount: 1,
    }),
  });
  assertAllowedOrigin(response, 'remote-share V2 record set');
  const value = await readJson(response, 'remote-share V2 record set');
  const records = value.records;
  if (
    value.v !== RECORD_SET_VERSION ||
    typeof value.setId !== 'string' ||
    !UUID_V4_RE.test(value.setId) ||
    value.recordSize !== RECORD_SIZE ||
    value.recordCount !== 1 ||
    typeof value.expiresAt !== 'number' ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= Date.now() ||
    typeof value.setToken !== 'string' ||
    !value.setToken.includes('.') ||
    typeof value.cleanupToken !== 'string' ||
    !UUID_V4_RE.test(value.cleanupToken) ||
    !Array.isArray(records) ||
    records.length !== 1
  ) {
    throw new Error('invalid remote-share V2 record set response');
  }
  const record = records[0] as Record<string, unknown> | undefined;
  if (
    !record ||
    record.index !== 0 ||
    typeof record.objectId !== 'string' ||
    !UUID_V8_RE.test(record.objectId) ||
    record.plaintextSize !== sourceFile.size ||
    record.encryptedSize !== sourceFile.size + R2RecordCryptoV2.AES_GCM_TAG_BYTES ||
    record.downloadUrl !== `${REMOTE_ORIGIN}/download/${roomId}/${record.objectId}`
  ) {
    throw new Error('invalid remote-share V2 record descriptor');
  }
  return {
    v: RECORD_SET_VERSION,
    setId: value.setId,
    recordSize: RECORD_SIZE,
    recordCount: 1,
    expiresAt: value.expiresAt,
    setToken: value.setToken,
    cleanupToken: value.cleanupToken,
    records: [
      {
        index: 0,
        objectId: record.objectId,
        plaintextSize: sourceFile.size,
        encryptedSize: sourceFile.size + R2RecordCryptoV2.AES_GCM_TAG_BYTES,
        downloadUrl: record.downloadUrl,
      },
    ],
  };
}

async function requestRecordUploadAuthority(
  roomId: string,
  session: RemoteRecordSetSession,
): Promise<RemoteRecordUploadAuthority> {
  const record = session.records[0];
  const response = await fetchWithTimeout(
    `${REMOTE_ORIGIN}/v2/sets/${roomId}/${session.setId}/records/0/upload`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({ setToken: session.setToken }),
    },
  );
  assertAllowedOrigin(response, 'remote-share V2 record upload authority');
  const value = await readJson(response, 'remote-share V2 record upload authority');
  if (
    value.v !== RECORD_SET_VERSION ||
    value.setId !== session.setId ||
    value.index !== 0 ||
    value.objectId !== record.objectId ||
    value.plaintextSize !== record.plaintextSize ||
    value.encryptedSize !== record.encryptedSize ||
    typeof value.uploadUrl !== 'string' ||
    !value.uploadUrl.startsWith('https://') ||
    !value.uploadHeaders ||
    typeof value.uploadHeaders !== 'object' ||
    Array.isArray(value.uploadHeaders) ||
    !Object.values(value.uploadHeaders).every((header) => typeof header === 'string') ||
    typeof value.uploadUrlExpiresAt !== 'number' ||
    !Number.isSafeInteger(value.uploadUrlExpiresAt) ||
    value.uploadUrlExpiresAt <= Date.now() ||
    value.expiresAt !== session.expiresAt ||
    value.downloadUrl !== record.downloadUrl
  ) {
    throw new Error('invalid remote-share V2 record upload authority');
  }
  return {
    v: RECORD_SET_VERSION,
    setId: session.setId,
    index: 0,
    objectId: record.objectId,
    plaintextSize: record.plaintextSize,
    encryptedSize: record.encryptedSize,
    downloadUrl: record.downloadUrl,
    uploadUrl: value.uploadUrl,
    uploadHeaders: value.uploadHeaders as Record<string, string>,
    uploadUrlExpiresAt: value.uploadUrlExpiresAt,
    expiresAt: session.expiresAt,
  };
}

function assertRecordUploadMetadata(
  authority: RemoteRecordUploadAuthority,
  session: RemoteRecordSetSession,
  roomId: string,
  queueItemId: string,
  applicationSessionId: string,
  sourceIdentity: string,
  sourceFile: File,
): void {
  const normalized = Object.fromEntries(
    Object.entries(authority.uploadHeaders).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const expected: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'x-amz-meta-cleanup-token': session.cleanupToken,
    'x-amz-meta-encrypted-size': String(authority.encryptedSize),
    'x-amz-meta-expires-at': String(session.expiresAt),
    'x-amz-meta-format-version': String(RECORD_SET_VERSION),
    'x-amz-meta-mime': encodeURIComponent(sourceFile.type),
    'x-amz-meta-name': encodeURIComponent(sourceFile.name),
    'x-amz-meta-object-id': authority.objectId,
    'x-amz-meta-queue-item-id': queueItemId,
    'x-amz-meta-record-count': '1',
    'x-amz-meta-record-index': '0',
    'x-amz-meta-record-size': String(RECORD_SIZE),
    'x-amz-meta-room-id': roomId,
    'x-amz-meta-session-id-sha256': createHash('sha256').update(applicationSessionId).digest('hex'),
    'x-amz-meta-set-id': session.setId,
    'x-amz-meta-size-bytes': String(sourceFile.size),
    'x-amz-meta-source-identity-sha256': createHash('sha256').update(sourceIdentity).digest('hex'),
    'x-amz-meta-total-size-bytes': String(sourceFile.size),
  };
  if (
    Object.keys(normalized).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([name, value]) => normalized[name] !== value)
  ) {
    throw new Error('remote-share V2 record upload metadata mismatch');
  }
}

async function completeRecordUpload(
  roomId: string,
  session: RemoteRecordSetSession,
): Promise<string> {
  const record = session.records[0];
  const response = await fetchWithTimeout(
    `${REMOTE_ORIGIN}/v2/sets/${roomId}/${session.setId}/records/0/complete`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({ setToken: session.setToken }),
    },
  );
  assertAllowedOrigin(response, 'remote-share V2 record completion');
  const value = await readJson(response, 'remote-share V2 record completion');
  if (
    value.v !== RECORD_SET_VERSION ||
    value.setId !== session.setId ||
    value.index !== 0 ||
    value.objectId !== record.objectId ||
    value.expiresAt !== session.expiresAt ||
    value.readyRecordCount !== 1 ||
    value.recordCount !== 1 ||
    value.complete !== true ||
    value.downloadUrl !== record.downloadUrl
  ) {
    throw new Error('invalid remote-share V2 record completion response');
  }
  return record.downloadUrl;
}

async function cleanupRecordSet(
  roomId: string,
  session: RemoteRecordSetSession,
): Promise<Response> {
  return fetchWithTimeout(`${REMOTE_ORIGIN}/v2/sets/${roomId}/${session.setId}`, {
    method: 'DELETE',
    headers: {
      Origin: APP_ORIGIN,
      'X-MXQR-Cleanup-Token': session.cleanupToken,
    },
  });
}

async function runV1Smoke(
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

async function runRecordSetSmoke(
  token: string,
  roomId: string,
  sourceBytes: Uint8Array<ArrayBuffer>,
): Promise<Record<string, unknown>> {
  const queueItemId = randomUUID();
  const applicationSessionId = `live-remote-share-smoke:${randomUUID()}`;
  const sourceIdentity = `live-remote-share-smoke:${randomUUID()}`;
  const sourceFile = new File([sourceBytes], FILE_NAME, { type: FILE_MIME });
  let session: RemoteRecordSetSession | undefined;
  let cleaned = false;
  let encryptor: Awaited<ReturnType<typeof R2RecordCryptoV2.createEncryptor>> | undefined;
  let decryptor: Awaited<ReturnType<typeof R2RecordCryptoV2.createDecryptor>> | undefined;

  try {
    session = await requestRecordSet(
      token,
      roomId,
      queueItemId,
      applicationSessionId,
      sourceIdentity,
      sourceFile,
    );
    encryptor = await R2RecordCryptoV2.createEncryptor(session.setId, sourceFile.size);
    const secret = encryptor.takeSecretDescriptor();
    const lease = await encryptor.encryptRecord(0, sourceBytes);
    const ciphertext = lease.bytesForUpload();
    const expectedCiphertext = new Uint8Array(await ciphertext.arrayBuffer());
    if (
      ciphertext.size !== session.records[0].encryptedSize ||
      expectedCiphertext.byteLength !== sourceFile.size + R2RecordCryptoV2.AES_GCM_TAG_BYTES
    ) {
      throw new Error('remote-share V2 record ciphertext size mismatch');
    }

    const authority = await requestRecordUploadAuthority(roomId, session);
    assertRecordUploadMetadata(
      authority,
      session,
      roomId,
      queueItemId,
      applicationSessionId,
      sourceIdentity,
      sourceFile,
    );
    await assertUploadCors(authority);

    const upload = await fetchWithTimeout(authority.uploadUrl, {
      method: 'PUT',
      headers: { ...authority.uploadHeaders, Origin: APP_ORIGIN },
      body: ciphertext,
    });
    if (!upload.ok) throw new Error(`R2 V2 record direct PUT HTTP ${upload.status}`);
    assertAllowedOrigin(upload, 'R2 V2 record direct PUT');
    lease.acknowledgeUploaded();

    const downloadUrl = await completeRecordUpload(roomId, session);
    const download = await fetchWithTimeout(downloadUrl, {
      headers: { Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(download, 'remote-share V2 record download');
    if (!download.ok) throw new Error(`remote-share V2 record download HTTP ${download.status}`);
    const downloadedCiphertext = new Uint8Array(await download.arrayBuffer());
    if (
      downloadedCiphertext.byteLength !== expectedCiphertext.byteLength ||
      Buffer.compare(Buffer.from(downloadedCiphertext), Buffer.from(expectedCiphertext)) !== 0
    ) {
      throw new Error('remote-share V2 downloaded ciphertext mismatch');
    }

    decryptor = await R2RecordCryptoV2.createDecryptor(secret);
    const decrypted = await decryptor.decryptRecord(0, downloadedCiphertext);
    if (
      decrypted.byteLength !== sourceBytes.byteLength ||
      Buffer.compare(Buffer.from(decrypted), Buffer.from(sourceBytes)) !== 0
    ) {
      throw new Error('remote-share V2 decrypted plaintext mismatch');
    }

    const deleted = await cleanupRecordSet(roomId, session);
    assertAllowedOrigin(deleted, 'remote-share V2 record-set cleanup');
    await readJson(deleted, 'remote-share V2 record-set cleanup');
    cleaned = true;

    const afterDelete = await fetchWithTimeout(downloadUrl, {
      headers: { Origin: APP_ORIGIN },
    });
    assertAllowedOrigin(afterDelete, 'remote-share V2 deleted-record lookup');
    if (afterDelete.status !== 404) {
      throw new Error(`deleted V2 record returned HTTP ${afterDelete.status}, expected 404`);
    }

    return {
      version: RECORD_SET_VERSION,
      recordCount: session.recordCount,
      plaintextBytes: sourceFile.size,
      ciphertextBytes: expectedCiphertext.byteLength,
      exactCiphertextRoundTrip: true,
      productCryptoRoundTrip: true,
      firstRecordReady: true,
      directR2Put: true,
      corsPreflight: true,
      metadataMatch: true,
      cleanupStatus: deleted.status,
      afterCleanupStatus: afterDelete.status,
    };
  } finally {
    decryptor?.dispose();
    encryptor?.dispose();
    if (session && !cleaned) await cleanupRecordSet(roomId, session).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const byteCount = parseByteCount();
  const v1Only = process.argv.includes('--v1-only');
  // Exercise the same namespace the product can actually allocate. The object
  // UUID still makes concurrent smoke objects unique if two runs pick the same
  // six-digit room code.
  const roomId = String(randomInt(100_000, 1_000_000));
  const sourceBytes = new Uint8Array(randomBytes(byteCount));
  const token = await requestCapabilityToken();
  const v1 = await runV1Smoke(token, roomId, sourceBytes);
  const recordSetV2 = v1Only ? undefined : await runRecordSetSmoke(token, roomId, sourceBytes);

  console.log(
    JSON.stringify({
      ok: true,
      ...v1,
      ...(recordSetV2 ? { recordSetV2 } : {}),
    }),
  );
}

await main();
