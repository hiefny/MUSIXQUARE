#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRO_ROOM_GENERATION_CONTRACT_VERSION = 1;
export const RELEASE_SHA_RE = /^[0-9a-f]{40}$/u;

export type ProRoomGenerationCutoverStatus = 'disabled' | 'ready';

export interface ProRoomGenerationCutoverResult {
  contractVersion: 1;
  status: ProRoomGenerationCutoverStatus;
  releaseSha: string | null;
  floorReleaseSha: string;
  everEnabled: true;
  generationFloor: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCutoverStatus(value: unknown): value is ProRoomGenerationCutoverStatus {
  return value === 'disabled' || value === 'ready';
}

function executionResults(payload: unknown, label: string): Record<string, unknown>[] {
  const executions = Array.isArray(payload) ? payload : [payload];
  if (executions.length === 0) {
    throw new Error(`${label} returned no D1 executions.`);
  }
  const validated: Record<string, unknown>[] = [];
  for (const execution of executions) {
    if (!isRecord(execution) || execution.success === false) {
      throw new Error(`${label} contains a failed or malformed D1 execution.`);
    }
    validated.push(execution);
  }
  return validated;
}

function lastResultRow(payload: unknown, label: string): Record<string, unknown> {
  const executions = executionResults(payload, label);
  for (let index = executions.length - 1; index >= 0; index -= 1) {
    const execution = executions[index];
    const rows = execution?.results;
    const row = Array.isArray(rows) ? rows.at(-1) : undefined;
    if (isRecord(row)) return row;
  }
  throw new Error(`${label} returned no verification row.`);
}

function immutableFloor(
  row: unknown,
  label: string,
): {
  floorReleaseSha: string;
  everEnabled: true;
  generationFloor: true;
} {
  if (!isRecord(row)) {
    throw new Error(`${label} has invalid immutable generation-floor evidence.`);
  }
  const everEnabled = Number(row.ever_enabled);
  const generationFloor =
    row.generation_floor === undefined ? everEnabled : Number(row.generation_floor);
  const floorReleaseSha =
    row.floor_release_sha === null ? null : String(row.floor_release_sha || '');
  if (
    everEnabled !== 1 ||
    generationFloor !== 1 ||
    typeof floorReleaseSha !== 'string' ||
    !RELEASE_SHA_RE.test(floorReleaseSha)
  ) {
    throw new Error(`${label} has invalid immutable generation-floor evidence.`);
  }
  return { floorReleaseSha, everEnabled: true, generationFloor: true };
}

export function assertGenerationCutoverStatus(
  payload: unknown,
  expectedStatus: ProRoomGenerationCutoverStatus,
  expectedReleaseSha: string | null = null,
): ProRoomGenerationCutoverResult {
  if (!isCutoverStatus(expectedStatus)) {
    throw new Error(`Unsupported generation cutover status: ${expectedStatus}.`);
  }
  const row = lastResultRow(payload, 'PRO room generation cutover');
  if (
    Number(row.contract_version) !== PRO_ROOM_GENERATION_CONTRACT_VERSION ||
    row.status !== expectedStatus
  ) {
    throw new Error(`PRO room generation cutover is not ${expectedStatus}.`);
  }
  const releaseSha = row.release_sha === null ? null : String(row.release_sha || '');
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

export function generationCutoverWorkflowOutputs(payload: unknown): {
  floorReleaseSha: string;
  generationFloor: true;
} {
  const row = lastResultRow(payload, 'PRO room generation cutover');
  if (
    Number(row.contract_version) !== PRO_ROOM_GENERATION_CONTRACT_VERSION ||
    !isCutoverStatus(row.status)
  ) {
    throw new Error('PRO room generation cutover returned an invalid status.');
  }
  const { floorReleaseSha, generationFloor } = immutableFloor(row, 'PRO room generation cutover');
  return { floorReleaseSha, generationFloor };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch {
    throw new Error('Cannot read PRO room generation cutover D1 JSON.');
  }
}

function usage(): never {
  throw new Error(
    'Usage: node scripts/pro-room-generation-cutover.mts ' +
      'cutover-outputs <cutover.json> | ' +
      'verify-cutover <cutover.json> <disabled|ready> [release-sha]',
  );
}

function main(args: readonly string[] = process.argv.slice(2)): void {
  const [command, ...rest] = args;
  if (command === 'cutover-outputs' && rest.length === 1) {
    const inputPath = rest[0];
    if (inputPath === undefined) usage();
    const outputs = generationCutoverWorkflowOutputs(readJson(inputPath));
    process.stdout.write(`generation_floor=${outputs.generationFloor}\n`);
    process.stdout.write(`floor_release_sha=${outputs.floorReleaseSha}\n`);
    return;
  }
  if (
    command === 'verify-cutover' &&
    (rest.length === 2 || rest.length === 3) &&
    isCutoverStatus(rest[1])
  ) {
    const inputPath = rest[0];
    const expectedStatus = rest[1];
    if (inputPath === undefined || !isCutoverStatus(expectedStatus)) usage();
    const result = assertGenerationCutoverStatus(
      readJson(inputPath),
      expectedStatus,
      rest[2] || null,
    );
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  usage();
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) main();
