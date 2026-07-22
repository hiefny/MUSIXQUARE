import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attemptedStates,
  preflight,
  productionVersion,
  queryCurrent,
  retrySync,
  runRollbackWithRetry,
  rollbackDisposition,
  rollbackDependencyBlock,
  rollbackSkipTargets,
  verifyCurrentRelease,
  verifyProductionVersion,
} from '../../../scripts/release-deployment-state.mjs';

const SCRIPT_PATH = resolve('scripts/release-deployment-state.mjs');
const temporaryDirectories: string[] = [];

function createDirectory(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'mxqr-release-deployment-'));
  temporaryDirectories.push(directory);
  return directory;
}

function deployment(versionId: string, message = 'release-message') {
  return {
    id: `deployment-${versionId}`,
    annotations: { 'workers/message': message },
    versions: [{ version_id: versionId, percentage: 100 }],
  };
}

function runScript(
  args: string[],
  environment: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('release deployment rollback state', () => {
  it('runs a production-state preflight immediately before every Worker deploy', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    for (const target of [
      'remote-share',
      'signaling',
      'pro-room',
      'developer-api-facade',
      'developer-api',
      'app',
    ]) {
      expect(workflow).toMatch(
        new RegExp(
          `preflight ${target}\\s+node scripts/release-deployment-state\\.mjs attempt ${target}` +
            `\\s+set \\+e\\s+npm run --silent wrangler -- deploy`,
        ),
      );
    }
  });

  it('keeps the cross-Worker release chain in dependency order', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const remoteShare = workflow.indexOf('Deploy and record remote-share Worker');
    const proRoom = workflow.indexOf('Deploy and record PRO room Worker');
    const signaling = workflow.indexOf('Deploy and record signaling Worker');
    const facade = workflow.indexOf('Deploy and record Developer API facade Worker');
    const developerApi = workflow.indexOf('Deploy and record Developer API Worker');
    const app = workflow.indexOf('Deploy and record app Worker with immutable dist');

    expect(remoteShare).toBeGreaterThan(-1);
    expect(proRoom).toBeGreaterThan(remoteShare);
    expect(signaling).toBeGreaterThan(proRoom);
    expect(facade).toBeGreaterThan(signaling);
    expect(developerApi).toBeGreaterThan(facade);
    expect(app).toBeGreaterThan(developerApi);
    expect(workflow).toContain('- developer-api');
    expect(workflow).toContain("MXQR_DEVELOPER_API_SMOKE_ROOM: '000001'");
    expect(workflow).toContain(
      'MXQR_DEVELOPER_API_SMOKE_KEY: ${{ secrets.MXQR_DEVELOPER_API_SMOKE_KEY }}',
    );

    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const deployAll = packageJson.scripts['deploy:all-workers'];
    const remoteConfig = deployAll.indexOf('npm run deploy:remote-share');
    const proConfig = deployAll.indexOf('cloudflare/wrangler.pro-room.toml');
    const signalingConfig = deployAll.indexOf('npm run deploy:signaling');
    const facadeConfig = deployAll.indexOf('cloudflare/wrangler.developer-api-facade.toml');
    const apiConfig = deployAll.indexOf('cloudflare/wrangler.developer-api.toml');
    const appConfig = deployAll.indexOf('cloudflare/wrangler.app.toml');

    expect(proConfig).toBeGreaterThan(remoteConfig);
    expect(signalingConfig).toBeGreaterThan(proConfig);
    expect(facadeConfig).toBeGreaterThan(signalingConfig);
    expect(apiConfig).toBeGreaterThan(facadeConfig);
    expect(appConfig).toBeGreaterThan(apiConfig);
  });

  it('requires exactly one 100% production version', () => {
    expect(productionVersion(deployment('before'), 'fixture')).toBe('before');
    expect(() =>
      productionVersion(
        {
          versions: [
            { version_id: 'old', percentage: 50 },
            { version_id: 'new', percentage: 50 },
          ],
        },
        'fixture',
      ),
    ).toThrow('exactly one 100% production version');
  });

  it('records before, attempted, and after versions for a deploy', () => {
    const directory = createDirectory();
    writeFileSync(
      resolve(directory, 'signaling-before.json'),
      JSON.stringify(deployment('before')),
    );

    const prepare = runScript(['prepare', 'signaling', directory], {
      RELEASE_MESSAGE: 'release-message',
    });
    expect(prepare.status, prepare.stderr).toBe(0);
    expect(runScript(['attempt', 'signaling', directory]).status).toBe(0);
    writeFileSync(resolve(directory, 'signaling.json'), JSON.stringify(deployment('after')));
    expect(runScript(['record', 'signaling', directory]).status).toBe(0);

    const state = JSON.parse(
      readFileSync(resolve(directory, 'signaling-state.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(state).toMatchObject({
      target: 'signaling',
      beforeVersionId: 'before',
      afterVersionId: 'after',
      attempted: true,
      changed: true,
      ownedByRelease: true,
    });
    expect(runScript(['version', 'signaling', directory]).stdout).toBe('after');
  });

  it('stops before deploy when production changed after preparation', () => {
    for (const [label, current] of [
      [
        'deployment',
        { deploymentId: 'deployment-external', versionId: 'before', message: 'external' },
      ],
      [
        'version',
        { deploymentId: 'deployment-before', versionId: 'external', message: 'external' },
      ],
    ] as const) {
      const directory = createDirectory();
      writeFileSync(
        resolve(directory, 'signaling-before.json'),
        JSON.stringify(deployment('before')),
      );
      expect(
        runScript(['prepare', 'signaling', directory], { RELEASE_MESSAGE: 'release-message' })
          .status,
      ).toBe(0);

      expect(() =>
        preflight('signaling', directory, {
          queryCurrent: () => current,
        }),
      ).toThrow('production changed after release preparation');
      const state = JSON.parse(
        readFileSync(resolve(directory, 'signaling-state.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(state.attempted, label).toBe(false);
      expect(state.preflightCheckedAt, label).toBeUndefined();
    }
  });

  it('records a successful preflight only when deployment and version still match', () => {
    const directory = createDirectory();
    writeFileSync(resolve(directory, 'app-before.json'), JSON.stringify(deployment('before')));
    expect(
      runScript(['prepare', 'app', directory], { RELEASE_MESSAGE: 'release-message' }).status,
    ).toBe(0);

    preflight('app', directory, {
      queryCurrent: () => ({
        deploymentId: 'deployment-before',
        versionId: 'before',
        message: 'release-message',
      }),
    });

    const state = JSON.parse(readFileSync(resolve(directory, 'app-state.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({
      attempted: false,
      preflightDeploymentId: 'deployment-before',
      preflightVersionId: 'before',
    });
    expect(state.preflightCheckedAt).toEqual(expect.any(String));
  });

  it('retries transient current-deployment queries with bounded backoff', () => {
    const directory = createDirectory();
    const delays: number[] = [];
    let attempts = 0;
    const current = queryCurrent('remote-share', 'wrangler.toml', resolve(directory, 'now.json'), {
      runner: () => {
        attempts += 1;
        if (attempts < 3) throw new Error('temporary Cloudflare 503');
        return JSON.stringify(deployment('current'));
      },
      retry: {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 20,
        sleep: (delayMs: number) => delays.push(delayMs),
        onRetry: () => undefined,
      },
    });

    expect(current.versionId).toBe('current');
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it('stops retrying after the configured attempt budget', () => {
    const delays: number[] = [];
    let attempts = 0;

    expect(() =>
      retrySync(
        'always failing operation',
        () => {
          attempts += 1;
          throw new Error('still unavailable');
        },
        {
          maxAttempts: 3,
          baseDelayMs: 10,
          maxDelayMs: 15,
          sleep: (delayMs: number) => delays.push(delayMs),
          onRetry: () => undefined,
        },
      ),
    ).toThrow('still unavailable');
    expect(attempts).toBe(3);
    expect(delays).toEqual([10, 15]);
  });

  it('rechecks ownership after a lost rollback response and avoids a duplicate command', () => {
    const directory = createDirectory();
    let queries = 0;
    let commands = 0;
    const state = {
      target: 'app',
      beforeVersionId: 'before',
      afterVersionId: 'after',
      afterDeploymentId: 'deployment-after',
      releaseMessage: 'release-message',
      ownedByRelease: true,
      config: 'wrangler.toml',
    };

    const result = runRollbackWithRetry(state, 'rollback-message', {
      outputPath: resolve(directory, 'rollback-current.json'),
      queryCurrent: () => {
        queries += 1;
        return {
          versionId: queries === 1 ? 'after' : 'before',
          deploymentId: queries === 1 ? 'deployment-after' : 'deployment-before',
          message: queries === 1 ? 'release-message' : 'rollback-message',
        };
      },
      runner: () => {
        commands += 1;
        throw new Error('response lost after Cloudflare accepted rollback');
      },
      retry: {
        maxAttempts: 3,
        baseDelayMs: 5,
        maxDelayMs: 10,
        sleep: () => undefined,
        onRetry: () => undefined,
      },
    });

    expect(result.status).toBe('already-restored');
    expect(queries).toBe(2);
    expect(commands).toBe(1);
  });

  it('does not issue another rollback when an external deploy appears between attempts', () => {
    const directory = createDirectory();
    let queries = 0;
    let commands = 0;
    const state = {
      target: 'signaling',
      beforeVersionId: 'before',
      afterVersionId: 'after',
      afterDeploymentId: 'deployment-after',
      releaseMessage: 'release-message',
      ownedByRelease: true,
      config: 'wrangler.toml',
    };

    const result = runRollbackWithRetry(state, 'rollback-message', {
      outputPath: resolve(directory, 'rollback-current.json'),
      queryCurrent: () => {
        queries += 1;
        return {
          versionId: queries === 1 ? 'after' : 'external',
          deploymentId: queries === 1 ? 'deployment-after' : 'deployment-external',
          message: queries === 1 ? 'release-message' : 'manual-deploy',
        };
      },
      runner: () => {
        commands += 1;
        throw new Error('temporary Cloudflare 502');
      },
      retry: {
        maxAttempts: 3,
        baseDelayMs: 5,
        maxDelayMs: 10,
        sleep: () => undefined,
        onRetry: () => undefined,
      },
    });

    expect(result.status).toBe('conflict');
    expect(queries).toBe(2);
    expect(commands).toBe(1);
  });

  it('bounds transient rollback current-query and command retries', () => {
    const directory = createDirectory();
    const delays: number[] = [];
    let queries = 0;
    let commands = 0;
    const state = {
      target: 'remote-share',
      beforeVersionId: 'before',
      afterVersionId: 'after',
      afterDeploymentId: 'deployment-after',
      releaseMessage: 'release-message',
      ownedByRelease: true,
      config: 'wrangler.toml',
    };

    const result = runRollbackWithRetry(state, 'rollback-message', {
      outputPath: resolve(directory, 'rollback-current.json'),
      queryCurrent: () => {
        queries += 1;
        if (queries === 1) throw new Error('temporary current-query 503');
        return {
          versionId: 'after',
          deploymentId: 'deployment-after',
          message: 'release-message',
        };
      },
      runner: () => {
        commands += 1;
        if (commands === 1) throw new Error('temporary rollback 502');
        return '';
      },
      retry: {
        maxAttempts: 3,
        baseDelayMs: 5,
        maxDelayMs: 10,
        sleep: (delayMs: number) => delays.push(delayMs),
        onRetry: () => undefined,
      },
    });

    expect(result.status).toBe('command-issued');
    expect(queries).toBe(3);
    expect(commands).toBe(2);
    expect(delays).toEqual([5, 10]);
  });

  it('tolerates delayed rollback visibility', () => {
    const directory = createDirectory();

    const verifyDelays: number[] = [];
    let verifyAttempts = 0;
    const restored = verifyProductionVersion(
      'app',
      'wrangler.toml',
      'before',
      resolve(directory, 'rollback.json'),
      {
        runner: () => {
          verifyAttempts += 1;
          return JSON.stringify(deployment(verifyAttempts < 3 ? 'after' : 'before'));
        },
        retry: {
          maxAttempts: 3,
          baseDelayMs: 5,
          maxDelayMs: 10,
          sleep: (delayMs: number) => verifyDelays.push(delayMs),
          onRetry: () => undefined,
        },
      },
    );
    expect(restored.versionId).toBe('before');
    expect(verifyAttempts).toBe(3);
    expect(verifyDelays).toEqual([5, 10]);
  });

  it('rejects a missing deployment change and an externally owned version', () => {
    for (const [suffix, after] of [
      ['unchanged', deployment('before')],
      ['external', deployment('after', 'another-release')],
    ] as const) {
      const directory = createDirectory();
      writeFileSync(resolve(directory, 'app-before.json'), JSON.stringify(deployment('before')));
      expect(
        runScript(['prepare', 'app', directory], { RELEASE_MESSAGE: 'release-message' }).status,
      ).toBe(0);
      expect(runScript(['attempt', 'app', directory]).status).toBe(0);
      writeFileSync(resolve(directory, 'app.json'), JSON.stringify(after));

      const record = runScript(['record', 'app', directory]);
      expect(record.status, suffix).not.toBe(0);
      const state = JSON.parse(
        readFileSync(resolve(directory, 'app-state.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(state).toMatchObject(
        suffix === 'unchanged'
          ? { changed: false, ownedByRelease: true }
          : { changed: true, ownedByRelease: false },
      );
    }
  });

  it('rolls back only a version owned by the failed release', () => {
    const state = {
      beforeVersionId: 'before',
      afterVersionId: 'after',
      afterDeploymentId: 'deployment-after',
      releaseMessage: 'this-release',
      ownedByRelease: true,
    };
    expect(rollbackDisposition(state, { versionId: 'before', message: null })).toBe(
      'already-restored',
    );
    expect(
      rollbackDisposition(state, {
        versionId: 'after',
        deploymentId: 'deployment-after',
        message: 'anything',
      }),
    ).toBe('rollback');
    expect(
      rollbackDisposition(state, {
        versionId: 'after',
        deploymentId: 'deployment-external',
        message: 'another-release',
      }),
    ).toBe('conflict');
    expect(
      rollbackDisposition(
        { ...state, afterVersionId: null },
        { versionId: 'unrecorded-after', message: 'this-release' },
      ),
    ).toBe('rollback');
    expect(rollbackDisposition(state, { versionId: 'newer', message: 'another-release' })).toBe(
      'conflict',
    );
  });

  it('orders attempted deployments in reverse release order', () => {
    const directory = createDirectory();
    for (const target of [
      'remote-share',
      'signaling',
      'pro-room',
      'developer-api-facade',
      'developer-api',
      'app',
    ]) {
      writeFileSync(
        resolve(directory, `${target}-state.json`),
        JSON.stringify({ schemaVersion: 1, target, attempted: true }),
      );
    }

    expect(attemptedStates(directory).map((state: { target: string }) => state.target)).toEqual([
      'app',
      'developer-api',
      'developer-api-facade',
      'signaling',
      'pro-room',
      'remote-share',
    ]);
  });

  it('withholds legacy signaling when an attempted app was not safely restored', () => {
    const states = [{ target: 'app' }, { target: 'signaling' }];

    expect(rollbackDependencyBlock('signaling', states, [])).toEqual({
      dependency: 'app',
      dependencyStatus: 'not-processed',
    });
    expect(
      rollbackDependencyBlock('signaling', states, [{ target: 'app', status: 'conflict' }]),
    ).toEqual({ dependency: 'app', dependencyStatus: 'conflict' });
    expect(
      rollbackDependencyBlock('signaling', states, [{ target: 'app', status: 'failed' }]),
    ).toEqual({ dependency: 'app', dependencyStatus: 'failed' });
    expect(
      rollbackDependencyBlock('signaling', states, [{ target: 'app', status: 'already-restored' }]),
    ).toBeNull();
    expect(
      rollbackDependencyBlock('signaling', states, [{ target: 'app', status: 'restored' }]),
    ).toBeNull();
    expect(rollbackDependencyBlock('signaling', [{ target: 'signaling' }], [])).toBeNull();
  });

  it('withholds legacy PRO when signaling was not safely restored first', () => {
    const states = [{ target: 'signaling' }, { target: 'pro-room' }];

    expect(rollbackDependencyBlock('pro-room', states, [])).toEqual({
      dependency: 'signaling',
      dependencyStatus: 'not-processed',
    });
    expect(
      rollbackDependencyBlock('pro-room', states, [
        { target: 'signaling', status: 'skipped-dependent-worker-not-restored' },
      ]),
    ).toEqual({
      dependency: 'signaling',
      dependencyStatus: 'skipped-dependent-worker-not-restored',
    });
    expect(
      rollbackDependencyBlock('pro-room', states, [{ target: 'signaling', status: 'conflict' }]),
    ).toEqual({ dependency: 'signaling', dependencyStatus: 'conflict' });
    expect(
      rollbackDependencyBlock('pro-room', states, [{ target: 'signaling', status: 'restored' }]),
    ).toBeNull();
    expect(rollbackDependencyBlock('pro-room', [{ target: 'pro-room' }], [])).toBeNull();
  });

  it('verifies every attempted Worker still matches the release after live smoke', () => {
    const directory = createDirectory();
    for (const [target, versionId] of [
      ['remote-share', 'share-after'],
      ['app', 'app-after'],
    ] as const) {
      writeFileSync(
        resolve(directory, `${target}-state.json`),
        JSON.stringify({
          schemaVersion: 1,
          target,
          config: `cloudflare/wrangler.${target}.toml`,
          attempted: true,
          ownedByRelease: true,
          releaseMessage: 'release-message',
          afterDeploymentId: `deployment-${versionId}`,
          afterVersionId: versionId,
        }),
      );
    }

    const report = verifyCurrentRelease(directory, {
      queryCurrent: (target: string) => {
        const versionId = target === 'app' ? 'app-after' : 'share-after';
        return {
          deploymentId: `deployment-${versionId}`,
          versionId,
          message: 'release-message',
        };
      },
    });

    expect(report.status).toBe('verified');
    expect(report.results).toEqual([
      expect.objectContaining({ target: 'remote-share', status: 'verified' }),
      expect.objectContaining({ target: 'app', status: 'verified' }),
    ]);
  });

  it('fails final verification when another deployment replaces the recorded release', () => {
    const directory = createDirectory();
    writeFileSync(
      resolve(directory, 'app-state.json'),
      JSON.stringify({
        schemaVersion: 1,
        target: 'app',
        config: 'cloudflare/wrangler.app.toml',
        attempted: true,
        ownedByRelease: true,
        releaseMessage: 'release-message',
        afterDeploymentId: 'deployment-after',
        afterVersionId: 'after',
      }),
    );

    expect(() =>
      verifyCurrentRelease(directory, {
        queryCurrent: () => ({
          deploymentId: 'deployment-external',
          versionId: 'after',
          message: 'manual-deploy',
        }),
      }),
    ).toThrow('another deployment may have replaced this release');

    const report = JSON.parse(
      readFileSync(resolve(directory, 'final-verification-report.json'), 'utf8'),
    ) as {
      status: string;
      results: Array<{ target: string; status: string }>;
    };
    expect(report.status).toBe('failed');
    expect(report.results).toEqual([
      expect.objectContaining({ target: 'app', status: 'conflict' }),
    ]);
  });

  it('keeps the Worker deployment token out of setup and smoke steps', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const deployStart = workflow.indexOf('  deploy:');
    const deploySteps = workflow.indexOf('    steps:', deployStart);
    expect(workflow.slice(deployStart, deploySteps)).not.toContain(
      'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
    );

    for (const stepName of [
      'Verify Cloudflare credentials',
      'Record current remote-share deployment',
      'Deploy and record remote-share Worker',
      'Record current signaling deployment',
      'Deploy and record signaling Worker',
      'Record current PRO room deployment',
      'Deploy and record PRO room Worker',
      'Record current Developer API facade deployment',
      'Deploy and record Developer API facade Worker',
      'Record current Developer API deployment',
      'Deploy and record Developer API Worker',
      'Record current app deployment',
      'Deploy and record app Worker with immutable dist',
      'Verify release still owns current production deployments',
    ]) {
      const stepStart = workflow.indexOf(`- name: ${stepName}`);
      const nextStep = workflow.indexOf('\n      - name:', stepStart + 1);
      const step = workflow.slice(stepStart, nextStep < 0 ? workflow.length : nextStep);
      expect(stepStart, stepName).toBeGreaterThan(-1);
      expect(step, stepName).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    }

    const lastSmoke = workflow.indexOf('Smoke app session endpoint');
    const finalVerification = workflow.indexOf(
      'Verify release still owns current production deployments',
    );
    const schemaRollback = workflow.indexOf('Restore Developer API schema after a failed release');
    const workerRollback = workflow.indexOf('Restore Worker deployments after a failed release');
    expect(finalVerification).toBeGreaterThan(lastSmoke);
    expect(schemaRollback).toBeGreaterThan(finalVerification);
    expect(workerRollback).toBeGreaterThan(schemaRollback);
    expect(workflow).toContain("steps.final_verification.outcome || 'not-run'");

    const schemaStep = workflow.slice(schemaRollback, workerRollback);
    const workerStepEnd = workflow.indexOf('\n      - name:', workerRollback + 1);
    const workerStep = workflow.slice(workerRollback, workerStepEnd);
    expect(schemaStep).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_D1_API_TOKEN }}');
    expect(schemaStep).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(workerStep).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(workerStep).not.toContain('secrets.CLOUDFLARE_D1_API_TOKEN');
  });

  it('runs documented storage and playback static invariants in CI and release validation', () => {
    for (const workflowPath of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
      const workflow = readFileSync(resolve(workflowPath), 'utf8');
      expect(workflow, workflowPath).toContain('npm run guard:chunk-pump');
      expect(workflow, workflowPath).toContain('npm run guard:lifecycle-writes');
    }
  });

  it('proves first-frame signaling compatibility before an app-only deployment', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const preflight = workflow.indexOf('Verify current signaling contract before app-only release');
    const appDeploy = workflow.indexOf('Deploy and record app Worker with immutable dist');
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(appDeploy);
    const nextStep = workflow.indexOf('\n      - name:', preflight + 1);
    const preflightStep = workflow.slice(preflight, nextStep);
    expect(preflightStep).toContain("if: inputs.target == 'app'");
    expect(preflightStep).toContain('run: npm run smoke:live:signaling');

    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['deploy:app']).toMatch(/^npm run smoke:live:signaling && /);
  });

  it('bounds production live-smoke requests and step runtimes before rollback', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    for (const stepName of [
      'Smoke remote-share Worker',
      'Smoke signaling Worker',
      'Smoke PRO room Worker',
      'Smoke Developer API Worker',
      'Smoke app session endpoint',
    ]) {
      const stepStart = workflow.indexOf(`- name: ${stepName}`);
      const nextStep = workflow.indexOf('\n      - name:', stepStart + 1);
      const step = workflow.slice(stepStart, nextStep < 0 ? workflow.length : nextStep);
      expect(stepStart, stepName).toBeGreaterThan(-1);
      expect(step, stepName).toContain('timeout-minutes: 5');
    }

    for (const scriptPath of [
      'scripts/live-developer-api-smoke.mjs',
      'scripts/live-remote-share-smoke.ts',
    ]) {
      const source = readFileSync(resolve(scriptPath), 'utf8');
      expect(source, scriptPath).toContain('const REQUEST_TIMEOUT_MS = 30_000;');
      expect(source, scriptPath).toContain('AbortSignal.timeout(REQUEST_TIMEOUT_MS)');
      expect(source.match(/\bfetch\(/g), scriptPath).toHaveLength(1);
      expect(source.match(/\bfetchWithTimeout\(/g)?.length, scriptPath).toBeGreaterThan(1);
    }

    const proRoomSmokePath = 'scripts/live-pro-room-smoke.mjs';
    const proRoomSmoke = readFileSync(resolve(proRoomSmokePath), 'utf8');
    expect(proRoomSmoke).toContain('export const PRO_ROOM_HEALTH_REQUEST_TIMEOUT_MS = 10_000;');
    expect(proRoomSmoke).toContain('AbortSignal.timeout(PRO_ROOM_HEALTH_REQUEST_TIMEOUT_MS)');
    expect(proRoomSmoke.match(/\bfetch\(/g), proRoomSmokePath).toHaveLength(1);
    expect(proRoomSmoke.match(/\bfetchWithTimeout\(/g)?.length, proRoomSmokePath).toBeGreaterThan(
      1,
    );
  });

  it('fails closed on unknown rollback skip targets', () => {
    expect([...rollbackSkipTargets('developer-api, app')]).toEqual(['developer-api', 'app']);
    expect(() => rollbackSkipTargets('unknown-worker')).toThrow(
      'Unknown release target: unknown-worker',
    );
  });

  it('records a schema-incompatible Worker as withheld from automatic rollback', () => {
    const directory = createDirectory();
    writeFileSync(
      resolve(directory, 'developer-api-state.json'),
      JSON.stringify({
        schemaVersion: 1,
        target: 'developer-api',
        config: 'cloudflare/wrangler.developer-api.toml',
        attempted: true,
        beforeVersionId: 'legacy-before',
        afterVersionId: 'effects-after',
      }),
    );

    const result = runScript(['rollback', directory], {
      MXQR_ROLLBACK_SKIP_TARGETS: 'developer-api',
    });

    expect(result.status).not.toBe(0);
    const report = JSON.parse(readFileSync(resolve(directory, 'rollback-report.json'), 'utf8')) as {
      status: string;
      results: Array<{ target: string; status: string; error?: string }>;
    };
    expect(report.status).toBe('partial-failure');
    expect(report.results).toEqual([
      expect.objectContaining({
        target: 'developer-api',
        status: 'skipped-schema-incompatible',
        error: expect.stringContaining('required schema rollback did not complete'),
      }),
    ]);
  });
});
