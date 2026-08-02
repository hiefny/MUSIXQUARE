#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRO_ROOM_GENERATION_CONTRACT_VERSION = 1;
export const RELEASE_SHA_RE = /^[0-9a-f]{40}$/u;

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
  const executions = executionResults(payload, label);
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const rows = executions[index]?.results;
    if (Array.isArray(rows) && rows.length > 0) return rows[rows.length - 1];
  }
  throw new Error(`${label} returned no verification row.`);
}

function immutableFloor(row, label) {
  const everEnabled = Number(row?.ever_enabled);
  const generationFloor =
    row?.generation_floor === undefined ? everEnabled : Number(row.generation_floor);
  const floorReleaseSha =
    row?.floor_release_sha === null ? null : String(row?.floor_release_sha || '');
  if (everEnabled !== 1 || generationFloor !== 1 || !RELEASE_SHA_RE.test(floorReleaseSha || '')) {
    throw new Error(`${label} has invalid immutable generation-floor evidence.`);
  }
  return { floorReleaseSha, everEnabled: true, generationFloor: true };
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
  const floor = immutableFloor(row, 'PRO room generation cutover');
  if (expectedStatus === 'ready') {
    if (!RELEASE_SHA_RE.test(expectedReleaseSha || '') || releaseSha !== expectedReleaseSha) {
      throw new Error('PRO room generation cutover release SHA does not match this release.');
    }
  } else if (releaseSha !== null) {
    throw new Error('Disabled PRO room generation cutover must not retain release authority.');
  }
  return {
    contractVersion: PRO_ROOM_GENERATION_CONTRACT_VERSION,
    status: expectedStatus,
    releaseSha,
    ...floor,
  };
}

export function generationCutoverWorkflowOutputs(payload) {
  const row = lastResultRow(payload, 'PRO room generation cutover');
  if (
    Number(row?.contract_version) !== PRO_ROOM_GENERATION_CONTRACT_VERSION ||
    !['disabled', 'ready'].includes(row?.status)
  ) {
    throw new Error('PRO room generation cutover returned an invalid status.');
  }
  const { floorReleaseSha, generationFloor } = immutableFloor(row, 'PRO room generation cutover');
  return { floorReleaseSha, generationFloor };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read PRO room generation cutover D1 JSON: ${path}`, { cause: error });
  }
}

function usage() {
  throw new Error(
    'Usage: node scripts/pro-room-generation-cutover.mjs ' +
      'cutover-outputs <cutover.json> | ' +
      'verify-cutover <cutover.json> <disabled|ready> [release-sha]',
  );
}

function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command === 'cutover-outputs' && rest.length === 1) {
    const outputs = generationCutoverWorkflowOutputs(readJson(rest[0]));
    process.stdout.write(`generation_floor=${outputs.generationFloor}\n`);
    process.stdout.write(`floor_release_sha=${outputs.floorReleaseSha}\n`);
    return;
  }
  if (
    command === 'verify-cutover' &&
    (rest.length === 2 || rest.length === 3) &&
    ['disabled', 'ready'].includes(rest[1])
  ) {
    const result = assertGenerationCutoverStatus(readJson(rest[0]), rest[1], rest[2] || null);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  usage();
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) main();
