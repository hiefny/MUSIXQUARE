import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

if (hits.length > 0) {
  console.error('[prod-security-guard] Dangerous production bypass flags are enabled:');
  for (const hit of hits) {
    console.error(`  - ${hit.source}: ${hit.flag}`);
  }
  console.error(
    '[prod-security-guard] Disable fallback/unguarded API flags before deploying production.',
  );
  process.exit(1);
}

console.log('[prod-security-guard] OK: no unapproved production fallback flags enabled.');
