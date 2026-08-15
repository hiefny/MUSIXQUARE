import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..');
const bypassAssetExtensions = new Set(['.js', '.css', '.woff2']);
const hashedBypassAssetName = /-[A-Za-z0-9_-]{8}\.(?:js|css|woff2)$/;

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await filesBelow(absolute)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Static Assets output contains an unsupported entry: ${absolute}`);
    }
    result.push(absolute);
  }
  return result;
}

export function validateAppStaticHeaders(source) {
  const requiredLines = [
    '/assets/*',
    'Cache-Control: public, max-age=31536000, immutable',
    'Strict-Transport-Security: max-age=31536000; includeSubDomains; preload',
    'X-Content-Type-Options: nosniff',
    'X-Frame-Options: DENY',
    'X-XSS-Protection: 1; mode=block',
    'Referrer-Policy: strict-origin-when-cross-origin',
    'Permissions-Policy:',
    'Content-Security-Policy:',
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  for (const required of requiredLines) {
    if (!source.includes(required)) {
      throw new Error(`Static Assets header source is missing: ${required}`);
    }
  }
  if (/^\s*(?:Content-Type|Access-Control-Allow-Origin)\s*:/imu.test(source)) {
    throw new Error('Static Assets headers must preserve inferred MIME and same-origin CORS.');
  }
  return source.endsWith('\n') ? source : `${source}\n`;
}

export async function assertHashedAppStaticBypassAssets(outputDirectory) {
  const assetsDirectory = path.join(outputDirectory, 'assets');
  const assetsStat = await stat(assetsDirectory).catch(() => null);
  if (!assetsStat?.isDirectory()) {
    throw new Error(`Static Assets output is missing its assets directory: ${assetsDirectory}`);
  }

  const bypassCandidates = (await filesBelow(assetsDirectory)).filter((file) =>
    bypassAssetExtensions.has(path.extname(file)),
  );
  const unhashed = bypassCandidates.filter(
    (file) => !hashedBypassAssetName.test(path.basename(file)),
  );
  if (unhashed.length > 0) {
    throw new Error(
      `App Worker bypass candidates must end in an eight-character Vite content hash:\n${unhashed
        .map((file) => `  - ${path.relative(outputDirectory, file)}`)
        .join('\n')}`,
    );
  }
  return bypassCandidates;
}

export async function materializeAppStaticHeaders({
  repoRoot = defaultRepoRoot,
  sourcePath = path.join(repoRoot, 'cloudflare', 'app-static-assets', '_headers'),
  outputDirectory = path.join(repoRoot, 'dist'),
} = {}) {
  const source = validateAppStaticHeaders(await readFile(sourcePath, 'utf8'));
  const outputStat = await stat(outputDirectory);
  if (!outputStat.isDirectory())
    throw new Error(`Static Assets output is not a directory: ${outputDirectory}`);
  await assertHashedAppStaticBypassAssets(outputDirectory);
  const outputPath = path.join(outputDirectory, '_headers');
  await writeFile(outputPath, source, 'utf8');
  return { outputPath, sourcePath };
}

export async function assertAppStaticHeadersMaterialized({
  repoRoot = defaultRepoRoot,
  sourcePath = path.join(repoRoot, 'cloudflare', 'app-static-assets', '_headers'),
  outputDirectory = path.join(repoRoot, 'dist'),
} = {}) {
  const source = validateAppStaticHeaders(await readFile(sourcePath, 'utf8'));
  await assertHashedAppStaticBypassAssets(outputDirectory);
  const outputPath = path.join(outputDirectory, '_headers');
  let materialized;
  try {
    materialized = await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `Production build is missing ${outputPath}; run npm run build before deployment.`,
      );
    }
    throw error;
  }
  if (materialized !== source) {
    throw new Error(
      `Production Static Assets headers differ from the canonical source: ${outputPath}`,
    );
  }
  return { outputPath, sourcePath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const { outputPath } = await materializeAppStaticHeaders();
  console.log(`[app-static-assets] wrote ${outputPath}`);
}
