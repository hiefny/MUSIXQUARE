import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function withoutComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');
}

function requireMatch(text, pattern, description, failures) {
  if (!pattern.test(text)) failures.push(`missing ${description}`);
}

function forbidMatch(text, pattern, description, failures) {
  if (pattern.test(text)) failures.push(`forbidden ${description}`);
}

const [publicRaw, facadeRaw] = await Promise.all([
  readFile(resolve(root, 'cloudflare/wrangler.developer-api.toml'), 'utf8'),
  readFile(resolve(root, 'cloudflare/wrangler.developer-api-facade.toml'), 'utf8'),
]);
const publicConfig = withoutComments(publicRaw);
const facadeConfig = withoutComments(facadeRaw);
const failures = [];

requireMatch(
  publicConfig,
  /^name\s*=\s*"musixquare-developer-api"\s*$/m,
  'public Worker name',
  failures,
);
requireMatch(
  publicConfig,
  /^main\s*=\s*"developer-api-worker\.js"\s*$/m,
  'public Worker entrypoint',
  failures,
);
requireMatch(
  publicConfig,
  /^workers_dev\s*=\s*false\s*$/m,
  'disabled public workers.dev route',
  failures,
);
requireMatch(
  publicConfig,
  /^preview_urls\s*=\s*false\s*$/m,
  'disabled public preview URL',
  failures,
);
requireMatch(
  publicConfig,
  /^pattern\s*=\s*"api\.musixquare\.com"\s*$/m,
  'API custom domain',
  failures,
);
requireMatch(
  publicConfig,
  /^binding\s*=\s*"DEVELOPER_API_DB"\s*$/m,
  'dedicated API D1 binding',
  failures,
);
requireMatch(
  publicConfig,
  /^database_name\s*=\s*"musixquare-developer-api"\s*$/m,
  'dedicated API D1 name',
  failures,
);
requireMatch(
  publicConfig,
  /^database_id\s*=\s*"237d63d2-6eea-4b01-b396-7784b5b8b6f0"\s*$/m,
  'dedicated API D1 id',
  failures,
);
requireMatch(
  publicConfig,
  /^name\s*=\s*"DEVELOPER_API_LIMITERS"\s*$/m,
  'API limiter binding',
  failures,
);
requireMatch(
  publicConfig,
  /^class_name\s*=\s*"DeveloperApiRateLimiter"\s*$/m,
  'API limiter class',
  failures,
);
requireMatch(
  publicConfig,
  /^binding\s*=\s*"DEVELOPER_API_FACADE"\s*$/m,
  'private facade service binding',
  failures,
);
requireMatch(
  publicConfig,
  /^service\s*=\s*"musixquare-developer-api-facade"\s*$/m,
  'private facade service target',
  failures,
);
requireMatch(
  publicConfig,
  /^DEVELOPER_API_MODE\s*=\s*"enabled"\s*$/m,
  'admin-issued room-bound API mode',
  failures,
);
forbidMatch(
  publicConfig,
  /^DEVELOPER_API_CANARY_ROOMS\s*=/m,
  'stale static canary room list',
  failures,
);
forbidMatch(
  publicConfig,
  /MusixquareProRoom|PRO_ROOMS|PRO_ROOM_DEVELOPER_ROOMS/,
  'PRO room Durable Object binding on the public Worker',
  failures,
);
forbidMatch(
  publicConfig,
  /\[\[r2_buckets\]\]|bucket_name\s*=|SIGNAL|MusixquareRoom/,
  'R2 or signaling binding on the public Worker',
  failures,
);

requireMatch(
  facadeConfig,
  /^name\s*=\s*"musixquare-developer-api-facade"\s*$/m,
  'facade Worker name',
  failures,
);
requireMatch(
  facadeConfig,
  /^main\s*=\s*"developer-api-facade-worker\.js"\s*$/m,
  'facade Worker entrypoint',
  failures,
);
requireMatch(
  facadeConfig,
  /^workers_dev\s*=\s*false\s*$/m,
  'disabled facade workers.dev route',
  failures,
);
requireMatch(
  facadeConfig,
  /^preview_urls\s*=\s*false\s*$/m,
  'disabled facade preview URL',
  failures,
);
requireMatch(
  facadeConfig,
  /^name\s*=\s*"PRO_ROOM_DEVELOPER_ROOMS"\s*$/m,
  'facade PRO room binding',
  failures,
);
requireMatch(
  facadeConfig,
  /^class_name\s*=\s*"MusixquareProRoom"\s*$/m,
  'facade PRO room class',
  failures,
);
requireMatch(
  facadeConfig,
  /^script_name\s*=\s*"musixquare-pro-room"\s*$/m,
  'facade cross-script target',
  failures,
);
forbidMatch(
  facadeConfig,
  /\[\[routes\]\]|custom_domain\s*=|\[\[d1_databases\]\]|\[\[r2_buckets\]\]|\[\[services\]\]|^\[vars\]\s*$/m,
  'public route, storage, service, or variable binding on the facade',
  failures,
);

if (failures.length > 0) {
  console.error('[developer-api-boundary] Unsafe Worker boundary configuration:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('[developer-api-boundary] OK: public API and private facade bindings remain isolated.');
