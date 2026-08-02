import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attemptedStates,
  changedAppRuntimeDependencies,
  changedRuntimePaths,
  npmInvocation,
  preflight,
  productionVersion,
  queryCurrent,
  releaseGitSha,
  releaseTargetWorkers,
  runtimePathsForWorker,
  retrySync,
  runRollbackWithRetry,
  rollbackDisposition,
  rollbackDependencyBlock,
  rollbackDeploymentMessage,
  rollbackSkipTargets,
  verifyPartialReleaseCompatibility,
  verifyCurrentRelease,
  verifyProductionVersion,
} from '../../../scripts/release-deployment-state.mjs';
import { emergencyDeploymentPlan } from '../../../scripts/emergency-deploy.mjs';

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

    const deployAll = emergencyDeploymentPlan('all-workers', '1'.repeat(40)).flat().join(' ');
    const remoteConfig = deployAll.indexOf('cloudflare/wrangler.remote-share.toml');
    const proConfig = deployAll.indexOf('cloudflare/wrangler.pro-room.toml');
    const signalingConfig = deployAll.indexOf('cloudflare/wrangler.signaling.toml');
    const facadeConfig = deployAll.indexOf('cloudflare/wrangler.developer-api-facade.toml');
    const apiConfig = deployAll.indexOf('cloudflare/wrangler.developer-api.toml');
    const appConfig = deployAll.indexOf('cloudflare/wrangler.app.toml');

    expect(proConfig).toBeGreaterThan(remoteConfig);
    expect(signalingConfig).toBeGreaterThan(proConfig);
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
      'remote-share',
      'signaling',
      'pro-room',
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
    ).toBe(`git:${restoredSha} rollback:${'b'.repeat(40)} run:11`);
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
      RELEASE_MESSAGE: 'release-message',
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

  it('restores first-frame signaling independently of the app rollback result', () => {
    const states = [{ target: 'app' }, { target: 'signaling' }];

    expect(rollbackDependencyBlock('signaling', states, [])).toBeNull();
    expect(
      rollbackDependencyBlock('signaling', states, [{ target: 'app', status: 'conflict' }]),
    ).toBeNull();
    expect(
      rollbackDependencyBlock('signaling', states, [{ target: 'app', status: 'failed' }]),
    ).toBeNull();
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

    const lastSmoke = workflow.indexOf('Smoke current PRO public boundary after app deployment');
    const finalVerification = workflow.indexOf(
      'Verify release still owns current production deployments',
    );
    const generationFence = workflow.indexOf(
      'Disable PRO room generation cutover before failed-release rollback',
    );
    const workerRollback = workflow.indexOf('Restore Worker deployments after a failed release');
    expect(finalVerification).toBeGreaterThan(lastSmoke);
    expect(generationFence).toBeGreaterThan(finalVerification);
    expect(workerRollback).toBeGreaterThan(generationFence);
    expect(workflow).toContain("steps.final_verification.outcome || 'not-run'");

    const generationFenceStep = workflow.slice(generationFence, workerRollback);
    const workerStepEnd = workflow.indexOf('\n      - name:', workerRollback + 1);
    const workerStep = workflow.slice(workerRollback, workerStepEnd);
    expect(generationFenceStep).toContain(
      'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_D1_API_TOKEN }}',
    );
    expect(generationFenceStep).not.toContain('secrets.CLOUDFLARE_API_TOKEN');
    expect(workerStep).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(workerStep).not.toContain('secrets.CLOUDFLARE_D1_API_TOKEN');
    expect(workerStep).toContain('inputs.apply_developer_api_d1');
    expect(workerStep).toContain('rollback_skip_targets="developer-api-facade,developer-api"');
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

  it('uses CI critical coverage and front-loads partial-release compatibility before deploy setup', () => {
    const ciWorkflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const coverage = ciWorkflow.indexOf('run: npm run test:coverage:critical');
    const compatibility = workflow.indexOf('Verify partial release dependency compatibility');
    const generationFloor = workflow.indexOf(
      'Read PRO room generation cutover before dependency rollout',
    );
    const browserInstall = workflow.indexOf('Install app smoke browser');
    const firstDeploy = workflow.indexOf('Deploy and record remote-share Worker');
    expect(coverage).toBeGreaterThan(-1);
    expect(compatibility).toBeGreaterThan(-1);
    expect(compatibility).toBeLessThan(generationFloor);
    expect(compatibility).toBeLessThan(browserInstall);
    expect(browserInstall).toBeLessThan(generationFloor);
    expect(compatibility).toBeLessThan(firstDeploy);
    const nextStep = workflow.indexOf('\n      - name:', compatibility + 1);
    const step = workflow.slice(compatibility, nextStep);
    expect(step).toContain("if: inputs.target != 'all'");
    expect(step).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(step).toContain(
      'node scripts/release-deployment-state.mjs compatibility "$RELEASE_TARGET" "${{ github.sha }}"',
    );
  });

  it('reuses the successful exact-SHA main CI artifact for every release target', () => {
    const ciWorkflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
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
    expect(workflow).toContain('actions/workflows/ci.yml/runs');
    expect(workflow).toContain('-f head_sha="$GITHUB_SHA"');
    expect(workflow).toContain('select(.conclusion == "success")');
    expect(workflow).toContain('actions/runs/$run_id/artifacts');
    expect(workflow).toContain('.name | startswith($prefix)');
    expect(workflow).toContain('artifact_prefix="production-candidate-$GITHUB_SHA-$run_id-"');
    expect(workflow).toContain('run_attempt="${artifact_name##*-}"');
    expect(workflow).toContain('RELEASE_SOURCE_RUN_ID');
    expect(workflow).toContain('RELEASE_SOURCE_RUN_ATTEMPT');
    expect(workflow).toContain('run-id: ${{ needs.validate.outputs.candidate_run_id }}');

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
    const appDeployEnd = workflow.indexOf('\n      - name:', appDeploy + 1);
    const appDeployStep = workflow.slice(appDeploy, appDeployEnd);
    expect(appDeployStep).toContain('git fetch --no-tags origin main');
    expect(appDeployStep).toContain('current_main="$(git rev-parse origin/main)"');
    expect(appDeployStep).toContain('if [[ "$current_main" != "$GITHUB_SHA" ]]');

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
    for (const stepName of [
      'Smoke remote-share Worker',
      'Smoke signaling Worker',
      'Smoke PRO room Worker',
      'Smoke Developer API Worker',
      'Smoke app session endpoint',
      'Smoke anonymous app account boundary',
      'Smoke current PRO public boundary after app deployment',
    ]) {
      const stepStart = workflow.indexOf(`- name: ${stepName}`);
      const nextStep = workflow.indexOf('\n      - name:', stepStart + 1);
      const step = workflow.slice(stepStart, nextStep < 0 ? workflow.length : nextStep);
      expect(stepStart, stepName).toBeGreaterThan(-1);
      expect(step, stepName).toContain('timeout-minutes: 5');
    }

    for (const stepName of [
      'Read PRO room generation cutover before dependency rollout',
      'Fence room-code reuse during dependency rollout',
      'Deploy and record remote-share Worker',
      'Deploy and record PRO room Worker',
      'Deploy and record signaling Worker',
      'Deploy and record Developer API Worker',
      'Deploy and record app Worker with immutable dist',
      'Restore Worker deployments after a failed release',
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

  it('fails closed on unknown rollback skip targets', () => {
    expect([...rollbackSkipTargets('developer-api, app')]).toEqual(['developer-api', 'app']);
    expect(() => rollbackSkipTargets('unknown-worker')).toThrow(
      'Unknown release target: unknown-worker',
    );
  });

  it('records a compatibility-floored Worker as withheld from automatic rollback', () => {
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
        status: 'skipped-compatibility-floor',
        error: expect.stringContaining('schema or generation compatibility floor'),
      }),
    ]);
  });
});
