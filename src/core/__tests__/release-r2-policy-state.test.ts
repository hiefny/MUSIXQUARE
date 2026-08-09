import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assessR2PolicyRecovery,
  captureR2PolicyCheckpoint,
  readR2ForwardRepairTargets,
  reconcileR2PoliciesWithWorkerBoundary,
  restoreR2Policies,
  verifyPairedRecoveryBoundary,
  verifyR2PolicyRecovery,
  verifyR2PolicyPreflight,
} from '../../../scripts/release-r2-policy-state.mjs';

const temporaryDirectories: string[] = [];
const CANDIDATE_RELEASE_MESSAGE = `git:${'c'.repeat(40)}`;
const ALL_WORKERS = [
  'pro-room',
  'remote-share',
  'signaling',
  'developer-api-facade',
  'developer-api',
  'app',
];

function directory(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'mxqr-r2-recovery-'));
  temporaryDirectories.push(path);
  return path;
}

function policyForUrl(url: string): unknown {
  if (url.endsWith('/cors') && url.includes('remote-share')) {
    return JSON.parse(readFileSync(resolve('cloudflare/r2-cors.remote-share.json'), 'utf8'));
  }
  if (url.endsWith('/lifecycle') && url.includes('remote-share')) {
    return JSON.parse(readFileSync(resolve('cloudflare/r2-lifecycle.remote-share.json'), 'utf8'));
  }
  if (url.endsWith('/cors') && url.includes('pro-media')) {
    return JSON.parse(readFileSync(resolve('cloudflare/r2-cors.pro-media.json'), 'utf8'));
  }
  throw new Error(`Unexpected R2 URL: ${url}`);
}

function response(policy: unknown): Response {
  return Response.json({ success: true, result: policy });
}

function baselinePolicyForUrl(url: string): unknown {
  const baseline = structuredClone(policyForUrl(url)) as {
    rules?: Array<{ allowed?: { headers?: string[] } }>;
  };
  if (url.endsWith('/cors') && url.includes('remote-share')) {
    baseline.rules![0]!.allowed!.headers = baseline.rules![0]!.allowed!.headers!.filter(
      (header) => header !== 'if-match',
    );
  }
  return baseline;
}

function mutablePolicyFetcher(live: Map<string, unknown>) {
  return vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PUT') {
      live.set(url, JSON.parse(String(init.body)));
      return Promise.resolve(Response.json({ success: true, result: {} }));
    }
    const policy = live.get(url);
    if (!policy) throw new Error(`Missing live R2 policy for ${url}.`);
    return Promise.resolve(response(structuredClone(policy)));
  });
}

function writeWorkerRecoveryBoundary(
  root: string,
  targets: string[],
  boundary: 'baseline' | 'candidate',
) {
  for (const target of targets) {
    writeFileSync(
      resolve(root, `${target}-state.json`),
      JSON.stringify({
        schemaVersion: 1,
        target,
        config: `cloudflare/wrangler.${target}.toml`,
        attempted: true,
        beforeVersionId: `${target}-baseline-version`,
        releaseMessage: CANDIDATE_RELEASE_MESSAGE,
      }),
    );
  }
  writeFileSync(
    resolve(root, 'rollback-report.json'),
    JSON.stringify({
      schemaVersion: 1,
      status: boundary === 'baseline' ? 'succeeded' : 'partial-failure',
      results: targets.map((target) => ({
        target,
        status: boundary === 'baseline' ? 'restored' : 'skipped-compatibility-floor',
      })),
    }),
  );
}

function workerQuery(boundary: 'baseline' | 'candidate') {
  return (target: string) => ({
    deploymentId: `${target}-${boundary}-deployment`,
    versionId:
      boundary === 'baseline' ? `${target}-baseline-version` : `${target}-candidate-version`,
    message: boundary === 'candidate' ? CANDIDATE_RELEASE_MESSAGE : `git:${'b'.repeat(40)}`,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('release R2 policy recovery checkpoint', () => {
  it('captures every policy before an all-target release mutates external state', async () => {
    const root = directory();
    const fetcher = vi.fn((input: string | URL | Request) =>
      Promise.resolve(response(policyForUrl(String(input)))),
    );
    const report = await captureR2PolicyCheckpoint('all', root, {
      fetcher,
      env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' },
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(report).toMatchObject({ releaseTarget: 'all', status: 'captured' });
    expect(report.policies).toHaveLength(3);
    expect(
      JSON.parse(readFileSync(resolve(root, 'r2-policy-checkpoint.json'), 'utf8')),
    ).toMatchObject({ status: 'captured' });
  });

  it('requires forward repair and never rewrites a changed candidate or external policy', async () => {
    const root = directory();
    const baselineFetcher = vi.fn((input: string | URL | Request) =>
      Promise.resolve(response(policyForUrl(String(input)))),
    );
    await captureR2PolicyCheckpoint('remote-share', root, {
      fetcher: baselineFetcher,
      env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' },
    });

    const changedCors = structuredClone(
      policyForUrl('https://example.test/musixquare-remote-share/cors'),
    ) as { rules: Array<{ maxAgeSeconds: number }> };
    changedCors.rules[0].maxAgeSeconds += 1;
    const recoveryFetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      const url = String(input);
      return Promise.resolve(response(url.endsWith('/cors') ? changedCors : policyForUrl(url)));
    });
    const report = await restoreR2Policies(root, {
      fetcher: recoveryFetcher,
      env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' },
    });

    expect(report).toMatchObject({
      status: 'forward-repair-required',
      forwardRepairTargets: ['remote-share', 'app'],
    });
    expect(readR2ForwardRepairTargets(root)).toBe('remote-share,app');
    expect(recoveryFetcher).toHaveBeenCalledTimes(2);
  });

  it('treats the exact candidate policy as recoverable instead of prematurely flooring Workers', async () => {
    const root = directory();
    const environment = { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' };
    await captureR2PolicyCheckpoint('remote-share', root, {
      fetcher: (input) => Promise.resolve(response(baselinePolicyForUrl(String(input)))),
      env: environment,
    });

    const report = await assessR2PolicyRecovery(root, {
      fetcher: (input) => Promise.resolve(response(policyForUrl(String(input)))),
      env: environment,
    });
    expect(report).toMatchObject({ status: 'unchanged', forwardRepairTargets: [] });
    expect(report.results).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'candidate-policy-active' })]),
    );
  });

  it('refuses to overwrite an R2 policy changed after the checkpoint', async () => {
    const root = directory();
    const environment = { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' };
    await captureR2PolicyCheckpoint('pro-room', root, {
      fetcher: (input) => Promise.resolve(response(policyForUrl(String(input)))),
      env: environment,
    });
    const changed = structuredClone(
      policyForUrl('https://example.test/musixquare-pro-media/cors'),
    ) as { rules: Array<{ maxAgeSeconds: number }> };
    changed.rules[0].maxAgeSeconds += 1;

    await expect(
      verifyR2PolicyPreflight('pro-media-cors', root, {
        fetcher: () => Promise.resolve(response(changed)),
        env: environment,
      }),
    ).rejects.toThrow('changed after the recovery checkpoint');
  });

  it('restores a captured baseline only from the twice-confirmed candidate and verifies read-back', async () => {
    const root = directory();
    const environment = { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' };
    const candidate = policyForUrl('https://example.test/musixquare-pro-media/cors') as {
      rules: Array<{ maxAgeSeconds: number }>;
    };
    const baseline = structuredClone(candidate);
    baseline.rules[0].maxAgeSeconds = 120;
    await captureR2PolicyCheckpoint('pro-room', root, {
      fetcher: () => Promise.resolve(response(baseline)),
      env: environment,
    });

    const methods: string[] = [];
    let getCount = 0;
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method || 'GET';
      methods.push(method);
      if (method === 'PUT') {
        expect(JSON.parse(String(init?.body))).toEqual(baseline);
        return Promise.resolve(Response.json({ success: true, result: {} }));
      }
      getCount += 1;
      return Promise.resolve(response(getCount <= 2 ? candidate : baseline));
    });

    await expect(restoreR2Policies(root, { fetcher, env: environment })).resolves.toMatchObject({
      status: 'restored-baseline',
      forwardRepairTargets: [],
      results: [{ id: 'pro-media-cors', status: 'restored-baseline' }],
    });
    expect(methods).toEqual(['GET', 'GET', 'PUT', 'GET']);
  });

  it('keeps marker-v3 R2 policy paired with candidate Workers retained by the generation floor', async () => {
    const root = directory();
    const environment = { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' };
    const live = new Map<string, unknown>();
    await captureR2PolicyCheckpoint('all', root, {
      fetcher: (input) => {
        const url = String(input);
        const baseline = baselinePolicyForUrl(url);
        live.set(url, baseline);
        return Promise.resolve(response(baseline));
      },
      env: environment,
    });
    writeWorkerRecoveryBoundary(root, ALL_WORKERS, 'candidate');
    expect(
      readFileSync(resolve('cloudflare/remote-share-contract-version.txt'), 'utf8').trim(),
    ).toBe('canonical-whole-object-actor-replay-v3');

    const fetcher = mutablePolicyFetcher(live);
    const report = await reconcileR2PoliciesWithWorkerBoundary(root, root, {
      fetcher,
      env: environment,
      workerOptions: { queryCurrent: workerQuery('candidate') },
    });

    expect(report).toMatchObject({ status: 'paired-policy-active' });
    expect(report.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'remote-share-cors',
          desiredBoundary: 'candidate',
          status: 'candidate-policy-restored',
        }),
      ]),
    );
    const remoteCorsUrl = [...live.keys()].find(
      (url) => url.includes('remote-share') && url.endsWith('/cors'),
    )!;
    expect(
      (live.get(remoteCorsUrl) as { rules: Array<{ allowed: { headers: string[] } }> }).rules[0]
        .allowed.headers,
    ).toContain('if-match');
    await expect(
      verifyPairedRecoveryBoundary(root, root, {
        fetcher,
        env: environment,
        workerOptions: { queryCurrent: workerQuery('candidate') },
      }),
    ).resolves.toMatchObject({ status: 'verified', workerIdentityStable: true });

    // The old independent gates both passed this incompatible combination:
    // exact candidate Workers plus baseline CORS without the signed If-Match.
    live.set(remoteCorsUrl, baselinePolicyForUrl(remoteCorsUrl));
    await expect(
      verifyPairedRecoveryBoundary(root, root, {
        fetcher,
        env: environment,
        workerOptions: { queryCurrent: workerQuery('candidate') },
      }),
    ).rejects.toThrow('not a coherent boundary');

    live.set(remoteCorsUrl, structuredClone(policyForUrl(remoteCorsUrl)));
    const replacementQuery = (target: string) => ({
      ...workerQuery('candidate')(target),
      deploymentId:
        target === 'remote-share'
          ? 'remote-share-replacement-deployment'
          : `${target}-candidate-deployment`,
    });
    await expect(
      verifyPairedRecoveryBoundary(root, root, {
        fetcher,
        env: environment,
        workerOptions: { queryCurrent: replacementQuery },
      }),
    ).rejects.toThrow('not a coherent boundary');
    expect(
      JSON.parse(readFileSync(resolve(root, 'paired-recovery-verification.json'), 'utf8')),
    ).toMatchObject({ status: 'failed', workerIdentityStable: false });
  });

  it('restores baseline R2 policy after a partial rollout actually restores its Worker', async () => {
    const root = directory();
    const environment = { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' };
    const live = new Map<string, unknown>();
    await captureR2PolicyCheckpoint('remote-share', root, {
      fetcher: (input) => {
        const url = String(input);
        const baseline = baselinePolicyForUrl(url);
        live.set(url, baseline);
        return Promise.resolve(response(baseline));
      },
      env: environment,
    });
    for (const url of live.keys()) live.set(url, structuredClone(policyForUrl(url)));
    writeWorkerRecoveryBoundary(root, ['remote-share'], 'baseline');
    const fetcher = mutablePolicyFetcher(live);

    const report = await reconcileR2PoliciesWithWorkerBoundary(root, root, {
      fetcher,
      env: environment,
      workerOptions: { queryCurrent: workerQuery('baseline') },
    });
    expect(report).toMatchObject({ status: 'paired-policy-active' });
    expect(report.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'remote-share-cors',
          desiredBoundary: 'baseline',
          status: 'baseline-policy-restored',
        }),
      ]),
    );
    const remoteCorsUrl = [...live.keys()].find(
      (url) => url.includes('remote-share') && url.endsWith('/cors'),
    )!;
    expect(
      (live.get(remoteCorsUrl) as { rules: Array<{ allowed: { headers: string[] } }> }).rules[0]
        .allowed.headers,
    ).not.toContain('if-match');
    await expect(
      verifyPairedRecoveryBoundary(root, root, {
        fetcher,
        env: environment,
        workerOptions: { queryCurrent: workerQuery('baseline') },
      }),
    ).resolves.toMatchObject({ status: 'verified' });
  });

  it('fresh-reads every captured policy and records an exact recovered baseline', async () => {
    const root = directory();
    const environment = { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' };
    await captureR2PolicyCheckpoint('remote-share', root, {
      fetcher: (input) => Promise.resolve(response(policyForUrl(String(input)))),
      env: environment,
    });
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      return Promise.resolve(response(policyForUrl(String(input))));
    });

    await expect(
      verifyR2PolicyRecovery(root, { fetcher, env: environment }),
    ).resolves.toMatchObject({
      status: 'verified',
      results: [
        { id: 'remote-share-cors', status: 'baseline-active' },
        { id: 'remote-share-lifecycle', status: 'baseline-active' },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(readFileSync(resolve(root, 'r2-policy-recovery-verification.json'), 'utf8')),
    ).toMatchObject({ status: 'verified' });
  });

  it('fails fresh recovery verification without rewriting a non-baseline policy', async () => {
    const root = directory();
    const environment = { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' };
    const baseline = policyForUrl('https://example.test/musixquare-pro-media/cors') as {
      rules: Array<{ maxAgeSeconds: number }>;
    };
    await captureR2PolicyCheckpoint('pro-room', root, {
      fetcher: () => Promise.resolve(response(baseline)),
      env: environment,
    });
    const changed = structuredClone(baseline);
    changed.rules[0].maxAgeSeconds += 1;
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      return Promise.resolve(response(changed));
    });

    await expect(verifyR2PolicyRecovery(root, { fetcher, env: environment })).rejects.toThrow(
      'Fresh R2 recovery verification failed',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(readFileSync(resolve(root, 'r2-policy-recovery-verification.json'), 'utf8')),
    ).toMatchObject({
      status: 'failed',
      results: [{ id: 'pro-media-cors', status: 'baseline-mismatch' }],
    });
  });

  it('returns the primary cap error even when response cancellation never settles', async () => {
    const never = new Promise<void>(() => undefined);
    const body = new ReadableStream({
      cancel: () => never,
    });
    const oversized = new Response(body, {
      status: 200,
      headers: { 'Content-Length': String(600 * 1024) },
    });
    const result = Promise.race([
      captureR2PolicyCheckpoint('pro-room', directory(), {
        fetcher: () => Promise.resolve(oversized),
        env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' },
      }).then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout('timed-out'), 100)),
    ]);

    await expect(result).resolves.toContain('response ceiling');
  });

  it('bounds non-cooperative header waits and cancels a late response without awaiting cleanup', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    let resolveHeaders!: (value: Response) => void;
    const headers = new Promise<Response>((resolveResponse) => {
      resolveHeaders = resolveResponse;
    });
    const fetcher = vi.fn(() => headers);
    const pending = captureR2PolicyCheckpoint('pro-room', directory(), {
      fetcher,
      env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' },
    });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    timeout.abort(new DOMException('deadline', 'TimeoutError'));
    await expect(pending).rejects.toThrow('pro-media-cors response timed out');

    const cancellation = vi.fn(() => new Promise<void>(() => undefined));
    resolveHeaders(new Response(new ReadableStream({ cancel: cancellation })));
    await vi.waitFor(() => expect(cancellation).toHaveBeenCalledTimes(1));
  });

  it('uses the same deadline to stop a stalled response body', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const cancellation = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"success":'));
      },
      cancel: cancellation,
    });
    const fetcher = vi.fn(() => Promise.resolve(new Response(body, { status: 200 })));
    const pending = captureR2PolicyCheckpoint('pro-room', directory(), {
      fetcher,
      env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' },
    });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    timeout.abort(new DOMException('deadline', 'TimeoutError'));
    await expect(pending).rejects.toThrow('pro-media-cors response timed out');
    expect(cancellation).toHaveBeenCalled();
  });

  it('rejects malformed UTF-8 before parsing a live policy envelope', async () => {
    await expect(
      captureR2PolicyCheckpoint('pro-room', directory(), {
        fetcher: () =>
          Promise.resolve(new Response(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]))),
        env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' },
      }),
    ).rejects.toThrow('did not return valid UTF-8 JSON');
  });

  it('enforces the byte ceiling while streaming when Content-Length is absent', async () => {
    const never = new Promise<void>(() => undefined);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(512 * 1024 + 1));
      },
      cancel: () => never,
    });
    const result = Promise.race([
      captureR2PolicyCheckpoint('pro-room', directory(), {
        fetcher: () => Promise.resolve(new Response(body, { status: 200 })),
        env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_API_TOKEN: 'token' },
      }).then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout('timed-out'), 100)),
    ]);

    await expect(result).resolves.toContain('response ceiling');
  });

  it('performs no Cloudflare reads when the selected scope has no R2 mutation', async () => {
    const fetcher = vi.fn();
    const report = await captureR2PolicyCheckpoint('app', directory(), {
      fetcher,
      env: {},
    });
    expect(report.policies).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
