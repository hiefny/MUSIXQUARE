import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHashedAppStaticBypassAssets } from './materialize-app-static-headers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.resolve(
  process.env.MXQR_STAGING_SOURCE_DIST || path.join(repoRoot, 'dist'),
);
const outputDirectory = path.resolve(
  process.env.MXQR_STAGING_OUTPUT_DIR || path.join(repoRoot, 'scratch', 'app-assets-staging-dist'),
);
const headerTemplate = path.join(repoRoot, 'cloudflare', 'app-static-assets', '_headers');
const allowedAssetExtensions = new Set(['.css', '.js', '.woff2']);

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(absolute)));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

function assertSafeOutput() {
  const scratchRoot = path.resolve(repoRoot, 'scratch');
  const relative = path.relative(scratchRoot, outputDirectory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to replace staging output outside scratch/: ${outputDirectory}`);
  }
}

assertSafeOutput();
const sourceFiles = await filesBelow(sourceDirectory).catch((error) => {
  throw new Error(`Build dist before preparing staging assets: ${error.message}`);
});
const sourceAssetsRoot = path.join(sourceDirectory, 'assets');
const assetFiles = sourceFiles.filter((file) => {
  const relative = path.relative(sourceAssetsRoot, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
});
const unsupported = assetFiles.filter((file) => !allowedAssetExtensions.has(path.extname(file)));
if (unsupported.length > 0) {
  throw new Error(
    `Unreviewed /assets MIME types:\n${unsupported.map((file) => `  - ${path.relative(sourceDirectory, file)}`).join('\n')}`,
  );
}
await assertHashedAppStaticBypassAssets(sourceDirectory);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(path.dirname(outputDirectory), { recursive: true });
await cp(sourceDirectory, outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, '_headers'),
  await readFile(headerTemplate, 'utf8'),
  'utf8',
);

console.log(
  `[app-assets-staging] prepared ${sourceFiles.length} files (${assetFiles.length} bypass candidates) at ${outputDirectory}`,
);
