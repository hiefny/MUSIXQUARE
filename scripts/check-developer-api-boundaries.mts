import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { experimental_readRawConfig } from 'wrangler';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readDeveloperApiBoundaryConfig(configPath: string): unknown {
  // With an explicit path, this raw-config API only reads and parses that file.
  // It does not load secrets, redirect configs, build, or deploy.
  return experimental_readRawConfig({ config: configPath }).rawConfig;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be a configuration table.`);
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord) ? value : [];
}

function hasBinding(value: unknown, expected: Record<string, unknown>): boolean {
  return records(value).some((binding) =>
    Object.entries(expected).every(([key, entry]) => binding[key] === entry),
  );
}

export function assertDeveloperApiBoundaries(publicValue: unknown, facadeValue: unknown): void {
  const publicConfig = requireRecord(publicValue, 'public Worker');
  const facadeConfig = requireRecord(facadeValue, 'facade Worker');
  const failures: string[] = [];
  const require = (condition: boolean, description: string): void => {
    if (!condition) failures.push(`missing ${description}`);
  };
  const forbid = (condition: boolean, description: string): void => {
    if (condition) failures.push(`forbidden ${description}`);
  };

  for (const [config, name, main, label] of [
    [publicConfig, 'musixquare-developer-api', 'developer-api-worker.ts', 'public'],
    [facadeConfig, 'musixquare-developer-api-facade', 'developer-api-facade-worker.ts', 'facade'],
  ] as const) {
    require(config.name === name, `${label} Worker name`);
    require(config.main === main, `${label} Worker entrypoint`);
    require(config.workers_dev === false, `disabled ${label} workers.dev route`);
    require(config.preview_urls === false, `disabled ${label} preview URL`);
  }
  require(hasBinding(publicConfig.routes, {
    pattern: 'api.musixquare.com',
    custom_domain: true,
  }), 'API custom domain');
  require(hasBinding(publicConfig.d1_databases, {
    binding: 'DEVELOPER_API_DB',
    database_name: 'musixquare-developer-api',
    database_id: '237d63d2-6eea-4b01-b396-7784b5b8b6f0',
  }), 'dedicated API D1 binding, name, and id on the same database');
  const publicDurableObjects = isRecord(publicConfig.durable_objects)
    ? publicConfig.durable_objects.bindings
    : undefined;
  require(hasBinding(publicDurableObjects, {
    name: 'DEVELOPER_API_LIMITERS',
    class_name: 'DeveloperApiRateLimiter',
  }), 'API limiter binding and class');
  require(hasBinding(publicConfig.services, {
    binding: 'DEVELOPER_API_FACADE',
    service: 'musixquare-developer-api-facade',
  }), 'private facade service binding and target');
  const publicVars = isRecord(publicConfig.vars) ? publicConfig.vars : {};
  require(publicVars.DEVELOPER_API_MODE === 'enabled', 'admin-issued room-bound API mode');
  forbid(Object.hasOwn(publicVars, 'DEVELOPER_API_CANARY_ROOMS'), 'stale static canary room list');
  forbid(
    records(publicDurableObjects).some(
      (binding) =>
        binding.class_name === 'MusixquareProRoom' ||
        binding.name === 'PRO_ROOMS' ||
        binding.name === 'PRO_ROOM_DEVELOPER_ROOMS',
    ),
    'PRO room Durable Object binding on the public Worker',
  );
  forbid(
    Object.hasOwn(publicConfig, 'r2_buckets') ||
      records(publicDurableObjects).some(
        (binding) =>
          binding.class_name === 'MusixquareRoom' ||
          (typeof binding.name === 'string' && binding.name.includes('SIGNAL')),
      ),
    'R2 or signaling binding on the public Worker',
  );

  require(isRecord(facadeConfig.version_metadata) &&
    facadeConfig.version_metadata.binding ===
      'CF_VERSION_METADATA', 'facade version metadata binding');
  require(hasBinding(
    isRecord(facadeConfig.durable_objects) ? facadeConfig.durable_objects.bindings : undefined,
    {
      name: 'PRO_ROOM_DEVELOPER_ROOMS',
      class_name: 'MusixquareProRoom',
      script_name: 'musixquare-pro-room',
    },
  ), 'facade PRO room binding, class, and cross-script target');
  forbid(
    ['route', 'routes', 'd1_databases', 'r2_buckets', 'services', 'vars'].some((key) =>
      Object.hasOwn(facadeConfig, key),
    ),
    'public route, storage, service, or variable binding on the facade',
  );

  if (failures.length > 0) {
    throw new Error(
      '[developer-api-boundary] Unsafe Worker boundary configuration:\n' +
        failures.map((failure) => `  - ${failure}`).join('\n'),
    );
  }
}

function main(): void {
  assertDeveloperApiBoundaries(
    readDeveloperApiBoundaryConfig(resolve(root, 'cloudflare/wrangler.developer-api.toml')),
    readDeveloperApiBoundaryConfig(resolve(root, 'cloudflare/wrangler.developer-api-facade.toml')),
  );
  console.log(
    '[developer-api-boundary] OK: public API and private facade bindings remain isolated.',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
