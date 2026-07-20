#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
  createAccountAssertion,
  verifyAccountAssertion,
} from '../cloudflare/account-assertion.js';
import {
  createStandardRoomAccountAssertion,
  createStandardRoomAccountDeletionAssertion,
  verifyStandardRoomAccountAssertion,
  verifyStandardRoomAccountDeletionAssertion,
} from '../cloudflare/standard-room-account-assertion.js';

export const PRODUCTION_ACCOUNT_CALLBACK = 'https://musixquare.com/api/auth/google/callback';
export const ACCOUNT_STAGE2_DEPLOYMENT_ORDER = ['signaling', 'pro-room', 'app'];

const REPO_ROOT = resolve(import.meta.dirname, '..');
const APP_CONFIG_PATH = 'cloudflare/wrangler.app.toml';
const SIGNALING_CONFIG_PATH = 'cloudflare/wrangler.signaling.toml';
const PRO_ROOM_CONFIG_PATH = 'cloudflare/wrangler.pro-room.toml';
const ACCOUNT_AUTH_PATH = 'cloudflare/account-auth.js';
const ACCOUNT_SCHEMA_PATH = 'cloudflare/auth.schema.sql';

export const EXPECTED_ACCOUNT_SCHEMA_OBJECTS = [
  'idx_mxqr_account_deleted_sessions_expiry',
  'idx_mxqr_account_pro_rooms_account',
  'idx_mxqr_account_sessions_account',
  'idx_mxqr_account_sessions_expiry',
  'idx_mxqr_oauth_flows_expiry',
  'mxqr_account_deleted_sessions',
  'mxqr_account_deletions',
  'mxqr_account_pro_rooms',
  'mxqr_account_sessions',
  'mxqr_accounts',
  'mxqr_oauth_flows',
].sort();

export const REQUIRED_ACCOUNT_SECRET_NAMES = Object.freeze({
  app: [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'MXQR_AUTH_SESSION_PEPPER',
    'MXQR_AUTH_SUBJECT_PEPPER',
    'MXQR_OAUTH_STATE_SECRET',
    'MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET',
    'MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET',
  ],
  signaling: ['MXQR_STANDARD_ROOM_ACCOUNT_ASSERTION_SECRET'],
  'pro-room': ['MXQR_PRO_ROOM_ACCOUNT_ASSERTION_SECRET'],
});

const ACCOUNT_SCHEMA_QUERY =
  "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'index') AND (name LIKE 'mxqr_%' OR name LIKE 'idx_mxqr_%') ORDER BY type, name";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const D1_DATABASE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN_SHARED_DATABASE_NAMES = new Set([
  'musixquare-admin-metrics',
  'musixquare-developer-api',
]);

function unquoteTomlValue(value) {
  const trimmed = String(value || '').trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseTomlAssignment(line) {
  const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
  if (!match || line.trimStart().startsWith('#')) return null;
  return [match[1], unquoteTomlValue(match[2])];
}

/** Parse only the repeated D1 blocks needed by this read-only preflight. */
export function parseD1Bindings(configText) {
  const bindings = [];
  let active = null;
  for (const line of String(configText || '').split(/\r?\n/)) {
    const header = line.trim();
    if (header === '[[d1_databases]]') {
      active = {};
      bindings.push(active);
      continue;
    }
    if (/^\[.+\]$/.test(header)) {
      active = null;
      continue;
    }
    if (!active) continue;
    const assignment = parseTomlAssignment(line);
    if (assignment) active[assignment[0]] = assignment[1];
  }
  return bindings;
}

export function validateAccountD1Binding(configText) {
  const allBindings = parseD1Bindings(configText);
  const matches = allBindings.filter((binding) => binding.binding === 'MUSIXQUARE_AUTH_DB');
  const errors = [];
  if (matches.length !== 1) {
    errors.push('App config must contain exactly one MUSIXQUARE_AUTH_DB D1 binding.');
    return { binding: null, errors };
  }

  const binding = matches[0];
  const databaseName = String(binding.database_name || '').trim();
  const databaseId = String(binding.database_id || '').trim();
  if (
    !databaseName ||
    !D1_DATABASE_NAME_RE.test(databaseName) ||
    /[<>]/.test(databaseName) ||
    /^(todo|replace|placeholder)/i.test(databaseName)
  ) {
    errors.push('MUSIXQUARE_AUTH_DB must use a real database_name, not a placeholder.');
  } else if (FORBIDDEN_SHARED_DATABASE_NAMES.has(databaseName)) {
    errors.push('MUSIXQUARE_AUTH_DB must be a dedicated database, not an existing shared store.');
  }
  if (!UUID_RE.test(databaseId)) {
    errors.push('MUSIXQUARE_AUTH_DB must use a real UUID database_id.');
  } else if (
    allBindings.some(
      (candidate) =>
        candidate !== binding &&
        candidate.binding !== 'MUSIXQUARE_AUTH_DB' &&
        candidate.database_id === databaseId,
    )
  ) {
    errors.push('MUSIXQUARE_AUTH_DB database_id must not be reused by another App binding.');
  }
  return {
    binding: errors.length === 0 ? { databaseName, databaseId } : null,
    errors,
  };
}

export function validateProductionCallback(callback, accountAuthSource, appConfig) {
  const errors = [];
  if (callback !== PRODUCTION_ACCOUNT_CALLBACK) {
    errors.push(`The acknowledged Google callback must be exactly ${PRODUCTION_ACCOUNT_CALLBACK}.`);
  }
  const defaultMatch = String(accountAuthSource || '').match(
    /const\s+DEFAULT_REDIRECT_URI\s*=\s*['"]([^'"]+)['"]/,
  );
  if (defaultMatch?.[1] !== PRODUCTION_ACCOUNT_CALLBACK) {
    errors.push('The App account-auth default callback does not match the production callback.');
  }

  for (const line of String(appConfig || '').split(/\r?\n/)) {
    const assignment = parseTomlAssignment(line);
    if (assignment?.[0] !== 'MXQR_AUTH_REDIRECT_URI') continue;
    if (assignment[1] !== PRODUCTION_ACCOUNT_CALLBACK) {
      errors.push(
        'The App config overrides MXQR_AUTH_REDIRECT_URI with a non-production callback.',
      );
    }
  }
  return errors;
}

export function normalizeSchemaSql(sql) {
  return String(sql || '')
    .trim()
    .replace(/;\s*$/, '')
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .replace(/\s*=\s*/g, '=')
    .trim()
    .toLowerCase();
}

/** Extract the account-owned tables and explicit indexes from the canonical SQL file. */
export function extractAccountSchemaObjects(schemaSql) {
  const objects = new Map();
  const expression =
    /CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[\s\S]*?;/gi;
  for (const match of String(schemaSql || '').matchAll(expression)) {
    const name = match[2];
    if (!name.startsWith('mxqr_') && !name.startsWith('idx_mxqr_')) continue;
    objects.set(name, {
      name,
      type: /TABLE/i.test(match[1]) ? 'table' : 'index',
      sql: match[0],
      normalizedSql: normalizeSchemaSql(match[0]),
    });
  }
  return objects;
}

export function validateAccountSchemaRows(remoteRows, canonicalSchemaSql) {
  const expected = extractAccountSchemaObjects(canonicalSchemaSql);
  const errors = [];
  const expectedNames = [...expected.keys()].sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(EXPECTED_ACCOUNT_SCHEMA_OBJECTS)) {
    errors.push('The canonical account schema file has an unexpected table/index set.');
    return errors;
  }

  const actual = new Map();
  for (const row of Array.isArray(remoteRows) ? remoteRows : []) {
    const name = typeof row?.name === 'string' ? row.name : '';
    if (!name) continue;
    if (actual.has(name)) {
      errors.push(`Remote account schema returned duplicate object ${name}.`);
      continue;
    }
    actual.set(name, row);
  }

  const actualNames = [...actual.keys()].sort();
  for (const missing of expectedNames.filter((name) => !actual.has(name))) {
    errors.push(`Remote account schema is missing ${missing}.`);
  }
  for (const extra of actualNames.filter((name) => !expected.has(name))) {
    errors.push(`Remote account database contains unexpected account object ${extra}.`);
  }
  for (const [name, expectedObject] of expected) {
    const row = actual.get(name);
    if (!row) continue;
    if (row.type !== expectedObject.type) {
      errors.push(`Remote account schema object ${name} has the wrong type.`);
      continue;
    }
    if (normalizeSchemaSql(row.sql) !== expectedObject.normalizedSql) {
      errors.push(`Remote account schema object ${name} differs from cloudflare/auth.schema.sql.`);
    }
  }
  return errors;
}

export function parseD1Rows(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error('Account D1 preflight returned invalid JSON.');
  }
  if (!Array.isArray(payload) || payload.some((result) => result?.success !== true)) {
    throw new Error('Account D1 preflight query failed.');
  }
  return payload.flatMap((result) => (Array.isArray(result.results) ? result.results : []));
}

export function parseSecretNames(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error('Wrangler secret list returned invalid JSON.');
  }
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.result)
      ? payload.result
      : Array.isArray(payload?.secrets)
        ? payload.secrets
        : null;
  if (!entries) throw new Error('Wrangler secret list returned an unsupported result.');
  return new Set(
    entries.map((entry) => (typeof entry?.name === 'string' ? entry.name : '')).filter(Boolean),
  );
}

export function validateRequiredSecretNames(service, names) {
  const required = REQUIRED_ACCOUNT_SECRET_NAMES[service];
  if (!required) throw new Error(`Unknown account preflight service: ${service}`);
  const errors = [];
  for (const name of required) {
    if (!names.has(name)) errors.push(`${service} is missing required secret ${name}.`);
  }
  if (service === 'app' && names.has('MXQR_AUTH_REDIRECT_URI')) {
    errors.push(
      'App has MXQR_AUTH_REDIRECT_URI as an unreadable secret; remove it so the verified production default is used.',
    );
  }
  return errors;
}

export function validateDeploymentOrder(value) {
  const provided = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
  return provided.length === ACCOUNT_STAGE2_DEPLOYMENT_ORDER.length &&
    provided.every((item, index) => item === ACCOUNT_STAGE2_DEPLOYMENT_ORDER[index])
    ? []
    : ['Stage 2 deployment order must be signaling,pro-room,app.'];
}

/**
 * Exercise the exact pure codecs used across Worker trust boundaries. This
 * deliberately uses an ephemeral local key: Wrangler cannot reveal or compare
 * production secret values, and the preflight must never do so.
 */
export async function verifyLocalAssertionRoundTrips() {
  const secret = randomBytes(32).toString('hex');
  const nowSeconds = 2_000_000_000;
  const accountId = 'acct_0000000000000000000000';

  const proToken = await createAccountAssertion(
    {
      accountId,
      nickname: 'Preflight',
      roomCode: '000001',
      audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
    },
    secret,
    nowSeconds,
  );
  const proVerified = await verifyAccountAssertion(proToken, secret, {
    audience: ACCOUNT_ASSERTION_AUDIENCE_PRO_ROOM,
    roomCode: '000001',
    nowSeconds: nowSeconds + 1,
  });

  const standardInput = {
    accountId,
    nickname: 'Preflight',
    roomCode: '123456',
    peerId: 'preflight-peer',
    role: 'guest',
  };
  const standardToken = await createStandardRoomAccountAssertion(standardInput, secret, nowSeconds);
  const standardVerified = await verifyStandardRoomAccountAssertion(standardToken, secret, {
    roomCode: standardInput.roomCode,
    peerId: standardInput.peerId,
    role: standardInput.role,
    nowSeconds: nowSeconds + 1,
  });
  const deletionToken = await createStandardRoomAccountDeletionAssertion(
    standardInput,
    secret,
    nowSeconds,
  );
  const deletionVerified = await verifyStandardRoomAccountDeletionAssertion(deletionToken, secret, {
    roomCode: standardInput.roomCode,
    peerId: standardInput.peerId,
    role: standardInput.role,
    nowSeconds: nowSeconds + 1,
  });
  const deletionRejectedAsAttach = await verifyStandardRoomAccountAssertion(deletionToken, secret, {
    nowSeconds: nowSeconds + 1,
  });

  if (!proVerified || !standardVerified || !deletionVerified || deletionRejectedAsAttach) {
    throw new Error('Local account assertion codec round-trip failed.');
  }
  return ['pro-room', 'standard-room', 'standard-room-delete'];
}

function npmInvocation() {
  const npmCli = process.env.npm_execpath;
  return npmCli
    ? { executable: process.execPath, prefix: [npmCli], shell: false }
    : {
        executable: process.platform === 'win32' ? 'npm.cmd' : 'npm',
        prefix: [],
        shell: process.platform === 'win32',
      };
}

export function buildWranglerReadOnlyCommand(request) {
  if (request.kind === 'd1-schema') {
    return [
      'd1',
      'execute',
      request.databaseName,
      '--remote',
      '--config',
      APP_CONFIG_PATH,
      '--command',
      ACCOUNT_SCHEMA_QUERY,
      '--json',
    ];
  }
  if (request.kind === 'secret-list') {
    return ['secret', 'list', '--config', request.configPath, '--format', 'json'];
  }
  throw new Error('Unsupported Wrangler preflight operation.');
}

function runWranglerReadOnly(request) {
  const npm = npmInvocation();
  const command = buildWranglerReadOnlyCommand(request);

  try {
    return execFileSync(
      npm.executable,
      [...npm.prefix, 'run', '--silent', 'wrangler', '--', ...command],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        shell: npm.shell,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    throw new Error(`Wrangler ${request.kind} preflight failed without exposing command output.`, {
      cause: error,
    });
  }
}

async function readRepositoryText(relativePath) {
  return readFile(resolve(REPO_ROOT, relativePath), 'utf8');
}

export async function runAccountStage2Preflight(
  options,
  { readText = readRepositoryText, runWrangler = runWranglerReadOnly } = {},
) {
  if (options?.remote !== true || options?.confirmProduction !== true) {
    throw new Error('Refusing remote preflight without both --remote and --confirm-production.');
  }

  const [appConfig, accountAuthSource, schemaSql] = await Promise.all([
    readText(APP_CONFIG_PATH),
    readText(ACCOUNT_AUTH_PATH),
    readText(ACCOUNT_SCHEMA_PATH),
  ]);
  const localErrors = [
    ...validateProductionCallback(options.callback, accountAuthSource, appConfig),
    ...validateDeploymentOrder(options.deploymentOrder),
  ];
  const d1 = validateAccountD1Binding(appConfig);
  localErrors.push(...d1.errors);
  const localSchemaNames = [...extractAccountSchemaObjects(schemaSql).keys()].sort();
  if (JSON.stringify(localSchemaNames) !== JSON.stringify(EXPECTED_ACCOUNT_SCHEMA_OBJECTS)) {
    localErrors.push('The canonical account schema file has an unexpected table/index set.');
  }
  if (localErrors.length > 0) throw new Error(localErrors.join('\n'));

  const assertions = await verifyLocalAssertionRoundTrips();
  const d1Output = runWrangler({
    kind: 'd1-schema',
    databaseName: d1.binding.databaseName,
    query: ACCOUNT_SCHEMA_QUERY,
  });
  const remoteSchemaErrors = validateAccountSchemaRows(parseD1Rows(d1Output), schemaSql);

  const secretRequests = [
    ['app', APP_CONFIG_PATH],
    ['signaling', SIGNALING_CONFIG_PATH],
    ['pro-room', PRO_ROOM_CONFIG_PATH],
  ];
  const secretErrors = [];
  const secretCounts = {};
  for (const [service, configPath] of secretRequests) {
    const names = parseSecretNames(runWrangler({ kind: 'secret-list', service, configPath }));
    secretCounts[service] = REQUIRED_ACCOUNT_SECRET_NAMES[service].filter((name) =>
      names.has(name),
    ).length;
    secretErrors.push(...validateRequiredSecretNames(service, names));
  }

  const errors = [...remoteSchemaErrors, ...secretErrors];
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return {
    ok: true,
    callback: PRODUCTION_ACCOUNT_CALLBACK,
    databaseBinding: 'MUSIXQUARE_AUTH_DB',
    databaseName: d1.binding.databaseName,
    schemaObjects: EXPECTED_ACCOUNT_SCHEMA_OBJECTS.length,
    requiredSecretNamesPresent: secretCounts,
    assertionCodecs: assertions,
    deploymentOrder: [...ACCOUNT_STAGE2_DEPLOYMENT_ORDER],
  };
}

export function parsePreflightArguments(argv) {
  const options = {
    remote: false,
    confirmProduction: false,
    callback: '',
    deploymentOrder: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--remote') options.remote = true;
    else if (argument === '--confirm-production') options.confirmProduction = true;
    else if (argument === '--callback') options.callback = argv[++index] || '';
    else if (argument === '--ack-deploy-order') options.deploymentOrder = argv[++index] || '';
    else throw new Error(`Unknown account Stage 2 preflight argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parsePreflightArguments(process.argv.slice(2));
  const result = await runAccountStage2Preflight(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(
    'Preflight is read-only. Deploy signaling -> pro-room -> app/static; this script did not deploy or change flags.\n',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[account-stage2-preflight] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
