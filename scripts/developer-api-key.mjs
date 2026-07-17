import { execFileSync } from 'node:child_process';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  deriveDeveloperApiKeyDigest,
  developerApiScopes,
} from '../cloudflare/developer-api-worker.js';

const DATABASE_NAME = 'musixquare-developer-api';
const WRANGLER_CONFIG = 'cloudflare/wrangler.developer-api.toml';
const ROOM_CODE_RE = /^0\d{5}$/;
const KEY_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const READ_SCOPES = Object.freeze(['room:read', 'playback:read', 'queue:read']);
const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;
const USAGE = [
  'Usage:',
  '  npm run developer-api:key -- issue --room 000001 --label "Friend API" [--days 90] [--scopes room:read,playback:read,queue:read]',
  '  npm run developer-api:key -- list [--room 000001]',
  '  npm run developer-api:key -- revoke --id <16-character-key-id>',
].join('\n');

export class DeveloperApiKeyCliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeveloperApiKeyCliError';
  }
}

function parseFlags(tokens, allowed) {
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith('--') || flag in values) {
      throw new DeveloperApiKeyCliError(USAGE);
    }
    values[flag] = value;
  }
  return values;
}

function parseRoomCode(value) {
  if (!ROOM_CODE_RE.test(value || '')) throw new DeveloperApiKeyCliError(USAGE);
  return value;
}

function parseScopes(value) {
  const scopes = value ? value.split(',').map((scope) => scope.trim()) : [...READ_SCOPES];
  if (
    scopes.length === 0 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !READ_SCOPES.includes(scope))
  ) {
    throw new DeveloperApiKeyCliError(
      `Phase 1 permits only these scopes: ${READ_SCOPES.join(', ')}`,
    );
  }
  return scopes;
}

export function parseDeveloperApiKeyCommand(argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw new DeveloperApiKeyCliError(USAGE);
  const [command, ...tokens] = argv;
  if (tokens.length % 2 !== 0) throw new DeveloperApiKeyCliError(USAGE);
  if (command === 'issue') {
    const flags = parseFlags(tokens, new Set(['--room', '--label', '--days', '--scopes']));
    const label = String(flags['--label'] || '').trim();
    const days = Number(flags['--days'] || DEFAULT_DAYS);
    if (
      label.length === 0 ||
      label.length > 64 ||
      /[\u0000-\u001f\u007f"%&|<>^!]/.test(label) ||
      !Number.isSafeInteger(days) ||
      days < 1 ||
      days > MAX_DAYS
    ) {
      throw new DeveloperApiKeyCliError(USAGE);
    }
    return {
      command,
      roomCode: parseRoomCode(flags['--room']),
      label,
      days,
      scopes: parseScopes(flags['--scopes']),
    };
  }
  if (command === 'revoke') {
    const flags = parseFlags(tokens, new Set(['--id']));
    const keyId = flags['--id'];
    if (!KEY_ID_RE.test(keyId || '')) throw new DeveloperApiKeyCliError(USAGE);
    return { command, keyId };
  }
  if (command === 'list') {
    const flags = parseFlags(tokens, new Set(['--room']));
    return {
      command,
      roomCode: flags['--room'] === undefined ? null : parseRoomCode(flags['--room']),
    };
  }
  throw new DeveloperApiKeyCliError(USAGE);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function executeDeveloperApiD1(sql) {
  const npmArgs = [
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
    '--command',
    sql,
  ];
  const executable =
    process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const args =
    process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', ...npmArgs] : npmArgs;
  let output;
  try {
    output = execFileSync(
      executable,
      args,
      {
        cwd: resolve(import.meta.dirname, '..'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
  } catch {
    throw new DeveloperApiKeyCliError('Developer API key database operation failed');
  }
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new DeveloperApiKeyCliError('Developer API key database returned invalid output');
  }
  if (!Array.isArray(payload) || payload.some((result) => result?.success !== true)) {
    throw new DeveloperApiKeyCliError('Developer API key database operation failed');
  }
  return payload.flatMap((result) => (Array.isArray(result.results) ? result.results : []));
}

export async function runDeveloperApiKeyCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  now = () => Date.now(),
  randomBytes = nodeRandomBytes,
  execute = executeDeveloperApiD1,
} = {}) {
  const command = parseDeveloperApiKeyCommand(argv);
  if (command.command === 'issue') {
    const pepper = env.MXQR_DEVELOPER_API_KEY_PEPPER;
    if (typeof pepper !== 'string' || pepper.length < 32) {
      throw new DeveloperApiKeyCliError(
        'MXQR_DEVELOPER_API_KEY_PEPPER must be supplied through the environment',
      );
    }
    const keyId = randomBytes(12).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    if (!KEY_ID_RE.test(keyId) || secret.length !== 43) {
      throw new DeveloperApiKeyCliError('Secure API key generation failed');
    }
    const digest = await deriveDeveloperApiKeyDigest(pepper, keyId, secret);
    const createdAt = now();
    const expiresAt = createdAt + command.days * 86_400_000;
    const scopeMask = command.scopes.reduce(
      (mask, scope) => mask | developerApiScopes[scope],
      0,
    );
    const inserted = execute(
      `INSERT INTO mxqr_developer_api_keys (` +
        `key_id, room_code, label, secret_digest, digest_version, scope_mask, status, ` +
        `created_at, updated_at, expires_at, revoked_at, last_used_hour` +
        `) VALUES (` +
        `${sqlString(keyId)}, ${sqlString(command.roomCode)}, ${sqlString(command.label)}, ` +
        `${sqlString(digest)}, 1, ${scopeMask}, 'active', ${createdAt}, ${createdAt}, ` +
        `${expiresAt}, NULL, NULL) RETURNING key_id;`,
    );
    if (!inserted.some((row) => row?.key_id === keyId)) {
      throw new DeveloperApiKeyCliError('Developer API key creation was not confirmed');
    }
    const apiKey = `mxqr_live_${keyId}.${secret}`;
    stdout.write(
      `${JSON.stringify(
        {
          apiKey,
          keyId,
          roomCode: command.roomCode,
          label: command.label,
          scopes: command.scopes,
          expiresAt: new Date(expiresAt).toISOString(),
          warning: 'This full API key is shown once. Store it securely now.',
        },
        null,
        2,
      )}\n`,
    );
    return { apiKey, keyId };
  }
  if (command.command === 'revoke') {
    const revokedAt = now();
    const revoked = execute(
      `UPDATE mxqr_developer_api_keys SET status = 'revoked', revoked_at = ${revokedAt}, ` +
        `updated_at = ${revokedAt} WHERE key_id = ${sqlString(command.keyId)} AND status = 'active' ` +
        `RETURNING key_id;`,
    );
    if (!revoked.some((row) => row?.key_id === command.keyId)) {
      throw new DeveloperApiKeyCliError('Developer API key is missing or already revoked');
    }
    stdout.write(`${JSON.stringify({ revoked: true, keyId: command.keyId })}\n`);
    return { revoked: true, keyId: command.keyId };
  }
  const where = command.roomCode ? ` WHERE room_code = ${sqlString(command.roomCode)}` : '';
  const rows = execute(
    `SELECT key_id, room_code, label, scope_mask, status, created_at, updated_at, ` +
      `expires_at, revoked_at, last_used_hour FROM mxqr_developer_api_keys${where} ` +
      `ORDER BY created_at DESC;`,
  );
  stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await runDeveloperApiKeyCli();
  } catch (error) {
    const message =
      error instanceof DeveloperApiKeyCliError ? error.message : 'Developer API key operation failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
