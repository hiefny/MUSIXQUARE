import { describe, expect, it } from 'vitest';
import {
  selectExactArtifact,
  selectLatestSuccessfulRun,
} from '../../../scripts/release-evidence.mts';

const SHA = 'a'.repeat(40);

describe('production candidate selection', () => {
  it('selects only successful exact-main-SHA push runs and exact-attempt artifacts', () => {
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
      selectExactArtifact(
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
      )?.name,
    ).toBe(`production-candidate-${SHA}-10-1`);
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
});
