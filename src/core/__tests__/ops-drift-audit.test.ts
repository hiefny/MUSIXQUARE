import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertOpsDriftContract,
  loadOpsDriftContract,
  normalizeCorsPolicy,
  normalizeLifecyclePolicy,
  normalizeWorkerSecretNames,
  renderOpsDriftMarkdown,
  runOpsDriftAudit,
  shortDeleteLifecycleRules,
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
  GITHUB_DRIFT_AUDIT_TOKEN: 'github-token',
  GITHUB_REPOSITORY: 'hiefny/MUSIXQUARE',
};

function harmlessResponse(url: string): Response {
  return url.startsWith('https://api.github.com/')
    ? jsonResponse([])
    : jsonResponse({ success: true, result: { rules: [] } });
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
    return jsonResponse({ success: true, result: { rules: [] } });
  }
  return jsonResponse([{ type: 'non_fast_forward' }, { type: 'deletion' }]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('operations drift audit', () => {
  it('validates the checked-in source contract and states manual-only boundaries', () => {
    expect(assertOpsDriftContract()).toEqual({
      schemaVersion: 3,
      r2CorsPolicyCount: 3,
      r2ExactLifecyclePolicyCount: 1,
      r2ShortLifecycleGuardCount: 1,
      workerSecretPolicyCount: 6,
      workerSecretNameCount: 36,
      githubRuleCount: 2,
      manualCheckCount: 4,
    });

    const contract = loadOpsDriftContract();
    const appInventory = contract.workerSecrets.find(
      (entry: { worker: string }) => entry.worker === 'musixquare-app',
    );
    const signalingInventory = contract.workerSecrets.find(
      (entry: { worker: string }) => entry.worker === 'musixquare-signaling',
    );
    if (appInventory === undefined || signalingInventory === undefined) {
      throw new Error('Required Worker secret inventory is missing.');
    }
    expect(appInventory.expectedNames).toContain('CLOUDFLARE_REALTIME_API_TOKEN');
    expect(appInventory.expectedNames).not.toContain('CLOUDFLARE_REALTIME_APP_SECRET');
    expect(appInventory.expectedNames).not.toContain('MXQR_PRO_ROOM_REUSE_CANARY_OPS_SECRET');
    expect(signalingInventory.expectedNames).not.toContain('PRO_ROOM_DECOMMISSION_VERIFY_SECRET');
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
    expect(step).not.toContain('CLOUDFLARE_API_TOKEN:');

    const runbook = readFileSync('cloudflare/config-drift-ops.md', 'utf8');
    expect(runbook).toContain('`Workers R2 Storage Read` and `Workers Scripts Read` permissions');
    expect(runbook).toContain(
      '`GET /accounts/{account_id}/workers/scripts/{script_name}/secrets` endpoint',
    );
    expect(runbook).toContain(
      "replace the\nGitHub `production` environment's R2-only `CLOUDFLARE_DRIFT_AUDIT_TOKEN`",
    );
    expect(runbook).toContain('Do not use the deployment token as a\ntemporary bridge');

    const source = readFileSync('scripts/audit-ops-drift.mjs', 'utf8');
    expect(source).toContain('env.CLOUDFLARE_DRIFT_AUDIT_TOKEN,');
    expect(source).not.toContain('env.CLOUDFLARE_DRIFT_AUDIT_TOKEN || env.CLOUDFLARE_API_TOKEN');
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
      env: {
        CLOUDFLARE_ACCOUNT_ID: 'account',
        CLOUDFLARE_DRIFT_AUDIT_TOKEN: 'cloudflare-token',
        GITHUB_DRIFT_AUDIT_TOKEN: 'github-token',
        GITHUB_REPOSITORY: 'hiefny/MUSIXQUARE',
      },
      now: new Date('2026-07-22T00:00:00.000Z'),
    });

    expect(report.status).toBe('automated-checks-passed');
    expect(report.checks.filter((check) => check.status === 'pass')).toHaveLength(12);
    expect(report.checks.filter((check) => check.status === 'manual-only')).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(12);
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
      return jsonResponse([{ type: 'deletion' }]);
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
    expect(noCredentials.checks.filter((check) => check.status === 'error')).toHaveLength(12);

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
