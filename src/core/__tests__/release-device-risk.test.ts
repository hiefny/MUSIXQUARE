import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyReleaseDeviceRisk,
  evaluateReleaseDeviceRisk,
  normalizeReleaseDeviceRiskContract,
  readReleaseDeviceRiskContract,
  releaseGitShaFromDeployment,
} from '../../../scripts/release-device-risk.mjs';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const SCRIPT_PATH = resolve(process.cwd(), 'scripts', 'release-device-risk.mjs');
const temporaryDirectories: string[] = [];

interface FixtureContract {
  schemaVersion: 1;
  requiredExactPaths: string[];
  requiredPathPrefixes: string[];
}

interface RiskRun {
  status: number | null;
  stdout: string;
  stderr: string;
  report: {
    required: boolean;
    reason: string;
    changedPaths: string[];
    matchedPaths: string[];
  };
}

function deployment(sha = BASE_SHA): Record<string, unknown> {
  return {
    annotations: { 'workers/message': `git:${sha}` },
    versions: [{ version_id: 'production-version', percentage: 100 }],
  };
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(directory: string, filePath: string, contents: string): void {
  const target = join(directory, filePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function commit(directory: string, message: string): string {
  git(directory, 'add', '--all');
  git(directory, '-c', 'commit.gpgsign=false', 'commit', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
}

function fixtureContract(
  overrides: Partial<Omit<FixtureContract, 'schemaVersion'>> = {},
): FixtureContract {
  return {
    schemaVersion: 1,
    requiredExactPaths: [
      'index.html',
      'package-lock.json',
      'package.json',
      'public/service-worker.js',
    ],
    requiredPathPrefixes: ['src/youtube/'],
    ...overrides,
  };
}

function fixturePackageManifest(peerjs = '^1.5.5', qrcode = '^1.5.4'): string {
  return `${JSON.stringify(
    {
      name: 'device-risk-fixture',
      private: true,
      dependencies: { peerjs, qrcode },
    },
    null,
    2,
  )}\n`;
}

function fixturePackageLock(
  options: {
    peerVersion?: string;
    peerIntegrity?: string;
    sdpVersion?: string;
    sdpIntegrity?: string;
    qrcodeSpec?: string;
    qrcodeVersion?: string;
    qrcodeIntegrity?: string;
  } = {},
): string {
  const peerVersion = options.peerVersion ?? '1.5.5';
  const sdpVersion = options.sdpVersion ?? '3.2.2';
  const qrcodeVersion = options.qrcodeVersion ?? '1.5.4';
  return `${JSON.stringify(
    {
      name: 'device-risk-fixture',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'device-risk-fixture',
          dependencies: { peerjs: '^1.5.5', qrcode: options.qrcodeSpec ?? '^1.5.4' },
        },
        'node_modules/@msgpack/msgpack': {
          version: '2.8.0',
          integrity: 'sha512-msgpack',
        },
        'node_modules/eventemitter3': {
          version: '4.0.7',
          integrity: 'sha512-events',
        },
        'node_modules/peerjs': {
          version: peerVersion,
          integrity: options.peerIntegrity ?? 'sha512-peer-v1',
          dependencies: {
            '@msgpack/msgpack': '^2.8.0',
            eventemitter3: '^4.0.7',
            'peerjs-js-binarypack': '^2.1.0',
            'webrtc-adapter': '^9.0.0',
          },
        },
        'node_modules/peerjs-js-binarypack': {
          version: '2.1.0',
          integrity: 'sha512-binarypack',
        },
        'node_modules/qrcode': {
          version: qrcodeVersion,
          integrity: options.qrcodeIntegrity ?? 'sha512-qrcode-v1',
        },
        'node_modules/sdp': {
          version: sdpVersion,
          integrity: options.sdpIntegrity ?? 'sha512-sdp-v1',
        },
        'node_modules/webrtc-adapter': {
          version: '9.0.4',
          integrity: 'sha512-adapter',
          dependencies: { sdp: '^3.2.0' },
        },
      },
    },
    null,
    2,
  )}\n`;
}

function serviceWorker(epoch: number, behavior = ''): string {
  return `'use strict';\nconst CACHE_VERSION = 'v${epoch}';\n${behavior}`;
}

function indexHtml(epoch: number, suffix = ''): string {
  return `<!doctype html>\n<script src="/bootstrap.js?cache=v${epoch}"></script>\n${suffix}`;
}

function createRiskRepository(
  options: {
    contract?: FixtureContract;
    files?: Record<string, string>;
  } = {},
): { directory: string; baseSha: string } {
  const directory = mkdtempSync(join(tmpdir(), 'mxqr-device-risk-'));
  temporaryDirectories.push(directory);
  git(directory, 'init', '--initial-branch=main');
  git(directory, 'config', 'user.email', 'device-risk@example.invalid');
  git(directory, 'config', 'user.name', 'Device Risk Test');
  write(
    directory,
    'cloudflare/release-device-risk.contract.json',
    `${JSON.stringify(options.contract ?? fixtureContract(), null, 2)}\n`,
  );
  write(directory, 'index.html', indexHtml(1));
  write(directory, 'public/service-worker.js', serviceWorker(1));
  write(directory, 'package.json', fixturePackageManifest());
  write(directory, 'package-lock.json', fixturePackageLock());
  for (const [filePath, contents] of Object.entries(options.files ?? {})) {
    write(directory, filePath, contents);
  }
  return { directory, baseSha: commit(directory, 'initial release') };
}

function runRisk(directory: string, baseSha: string): RiskRun {
  const headSha = git(directory, 'rev-parse', 'HEAD');
  const deploymentPath = join(directory, 'deployment.json');
  const reportPath = join(directory, 'risk-report.json');
  writeFileSync(deploymentPath, `${JSON.stringify(deployment(baseSha))}\n`, 'utf8');
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, 'evaluate', 'app', deploymentPath, headSha, 'false', reportPath],
    {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: JSON.parse(readFileSync(reportPath, 'utf8')) as RiskRun['report'],
  };
}

function workflowStepSource(workflow: string, name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Workflow step is missing: ${name}`);
  const next = workflow.indexOf('\n      - name:', start + marker.length);
  return workflow.slice(start, next < 0 ? workflow.length : next);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release device-risk policy', () => {
  it('loads the checked-in canonical and self-protecting contract', () => {
    const contract = readReleaseDeviceRiskContract();
    expect(contract.schemaVersion).toBe(1);
    expect(contract.requiredExactPaths).toEqual(
      expect.arrayContaining([
        '.github/workflows/real-device-qa.yml',
        '.github/workflows/release.yml',
        'cloudflare/release-device-risk.contract.json',
        'css/style.css',
        'public/service-worker.js',
        'scripts/release-device-risk.mjs',
        'scripts/release-evidence.mjs',
        'src/core/platform.ts',
        'src/core/state.ts',
        'src/rooms/authority.ts',
        'src/ui/chat.ts',
        'src/ui/player-controls.ts',
        'src/ui/range-drag.ts',
        'src/ui/seekbar.ts',
      ]),
    );
    expect(contract.requiredPathPrefixes).toContain('src/media/');
    expect(contract.requiredPathPrefixes).toContain('src/network/');
    expect(contract.requiredPathPrefixes).toContain('src/pro-room/');
    expect(contract.requiredPathPrefixes).toContain('src/share/');
    expect(contract.requiredPathPrefixes).toContain('src/storage/');
    expect(contract.requiredPathPrefixes).toContain('src/youtube/');
  });

  it('rejects unsorted, redundant, or non-canonical contracts', () => {
    expect(() =>
      normalizeReleaseDeviceRiskContract({
        schemaVersion: 1,
        requiredExactPaths: ['src/youtube/iframe.ts'],
        requiredPathPrefixes: ['src/youtube/'],
      }),
    ).toThrow(/redundant/u);
    expect(() =>
      normalizeReleaseDeviceRiskContract({
        schemaVersion: 1,
        requiredExactPaths: ['z.ts', 'a.ts'],
        requiredPathPrefixes: ['src/audio/'],
      }),
    ).toThrow(/sorted/u);
    expect(() =>
      normalizeReleaseDeviceRiskContract({
        schemaVersion: 1,
        requiredExactPaths: ['../outside.ts'],
        requiredPathPrefixes: ['src/audio/'],
      }),
    ).toThrow(/canonical/u);
  });

  it('matches runtime paths while excluding test-only files under sensitive prefixes', () => {
    const contract = readReleaseDeviceRiskContract();
    expect(
      classifyReleaseDeviceRisk(
        [
          'docs/README.md',
          'src/media/new-runtime-leaf.ts',
          'src/network/new-runtime-leaf.ts',
          'src/pro-room/playback-controller.ts',
          'src/share/new-runtime-leaf.ts',
          'src/storage/new-runtime-leaf.ts',
          'src/ui/player-controls.ts',
          'src/ui/range-drag.ts',
          'src/ui/seekbar.ts',
          'src/youtube/__tests__/iframe.test.ts',
          'src/youtube/iframe.ts',
          'public/service-worker.js',
        ],
        contract,
      ),
    ).toEqual({
      required: true,
      changedPaths: [
        'docs/README.md',
        'public/service-worker.js',
        'src/media/new-runtime-leaf.ts',
        'src/network/new-runtime-leaf.ts',
        'src/pro-room/playback-controller.ts',
        'src/share/new-runtime-leaf.ts',
        'src/storage/new-runtime-leaf.ts',
        'src/ui/player-controls.ts',
        'src/ui/range-drag.ts',
        'src/ui/seekbar.ts',
        'src/youtube/__tests__/iframe.test.ts',
        'src/youtube/iframe.ts',
      ],
      matchedPaths: [
        'public/service-worker.js',
        'src/media/new-runtime-leaf.ts',
        'src/network/new-runtime-leaf.ts',
        'src/pro-room/playback-controller.ts',
        'src/share/new-runtime-leaf.ts',
        'src/storage/new-runtime-leaf.ts',
        'src/ui/player-controls.ts',
        'src/ui/range-drag.ts',
        'src/ui/seekbar.ts',
        'src/youtube/iframe.ts',
      ],
    });
    expect(
      classifyReleaseDeviceRisk(['src/player/__tests__/playback.test.ts'], contract).required,
    ).toBe(false);
  });

  it('accepts only an exact canonical deployment message', () => {
    expect(releaseGitShaFromDeployment(deployment())).toBe(BASE_SHA);
    expect(
      releaseGitShaFromDeployment({
        ...deployment(),
        annotations: { 'workers/message': `prefix git:${BASE_SHA}` },
      }),
    ).toBeNull();
  });

  it('accepts provenance only from one fully active production version', () => {
    expect(
      releaseGitShaFromDeployment({
        annotations: { 'workers/message': `git:${BASE_SHA}` },
        versions: [
          { version_id: 'production', percentage: 100 },
          { version_id: 'inactive', percentage: 0 },
        ],
      }),
    ).toBeNull();
    expect(
      releaseGitShaFromDeployment({
        annotations: { 'workers/message': `git:${BASE_SHA}` },
        versions: [
          { version_id: 'first', percentage: 50 },
          { version_id: 'second', percentage: 50 },
        ],
      }),
    ).toBeNull();
    expect(
      releaseGitShaFromDeployment({ annotations: { 'workers/message': `git:${BASE_SHA}` } }),
    ).toBeNull();
    expect(
      releaseGitShaFromDeployment({
        annotations: { 'workers/message': `git:${BASE_SHA}` },
        versions: [{ version_id: '   ', percentage: 100 }],
      }),
    ).toBeNull();
  });

  it('fails closed when an app deployment has no Git provenance', () => {
    const report = evaluateReleaseDeviceRisk({
      target: 'app',
      headSha: HEAD_SHA,
      deployment: {},
      changedPaths: [],
      contract: readReleaseDeviceRiskContract(),
    });
    expect(report).toMatchObject({
      required: true,
      reason: 'unverifiable-current-app-deployment',
      baseSha: null,
    });
  });

  it('does not require browser evidence for a server-only deployment target', () => {
    const report = evaluateReleaseDeviceRisk({
      target: 'signaling',
      headSha: HEAD_SHA,
      deployment: {},
      changedPaths: ['src/youtube/iframe.ts'],
      contract: readReleaseDeviceRiskContract(),
    });
    expect(report).toMatchObject({
      required: false,
      reason: 'target-does-not-deploy-browser-app',
      changedPaths: [],
      matchedPaths: [],
    });
  });

  it('ignores a synchronized service-worker and index cache epoch-only bump', () => {
    const { directory, baseSha } = createRiskRepository();
    write(directory, 'public/service-worker.js', serviceWorker(2));
    write(directory, 'index.html', indexHtml(2));
    commit(directory, 'bump cache epoch');

    const result = runRisk(directory, baseSha);

    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({ required: false, matchedPaths: [] });
    expect(result.report.changedPaths).toEqual(['index.html', 'public/service-worker.js']);
  });

  it.each([
    [
      'service-worker behavior',
      (directory: string) => {
        write(
          directory,
          'public/service-worker.js',
          serviceWorker(2, "self.addEventListener('fetch', () => {});\n"),
        );
        write(directory, 'index.html', indexHtml(2));
      },
      'public/service-worker.js',
    ],
    [
      'index behavior',
      (directory: string) => {
        write(directory, 'public/service-worker.js', serviceWorker(2));
        write(directory, 'index.html', indexHtml(2, '<main>changed</main>\n'));
      },
      'index.html',
    ],
  ])('keeps %s changes high-risk beside an epoch bump', (_label, mutate, matchedPath) => {
    const { directory, baseSha } = createRiskRepository();
    mutate(directory);
    commit(directory, 'change browser behavior');

    const result = runRisk(directory, baseSha);

    expect(result.status).toBe(1);
    expect(result.report.required).toBe(true);
    expect(result.report.matchedPaths).toContain(matchedPath);
  });

  it('ignores a test-only addition under a sensitive runtime prefix', () => {
    const { directory, baseSha } = createRiskRepository();
    write(directory, 'src/youtube/__tests__/only.test.ts', 'it("passes", () => {});\n');
    commit(directory, 'add youtube test');

    const result = runRisk(directory, baseSha);

    expect(result.status).toBe(0);
    expect(result.report).toMatchObject({ required: false, matchedPaths: [] });
  });

  it.each([
    [
      'static import with extension resolution',
      'src/youtube/__tests__/runtime-helper.test.ts',
      "import '../youtube/__tests__/runtime-helper.test';\n",
    ],
    [
      'static re-export with an explicit extension',
      'src/youtube/__tests__/runtime-export.spec.ts',
      "export { testOnlyValue } from '../youtube/__tests__/runtime-export.spec.ts';\n",
    ],
    [
      'dynamic import with alias and index resolution',
      'src/youtube/__tests__/lazy-runtime/index.ts',
      "void import('@/youtube/__tests__/lazy-runtime');\n",
    ],
  ])(
    'fails closed when production uses a test-only module via %s',
    (_label, targetPath, source) => {
      const importerPath = 'src/ui/unprotected-runtime.ts';
      const { directory, baseSha } = createRiskRepository();
      write(directory, importerPath, source);
      write(directory, targetPath, 'export const testOnlyValue = true;\n');
      commit(directory, 'import test-only runtime module');

      const result = runRisk(directory, baseSha);

      expect(result.status).toBe(1);
      expect(result.report).toMatchObject({
        required: true,
        matchedPaths: [importerPath, targetPath],
      });
    },
  );

  it('keeps removal of a deployed production-to-test import high-risk', () => {
    const importerPath = 'src/ui/unprotected-runtime.ts';
    const targetPath = 'src/youtube/__tests__/runtime-helper.test.ts';
    const { directory, baseSha } = createRiskRepository({
      files: {
        [importerPath]: "import '../youtube/__tests__/runtime-helper.test';\n",
        [targetPath]: 'export const testOnlyValue = true;\n',
      },
    });
    write(directory, importerPath, 'export const runtimeValue = true;\n');
    rmSync(join(directory, targetPath));
    commit(directory, 'remove deployed test-only runtime import');

    const result = runRisk(directory, baseSha);

    expect(result.status).toBe(1);
    expect(result.report).toMatchObject({
      required: true,
      matchedPaths: [importerPath, targetPath],
    });
  });

  it('ignores QRCode-only package changes but catches a transitive PeerJS lock change', () => {
    const qrRepository = createRiskRepository();
    write(qrRepository.directory, 'package.json', fixturePackageManifest('^1.5.5', '^1.6.0'));
    write(
      qrRepository.directory,
      'package-lock.json',
      fixturePackageLock({
        qrcodeSpec: '^1.6.0',
        qrcodeVersion: '1.6.0',
        qrcodeIntegrity: 'sha512-qrcode-v2',
      }),
    );
    commit(qrRepository.directory, 'update qrcode');

    const qrResult = runRisk(qrRepository.directory, qrRepository.baseSha);
    expect(qrResult.status).toBe(0);
    expect(qrResult.report).toMatchObject({ required: false, matchedPaths: [] });

    const peerRepository = createRiskRepository();
    write(
      peerRepository.directory,
      'package-lock.json',
      fixturePackageLock({ sdpVersion: '3.3.0', sdpIntegrity: 'sha512-sdp-v2' }),
    );
    commit(peerRepository.directory, 'update peerjs transitive dependency');

    const peerResult = runRisk(peerRepository.directory, peerRepository.baseSha);
    expect(peerResult.status).toBe(1);
    expect(peerResult.report).toMatchObject({
      required: true,
      matchedPaths: ['package-lock.json'],
    });
  });

  it('detects a sensitive file renamed out of a protected prefix', () => {
    const { directory, baseSha } = createRiskRepository({
      files: { 'src/youtube/iframe.ts': 'export const iframe = true;\n' },
    });
    mkdirSync(join(directory, 'docs'), { recursive: true });
    git(directory, 'mv', 'src/youtube/iframe.ts', 'docs/iframe.ts');
    commit(directory, 'move runtime into docs');

    const result = runRisk(directory, baseSha);

    expect(result.status).toBe(1);
    expect(result.report.matchedPaths).toContain('src/youtube/iframe.ts');
    expect(result.report.changedPaths).toEqual(
      expect.arrayContaining(['docs/iframe.ts', 'src/youtube/iframe.ts']),
    );
  });

  it('classifies against the union of the deployed and candidate contracts', () => {
    const baseContract = fixtureContract({
      requiredExactPaths: ['src/legacy-risk.ts'],
      requiredPathPrefixes: ['src/youtube/'],
    });
    const { directory, baseSha } = createRiskRepository({
      contract: baseContract,
      files: { 'src/legacy-risk.ts': 'export const value = 1;\n' },
    });
    write(
      directory,
      'cloudflare/release-device-risk.contract.json',
      `${JSON.stringify(
        fixtureContract({
          requiredExactPaths: ['src/new-risk.ts'],
          requiredPathPrefixes: ['src/youtube/'],
        }),
        null,
        2,
      )}\n`,
    );
    write(directory, 'src/legacy-risk.ts', 'export const value = 2;\n');
    commit(directory, 'replace contract boundary');

    const result = runRisk(directory, baseSha);

    expect(result.status).toBe(1);
    expect(result.report.matchedPaths).toContain('src/legacy-risk.ts');
  });

  it('enforces the policy before the release authorizes any production mutation', () => {
    const workflow = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const riskGate = workflow.indexOf('Enforce risk-based physical-device evidence');
    const checkpoint = workflow.indexOf('Capture immutable Worker and R2 recovery checkpoint');
    const authorization = workflow.indexOf('Authorize production mutation');
    expect(riskGate).toBeGreaterThan(workflow.indexOf('Verify Cloudflare credentials'));
    expect(checkpoint).toBeGreaterThan(riskGate);
    expect(authorization).toBeGreaterThan(riskGate);
    expect(workflow).toContain('scripts/release-device-risk.mjs');
    expect(workflow).toContain('${{ inputs.require_real_device_evidence }}');
    expect(workflow).toContain('$RUNNER_TEMP/app-device-risk-baseline.json');
    expect(workflow).not.toContain('release-artifacts/deployments/app-device-risk-baseline.json');

    for (const name of [
      'Disable PRO room generation cutover before failed-release rollback',
      'Restore release-owned Workers after a failed release',
      'Reconcile R2 policy with the exact recovered Worker boundary',
    ]) {
      expect(workflowStepSource(workflow, name)).toContain(
        "steps.mutation_authorization.outputs.authorized == 'true'",
      );
    }
    const independentRecoveryJob = workflow.slice(workflow.indexOf('\n  recovery:'));
    expect(independentRecoveryJob).toContain("needs.deploy.outputs.mutation_authorized == 'true'");

    const recoveryWorkflow = readFileSync(
      resolve('.github/workflows/release-recovery.yml'),
      'utf8',
    );
    for (const name of [
      'Reassert disabled PRO generation fence',
      'Restore release-owned Workers or record a forward-repair boundary',
      'Reconcile persisted R2 policy with recovered Workers',
    ]) {
      expect(workflowStepSource(recoveryWorkflow, name)).toContain(
        "inputs.mutation_authorized == 'true'",
      );
    }
  });
});
