import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAppStaticHeadersMaterialized,
  materializeAppStaticHeaders,
} from '../../../scripts/materialize-app-static-headers.mjs';

const stagingConfig = readFileSync(resolve('cloudflare/wrangler.app-assets-staging.toml'), 'utf8');
const productionConfig = readFileSync(resolve('cloudflare/wrangler.app.toml'), 'utf8');
const productionWorker = readFileSync(resolve('cloudflare/app-worker.js'), 'utf8');
const worker = readFileSync(resolve('cloudflare/app-assets-staging-worker.js'), 'utf8');
const headers = readFileSync(resolve('cloudflare/app-static-assets/_headers'), 'utf8');
const productionBuildGuard = readFileSync(
  resolve('scripts/assert-production-build-clean.mjs'),
  'utf8',
);
const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function workerRunsFirst(pathname: string): boolean {
  const bypass = /^\/assets\/.*\.(?:js|css|woff2)$/.test(pathname);
  return !bypass;
}

describe('App Static Assets routing and isolated staging probe', () => {
  it('has no production route or production data binding', () => {
    expect(stagingConfig).toContain('name = "musixquare-app-assets-staging"');
    expect(stagingConfig).toContain('main = "app-assets-staging-worker.js"');
    expect(stagingConfig).toContain('workers_dev = true');
    expect(stagingConfig).not.toMatch(
      /\[\[(?:routes|r2_buckets|kv_namespaces|d1_databases|services)\]\]/,
    );
    expect(stagingConfig).not.toContain('durable_objects');
    expect(worker).toContain("headers.set('X-MXQR-Staging-Isolation', 'no-production-bindings')");
  });

  it('bypasses only current Vite asset types', () => {
    for (const config of [stagingConfig, productionConfig]) {
      expect(config).toContain('"!/assets/*.js"');
      expect(config).toContain('"!/assets/*.css"');
      expect(config).toContain('"!/assets/*.woff2"');
    }
    expect(productionConfig).toContain(
      'run_worker_first = ["/*", "!/assets/*.js", "!/assets/*.css", "!/assets/*.woff2"]',
    );
    expect(workerRunsFirst('/assets/main-12345678.js')).toBe(false);
    expect(workerRunsFirst('/assets/main-12345678.css')).toBe(false);
    expect(workerRunsFirst('/assets/font-12345678.woff2')).toBe(false);

    for (const pathname of [
      '/',
      '/000001',
      '/api/security-config',
      '/service-worker.js',
      '/bootstrap.js',
      '/fouc-cleanup.js',
      '/manifest.webmanifest',
      '/assets/future.wasm',
      '/assets',
    ]) {
      expect(workerRunsFirst(pathname), pathname).toBe(true);
    }
  });

  it('keeps cache, nosniff, CSP and CORS behavior explicit', () => {
    expect(headers).toContain('/assets/*');
    expect(headers).toContain('Cache-Control: public, max-age=31536000, immutable');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Content-Security-Policy:');
    expect(headers).not.toContain('Content-Type:');
    expect(headers).not.toContain('Access-Control-Allow-Origin:');

    const directives = headers
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line !== '/assets/*')
      .map((line) => {
        const separator = line.indexOf(':');
        return [line.slice(0, separator), line.slice(separator + 1).trim()] as const;
      });
    for (const [name, value] of directives.filter(([name]) => name !== 'Cache-Control')) {
      expect(productionWorker, name).toContain(`'${name}'`);
      expect(productionWorker, `${name} value`).toContain(value);
      expect(worker, `${name} staging value`).toContain(value);
    }
  });

  it('keeps the service worker and public source tree outside the header materialization', () => {
    expect(existsSync(resolve('public/_headers'))).toBe(false);
    expect(packageJson.scripts.build).toContain('materialize-app-static-headers.mjs');
    expect(productionBuildGuard).toContain('assertAppStaticHeadersMaterialized');
    expect(productionBuildGuard).not.toContain('materializeAppStaticHeaders');
    expect(productionConfig).toContain('"/*"');
    expect(workerRunsFirst('/service-worker.js')).toBe(true);
    expect(workerRunsFirst('/bootstrap.js')).toBe(true);
  });

  it('copies the canonical headers byte-for-byte into a prepared output directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mxqr-static-headers-'));
    const sourcePath = join(root, '_headers-source');
    const outputDirectory = join(root, 'dist');
    try {
      await mkdir(join(outputDirectory, 'assets'), { recursive: true });
      await Promise.all([
        writeFile(join(outputDirectory, 'assets', 'main-Ab12_cd3.js'), '', 'utf8'),
        writeFile(join(outputDirectory, 'assets', 'style-Ef45Gh67.css'), '', 'utf8'),
        writeFile(join(outputDirectory, 'assets', 'font-12ab_CD-.woff2'), '', 'utf8'),
      ]);
      await writeFile(sourcePath, headers, 'utf8');
      const result = await materializeAppStaticHeaders({ sourcePath, outputDirectory });
      expect(await readFile(result.outputPath, 'utf8')).toBe(headers);
      await expect(
        assertAppStaticHeadersMaterialized({ sourcePath, outputDirectory }),
      ).resolves.toEqual(result);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a bypassed asset lacks a Vite content hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mxqr-static-unhashed-'));
    const sourcePath = join(root, '_headers-source');
    const outputDirectory = join(root, 'dist');
    try {
      await mkdir(join(outputDirectory, 'assets'), { recursive: true });
      await writeFile(join(outputDirectory, 'assets', 'app.js'), '', 'utf8');
      await writeFile(sourcePath, headers, 'utf8');
      await expect(materializeAppStaticHeaders({ sourcePath, outputDirectory })).rejects.toThrow(
        /eight-character Vite content hash/u,
      );
      expect(existsSync(join(outputDirectory, '_headers'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when built headers are missing or drift from the canonical bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mxqr-static-drift-'));
    const sourcePath = join(root, '_headers-source');
    const outputDirectory = join(root, 'dist');
    try {
      await mkdir(join(outputDirectory, 'assets'), { recursive: true });
      await writeFile(join(outputDirectory, 'assets', 'main-Ab12_cd3.js'), '', 'utf8');
      await writeFile(sourcePath, headers, 'utf8');
      await expect(
        assertAppStaticHeadersMaterialized({ sourcePath, outputDirectory }),
      ).rejects.toThrow(/missing/u);

      await writeFile(join(outputDirectory, '_headers'), `${headers}# drift\n`, 'utf8');
      await expect(
        assertAppStaticHeadersMaterialized({ sourcePath, outputDirectory }),
      ).rejects.toThrow(/differ from the canonical source/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
