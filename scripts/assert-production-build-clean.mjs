import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(repoRoot, 'dist');

const forbiddenMarkers = [
  '__MUSIXQUARE_GET_STATE__',
  '__MUSIXQUARE_SET_STATE__',
  '__MUSIXQUARE_BUS__',
  '__MUSIXQUARE_GET_PLAYBACK_PROJECTION__',
  '__MUSIXQUARE_FILE_PLAYBACK_E2E__',
  '__MUSIXQUARE_FILE_PLAYBACK_CURRENT_ISOLATION__',
  '__MUSIXQUARE_FILE_PLAYBACK_PRODUCTION_LATCH_ISOLATION__',
];

async function* walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

const hits = [];

try {
  for await (const file of walkFiles(distDir)) {
    const bytes = await readFile(file);
    for (const marker of forbiddenMarkers) {
      if (bytes.includes(marker)) {
        hits.push({ file: path.relative(repoRoot, file), marker });
      }
    }
  }
} catch (error) {
  if (error && error.code === 'ENOENT') {
    console.error('[prod-hook-guard] dist/ not found. Run a production build first.');
    process.exit(1);
  }
  throw error;
}

if (hits.length > 0) {
  console.error('[prod-hook-guard] E2E test hooks were found in the production bundle:');
  for (const hit of hits) {
    console.error(`  - ${hit.file}: ${hit.marker}`);
  }
  console.error(
    '[prod-hook-guard] Use npm run build:checked for production and npm run build:e2e only for tests.',
  );
  process.exit(1);
}

console.log('[prod-hook-guard] OK: no E2E test hooks found in dist/.');
