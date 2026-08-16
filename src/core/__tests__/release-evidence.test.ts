import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createRealDeviceEvidence,
  selectExactArtifact,
  selectLatestSuccessfulRun,
  verifyRealDeviceEvidence,
} from '../../../scripts/release-evidence.mjs';

const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-08-15T10:00:00.000Z');

function input() {
  return {
    releaseSha: SHA,
    repository: 'hiefny/MUSIXQUARE',
    testedAt: '2026-08-15T09:30:00.000Z',
    environmentUrl: 'https://qa.musixquare.com/',
    evidenceUrl: 'https://github.com/hiefny/MUSIXQUARE/issues/123',
    tester: 'release-owner',
    workflowActor: 'hiefny',
    deviceMatrix:
      'iPhone 13 / iOS 18.6 / Safari | Pixel 8 / Android 16 / Chrome 139 | Windows 11 / Chrome 139',
    matrix: {
      standardRoom: true as const,
      proRoom: true as const,
      localAndRemoteMedia: true as const,
      youtubePlayback: true as const,
      systemAudio: true as const,
      backgroundResume: true as const,
      adaptivePowPerformance: true as const,
    },
    source: { runId: 42, runAttempt: 2 },
  };
}

describe('manual real-device evidence', () => {
  it('creates and verifies a canonical exact-SHA attestation', () => {
    const evidence = createRealDeviceEvidence(input(), NOW);
    expect(
      verifyRealDeviceEvidence(
        evidence,
        { releaseSha: SHA, repository: 'hiefny/MUSIXQUARE', runId: 42, runAttempt: 2 },
        NOW,
      ),
    ).toEqual(evidence);
    expect(Object.values(evidence.matrix)).toEqual([true, true, true, true, true, true, true]);
  });

  it('fails closed on unchecked, stale, non-HTTPS, or cross-SHA evidence', () => {
    expect(() =>
      createRealDeviceEvidence(
        { ...input(), matrix: { ...input().matrix, backgroundResume: false as never } },
        NOW,
      ),
    ).toThrow('matrix.backgroundResume');
    expect(() =>
      createRealDeviceEvidence({ ...input(), testedAt: '2026-07-01T00:00:00.000Z' }, NOW),
    ).toThrow('older than 14 days');
    expect(() =>
      createRealDeviceEvidence({ ...input(), testedAt: 'Sat, 15 Aug 2026 09:30:00 GMT' }, NOW),
    ).toThrow('canonical UTC ISO-8601');
    expect(() =>
      createRealDeviceEvidence({ ...input(), testedAt: '2026-02-30T09:30:00Z' }, NOW),
    ).toThrow('valid canonical UTC ISO-8601');
    expect(() =>
      createRealDeviceEvidence({ ...input(), environmentUrl: 'http://qa.local/' }, NOW),
    ).toThrow('absolute HTTPS URL');
    const evidence = createRealDeviceEvidence(input(), NOW);
    expect(() =>
      verifyRealDeviceEvidence(
        evidence,
        { releaseSha: 'b'.repeat(40), repository: evidence.repository, runId: 42, runAttempt: 2 },
        NOW,
      ),
    ).toThrow('release SHA');
  });

  it('rejects extra fields and evidence from a different workflow attempt', () => {
    const evidence = createRealDeviceEvidence(input(), NOW);
    expect(() =>
      verifyRealDeviceEvidence(
        { ...evidence, approved: true },
        { releaseSha: SHA, repository: evidence.repository, runId: 42, runAttempt: 2 },
        NOW,
      ),
    ).toThrow('canonical schema');
    expect(() =>
      verifyRealDeviceEvidence(
        evidence,
        { releaseSha: SHA, repository: evidence.repository, runId: 42, runAttempt: 3 },
        NOW,
      ),
    ).toThrow('workflow attempt');
  });

  it('selects only successful exact-main-SHA runs and exact-attempt artifacts', () => {
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
            event: 'workflow_dispatch',
          },
          {
            id: 11,
            run_attempt: 2,
            status: 'completed',
            conclusion: 'failure',
            head_sha: SHA,
            head_branch: 'main',
            event: 'workflow_dispatch',
          },
          {
            id: 12,
            run_attempt: 3,
            status: 'completed',
            conclusion: 'success',
            head_sha: 'b'.repeat(40),
            head_branch: 'main',
            event: 'workflow_dispatch',
          },
        ],
      },
      { sha: SHA, event: 'workflow_dispatch' },
    );
    expect(selected?.id).toBe(10);

    expect(
      selectExactArtifact(
        {
          artifacts: [
            { name: `real-device-evidence-${SHA}-10-2`, expired: false },
            { name: `real-device-evidence-${SHA}-10-1`, expired: true },
            {
              name: `real-device-evidence-${SHA}-10-1`,
              expired: false,
              created_at: '2026-08-15T09:40:00Z',
            },
          ],
        },
        { prefix: 'real-device-evidence-', sha: SHA, runId: 10, runAttempt: 1 },
      )?.name,
    ).toBe(`real-device-evidence-${SHA}-10-1`);
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
          event: 'workflow_dispatch',
        },
        {
          id: 21,
          run_attempt: 1,
          updated_at: '2026-08-15T09:45:00Z',
          status: 'completed',
          conclusion: 'success',
          head_sha: SHA,
          head_branch: 'main',
          event: 'workflow_dispatch',
        },
      ],
    };

    expect(selectLatestSuccessfulRun(runs, { sha: SHA, event: 'workflow_dispatch' })?.id).toBe(21);
    expect(
      selectLatestSuccessfulRun(runs, { sha: SHA, event: 'workflow_dispatch' }, new Set([21]))?.id,
    ).toBe(20);
  });

  it('keeps manual device evidence standalone from production release authorization', () => {
    const release = readFileSync('.github/workflows/release.yml', 'utf8');
    const deviceWorkflow = readFileSync('.github/workflows/real-device-qa.yml', 'utf8');

    for (const removedReleaseCoupling of [
      'require_real_device_evidence',
      'wait-device',
      'verify-device',
      'device_artifact_name',
      'device_run_id',
      'RELEASE_DEVICE_EVIDENCE',
      'real-device-evidence',
      'real-device-qa.yml',
      'release-device-risk',
      'real-device-risk',
      'Physical-device evidence:',
    ]) {
      expect(release).not.toContain(removedReleaseCoupling);
    }
    expect(release).toMatch(/- name: Select exact-SHA validated candidate\r?\n\s+id:/u);
    expect(release).toMatch(/- name: Download validated production candidate\r?\n\s+uses:/u);
    expect(release).toContain('needs: validate');
    const authorization = release.indexOf(
      'Authorize production mutations from persisted checkpoint',
    );
    expect(authorization).toBeGreaterThan(-1);
    for (const prerequisite of [
      'Verify candidate hashes and commit',
      'Revalidate time-sensitive production security guards',
      'Revalidate every production Worker bundle',
    ]) {
      const prerequisiteIndex = release.indexOf(prerequisite);
      expect(prerequisiteIndex).toBeGreaterThan(-1);
      expect(prerequisiteIndex).toBeLessThan(authorization);
    }
    expect(deviceWorkflow).toContain('name: Optional manual real-device QA record');
    expect(deviceWorkflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(deviceWorkflow).toContain('MXQR_RELEASE_SHA: ${{ inputs.release_sha }}');
    expect(deviceWorkflow).toContain('if [[ "$current_main" != "$MXQR_RELEASE_SHA" ||');
    expect(deviceWorkflow).not.toContain('run: |\n          if [[ ! "${{ inputs.release_sha }}"');
    expect(deviceWorkflow).toContain(
      'real-device-evidence-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(deviceWorkflow).toContain('retention-days: 90');
    expect(deviceWorkflow).not.toContain('workflow_call:');
    expect(deviceWorkflow).not.toContain('workflow_run:');
    expect(deviceWorkflow).not.toContain('environment:\n      name: production');
    expect(deviceWorkflow).not.toContain('secrets:');
    expect(deviceWorkflow).not.toContain('wrangler -- deploy');
  });
});
