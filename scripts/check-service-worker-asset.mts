import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  SERVICE_WORKER_CACHE_VERSION,
  SERVICE_WORKER_OUTPUT_PATH,
  assertServiceWorkerJavaScript,
  assertServiceWorkerSourceCompleteness,
  compileServiceWorkerAsset,
} from './service-worker-asset.ts';

const repoRoot = resolve(import.meta.dirname, '..');
await assertServiceWorkerSourceCompleteness(repoRoot);
await compileServiceWorkerAsset(repoRoot);

function readInjectedManifest(code: string, declaration: string): string[] {
  const match = new RegExp(`\\bconst\\s+${declaration}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`, 'u').exec(
    code,
  );
  const body = match?.[1];
  if (body === undefined) throw new Error(`Built service worker is missing ${declaration}.`);
  return [...body.matchAll(/"(?:\\.|[^"\\])*"/gu)].map((entry) => {
    const parsed: unknown = JSON.parse(entry[0]);
    if (typeof parsed !== 'string') throw new Error(`Invalid ${declaration} entry.`);
    return parsed;
  });
}

if (process.argv.includes('--dist')) {
  const distDirectory = resolve(repoRoot, 'dist');
  const builtPath = resolve(distDirectory, SERVICE_WORKER_OUTPUT_PATH);
  const built = await readFile(builtPath, 'utf8');
  assertServiceWorkerJavaScript(built);
  const files = await readdir(distDirectory);
  if (files.includes(`${SERVICE_WORKER_OUTPUT_PATH}.map`)) {
    throw new Error(`Service-worker sourcemap must not exist: ${SERVICE_WORKER_OUTPUT_PATH}.map`);
  }

  const expected = await compileServiceWorkerAsset(repoRoot, {
    buildEntryAssets: readInjectedManifest(built, 'BUILD_ENTRY_ASSETS'),
    optionalPrimaryFontAssets: readInjectedManifest(built, 'OPTIONAL_PRIMARY_FONT_ASSETS'),
  });
  if (built !== expected.code) {
    throw new Error(`Built /${SERVICE_WORKER_OUTPUT_PATH} is not byte-exact compiler output.`);
  }
}

console.log(
  `[service-worker] OK: strict TS owns /service-worker.js at cache epoch ${SERVICE_WORKER_CACHE_VERSION}${
    process.argv.includes('--dist') ? ' with byte-exact production output' : ''
  }.`,
);
