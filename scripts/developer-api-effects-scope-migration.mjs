#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DATABASE_NAME = 'musixquare-developer-api';
const WRANGLER_CONFIG = 'cloudflare/wrangler.developer-api.toml';
const APPLY_FILE = 'cloudflare/developer-api.effects-scopes.migration.sql';
const ROLLBACK_FILE = 'cloudflare/developer-api.effects-scopes.rollback.sql';
const LEGACY_SCOPE_LIMIT = 63;
const EFFECTS_SCOPE_LIMIT = 255;
const RELEASE_JOURNAL_VERSION = 1;

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runWrangler(args, { capture = false } = {}) {
  return execFileSync(
    npmExecutable(),
    [
      'run',
      '--silent',
      'wrangler',
      '--',
      'd1',
      'execute',
      DATABASE_NAME,
      '--remote',
      '--config',
      WRANGLER_CONFIG,
      '--json',
      ...args,
    ],
    {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    },
  );
}

export function parseD1Rows(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error('Developer API D1 returned invalid JSON.');
  }
  if (!Array.isArray(payload) || payload.some((result) => result?.success !== true)) {
    throw new Error('Developer API D1 query failed.');
  }
  return payload.flatMap((result) => (Array.isArray(result.results) ? result.results : []));
}

export function scopeMaskLimitFromSchema(sql) {
  if (typeof sql !== 'string') return null;
  const match = sql.match(/scope_mask\s+BETWEEN\s+1\s+AND\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

function readScopeMaskLimit(runner = runWrangler) {
  const output = runner(
    [
      '--command',
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mxqr_developer_api_keys';",
    ],
    { capture: true },
  );
  const rows = parseD1Rows(output);
  if (rows.length !== 1) throw new Error('Developer API key table is missing or ambiguous.');
  const limit = scopeMaskLimitFromSchema(rows[0]?.sql);
  if (limit === null) throw new Error('Developer API key scope constraint could not be verified.');
  return limit;
}

function writeGithubOutput(name, value, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  appendFileSync(outputPath, `${name}=${value}\n`, 'utf8');
}

function writeReleaseJournal(journalPath, beforeScopeMaskLimit) {
  if (!journalPath) return;
  const resolved = resolve(journalPath);
  mkdirSync(dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({
      version: RELEASE_JOURNAL_VERSION,
      operation: 'apply',
      beforeScopeMaskLimit,
    })}\n`,
    'utf8',
  );
  renameSync(temporary, resolved);
}

function readReleaseJournal(journalPath) {
  if (!journalPath || !existsSync(resolve(journalPath))) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(journalPath), 'utf8'));
  } catch {
    throw new Error('Developer API effects-scope release journal is invalid.');
  }
  if (
    value?.version !== RELEASE_JOURNAL_VERSION ||
    value?.operation !== 'apply' ||
    ![LEGACY_SCOPE_LIMIT, EFFECTS_SCOPE_LIMIT].includes(value?.beforeScopeMaskLimit)
  ) {
    throw new Error('Developer API effects-scope release journal is invalid.');
  }
  return value;
}

export function migrationDisposition(currentLimit, operation) {
  if (operation === 'apply') {
    if (currentLimit === EFFECTS_SCOPE_LIMIT) return 'skip';
    if (currentLimit === LEGACY_SCOPE_LIMIT) return 'apply';
  } else if (operation === 'rollback') {
    if (currentLimit === LEGACY_SCOPE_LIMIT) return 'skip';
    if (currentLimit === EFFECTS_SCOPE_LIMIT) return 'apply';
  }
  throw new Error(
    `Refusing Developer API effects-scope ${operation}: unexpected scope limit ${currentLimit}.`,
  );
}

export function runEffectsScopeMigration(
  operation,
  {
    runner = runWrangler,
    outputPath = process.env.GITHUB_OUTPUT,
    stdout = process.stdout,
    journalPath = null,
  } = {},
) {
  if (operation !== 'apply' && operation !== 'rollback') {
    throw new Error('Usage: developer-api-effects-scope-migration.mjs <apply|rollback>');
  }
  const before = readScopeMaskLimit(runner);
  if (operation === 'apply') writeReleaseJournal(journalPath, before);
  const disposition = migrationDisposition(before, operation);
  if (disposition === 'skip') {
    writeGithubOutput('applied', 'false', outputPath);
    stdout.write(
      `${JSON.stringify({ ok: true, operation, applied: false, scopeMaskLimit: before })}\n`,
    );
    return { applied: false, scopeMaskLimit: before };
  }

  const expected = operation === 'apply' ? EFFECTS_SCOPE_LIMIT : LEGACY_SCOPE_LIMIT;
  const file = operation === 'apply' ? APPLY_FILE : ROLLBACK_FILE;
  let executionError = null;
  try {
    runner(['--file', file]);
  } catch (error) {
    executionError = error;
  }

  // Re-read even after a failed Wrangler process. If D1 committed the batch
  // but the response was lost, the release rollback must know that the schema
  // changed before it considers restoring the previous Worker version.
  const after = readScopeMaskLimit(runner);
  const changed = after === expected;
  writeGithubOutput('applied', String(changed), outputPath);
  if (executionError) {
    throw new Error(
      `Developer API effects-scope ${operation} failed${changed ? ' after D1 committed the schema change' : ''}.`,
      { cause: executionError },
    );
  }
  if (!changed) {
    throw new Error(
      `Developer API effects-scope ${operation} verification failed: expected ${expected}, received ${after}.`,
    );
  }
  stdout.write(
    `${JSON.stringify({ ok: true, operation, applied: true, scopeMaskLimit: after })}\n`,
  );
  return { applied: true, scopeMaskLimit: after };
}

export function runEffectsScopeReleaseRollback(
  {
    runner = runWrangler,
    outputPath = process.env.GITHUB_OUTPUT,
    stdout = process.stdout,
    journalPath = process.env.MXQR_EFFECTS_SCOPE_RELEASE_JOURNAL,
  } = {},
) {
  const journal = readReleaseJournal(journalPath);
  if (!journal) {
    stdout.write(`${JSON.stringify({ ok: true, operation: 'release-rollback', applied: false })}\n`);
    return { applied: false, scopeMaskLimit: null };
  }
  const current = readScopeMaskLimit(runner);
  if (journal.beforeScopeMaskLimit === current) {
    stdout.write(
      `${JSON.stringify({ ok: true, operation: 'release-rollback', applied: false, scopeMaskLimit: current })}\n`,
    );
    return { applied: false, scopeMaskLimit: current };
  }
  if (
    journal.beforeScopeMaskLimit !== LEGACY_SCOPE_LIMIT ||
    current !== EFFECTS_SCOPE_LIMIT
  ) {
    throw new Error(
      `Refusing Developer API release rollback: journal ${journal.beforeScopeMaskLimit}, current ${current}.`,
    );
  }
  return runEffectsScopeMigration('rollback', { runner, outputPath, stdout });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'release-rollback') {
    runEffectsScopeReleaseRollback();
  } else {
    runEffectsScopeMigration(process.argv[2], {
      journalPath: process.env.MXQR_EFFECTS_SCOPE_RELEASE_JOURNAL || null,
    });
  }
}
