#!/usr/bin/env node

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ORIGIN = 'https://musixquare.com';
const ARTIFACT_ROOT = 'release-artifacts/pro-grants';
const ADMIN_SESSION_COOKIE = '__Host-mxqr_admin';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_BATCH_SIZE = 100;
const PROVISION_CONCURRENCY = 4;
const PRO_ROOM_LABEL_MAX_LENGTH = 64;
const ROOM_CODE_RE = /^0\d{5}$/u;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const REQUEST_ID_RE = /^batch_[A-Za-z0-9_-]{22}$/u;
const VOUCHER_ID_RE = /^voucher_[A-Za-z0-9_-]{16,64}$/u;
const VOUCHER_CODE_RE = /^MXQ(?:-[0-9A-HJKMNP-TV-Z]{5}){4}$/u;
const SAFE_REASON_RE = /^[a-z][a-z0-9_]{2,63}$/u;
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const USAGE = [
  'Usage:',
  '  npm run pro-grant:campaign -- create --slug asamo-0 --title "MUSIXQUARE 아사모 이벤트" --rooms 000100-000149 [--starts-at <ISO>] [--ends-at <ISO>] [--per-account-limit 1] [--artifact release-artifacts/pro-grants/asamo-0.json] [--origin https://musixquare.com] [--apply]',
  '  npm run pro-grant:campaign -- apply --artifact release-artifacts/pro-grants/asamo-0-<batch>.json [--origin https://musixquare.com]',
  '  npm run pro-grant:campaign -- status --slug asamo-0 [--origin https://musixquare.com]',
  '  npm run pro-grant:campaign -- revoke --slug asamo-0 --reason operator_revoked [--origin https://musixquare.com] [--apply]',
  '',
  'create and revoke are dry-run by default. --apply is required to mutate production.',
].join('\n');

export class ProGrantCampaignCliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProGrantCampaignCliError';
  }
}

function usageError() {
  return new ProGrantCampaignCliError(USAGE);
}

function parseFlags(tokens, { values, booleans = new Set() }) {
  const parsed = Object.create(null);
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index];
    if (booleans.has(flag)) {
      if (flag in parsed) throw usageError();
      parsed[flag] = true;
      continue;
    }
    if (!values.has(flag) || flag in parsed) throw usageError();
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith('--')) throw usageError();
    parsed[flag] = value;
    index += 1;
  }
  return parsed;
}

function parseOrigin(value) {
  let url;
  try {
    url = new URL(value || DEFAULT_ORIGIN);
  } catch {
    throw usageError();
  }
  const localHttp =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (
    (url.protocol !== 'https:' && !localHttp) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw usageError();
  }
  return url.origin;
}

function parseTimestamp(value, label) {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ProGrantCampaignCliError(`${label} must be an ISO-8601 timestamp`);
  }
  return parsed;
}

export function expandProGrantRoomSelection(value) {
  if (typeof value !== 'string' || !value.trim()) throw usageError();
  const roomCodes = [];
  const seen = new Set();
  for (const rawSegment of value.split(',')) {
    const segment = rawSegment.trim();
    const match = /^(0\d{5})(?:-(0\d{5}))?$/u.exec(segment);
    if (!match) throw usageError();
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (end < start || end - start + 1 > MAX_BATCH_SIZE) throw usageError();
    for (let room = start; room <= end; room += 1) {
      const roomCode = String(room).padStart(6, '0');
      if (!ROOM_CODE_RE.test(roomCode) || seen.has(roomCode)) throw usageError();
      seen.add(roomCode);
      roomCodes.push(roomCode);
      if (roomCodes.length > MAX_BATCH_SIZE) throw usageError();
    }
  }
  if (roomCodes.length === 0) throw usageError();
  return roomCodes;
}

export function parseProGrantCampaignCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw usageError();
  const [command, ...tokens] = argv;
  if (command === 'create') {
    const flags = parseFlags(tokens, {
      values: new Set([
        '--slug',
        '--title',
        '--rooms',
        '--starts-at',
        '--ends-at',
        '--per-account-limit',
        '--artifact',
        '--origin',
      ]),
      booleans: new Set(['--apply']),
    });
    const slug = String(flags['--slug'] || '');
    const title = String(flags['--title'] || '').trim();
    const perAccountLimit = Number(flags['--per-account-limit'] || 1);
    const startsAt = parseTimestamp(flags['--starts-at'], '--starts-at');
    const endsAt = parseTimestamp(flags['--ends-at'], '--ends-at');
    if (
      !SLUG_RE.test(slug) ||
      title.length < 1 ||
      title.length > 100 ||
      /[\u0000-\u001f\u007f]/u.test(title) ||
      !Number.isSafeInteger(perAccountLimit) ||
      perAccountLimit < 1 ||
      perAccountLimit > 10 ||
      (startsAt !== null && endsAt !== null && endsAt <= startsAt)
    ) {
      throw usageError();
    }
    return {
      command,
      slug,
      title,
      roomCodes: expandProGrantRoomSelection(flags['--rooms']),
      startsAt,
      endsAt,
      perAccountLimit,
      artifact: flags['--artifact'] || null,
      origin: parseOrigin(flags['--origin']),
      apply: flags['--apply'] === true,
    };
  }
  if (command === 'status') {
    const flags = parseFlags(tokens, {
      values: new Set(['--slug', '--origin']),
    });
    const slug = String(flags['--slug'] || '');
    if (!SLUG_RE.test(slug)) throw usageError();
    return { command, slug, origin: parseOrigin(flags['--origin']) };
  }
  if (command === 'apply') {
    const flags = parseFlags(tokens, {
      values: new Set(['--artifact', '--origin']),
    });
    if (!flags['--artifact']) throw usageError();
    return {
      command,
      artifact: flags['--artifact'],
      origin: parseOrigin(flags['--origin']),
    };
  }
  if (command === 'revoke') {
    const flags = parseFlags(tokens, {
      values: new Set(['--slug', '--reason', '--origin']),
      booleans: new Set(['--apply']),
    });
    const slug = String(flags['--slug'] || '');
    const reason = String(flags['--reason'] || '');
    if (!SLUG_RE.test(slug) || !SAFE_REASON_RE.test(reason)) throw usageError();
    return {
      command,
      slug,
      reason,
      origin: parseOrigin(flags['--origin']),
      apply: flags['--apply'] === true,
    };
  }
  throw usageError();
}

function accessHeaders(env) {
  const clientId = env.CF_ACCESS_CLIENT_ID;
  const clientSecret = env.CF_ACCESS_CLIENT_SECRET;
  if (!!clientId !== !!clientSecret) {
    throw new ProGrantCampaignCliError(
      'CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be supplied together',
    );
  }
  return clientId
    ? {
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
      }
    : {};
}

function normalizeSessionCookie(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  const token = input.startsWith(`${ADMIN_SESSION_COOKIE}=`)
    ? input.slice(ADMIN_SESSION_COOKIE.length + 1).split(';', 1)[0]
    : input;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
    throw new ProGrantCampaignCliError('MXQR_ADMIN_SESSION_COOKIE is malformed');
  }
  return `${ADMIN_SESSION_COOKIE}=${token}`;
}

function extractAdminCookie(response) {
  const headers = response?.headers;
  const setCookies =
    typeof headers?.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers?.get?.('set-cookie') || ''];
  for (const value of setCookies) {
    const match = new RegExp(`(?:^|[,;]\\s*)${ADMIN_SESSION_COOKIE}=([^;\\s,]+)`, 'u').exec(value);
    if (match && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(match[1])) {
      return `${ADMIN_SESSION_COOKIE}=${match[1]}`;
    }
  }
  throw new ProGrantCampaignCliError('Admin login did not return a valid session');
}

async function readJsonResponse(response, label) {
  let text;
  try {
    text = await response.text();
  } catch {
    throw new ProGrantCampaignCliError(`${label} returned an unreadable response`);
  }
  if (text.length > MAX_JSON_BYTES) {
    throw new ProGrantCampaignCliError(`${label} response exceeded the safe size limit`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ProGrantCampaignCliError(`${label} returned invalid JSON`);
  }
  if (!response.ok) {
    const errorCode =
      typeof payload?.error === 'string' && /^[A-Z0-9_]{3,80}$/u.test(payload.error)
        ? payload.error
        : 'REQUEST_FAILED';
    throw new ProGrantCampaignCliError(`${label} failed (${response.status} ${errorCode})`);
  }
  return payload;
}

export function createProGrantAdminClient({ origin, env, fetcher = globalThis.fetch }) {
  if (typeof fetcher !== 'function') {
    throw new ProGrantCampaignCliError('A fetch implementation is required');
  }
  const baseHeaders = accessHeaders(env);
  let cookie = normalizeSessionCookie(env.MXQR_ADMIN_SESSION_COOKIE);

  async function login() {
    if (cookie) return cookie;
    const password = env.MXQR_ADMIN_PASSWORD;
    if (typeof password !== 'string' || !password) {
      throw new ProGrantCampaignCliError(
        'MXQR_ADMIN_PASSWORD or MXQR_ADMIN_SESSION_COOKIE must be supplied',
      );
    }
    let response;
    try {
      response = await fetcher(`${origin}/api/admin/login`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          ...baseHeaders,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Origin: origin,
          'Sec-Fetch-Site': 'same-origin',
          'X-MXQR-Admin-CSRF': '1',
        },
        body: JSON.stringify({ password }),
      });
    } catch {
      throw new ProGrantCampaignCliError('Admin login request failed');
    }
    await readJsonResponse(response, 'Admin login');
    cookie = extractAdminCookie(response);
    return cookie;
  }

  async function request(path, { method = 'GET', body = null, sensitive = false } = {}) {
    await login();
    let response;
    try {
      response = await fetcher(`${origin}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: {
          ...baseHeaders,
          Accept: 'application/json',
          Cookie: cookie,
          ...(body === null
            ? {}
            : {
                'Content-Type': 'application/json',
                Origin: origin,
                'Sec-Fetch-Site': 'same-origin',
                'X-MXQR-Admin-CSRF': '1',
              }),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ProGrantCampaignCliError('PRO grant admin request failed');
    }
    if (sensitive && !/\bno-store\b/iu.test(response.headers.get('cache-control') || '')) {
      throw new ProGrantCampaignCliError('Sensitive voucher response was not marked no-store');
    }
    return readJsonResponse(response, 'PRO grant admin request');
  }

  return { request };
}

export function createProGrantBatchRequestId(randomBytes = nodeRandomBytes) {
  const id = `batch_${randomBytes(16).toString('base64url')}`;
  if (!REQUEST_ID_RE.test(id)) {
    throw new ProGrantCampaignCliError('Secure batch request ID generation failed');
  }
  return id;
}

export function generateProGrantVoucherCode(randomBytes = nodeRandomBytes) {
  const entropy = randomBytes(13);
  if (!entropy || entropy.length !== 13) {
    throw new ProGrantCampaignCliError('Secure voucher generation failed');
  }
  let bits = 0;
  let bitCount = 0;
  let encoded = '';
  for (const byte of entropy) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && encoded.length < 20) {
      bitCount -= 5;
      encoded += CROCKFORD_ALPHABET[(bits >>> bitCount) & 31];
      bits &= (1 << bitCount) - 1;
    }
  }
  if (encoded.length !== 20) {
    throw new ProGrantCampaignCliError('Secure voucher generation failed');
  }
  const code = `MXQ-${encoded.slice(0, 5)}-${encoded.slice(5, 10)}-${encoded.slice(10, 15)}-${encoded.slice(15)}`;
  if (!VOUCHER_CODE_RE.test(code)) {
    throw new ProGrantCampaignCliError('Secure voucher generation failed');
  }
  return code;
}

function assertArtifactPath(root, requestedPath, slug, requestId) {
  const path =
    requestedPath || `${ARTIFACT_ROOT}/${slug}-${requestId.replace(/^batch_/u, '')}.json`;
  if (typeof path !== 'string' || !path.endsWith('.json')) throw usageError();
  const artifactRoot = resolve(root, ARTIFACT_ROOT);
  const absolute = resolve(root, path);
  const fromArtifactRoot = relative(artifactRoot, absolute);
  if (
    fromArtifactRoot === '..' ||
    fromArtifactRoot.startsWith(`..${sep}`) ||
    fromArtifactRoot === '' ||
    fromArtifactRoot.split(sep).includes('..')
  ) {
    throw new ProGrantCampaignCliError(`Artifact must be written under ${ARTIFACT_ROOT}`);
  }
  return { path: relative(root, absolute).split(sep).join('/'), absolute };
}

export function reserveProGrantArtifact(root, requestedPath, slug, requestId) {
  const artifact = assertArtifactPath(root, requestedPath, slug, requestId);
  mkdirSync(dirname(artifact.absolute), { recursive: true });
  let fd;
  try {
    fd = openSync(artifact.absolute, 'wx', 0o600);
  } catch {
    throw new ProGrantCampaignCliError(
      `Artifact already exists or cannot be created: ${artifact.path}`,
    );
  }
  let complete = false;
  return {
    path: artifact.path,
    write(payload) {
      if (complete) throw new ProGrantCampaignCliError('Artifact reservation is already closed');
      try {
        writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' });
        fsyncSync(fd);
        closeSync(fd);
        complete = true;
      } catch {
        try {
          closeSync(fd);
        } catch {
          // The descriptor may already have closed after a partial failure.
        }
        complete = true;
        try {
          unlinkSync(artifact.absolute);
        } catch {
          // Preserve the primary safe-write failure.
        }
        throw new ProGrantCampaignCliError('Voucher artifact could not be written safely');
      }
    },
    discard() {
      if (complete) return;
      try {
        closeSync(fd);
      } finally {
        complete = true;
        try {
          unlinkSync(artifact.absolute);
        } catch {
          // Best effort only; an empty ignored placeholder contains no secret.
        }
      }
    },
  };
}

function artifactPathInsideRoot(root, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath.endsWith('.json')) throw usageError();
  const artifactRoot = resolve(root, ARTIFACT_ROOT);
  const absolute = resolve(root, requestedPath);
  const fromArtifactRoot = relative(artifactRoot, absolute);
  if (
    fromArtifactRoot === '..' ||
    fromArtifactRoot.startsWith(`..${sep}`) ||
    fromArtifactRoot === '' ||
    fromArtifactRoot.split(sep).includes('..')
  ) {
    throw new ProGrantCampaignCliError(`Artifact must be read from ${ARTIFACT_ROOT}`);
  }
  return { path: relative(root, absolute).split(sep).join('/'), absolute };
}

export function readProGrantArtifact(root, requestedPath) {
  const artifact = artifactPathInsideRoot(root, requestedPath);
  let raw;
  try {
    raw = readFileSync(artifact.absolute, 'utf8');
  } catch {
    throw new ProGrantCampaignCliError(`Artifact cannot be read: ${artifact.path}`);
  }
  if (raw.length === 0 || raw.length > MAX_JSON_BYTES) {
    throw new ProGrantCampaignCliError('Voucher artifact has an invalid size');
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new ProGrantCampaignCliError('Voucher artifact contains invalid JSON');
  }
  if (
    payload?.format !== 'mxqr-pro-grant-vouchers-v1' ||
    !REQUEST_ID_RE.test(payload?.requestId || '') ||
    !SLUG_RE.test(payload?.campaign?.slug || '') ||
    typeof payload.campaign.title !== 'string' ||
    payload.campaign.title.length < 1 ||
    payload.campaign.title.length > 100 ||
    !Number.isSafeInteger(payload.campaign.startsAt) ||
    payload.campaign.startsAt < 0 ||
    (payload.campaign.endsAt !== null &&
      (!Number.isSafeInteger(payload.campaign.endsAt) ||
        payload.campaign.endsAt <= payload.campaign.startsAt)) ||
    !Number.isSafeInteger(payload.campaign.perAccountLimit) ||
    payload.campaign.perAccountLimit < 1 ||
    !Array.isArray(payload.vouchers) ||
    payload.vouchers.length < 1 ||
    payload.vouchers.length > MAX_BATCH_SIZE
  ) {
    throw new ProGrantCampaignCliError('Voucher artifact does not match the v1 contract');
  }
  const rooms = new Set();
  const codes = new Set();
  for (const voucher of payload.vouchers) {
    if (
      !ROOM_CODE_RE.test(voucher?.roomCode || '') ||
      rooms.has(voucher.roomCode) ||
      !VOUCHER_CODE_RE.test(voucher?.code || '') ||
      codes.has(voucher.code)
    ) {
      throw new ProGrantCampaignCliError('Voucher artifact contains invalid or duplicate material');
    }
    rooms.add(voucher.roomCode);
    codes.add(voucher.code);
  }
  return { path: artifact.path, payload };
}

function assertRoomInventoryPayload(payload) {
  if (!payload || !Array.isArray(payload.rooms)) {
    throw new ProGrantCampaignCliError('PRO room inventory response was invalid');
  }
  return payload.rooms;
}

export function classifyProGrantRoomInventory(payload, requestedRoomCodes) {
  if (!Array.isArray(requestedRoomCodes) || requestedRoomCodes.length < 1) {
    throw new ProGrantCampaignCliError('PRO room inventory request was invalid');
  }
  const requested = new Set(requestedRoomCodes);
  if (
    requested.size !== requestedRoomCodes.length ||
    requestedRoomCodes.some((roomCode) => !ROOM_CODE_RE.test(roomCode))
  ) {
    throw new ProGrantCampaignCliError('PRO room inventory request was invalid');
  }
  const found = new Map();
  for (const room of assertRoomInventoryPayload(payload)) {
    if (!requested.has(room?.roomCode)) continue;
    if (found.has(room.roomCode)) {
      throw new ProGrantCampaignCliError('PRO room inventory contained duplicate room records');
    }
    if (
      !Number.isSafeInteger(room.roomGeneration) ||
      room.roomGeneration < 0 ||
      typeof room.status !== 'string' ||
      !['unactivated', 'active'].includes(room.activationState)
    ) {
      throw new ProGrantCampaignCliError('PRO room inventory contained an invalid room record');
    }
    found.set(room.roomCode, room);
  }

  const ready = [];
  const needsProvisioning = [];
  const unavailable = [];
  for (const roomCode of requestedRoomCodes) {
    const room = found.get(roomCode);
    if (!room) {
      needsProvisioning.push({ roomCode, reason: 'missing' });
    } else if (room.status === 'registered' && room.activationState === 'unactivated') {
      ready.push({ roomCode, roomGeneration: room.roomGeneration });
    } else if (room.status === 'provisioning' && room.activationState === 'unactivated') {
      needsProvisioning.push({
        roomCode,
        roomGeneration: room.roomGeneration,
        reason: 'provisioning',
      });
    } else {
      unavailable.push({
        roomCode,
        roomGeneration: room.roomGeneration,
        status: room.status,
        activationState: room.activationState,
      });
    }
  }
  return { ready, needsProvisioning, unavailable };
}

export function createProGrantRoomLabel(slug, roomCode) {
  if (!SLUG_RE.test(slug || '') || !ROOM_CODE_RE.test(roomCode || '')) {
    throw new ProGrantCampaignCliError('PRO room label input was invalid');
  }
  const campaignLabel = slug
    .split('-')
    .filter(Boolean)
    .map((segment) => (/^\d+$/u.test(segment) ? segment : segment.toUpperCase()))
    .join(' ');
  const suffix = ` · ${roomCode}`;
  return `${Array.from(campaignLabel)
    .slice(0, PRO_ROOM_LABEL_MAX_LENGTH - suffix.length)
    .join('')}${suffix}`;
}

function validateProvisionedRoom(payload, roomCode, expectedLabel) {
  const room = payload?.room;
  if (
    room?.roomCode !== roomCode ||
    room?.label !== expectedLabel ||
    !Number.isSafeInteger(room?.roomGeneration) ||
    room.roomGeneration < 0 ||
    room.status !== 'registered' ||
    room.activationState !== 'unactivated'
  ) {
    throw new ProGrantCampaignCliError(`PRO room ${roomCode} provisioning response was invalid`);
  }
  return room;
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function inspectProGrantRoomInventory(api, roomCodes) {
  return classifyProGrantRoomInventory(
    assertSecretFreeStatus(await api.request('/api/admin/pro-rooms')),
    roomCodes,
  );
}

async function provisionExactProGrantRooms(api, campaign, roomCodes) {
  const before = await inspectProGrantRoomInventory(api, roomCodes);
  if (before.unavailable.length > 0) {
    return { replayOnly: true, inventory: before, rooms: [] };
  }
  const rooms = await mapWithConcurrency(roomCodes, PROVISION_CONCURRENCY, async (roomCode) => {
    const label = createProGrantRoomLabel(campaign.slug, roomCode);
    const response = assertSecretFreeStatus(
      await api.request('/api/admin/pro-rooms', {
        method: 'POST',
        body: { roomCode, label },
      }),
    );
    return validateProvisionedRoom(response, roomCode, label);
  });
  const after = await inspectProGrantRoomInventory(api, roomCodes);
  if (
    after.ready.length !== roomCodes.length ||
    after.needsProvisioning.length > 0 ||
    after.unavailable.length > 0
  ) {
    throw new ProGrantCampaignCliError('PRO room pool did not settle into an unactivated state');
  }
  return { replayOnly: false, inventory: after, rooms };
}

function validateVoucherBatchConfirmation(payload, expected) {
  const mappings = payload?.mappings;
  if (
    payload?.requestId !== expected.requestId ||
    payload?.campaign?.slug !== expected.campaign.slug ||
    payload?.count !== expected.vouchers.length ||
    !Array.isArray(mappings) ||
    mappings.length !== expected.vouchers.length
  ) {
    throw new ProGrantCampaignCliError('Voucher batch response did not match the request');
  }
  const expectedRooms = new Set(expected.vouchers.map((voucher) => voucher.roomCode));
  const voucherIds = new Set();
  for (const voucher of mappings) {
    if (
      !VOUCHER_ID_RE.test(voucher?.voucherId || '') ||
      voucherIds.has(voucher.voucherId) ||
      !expectedRooms.delete(voucher?.roomCode) ||
      !Number.isSafeInteger(voucher?.roomGeneration) ||
      voucher.roomGeneration < 0 ||
      !['available', 'redeemed', 'revoked'].includes(voucher?.status)
    ) {
      throw new ProGrantCampaignCliError('Voucher batch response contained invalid confirmation');
    }
    voucherIds.add(voucher.voucherId);
  }
  if (expectedRooms.size !== 0) {
    throw new ProGrantCampaignCliError('Voucher batch response omitted requested rooms');
  }
  return mappings;
}

function assertSecretFreeStatus(payload) {
  const serialized = JSON.stringify(payload);
  if (/"(?:code|codeDigest|code_digest)"\s*:/iu.test(serialized)) {
    throw new ProGrantCampaignCliError('Status response unexpectedly contained voucher material');
  }
  return payload;
}

function writeSummary(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runProGrantCampaignCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  root = resolve(fileURLToPath(new URL('..', import.meta.url))),
  fetcher = globalThis.fetch,
  randomBytes = nodeRandomBytes,
  now = () => Date.now(),
  client = null,
  reserveArtifact = reserveProGrantArtifact,
} = {}) {
  const command = parseProGrantCampaignCommand(argv);
  const api = client || createProGrantAdminClient({ origin: command.origin, env, fetcher });

  if (command.command === 'apply') {
    const artifact = readProGrantArtifact(root, command.artifact);
    const payload = artifact.payload;
    const campaignBody = {
      slug: payload.campaign.slug,
      title: payload.campaign.title,
      startsAt: payload.campaign.startsAt,
      endsAt: payload.campaign.endsAt,
      perAccountLimit: payload.campaign.perAccountLimit,
      dryRun: false,
    };
    const provisioning = await provisionExactProGrantRooms(
      api,
      payload.campaign,
      payload.vouchers.map((voucher) => voucher.roomCode),
    );
    if (!provisioning.replayOnly) {
      await api.request('/api/admin/pro-grants/campaigns', {
        method: 'POST',
        body: campaignBody,
      });
    }
    const confirmation = assertSecretFreeStatus(
      await api.request(
        `/api/admin/pro-grants/campaigns/${encodeURIComponent(payload.campaign.slug)}/vouchers`,
        {
          method: 'POST',
          sensitive: true,
          body: {
            requestId: payload.requestId,
            vouchers: payload.vouchers,
            dryRun: false,
          },
        },
      ),
    );
    if (provisioning.replayOnly && confirmation.replayed !== true) {
      throw new ProGrantCampaignCliError(
        'Unavailable rooms may only be accepted for an exact existing batch replay',
      );
    }
    const mappings = validateVoucherBatchConfirmation(confirmation, payload);
    await api.request(
      `/api/admin/pro-grants/campaigns/${encodeURIComponent(payload.campaign.slug)}/status`,
      {
        method: 'POST',
        body: { requestId: payload.requestId, status: 'active', dryRun: false },
      },
    );
    const summary = {
      campaign: payload.campaign.slug,
      mode: 'apply',
      requestId: payload.requestId,
      voucherCount: mappings.length,
      artifact: artifact.path,
      replaySafe: confirmation.replayed === true,
      provisionedRoomCount: provisioning.rooms.length,
      warning: 'Voucher codes remain only in the ignored artifact and were not printed.',
    };
    writeSummary(stdout, summary);
    return summary;
  }

  if (command.command === 'status') {
    const status = assertSecretFreeStatus(
      await api.request(
        `/api/admin/pro-grants/campaigns/${encodeURIComponent(command.slug)}/status`,
      ),
    );
    writeSummary(stdout, status);
    return status;
  }

  const requestId = createProGrantBatchRequestId(randomBytes);
  if (command.command === 'revoke') {
    if (!command.apply) {
      const status = assertSecretFreeStatus(
        await api.request(
          `/api/admin/pro-grants/campaigns/${encodeURIComponent(command.slug)}/status`,
        ),
      );
      const preview = {
        campaign: command.slug,
        mode: 'dry-run',
        reason: command.reason,
        wouldRevoke: status,
      };
      writeSummary(stdout, preview);
      return preview;
    }
    const result = assertSecretFreeStatus(
      await api.request(
        `/api/admin/pro-grants/campaigns/${encodeURIComponent(command.slug)}/revoke`,
        {
          method: 'POST',
          body: {
            requestId,
            reason: command.reason,
          },
        },
      ),
    );
    writeSummary(stdout, {
      campaign: command.slug,
      mode: command.apply ? 'apply' : 'dry-run',
      ...result,
    });
    return result;
  }

  const effectiveStartsAt = command.startsAt ?? now();
  const campaignBody = {
    slug: command.slug,
    title: command.title,
    startsAt: effectiveStartsAt,
    endsAt: command.endsAt,
    perAccountLimit: command.perAccountLimit,
    dryRun: !command.apply,
  };
  if (!command.apply) {
    const campaign = assertSecretFreeStatus(
      await api.request('/api/admin/pro-grants/campaigns', {
        method: 'POST',
        body: campaignBody,
      }),
    );
    const inventory = await inspectProGrantRoomInventory(api, command.roomCodes);
    const summary = {
      campaign: command.slug,
      mode: 'dry-run',
      roomCount: command.roomCodes.length,
      campaignValidation: campaign,
      canApply: inventory.unavailable.length === 0,
      roomInventory: {
        readyCount: inventory.ready.length,
        needsProvisioningCount: inventory.needsProvisioning.length,
        unavailableCount: inventory.unavailable.length,
        needsProvisioning: inventory.needsProvisioning,
        unavailable: inventory.unavailable,
      },
    };
    writeSummary(stdout, summary);
    return summary;
  }

  const artifact = reserveArtifact(root, command.artifact, command.slug, requestId);
  try {
    const generatedCodes = new Set();
    const vouchers = command.roomCodes.map((roomCode) => {
      let code;
      do {
        code = generateProGrantVoucherCode(randomBytes);
      } while (generatedCodes.has(code));
      generatedCodes.add(code);
      return { roomCode, code };
    });
    const artifactPayload = {
      format: 'mxqr-pro-grant-vouchers-v1',
      warning: 'PLAINTEXT VOUCHER CODES. Store and distribute securely. This file is not tracked.',
      exportedAt: new Date(now()).toISOString(),
      requestId,
      campaign: {
        slug: command.slug,
        title: command.title,
        startsAt: effectiveStartsAt,
        endsAt: command.endsAt,
        perAccountLimit: command.perAccountLimit,
      },
      vouchers,
    };
    // Persist the only recoverable plaintext copy before the remote mutation.
    // If the response is lost, `apply --artifact ...` safely replays the same
    // operationId and digest set without minting another batch.
    artifact.write(artifactPayload);
    const provisioning = await provisionExactProGrantRooms(
      api,
      artifactPayload.campaign,
      command.roomCodes,
    );
    let campaign = null;
    if (!provisioning.replayOnly) {
      campaign = assertSecretFreeStatus(
        await api.request('/api/admin/pro-grants/campaigns', {
          method: 'POST',
          body: campaignBody,
        }),
      );
    }
    const batch = await api.request(
      `/api/admin/pro-grants/campaigns/${encodeURIComponent(command.slug)}/vouchers`,
      {
        method: 'POST',
        body: { requestId, dryRun: false, vouchers },
        sensitive: true,
      },
    );
    void campaign;
    const secretFreeBatch = assertSecretFreeStatus(batch);
    if (provisioning.replayOnly && secretFreeBatch.replayed !== true) {
      throw new ProGrantCampaignCliError(
        'Unavailable rooms may only be accepted for an exact existing batch replay',
      );
    }
    const mappings = validateVoucherBatchConfirmation(secretFreeBatch, artifactPayload);
    await api.request(
      `/api/admin/pro-grants/campaigns/${encodeURIComponent(command.slug)}/status`,
      {
        method: 'POST',
        body: {
          requestId,
          status: 'active',
          dryRun: false,
        },
      },
    );
    const summary = {
      campaign: command.slug,
      mode: 'apply',
      requestId,
      voucherCount: mappings.length,
      provisionedRoomCount: provisioning.rooms.length,
      artifact: artifact.path,
      warning: 'Voucher codes were written only to the ignored artifact and were not printed.',
    };
    writeSummary(stdout, summary);
    return summary;
  } catch (error) {
    // Once plaintext was written, preserve it for exact idempotent replay.
    // `discard` is a no-op after the reservation has been completed.
    artifact.discard();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runProGrantCampaignCli();
  } catch (error) {
    const message =
      error instanceof ProGrantCampaignCliError
        ? error.message
        : 'PRO grant campaign operation failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
