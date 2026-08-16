import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  UI_KIT_HTML_PATH,
  UI_KIT_OUTPUT_PATH,
  UI_KIT_SOURCES,
  assertUiKitHtmlContract,
  assertUiKitJavaScript,
  assertUiKitSourceCompleteness,
  compileUiKitAsset,
} from './ui-kit-asset.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
await assertUiKitSourceCompleteness(repoRoot);
const compiled = await compileUiKitAsset(repoRoot);

if (process.argv.includes('--dist')) {
  const builtPath = path.resolve(repoRoot, 'dist', UI_KIT_OUTPUT_PATH);
  const built = await readFile(builtPath, 'utf8');
  assertUiKitJavaScript(built);
  if (built !== compiled.code) {
    throw new Error(`Built /${UI_KIT_OUTPUT_PATH} is not byte-exact compiler output.`);
  }
  const outputDirectory = path.dirname(builtPath);
  const outputName = path.basename(builtPath);
  if ((await readdir(outputDirectory)).includes(`${outputName}.map`)) {
    throw new Error(`UI kit sourcemap must not exist: ${UI_KIT_OUTPUT_PATH}.map`);
  }
  const builtHtml = await readFile(
    path.resolve(repoRoot, 'dist', path.relative('public', UI_KIT_HTML_PATH)),
    'utf8',
  );
  assertUiKitHtmlContract(builtHtml);
}

console.log(
  `[ui-kit] OK: ${UI_KIT_SOURCES.length} strict TSX sources own /${UI_KIT_OUTPUT_PATH}${
    process.argv.includes('--dist') ? ' with byte-exact production output' : ''
  }.`,
);
