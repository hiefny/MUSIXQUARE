import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  UI_KIT_OUTPUT_PATH,
  UI_KIT_SOURCES,
  assertUiKitSourceCompleteness,
  compileUiKitAsset,
} from './ui-kit-asset.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const deploymentIgnorePattern = '/designsystem/ui_kits/';

async function assertDeploymentExcludesUiKit(assetsIgnorePath: string): Promise<void> {
  const rules = (await readFile(assetsIgnorePath, 'utf8'))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (!rules.includes(deploymentIgnorePattern)) {
    throw new Error(`Workers asset upload must exclude ${deploymentIgnorePattern}.`);
  }
}

async function assertBuildExcludesUiKit(outputPath: string): Promise<void> {
  try {
    await access(outputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Production build must not contain dist/designsystem/ui_kits.');
}

await assertUiKitSourceCompleteness(repoRoot);
await assertDeploymentExcludesUiKit(path.resolve(repoRoot, 'public/.assetsignore'));
await compileUiKitAsset(repoRoot);

if (process.argv.includes('--dist')) {
  await assertDeploymentExcludesUiKit(path.resolve(repoRoot, 'dist/.assetsignore'));
  await assertBuildExcludesUiKit(path.resolve(repoRoot, 'dist/designsystem/ui_kits'));
}

console.log(
  `[ui-kit] OK: ${UI_KIT_SOURCES.length} strict TSX sources own /${UI_KIT_OUTPUT_PATH}${
    process.argv.includes('--dist')
      ? ' with no production build output'
      : ' and remain excluded from Workers asset upload'
  }.`,
);
