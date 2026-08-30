import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  selectLatestArtifactAttempt,
  selectLatestSuccessfulRun,
  waitForArtifact,
} from '../../../scripts/release-evidence.mts';

const SHA = 'a'.repeat(40);
const ENVIRONMENT_KEYS = ['GITHUB_REPOSITORY', 'GITHUB_SHA', 'GH_TOKEN', 'GITHUB_OUTPUT'] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;
const temporaryDirectories: string[] = [];

function githubResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

function configureEvidenceEnvironment(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mxqr-release-evidence-'));
  temporaryDirectories.push(directory);
  const output = join(directory, 'github-output.txt');
  process.env.GITHUB_REPOSITORY = 'owner/repository';
  process.env.GITHUB_SHA = SHA.toUpperCase();
  process.env.GH_TOKEN = 'token-1234567890';
  process.env.GITHUB_OUTPUT = output;
  return output;
}

function successfulRun(runAttempt = 2): Record<string, unknown> {
  return {
    id: 10,
    run_attempt: runAttempt,
    updated_at: '2026-08-15T09:45:00Z',
    status: 'completed',
    conclusion: 'success',
    head_sha: SHA,
    head_branch: 'main',
    event: 'push',
    html_url: 'https://github.test/owner/repository/actions/runs/10',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENVIRONMENT_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('production candidate selection', () => {
  it('selects only successful exact-main-SHA push runs and run-scoped artifacts', () => {
    const selected = selectLatestSuccessfulRun(
      {
        workflow_runs: [
          {
            id: 10,
            run_attempt: 1,
            status: 'completed',
            conclusion: 'success',
            head_sha: SHA,
            head_branch: 'main',
            event: 'push',
          },
          {
            id: 11,
            run_attempt: 2,
            status: 'completed',
            conclusion: 'failure',
            head_sha: SHA,
            head_branch: 'main',
            event: 'push',
          },
          {
            id: 12,
            run_attempt: 3,
            status: 'completed',
            conclusion: 'success',
            head_sha: 'b'.repeat(40),
            head_branch: 'main',
            event: 'push',
          },
        ],
      },
      { sha: SHA, event: 'push' },
    );
    expect(selected?.id).toBe(10);

    expect(
      selectLatestArtifactAttempt(
        {
          artifacts: [
            { name: `production-candidate-${SHA}-10-2`, expired: false },
            { name: `production-candidate-${SHA}-10-1`, expired: true },
            {
              name: `production-candidate-${SHA}-10-1`,
              expired: false,
              created_at: '2026-08-15T09:40:00Z',
            },
          ],
        },
        { prefix: 'production-candidate-', sha: SHA, runId: 10, runAttempt: 1 },
      ),
    ).toMatchObject({ name: `production-candidate-${SHA}-10-1`, runAttempt: 1 });
  });

  it('reuses the newest valid candidate from an earlier successful job attempt', () => {
    const expected = {
      prefix: 'production-candidate-',
      sha: SHA,
      runId: 10,
      runAttempt: 2,
    };
    const attemptOne = {
      name: `production-candidate-${SHA}-10-1`,
      expired: false,
      created_at: '2026-08-15T09:40:00Z',
    };

    expect(
      selectLatestArtifactAttempt(
        {
          artifacts: [
            attemptOne,
            { name: `production-candidate-${SHA}-10-2`, expired: true },
            { name: `production-candidate-${SHA}-10-3`, expired: false },
            { name: `production-candidate-${SHA}-10-01`, expired: false },
            { name: `production-candidate-${SHA}-10-1-extra`, expired: false },
            { name: `production-candidate-${'b'.repeat(40)}-10-2`, expired: false },
            { name: `production-candidate-${SHA}-11-2`, expired: false },
          ],
        },
        expected,
      ),
    ).toMatchObject({ name: attemptOne.name, runAttempt: 1 });

    expect(
      selectLatestArtifactAttempt(
        {
          artifacts: [
            attemptOne,
            {
              name: `production-candidate-${SHA}-10-2`,
              expired: false,
              created_at: '2026-08-15T09:30:00Z',
            },
          ],
        },
        expected,
      ),
    ).toMatchObject({ name: `production-candidate-${SHA}-10-2`, runAttempt: 2 });
  });

  it('orders independent runs by global recency and can skip a missing newest artifact', () => {
    const runs = {
      workflow_runs: [
        {
          id: 20,
          run_attempt: 2,
          updated_at: '2026-08-15T09:00:00Z',
          status: 'completed',
          conclusion: 'success',
          head_sha: SHA,
          head_branch: 'main',
          event: 'push',
        },
        {
          id: 21,
          run_attempt: 1,
          updated_at: '2026-08-15T09:45:00Z',
          status: 'completed',
          conclusion: 'success',
          head_sha: SHA,
          head_branch: 'main',
          event: 'push',
        },
      ],
    };

    expect(selectLatestSuccessfulRun(runs, { sha: SHA, event: 'push' })?.id).toBe(21);
    expect(selectLatestSuccessfulRun(runs, { sha: SHA, event: 'push' }, new Set([21]))?.id).toBe(
      20,
    );
  });

  it('writes the actual earlier artifact attempt from a successful partial rerun', async () => {
    const output = configureEvidenceEnvironment();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubResponse({ workflow_runs: [successfulRun(2)] }))
      .mockResolvedValueOnce(
        githubResponse({
          total_count: 1,
          artifacts: [
            {
              name: `production-candidate-${SHA}-10-1`,
              expired: false,
              created_at: '2026-08-15T09:30:00Z',
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await waitForArtifact({
      workflow: 'ci.yml',
      event: 'push',
      prefix: 'production-candidate-',
      outputPrefix: '',
      timeoutMs: 1_000,
    });

    expect(readFileSync(output, 'utf8')).toBe(
      [
        'run_id=10',
        'run_attempt=1',
        `artifact_name=production-candidate-${SHA}-10-1`,
        'validation_profile=main-ci',
        '',
      ].join('\n'),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(
        `/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${SHA}`,
      ),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expect.any(String) }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/actions/runs/10/artifacts?per_page=100'),
      expect.any(Object),
    );
  });

  it('paginates a crowded run so an early candidate remains reusable', async () => {
    const output = configureEvidenceEnvironment();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubResponse({ workflow_runs: [successfulRun(2)] }))
      .mockResolvedValueOnce(
        githubResponse({
          total_count: 101,
          artifacts: Array.from({ length: 100 }, (_, index) => ({
            name: `diagnostic-${index}`,
            expired: false,
          })),
        }),
      )
      .mockResolvedValueOnce(
        githubResponse({
          total_count: 101,
          artifacts: [
            {
              name: `production-candidate-${SHA}-10-1`,
              expired: false,
              created_at: '2026-08-15T09:30:00Z',
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await waitForArtifact({
      workflow: 'ci.yml',
      event: 'push',
      prefix: 'production-candidate-',
      outputPrefix: '',
      timeoutMs: 1_000,
    });

    expect(readFileSync(output, 'utf8')).toContain('run_attempt=1\n');
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('artifacts?per_page=100&direction=asc&page=2'),
      expect.any(Object),
    );
  });

  it('fails closed when completed exact-commit runs have no usable artifact', async () => {
    configureEvidenceEnvironment();
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(githubResponse({ workflow_runs: [successfulRun(2)] }))
        .mockResolvedValueOnce(githubResponse({ total_count: 0, artifacts: [] })),
    );

    await expect(
      waitForArtifact({
        workflow: 'ci.yml',
        event: 'push',
        prefix: 'production-candidate-',
        outputPrefix: '',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('unexpired run-scoped artifact');
  });

  it('rejects malformed local evidence input and GitHub API failures', async () => {
    configureEvidenceEnvironment();
    process.env.GITHUB_REPOSITORY = 'not-a-repository';
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      waitForArtifact({
        workflow: 'ci.yml',
        event: 'push',
        prefix: 'production-candidate-',
        outputPrefix: '',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('GITHUB_REPOSITORY or GITHUB_SHA is malformed');
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.GITHUB_REPOSITORY = 'owner/repository';
    fetchMock.mockResolvedValueOnce(githubResponse({}, 503));
    await expect(
      waitForArtifact({
        workflow: 'ci.yml',
        event: 'push',
        prefix: 'production-candidate-',
        outputPrefix: '',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('GitHub API request failed with HTTP 503');
  });
});
