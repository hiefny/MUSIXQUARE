import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ALTERNATE_SIGNALING_DOMAIN,
  PRIMARY_SIGNALING_DOMAIN,
  SIGNALING_DOMAIN_ATTEMPT_FILE,
  SIGNALING_DOMAIN_CANDIDATE_VERIFICATION_FILE,
  SIGNALING_DOMAIN_CHECKPOINT_FILE,
  SIGNALING_DOMAIN_RECOVERY_FILE,
  SIGNALING_SERVICE,
  authorizeSignalingDomainAttempt,
  captureSignalingDomainCheckpoint,
  listWorkerDomains,
  recordSignalingDomainAttempt,
  restoreSignalingDomainBaseline,
  startSignalingDomainAttempt,
  verifySignalingDomainBaseline,
  verifySignalingDomainCandidate,
} from '../../../scripts/release-signaling-domain-state.mts';
import type { SignalingDomainStateOptions } from '../../../scripts/release-signaling-domain-state.mts';

const ACCOUNT_ID = 'a'.repeat(32);
const RELEASE_MESSAGE = `git:${'b'.repeat(40)}`;
const ZONE_ID = 'c'.repeat(32);
const PRIMARY_ID = '1'.repeat(40);
const ALTERNATE_ID = '2'.repeat(40);
const DRIFTED_ALTERNATE_ID = '3'.repeat(40);
const BASELINE_DEPLOYMENT = {
  deploymentId: '11111111-1111-4111-8111-111111111111',
  versionId: '22222222-2222-4222-8222-222222222222',
  message: `git:${'a'.repeat(40)}`,
};
const CANDIDATE_DEPLOYMENT = {
  deploymentId: '33333333-3333-4333-8333-333333333333',
  versionId: '44444444-4444-4444-8444-444444444444',
  message: RELEASE_MESSAGE,
};

interface ApiDomain {
  id: string;
  hostname: string;
  service: string;
  environment?: string | null;
  zone_id: string;
  zone_name: string;
}

function domain(id: string, hostname: string, service = SIGNALING_SERVICE): ApiDomain {
  return {
    id,
    hostname,
    service,
    environment: 'production',
    zone_id: ZONE_ID,
    zone_name: 'musixquare.com',
  };
}

function createCloudflareApi(initial: ApiDomain[]) {
  const domains = [...initial];
  const deletedIds: string[] = [];
  let malformedList = false;
  let malformedDelete = false;
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (init?.method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.split('/').at(-1) || '');
      deletedIds.push(id);
      const index = domains.findIndex((candidate) => candidate.id === id);
      if (index >= 0) domains.splice(index, 1);
      if (malformedDelete) return Response.json({ success: true, result: null });
      return Response.json({ success: true, errors: [], messages: [], result: null });
    }
    if (malformedList) return Response.json({ success: true, result: [] });
    const hostname = url.searchParams.get('hostname');
    const service = url.searchParams.get('service');
    const result = domains.filter(
      (candidate) =>
        (!hostname || candidate.hostname === hostname) &&
        (!service || candidate.service === service),
    );
    const page = Number(url.searchParams.get('page'));
    const perPage = Number(url.searchParams.get('per_page'));
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result,
      result_info: {
        page: page || 1,
        per_page: perPage || Math.max(1, result.length),
        count: result.length,
        total_count: result.length,
        total_pages: 1,
      },
    });
  };
  return {
    deletedIds,
    domains,
    fetcher,
    setMalformedList(value: boolean) {
      malformedList = value;
    },
    setMalformedDelete(value: boolean) {
      malformedDelete = value;
    },
  };
}

const directories: string[] = [];

function directory(): string {
  const result = mkdtempSync(join(tmpdir(), 'mxqr-signaling-domain-'));
  directories.push(result);
  writeFileSync(
    join(result, 'signaling-state.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      target: 'signaling',
      config: 'cloudflare/wrangler.signaling.toml',
      releaseMessage: RELEASE_MESSAGE,
      attempted: true,
      beforeDeploymentId: BASELINE_DEPLOYMENT.deploymentId,
      beforeVersionId: BASELINE_DEPLOYMENT.versionId,
      beforeMessage: BASELINE_DEPLOYMENT.message,
    })}\n`,
    'utf8',
  );
  return result;
}

function options(
  fetcher: typeof fetch,
  overrides: SignalingDomainStateOptions = {},
): SignalingDomainStateOptions {
  return {
    fetcher,
    edgeFetcher: async () => Response.json({ error: 'NOT_FOUND' }, { status: 404 }),
    edgeRetryDelaysMs: [0],
    wait: async () => {},
    querySignalingDeployment: () => CANDIDATE_DEPLOYMENT,
    env: {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      CLOUDFLARE_API_TOKEN: 'test-token',
      RELEASE_MESSAGE,
    },
    now: () => '2026-08-26T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('release signaling Custom Domain recovery', () => {
  it('reads the official single-page account inventory before applying exact local filters', async () => {
    const accountDomains = [
      domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN),
      domain('4'.repeat(40), 'musixquare.com', 'musixquare-app'),
      domain('5'.repeat(40), 'www.musixquare.com', 'musixquare-app'),
      domain('6'.repeat(40), 'api.musixquare.com', 'musixquare-developer-api'),
      domain('7'.repeat(40), 'share.musixquare.com', 'musixquare-remote-share'),
      domain('8'.repeat(40), 'other.musixquare.com', 'other-worker'),
    ];
    const queries: URL[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      queries.push(url);
      return Response.json({
        success: true,
        errors: [],
        messages: [],
        result: accountDomains,
      });
    };

    await expect(
      listWorkerDomains(options(fetcher), { hostname: PRIMARY_SIGNALING_DOMAIN }),
    ).resolves.toEqual([
      {
        id: PRIMARY_ID,
        hostname: PRIMARY_SIGNALING_DOMAIN,
        service: SIGNALING_SERVICE,
        environment: 'production',
        zoneId: ZONE_ID,
        zoneName: 'musixquare.com',
      },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.search).toBe('');
    expect(queries[0]?.searchParams.has('hostname')).toBe(false);
    expect(queries[0]?.searchParams.has('service')).toBe(false);
  });

  it('accepts individually omitted optional result_info fields', async () => {
    const fetcher = async (): Promise<Response> =>
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)],
        result_info: { count: 1 },
      });

    await expect(listWorkerDomains(options(fetcher))).resolves.toHaveLength(1);
  });

  it('fails closed when optional metadata implies a partial single-page inventory', async () => {
    const fetcher = async (): Promise<Response> =>
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: [domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)],
        result_info: { total_count: 6 },
      });

    await expect(listWorkerDomains(options(fetcher))).rejects.toThrow(
      'inconsistent pagination metadata',
    );
  });

  it('detaches only the recorded candidate alias and verifies the primary-only baseline', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();

    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));

    await expect(
      restoreSignalingDomainBaseline('signaling', evidence, options(api.fetcher)),
    ).resolves.toMatchObject({ status: 'restored', mutation: 'detached-alternate' });
    await expect(
      verifySignalingDomainBaseline('signaling', evidence, options(api.fetcher)),
    ).resolves.toMatchObject({ status: 'verified' });
    expect(api.deletedIds).toEqual([ALTERNATE_ID]);
    expect(api.domains).toEqual([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
  });

  it('freshly verifies the exact recorded candidate inventory and active deployment twice', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('all', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('all', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('all', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('all', evidence, options(api.fetcher));
    let deploymentReads = 0;

    await expect(
      verifySignalingDomainCandidate(
        'all',
        evidence,
        options(api.fetcher, {
          querySignalingDeployment: () => {
            deploymentReads += 1;
            return CANDIDATE_DEPLOYMENT;
          },
        }),
      ),
    ).resolves.toMatchObject({ status: 'verified', mutation: 'none' });
    expect(deploymentReads).toBe(2);
    expect(api.deletedIds).toEqual([]);
    expect(
      JSON.parse(
        readFileSync(join(evidence, SIGNALING_DOMAIN_CANDIDATE_VERIFICATION_FILE), 'utf8'),
      ),
    ).toMatchObject({ status: 'verified', mutation: 'none' });
  });

  it.each([
    [
      'missing alias',
      (api: ReturnType<typeof createCloudflareApi>) => {
        api.domains.splice(
          api.domains.findIndex((candidate) => candidate.hostname === ALTERNATE_SIGNALING_DOMAIN),
          1,
        );
      },
    ],
    [
      'foreign alias owner',
      (api: ReturnType<typeof createCloudflareApi>) => {
        api.domains.splice(
          api.domains.findIndex((candidate) => candidate.hostname === ALTERNATE_SIGNALING_DOMAIN),
          1,
          domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN, 'foreign-worker'),
        );
      },
    ],
    [
      'drifted alias identity',
      (api: ReturnType<typeof createCloudflareApi>) => {
        api.domains.splice(
          api.domains.findIndex((candidate) => candidate.hostname === ALTERNATE_SIGNALING_DOMAIN),
          1,
          domain(DRIFTED_ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN),
        );
      },
    ],
  ] as const)('fails final candidate verification on %s', async (_label, mutate) => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    mutate(api);

    await expect(
      verifySignalingDomainCandidate('signaling', evidence, options(api.fetcher)),
    ).rejects.toThrow();
    expect(api.deletedIds).toEqual([]);
    expect(
      JSON.parse(
        readFileSync(join(evidence, SIGNALING_DOMAIN_CANDIDATE_VERIFICATION_FILE), 'utf8'),
      ),
    ).toMatchObject({ status: 'failed', mutation: 'none' });
  });

  it('fails final candidate verification when active Worker ownership changes between reads', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    const newerDeployment = {
      deploymentId: '55555555-5555-4555-8555-555555555555',
      versionId: '66666666-6666-4666-8666-666666666666',
      message: `git:${'c'.repeat(40)}`,
    };
    let deploymentReads = 0;

    await expect(
      verifySignalingDomainCandidate(
        'signaling',
        evidence,
        options(api.fetcher, {
          querySignalingDeployment: () =>
            ++deploymentReads === 1 ? CANDIDATE_DEPLOYMENT : newerDeployment,
        }),
      ),
    ).rejects.toThrow('Worker ownership changed during final candidate verification');
    expect(deploymentReads).toBe(2);
    expect(api.deletedIds).toEqual([]);
  });

  it('never detaches a pre-existing alternate domain', async () => {
    const api = createCloudflareApi([
      domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN),
      domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN),
    ]);
    const evidence = directory();

    await captureSignalingDomainCheckpoint('all', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('all', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('all', evidence, options(api.fetcher));
    await recordSignalingDomainAttempt('all', evidence, options(api.fetcher));
    await expect(
      restoreSignalingDomainBaseline('all', evidence, options(api.fetcher)),
    ).resolves.toMatchObject({ status: 'already-restored', mutation: 'none' });
    expect(api.deletedIds).toEqual([]);
  });

  it.each([
    ['foreign owner', () => domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN, 'foreign-worker')],
    ['duplicate hostname', () => domain(DRIFTED_ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN)],
  ] as const)('fails closed without DELETE on %s drift', async (_label, drift) => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(drift());

    await expect(
      restoreSignalingDomainBaseline('signaling', evidence, options(api.fetcher)),
    ).rejects.toThrow();
    expect(api.deletedIds).toEqual([]);
  });

  it('blocks an alternate identity change after the attempt was recorded', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.splice(
      api.domains.findIndex((candidate) => candidate.hostname === ALTERNATE_SIGNALING_DOMAIN),
      1,
      domain(DRIFTED_ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN),
    );

    await expect(
      restoreSignalingDomainBaseline('signaling', evidence, options(api.fetcher)),
    ).rejects.toThrow('does not match the recorded candidate');
    expect(api.deletedIds).toEqual([]);
  });

  it('blocks a primary identity change after the attempt was recorded', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.splice(
      api.domains.findIndex((candidate) => candidate.hostname === PRIMARY_SIGNALING_DOMAIN),
      1,
      domain('4'.repeat(40), PRIMARY_SIGNALING_DOMAIN),
    );

    await expect(
      restoreSignalingDomainBaseline('signaling', evidence, options(api.fetcher)),
    ).rejects.toThrow('does not match the recorded candidate');
    expect(api.deletedIds).toEqual([]);
  });

  it('never detaches a newly visible alias from authorization-only evidence', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));

    await expect(
      restoreSignalingDomainBaseline('signaling', evidence, options(api.fetcher)),
    ).rejects.toThrow('identity evidence is unavailable');
    expect(api.deletedIds).toEqual([]);
  });

  it('never detaches a drifted pre-existing alternate identity', async () => {
    const api = createCloudflareApi([
      domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN),
      domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN),
    ]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.splice(
      api.domains.findIndex((candidate) => candidate.hostname === ALTERNATE_SIGNALING_DOMAIN),
      1,
      domain(DRIFTED_ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN),
    );

    await expect(
      restoreSignalingDomainBaseline('signaling', evidence, options(api.fetcher)),
    ).rejects.toThrow('automatic detach is forbidden');
    expect(api.deletedIds).toEqual([]);
  });

  it('records that DELETE was issued when post-detach verification fails', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    const originalFetcher = api.fetcher;
    let deleted = false;
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const response = await originalFetcher(input, init);
      if (init?.method === 'DELETE') {
        deleted = true;
        api.domains.splice(0, api.domains.length);
      }
      return response;
    };

    await expect(
      restoreSignalingDomainBaseline('signaling', evidence, options(fetcher)),
    ).rejects.toThrow();
    expect(deleted).toBe(true);
    expect(
      JSON.parse(readFileSync(join(evidence, SIGNALING_DOMAIN_RECOVERY_FILE), 'utf8')),
    ).toMatchObject({ status: 'failed', mutation: 'detached-alternate' });
  });

  it('records an uncertain detach request when Cloudflare loses the DELETE result', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.setMalformedDelete(true);

    await expect(
      restoreSignalingDomainBaseline('signaling', evidence, options(api.fetcher)),
    ).rejects.toThrow('invalid API envelope');
    expect(api.deletedIds).toEqual([ALTERNATE_ID]);
    expect(
      JSON.parse(readFileSync(join(evidence, SIGNALING_DOMAIN_RECOVERY_FILE), 'utf8')),
    ).toMatchObject({ status: 'failed', mutation: 'detach-requested' });
  });

  it('does not delete a live hostname after signaling deployment ownership changes', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    const newerDeployment = {
      deploymentId: '55555555-5555-4555-8555-555555555555',
      versionId: '66666666-6666-4666-8666-666666666666',
      message: `git:${'c'.repeat(40)}`,
    };
    let reads = 0;

    await expect(
      restoreSignalingDomainBaseline(
        'signaling',
        evidence,
        options(api.fetcher, {
          querySignalingDeployment: () => (++reads === 1 ? CANDIDATE_DEPLOYMENT : newerDeployment),
        }),
      ),
    ).rejects.toThrow('ownership changed immediately before domain detach');
    expect(reads).toBe(2);
    expect(api.deletedIds).toEqual([]);
  });

  it('accepts a failed deploy that attached the alias while the captured Worker stayed live', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    const baselineOptions = options(api.fetcher, {
      querySignalingDeployment: () => BASELINE_DEPLOYMENT,
    });
    await captureSignalingDomainCheckpoint('signaling', evidence, baselineOptions);
    await authorizeSignalingDomainAttempt('signaling', evidence, baselineOptions);
    await startSignalingDomainAttempt('signaling', evidence, baselineOptions);
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, baselineOptions);

    await expect(
      restoreSignalingDomainBaseline('signaling', evidence, baselineOptions),
    ).resolves.toMatchObject({ status: 'restored' });
    expect(api.deletedIds).toEqual([ALTERNATE_ID]);
  });

  it('withholds Worker rollback until the alternate edge fingerprint disappears', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));

    await expect(
      restoreSignalingDomainBaseline(
        'signaling',
        evidence,
        options(api.fetcher, {
          edgeFetcher: async () =>
            Response.json(
              { error: 'NOT_FOUND' },
              { status: 404, headers: { 'cache-control': 'no-store' } },
            ),
          edgeRetryDelaysMs: [0, 0],
        }),
      ),
    ).rejects.toThrow('edge detach did not converge');
    expect(api.deletedIds).toEqual([ALTERNATE_ID]);
    expect(
      JSON.parse(readFileSync(join(evidence, SIGNALING_DOMAIN_RECOVERY_FILE), 'utf8')),
    ).toMatchObject({ status: 'failed', mutation: 'detached-alternate' });
  });

  it('requires two consecutive non-signaling edge observations after detach', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    let edgeReads = 0;
    const edgePaths: string[] = [];
    const edgeAuthorizationHeaders: Array<string | null> = [];

    await expect(
      restoreSignalingDomainBaseline(
        'signaling',
        evidence,
        options(api.fetcher, {
          edgeFetcher: async (input, init) => {
            edgeReads += 1;
            edgePaths.push(new URL(String(input)).pathname);
            edgeAuthorizationHeaders.push(new Headers(init?.headers).get('authorization'));
            if (edgeReads === 2) {
              return Response.json(
                { error: 'NOT_FOUND' },
                { status: 404, headers: { 'cache-control': 'no-store' } },
              );
            }
            return Response.json({ error: 'DETACHED' }, { status: 404 });
          },
          edgeRetryDelaysMs: [0, 0, 0],
        }),
      ),
    ).resolves.toMatchObject({ status: 'restored' });
    expect(edgeReads).toBe(4);
    expect(edgePaths).toHaveLength(4);
    expect(edgePaths.every((path) => path.startsWith('/internal/mxqr-domain-detach-probe/'))).toBe(
      true,
    );
    expect(edgeAuthorizationHeaders).toEqual([null, null, null, null]);
  });

  it('rechecks edge absence when a recorded alias is already control-plane absent', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.splice(
      api.domains.findIndex((candidate) => candidate.hostname === ALTERNATE_SIGNALING_DOMAIN),
      1,
    );

    await expect(
      restoreSignalingDomainBaseline(
        'signaling',
        evidence,
        options(api.fetcher, {
          edgeFetcher: async () =>
            Response.json(
              { error: 'NOT_FOUND' },
              { status: 404, headers: { 'cache-control': 'no-store' } },
            ),
          edgeRetryDelaysMs: [0],
        }),
      ),
    ).rejects.toThrow('edge detach did not converge');
    expect(api.deletedIds).toEqual([]);
  });

  it('treats repeated alternate-edge 503 responses as ambiguous, never detached', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));

    await expect(
      restoreSignalingDomainBaseline(
        'signaling',
        evidence,
        options(api.fetcher, {
          edgeFetcher: async () => new Response('temporarily unavailable', { status: 503 }),
          edgeRetryDelaysMs: [0],
        }),
      ),
    ).rejects.toThrow('edge detach did not converge');
    expect(api.deletedIds).toEqual([ALTERNATE_ID]);
  });

  it('fails when the alias is reattached during edge-detach convergence', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    api.domains.push(domain(ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
    await recordSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    let edgeReads = 0;

    await expect(
      restoreSignalingDomainBaseline(
        'signaling',
        evidence,
        options(api.fetcher, {
          edgeFetcher: async () => {
            edgeReads += 1;
            if (edgeReads === 2) {
              api.domains.push(domain(DRIFTED_ALTERNATE_ID, ALTERNATE_SIGNALING_DOMAIN));
            }
            return Response.json({ error: 'DETACHED' }, { status: 404 });
          },
          edgeRetryDelaysMs: [0],
        }),
      ),
    ).rejects.toThrow('changed during edge-detach verification');
    expect(api.deletedIds).toEqual([ALTERNATE_ID]);
  });

  it('blocks the release checkpoint before mutation when capture is malformed', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    api.setMalformedList(true);
    const evidence = directory();
    await expect(
      captureSignalingDomainCheckpoint('all', evidence, options(api.fetcher)),
    ).rejects.toThrow('invalid API envelope');
    expect(() => readFileSync(join(evidence, SIGNALING_DOMAIN_CHECKPOINT_FILE))).toThrow();
    expect(api.deletedIds).toEqual([]);
  });

  it('fails closed when a started deployment has not yet made its alias observable', async () => {
    const api = createCloudflareApi([domain(PRIMARY_ID, PRIMARY_SIGNALING_DOMAIN)]);
    const evidence = directory();
    await captureSignalingDomainCheckpoint('signaling', evidence, options(api.fetcher));
    await authorizeSignalingDomainAttempt('signaling', evidence, options(api.fetcher));
    await startSignalingDomainAttempt('signaling', evidence, options(api.fetcher));

    await expect(
      restoreSignalingDomainBaseline('signaling', evidence, options(api.fetcher)),
    ).rejects.toThrow('may still attach the alternate domain later');
    expect(api.deletedIds).toEqual([]);
  });

  it('is a no-op for app-only releases', async () => {
    const fetcher = async (): Promise<Response> => {
      throw new Error('unexpected Cloudflare request');
    };
    const evidence = directory();
    await expect(captureSignalingDomainCheckpoint('app', evidence, options(fetcher))).resolves.toBe(
      null,
    );
    expect(() => readFileSync(join(evidence, SIGNALING_DOMAIN_ATTEMPT_FILE))).toThrow();
  });

  it('persists authorization before deploy and restores domains before both Worker rollbacks', () => {
    const release = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const independent = readFileSync(resolve('.github/workflows/release-recovery.yml'), 'utf8');
    const capture = release.indexOf('release-signaling-domain-state.mts \\\n            capture');
    const checkpointUpload = release.indexOf('Persist pre-mutation recovery checkpoint');
    const authorizationUpload = release.indexOf(
      'Persist signaling Custom Domain mutation authorization',
    );
    const firstMutation = release.indexOf('Fence room-code reuse during dependency rollout');
    const signalingPreflight = release.indexOf(
      'Preflight signaling Worker and Custom Domain mutation',
    );
    const start = release.indexOf('Mark signaling Custom Domain deployment started');
    const deploy = release.indexOf('Deploy and record signaling Worker');
    const startUpload = release.indexOf(
      'Persist signaling Custom Domain deployment-start evidence',
    );
    const attemptUpload = release.indexOf('Persist signaling Custom Domain attempt evidence');
    const restore = release.indexOf(
      'Restore signaling Custom Domain baseline before Worker rollback',
    );
    const rollback = release.indexOf('Restore release-owned Workers after a failed release');
    const verify = release.indexOf('Freshly verify signaling Custom Domain baseline', rollback);
    const finalWorkerOwnership = release.indexOf(
      'Verify release still owns current production deployments',
    );
    const lastAppSmoke = release.indexOf('Smoke current PRO public boundary after app deployment');
    const readinessRestore = release.indexOf('Restore PRO room generation readiness');
    const candidateVerification = release.indexOf(
      'Freshly verify signaling Custom Domain candidate',
    );
    const productionCommit = release.indexOf('Mark coherent production candidate committed');

    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(checkpointUpload);
    expect(checkpointUpload).toBeLessThan(authorizationUpload);
    expect(authorizationUpload).toBeLessThan(firstMutation);
    expect(signalingPreflight).toBeLessThan(start);
    expect(start).toBeLessThan(startUpload);
    expect(startUpload).toBeLessThan(deploy);
    expect(deploy).toBeLessThan(attemptUpload);
    const attemptUploadEnd = release.indexOf('\n      - name:', attemptUpload + 1);
    expect(release.slice(attemptUpload, attemptUploadEnd)).toContain(
      "steps.signaling_deployment.outcome != 'skipped'",
    );
    expect(restore).toBeLessThan(rollback);
    expect(rollback).toBeLessThan(verify);
    expect(release).toContain('MXQR_SIGNALING_DOMAIN_RECOVERY_OUTCOME=');
    expect(candidateVerification).toBeGreaterThan(finalWorkerOwnership);
    expect(candidateVerification).toBeGreaterThan(lastAppSmoke);
    expect(candidateVerification).toBeGreaterThan(readinessRestore);
    expect(candidateVerification).toBeLessThan(productionCommit);
    const candidateVerificationEnd = release.indexOf('\n      - name:', candidateVerification + 1);
    const candidateVerificationStep = release.slice(
      candidateVerification,
      candidateVerificationEnd,
    );
    expect(candidateVerificationStep).toContain(
      'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
    );
    expect(candidateVerificationStep).toContain('id: signaling_domain_candidate_verification');
    expect(candidateVerificationStep).toContain(
      'verify-candidate "$RELEASE_TARGET" release-artifacts/recovery-checkpoint',
    );
    expect(release.slice(candidateVerificationEnd, productionCommit)).toBe('\n      - name: ');
    expect(release).toContain(
      "- Final signaling Custom Domain candidate verification: \\`${{ steps.signaling_domain_candidate_verification.outcome || 'not-requested' }}\\`",
    );

    const independentDownload = independent.indexOf(
      'Download recorded signaling Custom Domain attempt evidence',
    );
    const independentStart = independent.indexOf(
      'Recover signaling Custom Domain deployment-start evidence',
    );
    const independentAuthorization = independent.indexOf(
      'Recover pre-deploy signaling Custom Domain authorization',
    );
    const independentRestore = independent.indexOf(
      'Restore signaling Custom Domain baseline before Worker rollback',
    );
    const independentRollback = independent.indexOf(
      'Restore release-owned Workers or record a forward-repair boundary',
    );
    const independentVerify = independent.indexOf(
      'Freshly verify signaling Custom Domain baseline',
    );
    expect(independentDownload).toBeGreaterThan(-1);
    expect(independentDownload).toBeLessThan(independentStart);
    expect(independentStart).toBeLessThan(independentAuthorization);
    expect(independentDownload).toBeLessThan(independentRestore);
    expect(independentRestore).toBeLessThan(independentRollback);
    expect(independentRollback).toBeLessThan(independentVerify);
    expect(independent).toContain('MXQR_SIGNALING_DOMAIN_RECOVERY_OUTCOME=');

    for (const [workflow, rollbackName] of [
      [release, 'Restore release-owned Workers after a failed release'],
      [independent, 'Restore release-owned Workers or record a forward-repair boundary'],
    ] as const) {
      const rollbackStart = workflow.indexOf(`- name: ${rollbackName}`);
      const rollbackEnd = workflow.indexOf('\n      - name:', rollbackStart + 1);
      const rollbackStep = workflow.slice(rollbackStart, rollbackEnd);
      const immediateDomainVerification = rollbackStep.indexOf(
        'release-signaling-domain-state.mts \\\n              verify',
      );
      const recoveryPlan = rollbackStep.indexOf('node scripts/release-recovery-plan.mts');
      expect(immediateDomainVerification).toBeGreaterThan(-1);
      expect(immediateDomainVerification).toBeLessThan(recoveryPlan);
      expect(rollbackStep).toContain(
        'MXQR_SIGNALING_DOMAIN_RECOVERY_OUTCOME="$signaling_domain_recovery_outcome"',
      );
    }

    const sameJobFailureStart = release.indexOf(
      '- name: Fail release when automatic recovery is incomplete',
    );
    const sameJobFailure = release.slice(sameJobFailureStart);
    const independentFailureStart = independent.indexOf(
      '- name: Fail independent recovery when automatic recovery is incomplete',
    );
    const independentFailure = independent.slice(independentFailureStart);
    expect(sameJobFailure).toContain("steps.production_commit.outputs.committed != 'true'");
    for (const gate of [sameJobFailure, independentFailure]) {
      expect(gate).toContain("inputs.target == 'all' || inputs.target == 'signaling'");
      for (const outcome of ['failure', 'cancelled', 'skipped']) {
        expect(gate).toContain(`signaling_domain_recovery.outcome == '${outcome}'`);
        expect(gate).toContain(`signaling_domain_verification.outcome == '${outcome}'`);
      }
    }
  });
});
