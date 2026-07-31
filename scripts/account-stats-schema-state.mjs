#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readRows(path) {
  const payload = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new Error('Account-stats readiness must contain exactly one D1 execution.');
  }
  const execution = payload[0];
  if (
    !execution ||
    typeof execution !== 'object' ||
    execution.success !== true ||
    !Array.isArray(execution.results) ||
    execution.results.length !== 1
  ) {
    throw new Error('Account-stats readiness returned a failed or malformed D1 execution.');
  }
  return execution.results[0];
}

function bit(value, name) {
  const parsed = Number(value);
  if (parsed !== 0 && parsed !== 1) {
    throw new Error(`Account-stats readiness returned an invalid ${name}.`);
  }
  return parsed;
}

export function accountStatsSchemaState(path) {
  const row = readRows(path);
  const tablePresent = bit(row?.table_present, 'table_present');
  const columnsReady = bit(row?.columns_ready, 'columns_ready');
  const foreignKeyReady = bit(row?.foreign_key_ready, 'foreign_key_ready');
  const schemaReady = bit(row?.schema_ready, 'schema_ready');
  if (schemaReady === 1 && (tablePresent !== 1 || columnsReady !== 1 || foreignKeyReady !== 1)) {
    throw new Error('Account-stats readiness is internally inconsistent.');
  }
  if (tablePresent === 0 && (columnsReady !== 0 || foreignKeyReady !== 0 || schemaReady !== 0)) {
    throw new Error('A missing account-stats table reported partial schema features.');
  }
  if (tablePresent === 1 && schemaReady === 0) {
    throw new Error(
      'The existing account-stats table is incompatible; repair it explicitly before release.',
    );
  }
  return schemaReady === 1 ? 'ready' : 'missing';
}

function usage() {
  throw new Error(
    'Usage: node scripts/account-stats-schema-state.mjs <plan|verify> <readiness.json>',
  );
}

function main(args = process.argv.slice(2)) {
  if (args.length !== 2) usage();
  const [command, path] = args;
  const state = accountStatsSchemaState(path);
  if (command === 'plan') {
    process.stdout.write(`state=${state}\n`);
    return;
  }
  if (command === 'verify') {
    if (state !== 'ready') throw new Error('The account-stats schema is not ready.');
    process.stdout.write('Account-stats schema is ready.\n');
    return;
  }
  usage();
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `Account-stats schema check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
