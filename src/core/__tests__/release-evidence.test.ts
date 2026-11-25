import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** A successful exact-main-SHA push run with no timestamps unless `fields` adds them. */
function exactMainRun(id: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    head_sha: SHA,
    head_branch: 'main',
    event: 'push',
    ...fields,
  };
}

const CANDIDATE = { name: `production-candidate-${SHA}-10-1`, expired: false };

function waitForCandidate(timeoutMs = 1_000): Promise<void> {
  return waitForArtifact({
    workflow: 'ci.yml',
    event: 'push',
    prefix: 'production-candidate-',
    outputPrefix: '',
    timeoutMs,
  });
}

afterEach(() => {
  vi.useRealTimers();
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

  it('dates a run by run_started_at, then created_at, without updated_at, and ranks an undated run last', () => {
    const expected = { sha: SHA, event: 'push' };
    const undated = exactMainRun(33);
    const created = exactMainRun(31, { created_at: '2026-08-15T09:40:00Z' });
    // run_started_at outranks its own older created_at.
    const started = exactMainRun(32, {
      run_started_at: '2026-08-15T09:50:00Z',
      created_at: '2026-08-15T09:00:00Z',
    });
    for (const workflowRuns of [
      [undated, created, started],
      [started, created, undated],
    ]) {
      const runs = { workflow_runs: workflowRuns };
      expect(selectLatestSuccessfulRun(runs, expected)?.id).toBe(32);
      expect(selectLatestSuccessfulRun(runs, expected, new Set([32]))?.id).toBe(31);
      // The undated run comes last although its id is the highest.
      expect(selectLatestSuccessfulRun(runs, expected, new Set([31, 32]))?.id).toBe(33);
    }
  });

  it('breaks a recency tie by the higher run id, then by the later attempt of one run', () => {
    const expected = { sha: SHA, event: 'push' };
    const updatedAt = '2026-08-15T09:45:00Z';
    expect(
      selectLatestSuccessfulRun(
        {
          workflow_runs: [
            exactMainRun(40, { run_attempt: 3, updated_at: updatedAt }),
            exactMainRun(41, { run_attempt: 1, updated_at: updatedAt }),
          ],
        },
        expected,
      ),
    ).toMatchObject({ id: 41, run_attempt: 1 });
    expect(
      selectLatestSuccessfulRun(
        {
          workflow_runs: [
            exactMainRun(42, { run_attempt: 1, updated_at: updatedAt }),
            exactMainRun(42, { run_attempt: 2, updated_at: updatedAt }),
          ],
        },
        expected,
      ),
    ).toMatchObject({ id: 42, run_attempt: 2 });
  });

  it('resolves two uploads for one attempt to the newer, ranking an undated upload oldest', () => {
    const expected = { prefix: 'production-candidate-', sha: SHA, runId: 10, runAttempt: 1 };
    expect(
      selectLatestArtifactAttempt(
        {
          artifacts: [
            { ...CANDIDATE, id: 2, created_at: '2026-08-15T09:35:00Z' },
            { ...CANDIDATE, id: 1, created_at: '2026-08-15T09:30:00Z' },
          ],
        },
        expected,
      ),
    ).toMatchObject({ id: 2, runAttempt: 1 });

    const dated = { ...CANDIDATE, id: 3, created_at: '2026-08-15T09:30:00Z' };
    const undated = { ...CANDIDATE, id: 4 };
    for (const artifacts of [
      [dated, undated],
      [undated, dated],
    ]) {
      expect(selectLatestArtifactAttempt({ artifacts }, expected)).toMatchObject({
        id: 3,
        runAttempt: 1,
      });
    }
  });

  it('rejects workflow-run and artifact payloads that are not GitHub list responses', () => {
    for (const payload of [null, {}, { workflow_runs: {} }]) {
      expect(() => selectLatestSuccessfulRun(payload, { sha: SHA, event: 'push' })).toThrow(
        'GitHub returned an invalid workflow-runs response.',
      );
    }
    for (const payload of [[], { artifacts: null }]) {
      expect(() =>
        selectLatestArtifactAttempt(payload, {
          prefix: 'production-candidate-',
          sha: SHA,
          runId: 10,
          runAttempt: 1,
        }),
      ).toThrow('GitHub returned an invalid artifacts response.');
    }
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

  it.each([
    ['a missing token', 'GH_TOKEN', undefined, 'GH_TOKEN must contain 10-2048 characters.'],
    ['a blank token', 'GH_TOKEN', '   ', 'GH_TOKEN must contain 10-2048 characters.'],
    [
      'a short commit SHA',
      'GITHUB_SHA',
      'a'.repeat(39),
      'GITHUB_SHA must contain 40-40 characters.',
    ],
  ])('rejects %s before calling GitHub', async (_case, key, value, message) => {
    configureEvidenceEnvironment();
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitForCandidate()).rejects.toThrow(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const crowdedFirstPage = {
    total_count: 101,
    artifacts: Array.from({ length: 100 }, (_, index) => ({
      name: `diagnostic-${index}`,
      expired: false,
    })),
  };

  it.each([
    [
      'a page that lists more artifacts than its total',
      [{ total_count: 1, artifacts: [CANDIDATE, CANDIDATE] }],
      'GitHub returned an invalid artifacts response.',
    ],
    [
      'a total that changes between pages',
      [crowdedFirstPage, { total_count: 102, artifacts: [CANDIDATE] }],
      'GitHub artifact pagination changed during release evidence collection.',
    ],
    [
      'pages that end short of their total',
      [crowdedFirstPage, { total_count: 101, artifacts: [] }],
      'GitHub returned an incomplete artifacts response.',
    ],
  ])('fails closed on %s and writes no output', async (_case, pages, message) => {
    const output = configureEvidenceEnvironment();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubResponse({ workflow_runs: [successfulRun(1)] }));
    for (const page of pages) fetchMock.mockResolvedValueOnce(githubResponse(page));
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitForCandidate()).rejects.toThrow(message);
    expect(fetchMock).toHaveBeenCalledTimes(1 + pages.length);
    expect(existsSync(output)).toBe(false);
  });

  it('writes the outputs under a given prefix, leaving the validation profile to the unprefixed candidate', async () => {
    const output = configureEvidenceEnvironment();
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(githubResponse({ workflow_runs: [successfulRun(1)] }))
        .mockResolvedValueOnce(githubResponse({ total_count: 1, artifacts: [CANDIDATE] })),
    );

    await waitForArtifact({
      workflow: 'ci.yml',
      event: 'push',
      prefix: 'production-candidate-',
      outputPrefix: 'candidate_',
      timeoutMs: 1_000,
    });

    expect(readFileSync(output, 'utf8')).toBe(
      [
        'candidate_run_id=10',
        'candidate_run_attempt=1',
        `candidate_artifact_name=production-candidate-${SHA}-10-1`,
        '',
      ].join('\n'),
    );
  });

  it('refuses an output value that would break a GITHUB_OUTPUT line, and writes none of the outputs', async () => {
    const output = configureEvidenceEnvironment();
    // A prefix with a line break would smuggle a second line into GITHUB_OUTPUT.
    const prefix = 'production-candidate\n';
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(githubResponse({ workflow_runs: [successfulRun(1)] }))
        .mockResolvedValueOnce(
          githubResponse({
            total_count: 1,
            artifacts: [{ name: `${prefix}${SHA}-10-1`, expired: false }],
          }),
        ),
    );

    await expect(
      waitForArtifact({
        workflow: 'ci.yml',
        event: 'push',
        prefix,
        outputPrefix: '',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('Refusing unsafe GitHub output artifact_name.');
    expect(existsSync(output)).toBe(false);
  });

  it('fails closed when every completed exact-commit run failed', async () => {
    const output = configureEvidenceEnvironment();
    const failedRun = { ...successfulRun(1), conclusion: 'failure' };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubResponse({ workflow_runs: [failedRun] }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(waitForCandidate()).rejects.toThrow('The exact main commit did not pass ci.yml.');
    // No artifact is listed for a run that did not succeed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(output)).toBe(false);
  });

  it('polls every 10 s while the exact-commit run is in progress, then takes its candidate', async () => {
    vi.useFakeTimers();
    const output = configureEvidenceEnvironment();
    const inProgress = { ...successfulRun(1), status: 'in_progress', conclusion: null };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubResponse({ workflow_runs: [inProgress] }))
      .mockResolvedValueOnce(githubResponse({ workflow_runs: [successfulRun(1)] }))
      .mockResolvedValueOnce(githubResponse({ total_count: 1, artifacts: [CANDIDATE] }));
    vi.stubGlobal('fetch', fetchMock);

    const waiting = waitForCandidate(60_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(output)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(readFileSync(output, 'utf8')).toBe(
      [
        'run_id=10',
        'run_attempt=1',
        `artifact_name=production-candidate-${SHA}-10-1`,
        'validation_profile=main-ci',
        '',
      ].join('\n'),
    );
  });

  it('times out when the exact-commit run never finishes, and writes no output', async () => {
    vi.useFakeTimers();
    const output = configureEvidenceEnvironment();
    const queued = { ...successfulRun(1), status: 'queued', conclusion: null };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(githubResponse({ workflow_runs: [queued] }));
    vi.stubGlobal('fetch', fetchMock);

    const timedOut = expect(waitForCandidate(25_000)).rejects.toThrow(
      `Timed out waiting for ci.yml on exact commit ${SHA}.`,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await timedOut;
    // Polled at 0, 10 and 20 s; the 30 s check is past the 25 s deadline.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(existsSync(output)).toBe(false);
  });
});
