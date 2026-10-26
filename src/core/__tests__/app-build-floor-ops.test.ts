import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import appWorker from '../../../cloudflare/app-worker.ts';
import {
  APP_BUILD_FLOOR_CLIENT_PATH,
  APP_BUILD_FLOOR_OPS_AUDIENCE,
  APP_BUILD_FLOOR_OPS_PATH,
} from '../../../cloudflare/app-build-floor-contract.ts';
import {
  GITHUB_ACTIONS_OIDC_ISSUER,
  GITHUB_ACTIONS_OIDC_JWKS_URL,
  GITHUB_ACTIONS_OIDC_TOKEN_MAX_BYTES,
  GITHUB_OIDC_JWKS_REFRESH_MIN_INTERVAL_MS,
  resetGitHubActionsOidcCacheForTests,
  verifyGitHubActionsOidcToken,
  type GitHubActionsOidcPolicy,
} from '../../../cloudflare/github-actions-oidc.ts';
import {
  APP_BUILD_FLOOR_LIVE_REPORT_PATH,
  APP_BUILD_FLOOR_STATE_PATH,
  APP_BUILD_FLOOR_STATUS_HEADERS,
  APP_BUILD_FLOOR_STATUS_PATH,
  SERVICE_CONTROL_OBJECT_NAME,
  SERVICE_CONTROL_STATE_PATH,
  clearServiceMaintenanceCacheForTests,
} from '../../../cloudflare/service-maintenance.ts';
import { createAtomicRateControlBinding } from './service-control-rate-limit-fixture.ts';

const ORIGIN = 'https://musixquare.com';
const T0 = Date.parse('2026-10-26T04:00:00.000Z');
const FLOOR_WORKFLOW = 'hiefny/MUSIXQUARE/.github/workflows/app-build-floor.yml@refs/heads/main';
const RELEASE_WORKFLOW = 'hiefny/MUSIXQUARE/.github/workflows/release.yml@refs/heads/main';
const RELEASE_RECOVERY_WORKFLOW =
  'hiefny/MUSIXQUARE/.github/workflows/release-recovery.yml@refs/heads/main';
const CI_WORKFLOW = 'hiefny/MUSIXQUARE/.github/workflows/ci.yml@refs/heads/main';

const TEST_POLICY: GitHubActionsOidcPolicy = {
  audience: 'https://example.test/api/ops',
  repository: 'owner/repo',
  repositoryId: '101',
  repositoryOwnerId: '202',
  ref: 'refs/heads/main',
  environment: 'production',
  eventName: 'workflow_dispatch',
  runnerEnvironment: 'github-hosted',
  jobWorkflowRefs: ['owner/repo/.github/workflows/ops.yml@refs/heads/main'],
};

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JsonWebKey & { kid: string };
}

async function createSigningKey(kid: string, modulusLength = 2048): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kty: 'RSA', n: exported.n, e: exported.e, alg: 'RS256', use: 'sig', kid },
  };
}

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function signToken(
  key: SigningKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const head = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid, ...header }));
  const body = base64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * A genuine token of a job that runs its own steps, as both callers do.
 * `workflow_ref` names its workflow. GitHub documents `job_workflow_ref` and
 * `job_workflow_sha` only for a job that runs a reusable workflow, so the
 * default token carries neither; tests add them where they matter.
 */
function claimsFor(
  policy: GitHubActionsOidcPolicy,
  nowMs: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(nowMs / 1_000);
  const [owner] = policy.repository.split('/');
  return {
    jti: '5f0c4e1e-0000-4000-8000-000000000001',
    sub: `repo:${policy.repository}:environment:${policy.environment}`,
    aud: policy.audience,
    ref: policy.ref,
    sha: 'a'.repeat(40),
    repository: policy.repository,
    repository_owner: owner,
    repository_owner_id: policy.repositoryOwnerId,
    repository_id: policy.repositoryId,
    repository_visibility: 'public',
    run_id: '9000000001',
    run_number: '7',
    run_attempt: '1',
    actor: owner,
    actor_id: policy.repositoryOwnerId,
    workflow: 'App build floor',
    event_name: policy.eventName,
    ref_type: 'branch',
    ref_protected: 'true',
    workflow_ref: policy.jobWorkflowRefs[0],
    workflow_sha: 'a'.repeat(40),
    runner_environment: policy.runnerEnvironment,
    environment: policy.environment,
    iss: GITHUB_ACTIONS_OIDC_ISSUER,
    nbf: now - 5,
    iat: now,
    exp: now + 300,
    ...overrides,
  };
}

/** GitHub's key set behind a counted fetch stub. */
function installJwks(initial: readonly (JsonWebKey & { kid?: string })[]) {
  const state = { keys: [...initial], status: 200 };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== GITHUB_ACTIONS_OIDC_JWKS_URL) throw new Error(`Unexpected fetch ${url}`);
    return new Response(JSON.stringify({ keys: state.keys }), {
      status: state.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { state, fetchMock };
}

function useDateClock(at = T0) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

let primary: SigningKey;
let rotated: SigningKey;
let weak: SigningKey;

beforeAll(async () => {
  primary = await createSigningKey('github-primary');
  rotated = await createSigningKey('github-rotated');
  weak = await createSigningKey('github-weak', 1024);
});

afterEach(() => {
  resetGitHubActionsOidcCacheForTests();
  clearServiceMaintenanceCacheForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GitHub Actions OIDC verifier', () => {
  it('accepts a token signed by a published GitHub key with every pinned claim', async () => {
    const jwks = installJwks([primary.jwk]);
    const token = await signToken(primary, claimsFor(TEST_POLICY, T0));
    await expect(verifyGitHubActionsOidcToken(token, TEST_POLICY, T0)).resolves.toEqual({
      ok: true,
      jobWorkflowRef: TEST_POLICY.jobWorkflowRefs[0],
      runId: '9000000001',
    });
    // The key set is cached.
    await verifyGitHubActionsOidcToken(token, TEST_POLICY, T0 + 1_000);
    expect(jwks.fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects any algorithm other than RS256 and malformed or oversized tokens without a key fetch', async () => {
    const jwks = installJwks([primary.jwk]);
    const claims = claimsFor(TEST_POLICY, T0);
    const valid = await signToken(primary, claims);
    const [, body, signature] = valid.split('.');
    const rejected = [
      await signToken(primary, claims, { alg: 'RS512' }),
      `${base64Url(JSON.stringify({ alg: 'none', kid: primary.kid }))}.${body}.`,
      `${base64Url(JSON.stringify({ alg: 'HS256', kid: primary.kid }))}.${body}.${signature}`,
      `${base64Url(JSON.stringify({ kid: primary.kid }))}.${body}.${signature}`,
      `${base64Url(JSON.stringify({ alg: 'RS256', kid: 'bad kid!' }))}.${body}.${signature}`,
      `${base64Url(JSON.stringify({ alg: 'RS256' }))}.${body}.${signature}`,
      valid.split('.').slice(0, 2).join('.'),
      `${valid}.extra`,
      `${valid.split('.')[0]}.%%%.${signature}`,
      'a'.repeat(GITHUB_ACTIONS_OIDC_TOKEN_MAX_BYTES + 1),
      '',
      undefined,
      42,
    ];
    for (const token of rejected) {
      await expect(
        verifyGitHubActionsOidcToken(token, TEST_POLICY, T0),
        String(token).slice(0, 40),
      ).resolves.toEqual({ ok: false, status: 401, error: 'OIDC_TOKEN_INVALID' });
    }
    expect(jwks.fetchMock).not.toHaveBeenCalled();
  });

  it('uses only RSA signature keys of at least 2048 bits from the key set', async () => {
    const { privateKey } = primary;
    const ecKey = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k-ec', alg: 'RS256' };
    const encKey = { ...primary.jwk, kid: 'k-enc', use: 'enc' };
    const otherAlg = { ...primary.jwk, kid: 'k-rs512', alg: 'RS512' };
    const weakKey = weak.jwk;
    installJwks([ecKey, encKey, otherAlg, weakKey, primary.jwk]);
    for (const kid of ['k-ec', 'k-enc', 'k-rs512']) {
      const token = await signToken(
        { kid, privateKey, jwk: primary.jwk },
        claimsFor(TEST_POLICY, T0),
      );
      await expect(verifyGitHubActionsOidcToken(token, TEST_POLICY, T0), kid).resolves.toEqual({
        ok: false,
        status: 401,
        error: 'OIDC_TOKEN_INVALID',
      });
    }
    const weakToken = await signToken(weak, claimsFor(TEST_POLICY, T0));
    await expect(verifyGitHubActionsOidcToken(weakToken, TEST_POLICY, T0)).resolves.toMatchObject({
      ok: false,
      status: 401,
    });
    // A key without `use` or `alg` is still a signing key.
    const bare = { kty: 'RSA', n: primary.jwk.n, e: primary.jwk.e, kid: 'k-bare' };
    resetGitHubActionsOidcCacheForTests();
    installJwks([bare]);
    const bareToken = await signToken(
      { kid: 'k-bare', privateKey, jwk: primary.jwk },
      claimsFor(TEST_POLICY, T0),
    );
    await expect(verifyGitHubActionsOidcToken(bareToken, TEST_POLICY, T0)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('rejects a signature from another key under a published kid', async () => {
    installJwks([primary.jwk]);
    const forged = await signToken(
      { kid: primary.kid, privateKey: rotated.privateKey, jwk: rotated.jwk },
      claimsFor(TEST_POLICY, T0),
    );
    await expect(verifyGitHubActionsOidcToken(forged, TEST_POLICY, T0)).resolves.toEqual({
      ok: false,
      status: 401,
      error: 'OIDC_TOKEN_INVALID',
    });
  });

  it('refreshes the key set for an unknown kid at most once per interval', async () => {
    const jwks = installJwks([primary.jwk]);
    const valid = await signToken(primary, claimsFor(TEST_POLICY, T0));
    expect(await verifyGitHubActionsOidcToken(valid, TEST_POLICY, T0)).toMatchObject({ ok: true });
    expect(jwks.fetchMock).toHaveBeenCalledTimes(1);

    // GitHub rotates in a new key; tokens signed with it arrive in a burst.
    jwks.state.keys = [primary.jwk, rotated.jwk];
    const early = T0 + 1_000;
    const rotatedToken = await signToken(rotated, claimsFor(TEST_POLICY, early));
    // The first unknown kid since the last fetch more than an interval ago? No:
    // the cache was filled one second earlier, so the refresh waits.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        verifyGitHubActionsOidcToken(rotatedToken, TEST_POLICY, early + attempt),
      ).resolves.toEqual({ ok: false, status: 401, error: 'OIDC_TOKEN_INVALID' });
    }
    expect(jwks.fetchMock).toHaveBeenCalledTimes(1);

    const later = T0 + GITHUB_OIDC_JWKS_REFRESH_MIN_INTERVAL_MS;
    const laterToken = await signToken(rotated, claimsFor(TEST_POLICY, later));
    await expect(
      verifyGitHubActionsOidcToken(laterToken, TEST_POLICY, later),
    ).resolves.toMatchObject({ ok: true });
    expect(jwks.fetchMock).toHaveBeenCalledTimes(2);

    // Forged kids after that refresh wait for the next interval again.
    const forged = await signToken(
      { kid: 'forged', privateKey: rotated.privateKey, jwk: rotated.jwk },
      claimsFor(TEST_POLICY, later),
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await verifyGitHubActionsOidcToken(forged, TEST_POLICY, later + 1_000 + attempt);
    }
    expect(jwks.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers 503 while the key set is unavailable and does not refetch inside the interval', async () => {
    const jwks = installJwks([primary.jwk]);
    jwks.state.status = 503;
    const token = await signToken(primary, claimsFor(TEST_POLICY, T0));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        verifyGitHubActionsOidcToken(token, TEST_POLICY, T0 + attempt * 1_000),
      ).resolves.toEqual({ ok: false, status: 503, error: 'OIDC_JWKS_UNAVAILABLE' });
    }
    expect(jwks.fetchMock).toHaveBeenCalledOnce();

    jwks.state.status = 200;
    const later = T0 + GITHUB_OIDC_JWKS_REFRESH_MIN_INTERVAL_MS;
    const laterToken = await signToken(primary, claimsFor(TEST_POLICY, later));
    await expect(
      verifyGitHubActionsOidcToken(laterToken, TEST_POLICY, later),
    ).resolves.toMatchObject({ ok: true });
    expect(jwks.fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an expired token', { exp: Math.floor(T0 / 1_000) - 61 }],
    ['a token issued in the future', { iat: Math.floor(T0 / 1_000) + 61 }],
    ['a token issued over an hour ago', { iat: Math.floor(T0 / 1_000) - 3_601 }],
    ['a token not yet valid', { nbf: Math.floor(T0 / 1_000) + 61 }],
    ['a string expiry', { exp: String(Math.floor(T0 / 1_000) + 300) }],
    ['another issuer', { iss: 'https://token.actions.githubusercontent.com/other' }],
    ['another audience', { aud: 'https://musixquare.com/api/other' }],
    ['an audience list with an extra value', { aud: [TEST_POLICY.audience, 'sts.amazonaws.com'] }],
    ['an empty audience list', { aud: [] }],
  ])('rejects %s as an invalid token', async (_label, overrides) => {
    installJwks([primary.jwk]);
    const token = await signToken(primary, claimsFor(TEST_POLICY, T0, overrides));
    await expect(verifyGitHubActionsOidcToken(token, TEST_POLICY, T0)).resolves.toEqual({
      ok: false,
      status: 401,
      error: 'OIDC_TOKEN_INVALID',
    });
  });

  it('accepts a one-value audience list and the clock skew allowance', async () => {
    installJwks([primary.jwk]);
    const now = Math.floor(T0 / 1_000);
    for (const overrides of [
      { aud: [TEST_POLICY.audience] },
      { exp: now - 59 },
      { iat: now + 59, nbf: now + 59 },
    ]) {
      const token = await signToken(primary, claimsFor(TEST_POLICY, T0, overrides));
      await expect(
        verifyGitHubActionsOidcToken(token, TEST_POLICY, T0),
        JSON.stringify(overrides),
      ).resolves.toMatchObject({ ok: true });
    }
  });
});

describe('GitHub Actions OIDC verifier workflow claims', () => {
  const OPS = 'owner/repo/.github/workflows/ops.yml@refs/heads/main';
  const OTHER_OPS = 'owner/repo/.github/workflows/release.yml@refs/heads/main';
  const CI = 'owner/repo/.github/workflows/ci.yml@refs/heads/main';
  const REUSABLE = 'owner/repo/.github/workflows/reusable.yml@refs/heads/main';
  const TWO_WORKFLOWS: GitHubActionsOidcPolicy = {
    ...TEST_POLICY,
    jobWorkflowRefs: [OPS, OTHER_OPS],
  };

  it.each([
    ['omits job_workflow_ref (the documented form)', TEST_POLICY, {}, OPS],
    [
      'repeats workflow_ref in job_workflow_ref',
      TEST_POLICY,
      { job_workflow_ref: OPS, job_workflow_sha: 'a'.repeat(40) },
      OPS,
    ],
    ['leaves job_workflow_ref empty', TEST_POLICY, { job_workflow_ref: '' }, OPS],
    [
      'names the second allowed workflow and omits job_workflow_ref',
      TWO_WORKFLOWS,
      { workflow_ref: OTHER_OPS },
      OTHER_OPS,
    ],
    [
      'names the second allowed workflow in both claims',
      TWO_WORKFLOWS,
      { workflow_ref: OTHER_OPS, job_workflow_ref: OTHER_OPS },
      OTHER_OPS,
    ],
  ])(
    'accepts a job that runs its own steps and %s',
    async (_label, policy, overrides, workflow) => {
      installJwks([primary.jwk]);
      const token = await signToken(primary, claimsFor(policy, T0, overrides));
      await expect(verifyGitHubActionsOidcToken(token, policy, T0)).resolves.toEqual({
        ok: true,
        jobWorkflowRef: workflow,
        runId: '9000000001',
      });
    },
  );

  it.each([
    ['a workflow_ref off the allowlist', TEST_POLICY, { workflow_ref: CI }],
    [
      'a workflow off the allowlist that names itself in job_workflow_ref',
      TEST_POLICY,
      { workflow_ref: CI, job_workflow_ref: CI },
    ],
    [
      'a workflow off the allowlist that calls an allowed workflow as a reusable workflow',
      TEST_POLICY,
      { workflow_ref: CI, job_workflow_ref: OPS },
    ],
    ['no workflow_ref', TEST_POLICY, { workflow_ref: undefined }],
    [
      'no workflow_ref beside an allowed job_workflow_ref',
      TEST_POLICY,
      { workflow_ref: undefined, job_workflow_ref: OPS },
    ],
    ['a workflow_ref that is not a string', TEST_POLICY, { workflow_ref: [OPS] }],
    [
      'the allowed workflow at another ref',
      TEST_POLICY,
      {
        workflow_ref: 'owner/repo/.github/workflows/ops.yml@refs/heads/feature',
        job_workflow_ref: 'owner/repo/.github/workflows/ops.yml@refs/heads/feature',
      },
    ],
    [
      'an allowed workflow that runs a reusable workflow off the allowlist',
      TEST_POLICY,
      { job_workflow_ref: REUSABLE },
    ],
    [
      'an allowed workflow that runs another allowed workflow as a reusable workflow',
      TWO_WORKFLOWS,
      { workflow_ref: OPS, job_workflow_ref: OTHER_OPS },
    ],
    ['a job_workflow_ref that is null', TEST_POLICY, { job_workflow_ref: null }],
    ['a job_workflow_ref list', TEST_POLICY, { job_workflow_ref: [OPS] }],
  ])('refuses %s with 403', async (_label, policy, overrides) => {
    installJwks([primary.jwk]);
    const token = await signToken(primary, claimsFor(policy, T0, overrides));
    await expect(verifyGitHubActionsOidcToken(token, policy, T0)).resolves.toEqual({
      ok: false,
      status: 403,
      error: 'OIDC_TOKEN_FORBIDDEN',
    });
  });
});

function createControl() {
  const control = createAtomicRateControlBinding();
  const calls: string[] = [];
  return {
    calls,
    binding: {
      idFromName: (name: string) => control.binding.idFromName(name),
      get: (id: string) => {
        const stub = control.binding.get(id);
        return {
          fetch: async (request: Request) => {
            calls.push(`${request.method} ${new URL(request.url).pathname}`);
            return stub.fetch(request);
          },
        };
      },
    },
    object: () => control.binding.get(control.binding.idFromName(SERVICE_CONTROL_OBJECT_NAME)),
    writes: () => calls.filter((call) => call === `POST ${APP_BUILD_FLOOR_STATE_PATH}`).length,
  };
}

type Control = ReturnType<typeof createControl>;

async function objectFloor(control: Control) {
  const response = await control.object().fetch(
    new Request(`https://service-control.internal${APP_BUILD_FLOOR_STATUS_PATH}`, {
      method: 'HEAD',
    }),
  );
  const header = (name: keyof typeof APP_BUILD_FLOOR_STATUS_HEADERS) =>
    response.headers.get(APP_BUILD_FLOOR_STATUS_HEADERS[name]);
  return {
    minAppBuild: Number(header('minAppBuild')),
    effectiveMinAppBuild: Number(header('effectiveMinAppBuild')),
    revision: Number(header('revision')),
    liveAppBuild: header('liveAppBuild'),
  };
}

function serviceWorkerAssets(build: number | null) {
  return {
    fetch: vi.fn(async (request: Request) =>
      build !== null && new URL(request.url).pathname === '/service-worker.js'
        ? new Response(`const CACHE_VERSION = 'v${build}';`)
        : new Response('Not found', { status: 404 }),
    ),
  };
}

function opsEnv(control: Control, liveBuild: number | null = 785) {
  return {
    MUSIXQUARE_SERVICE_CONTROL: control.binding,
    ASSETS: serviceWorkerAssets(liveBuild),
  };
}

const PRODUCTION_POLICY: GitHubActionsOidcPolicy = {
  audience: APP_BUILD_FLOOR_OPS_AUDIENCE,
  repository: 'hiefny/MUSIXQUARE',
  repositoryId: '1141408724',
  repositoryOwnerId: '257024056',
  ref: 'refs/heads/main',
  environment: 'production',
  eventName: 'workflow_dispatch',
  runnerEnvironment: 'github-hosted',
  jobWorkflowRefs: [FLOOR_WORKFLOW, RELEASE_WORKFLOW],
};

async function opsToken(overrides: Record<string, unknown> = {}, key = primary) {
  return signToken(key, claimsFor(PRODUCTION_POLICY, Date.now(), overrides));
}

async function ops(
  env: Record<string, unknown>,
  body: unknown,
  options: { token?: string | null; ip?: string; method?: string; contentType?: string } = {},
) {
  const token = options.token === undefined ? await opsToken() : options.token;
  const headers: Record<string, string> = {
    'Content-Type': options.contentType ?? 'application/json',
    'CF-Connecting-IP': options.ip ?? '192.0.2.50',
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const method = options.method ?? 'POST';
  return appWorker.fetch(
    new Request(`${ORIGIN}${APP_BUILD_FLOOR_OPS_PATH}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    env,
  );
}

function setBody(action: 'set' | 'lower', minAppBuild: number, expectedRevision: number) {
  return {
    action,
    minAppBuild,
    expectedRevision,
    requestId: `gh-9000000001-1-${action}-${minAppBuild}`,
    reason: `Production Release raise to ${minAppBuild}`,
  };
}

describe('App Worker ops App build floor endpoint', () => {
  it('applies the abuse limit before it parses a token or fetches keys', async () => {
    useDateClock();
    const jwks = installJwks([primary.jwk]);
    const control = createControl();
    const env = opsEnv(control);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const forged = await signToken(
        { kid: `forged-${attempt}`, privateKey: rotated.privateKey, jwk: rotated.jwk },
        claimsFor(PRODUCTION_POLICY, Date.now()),
      );
      statuses.push((await ops(env, { action: 'check' }, { token: forged })).status);
    }
    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 401));
    expect(statuses.slice(20)).toEqual([429, 429, 429, 429]);
    // One key-set fetch filled the empty cache; forged kids never refetch.
    expect(jwks.fetchMock).toHaveBeenCalledOnce();

    // After the refresh interval a limited caller still costs no key fetch.
    vi.setSystemTime(T0 + GITHUB_OIDC_JWKS_REFRESH_MIN_INTERVAL_MS + 1_000);
    const late = await ops(env, { action: 'check' }, { token: 'x.y.z' });
    expect(late.status).toBe(429);
    expect(late.headers.get('Retry-After')).toMatch(/^\d+$/u);
    expect(jwks.fetchMock).toHaveBeenCalledOnce();

    // Another address is not limited and authenticates with the cached key.
    const other = await ops(env, { action: 'check' }, { ip: '198.51.100.7' });
    expect(other.status).toBe(200);
    expect(control.writes()).toBe(0);
  });

  it.each([
    ['no Authorization header', null],
    ['an empty bearer token', ''],
    ['a token over 8 KiB', 'a'.repeat(GITHUB_ACTIONS_OIDC_TOKEN_MAX_BYTES + 1)],
  ])('refuses %s with 401 and no key fetch', async (_label, token) => {
    const jwks = installJwks([primary.jwk]);
    const control = createControl();
    const response = await ops(opsEnv(control), { action: 'check' }, { token });
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({ error: 'OIDC_TOKEN_INVALID' });
    expect(jwks.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-bearer Authorization scheme', async () => {
    const jwks = installJwks([primary.jwk]);
    const control = createControl();
    const token = await opsToken();
    const response = await appWorker.fetch(
      new Request(`${ORIGIN}${APP_BUILD_FLOOR_OPS_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Basic ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'check' }),
      }),
      opsEnv(control),
    );
    expect(response.status).toBe(401);
    expect(jwks.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['another repository', { repository: 'someone/MUSIXQUARE' }],
    ['another repository id', { repository_id: '1' }],
    ['a numeric repository id', { repository_id: 1141408724 }],
    ['another repository owner id', { repository_owner_id: '1' }],
    ['another ref', { ref: 'refs/heads/feature' }],
    ['a pull request event', { event_name: 'pull_request' }],
    ['a push event', { event_name: 'push' }],
    ['another environment', { environment: 'staging' }],
    ['no environment', { environment: undefined }],
    ['a self-hosted runner', { runner_environment: 'self-hosted' }],
    ['another workflow', { workflow_ref: CI_WORKFLOW }],
    [
      'another workflow that names itself in job_workflow_ref',
      { workflow_ref: CI_WORKFLOW, job_workflow_ref: CI_WORKFLOW },
    ],
    [
      'another workflow that calls the floor workflow as a reusable workflow',
      { workflow_ref: CI_WORKFLOW, job_workflow_ref: FLOOR_WORKFLOW },
    ],
    [
      'no workflow_ref beside the floor workflow',
      { workflow_ref: undefined, job_workflow_ref: FLOOR_WORKFLOW },
    ],
    ['the floor workflow calling another workflow', { job_workflow_ref: CI_WORKFLOW }],
    [
      'the floor workflow from another ref',
      {
        workflow_ref: 'hiefny/MUSIXQUARE/.github/workflows/app-build-floor.yml@refs/heads/x',
        job_workflow_ref: 'hiefny/MUSIXQUARE/.github/workflows/app-build-floor.yml@refs/heads/x',
      },
    ],
    [
      'the floor workflow calling itself from another ref',
      { job_workflow_ref: 'hiefny/MUSIXQUARE/.github/workflows/app-build-floor.yml@refs/heads/x' },
    ],
    [
      'a reusable workflow in a fork',
      { job_workflow_ref: 'fork/MUSIXQUARE/.github/workflows/app-build-floor.yml@refs/heads/main' },
    ],
    // The Production Release runs its recovery job through this reusable
    // workflow; its steps never take part in the floor.
    [
      "the Production Release's reusable recovery workflow",
      { workflow_ref: RELEASE_WORKFLOW, job_workflow_ref: RELEASE_RECOVERY_WORKFLOW },
    ],
    [
      'the Production Release calling the floor workflow as a reusable workflow',
      { workflow_ref: RELEASE_WORKFLOW, job_workflow_ref: FLOOR_WORKFLOW },
    ],
  ])('refuses %s with 403', async (_label, overrides) => {
    installJwks([primary.jwk]);
    const control = createControl();
    const response = await ops(opsEnv(control), setBody('lower', 0, 0), {
      token: await opsToken(overrides),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'OIDC_TOKEN_FORBIDDEN' });
    expect(control.writes()).toBe(0);
  });

  it('accepts the release deploy job and the floor job, which run their own steps', async () => {
    installJwks([primary.jwk]);
    const control = createControl();
    for (const workflow of [RELEASE_WORKFLOW, FLOOR_WORKFLOW]) {
      // The documented form names the workflow in workflow_ref only; a token
      // that also repeats it in job_workflow_ref is the same job.
      for (const overrides of [
        { workflow_ref: workflow },
        { workflow_ref: workflow, job_workflow_ref: workflow },
      ]) {
        const response = await ops(
          opsEnv(control),
          { action: 'check' },
          { token: await opsToken(overrides) },
        );
        expect(response.status, JSON.stringify(overrides)).toBe(200);
        expect(await response.json()).toMatchObject({ workflow });
      }
    }
  });

  it('checks authentication and reports the floor without changing it', async () => {
    useDateClock();
    installJwks([primary.jwk]);
    const control = createControl();
    const response = await ops(opsEnv(control), { action: 'check' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({
      ok: true,
      action: 'check',
      workflow: FLOOR_WORKFLOW,
      appBuildFloor: {
        minAppBuild: 0,
        effectiveMinAppBuild: 0,
        revision: 0,
        updatedAt: null,
        liveAppBuild: 785,
        reportedLiveAppBuild: null,
        reportedAt: null,
        state: 'valid',
        generatedAt: T0,
      },
    });
    expect(control.writes()).toBe(0);
    expect(control.calls).not.toContain(`POST ${APP_BUILD_FLOOR_LIVE_REPORT_PATH}`);
  });

  it('sets the floor up to the live build and refuses one above it', async () => {
    installJwks([primary.jwk]);
    const control = createControl();
    const env = opsEnv(control, 785);

    const above = await ops(env, setBody('set', 786, 0));
    expect(above.status).toBe(409);
    expect(await above.json()).toMatchObject({
      error: 'APP_BUILD_FLOOR_ABOVE_LIVE',
      appBuildFloor: { minAppBuild: 0, revision: 0 },
    });

    const set = await ops(env, setBody('set', 785, 0));
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      ok: true,
      action: 'set',
      changed: true,
      replayed: false,
      appBuildFloor: {
        minAppBuild: 785,
        effectiveMinAppBuild: 785,
        revision: 1,
        liveAppBuild: 785,
        reportedLiveAppBuild: 785,
      },
    });
    expect(await objectFloor(control)).toMatchObject({
      minAppBuild: 785,
      effectiveMinAppBuild: 785,
      revision: 1,
      liveAppBuild: '785',
    });

    const replay = await ops(env, setBody('set', 785, 0));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ changed: false, replayed: true });

    const sameAgain = await ops(env, { ...setBody('set', 785, 1), requestId: 'gh-9000000002-1' });
    expect(sameAgain.status).toBe(200);
    expect(await sameAgain.json()).toMatchObject({ changed: false, replayed: false });

    const conflict = await ops(env, { ...setBody('set', 784, 0), requestId: 'gh-9000000003-1' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'APP_BUILD_FLOOR_REVISION_CONFLICT' });
  });

  it('answers 503 for a set while the live build is unreadable, and still lowers', async () => {
    installJwks([primary.jwk]);
    const control = createControl();
    const live = opsEnv(control, 785);
    expect((await ops(live, setBody('set', 785, 0))).status).toBe(200);

    const unreadable = opsEnv(control, null);
    const set = await ops(unreadable, setBody('set', 785, 1));
    expect(set.status).toBe(503);
    expect(await set.json()).toEqual({ error: 'APP_BUILD_FLOOR_LIVE_BUILD_UNAVAILABLE' });
    expect(control.writes()).toBe(1);

    const lower = await ops(unreadable, setBody('lower', 0, 1));
    expect(lower.status).toBe(200);
    expect(await lower.json()).toMatchObject({
      action: 'lower',
      changed: true,
      appBuildFloor: { minAppBuild: 0, effectiveMinAppBuild: 0, revision: 2, liveAppBuild: null },
    });
  });

  it('refuses a raise through lower', async () => {
    installJwks([primary.jwk]);
    const control = createControl();
    const response = await ops(opsEnv(control), setBody('lower', 785, 0));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'APP_BUILD_FLOOR_LOWER_ONLY',
      appBuildFloor: { minAppBuild: 0, revision: 0 },
    });
    expect(await objectFloor(control)).toMatchObject({ minAppBuild: 0, revision: 0 });
  });

  it('validates the body for each action', async () => {
    installJwks([primary.jwk]);
    const control = createControl();
    const env = opsEnv(control);
    for (const body of [
      { action: 'raise', minAppBuild: 785, expectedRevision: 0, requestId: 'gh-1-1', reason: 'r' },
      { action: 'check', minAppBuild: 785 },
      { action: 'check', expectedRevision: 0 },
      { action: 'check', extra: true },
      { action: 'set', minAppBuild: 785, requestId: 'gh-9000000001', reason: 'r' },
      { action: 'set', minAppBuild: 785, expectedRevision: 0, reason: 'r' },
      { action: 'set', minAppBuild: 785, expectedRevision: 0, requestId: 'gh-9000000001' },
      { ...setBody('set', 785, 0), minAppBuild: '785' },
      { ...setBody('set', 785, 0), minAppBuild: -1 },
      { ...setBody('set', 785, 0), expectedRevision: -1 },
      { ...setBody('set', 785, 0), expectedRevision: 0.5 },
      { ...setBody('set', 785, 0), requestId: 'short' },
      { ...setBody('set', 785, 0), requestId: 'has space in it' },
      { ...setBody('set', 785, 0), reason: '' },
      { ...setBody('set', 785, 0), reason: 'line\nbreak' },
      { ...setBody('lower', 0, 0), liveAppBuild: 900 },
      [],
      'not json',
    ]) {
      const response = await ops(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const nonJson = await ops(env, { action: 'check' }, { contentType: 'text/plain' });
    expect(nonJson.status).toBe(415);
    expect(await objectFloor(control)).toMatchObject({ minAppBuild: 0, revision: 0 });
  });

  it('refuses other methods', async () => {
    const jwks = installJwks([primary.jwk]);
    const control = createControl();
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const response = await ops(opsEnv(control), { action: 'check' }, { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toBe('POST');
    }
    expect(jwks.fetchMock).not.toHaveBeenCalled();
  });

  it('stays available during maintenance', async () => {
    installJwks([primary.jwk]);
    const control = createControl();
    const enable = await control.object().fetch(
      new Request(`https://service-control.internal${SERVICE_CONTROL_STATE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          expectedRevision: 0,
          requestId: 'ops-test-maintenance',
        }),
      }),
    );
    expect(enable.status).toBe(200);
    const env = opsEnv(control);
    // Prime the maintenance state the public gate reads.
    const waits: Promise<unknown>[] = [];
    const context = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise) };
    await appWorker.fetch(new Request(`${ORIGIN}/favicon.ico`), env, context);
    await vi.waitFor(async () => {
      await Promise.all(waits);
      const gated = await appWorker.fetch(
        new Request(`${ORIGIN}${APP_BUILD_FLOOR_CLIENT_PATH}`),
        env,
      );
      expect(gated.status).toBe(503);
    });

    const response = await ops(env, setBody('set', 785, 0));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ appBuildFloor: { minAppBuild: 785 } });
  });
});
