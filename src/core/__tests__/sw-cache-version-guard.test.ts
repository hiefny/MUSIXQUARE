import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPT_PATH = resolve(process.cwd(), 'scripts', 'check-sw-cache-version.mts');
const SERVICE_WORKER_MANIFEST_PATH = 'scripts/service-worker-asset.ts';
const LEGACY_SERVICE_WORKER_PATH = 'public/service-worker.js';
const temporaryDirectories: string[] = [];

interface FixturePackageManifest {
  name: string;
  private: boolean;
  version?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
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

function serviceWorker(version: number, extra = ''): string {
  return `'use strict';\nconst CACHE_VERSION = 'v${version}';\n${extra}`;
}

function serviceWorkerManifest(version: number): string {
  return `export const SERVICE_WORKER_CACHE_VERSION = 'v${version}';\n`;
}

function packageManifest(overrides: Partial<FixturePackageManifest> = {}): string {
  const manifest: FixturePackageManifest = {
    name: 'guard-fixture',
    private: true,
    scripts: {
      dev: 'vite',
      build: 'vite build',
      'build:checked': 'npm run build && npm run guard',
      test: 'vitest run',
    },
    dependencies: {
      peerjs: '1.5.5',
    },
    devDependencies: {
      vite: '6.4.3',
    },
    ...overrides,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
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

  write(directory, SERVICE_WORKER_MANIFEST_PATH, serviceWorkerManifest(1));
  write(directory, 'browser/service-worker.ts', 'self.addEventListener("fetch", () => {});\n');
  write(directory, 'src/app.ts', 'export const app = true;\n');
  write(directory, 'package.json', packageManifest());
  commit(directory, 'initial app');

  write(directory, SERVICE_WORKER_MANIFEST_PATH, serviceWorkerManifest(2));
  commit(directory, 'bump cache to v2');
  return directory;
}

// Joined so this fixture text is not a relative Worker import literal: the
// suite never loads Worker code, so it stays out of the Worker coverage
// ratchet (ci-quality-gates.test.ts).
function workerModule(depth: number, file: string): string {
  return [...Array<string>(depth).fill('..'), 'cloudflare', file].join('/');
}

// Worker-side modules that browser code imports are compiled into the App
// bundle, so a change to only such a module still changes cached PWA assets.
function createRepositoryWithBundledWorkerModules(): string {
  const repository = createRepository();
  write(repository, 'cloudflare/shared-timing.ts', 'export const TIMEOUT_MS = 1_000;\n');
  write(
    repository,
    'cloudflare/media-reader.ts',
    "import { readBody } from './media-body.ts';\nexport const read = readBody;\n",
  );
  write(repository, 'cloudflare/media-body.ts', 'export const readBody = () => 1;\n');
  write(repository, 'cloudflare/admin-contract.ts', 'export const ADMIN_CONTRACT = 1;\n');
  write(repository, 'cloudflare/worker-only-timing.ts', 'export const WORKER_TIMEOUT_MS = 8;\n');
  write(
    repository,
    'cloudflare/app-worker.ts',
    "import { WORKER_TIMEOUT_MS } from './worker-only-timing.ts';\nexport default { WORKER_TIMEOUT_MS };\n",
  );
  write(repository, 'cloudflare/type-shapes.ts', 'export interface Shape {\n  id: string;\n}\n');
  write(repository, 'cloudflare/test-fixture-data.ts', 'export const fixture = 1;\n');
  write(repository, 'cloudflare/promo-only.ts', 'export const promo = 1;\n');
  write(
    repository,
    'src/pro-room/playback.ts',
    [
      'import {',
      '  TIMEOUT_MS,',
      `} from '${workerModule(2, 'shared-timing.ts')}';`,
      `import type { Shape } from '${workerModule(2, 'type-shapes.ts')}';`,
      'export const timeout: Shape | number = TIMEOUT_MS;',
      '',
    ].join('\n'),
  );
  write(
    repository,
    'src/pro-room/upload.ts',
    `export const load = () => import('${workerModule(2, 'media-reader.ts')}');\n`,
  );
  write(
    repository,
    'browser/classic-runtime/admin.ts',
    `export { ADMIN_CONTRACT } from '${workerModule(2, 'admin-contract.ts')}';\n`,
  );
  write(
    repository,
    'src/pro-room/__tests__/upload.test.ts',
    `import { fixture } from '${workerModule(3, 'test-fixture-data.ts')}';\nit('loads', () => expect(fixture).toBe(1));\n`,
  );
  write(
    repository,
    'browser/auxiliary-runtime/promo/study.ts',
    `export { promo } from '${workerModule(3, 'promo-only.ts')}';\n`,
  );
  write(
    repository,
    'cloudflare/type-reexport.ts',
    'export interface Reexported {\n  id: string;\n}\n',
  );
  write(
    repository,
    'src/pro-room/shapes.ts',
    `export type { Reexported } from '${workerModule(2, 'type-reexport.ts')}';\n`,
  );
  write(repository, 'cloudflare/url-asset.ts', 'export const worklet = true;\n');
  write(repository, 'cloudflare/location-url.ts', 'export const notBundled = true;\n');
  write(repository, 'cloudflare/commented-entry.ts', 'export const retired = true;\n');
  write(
    repository,
    'src/audio/worklet.ts',
    [
      `export const workletUrl = new URL('${workerModule(2, 'url-asset.ts')}', import.meta.url);`,
      `export const pageUrl = new URL('${workerModule(2, 'location-url.ts')}', location.href);`,
      `// export const retired = () => import('${workerModule(2, 'commented-entry.ts')}');`,
      '',
    ].join('\n'),
  );
  write(repository, 'cloudflare/html-entry.ts', 'export const boot = true;\n');
  write(
    repository,
    'index.html',
    [
      '<!doctype html>',
      '<!-- <script type="module" src="/cloudflare/commented-entry.ts"></script> -->',
      '<script type="module" src="/cloudflare/html-entry.ts"></script>',
      '',
    ].join('\n'),
  );
  write(repository, SERVICE_WORKER_MANIFEST_PATH, serviceWorkerManifest(3));
  commit(repository, 'bundle shared Worker modules and bump cache');
  return repository;
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
    expect(packageJson.scripts['guard:sw-cache-version']).toContain('check-sw-cache-version.mts');
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

  it.each([
    ['browser/classic-runtime/wordmark-anim.ts', 'document.body.dataset.ready = "true";\n'],
    ['browser/service-worker.ts', 'self.addEventListener("message", () => {});\n'],
    ['browser/auxiliary-runtime/promo-next.ts', 'export const runtime = true;\n'],
    ['browser/auxiliary-runtime/promo-next/entry.ts', 'export const runtime = true;\n'],
    ['scripts/classic-runtime-assets.ts', 'export const target = "wordmark-anim.js";\n'],
    ['browser/ui-kit/app/entry.tsx', 'document.body.dataset.kit = "ready";\n'],
    ['scripts/ui-kit-asset.ts', 'export const target = "app.js";\n'],
    ['scripts/materialize-localized-html.mts', 'export const output = "localized.html";\n'],
    ['scripts/localized-html-lib.mts', 'export const title = "changed";\n'],
    ['scripts/locale-seo-metadata.mts', 'export const locale = "changed";\n'],
    ['scripts/service-worker-app-shell-guard-lib.mts', 'export const worker = "changed.js";\n'],
    ['scripts/browser-target.ts', "export const LEGACY_APP_BROWSER_TARGET = 'chrome80';\n"],
    ['scripts/locale-recovery-assets.ts', 'export const recovery = "changed";\n'],
    ['fonts/noto/noto-sans-devanagari/devanagari.woff2', 'updated locale font bytes'],
    ['fonts/inter/inter-latin.woff2', 'updated app font bytes'],
    ['tsconfig.ui-kit.json', '{"compilerOptions":{"strict":true}}\n'],
  ])('tracks the browser build input %s as a PWA runtime change', (filePath, source) => {
    const repository = createRepository();
    write(repository, filePath, source);
    commit(repository, 'change classic runtime build input');

    const result = runGuard(repository);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(filePath);
  });

  it('accepts a separate follow-up bump commit', () => {
    const repository = createRepository();
    write(repository, 'src/player.ts', 'export const player = true;\n');
    commit(repository, 'change player');
    expect(runGuard(repository).status).toBe(1);

    write(repository, SERVICE_WORKER_MANIFEST_PATH, serviceWorkerManifest(3));
    commit(repository, 'bump cache to v3');

    const result = runGuard(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: v3');
  });

  it('accepts a runtime change and bump in the same commit', () => {
    const repository = createRepository();
    write(repository, 'src/player.ts', 'export const player = true;\n');
    write(repository, SERVICE_WORKER_MANIFEST_PATH, serviceWorkerManifest(3));
    commit(repository, 'change player and bump cache');

    const result = runGuard(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: v3');
  });

  it('allows backend, repository docs, test-only, and promo workshop changes', () => {
    const repository = createRepository();
    write(repository, 'cloudflare/app-worker.ts', 'export default {};\n');
    write(repository, 'docs/runbook.md', '# Runbook\n');
    write(repository, 'fonts/README.md', '# Font licensing and maintenance\n');
    write(repository, 'src/core/__tests__/only.test.ts', 'it("passes", () => {});\n');
    write(repository, 'e2e/release.test.ts', 'export {};\n');
    write(repository, '.workshop/promo/render.ts', 'export {};\n');
    write(repository, 'scripts/maintenance.mjs', 'export {};\n');
    commit(repository, 'update non-runtime files');

    const result = runGuard(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: v2');
  });

  it.each([
    ['a multi-line static import', 'cloudflare/shared-timing.ts'],
    ['a dynamic import()', 'cloudflare/media-reader.ts'],
    ['a dynamically imported module', 'cloudflare/media-body.ts'],
    ['an export-from in browser/', 'cloudflare/admin-contract.ts'],
  ])('treats a Worker module the App bundle reaches through %s as PWA runtime', (_label, file) => {
    const repository = createRepositoryWithBundledWorkerModules();
    expect(runGuard(repository).status).toBe(0);

    write(repository, file, 'export const changed = true;\n');
    commit(repository, `change only ${file}`);

    const result = runGuard(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('committed PWA runtime changes are newer than v3');
    expect(result.stderr).toContain(file);
  });

  it('keeps Worker-only, type-only, test-only, and promo-only Worker imports out of the PWA', () => {
    const repository = createRepositoryWithBundledWorkerModules();
    for (const file of [
      'cloudflare/app-worker.ts',
      'cloudflare/worker-only-timing.ts',
      'cloudflare/type-shapes.ts',
      'cloudflare/type-reexport.ts',
      'cloudflare/location-url.ts',
      'cloudflare/commented-entry.ts',
      'cloudflare/test-fixture-data.ts',
      'cloudflare/promo-only.ts',
    ]) {
      write(repository, file, 'export const changed = true;\n');
    }
    commit(repository, 'change modules the App bundle does not contain');

    const result = runGuard(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: v3');
  });

  it('derives the fixture bundle from every reference kind the build follows', async () => {
    const { bundledSupportPathsAt } = await import('../../../scripts/check-sw-cache-version.mts');
    const repository = createRepositoryWithBundledWorkerModules();

    // Static, dynamic, transitive, and export-from imports, a
    // new URL(..., import.meta.url) asset, and an index.html script. Not a
    // type-only re-export, a URL resolved against the page, a commented-out
    // import() or script tag, or anything only Workers, tests, or promo
    // studies import.
    expect(bundledSupportPathsAt(repository, 'HEAD')).toEqual(
      [
        'cloudflare/admin-contract.ts',
        'cloudflare/html-entry.ts',
        'cloudflare/media-body.ts',
        'cloudflare/media-reader.ts',
        'cloudflare/shared-timing.ts',
        'cloudflare/url-asset.ts',
      ].sort(),
    );
  });

  it('counts a module the bump commit bundled after the App stops importing it', () => {
    const repository = createRepositoryWithBundledWorkerModules();
    write(repository, 'cloudflare/shared-timing.ts', 'export const TIMEOUT_MS = 2_000;\n');
    write(repository, 'src/pro-room/playback.ts', 'export const timeout = 2_000;\n');
    commit(repository, 'change the module and stop bundling it');

    const stopped = runGuard(repository);
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain('src/pro-room/playback.ts');
    expect(stopped.stderr).toContain('cloudflare/shared-timing.ts');
  });

  // Two guard runs, each building the import graph at both ends of its range.
  // The three-run test this replaced took about 12 seconds on a loaded Windows
  // machine, close to the 15-second default, so this one gets more room.
  it(
    'counts a module the App imports again after a bump that did not bundle it',
    {
      timeout: 30_000,
    },
    () => {
      const repository = createRepositoryWithBundledWorkerModules();
      write(repository, 'cloudflare/shared-timing.ts', 'export const TIMEOUT_MS = 2_000;\n');
      write(repository, 'src/pro-room/playback.ts', 'export const timeout = 2_000;\n');
      write(repository, SERVICE_WORKER_MANIFEST_PATH, serviceWorkerManifest(4));
      commit(repository, 'stop bundling the module and bump cache to v4');
      write(repository, 'cloudflare/shared-timing.ts', 'export const TIMEOUT_MS = 3_000;\n');
      commit(repository, 'change the module the App no longer bundles');
      expect(runGuard(repository).status).toBe(0);

      write(
        repository,
        'src/pro-room/playback.ts',
        `export * from '${workerModule(2, 'shared-timing.ts')}';\n`,
      );
      commit(repository, 'bundle the module again');
      const restarted = runGuard(repository);
      expect(restarted.status).toBe(1);
      expect(restarted.stderr).toContain('src/pro-room/playback.ts');
      expect(restarted.stderr).toContain('cloudflare/shared-timing.ts');
    },
  );

  it('derives the bundled Worker modules of this repository from its import graph', async () => {
    const { bundledSupportPathsAt } = await import('../../../scripts/check-sw-cache-version.mts');
    const { runtimePathsForWorker } = await import('../../../scripts/release-deployment-state.mts');
    const bundled = bundledSupportPathsAt(process.cwd(), 'HEAD');

    // Modules src/ imports statically, through a dynamic import, and one hop
    // further inside cloudflare/.
    expect(bundled).toEqual(
      expect.arrayContaining([
        'cloudflare/app-build-floor-contract.ts',
        'cloudflare/display-name-policy.ts',
        'cloudflare/pro-room-receipt-timing.ts',
        'cloudflare/pro-room-media-duration.ts',
        'cloudflare/pro-room-body.ts',
        'cloudflare/pro-room-mp4-duration.ts',
      ]),
    );
    // Imported only by Workers.
    expect(bundled).not.toContain('cloudflare/app-worker.ts');
    expect(bundled).not.toContain('cloudflare/pro-room-media-timing.ts');
    // Whatever the App bundle compiles in must also ship with an App release.
    const appReleasePaths = runtimePathsForWorker('app');
    for (const file of bundled) expect(appReleasePaths).toContain(file);
  });

  it('allows removing retired promo studies without exempting adjacent browser runtime', () => {
    const repository = createRepository();
    const promoSource = 'browser/auxiliary-runtime/promo/logo-animation.ts';
    write(repository, promoSource, 'export const study = true;\n');
    commit(repository, 'add local promo study');
    expect(runGuard(repository).status).toBe(0);

    rmSync(join(repository, promoSource));
    commit(repository, 'retire local promo study');
    expect(runGuard(repository).status).toBe(0);

    write(repository, 'browser/classic-runtime/wordmark-anim.ts', 'export const app = true;\n');
    commit(repository, 'change actual app wordmark');
    const result = runGuard(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser/classic-runtime/wordmark-anim.ts');
  });

  it('allows only the reviewed Static Assets build-policy transition', () => {
    const repository = createRepository();
    const manifest = JSON.parse(packageManifest()) as FixturePackageManifest;
    manifest.scripts.build = 'vite build && node scripts/materialize-app-static-headers.mts';
    write(repository, 'package.json', `${JSON.stringify(manifest)}\n`);
    write(repository, 'scripts/materialize-app-static-headers.mts', 'export {};\n');
    commit(repository, 'materialize static asset headers after build');

    const result = runGuard(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: v2');
  });

  it.each([
    [
      'runtime dependency',
      (manifest: FixturePackageManifest) => (manifest.dependencies.peerjs = '2.0.0'),
    ],
    [
      'development dependency',
      (manifest: FixturePackageManifest) => (manifest.devDependencies.vite = '7.0.0'),
    ],
    [
      'another script',
      (manifest: FixturePackageManifest) => (manifest.scripts.dev = 'vite --host 0.0.0.0'),
    ],
    ['package metadata', (manifest: FixturePackageManifest) => (manifest.version = '8.0.0')],
  ])('does not hide a concurrent %s change in package.json', (_label, mutate) => {
    const repository = createRepository();
    const manifest = JSON.parse(packageManifest()) as FixturePackageManifest;
    manifest.scripts.build = 'vite build && node scripts/materialize-app-static-headers.mts';
    mutate(manifest);
    write(repository, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`);
    commit(repository, 'mix build policy with another package change');

    const result = runGuard(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package.json');
  });

  it('rejects an arbitrary or extended build command without a cache bump', () => {
    const repository = createRepository();
    const manifest = JSON.parse(packageManifest()) as FixturePackageManifest;
    manifest.scripts.build =
      'vite build && node scripts/materialize-app-static-headers.mts && node scripts/extra.mjs';
    write(repository, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`);
    commit(repository, 'extend build command');

    const result = runGuard(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package.json');
  });

  it.each([
    ['package-lock.json', '{"lockfileVersion":3}\n'],
    ['vite.config.ts', 'export default { build: { target: "esnext" } };\n'],
  ])('keeps %s classified as runtime beside the allowed package transition', (filePath, source) => {
    const repository = createRepository();
    const manifest = JSON.parse(packageManifest()) as FixturePackageManifest;
    manifest.scripts.build = 'vite build && node scripts/materialize-app-static-headers.mts';
    write(repository, 'package.json', `${JSON.stringify(manifest, null, 2)}\n`);
    write(repository, filePath, source);
    commit(repository, 'mix build policy with another build input');

    const result = runGuard(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(filePath);
  });

  it.each([
    '.workshop/faq/faq.html',
    '.workshop/sitemap/sitemap.html',
    '.workshop/sitemap/main.ts',
    '.workshop/sitemap/sitemap.css',
    '.workshop/translate/translate.html',
    '.workshop/translate/catalog-client.ts',
    'scripts/translation-catalog.ts',
    'scripts/translation-catalog-assets.ts',
  ])('treats public pages and built translation input %s as PWA runtime changes', (filePath) => {
    const repository = createRepository();
    write(repository, filePath, '<p>Updated public content</p>\n');
    commit(repository, 'update public FAQ');

    const result = runGuard(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(filePath);
  });

  it('rejects service-worker behavior changes without a version bump', () => {
    const repository = createRepository();
    write(
      repository,
      'browser/service-worker.ts',
      'self.addEventListener("fetch", () => {});\nself.skipWaiting();\n',
    );
    commit(repository, 'change service worker behavior');

    const result = runGuard(repository);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('browser/service-worker.ts');
  });

  it('still detects a runtime deletion when git recognizes a rename into docs', () => {
    const repository = createRepository();
    write(repository, 'src/renamed.ts', 'export const renamed = true;\n');
    commit(repository, 'add runtime module and bump later');
    write(repository, SERVICE_WORKER_MANIFEST_PATH, serviceWorkerManifest(3));
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
    write(repository, SERVICE_WORKER_MANIFEST_PATH, serviceWorkerManifest(1));
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

  it('follows cache history across the legacy public worker to compiler-manifest cutover', () => {
    const repository = createRepository();
    rmSync(join(repository, SERVICE_WORKER_MANIFEST_PATH));
    write(repository, LEGACY_SERVICE_WORKER_PATH, serviceWorker(2));
    commit(repository, 'restore a legacy service-worker history point');

    rmSync(join(repository, LEGACY_SERVICE_WORKER_PATH));
    write(repository, SERVICE_WORKER_MANIFEST_PATH, serviceWorkerManifest(3));
    commit(repository, 'move the cache epoch into the compiler manifest');

    const result = runGuard(repository);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: v3');
  });
});
