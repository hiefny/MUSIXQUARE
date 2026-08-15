import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attemptedStates,
  captureDeploymentCheckpoint,
  changedAppRuntimeDependencies,
  changedRuntimePaths,
  EMERGENCY_EXTERNAL_STATE_PATHS,
  contractCutoverRequiresForwardRepair,
  npmInvocation,
  preflight,
  productionVersion,
  queryCurrent,
  recheckPartialReleaseCompatibility,
  releaseGitSha,
  releaseTargetWorkers,
  runtimePathsForWorker,
  retrySync,
  runRollbackWithRetry,
  rollback,
  rollbackDisposition,
  rollbackDependencyBlock,
  rollbackDeploymentMessage,
  rollbackSkipTargets,
  verifyPartialReleaseCompatibility,
  verifyEmergencyCodeOnly,
  verifyCurrentRelease,
  verifyRecoveryBoundary,
  verifyProductionVersion,
} from '../../../scripts/release-deployment-state.mjs';
import { emergencyDeploymentPlan } from '../../../scripts/emergency-deploy.mjs';

const SCRIPT_PATH = resolve('scripts/release-deployment-state.mjs');
const CANONICAL_RELEASE_MESSAGE = `git:${'a'.repeat(40)}`;
const temporaryDirectories: string[] = [];

function createDirectory(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'mxqr-release-deployment-'));
  temporaryDirectories.push(directory);
  return directory;
}

function deployment(versionId: string, message = CANONICAL_RELEASE_MESSAGE) {
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
  it('rechecks unselected Workers before the selected Worker preflight and every deploy', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const workflowLines = workflow.split(/\r?\n/u);
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
          `if \\[\\[ "\\$RELEASE_TARGET" != 'all' \\]\\]; then` +
            `\\s+node scripts/release-deployment-state\\.mjs compatibility-recheck ` +
            `"\\$RELEASE_TARGET" "\\$GITHUB_SHA"\\s+fi` +
            `\\s+node scripts/release-deployment-state\\.mjs[^\\r\\n]*` +
            `\\s+preflight ${target} release-artifacts/recovery-checkpoint` +
            `\\s+node scripts/release-deployment-state\\.mjs attempt ${target}` +
            `\\s+set \\+e\\s+npm run --silent wrangler -- deploy`,
        ),
      );
      const preflightLine = workflowLines.findIndex(
        (line) => line.trim() === `preflight ${target} release-artifacts/recovery-checkpoint`,
      );
      expect(preflightLine, `${target} preflight command`).toBeGreaterThan(0);
      // Bash needs exactly one trailing backslash to continue the command.
      // Two backslashes pass a literal "\\" mode and terminate the line.
      expect(workflowLines[preflightLine - 1]?.trim()).toBe(
        'node scripts/release-deployment-state.mjs \\',
      );
    }
  });

  it('keeps Cloudflare deployment ownership messages canonical and below truncation', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    expect(workflow).toMatch(/^\s+RELEASE_MESSAGE: git:\$\{\{ github\.sha \}\}\s*$/mu);
    expect(workflow).toMatch(
      /^\s+RELEASE_ROLLBACK_MESSAGE: rollback:\$\{\{ github\.run_id \}\}:\$\{\{ github\.run_attempt \}\}\s*$/mu,
    );
    expect(CANONICAL_RELEASE_MESSAGE.length).toBe(44);
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
    expect(proRoom).toBeGreaterThan(-1);
    expect(remoteShare).toBeGreaterThan(proRoom);
    expect(signaling).toBeGreaterThan(remoteShare);
    expect(facade).toBeGreaterThan(signaling);
    expect(developerApi).toBeGreaterThan(facade);
    expect(app).toBeGreaterThan(developerApi);
    expect(workflow).toContain('- developer-api');
    expect(workflow).toContain("MXQR_DEVELOPER_API_SMOKE_ROOM: '000001'");
    expect(workflow).toContain(
      'MXQR_DEVELOPER_API_SMOKE_KEY: ${{ secrets.MXQR_DEVELOPER_API_SMOKE_KEY }}',
    );
    expect(workflow).toContain(
      'MXQR_EXPECTED_DEVELOPER_API_FACADE_VERSION: ${{ steps.developer_api_facade_deployment.outputs.version_id }}',
    );
    expect(workflow).toContain('id: developer_api_facade_deployment');
    expect(workflow).toContain('release-deployment-state.mjs version developer-api-facade');

    const deployAll = emergencyDeploymentPlan('all-workers', '1'.repeat(40)).flat().join(' ');
    const remoteConfig = deployAll.indexOf('cloudflare/wrangler.remote-share.toml');
    const proConfig = deployAll.indexOf('cloudflare/wrangler.pro-room.toml');
    const signalingConfig = deployAll.indexOf('cloudflare/wrangler.signaling.toml');
    const facadeConfig = deployAll.indexOf('cloudflare/wrangler.developer-api-facade.toml');
    const apiConfig = deployAll.indexOf('cloudflare/wrangler.developer-api.toml');
    const appConfig = deployAll.indexOf('cloudflare/wrangler.app.toml');

    expect(proConfig).toBeGreaterThan(-1);
    expect(remoteConfig).toBeGreaterThan(proConfig);
    expect(signalingConfig).toBeGreaterThan(remoteConfig);
    expect(facadeConfig).toBeGreaterThan(signalingConfig);
    expect(apiConfig).toBeGreaterThan(facadeConfig);
    expect(appConfig).toBeGreaterThan(apiConfig);
  });

  it('maps logical release targets to the exact Worker set they publish', () => {
    expect([...releaseTargetWorkers('app')]).toEqual(['app']);
    expect([...releaseTargetWorkers('developer-api')]).toEqual([
      'developer-api-facade',
      'developer-api',
    ]);
    expect([...releaseTargetWorkers('all')]).toEqual([
      'pro-room',
      'remote-share',
      'signaling',
      'developer-api-facade',
      'developer-api',
      'app',
    ]);
    expect(() => releaseTargetWorkers('unknown')).toThrow('Unknown release target');
  });

  it('maps every transitive local Worker import into the compatibility contract', () => {
    const entries: Record<string, string> = {
      'remote-share': 'cloudflare/remote-share-worker.js',
      signaling: 'cloudflare/signaling-worker.js',
      'pro-room': 'cloudflare/pro-room-worker.js',
      'developer-api-facade': 'cloudflare/developer-api-facade-worker.js',
      'developer-api': 'cloudflare/developer-api-worker.js',
      app: 'cloudflare/app-worker.js',
    };
    const collect = (entry: string, found = new Set<string>()): Set<string> => {
      const normalized = entry.replaceAll('\\', '/');
      if (found.has(normalized)) return found;
      found.add(normalized);
      const source = readFileSync(resolve(normalized), 'utf8');
      const imports = source.matchAll(/(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/gu);
      for (const match of imports) {
        const imported = relative(
          process.cwd(),
          resolve(dirname(resolve(normalized)), match[1]),
        ).replaceAll('\\', '/');
        collect(imported, found);
      }
      return found;
    };

    for (const [worker, entry] of Object.entries(entries)) {
      const mapped = runtimePathsForWorker(worker);
      for (const imported of collect(entry)) {
        const covered = mapped.some(
          (path) =>
            !path.startsWith(':(') && (path === imported || imported.startsWith(`${path}/`)),
        );
        expect(covered, `${worker}: ${imported}`).toBe(true);
      }
    }
  });

  it('treats the shared service-maintenance gate as one cross-Worker release contract', () => {
    const sharedGate = 'cloudflare/service-maintenance.js';

    expect(runtimePathsForWorker('app')).toContain(sharedGate);
    expect(runtimePathsForWorker('signaling')).toContain(sharedGate);
    expect(runtimePathsForWorker('pro-room')).toContain(sharedGate);
    expect(runtimePathsForWorker('remote-share')).toContain(sharedGate);
    expect(runtimePathsForWorker('developer-api-facade')).toContain(sharedGate);
    expect(runtimePathsForWorker('developer-api')).toContain(sharedGate);
  });

  it('tracks the extracted capability security runtime with the app Worker', () => {
    expect(runtimePathsForWorker('app')).toContain('cloudflare/capability-security.js');
  });

  it('tracks the Remote Share host assertion primitive with both importing Workers', () => {
    const assertionPrimitive = 'cloudflare/remote-share-upload-assertion.js';
    expect(runtimePathsForWorker('remote-share')).toContain(assertionPrimitive);
    expect(runtimePathsForWorker('signaling')).toContain(assertionPrimitive);
  });

  it('tracks R2 policies with every app/Worker consumer', () => {
    for (const policy of [
      'cloudflare/r2-cors.remote-share.json',
      'cloudflare/r2-lifecycle.remote-share.json',
    ]) {
      expect(runtimePathsForWorker('remote-share')).toContain(policy);
      expect(runtimePathsForWorker('app')).toContain(policy);
    }

    const proMediaCors = 'cloudflare/r2-cors.pro-media.json';
    expect(runtimePathsForWorker('pro-room')).toContain(proMediaCors);
    expect(runtimePathsForWorker('app')).toContain(proMediaCors);

    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const stepStart = workflow.indexOf('- name: Apply PRO media R2 CORS policy');
    const stepEnd = workflow.indexOf('\n      - name:', stepStart + 1);
    const step = workflow.slice(stepStart, stepEnd);
    expect(step).toContain("if: inputs.target == 'all' || inputs.target == 'pro-room'");
    expect(step).not.toContain("inputs.target == 'app'");
  });

  it('derives each Worker D1 dependency set from the immutable manifest', () => {
    const proPaths = runtimePathsForWorker('pro-room');
    expect(proPaths).toContain('cloudflare/admin-metrics.pro-room-generation.migration.sql');
    expect(proPaths).toContain('cloudflare/auth.pro-room-generation.migration.sql');
    expect(proPaths).toContain('cloudflare/developer-api-room-generation.migration.sql');
    expect(proPaths).not.toContain('cloudflare/d1-migrations.manifest.json');
    expect(proPaths).not.toContain('cloudflare/auth.account-stats.migration.sql');

    const developerPaths = runtimePathsForWorker('developer-api');
    expect(developerPaths).toContain('cloudflare/developer-api.launch-cleanup.migration.sql');
    expect(developerPaths).toContain('cloudflare/developer-api.effects-scopes.rollback.sql');

    const appPaths = runtimePathsForWorker('app');
    expect(appPaths).toContain('cloudflare/auth.launch-cleanup.migration.sql');
    expect(appPaths).toContain('cloudflare/developer-api.launch-cleanup.migration.sql');
  });

  it('extracts only an exact release Git SHA from deployment messages', () => {
    const sha = 'a'.repeat(40);
    expect(releaseGitSha(`git:${sha} run:123 target:all`)).toBe(sha);
    expect(releaseGitSha(`prefix git:${sha.toUpperCase()} suffix`)).toBe(sha);
    expect(releaseGitSha(`git:${'a'.repeat(39)} run:123`)).toBeNull();
    expect(releaseGitSha(`git:${sha}trailing`)).toBeNull();
    expect(releaseGitSha(null)).toBeNull();
  });

  it('preserves the restored release provenance in rollback deployment messages', () => {
    const restoredSha = 'a'.repeat(40);
    expect(
      rollbackDeploymentMessage(
        { beforeMessage: `git:${restoredSha} run:10 target:all` },
        `rollback:${'b'.repeat(40)} run:11`,
      ),
    ).toBe(`git:${restoredSha}`);
    expect(
      rollbackDeploymentMessage({ beforeMessage: 'legacy manual deploy' }, 'rollback:unknown'),
    ).toBe('rollback:unknown');
  });

  it('checks an ancestor diff through argument-safe Git calls', () => {
    const calls: string[][] = [];
    const changed = changedRuntimePaths('a'.repeat(40), 'b'.repeat(40), ['src', 'public'], {
      runner: (args: string[]) => {
        calls.push(args);
        return args[0] === 'diff' ? 'src/app.ts\npublic/service-worker.js\nsrc/app.ts\n' : '';
      },
    });
    expect(changed).toEqual(['public/service-worker.js', 'src/app.ts']);
    expect(calls).toEqual([
      ['merge-base', '--is-ancestor', 'a'.repeat(40), 'b'.repeat(40)],
      [
        'diff',
        '--name-only',
        '--diff-filter=ACDMRTUXB',
        `${'a'.repeat(40)}..${'b'.repeat(40)}`,
        '--',
        'src',
        'public',
      ],
    ]);
  });

  it('keeps test-only app files outside the partial-release runtime diff', () => {
    const calls: string[][] = [];
    changedRuntimePaths(
      'a'.repeat(40),
      'b'.repeat(40),
      [
        'src',
        ':(exclude)src/**/__tests__/**',
        ':(exclude)src/**/*.test.ts',
        ':(exclude)src/**/*.test.tsx',
      ],
      {
        runner: (args: string[]) => {
          calls.push(args);
          return '';
        },
      },
    );
    const diffCall = calls.find(([command]) => command === 'diff');
    expect(diffCall).toContain(':(exclude)src/**/__tests__/**');
    expect(diffCall).toContain(':(exclude)src/**/*.test.ts');
    expect(diffCall).toContain(':(exclude)src/**/*.test.tsx');
  });

  it('treats the remote-share contract marker as runtime for both sides', () => {
    const marker = 'cloudflare/remote-share-contract-version.txt';
    expect(runtimePathsForWorker('remote-share')).toContain(marker);
    expect(runtimePathsForWorker('app')).toContain(marker);
  });

  it('requires a full release when the app-to-service-control contract changes', () => {
    const marker = 'cloudflare/service-control-contract-version.txt';
    expect(runtimePathsForWorker('pro-room')).toContain(marker);
    expect(runtimePathsForWorker('app')).toContain(marker);

    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const stepStart = workflow.indexOf(
      '- name: Require a full release for service-control contract cutovers',
    );
    const stepEnd = workflow.indexOf('\n      - name:', stepStart + 1);
    const step = workflow.slice(stepStart, stepEnd);
    expect(stepStart).toBeGreaterThan(-1);
    expect(step).toContain("contract_marker='cloudflare/service-control-contract-version.txt'");
    expect(step).toContain("inputs.target }}\" != 'all'");

    const rollbackStepStart = workflow.indexOf(
      '- name: Restore release-owned Workers after a failed release',
    );
    const rollbackStepEnd = workflow.indexOf('\n      - name:', rollbackStepStart + 1);
    const rollbackStep = workflow.slice(rollbackStepStart, rollbackStepEnd);
    expect(readFileSync(SCRIPT_PATH, 'utf8')).toContain(
      'cloudflare/service-control-contract-version.txt',
    );
    expect(rollbackStep).toContain('service-control-forward-floor "$GITHUB_SHA"');
    expect(rollbackStep).not.toContain('git diff --quiet "${GITHUB_SHA}^"');
    expect(rollbackStep).toContain('node scripts/release-recovery-plan.mjs');
    expect(readFileSync(resolve('scripts/release-recovery-plan.mjs'), 'utf8')).toContain(
      "skip.add('pro-room')",
    );
  });

  it('keeps a multi-commit first service-control cutover on the forward-repair floor', () => {
    const repository = createDirectory();
    const deploymentDirectory = resolve(repository, 'deployments');
    mkdirSync(deploymentDirectory, { recursive: true });
    const git = (args: string[], options: { capture?: boolean } = {}): string =>
      execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'pipe',
      });
    git(['init', '--quiet']);
    git(['config', 'user.email', 'release-test@musixquare.invalid']);
    git(['config', 'user.name', 'MUSIXQUARE Release Test']);
    mkdirSync(resolve(repository, 'cloudflare'), { recursive: true });
    writeFileSync(resolve(repository, 'README.md'), 'before cutover\n');
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'pre-cutover']);
    const preCutoverSha = git(['rev-parse', 'HEAD'], { capture: true }).trim();

    writeFileSync(
      resolve(repository, 'cloudflare/service-control-contract-version.txt'),
      'admin-announcement-v1\n',
    );
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'add service-control cutover']);
    const cutoverSha = git(['rev-parse', 'HEAD'], { capture: true }).trim();
    writeFileSync(resolve(repository, 'README.md'), 'after cutover docs\n');
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'document cutover']);
    const releaseSha = git(['rev-parse', 'HEAD'], { capture: true }).trim();

    const statePath = resolve(deploymentDirectory, 'pro-room-state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        target: 'pro-room',
        config: 'cloudflare/wrangler.pro-room.toml',
        attempted: true,
        beforeVersionId: 'pro-room-before',
        beforeMessage: `git:${preCutoverSha}`,
        releaseMessage: `git:${releaseSha}`,
      }),
    );
    const changed = (baseSha: string, headSha: string, paths: string[]) =>
      changedRuntimePaths(baseSha, headSha, paths, { runner: git });
    expect(
      contractCutoverRequiresForwardRepair(
        releaseSha,
        'cloudflare/service-control-contract-version.txt',
        ['pro-room', 'app'],
        deploymentDirectory,
        {
          changedRuntimePaths: changed,
          queryCurrent: () => ({
            deploymentId: 'pro-room-candidate-deployment',
            versionId: 'pro-room-candidate-version',
            message: `git:${releaseSha}`,
          }),
        },
      ),
    ).toBe(true);

    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        target: 'pro-room',
        config: 'cloudflare/wrangler.pro-room.toml',
        attempted: true,
        beforeVersionId: 'pro-room-before',
        beforeMessage: `git:${cutoverSha}`,
        releaseMessage: `git:${releaseSha}`,
      }),
    );
    expect(
      contractCutoverRequiresForwardRepair(
        releaseSha,
        'cloudflare/service-control-contract-version.txt',
        ['pro-room', 'app'],
        deploymentDirectory,
        { changedRuntimePaths: changed },
      ),
    ).toBe(false);
  });

  it.each([
    ['service-control', 'cloudflare/service-control-contract-version.txt', ['pro-room', 'app']],
    ['remote-share', 'cloudflare/remote-share-contract-version.txt', ['remote-share', 'app']],
  ] as const)(
    'does not invent a %s candidate boundary before the first Worker deploy',
    (_label, markerPath, targets) => {
      const checkpoint = createDirectory();
      const beforeSha = 'b'.repeat(40);
      const releaseSha = 'c'.repeat(40);
      for (const target of targets) {
        writeFileSync(
          resolve(checkpoint, `${target}-state.json`),
          JSON.stringify({
            schemaVersion: 1,
            target,
            config: `cloudflare/wrangler.${target}.toml`,
            attempted: true,
            beforeVersionId: `${target}-before`,
            beforeMessage: `git:${beforeSha}`,
            releaseMessage: `git:${releaseSha}`,
          }),
        );
      }
      const changedRuntimePaths = () => [markerPath];
      const baselineQuery = (target: string) => ({
        deploymentId: `${target}-before-deployment`,
        versionId: `${target}-before`,
        message: `git:${beforeSha}`,
      });

      expect(
        contractCutoverRequiresForwardRepair(releaseSha, markerPath, [...targets], checkpoint, {
          changedRuntimePaths,
          queryCurrent: baselineQuery,
        }),
      ).toBe(false);

      expect(
        contractCutoverRequiresForwardRepair(releaseSha, markerPath, [...targets], checkpoint, {
          changedRuntimePaths,
          queryCurrent: (target: string) =>
            target === targets[0]
              ? {
                  deploymentId: `${target}-candidate-deployment`,
                  versionId: `${target}-candidate-version`,
                  message: `git:${releaseSha}`,
                }
              : baselineQuery(target),
        }),
      ).toBe(true);

      expect(
        contractCutoverRequiresForwardRepair(releaseSha, markerPath, [...targets], checkpoint, {
          changedRuntimePaths,
          queryCurrent: () => {
            throw new Error('Cloudflare identity unavailable');
          },
        }),
      ).toBe(true);

      expect(
        contractCutoverRequiresForwardRepair(releaseSha, markerPath, [...targets], checkpoint, {
          changedRuntimePaths,
          queryCurrent: baselineQuery,
          requireCheckpointInventory: true,
        }),
      ).toBe(true);

      const truncatedCheckpoint = createDirectory();
      writeFileSync(
        resolve(truncatedCheckpoint, 'recovery-checkpoint.json'),
        JSON.stringify({
          schemaVersion: 1,
          releaseTarget: 'all',
          status: 'captured',
          workers: [
            'pro-room',
            'remote-share',
            'signaling',
            'developer-api-facade',
            'developer-api',
            'app',
          ].map((target) => ({ target })),
        }),
      );
      const retainedTarget = targets[1];
      writeFileSync(
        resolve(truncatedCheckpoint, `${retainedTarget}-state.json`),
        JSON.stringify({
          schemaVersion: 1,
          target: retainedTarget,
          config: `cloudflare/wrangler.${retainedTarget}.toml`,
          attempted: true,
          beforeVersionId: `${retainedTarget}-before`,
          beforeMessage: `git:${beforeSha}`,
          releaseMessage: `git:${releaseSha}`,
        }),
      );
      expect(
        contractCutoverRequiresForwardRepair(
          releaseSha,
          markerPath,
          [...targets],
          truncatedCheckpoint,
          { changedRuntimePaths, queryCurrent: baselineQuery },
        ),
      ).toBe(true);
    },
  );

  it('treats deleted runtime files as compatibility-relevant changes', () => {
    const repository = createDirectory();
    const git = (args: string[], options: { capture?: boolean } = {}): string =>
      execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'pipe',
      });
    git(['init', '--quiet']);
    git(['config', 'user.email', 'release-test@musixquare.invalid']);
    git(['config', 'user.name', 'MUSIXQUARE Release Test']);
    mkdirSync(resolve(repository, 'src'), { recursive: true });
    writeFileSync(resolve(repository, 'src', 'deleted-runtime.ts'), 'export const live = true;\n');
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'base']);
    const baseSha = git(['rev-parse', 'HEAD'], { capture: true }).trim();
    rmSync(resolve(repository, 'src', 'deleted-runtime.ts'));
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'delete runtime']);
    const headSha = git(['rev-parse', 'HEAD'], { capture: true }).trim();

    expect(changedRuntimePaths(baseSha, headSha, ['src'], { runner: git })).toEqual([
      'src/deleted-runtime.ts',
    ]);
  });

  it('keeps test and release-tool dependency changes outside the app runtime diff', () => {
    const repository = createDirectory();
    const git = (args: string[], options: { capture?: boolean } = {}): string =>
      execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'pipe',
      });
    git(['init', '--quiet']);
    git(['config', 'user.email', 'release-test@musixquare.invalid']);
    git(['config', 'user.name', 'MUSIXQUARE Release Test']);
    mkdirSync(resolve(repository, 'src', '__tests__'), { recursive: true });
    writeFileSync(resolve(repository, 'src', 'app.ts'), 'export const value = 1;\n');
    writeFileSync(resolve(repository, 'src', '__tests__', 'app.test.ts'), 'test("one");\n');
    writeFileSync(resolve(repository, 'package.json'), '{"private":true}\n');
    writeFileSync(resolve(repository, 'package-lock.json'), '{"lockfileVersion":3}\n');
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'base']);
    const baseSha = git(['rev-parse', 'HEAD'], { capture: true }).trim();

    writeFileSync(resolve(repository, 'src', '__tests__', 'app.test.ts'), 'test("two");\n');
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'test only']);
    const testOnlySha = git(['rev-parse', 'HEAD'], { capture: true }).trim();
    const queryCurrent = (target: string) => ({
      deploymentId: `deployment-${target}`,
      versionId: `version-${target}`,
      message: `git:${baseSha} run:1 target:all`,
    });
    const diffWithRepository = (from: string, to: string, paths: string[]) =>
      changedRuntimePaths(from, to, paths, { runner: git });

    expect(
      verifyPartialReleaseCompatibility('signaling', testOnlySha, repository, {
        queryCurrent,
        changedRuntimePaths: diffWithRepository,
        gitRunner: git,
      }).status,
    ).toBe('compatible');

    writeFileSync(
      resolve(repository, 'package-lock.json'),
      '{"lockfileVersion":3,"changed":true}\n',
    );
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'dependency change']);
    const dependencySha = git(['rev-parse', 'HEAD'], { capture: true }).trim();
    expect(
      verifyPartialReleaseCompatibility('signaling', dependencySha, repository, {
        queryCurrent,
        changedRuntimePaths: diffWithRepository,
        gitRunner: git,
      }).status,
    ).toBe('compatible');
  });

  it('allows an app-only release when every unselected Worker is source-equivalent', () => {
    const directory = createDirectory();
    const deployedSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const queried: string[] = [];
    const diffed: string[] = [];
    const report = verifyPartialReleaseCompatibility('app', headSha, directory, {
      queryCurrent: (target: string) => {
        queried.push(target);
        return {
          deploymentId: `deployment-${target}`,
          versionId: `version-${target}`,
          message: `git:${deployedSha} run:1 target:all`,
        };
      },
      changedRuntimePaths: (
        _base: string,
        _head: string,
        _paths: string[],
        context: { target: string },
      ) => {
        diffed.push(context.target);
        return [];
      },
    });

    expect(report.status).toBe('compatible');
    expect(queried).not.toContain('app');
    expect(diffed).toEqual(queried);
    expect(report.results).toHaveLength(5);
  });

  it('rechecks every captured unselected deployment identity before a partial deploy', () => {
    const directory = createDirectory();
    const deployedSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const currentFor = (target: string) => ({
      deploymentId: `deployment-${target}`,
      versionId: `version-${target}`,
      message: `git:${deployedSha}`,
    });
    const captured = verifyPartialReleaseCompatibility('app', headSha, directory, {
      queryCurrent: currentFor,
      changedRuntimePaths: () => [],
    });
    expect(captured.results).toContainEqual(
      expect.objectContaining({
        target: 'pro-room',
        deployedDeploymentId: 'deployment-pro-room',
        deployedVersionId: 'version-pro-room',
      }),
    );

    const queried: string[] = [];
    const recheck = recheckPartialReleaseCompatibility('app', headSha, directory, {
      queryCurrent: (target: string) => {
        queried.push(target);
        return currentFor(target);
      },
    });
    expect(recheck.status).toBe('compatible');
    expect(queried).toHaveLength(5);
    expect(queried).not.toContain('app');
    expect(recheck.results).toContainEqual(
      expect.objectContaining({
        target: 'pro-room',
        expectedDeploymentId: 'deployment-pro-room',
        currentDeploymentId: 'deployment-pro-room',
        status: 'compatible',
      }),
    );
  });

  it('fails closed when an unselected Worker drifts after compatibility capture', () => {
    const directory = createDirectory();
    const deployedSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const currentFor = (target: string) => ({
      deploymentId: `deployment-${target}`,
      versionId: `version-${target}`,
      message: `git:${deployedSha}`,
    });
    verifyPartialReleaseCompatibility('app', headSha, directory, {
      queryCurrent: currentFor,
      changedRuntimePaths: () => [],
    });

    expect(() =>
      recheckPartialReleaseCompatibility('app', headSha, directory, {
        queryCurrent: (target: string) =>
          target === 'signaling'
            ? { ...currentFor(target), deploymentId: 'deployment-signaling-external' }
            : currentFor(target),
      }),
    ).toThrow('signaling production changed after partial-release compatibility was captured');

    const report = JSON.parse(
      readFileSync(resolve(directory, 'partial-release-compatibility-recheck.json'), 'utf8'),
    ) as { status: string; results: Array<{ target: string; status: string }> };
    expect(report.status).toBe('failed');
    expect(report.results).toContainEqual(
      expect.objectContaining({ target: 'signaling', status: 'failed' }),
    );
  });

  it('keeps full releases independent of a partial compatibility snapshot', () => {
    const directory = createDirectory();
    const recheck = recheckPartialReleaseCompatibility('all', 'not-needed', directory, {
      queryCurrent: () => {
        throw new Error('must not query');
      },
    });
    expect(recheck.status).toBe('not-required');
    expect(recheck.results).toEqual([]);
  });

  it('keeps app-owned account migration metadata from forcing a PRO deployment', () => {
    const directory = createDirectory();
    const deployedSha = 'a'.repeat(40);
    const changed = new Set([
      'cloudflare/d1-migrations.manifest.json',
      'cloudflare/auth.schema.sql',
      'cloudflare/auth.account-stats.migration.sql',
    ]);
    const report = verifyPartialReleaseCompatibility('app', 'b'.repeat(40), directory, {
      queryCurrent: (target: string) => ({
        deploymentId: `deployment-${target}`,
        versionId: `version-${target}`,
        message: `git:${deployedSha} run:1 target:all`,
      }),
      changedRuntimePaths: (_base: string, _head: string, paths: string[]) =>
        paths.filter((path) => changed.has(path)),
    });

    expect(report.status).toBe('compatible');
    expect(report.results).toContainEqual(
      expect.objectContaining({ target: 'pro-room', status: 'compatible' }),
    );
  });

  it('still blocks an app-only release when the auth PRO generation contract changed', () => {
    const directory = createDirectory();
    const deployedSha = 'a'.repeat(40);
    expect(() =>
      verifyPartialReleaseCompatibility('app', 'b'.repeat(40), directory, {
        queryCurrent: (target: string) => ({
          deploymentId: `deployment-${target}`,
          versionId: `version-${target}`,
          message: `git:${deployedSha} run:1 target:all`,
        }),
        changedRuntimePaths: (_base: string, _head: string, paths: string[]) =>
          paths.filter((path) => path === 'cloudflare/auth.pro-room-generation.migration.sql'),
      }),
    ).toThrow('pro-room has undeployed production-source changes');

    const report = JSON.parse(
      readFileSync(resolve(directory, 'partial-release-compatibility.json'), 'utf8'),
    ) as {
      results: Array<{ target: string; status: string }>;
    };
    expect(report.results).toContainEqual(
      expect.objectContaining({ target: 'pro-room', status: 'incompatible' }),
    );
  });

  it.each(['cloudflare/pro-room-grants.js', 'cloudflare/admin-metrics.pro-grants.migration.sql'])(
    'tracks %s as a shared PRO room runtime dependency',
    (changedPath) => {
      const directory = createDirectory();
      const deployedSha = 'a'.repeat(40);
      expect(() =>
        verifyPartialReleaseCompatibility('app', 'b'.repeat(40), directory, {
          queryCurrent: (target: string) => ({
            deploymentId: `deployment-${target}`,
            versionId: `version-${target}`,
            message: `git:${deployedSha} run:1 target:all`,
          }),
          changedRuntimePaths: (_base: string, _head: string, paths: string[]) =>
            paths.filter((path) => path === changedPath),
        }),
      ).toThrow('pro-room has undeployed production-source changes');
    },
  );

  it('blocks a partial release when another Worker has undeployed runtime changes', () => {
    const directory = createDirectory();
    const deployedSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    expect(() =>
      verifyPartialReleaseCompatibility('app', headSha, directory, {
        queryCurrent: (target: string) => ({
          deploymentId: `deployment-${target}`,
          versionId: `version-${target}`,
          message: `git:${deployedSha} run:1 target:all`,
        }),
        changedRuntimePaths: (
          _base: string,
          _head: string,
          _paths: string[],
          context: { target: string },
        ) => (context.target === 'signaling' ? ['cloudflare/signaling-worker.js'] : []),
      }),
    ).toThrow('signaling has undeployed production-source changes');

    const report = JSON.parse(
      readFileSync(resolve(directory, 'partial-release-compatibility.json'), 'utf8'),
    ) as { status: string; results: Array<{ target: string; status: string }> };
    expect(report.status).toBe('failed');
    expect(report.results).toContainEqual(
      expect.objectContaining({ target: 'signaling', status: 'incompatible' }),
    );
  });

  it('tracks app runtime sources without treating repository tooling as a Worker contract', () => {
    const directory = createDirectory();
    const report = verifyPartialReleaseCompatibility('signaling', 'b'.repeat(40), directory, {
      queryCurrent: (target: string) => ({
        deploymentId: `deployment-${target}`,
        versionId: `version-${target}`,
        message: `git:${'a'.repeat(40)} run:1 target:all`,
      }),
      changedRuntimePaths: (
        _base: string,
        _head: string,
        paths: string[],
        context: { target: string; kind?: string },
      ) => {
        if (context.target !== 'app') return [];
        if (context.kind === 'dependency-manifest') return [];
        expect(paths).toContain('src');
        expect(paths).toContain('css');
        expect(paths).toContain('.workshop/privacy');
        expect(paths).toContain('cloudflare/app-static-assets/_headers');
        expect(paths).toContain('scripts/materialize-app-static-headers.mjs');
        expect(paths).not.toContain('package.json');
        expect(paths).not.toContain('package-lock.json');
        return [];
      },
    });
    expect(report.status).toBe('compatible');
  });

  it('blocks an unselected app when its production dependency resolution changed', () => {
    const repository = createDirectory();
    const git = (args: string[], options: { capture?: boolean } = {}): string =>
      execFileSync('git', ['-C', repository, ...args], {
        encoding: 'utf8',
        stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'pipe',
      });
    const packageState = (version: string) => ({
      packageJson: JSON.stringify({ dependencies: { peerjs: '^1.0.0' } }),
      packageLock: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { peerjs: '^1.0.0' } },
          'node_modules/peerjs': {
            version,
            resolved: `https://registry.example/peerjs-${version}.tgz`,
            integrity: `sha512-${version}`,
          },
          'node_modules/test-only': { version: '1.0.0', dev: true },
        },
      }),
    });
    git(['init', '--quiet']);
    git(['config', 'user.email', 'release-test@musixquare.invalid']);
    git(['config', 'user.name', 'MUSIXQUARE Release Test']);
    const before = packageState('1.0.0');
    writeFileSync(resolve(repository, 'package.json'), before.packageJson);
    writeFileSync(resolve(repository, 'package-lock.json'), before.packageLock);
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'base']);
    const baseSha = git(['rev-parse', 'HEAD'], { capture: true }).trim();
    const after = packageState('1.1.0');
    writeFileSync(resolve(repository, 'package-lock.json'), after.packageLock);
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'runtime dependency update']);
    const headSha = git(['rev-parse', 'HEAD'], { capture: true }).trim();
    const queryCurrent = (target: string) => ({
      deploymentId: `deployment-${target}`,
      versionId: `version-${target}`,
      message: `git:${baseSha}`,
    });
    const diffWithRepository = (from: string, to: string, paths: string[]) =>
      changedRuntimePaths(from, to, paths, { runner: git });

    expect(changedAppRuntimeDependencies(baseSha, headSha, { runner: git })).toEqual([
      'package.json#dependencies',
      'package-lock.json#production-resolution',
    ]);
    expect(() =>
      verifyPartialReleaseCompatibility('signaling', headSha, repository, {
        queryCurrent,
        changedRuntimePaths: diffWithRepository,
        gitRunner: git,
      }),
    ).toThrow('app has undeployed production-source changes');
  });

  it('invokes npm through its JavaScript CLI on Windows', () => {
    expect(
      npmInvocation('win32', {
        nodeExecutable: 'C:/Node/node.exe',
        environment: {},
        fileExists: (path: string) => path.replaceAll('\\', '/').endsWith('/npm-cli.js'),
      }),
    ).toEqual({
      executable: 'C:/Node/node.exe',
      prefixArgs: ['C:\\Node\\node_modules\\npm\\bin\\npm-cli.js'],
    });
    expect(npmInvocation('linux')).toEqual({ executable: 'npm', prefixArgs: [] });
  });

  it('treats both Developer API Workers as selected and fails closed without release provenance', () => {
    const directory = createDirectory();
    const queried: string[] = [];
    expect(() =>
      verifyPartialReleaseCompatibility('developer-api', 'b'.repeat(40), directory, {
        queryCurrent: (target: string) => {
          queried.push(target);
          return {
            deploymentId: `deployment-${target}`,
            versionId: `version-${target}`,
            message: target === 'remote-share' ? 'manual release' : `git:${'a'.repeat(40)}`,
          };
        },
        changedRuntimePaths: () => [],
      }),
    ).toThrow('does not record a git:<40-char-sha>');
    expect(queried).not.toContain('developer-api-facade');
    expect(queried).not.toContain('developer-api');
  });

  it('does not query production compatibility state for a full release', () => {
    const directory = createDirectory();
    const report = verifyPartialReleaseCompatibility('all', 'not-needed', directory, {
      queryCurrent: () => {
        throw new Error('must not query');
      },
    });
    expect(report.status).toBe('not-required');
    expect(report.results).toEqual([]);
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
      RELEASE_MESSAGE: CANONICAL_RELEASE_MESSAGE,
    });
    expect(prepare.status, String(prepare.stderr)).toBe(0);
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
        runScript(['prepare', 'signaling', directory], {
          RELEASE_MESSAGE: CANONICAL_RELEASE_MESSAGE,
        }).status,
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
      runScript(['prepare', 'app', directory], { RELEASE_MESSAGE: CANONICAL_RELEASE_MESSAGE })
        .status,
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

  it('captures every selected Worker baseline before any production mutation', () => {
    const directory = createDirectory();
    const queried: string[] = [];
    const report = captureDeploymentCheckpoint(
      'developer-api',
      CANONICAL_RELEASE_MESSAGE,
      directory,
      {
        queryCurrent: (target: string) => {
          queried.push(target);
          return {
            deployment: deployment(`${target}-before`),
            deploymentId: `deployment-${target}-before`,
            versionId: `${target}-before`,
            message: `git:${'b'.repeat(40)}`,
          };
        },
      },
    );

    expect(queried).toEqual(['developer-api-facade', 'developer-api']);
    expect(report).toMatchObject({ releaseTarget: 'developer-api', status: 'captured' });
    for (const target of queried) {
      expect(
        JSON.parse(readFileSync(resolve(directory, `${target}-state.json`), 'utf8')),
      ).toMatchObject({
        target,
        attempted: true,
        beforeVersionId: `${target}-before`,
        releaseMessage: CANONICAL_RELEASE_MESSAGE,
      });
    }
  });

  it('fails emergency code-only deployment on tracked external-state drift', () => {
    const directory = createDirectory();
    writeFileSync(
      resolve(directory, 'app-state.json'),
      JSON.stringify({
        schemaVersion: 1,
        target: 'app',
        config: 'cloudflare/wrangler.app.toml',
        attempted: true,
        beforeVersionId: 'before',
        beforeMessage: `git:${'b'.repeat(40)}`,
        releaseMessage: `git:${'c'.repeat(40)}`,
      }),
    );
    const changed = vi.fn(() => ['cloudflare/r2-cors.remote-share.json']);

    expect(() =>
      verifyEmergencyCodeOnly('c'.repeat(40), directory, { changedRuntimePaths: changed }),
    ).toThrow('Emergency deployment is code-only');
    expect(changed).toHaveBeenCalledWith(
      'b'.repeat(40),
      'c'.repeat(40),
      EMERGENCY_EXTERNAL_STATE_PATHS,
      expect.any(Object),
    );
    expect(
      JSON.parse(readFileSync(resolve(directory, 'emergency-code-only.json'), 'utf8')),
    ).toMatchObject({ status: 'failed' });
  });

  it('rejects a noncanonical ownership message before any deploy attempt', () => {
    const directory = createDirectory();
    writeFileSync(resolve(directory, 'app-before.json'), JSON.stringify(deployment('before')));

    for (const message of [
      `${CANONICAL_RELEASE_MESSAGE} run:123`,
      `git:${'A'.repeat(40)}`,
      'release-message',
    ]) {
      const result = runScript(['prepare', 'app', directory], { RELEASE_MESSAGE: message });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('must be exactly git:<40-char-lowercase-sha>');
    }
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

  it('creates the deployment artifact directory for standalone compatibility queries', () => {
    const directory = resolve(createDirectory(), 'not-created-yet', 'nested');
    const outputPath = resolve(directory, 'current.json');
    const current = queryCurrent('app', 'wrangler.toml', outputPath, {
      runner: () => JSON.stringify(deployment('current')),
      retry: { maxAttempts: 1 },
    });

    expect(current.versionId).toBe('current');
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(deployment('current'));
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

  it('issues rollback only after two exact identity reads under the release writer lease', () => {
    const directory = createDirectory();
    let queries = 0;
    const runner = vi.fn();
    const state = {
      target: 'app',
      beforeVersionId: 'before',
      afterVersionId: 'after',
      afterDeploymentId: 'deployment-after',
      releaseMessage: CANONICAL_RELEASE_MESSAGE,
      ownedByRelease: true,
      config: 'wrangler.toml',
    };

    const result = runRollbackWithRetry(state, 'rollback-message', {
      outputPath: resolve(directory, 'rollback-current.json'),
      queryCurrent: () => {
        queries += 1;
        return {
          versionId: 'after',
          deploymentId: 'deployment-after',
          message: CANONICAL_RELEASE_MESSAGE,
        };
      },
      runner,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 5,
        maxDelayMs: 10,
        sleep: () => undefined,
        onRetry: () => undefined,
      },
    });

    expect(result.status).toBe('command-issued');
    expect(queries).toBe(2);
    expect(result.commandIssued).toBe(true);
    expect(runner).toHaveBeenCalledWith([
      'rollback',
      'before',
      '--config',
      'wrangler.toml',
      '--message',
      'rollback-message',
      '--yes',
    ]);
  });

  it('does not issue another rollback when an external deploy appears between attempts', () => {
    const directory = createDirectory();
    let queries = 0;
    const runner = vi.fn();
    const state = {
      target: 'signaling',
      beforeVersionId: 'before',
      afterVersionId: 'after',
      afterDeploymentId: 'deployment-after',
      releaseMessage: CANONICAL_RELEASE_MESSAGE,
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
          message: queries === 1 ? CANONICAL_RELEASE_MESSAGE : 'manual-deploy',
        };
      },
      runner,
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
    expect(result.commandIssued).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('does not issue rollback when the first ownership read already sees external drift', () => {
    const directory = createDirectory();
    const runner = vi.fn();
    const state = {
      target: 'app',
      beforeVersionId: 'before',
      afterVersionId: 'after',
      afterDeploymentId: 'deployment-after',
      releaseMessage: CANONICAL_RELEASE_MESSAGE,
      ownedByRelease: true,
      config: 'wrangler.toml',
    };

    const result = runRollbackWithRetry(state, 'rollback-message', {
      outputPath: resolve(directory, 'rollback-current.json'),
      queryCurrent: () => ({
        versionId: 'external',
        deploymentId: 'deployment-external',
        message: 'manual-deploy',
      }),
      runner,
      retry: {
        maxAttempts: 1,
        baseDelayMs: 5,
        maxDelayMs: 10,
        sleep: () => undefined,
        onRetry: () => undefined,
      },
    });

    expect(result.status).toBe('conflict');
    expect(result.commandIssued).toBe(false);
    expect(runner).not.toHaveBeenCalled();
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
        runScript(['prepare', 'app', directory], { RELEASE_MESSAGE: CANONICAL_RELEASE_MESSAGE })
          .status,
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
      releaseMessage: CANONICAL_RELEASE_MESSAGE,
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
        { versionId: 'unrecorded-after', message: CANONICAL_RELEASE_MESSAGE },
      ),
    ).toBe('rollback');
    expect(rollbackDisposition(state, { versionId: 'newer', message: 'another-release' })).toBe(
      'conflict',
    );
    expect(
      rollbackDisposition(
        { beforeVersionId: 'before', releaseMessage: null },
        { versionId: 'candidate', message: null },
      ),
    ).toBe('conflict');
    expect(
      rollbackDisposition(
        { beforeVersionId: 'before', releaseMessage: 'git:not-a-sha' },
        { versionId: 'before', message: 'git:not-a-sha' },
      ),
    ).toBe('conflict');
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
        JSON.stringify({
          schemaVersion: 1,
          target,
          config: `cloudflare/wrangler.${target}.toml`,
          attempted: true,
          beforeVersionId: `${target}-before`,
          releaseMessage: CANONICAL_RELEASE_MESSAGE,
        }),
      );
    }

    expect(attemptedStates(directory).map((state: { target: string }) => state.target)).toEqual([
      'app',
      'developer-api',
      'developer-api-facade',
      'signaling',
      'remote-share',
      'pro-room',
    ]);
  });

  it('restores signaling only after the App baseline is known to be restored', () => {
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
      rollbackDependencyBlock('signaling', states, [
        { target: 'app', status: 'skipped-compatibility-floor' },
      ]),
    ).toEqual({ dependency: 'app', dependencyStatus: 'skipped-compatibility-floor' });
    expect(
      rollbackDependencyBlock('signaling', states, [{ target: 'app', status: 'already-restored' }]),
    ).toBeNull();
    expect(
      rollbackDependencyBlock('signaling', states, [{ target: 'app', status: 'restored' }]),
    ).toBeNull();
    expect(rollbackDependencyBlock('signaling', [{ target: 'signaling' }], [])).toBeNull();
  });

  it('restores remote-share only after the App baseline is known to be restored', () => {
    const states = [{ target: 'app' }, { target: 'remote-share' }];

    expect(rollbackDependencyBlock('remote-share', states, [])).toEqual({
      dependency: 'app',
      dependencyStatus: 'not-processed',
    });
    for (const status of [
      'conflict',
      'failed',
      'skipped-compatibility-floor',
      'skipped-dependent-worker-not-restored',
    ]) {
      expect(rollbackDependencyBlock('remote-share', states, [{ target: 'app', status }])).toEqual({
        dependency: 'app',
        dependencyStatus: status,
      });
    }
    expect(
      rollbackDependencyBlock('remote-share', states, [
        { target: 'app', status: 'already-restored' },
      ]),
    ).toBeNull();
    expect(
      rollbackDependencyBlock('remote-share', states, [{ target: 'app', status: 'restored' }]),
    ).toBeNull();
    expect(rollbackDependencyBlock('remote-share', [{ target: 'remote-share' }], [])).toBeNull();
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
          beforeVersionId: `${target}-before`,
          releaseMessage: CANONICAL_RELEASE_MESSAGE,
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
          message: CANONICAL_RELEASE_MESSAGE,
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
        beforeVersionId: 'before',
        releaseMessage: CANONICAL_RELEASE_MESSAGE,
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
    const recoveryPlan = readFileSync(resolve('scripts/release-recovery-plan.mjs'), 'utf8');
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

    const liveSmokeSteps = workflow
      .split(/(?=^ {6}- name: )/gmu)
      .filter((step) => step.includes('npm run smoke:live:'));
    expect(liveSmokeSteps).toHaveLength(9);
    for (const step of liveSmokeSteps) {
      expect(step).not.toMatch(/CLOUDFLARE_(?:D1_)?API_TOKEN/u);
    }

    const lastSmoke = workflow.indexOf('Smoke current PRO public boundary after app deployment');
    const finalVerification = workflow.indexOf(
      'Verify release still owns current production deployments',
    );
    const generationFence = workflow.indexOf(
      'Disable PRO room generation cutover before failed-release rollback',
    );
    const workerFloorAssessment = workflow.indexOf(
      'Assess captured Worker compatibility floors before failed-release rollback',
    );
    const workerRollback = workflow.indexOf('Restore release-owned Workers after a failed release');
    expect(finalVerification).toBeGreaterThan(lastSmoke);
    expect(generationFence).toBeGreaterThan(finalVerification);
    expect(workerFloorAssessment).toBeGreaterThan(generationFence);
    expect(workerRollback).toBeGreaterThan(workerFloorAssessment);
    expect(workflow).toContain("steps.final_verification.outcome || 'not-run'");

    const generationFenceStep = workflow.slice(generationFence, workerRollback);
    const workerStepEnd = workflow.indexOf('\n      - name:', workerRollback + 1);
    const workerStep = workflow.slice(workerRollback, workerStepEnd);
    expect(generationFenceStep).toContain(
      'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_D1_API_TOKEN }}',
    );
    expect(generationFenceStep).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(generationFenceStep).toContain('system:entitlement-backfill');
    expect(generationFenceStep).toContain('entitlement.backfill');
    expect(generationFenceStep).toContain('release-worker-floor-state.mjs');
    expect(generationFenceStep).toContain('entitlement_floor');
    expect(workerStep).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(workerStep).not.toContain('secrets.CLOUDFLARE_D1_API_TOKEN');
    expect(workerStep).toContain('inputs.apply_developer_api_d1');
    expect(workerStep).toContain('steps.worker_floor_assessment.outputs.forward_targets');
    expect(workerStep).toContain('node scripts/release-recovery-plan.mjs');
    expect(workerStep).toContain('MXQR_R2_FORWARD_TARGETS=');
    expect(workerStep).toContain('MXQR_GENERATION_FENCE_OUTCOME=');
    expect(workerStep).toContain('MXQR_WORKER_FLOOR_TARGETS=');
    expect(recoveryPlan).toContain("skip.add('developer-api-facade')");
    expect(recoveryPlan).toContain("skip.add('pro-room')");
    expect(recoveryPlan).toContain("skip.add('remote-share')");
    const skippedTargetsOutput = workerStep.indexOf(
      'echo "skipped_targets=${rollback_skip_targets}" >> "$GITHUB_OUTPUT"',
    );
    const rollbackCommand = workerStep.indexOf('rollback release-artifacts/recovery-checkpoint');
    expect(skippedTargetsOutput).toBeGreaterThan(-1);
    expect(rollbackCommand).toBeGreaterThan(skippedTargetsOutput);
  });

  it('applies the admin suspension-reason migration idempotently before the matched rollout', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const migrationStep = workflow.indexOf('Apply and verify PRO suspension-reason D1 contract');
    const nextStep = workflow.indexOf('\n      - name:', migrationStep + 1);
    const step = workflow.slice(migrationStep, nextStep);
    const proDeploy = workflow.indexOf('Deploy and record PRO room Worker');
    const appDeploy = workflow.indexOf('Deploy and record app Worker with immutable dist');

    expect(migrationStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeLessThan(proDeploy);
    expect(migrationStep).toBeLessThan(appDeploy);
    expect(step).toContain("if: inputs.target == 'all'");
    expect(step).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_D1_API_TOKEN }}');
    expect(step).toContain("pragma_table_info('mxqr_pro_room_registry')");
    expect(step).toContain('admin-metrics.suspension-reason.migration.sql');
    expect(step).toContain('if [[ "$column_count" == \'0\' ]]');
    expect(step).toContain('elif [[ "$column_count" == \'1\' ]]');
    expect(step).toContain('DROP TRIGGER IF EXISTS mxqr_pro_room_registry_suspension_reason');
    expect(step).toContain('null_guard_count');
    expect(step).toContain('invalid_suspended_count');
    expect(step).toContain('invalid_active_count');
    expect(step).toContain('capture-wrangler-d1-json.mjs');
  });

  it('applies and verifies the lifetime room-count contract before app-serving rollouts', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const migrationStep = workflow.indexOf('Apply and verify lifetime room-count D1 contract');
    const nextStep = workflow.indexOf('\n      - name:', migrationStep + 1);
    const step = workflow.slice(migrationStep, nextStep);

    expect(migrationStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeGreaterThan(
      workflow.indexOf('Fence room-code reuse during dependency rollout'),
    );
    expect(migrationStep).toBeLessThan(workflow.indexOf('Deploy and record signaling Worker'));
    expect(migrationStep).toBeLessThan(
      workflow.indexOf('Deploy and record app Worker with immutable dist'),
    );
    expect(step).toContain("if: inputs.target == 'all' || inputs.target == 'app'");
    expect(step).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_D1_API_TOKEN }}');
    expect(step).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(step).toContain('admin-metrics.lifetime-room-count.migration.sql');
    expect(step).toContain('mxqr_lifetime_metric_totals');
    expect(step).toContain('mxqr_lifetime_room_opened_insert');
    expect(step).toContain('mxqr_lifetime_room_opened_increment');
    expect(step).toContain('insert_guard_count');
    expect(step).toContain('increment_guard_count');
    expect(step).toContain('rooms_opened');
    expect(step).toContain('retained_rooms_opened');
    expect(step).toContain('capture-wrangler-d1-json.mjs');
  });

  it('installs and verifies the secret-free generic PRO grant ledger before app rollouts', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const migrationStep = workflow.indexOf('Apply and verify generic PRO grant D1 contract');
    const nextStep = workflow.indexOf('\n      - name:', migrationStep + 1);
    const step = workflow.slice(migrationStep, nextStep);

    expect(migrationStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeLessThan(
      workflow.indexOf('Deploy and record app Worker with immutable dist'),
    );
    expect(step).toContain(
      "if: inputs.target == 'all' || inputs.target == 'app' || inputs.target == 'pro-room'",
    );
    expect(step).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_D1_API_TOKEN }}');
    expect(step).toContain('admin-metrics.pro-grants.migration.sql');
    expect(step).toContain('mxqr_pro_grant_campaigns');
    expect(step).toContain('mxqr_pro_grant_vouchers');
    expect(step).toContain('mxqr_pro_grant_account_fences');
    expect(step).toContain('mxqr_pro_grants');
    expect(step).toContain('mxqr_pro_grant_allocations');
    expect(step).toContain('mxqr_pro_grant_audit');
    expect(step).toContain('mxqr_pro_account_entitlements');
    expect(step).toContain('forbidden_secret_column_count');
    expect(step).toContain('idx_mxqr_pro_grants_one_current_pro_per_account');
    expect(step).toContain('mxqr_pro_grant_voucher_registry_guard');
    expect(step).toContain('idx_mxqr_pro_account_entitlements_one_current_account');
    expect(step).toContain('idx_mxqr_pro_account_entitlements_one_reserved_room');
    expect(step).toContain('mxqr_pro_account_entitlements_material_immutable');
    expect(step).toContain('entitlement_account_index_count');
    expect(step).toContain('entitlement_room_index_count');
    expect(step).toContain('account_fence_table_count');
    expect(step).toContain('(.table_count | tonumber) == 9');
    expect(step).toContain('(.index_count | tonumber) == 11');
    expect(step).toContain('(.trigger_count | tonumber) == 14');
    expect(step).toContain('capture-wrangler-d1-json.mjs');
  });

  it('installs the secret-free owner-transfer journal before the matched Worker rollout', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const migrationStep = workflow.indexOf('Apply and verify owner-transfer saga D1 contract');
    const nextStep = workflow.indexOf('\n      - name:', migrationStep + 1);
    const step = workflow.slice(migrationStep, nextStep);
    expect(migrationStep).toBeGreaterThan(-1);
    expect(migrationStep).toBeLessThan(workflow.indexOf('Deploy and record PRO room Worker'));
    expect(migrationStep).toBeLessThan(
      workflow.indexOf('Deploy and record app Worker with immutable dist'),
    );
    expect(step).toContain('admin-metrics.owner-transfer-saga.migration.sql');
    expect(step).toContain('mxqr_pro_room_owner_transfer_sagas');
    expect(step).toContain('mxqr_pro_room_owner_transfer_issuances');
    expect(step).toContain('trg_mxqr_pro_room_owner_transfer_issuance_expiry_audit');
    expect(step).toContain('trg_mxqr_pro_room_owner_transfer_saga_expiry_audit');
    expect(step).toContain('trigger_count');
    expect(step).toContain('secret_column_count');
    expect(step).toContain("if: inputs.target == 'all'");
  });

  it('migrates and verifies the Developer authority fence before every authority-aware deploy', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const migrationStep = workflow.indexOf(
      'Apply and verify Developer API authority-fence D1 contract',
    );
    const nextStep = workflow.indexOf('\n      - name:', migrationStep + 1);
    const step = workflow.slice(migrationStep, nextStep);
    expect(migrationStep).toBeGreaterThan(-1);
    for (const deploy of [
      'Deploy and record PRO room Worker',
      'Deploy and record Developer API facade Worker',
      'Deploy and record Developer API Worker',
      'Deploy and record app Worker with immutable dist',
    ]) {
      expect(migrationStep).toBeLessThan(workflow.indexOf(deploy));
    }
    expect(step).toContain('developer-api.authority-fence.migration.sql');
    expect(step).toContain('mxqr_developer_api_room_authority_fences');
    expect(step).toContain('trg_mxqr_developer_api_keys_authority_fenced_insert');
    expect(step).toContain('trg_mxqr_developer_api_keys_authority_fenced_update');
    expect(step).toContain('authority-fence-repair.sql');
    expect(step).toContain('invalid_fence_count');
    expect(step).toContain('apply_developer_api_d1');
  });

  it('migrates and verifies Developer authority epoch before PRO, facade, API and App deploys', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const migrationStep = workflow.indexOf(
      'Apply and verify Developer API authority-epoch D1 contract',
    );
    const nextStep = workflow.indexOf('\n      - name:', migrationStep + 1);
    const step = workflow.slice(migrationStep, nextStep);
    expect(migrationStep).toBeGreaterThan(-1);
    for (const deploy of [
      'Deploy and record PRO room Worker',
      'Deploy and record Developer API facade Worker',
      'Deploy and record Developer API Worker',
      'Deploy and record app Worker with immutable dist',
    ]) {
      expect(migrationStep).toBeLessThan(workflow.indexOf(deploy));
    }
    expect(step).toContain('developer-api.authority-epoch.migration.sql');
    expect(step).toContain("pragma_table_info('mxqr_developer_api_keys')");
    expect(step).toContain('authority_epoch');
    expect(step).toContain('trg_mxqr_developer_api_keys_authority_epoch_immutable');
    expect(step).toContain('invalid_epoch_count');
    expect(step).toContain('apply_developer_api_d1');
  });

  it('runs documented storage and playback static invariants once in main CI', () => {
    const ciWorkflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    const releaseWorkflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    expect(ciWorkflow).toContain('npm run guard:chunk-pump');
    expect(ciWorkflow).toContain('npm run guard:lifecycle-writes');
    expect(ciWorkflow).toContain('run: npm run format:check');
    expect(releaseWorkflow).not.toContain('npm run guard:chunk-pump');
    expect(releaseWorkflow).not.toContain('npm run guard:lifecycle-writes');
    expect(releaseWorkflow).not.toContain('run: npm run format:check');
  });

  it('uses CI critical browser coverage while keeping the production release browser-free', () => {
    const ciWorkflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const coverage = ciWorkflow.indexOf('run: npm run test:coverage:critical');
    const compatibility = workflow.indexOf('Verify partial release dependency compatibility');
    const generationFloor = workflow.indexOf(
      'Read PRO room generation cutover before dependency rollout',
    );
    const firstDeploy = workflow.indexOf('Deploy and record remote-share Worker');
    expect(coverage).toBeGreaterThan(-1);
    expect(ciWorkflow).toContain('run: npm run test:e2e:critical');
    expect(compatibility).toBeGreaterThan(-1);
    expect(compatibility).toBeLessThan(generationFloor);
    expect(compatibility).toBeLessThan(firstDeploy);
    expect(workflow).not.toContain('playwright install');
    expect(workflow).not.toContain('test:e2e');
    expect(workflow).not.toContain('smoke:live:app-session');
    expect(workflow).toContain('run: npm run smoke:live:app-generation');
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['pretest:e2e:critical']).toBe('npm run build:e2e');
    expect(packageJson.scripts['test:e2e:critical']).toBe(
      'playwright test e2e/critical-browser.test.ts e2e/release-smoke.test.ts e2e/remote-upload-browser.test.ts --project=chromium --reporter=line',
    );
    expect(packageJson.scripts['smoke:live:app-generation']).toBe(
      'node scripts/live-app-generation-smoke.mjs',
    );
    const appGenerationSmoke = readFileSync(
      resolve('scripts/live-app-generation-smoke.mjs'),
      'utf8',
    );
    expect(appGenerationSmoke).not.toMatch(/playwright|chromium/iu);
    const smokeSourceFile = ts.createSourceFile(
      'live-app-generation-smoke.mjs',
      appGenerationSmoke,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const runtimeImports: string[] = [];
    let hasDynamicImport = false;
    const visitImport = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        runtimeImports.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        hasDynamicImport = true;
      }
      ts.forEachChild(node, visitImport);
    };
    visitImport(smokeSourceFile);
    expect(hasDynamicImport).toBe(false);
    expect(runtimeImports.sort()).toEqual([
      'jsdom',
      'node:crypto',
      'node:fs/promises',
      'node:path',
      'node:url',
      'typescript',
    ]);
    expect(packageJson.scripts['smoke:live']).not.toContain('app-session');
    expect(packageJson.scripts['smoke:live']).not.toContain('test:e2e');
    const nextStep = workflow.indexOf('\n      - name:', compatibility + 1);
    const step = workflow.slice(compatibility, nextStep);
    expect(step).toContain("if: inputs.target != 'all'");
    expect(step).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(step).toContain(
      'node scripts/release-deployment-state.mjs compatibility "$RELEASE_TARGET" "${{ github.sha }}"',
    );
  });

  it('rechecks captured unselected deployments immediately before every selected Worker attempt', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const deployments = [
      ['Deploy and record PRO room Worker', 'pro-room'],
      ['Deploy and record remote-share Worker', 'remote-share'],
      ['Deploy and record signaling Worker', 'signaling'],
      ['Deploy and record Developer API facade Worker', 'developer-api-facade'],
      ['Deploy and record Developer API Worker', 'developer-api'],
      ['Deploy and record app Worker with immutable dist', 'app'],
    ] as const;
    const recheckCommand =
      'node scripts/release-deployment-state.mjs compatibility-recheck "$RELEASE_TARGET" "$GITHUB_SHA"';

    for (const [stepName, target] of deployments) {
      const start = workflow.indexOf(`- name: ${stepName}`);
      const end = workflow.indexOf('\n      - name:', start + 1);
      const step = workflow.slice(start, end);
      const preflight = step.indexOf(`preflight ${target}`);
      const recheck = step.indexOf(recheckCommand);
      const attempt = step.indexOf(`attempt ${target}`);
      const deploy = step.indexOf('wrangler -- deploy');
      expect(start, stepName).toBeGreaterThan(-1);
      expect(step, stepName).toContain(`if [[ "$RELEASE_TARGET" != 'all' ]]`);
      expect(preflight, stepName).toBeGreaterThan(-1);
      expect(recheck, stepName).toBeGreaterThan(-1);
      expect(preflight, stepName).toBeGreaterThan(recheck);
      expect(attempt, stepName).toBeGreaterThan(preflight);
      expect(deploy, stepName).toBeGreaterThan(attempt);
    }
    expect(workflow.match(/compatibility-recheck "\$RELEASE_TARGET" "\$GITHUB_SHA"/g)).toHaveLength(
      deployments.length,
    );
  });

  it('reuses the successful exact-SHA main CI artifact for every release target', () => {
    const ciWorkflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const evidenceTool = readFileSync(resolve('scripts/release-evidence.mjs'), 'utf8');
    const ciBuild = ciWorkflow.indexOf('Build and verify production bundle');
    const ciArtifact = ciWorkflow.indexOf('Upload immutable main-CI production candidate');
    expect(ciArtifact).toBeGreaterThan(ciBuild);
    expect(ciWorkflow).toContain('RELEASE_VALIDATION_PROFILE: main-ci');
    expect(ciWorkflow).toContain('RELEASE_TARGET: all');
    expect(ciWorkflow).toContain(
      'production-candidate-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
    );

    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('Select exact-SHA validated candidate');
    expect(workflow).toContain('node scripts/release-evidence.mjs wait-candidate');
    expect(evidenceTool).toContain("workflow: 'ci.yml'");
    expect(evidenceTool).toContain("event: 'push'");
    expect(evidenceTool).toContain("prefix: 'production-candidate-'");
    expect(evidenceTool).toContain('head_sha: sha');
    expect(evidenceTool).toContain("run.conclusion === 'success'");
    expect(evidenceTool).toContain('/actions/runs/${run.id}/artifacts?per_page=100');
    expect(evidenceTool).toContain('artifact.name === `${prefix}${expected.runAttempt}`');
    expect(workflow).toContain('RELEASE_SOURCE_RUN_ID');
    expect(workflow).toContain('RELEASE_SOURCE_RUN_ATTEMPT');
    expect(workflow).toContain('run-id: ${{ needs.validate.outputs.candidate_run_id }}');
    const candidateVerification = workflow.indexOf('Verify candidate hashes and commit');
    const timeSensitiveGuard = workflow.indexOf(
      'Revalidate time-sensitive production security guards',
    );
    const bundleRevalidation = workflow.indexOf(
      'Revalidate every production Worker bundle without deploying',
    );
    expect(timeSensitiveGuard).toBeGreaterThan(candidateVerification);
    expect(bundleRevalidation).toBeGreaterThan(timeSensitiveGuard);
    expect(workflow.slice(timeSensitiveGuard, bundleRevalidation)).toContain(
      'npm run guard:prod-security',
    );

    const validateStart = workflow.indexOf('  validate:');
    const deployStart = workflow.indexOf('  deploy:');
    const validateJob = workflow.slice(validateStart, deployStart);
    for (const stepName of [
      'Setup Node.js',
      'Install dependencies',
      'Typecheck',
      'Lint',
      'Formatting',
      'Worker syntax check',
      'Playback and storage static invariants',
      'Unit tests',
      'Critical runtime coverage',
      'Install Playwright browser',
      'Release-candidate core smoke',
      'Build and verify production bundle',
      'Record immutable release manifest',
      'Upload immutable production candidate',
    ]) {
      expect(validateJob, stepName).not.toContain(`- name: ${stepName}`);
    }
    expect(validateJob).not.toContain('RELEASE_TARGET_INPUT');
    expect(validateJob).not.toContain('if [[ "$RELEASE_TARGET_INPUT" != "app" ]]');

    const compatibility = workflow.indexOf('Verify partial release dependency compatibility');
    const appDeploy = workflow.indexOf('Deploy and record app Worker with immutable dist');
    expect(compatibility).toBeGreaterThan(-1);
    expect(compatibility).toBeLessThan(appDeploy);
    expect(workflow).not.toContain('Verify current signaling contract before app-only release');
    const initialFence = workflow.indexOf('Verify release commit is still current main');
    expect(initialFence).toBeGreaterThan(-1);
    expect(initialFence).toBeLessThan(workflow.indexOf('Setup Node.js'));
    expect(workflow.match(/git fetch --no-tags origin main/g)).toHaveLength(1);
    expect(workflow).toContain('the immutable candidate is pinned');
    expect(workflow).not.toContain('main advanced to $current_main before the app deployment');

    const appPlan = emergencyDeploymentPlan('app', '1'.repeat(40));
    expect(appPlan[0]).toEqual(['run', '--silent', 'smoke:live:signaling']);
    expect(appPlan[1]).toEqual(['run', '--silent', 'build:checked']);
  });

  it('rechecks anonymous account and PRO public boundaries after an app-only deployment', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const appDeploy = workflow.indexOf('Deploy and record app Worker with immutable dist');
    const authSmoke = workflow.indexOf('Smoke anonymous app account boundary');
    const proSmoke = workflow.indexOf('Smoke current PRO public boundary after app deployment');
    const finalVerification = workflow.indexOf(
      'Verify release still owns current production deployments',
    );
    expect(authSmoke).toBeGreaterThan(appDeploy);
    expect(proSmoke).toBeGreaterThan(authSmoke);
    expect(finalVerification).toBeGreaterThan(proSmoke);

    const authStepEnd = workflow.indexOf('\n      - name:', authSmoke + 1);
    const authStep = workflow.slice(authSmoke, authStepEnd);
    expect(authStep).toContain("if: inputs.target == 'all' || inputs.target == 'app'");
    expect(authStep).toContain('run: npm run smoke:live:app-public-boundary');

    const proStepEnd = workflow.indexOf('\n      - name:', proSmoke + 1);
    const proStep = workflow.slice(proSmoke, proStepEnd);
    expect(proStep).toContain("if: inputs.target == 'all' || inputs.target == 'app'");
    expect(proStep).toContain('run: npm run smoke:live:pro-room');
  });

  it('blocks ordinary local deploy scripts and gates every emergency route', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const targets = [
      'remote-share',
      'pro-room',
      'developer-api-facade',
      'developer-api',
      'developer-api-stack',
      'signaling',
      'app',
      'all-workers',
    ];
    for (const target of targets) {
      expect(packageJson.scripts[`deploy:${target}`]).toBe(
        `node scripts/guard-emergency-deploy.mjs reject ${target}`,
      );
      expect(packageJson.scripts[`emergency:deploy:${target}`]).toBe(
        `node scripts/emergency-deploy.mjs ${target}`,
      );
    }
  });

  it('bounds production live-smoke requests and step runtimes before rollback', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const deployStart = workflow.indexOf('\n  deploy:');
    const deploySteps = workflow.indexOf('\n    steps:', deployStart);
    expect(deployStart).toBeGreaterThan(-1);
    expect(deploySteps).toBeGreaterThan(deployStart);
    expect(workflow.slice(deployStart, deploySteps)).toContain('timeout-minutes: 240');

    const secretPreflight = workflow.indexOf(
      '- name: Verify Remote Share assertion secret inventory',
    );
    const mutationAuthorization = workflow.indexOf(
      '- name: Authorize production mutations from persisted checkpoint',
    );
    expect(secretPreflight).toBeGreaterThan(deploySteps);
    expect(secretPreflight).toBeLessThan(mutationAuthorization);
    const secretPreflightEnd = workflow.indexOf('\n      - name:', secretPreflight + 1);
    const secretStep = workflow.slice(secretPreflight, secretPreflightEnd);
    expect(secretStep).toContain('MXQR_REMOTE_SHARE_UPLOAD_ASSERTION_SECRET');
    expect(secretStep).toContain('cloudflare/wrangler.remote-share.toml');
    expect(secretStep).toContain('cloudflare/wrangler.signaling.toml');
    expect(secretStep).toContain("'any(.[]; .name == $name)'");

    for (const stepName of [
      'Smoke PRO media R2 CORS boundary',
      'Smoke remote-share Worker',
      'Smoke signaling Worker',
      'Smoke Remote Share host assertion path',
      'Smoke Developer API Worker',
      'Smoke app generation endpoint',
      'Smoke anonymous app account boundary',
    ]) {
      const stepStart = workflow.indexOf(`- name: ${stepName}`);
      const nextStep = workflow.indexOf('\n      - name:', stepStart + 1);
      const step = workflow.slice(stepStart, nextStep < 0 ? workflow.length : nextStep);
      expect(stepStart, stepName).toBeGreaterThan(-1);
      expect(step, stepName).toContain(
        stepName === 'Smoke PRO media R2 CORS boundary'
          ? 'timeout-minutes: 10'
          : stepName === 'Smoke Developer API Worker'
            ? 'timeout-minutes: 10'
            : 'timeout-minutes: 5',
      );
    }

    const assertionSmokeStart = workflow.indexOf('- name: Smoke Remote Share host assertion path');
    const assertionSmokeEnd = workflow.indexOf('\n      - name:', assertionSmokeStart + 1);
    const assertionSmoke = workflow.slice(assertionSmokeStart, assertionSmokeEnd);
    expect(assertionSmoke).toContain("inputs.target == 'all' || inputs.target == 'signaling'");
    expect(assertionSmoke).toContain('run: npm run smoke:live:remote-share -- --require-assertion');
    expect(assertionSmoke).toContain(
      'MXQR_EXPECTED_REMOTE_SHARE_VERSION: ${{ steps.remote_share_deployment.outputs.version_id }}',
    );
    expect(assertionSmoke).toContain(
      'MXQR_EXPECTED_SIGNALING_VERSION: ${{ steps.signaling_deployment.outputs.version_id }}',
    );

    const remoteDeployStart = workflow.indexOf('- name: Deploy and record remote-share Worker');
    const remoteDeployEnd = workflow.indexOf('\n      - name:', remoteDeployStart + 1);
    const remoteDeploy = workflow.slice(remoteDeployStart, remoteDeployEnd);
    expect(remoteDeploy).toContain('id: remote_share_deployment');
    expect(remoteDeploy).toContain(
      'version_id="$(node scripts/release-deployment-state.mjs version remote-share)"',
    );

    const remoteSmokeStart = workflow.indexOf('- name: Smoke remote-share Worker');
    const remoteSmokeEnd = workflow.indexOf('\n      - name:', remoteSmokeStart + 1);
    const remoteSmoke = workflow.slice(remoteSmokeStart, remoteSmokeEnd);
    expect(remoteSmoke).toContain(
      'MXQR_EXPECTED_REMOTE_SHARE_VERSION: ${{ steps.remote_share_deployment.outputs.version_id }}',
    );

    const proRoomSmokeStepNames = [
      'Smoke PRO room Worker',
      'Smoke current PRO public boundary after app deployment',
    ];
    expect(workflow.match(/run: npm run smoke:live:pro-room/gu)).toHaveLength(
      proRoomSmokeStepNames.length,
    );
    for (const stepName of proRoomSmokeStepNames) {
      const stepStart = workflow.indexOf(`- name: ${stepName}`);
      const nextStep = workflow.indexOf('\n      - name:', stepStart + 1);
      const step = workflow.slice(stepStart, nextStep < 0 ? workflow.length : nextStep);
      expect(stepStart, stepName).toBeGreaterThan(-1);
      expect(step, stepName).toContain('timeout-minutes: 8');
      expect(step, stepName).toContain('run: npm run smoke:live:pro-room');
    }

    for (const stepName of [
      'Read PRO room generation cutover before dependency rollout',
      'Fence room-code reuse during dependency rollout',
      'Deploy and record remote-share Worker',
      'Deploy and record PRO room Worker',
      'Deploy and record signaling Worker',
      'Deploy and record Developer API Worker',
      'Deploy and record app Worker with immutable dist',
      'Restore release-owned Workers after a failed release',
    ]) {
      const stepStart = workflow.indexOf(`- name: ${stepName}`);
      const nextStep = workflow.indexOf('\n      - name:', stepStart + 1);
      const step = workflow.slice(stepStart, nextStep < 0 ? workflow.length : nextStep);
      expect(stepStart, stepName).toBeGreaterThan(-1);
      expect(step, stepName).toMatch(/timeout-minutes: (?:10|15|20)/u);
    }

    const npmInvocation = readFileSync(resolve('scripts/npm-invocation.mjs'), 'utf8');
    expect(npmInvocation).toContain('timeout: options.timeout ?? 10 * 60 * 1000');

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

  it('persists a pre-mutation checkpoint and reserves an independent recovery job', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const recoveryWorkflow = readFileSync(
      resolve('.github/workflows/release-recovery.yml'),
      'utf8',
    );
    const capture = workflow.indexOf('Capture immutable Worker and R2 recovery checkpoint');
    const persist = workflow.indexOf('Persist pre-mutation recovery checkpoint');
    const authorize = workflow.indexOf('Authorize production mutations from persisted checkpoint');
    const firstD1Mutation = workflow.indexOf('Fence room-code reuse during dependency rollout');
    const firstR2Mutation = workflow.indexOf('Apply remote-share R2 CORS policy');
    const firstWorkerMutation = workflow.indexOf('Deploy and record PRO room Worker');
    const finalVerification = workflow.indexOf(
      'Verify release still owns current production deployments',
    );
    const readiness = workflow.indexOf('Restore PRO room generation readiness');
    const productionCommit = workflow.indexOf('Mark coherent production candidate committed');
    const sameJobRecovery = workflow.indexOf(
      'Assess R2 recovery constraints before Worker rollback',
    );
    const sameJobWorkerRollback = workflow.indexOf(
      'Restore release-owned Workers after a failed release',
    );
    const sameJobR2Reconciliation = workflow.indexOf(
      'Reconcile R2 policy with the exact recovered Worker boundary',
    );
    const sameJobPairedVerification = workflow.indexOf(
      'Freshly verify the paired R2 and Worker recovery boundary',
    );
    const recoveryJob = workflow.indexOf('\n  recovery:');

    expect(capture).toBeGreaterThan(-1);
    expect(persist).toBeGreaterThan(capture);
    expect(authorize).toBeGreaterThan(persist);
    for (const mutation of [firstD1Mutation, firstR2Mutation, firstWorkerMutation]) {
      expect(mutation).toBeGreaterThan(authorize);
    }
    expect(workflow.slice(capture, persist)).toContain('checkpoint "$RELEASE_TARGET"');
    expect(workflow.slice(capture, persist)).toContain('snapshot "$RELEASE_TARGET"');
    for (const [preflight, mutation] of [
      ['preflight remote-share-cors', 'r2 bucket cors set musixquare-remote-share'],
      ['preflight remote-share-lifecycle', 'r2 bucket lifecycle set musixquare-remote-share'],
      ['preflight pro-media-cors', 'r2 bucket cors set musixquare-pro-media'],
    ]) {
      expect(workflow.indexOf(preflight)).toBeGreaterThan(persist);
      expect(workflow.indexOf(preflight)).toBeLessThan(workflow.indexOf(mutation));
    }
    expect(productionCommit).toBeGreaterThan(finalVerification);
    expect(productionCommit).toBeGreaterThan(readiness);
    expect(productionCommit).toBeLessThan(sameJobRecovery);
    expect(workflow.slice(productionCommit, sameJobRecovery)).toContain(
      'echo \'committed=true\' >> "$GITHUB_OUTPUT"',
    );
    for (const stepName of [
      'Assess R2 recovery constraints before Worker rollback',
      'Disable PRO room generation cutover before failed-release rollback',
      'Assess captured Worker compatibility floors before failed-release rollback',
      'Restore release-owned Workers after a failed release',
    ]) {
      const start = workflow.indexOf(`- name: ${stepName}`);
      const end = workflow.indexOf('\n      - name:', start + 1);
      expect(workflow.slice(start, end)).toContain(
        "steps.production_commit.outputs.committed != 'true'",
      );
    }
    expect(sameJobR2Reconciliation).toBeGreaterThan(sameJobWorkerRollback);
    expect(sameJobPairedVerification).toBeGreaterThan(sameJobR2Reconciliation);
    expect(workflow.slice(sameJobR2Reconciliation, sameJobPairedVerification)).toContain(
      'release-artifacts/recovery-checkpoint',
    );
    expect(workflow.slice(sameJobR2Reconciliation, sameJobPairedVerification)).not.toContain(
      'release-artifacts/deployments',
    );
    expect(workflow.slice(sameJobPairedVerification, recoveryJob)).toContain(
      'verify-paired-recovery',
    );
    const finalFailure = workflow.indexOf('Fail release when automatic recovery is incomplete');
    const finalFailureEnd = workflow.indexOf('\n  recovery:', finalFailure);
    const finalFailureStep = workflow.slice(finalFailure, finalFailureEnd);
    expect(finalFailureStep).toContain("steps.r2_policy_reconciliation.outcome == 'failure'");
    expect(finalFailureStep).toContain("steps.paired_recovery_verification.outcome == 'failure'");
    expect(recoveryJob).toBeGreaterThan(firstWorkerMutation);
    const recoveryCaller = workflow.slice(recoveryJob);
    const recovery = recoveryWorkflow;
    expect(recoveryCaller).toContain('needs: [validate, deploy]');
    expect(recoveryCaller).toContain("needs.deploy.outputs.production_committed != 'true'");
    expect(recoveryCaller).toContain('uses: ./.github/workflows/release-recovery.yml');
    expect(recoveryCaller).toContain('secrets: inherit');
    expect(recovery).not.toContain('needs: [validate, deploy]');
    expect(recovery).not.toContain('needs.validate');
    expect(recovery).not.toContain('needs.deploy');
    expect(recovery).toContain('timeout-minutes: 90');
    expect(recovery).toContain('Recover persisted coherent-production marker');
    expect(recovery).toContain('Retry coherent-production marker download');
    expect(recovery).toContain('Classify coherent-production marker');
    expect(recovery).toContain("production_commit_state.outputs.state == 'committed'");
    expect(recovery).toContain("production_commit_state.outputs.state == 'indeterminate'");
    expect(recovery).toContain('/actions/runs/${GITHUB_RUN_ID}/artifacts?per_page=100');
    expect(recovery).toContain('Download immutable pre-mutation recovery checkpoint');
    expect(recovery).toContain('Retry immutable recovery checkpoint download');
    expect(recovery.match(/- name: Checkout exact failed release/gu)).toHaveLength(1);
    expect(recovery.indexOf('Checkout exact failed release')).toBeLessThan(
      recovery.indexOf('Download immutable pre-mutation recovery checkpoint'),
    );
    expect(recovery).toContain("checkpoint_root='release-artifacts/recovery-checkpoint'");
    expect(recovery).toContain('"${checkpoint_root}/r2-policy-checkpoint.json"');
    expect(recovery).toContain('"${checkpoint_root}/worker-floor-checkpoint.json"');
    expect(recovery).toContain(
      "expected_workers='app,developer-api,developer-api-facade,pro-room,remote-share,signaling'",
    );
    expect(recovery).toContain('.releaseMessage == $release_message');
    expect(recovery).toContain('.target == $worker');
    expect(recovery).toContain('.config == $config');
    expect(recovery).toContain('.releaseMessage == $release_message');
    expect(recovery).toContain('error("missing Worker baseline identity")');
    expect(recovery).toContain('.beforeVersionId == $checkpoint_version');
    expect(recovery).toContain(
      'The downloaded immutable checkpoint is absent, nested at an unexpected path, or structurally incomplete.',
    );
    expect(recovery).toContain('inputs.mutation_authorized');
    expect(recovery).toContain("recovery_checkpoint_ready.outputs.available == 'true'");
    expect(recovery).toContain('assess release-artifacts/recovery-checkpoint');
    expect(recovery).toContain('rollback release-artifacts/recovery-checkpoint');
    expect(recovery).toContain('Reconcile persisted R2 policy with recovered Workers');
    expect(recovery).toContain('Verify final paired R2 and Worker recovery boundary');
    expect(recovery).toContain('verify-paired-recovery');
    expect(recovery).toContain('service_control_forward_floor="$(');
    expect(recovery).toContain('remote_share_forward_floor="$(');
    expect(recovery).not.toContain(
      'if [[ "$(node scripts/release-deployment-state.mjs service-control-forward-floor',
    );
    expect(recovery).not.toContain(
      'if [[ "$(node scripts/release-deployment-state.mjs remote-share-forward-floor',
    );
    expect(
      recovery.indexOf('Reconcile persisted R2 policy with recovered Workers'),
    ).toBeGreaterThan(
      recovery.indexOf('Restore release-owned Workers or record a forward-repair boundary'),
    );
  });

  it('renders independent recovery Markdown without Bash command substitution', () => {
    const workflow = readFileSync(resolve('.github/workflows/release-recovery.yml'), 'utf8');
    const recoverySummaryStart = workflow.indexOf('- name: Failed-release recovery summary');
    const recoverySummary = workflow.slice(recoverySummaryStart);
    const markdownLines = recoverySummary
      .split(/\r?\n/u)
      .filter((line) => line.includes('`${{ steps.fallback_'));

    expect(recoverySummaryStart).toBeGreaterThan(-1);
    expect(markdownLines).toHaveLength(7);
    for (const line of markdownLines) {
      expect(line).toMatch(/^\s+printf '%s\\n' '- .*`' >> "\$GITHUB_STEP_SUMMARY"$/u);
      expect(line).not.toMatch(/^\s+echo\s+"[^"\n]*`\$\{\{/u);
    }
  });

  it('freshly proves either the restored baseline or an exact retained release candidate', () => {
    const directory = createDirectory();
    for (const [target, beforeVersionId, releaseMessage] of [
      ['app', 'app-before', CANONICAL_RELEASE_MESSAGE],
      ['signaling', 'signaling-before', CANONICAL_RELEASE_MESSAGE],
    ]) {
      writeFileSync(
        resolve(directory, `${target}-state.json`),
        JSON.stringify({
          schemaVersion: 1,
          target,
          config: `cloudflare/wrangler.${target}.toml`,
          attempted: true,
          beforeVersionId,
          releaseMessage,
        }),
      );
    }
    writeFileSync(
      resolve(directory, 'rollback-report.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'partial-failure',
        results: [
          { target: 'app', status: 'skipped-compatibility-floor' },
          { target: 'signaling', status: 'skipped-dependent-worker-not-restored' },
        ],
      }),
    );

    expect(
      verifyRecoveryBoundary(directory, {
        queryCurrent: (target: string) => ({
          deploymentId: `${target}-candidate-deployment`,
          versionId: `${target}-candidate-version`,
          message: CANONICAL_RELEASE_MESSAGE,
        }),
      }),
    ).toMatchObject({
      status: 'verified',
      results: [
        { target: 'app', status: 'verified-forward-boundary' },
        { target: 'signaling', status: 'verified-forward-boundary' },
      ],
    });
  });

  it('reproduces a partial rollout without mistaking untouched baselines for retained candidates', () => {
    const directory = createDirectory();
    const targets = [
      'pro-room',
      'remote-share',
      'signaling',
      'developer-api-facade',
      'developer-api',
      'app',
    ] as const;
    const candidateTargets = new Set(['pro-room', 'remote-share']);
    for (const target of targets) {
      writeFileSync(
        resolve(directory, `${target}-state.json`),
        JSON.stringify({
          schemaVersion: 1,
          target,
          config: `cloudflare/wrangler.${target}.toml`,
          attempted: true,
          beforeDeploymentId: `${target}-baseline-deployment`,
          beforeVersionId: `${target}-baseline-version`,
          beforeMessage: `git:${'b'.repeat(40)}`,
          releaseMessage: CANONICAL_RELEASE_MESSAGE,
          ...(candidateTargets.has(target)
            ? {
                afterDeploymentId: `${target}-candidate-deployment`,
                afterVersionId: `${target}-candidate-version`,
                ownedByRelease: true,
              }
            : { afterDeploymentId: null, afterVersionId: null }),
        }),
      );
    }
    const queryCurrent = (target: string) => {
      const candidate = candidateTargets.has(target);
      return {
        deploymentId: `${target}-${candidate ? 'candidate' : 'baseline'}-deployment`,
        versionId: `${target}-${candidate ? 'candidate' : 'baseline'}-version`,
        message: candidate ? CANONICAL_RELEASE_MESSAGE : `git:${'b'.repeat(40)}`,
      };
    };
    const runner = vi.fn();

    const report = rollback(directory, {
      // This is the production failure shape: permanent contract floors retain
      // the deployed PRO/remote candidates and also name the not-yet-attempted
      // App. The App and signaling must still classify from their live baseline.
      skipTargets: new Set(['app', 'pro-room', 'remote-share']),
      queryCurrent,
      runner,
    });

    expect(report).toMatchObject({
      status: 'forward-repair-required',
      results: [
        { target: 'app', status: 'already-restored' },
        { target: 'developer-api', status: 'already-restored' },
        { target: 'developer-api-facade', status: 'already-restored' },
        { target: 'signaling', status: 'already-restored' },
        { target: 'remote-share', status: 'skipped-compatibility-floor' },
        { target: 'pro-room', status: 'skipped-compatibility-floor' },
      ],
    });
    expect(runner).not.toHaveBeenCalled();
    expect(verifyRecoveryBoundary(directory, { queryCurrent })).toMatchObject({
      status: 'verified',
      results: [
        { target: 'app', status: 'verified-baseline' },
        { target: 'developer-api', status: 'verified-baseline' },
        { target: 'developer-api-facade', status: 'verified-baseline' },
        { target: 'signaling', status: 'verified-baseline' },
        { target: 'remote-share', status: 'verified-forward-boundary' },
        { target: 'pro-room', status: 'verified-forward-boundary' },
      ],
    });
  });

  it('fails closed when a baseline signaling Worker is paired with a retained candidate App', () => {
    const directory = createDirectory();
    for (const target of ['app', 'signaling'] as const) {
      writeFileSync(
        resolve(directory, `${target}-state.json`),
        JSON.stringify({
          schemaVersion: 1,
          target,
          config: `cloudflare/wrangler.${target}.toml`,
          attempted: true,
          beforeVersionId: `${target}-baseline-version`,
          releaseMessage: CANONICAL_RELEASE_MESSAGE,
        }),
      );
    }
    const runner = vi.fn();

    const report = rollback(directory, {
      skipTargets: new Set(['app']),
      queryCurrent: (target: string) => ({
        deploymentId: `${target}-${target === 'app' ? 'candidate' : 'baseline'}-deployment`,
        versionId: `${target}-${target === 'app' ? 'candidate' : 'baseline'}-version`,
        message: target === 'app' ? CANONICAL_RELEASE_MESSAGE : `git:${'b'.repeat(40)}`,
      }),
      runner,
    });

    expect(report).toMatchObject({
      status: 'partial-failure',
      results: [
        { target: 'app', status: 'skipped-compatibility-floor' },
        {
          target: 'signaling',
          status: 'incompatible-baseline-dependent-worker',
          error: expect.stringContaining('cross-Worker protocol boundary'),
        },
      ],
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('fails closed when a baseline Remote Share Worker is paired with a retained candidate App', () => {
    const directory = createDirectory();
    for (const target of ['app', 'remote-share'] as const) {
      writeFileSync(
        resolve(directory, `${target}-state.json`),
        JSON.stringify({
          schemaVersion: 1,
          target,
          config: `cloudflare/wrangler.${target}.toml`,
          attempted: true,
          beforeVersionId: `${target}-baseline-version`,
          releaseMessage: CANONICAL_RELEASE_MESSAGE,
        }),
      );
    }
    const runner = vi.fn();

    const report = rollback(directory, {
      skipTargets: new Set(['app']),
      queryCurrent: (target: string) => ({
        deploymentId: `${target}-${target === 'app' ? 'candidate' : 'baseline'}-deployment`,
        versionId: `${target}-${target === 'app' ? 'candidate' : 'baseline'}-version`,
        message: target === 'app' ? CANONICAL_RELEASE_MESSAGE : `git:${'b'.repeat(40)}`,
      }),
      runner,
    });

    expect(report).toMatchObject({
      status: 'partial-failure',
      results: [
        { target: 'app', status: 'skipped-compatibility-floor' },
        {
          target: 'remote-share',
          status: 'incompatible-baseline-dependent-worker',
          error: expect.stringContaining('cross-Worker protocol boundary'),
        },
      ],
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('fails recovery verification on a mixed or unowned live Worker boundary', () => {
    const directory = createDirectory();
    writeFileSync(
      resolve(directory, 'app-state.json'),
      JSON.stringify({
        schemaVersion: 1,
        target: 'app',
        config: 'cloudflare/wrangler.app.toml',
        attempted: true,
        beforeVersionId: 'app-before',
        releaseMessage: CANONICAL_RELEASE_MESSAGE,
      }),
    );
    writeFileSync(
      resolve(directory, 'rollback-report.json'),
      JSON.stringify({
        schemaVersion: 1,
        status: 'succeeded',
        results: [{ target: 'app', status: 'restored' }],
      }),
    );

    expect(() =>
      verifyRecoveryBoundary(directory, {
        queryCurrent: () => ({
          deploymentId: 'unknown-deployment',
          versionId: 'unknown-version',
          message: `git:${'b'.repeat(40)}`,
        }),
      }),
    ).toThrow('production is not a proven baseline or forward-repair candidate');
    expect(
      JSON.parse(readFileSync(resolve(directory, 'recovery-final-verification.json'), 'utf8')),
    ).toMatchObject({ status: 'failed', results: [{ target: 'app', status: 'conflict' }] });
  });

  it('fails closed on unknown rollback skip targets', () => {
    expect([...rollbackSkipTargets('developer-api, app')]).toEqual(['developer-api', 'app']);
    expect(() => rollbackSkipTargets('unknown-worker')).toThrow(
      'Unknown release target: unknown-worker',
    );
  });

  it('records an exact compatibility-floored candidate as a coherent forward boundary', () => {
    const directory = createDirectory();
    writeFileSync(
      resolve(directory, 'developer-api-state.json'),
      JSON.stringify({
        schemaVersion: 1,
        target: 'developer-api',
        config: 'cloudflare/wrangler.developer-api.toml',
        attempted: true,
        beforeVersionId: 'previous-before',
        afterVersionId: 'current-after',
        releaseMessage: CANONICAL_RELEASE_MESSAGE,
        ownedByRelease: true,
      }),
    );

    const report = rollback(directory, {
      skipTargets: new Set(['developer-api']),
      queryCurrent: () => ({
        deploymentId: 'candidate-deployment',
        versionId: 'current-after',
        message: CANONICAL_RELEASE_MESSAGE,
      }),
    });

    expect(report.status).toBe('forward-repair-required');
    expect(report.results).toEqual([
      expect.objectContaining({
        target: 'developer-api',
        status: 'skipped-compatibility-floor',
        error: expect.stringContaining('exact release candidate'),
      }),
    ]);
  });
});
