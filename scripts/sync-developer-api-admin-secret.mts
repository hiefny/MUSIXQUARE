import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_CONFIG = 'cloudflare/wrangler.app.toml';
const SECRET_NAME = 'MXQR_DEVELOPER_API_KEY_PEPPER';
const DEFAULT_LOCAL_SECRET_FILE = 'docs/private/developer-api-secrets.json';

export interface DeveloperApiAdminSecretEnvironment extends Record<string, string | undefined> {
  MXQR_DEVELOPER_API_KEY_PEPPER?: string;
  MXQR_DEVELOPER_API_SECRET_FILE?: string;
  npm_execpath?: string;
}

type SecretFileReader = (path: string, encoding: 'utf8') => string;

export interface DeveloperApiAdminPepperOptions {
  env?: DeveloperApiAdminSecretEnvironment;
  readFile?: SecretFileReader;
  secretFile?: string;
}

interface SecretSyncExecutionOptions {
  cwd: string;
  env: DeveloperApiAdminSecretEnvironment;
  input: string;
  stdio: ['pipe', 'inherit', 'inherit'];
}

type SecretSyncExecutor = (
  executable: string,
  args: string[],
  options: SecretSyncExecutionOptions,
) => unknown;

export interface DeveloperApiAdminSecretSyncOptions {
  env?: DeveloperApiAdminSecretEnvironment;
  execute?: SecretSyncExecutor;
  stdout?: { write(value: string): unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const executeSecretSync: SecretSyncExecutor = (executable, args, options) =>
  execFileSync(executable, args, options);

export function readDeveloperApiAdminPepper({
  env = process.env,
  readFile = readFileSync,
  secretFile = env.MXQR_DEVELOPER_API_SECRET_FILE || DEFAULT_LOCAL_SECRET_FILE,
}: DeveloperApiAdminPepperOptions = {}): string {
  const environmentValue = env[SECRET_NAME];
  if (typeof environmentValue === 'string' && environmentValue.length >= 32) {
    return environmentValue;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(resolve(secretFile), 'utf8'));
  } catch {
    throw new Error(
      `${SECRET_NAME} is missing. Set it in the environment or provide the configured local secret file.`,
    );
  }
  const localValue = isRecord(parsed) ? parsed.developerApiKeyPepper : undefined;
  if (typeof localValue !== 'string' || localValue.length < 32) {
    throw new Error(
      'The configured local secret file does not contain a valid developerApiKeyPepper.',
    );
  }
  return localValue;
}

export function syncDeveloperApiAdminPepper({
  env = process.env,
  execute = executeSecretSync,
  stdout = process.stdout,
}: DeveloperApiAdminSecretSyncOptions = {}): void {
  const pepper = readDeveloperApiAdminPepper({ env });
  const npmExecPath = env.npm_execpath;
  if (typeof npmExecPath !== 'string' || !npmExecPath) {
    throw new Error('Run this secret sync through npm run developer-api:admin-secret:sync.');
  }
  try {
    execute(
      process.execPath,
      [
        npmExecPath,
        'run',
        '--silent',
        'wrangler',
        '--',
        'secret',
        'put',
        SECRET_NAME,
        '--config',
        APP_CONFIG,
      ],
      {
        cwd: resolve('.'),
        env,
        input: `${pepper}\n`,
        stdio: ['pipe', 'inherit', 'inherit'],
      },
    );
  } catch {
    throw new Error(`Failed to sync ${SECRET_NAME} to the app Worker.`);
  }
  stdout.write(`Synced ${SECRET_NAME} to the app Worker without printing its value.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    syncDeveloperApiAdminPepper();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Secret sync failed.'}\n`);
    process.exitCode = 1;
  }
}
