import { execFileSync } from 'node:child_process';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  deriveDeveloperApiKeyDigest,
  developerApiScopes,
} from '../cloudflare/developer-api-worker.ts';
import { isProRoomGeneration } from '../cloudflare/pro-room-generation.ts';

const DATABASE_NAME = 'musixquare-developer-api';
const WRANGLER_CONFIG = 'cloudflare/wrangler.developer-api.toml';
const ADMIN_DATABASE_NAME = 'musixquare-admin-metrics';
const ADMIN_WRANGLER_CONFIG = 'cloudflare/wrangler.app.toml';
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
type RoomGenerationResolver = (roomCode: string) => number | Promise<number>;

export interface DeveloperApiKeyCliDependencies {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  stdout?: { write(value: string): unknown };
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  execute?: D1Executor;
  resolveRoomGeneration?: RoomGenerationResolver;
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

export function executeAdminD1(sql: string): DeveloperApiD1Row[] {
  return executeD1(ADMIN_DATABASE_NAME, ADMIN_WRANGLER_CONFIG, sql);
}

export function resolveCurrentProRoomGeneration(
  roomCode: string,
  execute: D1Executor = executeAdminD1,
): number {
  const rows = execute(
    `SELECT room_code, room_generation, status, activation_state ` +
      `FROM mxqr_pro_room_registry WHERE room_code = ${sqlString(roomCode)} LIMIT 2;`,
  );
  const row = rows[0];
  const roomGeneration = row?.room_generation;
  if (
    rows.length !== 1 ||
    row?.room_code !== roomCode ||
    !isProRoomGeneration(roomGeneration) ||
    row.status !== 'registered' ||
    row.activation_state !== 'active'
  ) {
    throw new DeveloperApiKeyCliError(
      'The current active PRO room incarnation could not be verified',
    );
  }
  return roomGeneration;
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
  randomBytes = nodeRandomBytes,
  execute = executeDeveloperApiD1,
  resolveRoomGeneration = resolveCurrentProRoomGeneration,
}: DeveloperApiKeyCliDependencies = {}): Promise<
  IssuedDeveloperApiKey | RevokedDeveloperApiKey | DeveloperApiD1Row[]
> {
  const command = parseDeveloperApiKeyCommand(argv);
  if (command.command === 'issue') {
    const pepper = env.MXQR_DEVELOPER_API_KEY_PEPPER;
    if (typeof pepper !== 'string' || pepper.length < 32) {
      throw new DeveloperApiKeyCliError(
        'MXQR_DEVELOPER_API_KEY_PEPPER must be supplied through the environment',
      );
    }
    const roomGeneration = await resolveRoomGeneration(command.roomCode);
    if (!isProRoomGeneration(roomGeneration)) {
      throw new DeveloperApiKeyCliError(
        'The current active PRO room incarnation could not be verified',
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
    let scopeMask = 0;
    for (const scope of command.scopes) {
      const bit = developerApiScopes[scope];
      if (typeof bit !== 'number' || !Number.isSafeInteger(bit)) {
        throw new DeveloperApiKeyCliError('Developer API scope configuration is invalid');
      }
      scopeMask |= bit;
    }
    const inserted = execute(
      `INSERT INTO mxqr_developer_api_keys (` +
        `key_id, room_code, room_generation, label, secret_digest, digest_version, scope_mask, status, ` +
        `created_at, updated_at, expires_at, revoked_at, last_used_hour` +
        `) VALUES (` +
        `${sqlString(keyId)}, ${sqlString(command.roomCode)}, ${roomGeneration}, ` +
        `${sqlString(command.label)}, ${sqlString(digest)}, 1, ${scopeMask}, 'active', ${createdAt}, ${createdAt}, ` +
        `${expiresAt}, NULL, NULL) RETURNING key_id;`,
    );
    if (!inserted.some((row) => row?.key_id === keyId)) {
      throw new DeveloperApiKeyCliError('Developer API key creation was not confirmed');
    }
    let confirmedGeneration = null;
    try {
      confirmedGeneration = await resolveRoomGeneration(command.roomCode);
    } catch {
      // The cleanup below runs before the error is surfaced, so a registry
      // transition can never leave an unreported credential behind.
    }
    if (confirmedGeneration !== roomGeneration) {
      execute(
        `DELETE FROM mxqr_developer_api_keys WHERE key_id = ${sqlString(keyId)} ` +
          `AND room_code = ${sqlString(command.roomCode)} ` +
          `AND room_generation = ${roomGeneration} AND secret_digest = ${sqlString(digest)};`,
      );
      throw new DeveloperApiKeyCliError(
        'The PRO room incarnation changed while the key was being issued',
      );
    }
    const apiKey = `mxqr_live_${keyId}.${secret}`;
    stdout.write(
      `${JSON.stringify(
        {
          apiKey,
          keyId,
          roomCode: command.roomCode,
          roomGeneration,
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
