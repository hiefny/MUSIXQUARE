import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertOpsDriftContract,
  loadOpsDriftContract,
  normalizeActiveDeploymentVersions,
  normalizeCorsPolicy,
  normalizeLifecyclePolicy,
  normalizeWorkerBindings,
  normalizeWorkerCustomDomains,
  normalizeWorkerRoutes,
  normalizeWorkerSubdomain,
  normalizeWorkerSecretNames,
  renderOpsDriftMarkdown,
  runOpsDriftAudit,
  shortDeleteLifecycleRules,
  workerSurfaceFromToml,
} from '../../../scripts/audit-ops-drift.mjs';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const AUDIT_ENV = {
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_DRIFT_AUDIT_TOKEN: 'cloudflare-token',
  CLOUDFLARE_ZONE_ID: 'zone',
  CLOUDFLARE_WORKERS_ROUTES_READ_TOKEN: 'routes-token',
  GITHUB_DRIFT_AUDIT_TOKEN: 'github-token',
  GITHUB_REPOSITORY: 'hiefny/MUSIXQUARE',
};

function harmlessResponse(url: string): Response {
  return url.startsWith('https://api.github.com/')
    ? jsonResponse([])
    : jsonResponse({ success: true, result: { rules: [] } });
}

function tomlTables(source: string): Map<string, Array<Map<string, string>>> {
  const result = new Map<string, Array<Map<string, string>>>();
  let current = new Map<string, string>();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[\[?([^\]]+)\]\]?$/u);
    if (header) {
      current = new Map<string, string>();
      const tables = result.get(header[1]) ?? [];
      tables.push(current);
      result.set(header[1], tables);
      continue;
    }
    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/u);
    if (assignment) current.set(assignment[1], assignment[2]);
  }
  return result;
}

function fixtureScalar(raw: string | undefined): string | number | boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw.startsWith('"')) return JSON.parse(raw) as string;
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (/^-?[0-9]+$/u.test(raw)) return Number(raw);
  throw new Error(`Unsupported fixture scalar: ${raw}`);
}

function workerVersionBindingsFixture(source: string): Array<Record<string, unknown>> {
  const rootName = source.match(/^name\s*=\s*"([^"]+)"/mu)?.[1];
  if (!rootName) throw new Error('Fixture Worker name is missing.');
  const tables = tomlTables(source);
  const values = (name: string) => tables.get(name) ?? [];
  const bindings: Array<Record<string, unknown>> = [];
  for (const table of values('assets')) {
    bindings.push({ name: fixtureScalar(table.get('binding')), type: 'assets' });
  }
  for (const table of values('version_metadata')) {
    bindings.push({
      name: fixtureScalar(table.get('binding')),
      type: 'version_metadata',
      id: 'opaque-version-id',
    });
  }
  for (const table of values('vars')) {
    for (const [name, raw] of table) {
      bindings.push({ name, type: 'plain_text', text: String(fixtureScalar(raw)) });
    }
  }
  for (const table of values('r2_buckets')) {
    bindings.push({
      name: fixtureScalar(table.get('binding')),
      type: 'r2_bucket',
      bucket_name: fixtureScalar(table.get('bucket_name')),
    });
  }
  for (const table of values('kv_namespaces')) {
    bindings.push({
      name: fixtureScalar(table.get('binding')),
      type: 'kv_namespace',
      namespace_id: fixtureScalar(table.get('id')),
    });
  }
  for (const table of values('d1_databases')) {
    bindings.push({
      name: fixtureScalar(table.get('binding')),
      type: 'd1',
      database_id: fixtureScalar(table.get('database_id')),
    });
  }
  for (const table of values('durable_objects.bindings')) {
    bindings.push({
      name: fixtureScalar(table.get('name')),
      type: 'durable_object_namespace',
      class_name: fixtureScalar(table.get('class_name')),
      script_name: fixtureScalar(table.get('script_name')) ?? rootName,
    });
  }
  for (const table of values('services')) {
    bindings.push({
      name: fixtureScalar(table.get('binding')),
      type: 'service',
      service: fixtureScalar(table.get('service')),
      environment: fixtureScalar(table.get('environment')) ?? 'production',
    });
  }
  const simple = values('ratelimits.simple');
  for (const [index, table] of values('ratelimits').entries()) {
    bindings.push({
      name: fixtureScalar(table.get('name')),
      type: 'ratelimit',
      namespace_id: fixtureScalar(table.get('namespace_id')),
      simple: {
        limit: fixtureScalar(simple[index]?.get('limit')),
        period: fixtureScalar(simple[index]?.get('period')),
      },
    });
  }
  return bindings;
}

async function matchingLiveResponse(
  contract: ReturnType<typeof loadOpsDriftContract>,
  url: string,
): Promise<Response> {
  const workerSecrets = contract.workerSecrets.find((entry: { worker: string }) =>
    url.includes(`/workers/scripts/${encodeURIComponent(entry.worker)}/secrets`),
  );
  if (workerSecrets !== undefined) {
    return jsonResponse({
      success: true,
      result: workerSecrets.expectedNames.map((name: string) => ({ name, type: 'secret_text' })),
    });
  }
  const requestUrl = new URL(url);
  if (requestUrl.pathname.endsWith('/workers/domains') && !requestUrl.searchParams.has('service')) {
    return jsonResponse({
      success: true,
      result: contract.workerSurfaces.flatMap(
        (surface: { worker: string; customDomains: string[] }) =>
          surface.customDomains.map((hostname) => ({
            id: 'opaque-account-domain-id',
            hostname,
            service: surface.worker,
            environment: 'production',
          })),
      ),
      result_info: { page: 1, per_page: 100, total_pages: 1 },
    });
  }
  const workerSurface = contract.workerSurfaces.find(
    (entry: { worker: string }) =>
      requestUrl.pathname.includes(`/workers/scripts/${encodeURIComponent(entry.worker)}/`) ||
      requestUrl.searchParams.get('service') === entry.worker,
  );
  if (workerSurface !== undefined && url.includes('/deployments')) {
    return jsonResponse({
      success: true,
      result: {
        deployments: [
          {
            id: 'opaque-deployment-id',
            versions: [
              {
                version_id: `opaque-active-version-${workerSurface.worker}`,
                percentage: 100,
              },
            ],
          },
        ],
      },
    });
  }
  if (workerSurface !== undefined && url.includes('/versions/')) {
    const source = readFileSync(workerSurface.source, 'utf8');
    return jsonResponse({
      success: true,
      result: {
        id: 'opaque-version-id',
        resources: {
          bindings: [
            ...workerVersionBindingsFixture(source),
            { name: 'IGNORED_TEST_SECRET', type: 'secret_text', text: 'never-return-this-value' },
          ],
        },
      },
    });
  }
  if (workerSurface !== undefined && url.includes('/subdomain')) {
    return jsonResponse({
      success: true,
      result: {
        enabled: workerSurface.workersDev,
        previews_enabled: workerSurface.previewUrls,
      },
    });
  }
  if (workerSurface !== undefined && url.includes('/workers/domains')) {
    return jsonResponse({
      success: true,
      result: workerSurface.customDomains.map((hostname: string) => ({
        id: 'opaque-domain-id',
        cert_id: 'opaque-certificate-id',
        zone_id: 'opaque-zone-id',
        hostname,
        service: workerSurface.worker,
      })),
      result_info: { page: 1, per_page: 100, total_pages: 1 },
    });
  }
  if (url.includes('/workers/routes')) {
    return jsonResponse({
      success: true,
      result: contract.workerRoutes.expected.map((route: { pattern: string; worker: string }) => ({
        id: 'opaque-route-id',
        pattern: route.pattern,
        script: route.worker,
      })),
    });
  }
  const cors = contract.r2Cors.find(
    (entry: { bucket: string }) => url.includes(entry.bucket) && url.endsWith('/cors'),
  );
  if (cors !== undefined) {
    const source = await import('node:fs').then(({ readFileSync }) =>
      JSON.parse(readFileSync(cors.source, 'utf8')),
    );
    return jsonResponse({ success: true, result: source });
  }
  const lifecycle = contract.r2Lifecycle.exactPolicies.find(
    (entry: { bucket: string }) => url.includes(entry.bucket) && url.endsWith('/lifecycle'),
  );
  if (lifecycle !== undefined) {
    const source = await import('node:fs').then(({ readFileSync }) =>
      JSON.parse(readFileSync(lifecycle.source, 'utf8')),
    );
    return jsonResponse({ success: true, result: source });
  }
  if (url.includes('musixquare-pro-media') && url.endsWith('/lifecycle')) {
    return jsonResponse({
      success: true,
      result: {
        rules: [
          {
            id: 'Default Multipart Abort Rule',
            enabled: true,
            conditions: {},
            abortMultipartUploadsTransition: {
              condition: { type: 'Age', maxAge: 604800 },
            },
          },
        ],
      },
    });
  }
  return jsonResponse([{ type: 'non_fast_forward' }, { type: 'deletion' }]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('operations drift audit', () => {
  it('validates the checked-in source contract and states manual-only boundaries', () => {
    expect(assertOpsDriftContract()).toEqual({
      schemaVersion: 4,
      r2CorsPolicyCount: 3,
      r2ExactLifecyclePolicyCount: 1,
      r2ShortLifecycleGuardCount: 1,
      workerSecretPolicyCount: 6,
      workerSecretNameCount: 38,
      workerSurfacePolicyCount: 6,
      workerBindingCount: 63,
      workerCustomDomainCount: 5,
      workerRouteCount: 0,
      githubRuleCount: 2,
      manualCheckCount: 4,
    });

    const contract = loadOpsDriftContract();
    expect(
      contract.workerSurfaces.map((entry: { environment: string }) => entry.environment),
    ).toEqual(Array.from({ length: 6 }, () => 'production'));
    const appInventory = contract.workerSecrets.find(
      (entry: { worker: string }) => entry.worker === 'musixquare-app',
    );
    const signalingInventory = contract.workerSecrets.find(
      (entry: { worker: string }) => entry.worker === 'musixquare-signaling',
    );
    const remoteShareInventory = contract.workerSecrets.find(
      (entry: { worker: string }) => entry.worker === 'musixquare-remote-share',
    );
    if (
      appInventory === undefined ||
      signalingInventory === undefined ||
      remoteShareInventory === undefined
    ) {
      throw new Error('Required Worker secret inventory is missing.');
    }
    expect(appInventory.expectedNames).toContain('CLOUDFLARE_REALTIME_API_TOKEN');
    expect(appInventory.expectedNames).not.toContain('CLOUDFLARE_REALTIME_APP_SECRET');
    expect(appInventory.expectedNames).not.toContain('MXQR_PRO_ROOM_REUSE_CANARY_OPS_SECRET');
    expect(signalingInventory.expectedNames).not.toContain('PRO_ROOM_DECOMMISSION_VERIFY_SECRET');
    expect(signalingInventory.expectedNames).toContain('MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET');
    expect(remoteShareInventory.expectedNames).toContain(
      'MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET',
    );
    const facade = contract.workerSurfaces.find(
      (entry: { worker: string }) => entry.worker === 'musixquare-developer-api-facade',
    );
    const proRoom = contract.workerSurfaces.find(
      (entry: { worker: string }) => entry.worker === 'musixquare-pro-room',
    );
    expect(facade).toMatchObject({
      exposure: 'none',
      environment: 'production',
      workersDev: false,
      previewUrls: false,
      customDomains: [],
    });
    expect(proRoom).toMatchObject({
      exposure: 'none',
      environment: 'production',
      workersDev: false,
      previewUrls: false,
      customDomains: [],
    });
  });

  it('keeps the live workflow limited to the narrow read-only Cloudflare token', () => {
    const workflow = readFileSync('.github/workflows/ops-drift-audit.yml', 'utf8');
    const stepStart = workflow.indexOf('- name: Compare read-only live controls');
    const nextStep = workflow.indexOf('\n      - name:', stepStart + 1);
    const step = workflow.slice(stepStart, nextStep);

    expect(stepStart).toBeGreaterThan(-1);
    expect(step).toContain(
      'CLOUDFLARE_DRIFT_AUDIT_TOKEN: ${{ secrets.CLOUDFLARE_DRIFT_AUDIT_TOKEN }}',
    );
    expect(step).toContain('Required Cloudflare account permissions: Workers R2 Storage Read');
    expect(step).toContain('and Workers Scripts Read.');
    expect(step).toContain(
      'CLOUDFLARE_WORKERS_ROUTES_READ_TOKEN: ${{ secrets.CLOUDFLARE_WORKERS_ROUTES_READ_TOKEN }}',
    );
    expect(step).toContain('Optional separate permission: Workers Routes Read.');
    expect(step).not.toContain('CLOUDFLARE_API_TOKEN:');

    const runbook = readFileSync('cloudflare/config-drift-ops.md', 'utf8');
    expect(runbook).toContain('`Workers R2 Storage Read` and `Workers Scripts Read` permissions');
    expect(runbook).toContain(
      '`GET /accounts/{account_id}/workers/scripts/{script_name}/secrets` endpoint',
    );
    expect(runbook).toContain("verify that the\nGitHub `production` environment's existing narrow");
    expect(runbook).toContain('Schema v3 already required\nboth permissions');
    expect(runbook.replaceAll(/\s+/gu, ' ')).toContain(
      'Do not use the deployment token as a temporary bridge',
    );

    const source = readFileSync('scripts/audit-ops-drift.mjs', 'utf8');
    expect(source).toContain('env.CLOUDFLARE_DRIFT_AUDIT_TOKEN,');
    expect(source).not.toContain('env.CLOUDFLARE_DRIFT_AUDIT_TOKEN || env.CLOUDFLARE_API_TOKEN');
  });

  it('runs the read-only drift audit daily as well as on manual dispatch', () => {
    const workflow = readFileSync('.github/workflows/ops-drift-audit.yml', 'utf8');

    expect(workflow).toContain("cron: '37 3 * * *'");
    expect(workflow).not.toContain("cron: '37 3 * * 1'");
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).not.toMatch(/permissions:[\s\S]*?\b(?:write|admin)\b/u);
    expect(workflow).not.toContain('wrangler deploy');
    expect(workflow).not.toContain('secret put');
    expect(workflow).not.toContain('r2 bucket cors set');
  });

  it('compares CORS semantically without depending on array or header case order', () => {
    const first = normalizeCorsPolicy({
      rules: [
        {
          id: 'one',
          allowed: {
            origins: ['https://b.example', 'https://a.example'],
            methods: ['put', 'GET'],
            headers: ['Content-Type', 'Range'],
          },
          exposeHeaders: ['ETag', 'Content-Length'],
          maxAgeSeconds: 60,
        },
      ],
    });
    const second = normalizeCorsPolicy({
      rules: [
        {
          id: 'cloudflare-normalized-id',
          allowed: {
            origins: ['https://a.example', 'https://b.example'],
            methods: ['GET', 'PUT'],
            headers: ['range', 'content-type'],
          },
          exposeHeaders: ['content-length', 'etag'],
          maxAgeSeconds: 60,
        },
      ],
    });
    expect(first).toEqual(second);
  });

  it('rejects unknown source CORS keys instead of silently ignoring typos', () => {
    expect(() =>
      normalizeCorsPolicy(
        {
          rules: [
            {
              id: 'one',
              allowed: {
                origins: ['https://example.com'],
                methods: ['GET'],
                headers: [],
                header: ['x-typo'],
              },
              exposeHeaders: [],
              maxAgeSeconds: 60,
            },
          ],
        },
        'source',
        { exactKeys: true },
      ),
    ).toThrow('must contain exactly origins, methods, and headers');
  });

  it('normalizes the exact lifecycle API result and flags short or date-based deletes', () => {
    const policy = normalizeLifecyclePolicy({
      rules: [
        {
          id: 'long-retention',
          enabled: true,
          conditions: { prefix: 'persistent/' },
          deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86401 } },
        },
        {
          id: 'disabled-short-retention',
          enabled: false,
          conditions: { prefix: 'disabled/' },
          deleteObjectsTransition: { condition: { type: 'Age', maxAge: 1 } },
        },
        {
          id: 'short-retention',
          enabled: true,
          conditions: { prefix: 'short/' },
          deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } },
        },
        {
          id: 'date-retention',
          enabled: true,
          conditions: { prefix: 'dated/' },
          deleteObjectsTransition: {
            condition: { type: 'Date', date: '2026-08-10T00:00:00.000Z' },
          },
        },
      ],
    });

    expect(shortDeleteLifecycleRules(policy, 86400)).toEqual([
      'date-retention (2026-08-10T00:00:00.000Z)',
      'short-retention (86400s)',
    ]);
    const cloudflareDefaultRule = {
      rules: [
        {
          id: 'Default Multipart Abort Rule',
          enabled: true,
          conditions: {},
          abortMultipartUploadsTransition: {
            condition: { type: 'Age', maxAge: 604800 },
          },
        },
      ],
    };
    expect(() => normalizeLifecyclePolicy(cloudflareDefaultRule)).toThrow(
      'must declare id, enabled, and the exact conditions.prefix',
    );
    const normalizedDefaultRule = normalizeLifecyclePolicy(cloudflareDefaultRule, 'live', {
      allowEmptyPrefixOmission: true,
    });
    expect(normalizedDefaultRule[0]?.conditions).toEqual({ prefix: '' });
    expect(shortDeleteLifecycleRules(normalizedDefaultRule, 86400)).toEqual([]);

    const omittedPrefixShortDelete = normalizeLifecyclePolicy(
      {
        rules: [
          {
            id: 'unsafe-all-object-expiry',
            enabled: true,
            conditions: {},
            deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } },
          },
        ],
      },
      'live',
      { allowEmptyPrefixOmission: true },
    );
    expect(shortDeleteLifecycleRules(omittedPrefixShortDelete, 86400)).toEqual([
      'unsafe-all-object-expiry (86400s)',
    ]);
    expect(normalizeLifecyclePolicy({})).toEqual([]);
    expect(() =>
      normalizeLifecyclePolicy({ rules: [], rule: [] }, 'source', { exactKeys: true }),
    ).toThrow('must contain exactly rules');
  });

  it('passes matching live controls while retaining honest manual-only rows', async () => {
    const contract = loadOpsDriftContract();
    const fetcher = vi.fn((url: string) => matchingLiveResponse(contract, url));

    const report = await runOpsDriftAudit({
      contract,
      fetcher,
      env: AUDIT_ENV,
      now: new Date('2026-07-22T00:00:00.000Z'),
    });

    expect(
      report.checks.filter((check) => check.status === 'drift' || check.status === 'error'),
    ).toEqual([]);
    expect(report.status).toBe('automated-checks-passed');
    expect(report.checks.filter((check) => check.status === 'pass')).toHaveLength(32);
    expect(report.checks.filter((check) => check.status === 'manual-only')).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(38);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/rules/branches/main?per_page=100'),
      expect.any(Object),
    );
    expect(renderOpsDriftMarkdown(report)).toContain('MANUAL');
    expect(renderOpsDriftMarkdown(report)).toContain(
      'were not queried and are not implied to pass',
    );
  });

  it('fails closed for missing and unexpected Worker secret names without retaining values', async () => {
    const contract = loadOpsDriftContract();
    const appInventory = contract.workerSecrets.find(
      (entry: { worker: string }) => entry.worker === 'musixquare-app',
    );
    if (appInventory === undefined) throw new Error('App secret inventory is missing.');
    const missingName = 'MXQR_CAPABILITY_SECRET';
    const unexpectedName = 'MXQR_PRO_ROOM_REUSE_CANARY_OPS_SECRET';
    const secretValue = 'must-never-appear-in-report-or-markdown';
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/workers/scripts/musixquare-app/secrets')) {
        return jsonResponse({
          success: true,
          result: [
            ...appInventory.expectedNames
              .filter((name: string) => name !== missingName)
              .map((name: string) => ({ name, type: 'secret_text', text: secretValue })),
            { name: unexpectedName, type: 'secret_text', text: secretValue },
          ],
        });
      }
      return matchingLiveResponse(contract, url);
    });

    const report = await runOpsDriftAudit({ contract, fetcher, env: AUDIT_ENV });
    const check = report.checks.find((entry) => entry.id === 'worker-secrets:musixquare-app');
    expect(check).toEqual({
      id: 'worker-secrets:musixquare-app',
      label: 'Worker secrets musixquare-app',
      status: 'drift',
      detail: `Missing secret names: ${missingName}. Unexpected secret names: ${unexpectedName}.`,
    });
    expect(report.status).toBe('attention-required');
    expect(JSON.stringify(report)).not.toContain(secretValue);
    expect(renderOpsDriftMarkdown(report)).not.toContain(secretValue);
  });

  it('normalizes only Worker secret names and ignores value-bearing API fields', () => {
    const secretValue = 'private-secret-value';
    const names = normalizeWorkerSecretNames([
      { name: 'TEXT_SECRET', type: 'secret_text', text: secretValue },
      {
        name: 'KEY_SECRET',
        type: 'secret_key',
        format: 'raw',
        key_base64: secretValue,
      },
    ]);
    expect(names).toEqual(['KEY_SECRET', 'TEXT_SECRET']);
    expect(JSON.stringify(names)).not.toContain(secretValue);
  });

  it('canonicalizes source-only Worker surface fixtures without retaining secrets or opaque IDs', () => {
    const source = `name = "fixture-worker"
workers_dev = false
preview_urls = false

[version_metadata]
binding = "CF_VERSION_METADATA"

[vars]
SECURITY_MODE = "required"

[[routes]]
pattern = "fixture.example.com"
custom_domain = true

[[d1_databases]]
binding = "DB"
database_name = "fixture-db"
database_id = "expected-opaque-database-id"

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "FixtureRoom"

[[services]]
binding = "UPSTREAM"
service = "fixture-upstream"
`;
    const surface = workerSurfaceFromToml(source, 'fixture');
    expect(surface).toMatchObject({
      worker: 'fixture-worker',
      workersDev: false,
      previewUrls: false,
      customDomains: ['fixture.example.com'],
      routes: [],
    });
    const liveBindings = [
      ...workerVersionBindingsFixture(source),
      {
        name: 'IGNORED_SECRET',
        type: 'secret_text',
        text: 'must-never-be-canonicalized',
      },
    ];
    const normalized = normalizeWorkerBindings(liveBindings, source, 'fixture live');
    expect(normalized).toEqual(surface.bindings);
    expect(normalized).toContainEqual({
      name: 'UPSTREAM',
      type: 'service',
      target: 'fixture-upstream',
      environment: 'production',
    });
    expect(JSON.stringify(normalized)).not.toContain('must-never-be-canonicalized');
    expect(JSON.stringify(normalized)).not.toContain('expected-opaque-database-id');
    expect(JSON.stringify(normalized)).not.toContain('opaque-version-id');

    const wrongBindings = liveBindings.map((binding) =>
      binding.name === 'DB'
        ? { ...binding, database_id: 'unexpected-opaque-database-id' }
        : binding.name === 'SECURITY_MODE'
          ? { ...binding, text: 'disabled-and-sensitive' }
          : binding,
    );
    const wrong = normalizeWorkerBindings(wrongBindings, source, 'fixture live');
    expect(wrong).not.toEqual(surface.bindings);
    expect(JSON.stringify(wrong)).not.toContain('unexpected-opaque-database-id');
    expect(JSON.stringify(wrong)).not.toContain('disabled-and-sensitive');

    expect(
      normalizeWorkerCustomDomains(
        [
          {
            hostname: 'FIXTURE.EXAMPLE.COM',
            service: 'fixture-worker',
            id: 'opaque-domain-id',
          },
          { hostname: 'other.example.com', service: 'other-worker' },
        ],
        'fixture-worker',
      ),
    ).toEqual([{ hostname: 'fixture.example.com', environment: 'production' }]);
    expect(
      normalizeWorkerCustomDomains(
        [
          {
            hostname: 'fixture.example.com',
            service: 'fixture-worker',
            environment: 'staging',
          },
        ],
        'fixture-worker',
      ),
    ).toEqual([{ hostname: 'fixture.example.com', environment: 'staging' }]);
    expect(
      normalizeWorkerSubdomain({ enabled: false, previews_enabled: false, tag: 'opaque' }),
    ).toEqual({ workersDev: false, previewUrls: false });
    expect(
      normalizeWorkerRoutes(
        [
          {
            id: 'opaque-route-id',
            pattern: 'fixture.example.com/*',
            script: 'fixture-worker',
          },
          { pattern: 'other.example.com/*', script: 'other-worker' },
        ],
        ['fixture-worker'],
      ),
    ).toEqual([
      { pattern: 'fixture.example.com/*', worker: 'fixture-worker' },
      { pattern: 'other.example.com/*', worker: null },
    ]);
  });

  it('requires a complete one- or two-version active deployment traffic split', () => {
    expect(
      normalizeActiveDeploymentVersions([
        {
          id: 'opaque-deployment-id',
          versions: [
            { version_id: 'opaque-version-a', percentage: 50 },
            { version_id: 'opaque-version-b', percentage: 50 },
          ],
        },
      ]),
    ).toEqual([
      { versionId: 'opaque-version-a', percentage: 50 },
      { versionId: 'opaque-version-b', percentage: 50 },
    ]);
    expect(() =>
      normalizeActiveDeploymentVersions([
        {
          versions: [
            { version_id: 'duplicate', percentage: 50 },
            { version_id: 'duplicate', percentage: 50 },
          ],
        },
      ]),
    ).toThrow('duplicate serving version');
    expect(() =>
      normalizeActiveDeploymentVersions([
        {
          versions: [
            { version_id: 'opaque-version-a', percentage: 0 },
            { version_id: 'opaque-version-b', percentage: 100 },
          ],
        },
      ]),
    ).toThrow('invalid serving version');
    expect(() =>
      normalizeActiveDeploymentVersions([
        {
          versions: [
            { version_id: 'opaque-version-a', percentage: 40 },
            { version_id: 'opaque-version-b', percentage: 50 },
          ],
        },
      ]),
    ).toThrow('percentages must sum to 100');
  });

  it('flags a mismatching version in an active split deployment without reporting version data', async () => {
    const contract = loadOpsDriftContract();
    const app = contract.workerSurfaces.find(
      (entry: { worker: string }) => entry.worker === 'musixquare-app',
    );
    if (app === undefined) throw new Error('App surface is missing.');
    const source = readFileSync(app.source, 'utf8');
    const secretValue = 'split-version-secret-that-must-not-be-reported';
    const firstVersion = 'opaque-split-version-a';
    const secondVersion = 'opaque-split-version-b';
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/workers/scripts/musixquare-app/deployments')) {
        return jsonResponse({
          success: true,
          result: {
            deployments: [
              {
                id: 'opaque-split-deployment-id',
                versions: [
                  { version_id: firstVersion, percentage: 50 },
                  { version_id: secondVersion, percentage: 50 },
                ],
              },
            ],
          },
        });
      }
      if (url.includes(`/workers/scripts/musixquare-app/versions/${firstVersion}`)) {
        return jsonResponse({
          success: true,
          result: { resources: { bindings: workerVersionBindingsFixture(source) } },
        });
      }
      if (url.includes(`/workers/scripts/musixquare-app/versions/${secondVersion}`)) {
        return jsonResponse({
          success: true,
          result: {
            resources: {
              bindings: [
                ...workerVersionBindingsFixture(source),
                { name: 'UNEXPECTED_BINDING', type: 'plain_text', text: secretValue },
              ],
            },
          },
        });
      }
      return matchingLiveResponse(contract, url);
    });

    const report = await runOpsDriftAudit({ contract, fetcher, env: AUDIT_ENV });
    expect(report.checks.find((check) => check.id === 'worker-bindings:musixquare-app')).toEqual({
      id: 'worker-bindings:musixquare-app',
      label: 'Worker bindings musixquare-app',
      status: 'drift',
      detail:
        "At least one actively serving version's non-secret binding names, types, or source-backed targets differ from cloudflare/wrangler.app.toml.",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(firstVersion);
    expect(serialized).not.toContain(secondVersion);
    expect(serialized).not.toContain('opaque-split-deployment-id');
    expect(serialized).not.toContain(secretValue);
  });

  it('treats an explicit staging custom-domain attachment as production drift', async () => {
    const contract = loadOpsDriftContract();
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/workers/domains') && url.includes('musixquare-app')) {
        return jsonResponse({
          success: true,
          result: [
            {
              hostname: 'musixquare.com',
              service: 'musixquare-app',
              environment: 'staging',
            },
            {
              hostname: 'www.musixquare.com',
              service: 'musixquare-app',
              environment: 'production',
            },
          ],
          result_info: { total_pages: 1 },
        });
      }
      return matchingLiveResponse(contract, url);
    });

    const report = await runOpsDriftAudit({ contract, fetcher, env: AUDIT_ENV });
    expect(
      report.checks.find((check) => check.id === 'worker-domains:musixquare-app'),
    ).toMatchObject({
      status: 'drift',
      detail: 'Live custom-domain exposure differs from the exact contract.',
    });
  });

  it('treats every unexpected zone route as drift even when it targets another Worker', async () => {
    const contract = loadOpsDriftContract();
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/workers/routes')) {
        return jsonResponse({
          success: true,
          result: [
            {
              id: 'opaque-rogue-route-id',
              pattern: 'musixquare.com/*',
              script: 'rogue-worker',
            },
          ],
        });
      }
      return matchingLiveResponse(contract, url);
    });

    const report = await runOpsDriftAudit({ contract, fetcher, env: AUDIT_ENV });
    expect(report.checks.find((check) => check.id === 'worker-routes')).toMatchObject({
      status: 'drift',
      detail: 'Live zone routes differ from the exact route contract.',
    });
    expect(JSON.stringify(report)).not.toContain('opaque-rogue-route-id');
    expect(JSON.stringify(report)).not.toContain('rogue-worker');
    expect(JSON.stringify(report)).not.toContain('musixquare.com/*');
  });

  it('detects a project-domain attachment owned by an uncontracted Worker', async () => {
    const contract = loadOpsDriftContract();
    const rogueHostname = 'admin.musixquare.com';
    const rogueWorker = 'rogue-worker';
    const fetcher = vi.fn(async (url: string) => {
      const requestUrl = new URL(url);
      if (
        requestUrl.pathname.endsWith('/workers/domains') &&
        !requestUrl.searchParams.has('service')
      ) {
        const matching = await matchingLiveResponse(contract, url);
        const payload = await matching.json();
        return jsonResponse({
          ...payload,
          result: [
            ...(payload as { result: unknown[] }).result,
            {
              id: 'opaque-rogue-domain-id',
              hostname: rogueHostname,
              service: rogueWorker,
              environment: 'production',
            },
          ],
        });
      }
      return matchingLiveResponse(contract, url);
    });

    const report = await runOpsDriftAudit({ contract, fetcher, env: AUDIT_ENV });
    expect(report.checks.find((check) => check.id === 'worker-domain-inventory')).toMatchObject({
      status: 'drift',
      detail:
        'Project-domain custom-domain exposure differs from the exact account inventory contract.',
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(rogueHostname);
    expect(serialized).not.toContain(rogueWorker);
    expect(serialized).not.toContain('opaque-rogue-domain-id');
  });

  it('reports API failures separately from exposure drift without leaking response data', async () => {
    const contract = loadOpsDriftContract();
    const secretResponseValue = 'api-error-secret-that-must-not-be-reported';
    const leakCheckEnv = {
      ...AUDIT_ENV,
      CLOUDFLARE_ACCOUNT_ID: 'opaque-account-id-that-must-not-be-reported',
      CLOUDFLARE_ZONE_ID: 'opaque-zone-id-that-must-not-be-reported',
      CLOUDFLARE_DRIFT_AUDIT_TOKEN: 'worker-read-token-that-must-not-be-reported',
      CLOUDFLARE_WORKERS_ROUTES_READ_TOKEN: 'route-read-token-that-must-not-be-reported',
    };
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/workers/scripts/musixquare-app/versions/')) {
        return jsonResponse({ error: secretResponseValue }, 403);
      }
      if (url.includes('/workers/domains') && url.includes('musixquare-pro-room')) {
        return jsonResponse({
          success: true,
          result: [
            {
              id: 'opaque-domain-id-that-must-not-be-reported',
              hostname: 'private-worker-accidentally-public.example.com',
              service: 'musixquare-pro-room',
            },
          ],
          result_info: { total_pages: 1 },
        });
      }
      if (url.includes('/workers/routes')) {
        return jsonResponse({
          success: true,
          result: [
            {
              id: 'opaque-route-id-that-must-not-be-reported',
              pattern: 'musixquare.com/private/*',
              script: 'musixquare-developer-api-facade',
            },
          ],
        });
      }
      return matchingLiveResponse(contract, url);
    });

    const report = await runOpsDriftAudit({ contract, fetcher, env: leakCheckEnv });
    expect(
      report.checks.find((check) => check.id === 'worker-bindings:musixquare-app'),
    ).toMatchObject({
      status: 'error',
      detail: 'Worker serving version bindings musixquare-app returned HTTP 403.',
    });
    expect(
      report.checks.find((check) => check.id === 'worker-domains:musixquare-pro-room'),
    ).toMatchObject({ status: 'drift' });
    expect(report.checks.find((check) => check.id === 'worker-routes')).toMatchObject({
      status: 'drift',
    });
    expect(JSON.stringify(report)).not.toContain(secretResponseValue);
    expect(JSON.stringify(report)).not.toContain('opaque-domain-id-that-must-not-be-reported');
    expect(JSON.stringify(report)).not.toContain('opaque-route-id-that-must-not-be-reported');
    expect(JSON.stringify(report)).not.toContain(leakCheckEnv.CLOUDFLARE_ACCOUNT_ID);
    expect(JSON.stringify(report)).not.toContain(leakCheckEnv.CLOUDFLARE_ZONE_ID);
    expect(JSON.stringify(report)).not.toContain(leakCheckEnv.CLOUDFLARE_DRIFT_AUDIT_TOKEN);
    expect(JSON.stringify(report)).not.toContain(leakCheckEnv.CLOUDFLARE_WORKERS_ROUTES_READ_TOKEN);
  });

  it('sanitizes transport failures before retaining them in the audit report', async () => {
    const contract = loadOpsDriftContract();
    const leakCheckEnv = {
      ...AUDIT_ENV,
      CLOUDFLARE_ACCOUNT_ID: 'transport-account-id-that-must-not-be-reported',
      CLOUDFLARE_ZONE_ID: 'transport-zone-id-that-must-not-be-reported',
      CLOUDFLARE_DRIFT_AUDIT_TOKEN: 'transport-worker-token-that-must-not-be-reported',
      CLOUDFLARE_WORKERS_ROUTES_READ_TOKEN: 'transport-route-token-that-must-not-be-reported',
    };
    const servingVersionId = 'transport-version-id-that-must-not-be-reported';
    const fetcher = vi.fn(async (url: string) => {
      if (fetcher.mock.calls.length === 1) {
        throw new Error(
          `network failure for ${url}/${leakCheckEnv.CLOUDFLARE_ACCOUNT_ID}/${leakCheckEnv.CLOUDFLARE_ZONE_ID}/${servingVersionId}?token=${leakCheckEnv.CLOUDFLARE_DRIFT_AUDIT_TOKEN}`,
        );
      }
      return matchingLiveResponse(contract, url);
    });

    const report = await runOpsDriftAudit({ contract, fetcher, env: leakCheckEnv });
    expect(report.checks.some((check) => check.detail.includes('request failed'))).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(leakCheckEnv.CLOUDFLARE_ACCOUNT_ID);
    expect(serialized).not.toContain(leakCheckEnv.CLOUDFLARE_ZONE_ID);
    expect(serialized).not.toContain(leakCheckEnv.CLOUDFLARE_DRIFT_AUDIT_TOKEN);
    expect(serialized).not.toContain(leakCheckEnv.CLOUDFLARE_WORKERS_ROUTES_READ_TOKEN);
    expect(serialized).not.toContain(servingVersionId);
  });

  it('marks optional zone-route coverage manual when both narrow inputs are absent', async () => {
    const contract = loadOpsDriftContract();
    const fetcher = vi.fn((url: string) => matchingLiveResponse(contract, url));
    const report = await runOpsDriftAudit({
      contract,
      fetcher,
      env: {
        CLOUDFLARE_ACCOUNT_ID: AUDIT_ENV.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_DRIFT_AUDIT_TOKEN: AUDIT_ENV.CLOUDFLARE_DRIFT_AUDIT_TOKEN,
        GITHUB_DRIFT_AUDIT_TOKEN: AUDIT_ENV.GITHUB_DRIFT_AUDIT_TOKEN,
        GITHUB_REPOSITORY: AUDIT_ENV.GITHUB_REPOSITORY,
      },
    });
    expect(report.status).toBe('automated-checks-passed');
    expect(report.checks.find((check) => check.id === 'worker-routes')).toMatchObject({
      status: 'manual-only',
    });

    const partial = await runOpsDriftAudit({
      contract,
      fetcher,
      env: {
        CLOUDFLARE_ACCOUNT_ID: AUDIT_ENV.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_DRIFT_AUDIT_TOKEN: AUDIT_ENV.CLOUDFLARE_DRIFT_AUDIT_TOKEN,
        CLOUDFLARE_ZONE_ID: AUDIT_ENV.CLOUDFLARE_ZONE_ID,
        GITHUB_DRIFT_AUDIT_TOKEN: AUDIT_ENV.GITHUB_DRIFT_AUDIT_TOKEN,
        GITHUB_REPOSITORY: AUDIT_ENV.GITHUB_REPOSITORY,
      },
    });
    expect(partial.status).toBe('attention-required');
    expect(partial.checks.find((check) => check.id === 'worker-routes')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('requires both'),
    });
  });

  it('fails closed for a live policy mismatch, missing rule, or unavailable credential', async () => {
    const contract = loadOpsDriftContract();
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/cors')) {
        return jsonResponse({
          success: true,
          result: {
            rules: [
              {
                allowed: { origins: ['*'], methods: ['DELETE'], headers: [] },
                exposeHeaders: [],
                maxAgeSeconds: 0,
              },
            ],
          },
        });
      }
      if (url.includes('musixquare-remote-share') && url.endsWith('/lifecycle')) {
        return jsonResponse({
          success: true,
          result: {
            rules: [
              {
                id: 'wrong-lifecycle',
                enabled: true,
                conditions: { prefix: 'wrong/' },
                deleteObjectsTransition: { condition: { type: 'Age', maxAge: 172800 } },
              },
            ],
          },
        });
      }
      if (url.includes('musixquare-pro-media') && url.endsWith('/lifecycle')) {
        return jsonResponse({
          success: true,
          result: {
            rules: [
              {
                id: 'copied-temporary-media-expiry',
                enabled: true,
                conditions: { prefix: '' },
                deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86400 } },
              },
            ],
          },
        });
      }
      if (url.startsWith('https://api.github.com/')) {
        return jsonResponse([{ type: 'deletion' }]);
      }
      return matchingLiveResponse(contract, url);
    });

    const report = await runOpsDriftAudit({
      contract,
      fetcher,
      env: {
        CLOUDFLARE_ACCOUNT_ID: 'account',
        CLOUDFLARE_DRIFT_AUDIT_TOKEN: 'cloudflare-token',
        GITHUB_DRIFT_AUDIT_TOKEN: 'github-token',
      },
    });
    expect(report.status).toBe('attention-required');
    expect(report.checks.filter((check) => check.status === 'drift')).toHaveLength(6);

    const noCredentials = await runOpsDriftAudit({ contract, fetcher, env: {} });
    expect(noCredentials.status).toBe('attention-required');
    expect(noCredentials.checks.filter((check) => check.status === 'error')).toHaveLength(31);

    const broadTokenOnly = await runOpsDriftAudit({
      contract,
      fetcher,
      env: {
        CLOUDFLARE_ACCOUNT_ID: 'account',
        CLOUDFLARE_API_TOKEN: 'deployment-token-must-not-be-used',
        GITHUB_DRIFT_AUDIT_TOKEN: 'github-token',
      },
    });
    expect(
      broadTokenOnly.checks.filter(
        (check) => check.id.startsWith('r2-cors:') && check.status === 'error',
      ),
    ).toHaveLength(3);
    expect(
      broadTokenOnly.checks.filter(
        (check) => check.id.startsWith('r2-') && check.status === 'error',
      ),
    ).toHaveLength(5);
    expect(
      broadTokenOnly.checks.filter(
        (check) => check.id.startsWith('worker-secrets:') && check.status === 'error',
      ),
    ).toHaveLength(6);
    expect(
      broadTokenOnly.checks.filter(
        (check) =>
          (check.id.startsWith('worker-bindings:') ||
            check.id.startsWith('worker-subdomain:') ||
            check.id.startsWith('worker-domains:')) &&
          check.status === 'error',
      ),
    ).toHaveLength(18);
    expect(
      broadTokenOnly.checks.find((check) => check.id === 'worker-domain-inventory'),
    ).toMatchObject({ status: 'error' });
  });

  it('bounds non-cooperative header waits and cancels the response if it arrives late', async () => {
    const contract = loadOpsDriftContract();
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementationOnce(() => timeout.signal);
    let resolveHeaders!: (value: Response) => void;
    const headers = new Promise<Response>((resolveResponse) => {
      resolveHeaders = resolveResponse;
    });
    const fetcher = vi.fn((url: string) =>
      fetcher.mock.calls.length === 1 ? headers : Promise.resolve(harmlessResponse(url)),
    );
    const pending = runOpsDriftAudit({ contract, fetcher, env: AUDIT_ENV });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    timeout.abort(new DOMException('deadline', 'TimeoutError'));
    const report = await pending;
    expect(report.checks[0]).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('response timed out'),
    });

    const cancellation = vi.fn(() => new Promise<void>(() => undefined));
    resolveHeaders(new Response(new ReadableStream({ cancel: cancellation })));
    await vi.waitFor(() => expect(cancellation).toHaveBeenCalledTimes(1));
  });

  it('uses the header deadline to stop a stalled live-audit response body', async () => {
    const contract = loadOpsDriftContract();
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockImplementationOnce(() => timeout.signal);
    const cancellation = vi.fn();
    const stalled = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":'));
        },
        cancel: cancellation,
      }),
    );
    const fetcher = vi.fn((url: string) =>
      Promise.resolve(fetcher.mock.calls.length === 1 ? stalled : harmlessResponse(url)),
    );
    const pending = runOpsDriftAudit({ contract, fetcher, env: AUDIT_ENV });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    timeout.abort(new DOMException('deadline', 'TimeoutError'));
    const report = await pending;
    expect(report.checks[0]).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('response timed out'),
    });
    expect(cancellation).toHaveBeenCalled();
  });

  it('caps streamed live-audit responses even without Content-Length', async () => {
    const contract = loadOpsDriftContract();
    const oversized = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(512 * 1024 + 1));
        },
      }),
    );
    const fetcher = vi.fn((url: string) =>
      Promise.resolve(fetcher.mock.calls.length === 1 ? oversized : harmlessResponse(url)),
    );

    const report = await runOpsDriftAudit({ contract, fetcher, env: AUDIT_ENV });
    expect(report.checks[0]).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('response ceiling'),
    });
  });

  it('rejects malformed UTF-8 in a live-audit JSON response', async () => {
    const contract = loadOpsDriftContract();
    const malformed = new Response(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]));
    const fetcher = vi.fn((url: string) =>
      Promise.resolve(fetcher.mock.calls.length === 1 ? malformed : harmlessResponse(url)),
    );

    const report = await runOpsDriftAudit({ contract, fetcher, env: AUDIT_ENV });
    expect(report.checks[0]).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('did not return valid UTF-8 JSON'),
    });
  });
});
