import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_CONFIG = 'cloudflare/wrangler.app.toml';
const SECRET_NAME = 'MXQR_DEVELOPER_API_KEY_PEPPER';
const DEFAULT_LOCAL_SECRET_FILE = 'docs/private/developer-api-secrets.json';

export function readDeveloperApiAdminPepper({
  env = process.env,
  readFile = readFileSync,
  secretFile = env.MXQR_DEVELOPER_API_SECRET_FILE || DEFAULT_LOCAL_SECRET_FILE,
} = {}) {
  const environmentValue = String(env[SECRET_NAME] || '');
  if (environmentValue.length >= 32) return environmentValue;

  let parsed;
  try {
    parsed = JSON.parse(readFile(resolve(secretFile), 'utf8'));
  } catch {
    throw new Error(
      `${SECRET_NAME} is missing. Set it in the environment or provide ${secretFile}.`,
    );
  }
  const localValue = String(parsed?.developerApiKeyPepper || '');
  if (localValue.length < 32) {
    throw new Error(`${secretFile} does not contain a valid developerApiKeyPepper.`);
  }
  return localValue;
}

export function syncDeveloperApiAdminPepper({
  env = process.env,
  execute = execFileSync,
  stdout = process.stdout,
} = {}) {
  const pepper = readDeveloperApiAdminPepper({ env });
  const npmExecPath = String(env.npm_execpath || '');
  if (!npmExecPath) {
    throw new Error('Run this secret sync through npm run developer-api:admin-secret:sync.');
  }
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
