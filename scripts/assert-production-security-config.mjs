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
const productionWranglerRoutes = new Map([
  ['cloudflare/wrangler.app.toml', ['musixquare.com', 'www.musixquare.com']],
  ['cloudflare/wrangler.signaling.toml', ['signal.musixquare.com']],
  ['cloudflare/wrangler.remote-share.toml', ['share.musixquare.com']],
  ['cloudflare/wrangler.remote-share.example.toml', ['share.musixquare.com']],
]);
const productionRequiredPatterns = new Map([
  [
    'cloudflare/wrangler.app.toml',
    [
      {
        label: 'Turnstile-disabled PoW policy',
        pattern: /^\s*MXQR_TURNSTILE_DISABLED\s*=\s*["']true["']\s*$/m,
      },
      {
        label: 'atomic D1 API rate-limit binding',
        pattern: /\[\[d1_databases\]\][\s\S]*?^\s*binding\s*=\s*["']MUSIXQUARE_ADMIN_DB["']\s*$/m,
      },
    ],
  ],
  ...['cloudflare/wrangler.remote-share.toml', 'cloudflare/wrangler.remote-share.example.toml'].map(
    (file) => [
      file,
      [
        {
          label: 'atomic remote-share Durable Object binding',
          pattern:
            /\{\s*name\s*=\s*["']REMOTE_SHARE_RATE_LIMITER["']\s*,\s*class_name\s*=\s*["']RemoteShareRateLimiter["']\s*\}/m,
        },
        {
          label: 'remote-share Durable Object SQLite migration',
          pattern:
            /^\s*new_sqlite_classes\s*=\s*\[[^\]]*["']RemoteShareRateLimiter["'][^\]]*\]\s*$/m,
        },
      ],
    ],
  ),
]);

function isTruthy(value) {
  return truthyValues.has(
    String(value || '')
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .toLowerCase(),
  );
}

function normalizeValue(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
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

  const expectedRoutes = productionWranglerRoutes.get(file);
  if (expectedRoutes) {
    for (const setting of ['workers_dev', 'preview_urls']) {
      const match = text.match(new RegExp(`^\\s*${setting}\\s*=\\s*(.+?)\\s*$`, 'm'));
      if (!match || normalizeValue(match[1]).toLowerCase() !== 'false') {
        hits.push({ source: file, flag: `${setting}=false (required)` });
      }
    }
    for (const route of expectedRoutes) {
      const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const routeBlock = new RegExp(
        `\\[\\[routes\\]\\][\\s\\S]*?^\\s*pattern\\s*=\\s*["']${escapedRoute}["'][\\s\\S]*?^\\s*custom_domain\\s*=\\s*true\\s*$`,
        'm',
      );
      if (!routeBlock.test(text)) {
        hits.push({ source: file, flag: `custom-domain route ${route} (required)` });
      }
    }
  }

  for (const required of productionRequiredPatterns.get(file) || []) {
    if (!required.pattern.test(text)) {
      hits.push({ source: file, flag: `${required.label} (required)` });
    }
  }
}

try {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const scripts = packageJson?.scripts || {};
  if (!/^npm run build(?::checked)?$/.test(String(scripts['pretest:e2e:smoke'] || ''))) {
    hits.push({
      source: 'package.json',
      flag: 'smoke E2E must build production assets, never VITE_E2E assets',
    });
  }
  if (scripts['predeploy:app'] !== 'npm run build:checked') {
    hits.push({
      source: 'package.json',
      flag: 'predeploy:app must run the checked production build',
    });
  }
  if (
    !/npx --yes wrangler@4\.110\.0 deploy .*wrangler\.app\.toml/.test(
      String(scripts['deploy:app'] || ''),
    )
  ) {
    hits.push({
      source: 'package.json',
      flag: 'deploy:app must use pinned Wrangler 4.110.0 and target wrangler.app.toml',
    });
  }
} catch (error) {
  hits.push({ source: 'package.json', flag: `valid release scripts required (${String(error)})` });
}

if (hits.length > 0) {
  console.error('[prod-security-guard] Production security/release checks failed:');
  for (const hit of hits) {
    console.error(`  - ${hit.source}: ${hit.flag}`);
  }
  console.error(
    '[prod-security-guard] Fix every production bypass or unsafe release path before deploying.',
  );
  process.exit(1);
}

console.log('[prod-security-guard] OK: no unapproved production fallback flags enabled.');
