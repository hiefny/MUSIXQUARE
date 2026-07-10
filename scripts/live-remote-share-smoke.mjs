#!/usr/bin/env node

import { createHash } from 'node:crypto';

const APP_ORIGIN = 'https://musixquare.com';
const REMOTE_ORIGIN = 'https://share.musixquare.com';
const CHUNK_BYTES = 8 * 1024 * 1024;
const TAG_BYTES = 16;
const DEFAULT_PLAIN_BYTES = CHUNK_BYTES + 1;

function parsePlainBytes() {
  const option = process.argv.find((value) => value.startsWith('--plain-bytes='));
  const value = Number(option?.slice('--plain-bytes='.length) || DEFAULT_PLAIN_BYTES);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 5 * 1024 * 1024 * 1024) {
    throw new Error('plain byte count must be between 1 and 5 GiB');
  }
  return value;
}

function hasLeadingZeroBits(bytes, difficulty) {
  let remaining = difficulty;
  for (const byte of bytes) {
    if (remaining <= 0) return true;
    const bits = Math.min(8, remaining);
    if ((byte & (0xff << (8 - bits))) !== 0) return false;
    remaining -= bits;
  }
  return remaining <= 0;
}

function solveProofOfWork(challenge, difficulty, expiresAt) {
  if (!challenge || !Number.isInteger(difficulty) || difficulty < 8 || difficulty > 24) {
    throw new Error('invalid proof-of-work challenge');
  }
  const prefix = `mxqr-pow-v1:${challenge}:`;
  for (let solution = 0; solution < Number.MAX_SAFE_INTEGER; solution += 1) {
    if (solution % 10_000 === 0 && Date.now() / 1000 >= expiresAt) {
      throw new Error('proof-of-work challenge expired');
    }
    const digest = createHash('sha256').update(`${prefix}${solution}`).digest();
    if (hasLeadingZeroBits(digest, difficulty)) return String(solution);
  }
  throw new Error('proof-of-work solution unavailable');
}

async function jsonResponse(response, label) {
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

async function capabilityToken() {
  const commonHeaders = { Origin: APP_ORIGIN, 'Content-Type': 'application/json' };
  const config = await jsonResponse(
    await fetch(`${APP_ORIGIN}/api/security-config`, {
      headers: { Origin: APP_ORIGIN, Accept: 'application/json' },
    }),
    'security config',
  );
  if (!config.capabilityRequired || !config.proofOfWorkRequired) {
    throw new Error('production capability proof-of-work is not enabled');
  }
  const challenge = await jsonResponse(
    await fetch(`${APP_ORIGIN}/api/capability-challenge`, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({ scopes: ['remote-share'] }),
    }),
    'capability challenge',
  );
  const solution = solveProofOfWork(challenge.challenge, challenge.difficulty, challenge.expiresAt);
  const token = await jsonResponse(
    await fetch(`${APP_ORIGIN}/api/capability-token`, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({
        scopes: ['remote-share'],
        proofOfWork: { challenge: challenge.challenge, solution },
      }),
    }),
    'capability token',
  );
  if (typeof token.token !== 'string' || !token.token) throw new Error('capability token missing');
  return token.token;
}

async function requestSession(token, plainBytes, roomId) {
  const chunkCount = Math.ceil(plainBytes / CHUNK_BYTES);
  const encryptedBytes = plainBytes + chunkCount * TAG_BYTES;
  const response = await fetch(`${REMOTE_ORIGIN}/session`, {
    method: 'POST',
    headers: {
      Origin: APP_ORIGIN,
      'Content-Type': 'application/json',
      'X-MXQR-Capability': token,
    },
    body: JSON.stringify({
      protocolVersion: 4,
      roomId,
      sessionId: Date.now(),
      index: 0,
      name: `live-smoke-${plainBytes}.bin`,
      mime: 'application/octet-stream',
      size: plainBytes,
      encryptedSize: encryptedBytes,
      chunkSize: CHUNK_BYTES,
      chunkCount,
      tagBytes: TAG_BYTES,
    }),
  });
  const session = await jsonResponse(response, 'remote share session');
  if (
    session.protocolVersion !== 4 ||
    typeof session.objectId !== 'string' ||
    typeof session.controlToken !== 'string' ||
    typeof session.cleanupToken !== 'string' ||
    typeof session.downloadUrl !== 'string'
  ) {
    throw new Error('invalid v4 session response');
  }
  return { ...session, chunkCount, encryptedBytes };
}

async function requestPartTargets(session, parts) {
  const response = await fetch(`${REMOTE_ORIGIN}/parts`, {
    method: 'POST',
    headers: { Origin: APP_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      objectId: session.objectId,
      controlToken: session.controlToken,
      parts,
    }),
  });
  const body = await jsonResponse(response, 'multipart part URLs');
  if (!Array.isArray(body.parts) || body.parts.length !== parts.length) {
    throw new Error('invalid multipart part URL response');
  }
  return body.parts;
}

async function assertR2Cors(target) {
  const requestedHeaders = Object.keys(target.uploadHeaders).join(',');
  const response = await fetch(target.uploadUrl, {
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
  const allowed = new Set(
    (response.headers.get('access-control-allow-headers') || '')
      .toLowerCase()
      .split(',')
      .map((value) => value.trim()),
  );
  for (const header of Object.keys(target.uploadHeaders)) {
    if (!allowed.has(header.toLowerCase())) throw new Error(`R2 CORS does not allow ${header}`);
  }
}

function opaquePart(plainBytes, partNumber) {
  const bytes = new Uint8Array(plainBytes + TAG_BYTES);
  bytes.fill((partNumber * 37) & 0xff);
  bytes[0] = 0x4d;
  bytes[Math.floor(bytes.length / 2)] = partNumber & 0xff;
  bytes[bytes.length - 1] = 0x51;
  return bytes;
}

async function uploadPart(target, bytes) {
  return fetch(target.uploadUrl, {
    method: 'PUT',
    headers: {
      ...target.uploadHeaders,
      Origin: APP_ORIGIN,
      'Content-Length': String(bytes.byteLength),
    },
    body: bytes,
  });
}

async function complete(session, roomId, parts) {
  return jsonResponse(
    await fetch(`${REMOTE_ORIGIN}/complete`, {
      method: 'POST',
      headers: { Origin: APP_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomId,
        objectId: session.objectId,
        controlToken: session.controlToken,
        parts,
      }),
    }),
    'remote share complete',
  );
}

async function abort(session, roomId) {
  return fetch(`${REMOTE_ORIGIN}/abort`, {
    method: 'POST',
    headers: { Origin: APP_ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomId,
      objectId: session.objectId,
      controlToken: session.controlToken,
    }),
  });
}

async function cleanup(session, roomId) {
  return fetch(`${REMOTE_ORIGIN}/object/${roomId}/${session.objectId}`, {
    method: 'DELETE',
    headers: { Origin: APP_ORIGIN, 'X-MXQR-Cleanup-Token': session.cleanupToken },
  });
}

async function hashDownload(response, expectedBytes) {
  if (!response.body) throw new Error('download body missing');
  const hash = createHash('sha256');
  const reader = response.body.getReader();
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    hash.update(value);
  }
  if (received !== expectedBytes) {
    throw new Error(`download size mismatch: expected ${expectedBytes}, received ${received}`);
  }
  return hash.digest('hex');
}

async function main() {
  const plainBytes = parsePlainBytes();
  const roomId = `live-v4-${Date.now()}`;
  const token = await capabilityToken();
  let session;
  let completed = false;
  let cleaned = false;

  try {
    session = await requestSession(token, plainBytes, roomId);
    const sourceHash = createHash('sha256');
    const uploadedParts = [];
    let firstPartHash = '';
    let firstPartBytes = 0;
    let firstTarget;
    let wrongDigestStatus;

    for (let partNumber = 1; partNumber <= session.chunkCount; partNumber += 1) {
      const plainPartBytes = Math.min(CHUNK_BYTES, plainBytes - (partNumber - 1) * CHUNK_BYTES);
      const bytes = opaquePart(plainPartBytes, partNumber);
      const contentMd5 = createHash('md5').update(bytes).digest('base64');
      const [target] = await requestPartTargets(session, [{ partNumber, contentMd5 }]);
      if (!target) throw new Error(`missing UploadPart target ${partNumber}`);
      sourceHash.update(bytes);
      if (partNumber === 1) {
        firstTarget = target;
        firstPartBytes = bytes.byteLength;
        firstPartHash = createHash('sha256').update(bytes).digest('hex');
        await assertR2Cors(target);

        const tampered = new URL(target.uploadUrl);
        tampered.searchParams.set('partNumber', String(partNumber + 1));
        const tamperedResponse = await uploadPart({ ...target, uploadUrl: tampered }, bytes);
        if (tamperedResponse.status !== 403) {
          throw new Error(`tampered part URL returned ${tamperedResponse.status}, expected 403`);
        }

        const wrongBytes = bytes.slice();
        wrongBytes[Math.floor(wrongBytes.length / 3)] ^= 0xff;
        const wrongDigestResponse = await uploadPart(target, wrongBytes);
        wrongDigestStatus = wrongDigestResponse.status;
        if (wrongDigestResponse.ok) {
          throw new Error('digest-bound UploadPart URL accepted different same-length bytes');
        }
      }
      const response = await uploadPart(target, bytes);
      if (!response.ok) {
        throw new Error(`R2 UploadPart ${partNumber} HTTP ${response.status}`);
      }
      if (response.headers.get('access-control-allow-origin') !== APP_ORIGIN) {
        throw new Error('R2 UploadPart CORS origin mismatch');
      }
      const etag = String(response.headers.get('etag') || '')
        .trim()
        .replace(/^"|"$/g, '');
      if (!/^[a-f0-9]{32}$/i.test(etag)) throw new Error('invalid UploadPart ETag');
      uploadedParts.push({ partNumber, etag });
    }

    const expectedHash = sourceHash.digest('hex');
    const beforeComplete = await fetch(session.downloadUrl, { headers: { Origin: APP_ORIGIN } });
    if (beforeComplete.status !== 404) {
      throw new Error(`incomplete object download returned ${beforeComplete.status}, expected 404`);
    }

    const completeBody = await complete(session, roomId, uploadedParts);
    completed = true;
    if (completeBody.objectId !== session.objectId) throw new Error('completion object mismatch');

    const range = await fetch(session.downloadUrl, {
      headers: { Origin: APP_ORIGIN, Range: `bytes=0-${firstPartBytes - 1}` },
    });
    if (range.status !== 206) throw new Error(`range download HTTP ${range.status}`);
    if (
      range.headers.get('content-range') !==
      `bytes 0-${firstPartBytes - 1}/${session.encryptedBytes}`
    ) {
      throw new Error('range Content-Range mismatch');
    }
    if ((await hashDownload(range, firstPartBytes)) !== firstPartHash) {
      throw new Error('range SHA-256 mismatch');
    }

    const download = await fetch(session.downloadUrl, { headers: { Origin: APP_ORIGIN } });
    if (!download.ok) throw new Error(`download HTTP ${download.status}`);
    if ((await hashDownload(download, session.encryptedBytes)) !== expectedHash) {
      throw new Error('full download SHA-256 mismatch');
    }

    const replayAfterComplete = await uploadPart(
      firstTarget,
      opaquePart(Math.min(CHUNK_BYTES, plainBytes), 1),
    );
    if (replayAfterComplete.ok) {
      throw new Error('completed multipart upload unexpectedly accepted a replayed part');
    }

    const cleanupResponse = await cleanup(session, roomId);
    await jsonResponse(cleanupResponse, 'cleanup');
    cleaned = true;
    const afterCleanup = await fetch(session.downloadUrl, { headers: { Origin: APP_ORIGIN } });
    if (afterCleanup.status !== 404) {
      throw new Error(`cleaned object download returned ${afterCleanup.status}, expected 404`);
    }

    console.log(
      JSON.stringify({
        ok: true,
        protocolVersion: session.protocolVersion,
        plainBytes,
        encryptedBytes: session.encryptedBytes,
        partCount: session.chunkCount,
        corsPreflight: true,
        tamperedPartUrlStatus: 403,
        wrongDigestStatus,
        incompleteDownloadStatus: beforeComplete.status,
        rangeStatus: range.status,
        rangeSha256Match: true,
        fullSha256Match: true,
        replayAfterCompleteStatus: replayAfterComplete.status,
        cleanupStatus: cleanupResponse.status,
        afterCleanupStatus: afterCleanup.status,
      }),
    );
  } finally {
    if (session && !completed) await abort(session, roomId).catch(() => undefined);
    if (session && completed && !cleaned) await cleanup(session, roomId).catch(() => undefined);
  }
}

await main();
