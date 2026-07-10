#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';

const APP_ORIGIN = 'https://musixquare.com';
const REMOTE_ORIGIN = 'https://share.musixquare.com';
const DEFAULT_BYTES = 32;
const MAX_SMOKE_BYTES = 1024 * 1024;

function parseByteCount() {
  const option = process.argv.find((value) => value.startsWith('--bytes='));
  const value = Number(option?.slice('--bytes='.length) || DEFAULT_BYTES);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SMOKE_BYTES) {
    throw new Error(`--bytes must be an integer between 1 and ${MAX_SMOKE_BYTES}`);
  }
  return value;
}

async function readJson(response, label) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function requestCapabilityToken() {
  if (process.env.MXQR_CAPABILITY_TOKEN) return process.env.MXQR_CAPABILITY_TOKEN.trim();

  const config = await readJson(
    await fetch(`${APP_ORIGIN}/api/security-config`, {
      headers: { Accept: 'application/json', Origin: APP_ORIGIN },
    }),
    'security config',
  );
  if (config.capabilityRequired !== true) return '';

  const response = await fetch(`${APP_ORIGIN}/api/capability-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
    body: JSON.stringify({ scopes: ['remote-share'] }),
  });
  const payload = await readJson(response, 'capability token');
  if (typeof payload.token !== 'string' || !payload.token) {
    throw new Error('capability token missing');
  }
  return payload.token;
}

async function requestSession(token, roomId, bytes) {
  const response = await fetch(`${REMOTE_ORIGIN}/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: APP_ORIGIN,
      ...(token ? { 'X-MXQR-Capability': token } : {}),
    },
    body: JSON.stringify({
      roomId,
      sessionId: Date.now(),
      index: 0,
      name: 'live-remote-share-smoke.bin',
      mime: 'application/octet-stream',
      size: bytes.byteLength,
      encryptedSize: bytes.byteLength,
    }),
  });
  const session = await readJson(response, 'remote-share session');
  if (
    typeof session.uploadUrl !== 'string' ||
    typeof session.completeToken !== 'string' ||
    typeof session.objectId !== 'string' ||
    typeof session.downloadUrl !== 'string' ||
    typeof session.cleanupToken !== 'string' ||
    !session.uploadHeaders ||
    typeof session.uploadHeaders !== 'object'
  ) {
    throw new Error('invalid remote-share session response');
  }
  return session;
}

async function assertUploadCors(session) {
  const requestedHeaders = Object.keys(session.uploadHeaders).join(',');
  const response = await fetch(session.uploadUrl, {
    method: 'OPTIONS',
    headers: {
      Origin: APP_ORIGIN,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': requestedHeaders,
    },
  });
  if (!response.ok) throw new Error(`R2 CORS preflight HTTP ${response.status}`);
  if (response.headers.get('access-control-allow-origin') !== APP_ORIGIN) {
    throw new Error('R2 CORS origin mismatch');
  }
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

async function completeUpload(session, roomId) {
  return readJson(
    await fetch(`${REMOTE_ORIGIN}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      body: JSON.stringify({
        roomId,
        objectId: session.objectId,
        completeToken: session.completeToken,
      }),
    }),
    'remote-share complete',
  );
}

async function cleanup(session, roomId) {
  return fetch(`${REMOTE_ORIGIN}/object/${roomId}/${session.objectId}`, {
    method: 'DELETE',
    headers: {
      Origin: APP_ORIGIN,
      'X-MXQR-Cleanup-Token': session.cleanupToken,
    },
  });
}

async function main() {
  const byteCount = parseByteCount();
  const roomId = `live-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const source = randomBytes(byteCount);
  const expectedSha256 = createHash('sha256').update(source).digest('hex');
  const token = await requestCapabilityToken();
  let session;
  let cleaned = false;

  try {
    session = await requestSession(token, roomId, source);
    await assertUploadCors(session);

    const upload = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: { ...session.uploadHeaders, Origin: APP_ORIGIN },
      body: source,
    });
    if (!upload.ok) throw new Error(`R2 direct PUT HTTP ${upload.status}`);
    if (upload.headers.get('access-control-allow-origin') !== APP_ORIGIN) {
      throw new Error('R2 direct PUT CORS origin mismatch');
    }

    const completed = await completeUpload(session, roomId);
    if (completed.objectId !== session.objectId) throw new Error('completion object mismatch');

    const download = await fetch(session.downloadUrl, { headers: { Origin: APP_ORIGIN } });
    if (!download.ok) throw new Error(`remote-share download HTTP ${download.status}`);
    const downloaded = Buffer.from(await download.arrayBuffer());
    const actualSha256 = createHash('sha256').update(downloaded).digest('hex');
    if (downloaded.byteLength !== source.byteLength || actualSha256 !== expectedSha256) {
      throw new Error('remote-share download byte mismatch');
    }

    const deleted = await cleanup(session, roomId);
    await readJson(deleted, 'remote-share cleanup');
    cleaned = true;
    const afterDelete = await fetch(session.downloadUrl, { headers: { Origin: APP_ORIGIN } });
    if (afterDelete.status !== 404) {
      throw new Error(`deleted object returned HTTP ${afterDelete.status}, expected 404`);
    }

    console.log(
      JSON.stringify({
        ok: true,
        bytes: byteCount,
        directR2Put: true,
        corsPreflight: true,
        sha256Match: true,
        cleanupStatus: deleted.status,
        afterCleanupStatus: afterDelete.status,
      }),
    );
  } finally {
    if (session && !cleaned) await cleanup(session, roomId).catch(() => undefined);
  }
}

await main();
