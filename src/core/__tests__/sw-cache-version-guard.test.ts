import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPT_PATH = resolve(process.cwd(), 'scripts', 'check-sw-cache-version.mjs');
const temporaryDirectories: string[] = [];

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

function serviceWorker(version: number, extra = ''): string {
  return `'use strict';\nconst CACHE_VERSION = 'v${version}';\n${extra}`;
}

function commit(directory: string, message: string): string {
  git(directory, 'add', '--all');
  git(directory, '-c', 'commit.gpgsign=false', 'commit', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
}

function createRepository(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mxqr-sw-guard-'));
  temporaryDirectories.push(directory);
  git(directory, 'init', '--initial-branch=main');
  git(directory, 'config', 'user.email', 'guard@example.invalid');
  git(directory, 'config', 'user.name', 'SW Guard Test');

  write(directory, 'public/service-worker.js', serviceWorker(1));
  write(directory, 'src/app.ts', 'export const app = true;\n');
  commit(directory, 'initial app');

  write(directory, 'public/service-worker.js', serviceWorker(2));
  commit(directory, 'bump cache to v2');
  return directory;
}

function runGuard(directory: string, ...args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT_PATH, '--repo', directory, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('service-worker CACHE_VERSION guard', () => {
  it('is wired into checked builds with full CI and release history', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    const ciWorkflow = readFileSync(
      resolve(process.cwd(), '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const releaseWorkflow = readFileSync(
      resolve(process.cwd(), '.github', 'workflows', 'release.yml'),
      'utf8',
    );

    expect(packageJson.scripts['build:checked']).toContain('guard:sw-cache-version');
    expect(packageJson.scripts['guard:sw-cache-version']).toContain('check-sw-cache-version.mjs');
    expect(ciWorkflow).toMatch(/Checkout[\s\S]*?fetch-depth:\s*0/u);
    expect(releaseWorkflow).toMatch(/Checkout exact release commit[\s\S]*?fetch-depth:\s*0/u);
  });

  it('rejects a runtime app commit newer than the latest bump', () => {
    const repository = createRepository();
    write(repository, 'src/player.ts', 'export const player = true;\n');
    commit(repository, 'change player');

    const result = runGuard(repository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('committed PWA runtime changes are newer than v2');
    expect(result.stderr).toContain('src/player.ts');
  });

  it('accepts a separate follow-up bump commit', () => {
    const repository = createRepository();
    write(repository, 'src/player.ts', 'export const player = true;\n');
    commit(repository, 'change player');
    expect(runGuard(repository).status).toBe(1);

    write(repository, 'public/service-worker.js', serviceWorker(3));
    commit(repository, 'bump cache to v3');

    const result = runGuard(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: v3');
  });

  it('accepts a runtime change and bump in the same commit', () => {
    const repository = createRepository();
    write(repository, 'src/player.ts', 'export const player = true;\n');
    write(repository, 'public/service-worker.js', serviceWorker(3));
    commit(repository, 'change player and bump cache');

    const result = runGuard(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: v3');
  });

  it('allows backend, repository docs, test-only, and promo workshop changes', () => {
    const repository = createRepository();
    write(repository, 'cloudflare/app-worker.js', 'export default {};\n');
    write(repository, 'docs/runbook.md', '# Runbook\n');
    write(repository, 'src/core/__tests__/only.test.ts', 'it("passes", () => {});\n');
    write(repository, 'e2e/release.test.ts', 'export {};\n');
    write(repository, '.workshop/promo/render.ts', 'export {};\n');
    write(repository, 'scripts/maintenance.mjs', 'export {};\n');
    commit(repository, 'update non-runtime files');

    const result = runGuard(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: v2');
  });

  it('treats public pages and built workshop inputs as PWA runtime changes', () => {
    const repository = createRepository();
    write(repository, '.workshop/faq/faq.html', '<p>Updated FAQ</p>\n');
    commit(repository, 'update public FAQ');

    const result = runGuard(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.workshop/faq/faq.html');
  });

  it('rejects service-worker behavior changes without a version bump', () => {
    const repository = createRepository();
    write(
      repository,
      'public/service-worker.js',
      serviceWorker(2, "self.addEventListener('fetch', () => {});\n"),
    );
    commit(repository, 'change service worker behavior');

    const result = runGuard(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('public/service-worker.js');
  });

  it('still detects a runtime deletion when git recognizes a rename into docs', () => {
    const repository = createRepository();
    write(repository, 'src/renamed.ts', 'export const renamed = true;\n');
    commit(repository, 'add runtime module and bump later');
    write(repository, 'public/service-worker.js', serviceWorker(3));
    commit(repository, 'bump cache to v3');

    mkdirSync(join(repository, 'docs'), { recursive: true });
    git(repository, 'mv', 'src/renamed.ts', 'docs/renamed.ts');
    commit(repository, 'move runtime module into docs');

    const result = runGuard(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/renamed.ts');
  });

  it('does not accept a CACHE_VERSION rollback as a bump', () => {
    const repository = createRepository();
    write(repository, 'public/service-worker.js', serviceWorker(1));
    commit(repository, 'accidentally roll cache backwards');

    const result = runGuard(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must increase monotonically');
    expect(result.stderr).toContain('v2 became v1');
  });

  it('fails closed when checkout history is shallow', () => {
    const source = createRepository();
    const clone = mkdtempSync(join(tmpdir(), 'mxqr-sw-guard-shallow-'));
    temporaryDirectories.push(clone);
    rmSync(clone, { recursive: true, force: true });

    execFileSync('git', ['clone', '--depth=1', pathToFileURL(source).href, clone], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const result = runGuard(clone);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('shallow history');
    expect(result.stderr).toContain('fetch-depth: 0');
  });
});
