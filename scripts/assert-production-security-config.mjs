import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAccountRolloutConfig } from './production-security-rollout.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dangerousFlags = [
  'MXQR_ALLOW_INFERRED_CAPABILITY_FALLBACK',
  'ALLOW_INFERRED_CAPABILITY_FALLBACK',
  'MXQR_ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK',
  'MXQR_ALLOW_HEADER_CAPABILITY_FALLBACK',
  'ALLOW_TRUSTED_ORIGIN_CAPABILITY_FALLBACK',
  'MXQR_ALLOW_UNGUARDED_PAID_APIS',
  'ALLOW_UNGUARDED_PAID_APIS',
  'MXQR_ALLOW_UNGUARDED_REMOTE_SHARE',
  'ALLOW_UNGUARDED_REMOTE_SHARE',
];

// Static env-style files we always check.
const staticConfigFiles = [
  '.env.cloudflare-turn',
  '.env.cloudflare-turn.example',
  '.env.production',
  '.env.production.local',
  '.dev.vars',
  '.dev.vars.production',
];

// Auto-discover every cloudflare/wrangler*.toml so new workers (and their
// example files) are covered without updating this list. Prevents the
// "added a worker, forgot to extend the guard" failure mode.
async function discoverWranglerFiles() {
  const dir = path.join(repoRoot, 'cloudflare');
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && /^wrangler.*\.toml$/i.test(entry.name))
    .map((entry) => `cloudflare/${entry.name}`)
    .sort();
}

const configFiles = [...staticConfigFiles, ...(await discoverWranglerFiles())];

const truthyValues = new Set(['1', 'true', 'yes', 'on']);

function isTruthy(value) {
  return truthyValues.has(
    String(value || '')
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .toLowerCase(),
  );
}

function readAssignment(line, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = line.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`));
  return match?.[1] ?? null;
}

const hits = [];
const rolloutErrors = [];

for (const flag of dangerousFlags) {
  if (isTruthy(process.env[flag])) {
    hits.push({ source: 'environment', flag });
  }
}

for (const file of configFiles) {
  let text;
  try {
    text = await readFile(path.join(repoRoot, file), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') continue;
    throw error;
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trimStart().startsWith('#')) continue;
    for (const flag of dangerousFlags) {
      const value = readAssignment(line, flag);
      if (value !== null && isTruthy(value)) {
        hits.push({ source: `${file}:${i + 1}`, flag });
      }
    }
  }
}

// Account identity and least-privilege PRO authority are current-contract
// invariants. Reject their retired rollout flags and require both Workers to
// retain the dedicated account database binding. Secrets are verified at
// deploy/runbook time because Wrangler keeps them out of the repository.
const proConfigPath = path.join(repoRoot, 'cloudflare', 'wrangler.pro-room.toml');
const appConfigPath = path.join(repoRoot, 'cloudflare', 'wrangler.app.toml');
const [proConfig, appConfig] = await Promise.all([
  readFile(proConfigPath, 'utf8'),
  readFile(appConfigPath, 'utf8'),
]);

rolloutErrors.push(...validateAccountRolloutConfig(proConfig, appConfig));

if (hits.length > 0 || rolloutErrors.length > 0) {
  console.error('[prod-security-guard] Unsafe production configuration detected:');
  for (const hit of hits) {
    console.error(`  - ${hit.source}: ${hit.flag}`);
  }
  for (const error of rolloutErrors) {
    console.error(`  - account rollout: ${error}`);
  }
  console.error(
    '[prod-security-guard] Fix the production security/rollout configuration before deploying.',
  );
  process.exit(1);
}

console.log('[prod-security-guard] OK: no unapproved bypass or retired rollout flags.');
