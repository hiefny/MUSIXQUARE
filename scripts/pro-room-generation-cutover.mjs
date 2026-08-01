#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRO_ROOM_GENERATION_CONTRACT_VERSION = 1;
export const RELEASE_SHA_RE = /^[0-9a-f]{40}$/u;
export const INITIAL_DELETION_ROOM_CODES = Object.freeze(['000002', '000003']);
export const INITIAL_DELETION_MINIMUM_AGE_MS = 70 * 60 * 1000;
const PUBLIC_DELETION_EVIDENCE_TIMEOUT_MS = 10_000;

function executionResults(payload, label) {
  const executions = Array.isArray(payload) ? payload : [payload];
  if (executions.length === 0) {
    throw new Error(`${label} returned no D1 executions.`);
  }
  for (const execution of executions) {
    if (!execution || typeof execution !== 'object' || execution.success === false) {
      throw new Error(`${label} contains a failed or malformed D1 execution.`);
    }
  }
  return executions;
}

function lastResultRow(payload, label) {
  const rows = lastResultRows(payload, label);
  return rows[rows.length - 1];
}

function lastResultRows(payload, label) {
  const executions = executionResults(payload, label);
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const rows = executions[index]?.results;
    if (Array.isArray(rows) && rows.length > 0) return rows;
  }
  throw new Error(`${label} returned no verification row.`);
}

function safeInteger(row, name, label) {
  const raw = row?.[name];
  if (raw === null || raw === undefined || raw === '') {
    throw new Error(`${label} returned an invalid ${name}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} returned an invalid ${name}.`);
  }
  return value;
}

function exactRoomRows(rows, label) {
  if (rows.length !== INITIAL_DELETION_ROOM_CODES.length) {
    throw new Error(`${label} did not return exactly the required legacy rooms.`);
  }
  const byRoomCode = new Map();
  for (const row of rows) {
    const roomCode = String(row?.room_code || row?.roomCode || '');
    if (!INITIAL_DELETION_ROOM_CODES.includes(roomCode) || byRoomCode.has(roomCode)) {
      throw new Error(`${label} returned an unexpected or duplicate room code.`);
    }
    byRoomCode.set(roomCode, row);
  }
  for (const roomCode of INITIAL_DELETION_ROOM_CODES) {
    if (!byRoomCode.has(roomCode)) {
      throw new Error(`${label} is missing room ${roomCode}.`);
    }
  }
  return byRoomCode;
}

export function assertGenerationSchemaVerification(label, payload) {
  const row = lastResultRow(payload, label);
  if (Number(row?.schema_ready) !== 1) {
    throw new Error(`${label} is not ready for immutable PRO room generations.`);
  }
  return { label, schemaReady: true };
}

export function generationMigrationState(label, payload) {
  const row = lastResultRow(payload, label);
  const present = Number(row?.features_present);
  const expected = Number(row?.features_expected);
  if (
    !Number.isSafeInteger(present) ||
    !Number.isSafeInteger(expected) ||
    expected <= 0 ||
    present < 0 ||
    present > expected
  ) {
    throw new Error(`${label} returned an invalid migration-state count.`);
  }
  if (present === 0) return 'legacy';
  if (present === expected) return 'ready';
  return 'partial';
}

function binaryFlag(row, name, label) {
  const value = Number(row?.[name]);
  if (value !== 0 && value !== 1) {
    throw new Error(`${label} returned an invalid ${name} flag.`);
  }
  return value === 1;
}

function removeAlterColumn(sql, table, column) {
  const pattern = new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN ${column}[\\s\\S]*?;\\s*`, 'u');
  if (!pattern.test(sql)) {
    throw new Error(`Tracked migration is missing ${table}.${column}.`);
  }
  return sql.replace(pattern, '');
}

export function renderForwardCompletionSql(database, statePayload, sourceSql) {
  if (!['admin', 'auth', 'developer'].includes(database) || typeof sourceSql !== 'string') {
    throw new Error(`Unsupported PRO room generation migration: ${database}.`);
  }
  const row = lastResultRow(statePayload, `${database} migration state`);
  let sql = sourceSql;
  if (database === 'admin') {
    if (binaryFlag(row, 'registry_generation_column', 'Admin migration state')) {
      sql = removeAlterColumn(sql, 'mxqr_pro_room_registry', 'room_generation');
    }
    if (binaryFlag(row, 'audit_generation_column', 'Admin migration state')) {
      sql = removeAlterColumn(sql, 'mxqr_pro_room_admin_audit', 'room_generation');
    }
    sql = sql
      .replace(/^CREATE TABLE (mxqr_pro_room_[a-z0-9_]+)/gmu, 'CREATE TABLE IF NOT EXISTS $1')
      .replace(/^CREATE INDEX ([a-z0-9_]+)/gmu, 'CREATE INDEX IF NOT EXISTS $1')
      .replace(/^CREATE TRIGGER ([a-z0-9_]+)/gmu, 'DROP TRIGGER IF EXISTS $1;\n\nCREATE TRIGGER $1')
      .replace(
        'INSERT INTO mxqr_pro_room_generation_allocations',
        'INSERT OR IGNORE INTO mxqr_pro_room_generation_allocations',
      )
      .replace(
        'INSERT INTO mxqr_pro_room_generation_cutover',
        'INSERT OR IGNORE INTO mxqr_pro_room_generation_cutover',
      );
  } else if (database === 'auth') {
    binaryFlag(row, 'generation_table', 'Account migration state');
    sql = sql
      .replace(
        'CREATE TABLE mxqr_account_pro_room_generations',
        'CREATE TABLE IF NOT EXISTS mxqr_account_pro_room_generations',
      )
      .replace(
        'CREATE INDEX idx_mxqr_account_pro_room_generations_account',
        'CREATE INDEX IF NOT EXISTS idx_mxqr_account_pro_room_generations_account',
      );
  } else {
    if (binaryFlag(row, 'keys_generation_column', 'Developer migration state')) {
      sql = removeAlterColumn(sql, 'mxqr_developer_api_keys', 'room_generation');
    }
    if (binaryFlag(row, 'audit_generation_column', 'Developer migration state')) {
      sql = removeAlterColumn(sql, 'mxqr_developer_api_audit', 'room_generation');
    }
    if (binaryFlag(row, 'admin_audit_generation_column', 'Developer migration state')) {
      sql = removeAlterColumn(sql, 'mxqr_developer_api_admin_audit', 'room_generation');
    }
  }
  return `${sql.trim()}\n`;
}

export function assertGenerationCutoverStatus(payload, expectedStatus, expectedReleaseSha = null) {
  if (!['disabled', 'ready'].includes(expectedStatus)) {
    throw new Error(`Unsupported generation cutover status: ${expectedStatus}.`);
  }
  const row = lastResultRow(payload, 'PRO room generation cutover');
  if (
    Number(row?.contract_version) !== PRO_ROOM_GENERATION_CONTRACT_VERSION ||
    row?.status !== expectedStatus
  ) {
    throw new Error(`PRO room generation cutover is not ${expectedStatus}.`);
  }
  const releaseSha = row?.release_sha === null ? null : String(row?.release_sha || '');
  const floorReleaseSha =
    row?.floor_release_sha === null ? null : String(row?.floor_release_sha || '');
  const everEnabled = Number(row?.ever_enabled) === 1;
  const generationFloor =
    row?.generation_floor === undefined ? everEnabled : Number(row.generation_floor) === 1;
  if (
    ![0, 1].includes(Number(row?.ever_enabled)) ||
    (row?.generation_floor !== undefined && ![0, 1].includes(Number(row.generation_floor))) ||
    (everEnabled && !RELEASE_SHA_RE.test(floorReleaseSha || '')) ||
    (!everEnabled && floorReleaseSha !== null) ||
    generationFloor !== everEnabled
  ) {
    throw new Error('PRO room generation cutover has invalid irreversible floor evidence.');
  }
  if (expectedStatus === 'ready') {
    if (
      !everEnabled ||
      !RELEASE_SHA_RE.test(expectedReleaseSha || '') ||
      releaseSha !== expectedReleaseSha
    ) {
      throw new Error('PRO room generation cutover release SHA does not match this release.');
    }
  } else if (releaseSha !== null) {
    throw new Error('Disabled PRO room generation cutover must not retain release authority.');
  }
  return {
    contractVersion: PRO_ROOM_GENERATION_CONTRACT_VERSION,
    status: expectedStatus,
    releaseSha,
    floorReleaseSha,
    everEnabled,
    generationFloor,
  };
}

export function generationCutoverWorkflowOutputs(payload) {
  const row = lastResultRow(payload, 'PRO room generation cutover');
  const status = row?.status;
  if (!['disabled', 'ready'].includes(status)) {
    throw new Error('PRO room generation cutover returned an invalid status.');
  }
  const everEnabled = Number(row?.ever_enabled);
  const generationFloor =
    row?.generation_floor === undefined ? everEnabled : Number(row.generation_floor);
  const floorReleaseSha =
    row?.floor_release_sha === null ? null : String(row?.floor_release_sha || '');
  if (
    ![0, 1].includes(everEnabled) ||
    ![0, 1].includes(generationFloor) ||
    generationFloor !== everEnabled ||
    (everEnabled === 1 && !RELEASE_SHA_RE.test(floorReleaseSha || '')) ||
    (everEnabled === 0 && floorReleaseSha !== null)
  ) {
    throw new Error('PRO room generation cutover returned an invalid rollback floor.');
  }
  return {
    wasReady: status === 'ready',
    everEnabled: everEnabled === 1,
    generationFloor: generationFloor === 1,
    floorReleaseSha,
  };
}

function assertPublicDeletionEvidence(payload) {
  const rows = Array.isArray(payload?.rooms) ? payload.rooms : [];
  const byRoomCode = exactRoomRows(rows, 'Public bootstrap deletion evidence');
  for (const roomCode of INITIAL_DELETION_ROOM_CODES) {
    const row = byRoomCode.get(roomCode);
    if (
      Number(row?.status) !== 404 ||
      !['ROOM_NOT_FOUND', 'PRO_ROOM_NOT_FOUND'].includes(String(row?.error || ''))
    ) {
      throw new Error(`Public bootstrap still exposes legacy room ${roomCode}.`);
    }
  }
  return true;
}

export function assertInitialDeletionEvidence(adminPayload, developerPayload, publicPayload) {
  const adminRows = exactRoomRows(
    lastResultRows(adminPayload, 'Admin deletion evidence'),
    'Admin deletion evidence',
  );
  const developerRows = exactRoomRows(
    lastResultRows(developerPayload, 'Developer deletion evidence'),
    'Developer deletion evidence',
  );
  assertPublicDeletionEvidence(publicPayload);

  for (const roomCode of INITIAL_DELETION_ROOM_CODES) {
    const admin = adminRows.get(roomCode);
    const generation = safeInteger(admin, 'registry_generation', `Admin room ${roomCode}`);
    const completedAt = safeInteger(admin, 'history_decommissioned_at', `Admin room ${roomCode}`);
    const observedAt = safeInteger(admin, 'observed_at', `Admin room ${roomCode}`);
    const registryUpdatedAt = safeInteger(admin, 'registry_updated_at', `Admin room ${roomCode}`);
    const authorizedDeleteAuditCount = safeInteger(
      admin,
      'authorized_delete_audit_count',
      `Admin room ${roomCode}`,
    );
    const authorizedDeleteAuditLatestAt = safeInteger(
      admin,
      'authorized_delete_audit_latest_at',
      `Admin room ${roomCode}`,
    );
    if (
      admin?.registry_status !== 'decommissioned' ||
      generation !== 0 ||
      safeInteger(admin, 'history_count', `Admin room ${roomCode}`) !== 1 ||
      safeInteger(admin, 'allocation_count', `Admin room ${roomCode}`) !== 1 ||
      safeInteger(admin, 'other_allocation_count', `Admin room ${roomCode}`) !== 0 ||
      authorizedDeleteAuditCount < 1 ||
      completedAt < 0 ||
      registryUpdatedAt < completedAt ||
      registryUpdatedAt > observedAt ||
      authorizedDeleteAuditLatestAt < 0 ||
      authorizedDeleteAuditLatestAt > completedAt ||
      observedAt - completedAt < INITIAL_DELETION_MINIMUM_AGE_MS
    ) {
      throw new Error(`Admin deletion evidence is incomplete for room ${roomCode}.`);
    }

    const developer = developerRows.get(roomCode);
    const generationRequestId = String(developer?.generation_request_id || '');
    const generationDecommissionedAt = safeInteger(
      developer,
      'generation_decommissioned_at',
      `Developer room ${roomCode}`,
    );
    if (
      safeInteger(developer, 'generation_tombstone_count', `Developer room ${roomCode}`) !== 1 ||
      safeInteger(developer, 'other_generation_tombstone_count', `Developer room ${roomCode}`) !==
        0 ||
      safeInteger(developer, 'key_count', `Developer room ${roomCode}`) !== 0 ||
      safeInteger(developer, 'api_audit_count', `Developer room ${roomCode}`) !== 0 ||
      safeInteger(developer, 'admin_audit_count', `Developer room ${roomCode}`) !== 0 ||
      !generationRequestId ||
      generationDecommissionedAt < 0 ||
      generationDecommissionedAt > observedAt
    ) {
      throw new Error(`Developer credential deletion evidence is incomplete for room ${roomCode}.`);
    }
  }

  return {
    ok: true,
    roomCodes: [...INITIAL_DELETION_ROOM_CODES],
    minimumCompletionAgeMs: INITIAL_DELETION_MINIMUM_AGE_MS,
  };
}

export async function probePublicDeletionEvidence(
  baseUrl = 'https://musixquare.com',
  fetchImpl = fetch,
) {
  const origin = new URL(baseUrl);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('Public deletion evidence requires a clean HTTPS origin.');
  }
  const rooms = [];
  for (const roomCode of INITIAL_DELETION_ROOM_CODES) {
    const url = new URL(`/api/pro-room/v1/rooms/${roomCode}/bootstrap`, origin);
    let response;
    try {
      response = await fetchImpl(url, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(PUBLIC_DELETION_EVIDENCE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Cannot verify public bootstrap deletion for room ${roomCode}.`, {
        cause: error,
      });
    }
    let payload = null;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      // A generic edge 404 is insufficient: only the application-level
      // tombstone response proves the PRO route was reached.
    }
    rooms.push({
      roomCode,
      status: response.status,
      error: typeof payload?.error === 'string' ? payload.error : null,
    });
  }
  const evidence = { checkedAt: Date.now(), rooms };
  assertPublicDeletionEvidence(evidence);
  return evidence;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${label} D1 verification JSON: ${path}`, { cause: error });
  }
}

function usage() {
  throw new Error(
    'Usage: node scripts/pro-room-generation-cutover.mjs ' +
      'verify-schema <admin.json> <auth.json> <developer.json> | ' +
      'plan-migrations <admin.json> <auth.json> <developer.json> | ' +
      'render-migration <admin|auth|developer> <state.json> <source.sql> <output.sql> | ' +
      'cutover-outputs <cutover.json> | ' +
      'verify-cutover <cutover.json> <disabled|ready> [release-sha] | ' +
      'probe-public-deletion <output.json> [base-url] | ' +
      'verify-initial-deletion <admin.json> <developer.json> <public.json>',
  );
}

async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command === 'verify-schema' && rest.length === 3) {
    const labels = [
      'Admin registry schema',
      'Account reverse-index schema',
      'Developer API schema',
    ];
    const result = rest.map((path, index) =>
      assertGenerationSchemaVerification(labels[index], readJson(path, labels[index])),
    );
    process.stdout.write(`${JSON.stringify({ ok: true, databases: result })}\n`);
    return;
  }
  if (command === 'plan-migrations' && rest.length === 3) {
    const names = ['admin', 'auth', 'developer'];
    const labels = [
      'Admin registry migration',
      'Account reverse-index migration',
      'Developer API migration',
    ];
    for (let index = 0; index < rest.length; index += 1) {
      const state = generationMigrationState(labels[index], readJson(rest[index], labels[index]));
      process.stdout.write(`${names[index]}=${state}\n`);
    }
    return;
  }
  if (
    command === 'render-migration' &&
    rest.length === 4 &&
    ['admin', 'auth', 'developer'].includes(rest[0])
  ) {
    const [database, statePath, sourcePath, outputPath] = rest;
    const sql = renderForwardCompletionSql(
      database,
      readJson(statePath, `${database} migration state`),
      readFileSync(resolve(sourcePath), 'utf8'),
    );
    writeFileSync(resolve(outputPath), sql, 'utf8');
    process.stdout.write(`${JSON.stringify({ ok: true, database, outputPath })}\n`);
    return;
  }
  if (command === 'cutover-outputs' && rest.length === 1) {
    const outputs = generationCutoverWorkflowOutputs(
      readJson(rest[0], 'PRO room generation cutover'),
    );
    process.stdout.write(`was_ready=${outputs.wasReady}\n`);
    process.stdout.write(`ever_enabled=${outputs.everEnabled}\n`);
    process.stdout.write(`generation_floor=${outputs.generationFloor}\n`);
    process.stdout.write(`floor_release_sha=${outputs.floorReleaseSha || ''}\n`);
    return;
  }
  if (
    command === 'verify-cutover' &&
    (rest.length === 2 || rest.length === 3) &&
    ['disabled', 'ready'].includes(rest[1])
  ) {
    const result = assertGenerationCutoverStatus(
      readJson(rest[0], 'PRO room generation cutover'),
      rest[1],
      rest[2] || null,
    );
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  if (command === 'probe-public-deletion' && (rest.length === 1 || rest.length === 2)) {
    const evidence = await probePublicDeletionEvidence(rest[1] || 'https://musixquare.com');
    writeFileSync(resolve(rest[0]), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ ok: true, ...evidence })}\n`);
    return;
  }
  if (command === 'verify-initial-deletion' && rest.length === 3) {
    const result = assertInitialDeletionEvidence(
      readJson(rest[0], 'Admin deletion evidence'),
      readJson(rest[1], 'Developer deletion evidence'),
      readJson(rest[2], 'Public bootstrap deletion evidence'),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  usage();
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) await main();
