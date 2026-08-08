import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  assertOpsDriftContract,
  loadOpsDriftContract,
  normalizeCorsPolicy,
  renderOpsDriftMarkdown,
  runOpsDriftAudit,
} from '../../../scripts/audit-ops-drift.mjs';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('operations drift audit', () => {
  it('validates the checked-in source contract and states manual-only boundaries', () => {
    expect(assertOpsDriftContract()).toEqual({
      schemaVersion: 1,
      r2PolicyCount: 3,
      githubRuleCount: 2,
      manualCheckCount: 4,
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
    expect(step).not.toContain('CLOUDFLARE_API_TOKEN:');

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

  it('passes matching live controls while retaining honest manual-only rows', async () => {
    const contract = loadOpsDriftContract();
    const fetcher = vi.fn(async (url: string) => {
      const cors = contract.r2Cors.find((entry: { bucket: string }) => url.includes(entry.bucket));
      if (cors) {
        const source = await import('node:fs').then(({ readFileSync }) =>
          JSON.parse(readFileSync(cors.source, 'utf8')),
        );
        return jsonResponse({ success: true, result: source });
      }
      return jsonResponse([{ type: 'non_fast_forward' }, { type: 'deletion' }]);
    });

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
    expect(report.checks.filter((check) => check.status === 'pass')).toHaveLength(4);
    expect(report.checks.filter((check) => check.status === 'manual-only')).toHaveLength(4);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/rules/branches/main?per_page=100'),
      expect.any(Object),
    );
    expect(renderOpsDriftMarkdown(report)).toContain('MANUAL');
    expect(renderOpsDriftMarkdown(report)).toContain(
      'were not queried and are not implied to pass',
    );
  });

  it('fails closed for a live CORS mismatch, missing rule, or unavailable credential', async () => {
    const contract = loadOpsDriftContract();
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/r2/buckets/')) {
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
    expect(report.checks.filter((check) => check.status === 'drift')).toHaveLength(4);

    const noCredentials = await runOpsDriftAudit({ contract, fetcher, env: {} });
    expect(noCredentials.status).toBe('attention-required');
    expect(noCredentials.checks.filter((check) => check.status === 'error')).toHaveLength(4);

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
  });
});
