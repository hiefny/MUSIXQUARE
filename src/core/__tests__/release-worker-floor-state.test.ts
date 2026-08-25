import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { verifyRecoveryBoundary } from '../../../scripts/release-deployment-state.mts';
import {
  DEVELOPER_AUTHORITY_SUPPORT_RELEASE_SHA,
  ENTITLEMENT_SUPPORT_RELEASE_SHA,
  assessWorkerFloorRecovery,
  captureWorkerFloorCheckpoint,
  readWorkerFloorForwardRepairTargets,
  verifyWorkerFloorRecovery,
} from '../../../scripts/release-worker-floor-state.mts';

const SCRIPT_PATH = resolve('scripts/release-worker-floor-state.mts');
const CANDIDATE_SHA = 'c'.repeat(40);
const FLOOR_SHA = 'a'.repeat(40);
const LEGACY_ENTITLEMENT_BLIND_SHA = 'e1eb9b7ce15316d875f55b16e8be134eba521813';
const GENERATION_SUPPORT_SHA = '4c5612d5fc4c5548781eb7d5b26d6904969c051c';
const DEVELOPER_AUTHORITY_WORKERS = ['developer-api-facade', 'developer-api'] as const;
const FLOOR_WORKERS = [
  'pro-room',
  'signaling',
  'developer-api-facade',
  'developer-api',
  'app',
] as const;
const RECOVERY_ORDER = [...FLOOR_WORKERS].reverse();
const BEFORE_SHA = new Map<string, string>(
  FLOOR_WORKERS.map((target, index) => [target, String(index + 1).repeat(40)]),
);
const temporaryDirectories: string[] = [];

function directory(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'mxqr-worker-floor-'));
  temporaryDirectories.push(path);
  return path;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function floorPayload({
  generation = true,
  floorReleaseSha = generation ? FLOOR_SHA : null,
  entitlement = true,
  status = 'disabled',
  releaseSha = status === 'ready' ? CANDIDATE_SHA : null,
}: {
  generation?: boolean;
  floorReleaseSha?: string | null;
  entitlement?: boolean;
  status?: 'disabled' | 'ready';
  releaseSha?: string | null;
} = {}): unknown {
  return [
    {
      success: true,
      results: [
        {
          contract_version: 1,
          status,
          release_sha: releaseSha,
          ever_enabled: generation ? 1 : 0,
          floor_release_sha: floorReleaseSha,
          generation_floor: generation ? 1 : 0,
          entitlement_floor: entitlement ? 1 : 0,
        },
      ],
    },
  ];
}

function writeWorkerStates(
  root: string,
  targets: readonly string[] = FLOOR_WORKERS,
  {
    beforeMessage = (target: string): string | null => `git:${BEFORE_SHA.get(target)}`,
  }: { beforeMessage?: (target: string) => string | null } = {},
): void {
  mkdirSync(root, { recursive: true });
  for (const target of targets) {
    writeJson(resolve(root, `${target}-state.json`), {
      schemaVersion: 1,
      target,
      config: `cloudflare/wrangler.${target}.toml`,
      releaseMessage: `git:${CANDIDATE_SHA}`,
      beforeDeploymentId: `${target}-baseline-deployment`,
      beforeVersionId: `${target}-baseline-version`,
      beforeMessage: beforeMessage(target),
      attempted: true,
      afterDeploymentId: null,
      afterVersionId: null,
      changed: false,
    });
  }
}

function ancestry({
  releaseAncestors = new Set(FLOOR_WORKERS),
  floorAware = new Set(FLOOR_WORKERS),
  entitlementAware = new Set(FLOOR_WORKERS),
  developerAuthorityAware = new Set(FLOOR_WORKERS),
}: {
  releaseAncestors?: Set<string>;
  floorAware?: Set<string>;
  entitlementAware?: Set<string>;
  developerAuthorityAware?: Set<string>;
} = {}): (baseSha: string, headSha: string) => boolean {
  const targetForBeforeSha = (sha: string) =>
    [...BEFORE_SHA].find(([, beforeSha]) => beforeSha === sha)?.[0];
  return (baseSha, headSha) => {
    if (headSha === CANDIDATE_SHA) {
      const target = targetForBeforeSha(baseSha);
      return Boolean(target && releaseAncestors.has(target));
    }
    if (baseSha === FLOOR_SHA) {
      const target = targetForBeforeSha(headSha);
      return Boolean(target && floorAware.has(target));
    }
    if (baseSha === ENTITLEMENT_SUPPORT_RELEASE_SHA) {
      const target = targetForBeforeSha(headSha);
      return Boolean(target && entitlementAware.has(target));
    }
    if (baseSha === DEVELOPER_AUTHORITY_SUPPORT_RELEASE_SHA) {
      const target = targetForBeforeSha(headSha);
      return Boolean(target && developerAuthorityAware.has(target));
    }
    return false;
  };
}

function writeRollbackReport(
  root: string,
  status: 'already-restored' | 'restored' | 'skipped-compatibility-floor',
): void {
  writeJson(resolve(root, 'rollback-report.json'), {
    schemaVersion: 1,
    status: status === 'skipped-compatibility-floor' ? 'partial-failure' : 'succeeded',
    results: FLOOR_WORKERS.map((target) => ({ target, status })),
  });
}

function liveWorker(boundary: 'baseline' | 'candidate') {
  return (target: string) => ({
    deploymentId: `${target}-${boundary}-deployment`,
    versionId:
      boundary === 'baseline' ? `${target}-baseline-version` : `${target}-candidate-version`,
    message: boundary === 'candidate' ? `git:${CANDIDATE_SHA}` : `git:${BEFORE_SHA.get(target)}`,
  });
}

function workflowStep(workflow: string, name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  const end = workflow.indexOf('\n      - name:', start + 1);
  expect(start, name).toBeGreaterThan(-1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('Worker compatibility-floor recovery', () => {
  it('captures exact Cloudflare/Git provenance and permits a later all-release baseline', () => {
    const checkpoint = directory();
    const sameJob = directory();
    const independent = directory();
    writeWorkerStates(checkpoint);

    const captured = captureWorkerFloorCheckpoint('all', floorPayload(), checkpoint, {
      isAncestor: ancestry(),
    });
    expect(captured).toMatchObject({
      releaseTarget: 'all',
      releaseGitSha: CANDIDATE_SHA,
      floors: {
        generationFloor: true,
        floorReleaseSha: FLOOR_SHA,
        entitlementFloor: true,
      },
    });
    expect(captured.workers).toEqual(
      FLOOR_WORKERS.map((target) =>
        expect.objectContaining({
          target,
          beforeDeploymentId: `${target}-baseline-deployment`,
          beforeVersionId: `${target}-baseline-version`,
          beforeGitSha: BEFORE_SHA.get(target),
          provenanceStatus: 'verified-release-ancestor',
          generationFloorAware: true,
          entitlementFloorAware: true,
          developerAuthorityAware: true,
        }),
      ),
    );

    const sameJobReport = assessWorkerFloorRecovery(checkpoint, floorPayload(), sameJob, {
      isAncestor: ancestry(),
    });
    const independentReport = assessWorkerFloorRecovery(checkpoint, floorPayload(), independent, {
      isAncestor: ancestry(),
    });
    expect(sameJobReport.status).toBe('rollback-compatible');
    expect(sameJobReport.forwardRepairTargets).toEqual([]);
    expect(readWorkerFloorForwardRepairTargets(sameJob)).toBe('');
    expect({
      status: sameJobReport.status,
      results: sameJobReport.results,
      targets: sameJobReport.forwardRepairTargets,
    }).toEqual({
      status: independentReport.status,
      results: independentReport.results,
      targets: independentReport.forwardRepairTargets,
    });
  });

  it.each([
    ['before the first Worker mutation', 'already-restored'],
    ['after a later bad all-release candidate', 'restored'],
  ] as const)('verifies the captured baseline %s', (_label, rollbackStatus) => {
    const checkpoint = directory();
    writeWorkerStates(checkpoint);
    captureWorkerFloorCheckpoint('all', floorPayload(), checkpoint, {
      isAncestor: ancestry(),
    });
    const assessment = assessWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
      isAncestor: ancestry(),
    });
    expect(assessment.forwardRepairTargets).toEqual([]);

    writeRollbackReport(checkpoint, rollbackStatus);
    expect(
      verifyRecoveryBoundary(checkpoint, { queryCurrent: liveWorker('baseline') }),
    ).toMatchObject({
      status: 'verified',
      results: RECOVERY_ORDER.map((target) => ({
        target,
        status: 'verified-baseline',
      })),
    });
  });

  it('retains the exact candidate after a first generation-floor cutover', () => {
    const checkpoint = directory();
    writeWorkerStates(checkpoint);
    captureWorkerFloorCheckpoint(
      'all',
      floorPayload({ generation: false, floorReleaseSha: null, entitlement: true }),
      checkpoint,
      { isAncestor: ancestry() },
    );

    const assessment = assessWorkerFloorRecovery(
      checkpoint,
      floorPayload({ generation: true, floorReleaseSha: CANDIDATE_SHA, entitlement: true }),
      checkpoint,
      { isAncestor: ancestry() },
    );
    expect(assessment.status).toBe('forward-repair-required');
    expect(assessment.forwardRepairTargets).toEqual(FLOOR_WORKERS);

    writeRollbackReport(checkpoint, 'skipped-compatibility-floor');
    expect(
      verifyRecoveryBoundary(checkpoint, { queryCurrent: liveWorker('candidate') }),
    ).toMatchObject({
      status: 'verified',
      results: RECOVERY_ORDER.map((target) => ({
        target,
        status: 'verified-forward-boundary',
      })),
    });
  });

  it('propagates first-cutover recovery failure when no exact candidate is live', () => {
    const checkpoint = directory();
    writeWorkerStates(checkpoint);
    captureWorkerFloorCheckpoint(
      'all',
      floorPayload({ generation: false, floorReleaseSha: null, entitlement: true }),
      checkpoint,
      { isAncestor: ancestry() },
    );
    assessWorkerFloorRecovery(
      checkpoint,
      floorPayload({ generation: true, floorReleaseSha: CANDIDATE_SHA, entitlement: true }),
      checkpoint,
      { isAncestor: ancestry() },
    );
    writeRollbackReport(checkpoint, 'skipped-compatibility-floor');

    expect(() =>
      verifyRecoveryBoundary(checkpoint, { queryCurrent: liveWorker('baseline') }),
    ).toThrow('production is not a proven baseline or forward-repair candidate');
    expect(
      JSON.parse(readFileSync(resolve(checkpoint, 'recovery-final-verification.json'), 'utf8')),
    ).toMatchObject({ status: 'failed' });
  });

  it('rejects a restored baseline that contradicts a candidate-required floor report', () => {
    const checkpoint = directory();
    writeWorkerStates(checkpoint);
    captureWorkerFloorCheckpoint(
      'all',
      floorPayload({ generation: false, floorReleaseSha: null, entitlement: true }),
      checkpoint,
      { isAncestor: ancestry() },
    );
    assessWorkerFloorRecovery(
      checkpoint,
      floorPayload({ generation: true, floorReleaseSha: CANDIDATE_SHA, entitlement: true }),
      checkpoint,
      { isAncestor: ancestry() },
    );

    // The generic Worker verifier can prove this baseline in isolation. The
    // final floor verifier must reject it because every target was withheld by
    // the first-cutover assessment and therefore requires the exact candidate.
    writeRollbackReport(checkpoint, 'restored');
    expect(
      verifyRecoveryBoundary(checkpoint, { queryCurrent: liveWorker('baseline') }),
    ).toMatchObject({ status: 'verified' });
    expect(() =>
      verifyWorkerFloorRecovery(
        checkpoint,
        floorPayload({ generation: true, floorReleaseSha: CANDIDATE_SHA, entitlement: true }),
        checkpoint,
      ),
    ).toThrow('Final Worker compatibility-floor verification failed');
  });

  it('freshly verifies stable floor evidence after the paired Worker boundary', () => {
    const checkpoint = directory();
    writeWorkerStates(checkpoint);
    captureWorkerFloorCheckpoint('all', floorPayload(), checkpoint, {
      isAncestor: ancestry(),
    });
    assessWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
      isAncestor: ancestry(),
    });
    writeRollbackReport(checkpoint, 'restored');
    verifyRecoveryBoundary(checkpoint, { queryCurrent: liveWorker('baseline') });

    expect(
      verifyWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
        isAncestor: ancestry(),
      }),
    ).toMatchObject({
      status: 'verified',
      releaseGitSha: CANDIDATE_SHA,
      assessmentStatus: 'rollback-compatible',
      forwardRepairTargets: [],
      workerBoundaryStatus: 'verified',
    });
  });

  it('fails the final gate when floor evidence changes after assessment', () => {
    const checkpoint = directory();
    writeWorkerStates(checkpoint, ['app']);
    captureWorkerFloorCheckpoint(
      'app',
      floorPayload({ generation: true, entitlement: false }),
      checkpoint,
      { isAncestor: ancestry() },
    );
    assessWorkerFloorRecovery(
      checkpoint,
      floorPayload({ generation: true, entitlement: false }),
      checkpoint,
      { isAncestor: ancestry() },
    );
    writeJson(resolve(checkpoint, 'rollback-report.json'), {
      schemaVersion: 1,
      status: 'succeeded',
      results: [{ target: 'app', status: 'restored' }],
    });
    verifyRecoveryBoundary(checkpoint, { queryCurrent: liveWorker('baseline') });

    expect(() =>
      verifyWorkerFloorRecovery(
        checkpoint,
        floorPayload({ generation: true, entitlement: true }),
        checkpoint,
      ),
    ).toThrow('Final Worker compatibility-floor verification failed');
    expect(
      JSON.parse(readFileSync(resolve(checkpoint, 'worker-floor-final-verification.json'), 'utf8')),
    ).toMatchObject({ status: 'failed' });
  });

  it('fails the final gate if generation readiness is reactivated after assessment', () => {
    const checkpoint = directory();
    writeWorkerStates(checkpoint);
    captureWorkerFloorCheckpoint(
      'all',
      floorPayload({
        generation: true,
        entitlement: true,
        status: 'ready',
        releaseSha: 'd'.repeat(40),
      }),
      checkpoint,
      { isAncestor: ancestry() },
    );
    assessWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
      isAncestor: ancestry(),
    });
    writeRollbackReport(checkpoint, 'restored');
    verifyRecoveryBoundary(checkpoint, { queryCurrent: liveWorker('baseline') });

    expect(() =>
      verifyWorkerFloorRecovery(
        checkpoint,
        floorPayload({ status: 'ready', releaseSha: CANDIDATE_SHA }),
        checkpoint,
      ),
    ).toThrow('Final Worker compatibility-floor verification failed');
  });

  it('rejects regressed, drifted, or externally introduced durable floors', () => {
    const expectInvalidEvolution = (
      checkpointFloors: Parameters<typeof floorPayload>[0],
      currentFloors: Parameters<typeof floorPayload>[0],
      message: string,
    ) => {
      const checkpoint = directory();
      writeWorkerStates(checkpoint, ['app']);
      captureWorkerFloorCheckpoint('app', floorPayload(checkpointFloors), checkpoint, {
        isAncestor: ancestry(),
      });
      expect(() =>
        assessWorkerFloorRecovery(checkpoint, floorPayload(currentFloors), checkpoint, {
          isAncestor: ancestry(),
        }),
      ).toThrow(message);
    };

    expectInvalidEvolution(
      { generation: true, entitlement: true },
      { generation: false, floorReleaseSha: null, entitlement: true },
      'generation floor regressed',
    );
    expectInvalidEvolution(
      { generation: true, entitlement: true },
      { generation: true, floorReleaseSha: 'd'.repeat(40), entitlement: true },
      'release SHA drifted',
    );
    expectInvalidEvolution(
      { generation: false, floorReleaseSha: null, entitlement: true },
      { generation: true, floorReleaseSha: 'd'.repeat(40), entitlement: true },
      'exact release candidate',
    );
    expectInvalidEvolution(
      { generation: true, entitlement: true },
      { generation: true, entitlement: false },
      'entitlement compatibility floor regressed',
    );
  });

  it('allows an existing entitlement floor but retains app and PRO throughout first cutover', () => {
    const existing = directory();
    writeWorkerStates(existing);
    captureWorkerFloorCheckpoint('all', floorPayload({ entitlement: true }), existing, {
      isAncestor: ancestry(),
    });
    expect(
      assessWorkerFloorRecovery(existing, floorPayload({ entitlement: true }), existing, {
        isAncestor: ancestry(),
      }).forwardRepairTargets,
    ).toEqual([]);

    const introduced = directory();
    writeWorkerStates(introduced);
    captureWorkerFloorCheckpoint('all', floorPayload({ entitlement: false }), introduced, {
      isAncestor: ancestry(),
    });
    expect(
      assessWorkerFloorRecovery(introduced, floorPayload({ entitlement: false }), introduced, {
        isAncestor: ancestry(),
      }).forwardRepairTargets,
    ).toEqual(['pro-room', 'app']);
    expect(
      assessWorkerFloorRecovery(introduced, floorPayload({ entitlement: true }), introduced, {
        isAncestor: ancestry(),
      }).forwardRepairTargets,
    ).toEqual(['pro-room', 'app']);
  });

  it('requires an entitlement-aware App/PRO baseline after the durable floor is complete', () => {
    expect(ENTITLEMENT_SUPPORT_RELEASE_SHA).toBe('a79d1624d2314942072622cc875da7c7332a9530');

    const checkpoint = directory();
    writeWorkerStates(checkpoint, ['app']);
    const entitlementBlindAncestry = ancestry({ entitlementAware: new Set() });
    const captured = captureWorkerFloorCheckpoint('app', floorPayload(), checkpoint, {
      isAncestor: entitlementBlindAncestry,
    });
    expect(captured.workers).toEqual([
      expect.objectContaining({
        target: 'app',
        provenanceStatus: 'verified-release-ancestor',
        generationFloorAware: true,
        entitlementFloorAware: false,
      }),
    ]);

    const report = assessWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
      isAncestor: entitlementBlindAncestry,
    });
    expect(report.status).toBe('forward-repair-required');
    expect(report.forwardRepairTargets).toEqual(['app']);
    expect(report.results).toEqual([
      expect.objectContaining({
        target: 'app',
        floor: 'generation',
        status: 'baseline-compatible',
      }),
      expect.objectContaining({
        target: 'app',
        floor: 'entitlement',
        status: 'candidate-required',
      }),
    ]);
  });

  it('keeps an authority-blind Developer API pair on the exact candidate', () => {
    expect(DEVELOPER_AUTHORITY_SUPPORT_RELEASE_SHA).toBe(
      '4d2a4ff7898d40956fc110ad998433aa41ceb0e2',
    );

    const checkpoint = directory();
    writeWorkerStates(checkpoint, DEVELOPER_AUTHORITY_WORKERS);
    const authorityBlindAncestry = ancestry({ developerAuthorityAware: new Set() });
    const captured = captureWorkerFloorCheckpoint('developer-api', floorPayload(), checkpoint, {
      isAncestor: authorityBlindAncestry,
    });
    expect(captured.workers).toEqual(
      DEVELOPER_AUTHORITY_WORKERS.map((target) =>
        expect.objectContaining({
          target,
          provenanceStatus: 'verified-release-ancestor',
          generationFloorAware: true,
          developerAuthorityAware: false,
        }),
      ),
    );

    const report = assessWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
      isAncestor: authorityBlindAncestry,
    });
    expect(report.status).toBe('forward-repair-required');
    expect(report.forwardRepairTargets).toEqual([...DEVELOPER_AUTHORITY_WORKERS]);
    expect(report.results).toEqual([
      ...DEVELOPER_AUTHORITY_WORKERS.map((target) => ({
        target,
        floor: 'generation',
        status: 'baseline-compatible',
        beforeGitSha: BEFORE_SHA.get(target),
      })),
      ...DEVELOPER_AUTHORITY_WORKERS.map((target) => ({
        target,
        floor: 'developer-authority',
        status: 'candidate-required',
        beforeGitSha: BEFORE_SHA.get(target),
      })),
    ]);

    writeJson(resolve(checkpoint, 'rollback-report.json'), {
      schemaVersion: 1,
      status: 'partial-failure',
      results: DEVELOPER_AUTHORITY_WORKERS.map((target) => ({
        target,
        status: 'skipped-compatibility-floor',
      })),
    });
    expect(
      verifyRecoveryBoundary(checkpoint, { queryCurrent: liveWorker('candidate') }),
    ).toMatchObject({ status: 'verified' });
    expect(
      verifyWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
        isAncestor: authorityBlindAncestry,
      }),
    ).toMatchObject({
      status: 'verified',
      assessmentStatus: 'forward-repair-required',
      forwardRepairTargets: [...DEVELOPER_AUTHORITY_WORKERS],
    });
  });

  it.each(DEVELOPER_AUTHORITY_WORKERS)(
    'keeps both Developer API candidates when only %s lacks authority support',
    (unsupportedTarget) => {
      const checkpoint = directory();
      writeWorkerStates(checkpoint, DEVELOPER_AUTHORITY_WORKERS);
      const oneSidedAncestry = ancestry({
        developerAuthorityAware: new Set(
          DEVELOPER_AUTHORITY_WORKERS.filter((target) => target !== unsupportedTarget),
        ),
      });
      captureWorkerFloorCheckpoint('developer-api', floorPayload(), checkpoint, {
        isAncestor: oneSidedAncestry,
      });

      const report = assessWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
        isAncestor: oneSidedAncestry,
      });
      expect(report.forwardRepairTargets).toEqual([...DEVELOPER_AUTHORITY_WORKERS]);
      expect(report.results.filter(({ floor }) => floor === 'developer-authority')).toEqual(
        DEVELOPER_AUTHORITY_WORKERS.map((target) => ({
          target,
          floor: 'developer-authority',
          status: 'candidate-required',
          beforeGitSha: BEFORE_SHA.get(target),
        })),
      );

      writeJson(resolve(checkpoint, 'rollback-report.json'), {
        schemaVersion: 1,
        status: 'partial-failure',
        results: DEVELOPER_AUTHORITY_WORKERS.map((target) => ({
          target,
          status: 'skipped-compatibility-floor',
        })),
      });
      verifyRecoveryBoundary(checkpoint, { queryCurrent: liveWorker('candidate') });
      expect(
        verifyWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
          isAncestor: oneSidedAncestry,
        }),
      ).toMatchObject({
        status: 'verified',
        forwardRepairTargets: [...DEVELOPER_AUTHORITY_WORKERS],
      });
    },
  );

  it('rejects a forged floor assessment that omits required Developer API forward targets', () => {
    const checkpoint = directory();
    writeWorkerStates(checkpoint, DEVELOPER_AUTHORITY_WORKERS);
    const authorityBlindAncestry = ancestry({ developerAuthorityAware: new Set() });
    captureWorkerFloorCheckpoint('developer-api', floorPayload(), checkpoint, {
      isAncestor: authorityBlindAncestry,
    });
    assessWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
      isAncestor: authorityBlindAncestry,
    });

    const assessmentPath = resolve(checkpoint, 'worker-floor-recovery.json');
    const forged = JSON.parse(readFileSync(assessmentPath, 'utf8')) as {
      status: string;
      forwardRepairTargets: string[];
      results: Array<{ floor: string; status: string }>;
    };
    forged.status = 'rollback-compatible';
    forged.forwardRepairTargets = [];
    for (const result of forged.results) {
      if (result.floor === 'developer-authority') result.status = 'baseline-compatible';
    }
    writeJson(assessmentPath, forged);
    writeJson(resolve(checkpoint, 'rollback-report.json'), {
      schemaVersion: 1,
      status: 'succeeded',
      results: DEVELOPER_AUTHORITY_WORKERS.map((target) => ({ target, status: 'restored' })),
    });
    expect(
      verifyRecoveryBoundary(checkpoint, { queryCurrent: liveWorker('baseline') }),
    ).toMatchObject({ status: 'verified' });

    expect(() =>
      verifyWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
        isAncestor: authorityBlindAncestry,
      }),
    ).toThrow('Final Worker compatibility-floor verification failed');
    expect(
      JSON.parse(readFileSync(resolve(checkpoint, 'worker-floor-final-verification.json'), 'utf8')),
    ).toMatchObject({ status: 'failed' });
  });

  it.each([
    ['unknown', () => null, ancestry()],
    [
      'divergent',
      (target: string) => `git:${BEFORE_SHA.get(target)}`,
      ancestry({ releaseAncestors: new Set() }),
    ],
  ] as const)(
    'fails closed for %s Developer API provenance',
    (_label, beforeMessage, isAncestor) => {
      const checkpoint = directory();
      writeWorkerStates(checkpoint, DEVELOPER_AUTHORITY_WORKERS, { beforeMessage });
      captureWorkerFloorCheckpoint('developer-api', floorPayload(), checkpoint, { isAncestor });

      const report = assessWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
        isAncestor,
      });
      expect(report.forwardRepairTargets).toEqual([...DEVELOPER_AUTHORITY_WORKERS]);
      expect(report.results.filter(({ floor }) => floor === 'developer-authority')).toEqual(
        DEVELOPER_AUTHORITY_WORKERS.map((target) =>
          expect.objectContaining({ target, status: 'candidate-required' }),
        ),
      );
    },
  );

  it('fails closed when a first-cutover entitlement candidate was never deployed', () => {
    const checkpoint = directory();
    writeWorkerStates(checkpoint, ['app']);
    captureWorkerFloorCheckpoint('app', floorPayload({ entitlement: false }), checkpoint, {
      isAncestor: ancestry(),
    });
    expect(
      assessWorkerFloorRecovery(checkpoint, floorPayload({ entitlement: false }), checkpoint, {
        isAncestor: ancestry(),
      }).forwardRepairTargets,
    ).toEqual(['app']);
    writeJson(resolve(checkpoint, 'rollback-report.json'), {
      schemaVersion: 1,
      status: 'partial-failure',
      results: [{ target: 'app', status: 'skipped-compatibility-floor' }],
    });
    expect(() =>
      verifyRecoveryBoundary(checkpoint, { queryCurrent: liveWorker('baseline') }),
    ).toThrow('production is not a proven baseline or forward-repair candidate');
  });

  it('fails closed for unknown baseline provenance', () => {
    const checkpoint = directory();
    writeWorkerStates(checkpoint, ['app'], { beforeMessage: () => null });
    captureWorkerFloorCheckpoint('app', floorPayload(), checkpoint, {
      isAncestor: ancestry(),
    });
    const report = assessWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
      isAncestor: ancestry(),
    });
    expect(report.forwardRepairTargets).toEqual(['app']);
    expect(report.results).toEqual([
      expect.objectContaining({ target: 'app', floor: 'generation', status: 'candidate-required' }),
      expect.objectContaining({
        target: 'app',
        floor: 'entitlement',
        status: 'candidate-required',
      }),
    ]);
  });

  it('fails closed for divergent baseline provenance', () => {
    const checkpoint = directory();
    writeWorkerStates(checkpoint, ['app']);
    const divergentAncestry = ancestry({ releaseAncestors: new Set() });
    captureWorkerFloorCheckpoint('app', floorPayload(), checkpoint, {
      isAncestor: divergentAncestry,
    });
    const report = assessWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
      isAncestor: divergentAncestry,
    });
    expect(report.forwardRepairTargets).toEqual(['app']);
    expect(report.results).toEqual([
      expect.objectContaining({
        target: 'app',
        floor: 'generation',
        status: 'candidate-required',
      }),
      expect.objectContaining({
        target: 'app',
        floor: 'entitlement',
        status: 'candidate-required',
      }),
    ]);
  });

  it('rejects a checkpoint missing canonical cutover authority evidence', () => {
    const checkpoint = directory();
    writeWorkerStates(checkpoint, ['app']);
    captureWorkerFloorCheckpoint('app', floorPayload(), checkpoint, {
      isAncestor: ancestry(),
    });
    const checkpointPath = resolve(checkpoint, 'worker-floor-checkpoint.json');
    const tampered = JSON.parse(readFileSync(checkpointPath, 'utf8')) as {
      floors: Record<string, unknown>;
    };
    delete tampered.floors.status;
    delete tampered.floors.releaseSha;
    writeJson(checkpointPath, tampered);

    expect(() =>
      assessWorkerFloorRecovery(checkpoint, floorPayload(), checkpoint, {
        isAncestor: ancestry(),
      }),
    ).toThrow('checkpoint is missing or malformed');
  });

  it('runs the snapshot and assessment CLIs against a supported baseline', () => {
    const checkpoint = directory();
    const payloadPath = resolve(checkpoint, 'floor.json');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeJson(resolve(checkpoint, 'app-state.json'), {
      schemaVersion: 1,
      target: 'app',
      config: 'cloudflare/wrangler.app.toml',
      releaseMessage: `git:${head}`,
      beforeDeploymentId: 'app-baseline-deployment',
      beforeVersionId: 'app-baseline-version',
      beforeMessage: `git:${head}`,
      attempted: true,
    });
    writeJson(
      payloadPath,
      floorPayload({ generation: true, floorReleaseSha: head, entitlement: true }),
    );

    execFileSync(process.execPath, [SCRIPT_PATH, 'snapshot', 'app', payloadPath, checkpoint], {
      cwd: resolve('.'),
      stdio: 'pipe',
    });
    expect(
      JSON.parse(readFileSync(resolve(checkpoint, 'worker-floor-checkpoint.json'), 'utf8')),
    ).toMatchObject({
      releaseTarget: 'app',
      releaseGitSha: head,
      workers: [
        {
          target: 'app',
          beforeGitSha: head,
          provenanceStatus: 'verified-release-ancestor',
          generationFloorAware: true,
          entitlementFloorAware: true,
        },
      ],
    });

    execFileSync(process.execPath, [SCRIPT_PATH, 'assess', checkpoint, payloadPath, checkpoint], {
      cwd: resolve('.'),
      stdio: 'pipe',
    });
    expect(
      JSON.parse(readFileSync(resolve(checkpoint, 'worker-floor-recovery.json'), 'utf8')),
    ).toMatchObject({
      status: 'rollback-compatible',
      forwardRepairTargets: [],
      results: [
        { target: 'app', floor: 'generation', status: 'baseline-compatible' },
        { target: 'app', floor: 'entitlement', status: 'baseline-compatible' },
      ],
    });
  });

  it('keeps the exact candidate when the real baseline predates entitlement support', () => {
    const checkpoint = directory();
    const payloadPath = resolve(checkpoint, 'floor.json');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(
      execFileSync('git', ['merge-base', '--is-ancestor', GENERATION_SUPPORT_SHA, head], {
        stdio: 'ignore',
      }),
    ).toBeDefined();
    expect(() =>
      execFileSync(
        'git',
        [
          'merge-base',
          '--is-ancestor',
          ENTITLEMENT_SUPPORT_RELEASE_SHA,
          LEGACY_ENTITLEMENT_BLIND_SHA,
        ],
        { stdio: 'ignore' },
      ),
    ).toThrow();
    writeJson(resolve(checkpoint, 'app-state.json'), {
      schemaVersion: 1,
      target: 'app',
      config: 'cloudflare/wrangler.app.toml',
      releaseMessage: `git:${head}`,
      beforeDeploymentId: 'app-legacy-deployment',
      beforeVersionId: 'app-legacy-version',
      beforeMessage: `git:${LEGACY_ENTITLEMENT_BLIND_SHA}`,
      attempted: true,
    });
    writeJson(
      payloadPath,
      floorPayload({
        generation: true,
        floorReleaseSha: GENERATION_SUPPORT_SHA,
        entitlement: true,
      }),
    );

    execFileSync(process.execPath, [SCRIPT_PATH, 'snapshot', 'app', payloadPath, checkpoint], {
      cwd: resolve('.'),
      stdio: 'pipe',
    });
    execFileSync(process.execPath, [SCRIPT_PATH, 'assess', checkpoint, payloadPath, checkpoint], {
      cwd: resolve('.'),
      stdio: 'pipe',
    });

    expect(
      JSON.parse(readFileSync(resolve(checkpoint, 'worker-floor-checkpoint.json'), 'utf8')),
    ).toMatchObject({
      workers: [
        {
          target: 'app',
          beforeGitSha: LEGACY_ENTITLEMENT_BLIND_SHA,
          provenanceStatus: 'verified-release-ancestor',
          generationFloorAware: true,
          entitlementFloorAware: false,
        },
      ],
    });
    expect(
      JSON.parse(readFileSync(resolve(checkpoint, 'worker-floor-recovery.json'), 'utf8')),
    ).toMatchObject({
      status: 'forward-repair-required',
      forwardRepairTargets: ['app'],
      results: [
        { target: 'app', floor: 'generation', status: 'baseline-compatible' },
        { target: 'app', floor: 'entitlement', status: 'candidate-required' },
      ],
    });
  });

  it('uses real Git ancestry to reject a pre-authority Developer API baseline', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const ancestryCache = new Map<string, boolean>();
    const isAncestor = (baseSha: string, headSha: string): boolean => {
      const key = `${baseSha}:${headSha}`;
      const cached = ancestryCache.get(key);
      if (cached !== undefined) return cached;
      let result = false;
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', baseSha, headSha], {
          stdio: 'ignore',
        });
        result = true;
      } catch {
        // git merge-base exits non-zero when baseSha is not an ancestor.
      }
      ancestryCache.set(key, result);
      return result;
    };
    expect(isAncestor(GENERATION_SUPPORT_SHA, DEVELOPER_AUTHORITY_SUPPORT_RELEASE_SHA)).toBe(true);
    expect(isAncestor(DEVELOPER_AUTHORITY_SUPPORT_RELEASE_SHA, GENERATION_SUPPORT_SHA)).toBe(false);

    const runAssessment = (beforeGitSha: string) => {
      const checkpoint = directory();
      const payloadPath = resolve(checkpoint, 'floor.json');
      for (const target of DEVELOPER_AUTHORITY_WORKERS) {
        writeJson(resolve(checkpoint, `${target}-state.json`), {
          schemaVersion: 1,
          target,
          config: `cloudflare/wrangler.${target}.toml`,
          releaseMessage: `git:${head}`,
          beforeDeploymentId: `${target}-baseline-deployment`,
          beforeVersionId: `${target}-baseline-version`,
          beforeMessage: `git:${beforeGitSha}`,
          attempted: true,
        });
      }
      writeJson(
        payloadPath,
        floorPayload({
          generation: true,
          floorReleaseSha: GENERATION_SUPPORT_SHA,
          entitlement: true,
        }),
      );
      const payload = JSON.parse(readFileSync(payloadPath, 'utf8')) as unknown;
      const captured = captureWorkerFloorCheckpoint('developer-api', payload, checkpoint, {
        isAncestor,
      });
      const assessment = assessWorkerFloorRecovery(checkpoint, payload, checkpoint, {
        isAncestor,
      });
      return {
        checkpoint: captured as { workers: Array<Record<string, unknown>> },
        assessment: assessment as { status: string; forwardRepairTargets: string[] },
      };
    };

    const legacy = runAssessment(GENERATION_SUPPORT_SHA);
    expect(legacy.checkpoint.workers).toEqual(
      DEVELOPER_AUTHORITY_WORKERS.map((target) =>
        expect.objectContaining({
          target,
          generationFloorAware: true,
          developerAuthorityAware: false,
        }),
      ),
    );
    expect(legacy.assessment).toMatchObject({
      status: 'forward-repair-required',
      forwardRepairTargets: [...DEVELOPER_AUTHORITY_WORKERS],
    });

    const supported = runAssessment(head);
    expect(supported.checkpoint.workers).toEqual(
      DEVELOPER_AUTHORITY_WORKERS.map((target) =>
        expect.objectContaining({
          target,
          generationFloorAware: true,
          developerAuthorityAware: true,
        }),
      ),
    );
    expect(supported.assessment).toMatchObject({
      status: 'rollback-compatible',
      forwardRepairTargets: [],
    });
    expect(ancestryCache.size).toBeLessThanOrEqual(8);
  });

  it('wires the immutable floor checkpoint into both recovery paths', () => {
    const workflow = [
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8'),
      readFileSync(resolve('.github/workflows/release-recovery.yml'), 'utf8'),
    ].join('\n');
    const recoveryPlan = readFileSync(resolve('scripts/release-recovery-plan.mts'), 'utf8');
    const workerCheckpoint = workflow.indexOf('Capture immutable Worker compatibility floors');
    const persistedCheckpoint = workflow.indexOf('Persist pre-mutation recovery checkpoint');
    const authorization = workflow.indexOf(
      'Authorize production mutations from persisted checkpoint',
    );
    expect(workerCheckpoint).toBeGreaterThan(-1);
    expect(persistedCheckpoint).toBeGreaterThan(workerCheckpoint);
    expect(authorization).toBeGreaterThan(persistedCheckpoint);
    expect(workflow.slice(workerCheckpoint, persistedCheckpoint)).toContain(
      'release-worker-floor-state.mts',
    );

    const sameJobAssessment = workflowStep(
      workflow,
      'Assess captured Worker compatibility floors before failed-release rollback',
    );
    const sameJobRollback = workflowStep(
      workflow,
      'Restore release-owned Workers after a failed release',
    );
    const independentAssessment = workflowStep(
      workflow,
      'Assess persisted Worker compatibility floors',
    );
    const independentRollback = workflowStep(
      workflow,
      'Restore release-owned Workers or record a forward-repair boundary',
    );
    for (const step of [sameJobAssessment, independentAssessment]) {
      expect(step).toContain('assess release-artifacts/recovery-checkpoint "$floor_file"');
      expect(step).toContain('targets release-artifacts/recovery-checkpoint');
    }
    for (const step of [sameJobRollback, independentRollback]) {
      expect(step).toContain('MXQR_WORKER_FLOOR_TARGETS=');
      expect(step).toContain('node scripts/release-recovery-plan.mts');
      expect(step).toContain('rollback release-artifacts/recovery-checkpoint');
      expect(step).toContain(
        'service-control-forward-floor "$GITHUB_SHA" release-artifacts/recovery-checkpoint',
      );
      expect(step).toContain(
        'remote-share-forward-floor "$GITHUB_SHA" release-artifacts/recovery-checkpoint',
      );
      expect(step).toContain(
        'pro-system-audio-forward-floor "$GITHUB_SHA" release-artifacts/recovery-checkpoint',
      );
      expect(step).toContain(
        'standard-room-pin-forward-floor "$GITHUB_SHA" release-artifacts/recovery-checkpoint',
      );
      expect(step).not.toMatch(/generation_floor[^\n]*== ['"]true['"]/u);
    }
    expect(recoveryPlan).toContain(
      "return ['pro-room', 'signaling', 'developer-api-facade', 'developer-api', 'app'];",
    );
    expect(
      workflowStep(workflow, 'Reconcile R2 policy with the exact recovered Worker boundary'),
    ).toContain('release-artifacts/recovery-checkpoint');
    expect(
      workflowStep(workflow, 'Freshly verify the paired R2 and Worker recovery boundary'),
    ).not.toContain('release-artifacts/deployments');
    const sameJobPaired = workflow.indexOf(
      'Freshly verify the paired R2 and Worker recovery boundary',
    );
    const sameJobFloorFinal = workflow.indexOf('Freshly verify Worker compatibility floors');
    const independentPaired = workflow.indexOf(
      'Verify final paired R2 and Worker recovery boundary',
    );
    const independentFloorFinal = workflow.indexOf(
      'Freshly verify persisted Worker compatibility floors',
    );
    expect(sameJobFloorFinal).toBeGreaterThan(sameJobPaired);
    expect(independentFloorFinal).toBeGreaterThan(independentPaired);
    for (const stepName of [
      'Freshly verify Worker compatibility floors',
      'Freshly verify persisted Worker compatibility floors',
    ]) {
      const step = workflowStep(workflow, stepName);
      expect(step).toContain('CLOUDFLARE_D1_API_TOKEN');
      expect(step).toContain('verify release-artifacts/recovery-checkpoint "$floor_file"');
      expect(step).toContain('entitlement_floor');
    }
    const sameJobFailure = workflowStep(
      workflow,
      'Fail release when automatic recovery is incomplete',
    );
    for (const outcome of [
      'r2_policy_assessment',
      'worker_floor_assessment',
      'worker_floor_verification',
    ]) {
      expect(sameJobFailure).toContain(`steps.${outcome}.outcome == 'failure'`);
      expect(sameJobFailure).toContain(`steps.${outcome}.outcome == 'cancelled'`);
    }

    const independentFailure = workflowStep(
      workflow,
      'Fail independent recovery when automatic recovery is incomplete',
    );
    for (const outcome of [
      'fallback_r2_policy_assessment',
      'fallback_generation_fence',
      'fallback_worker_floor_assessment',
      'fallback_worker_recovery',
      'fallback_r2_policy_reconciliation',
      'fallback_final_verification',
      'fallback_worker_floor_verification',
    ]) {
      expect(independentFailure).toContain(`steps.${outcome}.outcome == 'failure'`);
      expect(independentFailure).toContain(`steps.${outcome}.outcome == 'cancelled'`);
    }
  });
});
