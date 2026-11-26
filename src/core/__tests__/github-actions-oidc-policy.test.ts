import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  GITHUB_ACTIONS_OIDC_ISSUER,
  GITHUB_ACTIONS_OIDC_JWKS_URL,
  MUSIXQUARE_GITHUB_REPOSITORY,
  resetGitHubActionsOidcCacheForTests,
  verifyGitHubActionsOidcToken,
  type GitHubActionsOidcPolicy,
} from '../../../cloudflare/github-actions-oidc.ts';

const T0 = Date.parse('2026-11-26T05:07:00.000Z');
const OPS = 'owner/repo/.github/workflows/ops.yml@refs/heads/main';

/** A policy of the App build floor's shape: one environment and one event. */
const SINGLE_POLICY: GitHubActionsOidcPolicy = {
  audience: 'https://example.test/api/ops',
  repository: 'owner/repo',
  repositoryId: '101',
  repositoryOwnerId: '202',
  ref: 'refs/heads/main',
  environment: 'production',
  eventName: 'workflow_dispatch',
  runnerEnvironment: 'github-hosted',
  workflowRefs: [OPS],
};

/** A policy of the status monitor's shape: no environment and two events. */
const LIST_POLICY: GitHubActionsOidcPolicy = {
  ...SINGLE_POLICY,
  environment: null,
  eventName: ['schedule', 'workflow_dispatch'],
};

const ACCEPTED = { ok: true, workflowRef: OPS, runId: '9000000001' };
const FORBIDDEN = { ok: false, status: 403, error: 'OIDC_TOKEN_FORBIDDEN' };

// Signing-key and claims helpers, copied from app-build-floor-ops.test.ts.

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly jwk: JsonWebKey & { kid: string };
}

async function createSigningKey(kid: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
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

async function signToken(key: SigningKey, claims: Record<string, unknown>): Promise<string> {
  const head = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid }));
  const body = base64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * A genuine token of a job that runs its own steps. A job that names no
 * environment gets no environment claim and a ref-based subject; a policy
 * with an event list gets its first event. An override of undefined drops the
 * claim, because JSON leaves undefined values out.
 */
function claimsFor(
  policy: GitHubActionsOidcPolicy,
  nowMs: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = Math.floor(nowMs / 1_000);
  const [owner] = policy.repository.split('/');
  return {
    jti: '5f0c4e1e-0000-4000-8000-000000000002',
    sub:
      policy.environment === null
        ? `repo:${policy.repository}:ref:${policy.ref}`
        : `repo:${policy.repository}:environment:${policy.environment}`,
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
    workflow: 'Ops',
    event_name: typeof policy.eventName === 'string' ? policy.eventName : policy.eventName[0],
    ref_type: 'branch',
    ref_protected: 'true',
    workflow_ref: policy.workflowRefs[0],
    workflow_sha: 'a'.repeat(40),
    runner_environment: policy.runnerEnvironment,
    ...(policy.environment === null ? {} : { environment: policy.environment }),
    iss: GITHUB_ACTIONS_OIDC_ISSUER,
    nbf: now - 5,
    iat: now,
    exp: now + 300,
    ...overrides,
  };
}

/** GitHub's key set behind a counted fetch stub. */
function installJwks(keys: readonly (JsonWebKey & { kid?: string })[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== GITHUB_ACTIONS_OIDC_JWKS_URL) throw new Error(`Unexpected fetch ${url}`);
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function verify(policy: GitHubActionsOidcPolicy, overrides: Record<string, unknown> = {}) {
  const token = await signToken(primary, claimsFor(policy, T0, overrides));
  return verifyGitHubActionsOidcToken(token, policy, T0);
}

let primary: SigningKey;

beforeAll(async () => {
  primary = await createSigningKey('github-primary');
});

afterEach(() => {
  resetGitHubActionsOidcCacheForTests();
  vi.unstubAllGlobals();
});

describe('GitHub Actions OIDC policy: environment', () => {
  it('accepts a token without an environment claim when the policy names no environment', async () => {
    const fetchMock = installJwks([primary.jwk]);
    const claims = claimsFor(LIST_POLICY, T0);
    expect(claims).not.toHaveProperty('environment');
    await expect(verify(LIST_POLICY)).resolves.toEqual(ACCEPTED);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ['production', 'production'],
    ['another environment', 'status-monitor'],
    ['an empty string', ''],
    ['null', null],
    ['a list', ['production']],
    ['a number', 0],
    ['false', false],
  ])(
    'refuses an environment claim of %s when the policy names no environment',
    async (_label, environment) => {
      installJwks([primary.jwk]);
      await expect(verify(LIST_POLICY, { environment })).resolves.toEqual(FORBIDDEN);
    },
  );

  it('still requires the exact environment when the policy names one', async () => {
    installJwks([primary.jwk]);
    await expect(verify(SINGLE_POLICY)).resolves.toEqual(ACCEPTED);
    for (const environment of [undefined, null, '', 'staging', 'Production', ['production']]) {
      await expect(
        verify(SINGLE_POLICY, { environment }),
        JSON.stringify(environment) ?? 'absent',
      ).resolves.toEqual(FORBIDDEN);
    }
  });
});

describe('GitHub Actions OIDC policy: event name', () => {
  it.each(['schedule', 'workflow_dispatch'])(
    'accepts a %s run from an event list',
    async (event) => {
      installJwks([primary.jwk]);
      await expect(verify(LIST_POLICY, { event_name: event })).resolves.toEqual(ACCEPTED);
    },
  );

  it.each([
    ['push', 'push'],
    ['pull_request', 'pull_request'],
    ['pull_request_target', 'pull_request_target'],
    ['repository_dispatch', 'repository_dispatch'],
    ['another case', 'Schedule'],
    ['a trailing space', 'schedule '],
    ['an empty string', ''],
    ['a list of an allowed event', ['schedule']],
    ['null', null],
    ['no event', undefined],
  ])('refuses %s against an event list', async (_label, event) => {
    installJwks([primary.jwk]);
    await expect(verify(LIST_POLICY, { event_name: event })).resolves.toEqual(FORBIDDEN);
  });

  it('refuses every event when the list is empty', async () => {
    installJwks([primary.jwk]);
    const policy: GitHubActionsOidcPolicy = { ...LIST_POLICY, eventName: [] };
    for (const event of ['schedule', 'workflow_dispatch']) {
      await expect(verify(policy, { event_name: event }), event).resolves.toEqual(FORBIDDEN);
    }
  });

  it('keeps a single event name exact, as before', async () => {
    installJwks([primary.jwk]);
    await expect(verify(SINGLE_POLICY)).resolves.toEqual(ACCEPTED);
    for (const event of [
      'schedule',
      'push',
      'Workflow_dispatch',
      ['workflow_dispatch'],
      undefined,
    ]) {
      await expect(
        verify(SINGLE_POLICY, { event_name: event }),
        JSON.stringify(event) ?? 'absent',
      ).resolves.toEqual(FORBIDDEN);
    }
  });
});

describe('GitHub Actions OIDC policy without an environment', () => {
  it.each([
    ['another repository', { repository: 'someone/repo' }],
    ['another repository id', { repository_id: '1' }],
    ['another repository owner id', { repository_owner_id: '1' }],
    ['another ref', { ref: 'refs/heads/feature' }],
    ['a self-hosted runner', { runner_environment: 'self-hosted' }],
    [
      'a workflow off the allowlist',
      { workflow_ref: 'owner/repo/.github/workflows/ci.yml@refs/heads/main' },
    ],
    [
      'a job that runs a reusable workflow',
      { job_workflow_ref: 'owner/repo/.github/workflows/reusable.yml@refs/heads/main' },
    ],
  ])('still refuses %s with 403', async (_label, overrides) => {
    installJwks([primary.jwk]);
    await expect(verify(LIST_POLICY, overrides)).resolves.toEqual(FORBIDDEN);
  });

  it('still refuses another audience as an invalid token', async () => {
    installJwks([primary.jwk]);
    await expect(verify(LIST_POLICY, { aud: 'https://example.test/api/other' })).resolves.toEqual({
      ok: false,
      status: 401,
      error: 'OIDC_TOKEN_INVALID',
    });
  });
});

describe('MUSIXQUARE GitHub repository identity', () => {
  it('pins the repository name and its numeric ids', () => {
    expect(MUSIXQUARE_GITHUB_REPOSITORY).toEqual({
      repository: 'hiefny/MUSIXQUARE',
      repositoryId: '1141408724',
      repositoryOwnerId: '257024056',
    });
    expect(Object.isFrozen(MUSIXQUARE_GITHUB_REPOSITORY)).toBe(true);
  });
});
