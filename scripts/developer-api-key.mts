import { execFileSync } from 'node:child_process';
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseDeveloperApiKey } from '../cloudflare/developer-api-worker.ts';
import { createAdminCliClient, isAdminCliTransportFailure } from './admin-cli-client.mts';
import { isProRoomGeneration } from '../cloudflare/pro-room-generation.ts';

const DATABASE_NAME = 'musixquare-developer-api';
const WRANGLER_CONFIG = 'cloudflare/wrangler.developer-api.toml';
const ADMIN_ORIGIN = 'https://musixquare.com';
const ROOM_CODE_RE = /^0\d{5}$/;
const KEY_ID_RE = /^[A-Za-z0-9_-]{16}$/;
export type DeveloperApiScope =
  | 'room:read'
  | 'playback:read'
  | 'playback:control'
  | 'queue:read'
  | 'queue:write'
  | 'media:upload'
  | 'effects:read'
  | 'effects:control';

export type DeveloperApiKeyCommand =
  | {
      command: 'issue';
      roomCode: string;
      label: string;
      days: number;
      scopes: DeveloperApiScope[];
    }
  | { command: 'revoke'; keyId: string }
  | { command: 'list'; roomCode: string | null };

export interface DeveloperApiD1Row extends Record<string, unknown> {
  key_id?: string;
}

type D1Executor = (statement: string) => DeveloperApiD1Row[];

export interface DeveloperApiKeyCliDependencies {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  stdout?: { write(value: string): unknown };
  now?: () => number;
  randomUUID?: () => string;
  fetcher?: typeof fetch;
  execute?: D1Executor;
}

export interface IssuedDeveloperApiKey {
  apiKey: string;
  keyId: string;
}

export interface RevokedDeveloperApiKey {
  revoked: true;
  keyId: string;
}

const READ_SCOPES = [
  'room:read',
  'playback:read',
  'queue:read',
  'effects:read',
] as const satisfies readonly DeveloperApiScope[];
const ISSUABLE_SCOPES = [
  'room:read',
  'playback:read',
  'playback:control',
  'queue:read',
  'queue:write',
  'media:upload',
  'effects:read',
  'effects:control',
] as const satisfies readonly DeveloperApiScope[];
const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;
const USAGE = [
  'Usage:',
  '  npm run developer-api:key -- issue --room 000000 --label "Launch canary" [--days 90] [--scopes room:read,playback:read,playback:control,queue:read,queue:write,media:upload,effects:read,effects:control]',
  '  npm run developer-api:key -- list [--room 000000]',
  '  npm run developer-api:key -- revoke --id <16-character-key-id>',
  'issue requires CF_ACCESS_CLIENT_ID/SECRET and MXQR_ADMIN_PASSWORD or MXQR_ADMIN_SESSION_COOKIE; no local key pepper is used.',
].join('\n');

export class DeveloperApiKeyCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeveloperApiKeyCliError';
  }
}

function parseFlags(
  tokens: readonly string[],
  allowed: ReadonlySet<string>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (
      flag === undefined ||
      !allowed.has(flag) ||
      value === undefined ||
      value.startsWith('--') ||
      flag in values
    ) {
      throw new DeveloperApiKeyCliError(USAGE);
    }
    values[flag] = value;
  }
  return values;
}

function parseRoomCode(value: unknown): string {
  if (typeof value !== 'string' || !ROOM_CODE_RE.test(value)) {
    throw new DeveloperApiKeyCliError(USAGE);
  }
  return value;
}

function isDeveloperApiScope(value: string): value is DeveloperApiScope {
  return ISSUABLE_SCOPES.some((scope) => scope === value);
}

function parseScopes(value: string | undefined): DeveloperApiScope[] {
  const scopes = value ? value.split(',').map((scope) => scope.trim()) : [...READ_SCOPES];
  if (
    scopes.length === 0 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !isDeveloperApiScope(scope))
  ) {
    throw new DeveloperApiKeyCliError(`Permitted scopes: ${ISSUABLE_SCOPES.join(', ')}`);
  }
  return scopes.filter(isDeveloperApiScope);
}

export function parseDeveloperApiKeyCommand(argv: readonly string[]): DeveloperApiKeyCommand {
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
    if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId)) {
      throw new DeveloperApiKeyCliError(USAGE);
    }
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

function sqlString(value: unknown): string {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function executeD1(databaseName: string, wranglerConfig: string, sql: string): DeveloperApiD1Row[] {
  const npmArgs = [
    'run',
    '--silent',
    'wrangler',
    '--',
    'd1',
    'execute',
    databaseName,
    '--remote',
    '--config',
    wranglerConfig,
    '--json',
    '--command',
    sql,
  ];
  const executable = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd', ...npmArgs] : npmArgs;
  let output: string;
  try {
    output = execFileSync(executable, args, {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    throw new DeveloperApiKeyCliError('Developer API key database operation failed');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new DeveloperApiKeyCliError('Developer API key database returned invalid output');
  }
  if (
    !Array.isArray(payload) ||
    payload.some((result) => !isRecord(result) || result.success !== true)
  ) {
    throw new DeveloperApiKeyCliError('Developer API key database operation failed');
  }
  const rows: DeveloperApiD1Row[] = [];
  for (const result of payload) {
    if (!isRecord(result) || !Array.isArray(result.results)) continue;
    for (const row of result.results) {
      if (!isRecord(row)) {
        throw new DeveloperApiKeyCliError('Developer API key database returned invalid output');
      }
      rows.push(row);
    }
  }
  return rows;
}

export function executeDeveloperApiD1(sql: string): DeveloperApiD1Row[] {
  return executeD1(DATABASE_NAME, WRANGLER_CONFIG, sql);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateIssuedKey(
  value: unknown,
  command: Extract<DeveloperApiKeyCommand, { command: 'issue' }>,
  roomGeneration: number,
  nowMs: number,
): { apiKey: string; keyId: string; expiresAt: number } {
  const fail = () =>
    new DeveloperApiKeyCliError('Developer API key issuance returned an invalid confirmation');
  if (
    !hasExactKeys(value, ['roomCode', 'roomGeneration', 'apiKey', 'key']) ||
    value.roomCode !== command.roomCode ||
    value.roomGeneration !== roomGeneration ||
    typeof value.apiKey !== 'string'
  )
    throw fail();
  const credential = parseDeveloperApiKey(value.apiKey);
  const key = value.key;
  if (
    !credential ||
    !hasExactKeys(key, [
      'keyId',
      'roomGeneration',
      'label',
      'scopes',
      'status',
      'createdAt',
      'updatedAt',
      'expiresAt',
      'revokedAt',
      'lastUsedAt',
    ]) ||
    key.keyId !== credential.keyId ||
    key.roomGeneration !== roomGeneration ||
    key.label !== command.label ||
    !Array.isArray(key.scopes) ||
    key.scopes.length !== command.scopes.length ||
    new Set(key.scopes).size !== key.scopes.length ||
    key.scopes.some((scope) => !command.scopes.includes(scope as DeveloperApiScope)) ||
    key.status !== 'active' ||
    !safeTimestamp(key.createdAt) ||
    !safeTimestamp(key.updatedAt) ||
    key.updatedAt < key.createdAt ||
    !safeTimestamp(key.expiresAt) ||
    key.expiresAt - key.createdAt !== command.days * 86_400_000 ||
    key.expiresAt <= nowMs ||
    key.revokedAt !== null ||
    (key.lastUsedAt !== null && !safeTimestamp(key.lastUsedAt))
  )
    throw fail();
  return { apiKey: value.apiKey, keyId: credential.keyId, expiresAt: key.expiresAt };
}

export function runDeveloperApiKeyCli(
  dependencies: DeveloperApiKeyCliDependencies & { argv: readonly ['issue', ...string[]] },
): Promise<IssuedDeveloperApiKey>;
export function runDeveloperApiKeyCli(
  dependencies?: DeveloperApiKeyCliDependencies,
): Promise<IssuedDeveloperApiKey | RevokedDeveloperApiKey | DeveloperApiD1Row[]>;
export async function runDeveloperApiKeyCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  now = () => Date.now(),
  randomUUID = nodeRandomUUID,
  fetcher = globalThis.fetch,
  execute = executeDeveloperApiD1,
}: DeveloperApiKeyCliDependencies = {}): Promise<
  IssuedDeveloperApiKey | RevokedDeveloperApiKey | DeveloperApiD1Row[]
> {
  const command = parseDeveloperApiKeyCommand(argv);
  if (command.command === 'issue') {
    if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
      throw new DeveloperApiKeyCliError(
        'CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required for issuance',
      );
    }
    const client = createAdminCliClient({
      origin: ADMIN_ORIGIN,
      env,
      fetcher,
      ErrorType: DeveloperApiKeyCliError,
      requestLabel: 'Developer API admin request',
      sensitiveLabel: 'Sensitive API key response',
    });
    const path = `/api/admin/pro-rooms/${command.roomCode}/api-keys`;
    const detail = await client.request(path);
    if (
      !hasExactKeys(detail, ['roomCode', 'roomGeneration', 'maxActiveKeys', 'keys']) ||
      detail.roomCode !== command.roomCode ||
      !isProRoomGeneration(detail.roomGeneration) ||
      detail.maxActiveKeys !== 3 ||
      !Array.isArray(detail.keys)
    ) {
      throw new DeveloperApiKeyCliError('The current PRO room incarnation could not be verified');
    }
    const roomGeneration = detail.roomGeneration;
    const requestId = randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(requestId)) {
      throw new DeveloperApiKeyCliError('Secure API key request ID generation failed');
    }
    const body = {
      label: command.label,
      days: command.days,
      scopes: command.scopes,
      requestId,
      roomGeneration,
    };
    let issued: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        issued = await client.request(path, { method: 'POST', body, sensitive: true });
        break;
      } catch (error) {
        if (attempt === 0 && isAdminCliTransportFailure(error)) continue;
        throw error;
      }
    }
    const key = validateIssuedKey(issued, command, roomGeneration, now());
    stdout.write(
      `${JSON.stringify(
        {
          apiKey: key.apiKey,
          keyId: key.keyId,
          roomCode: command.roomCode,
          roomGeneration,
          label: command.label,
          scopes: command.scopes,
          expiresAt: new Date(key.expiresAt).toISOString(),
          warning: 'This full API key is shown once. Store it securely now.',
        },
        null,
        2,
      )}\n`,
    );
    return { apiKey: key.apiKey, keyId: key.keyId };
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
    `SELECT key_id, room_code, room_generation, label, scope_mask, status, created_at, updated_at, ` +
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
      error instanceof DeveloperApiKeyCliError
        ? error.message
        : 'Developer API key operation failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
