import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLASSIC_RUNTIME_ASSETS,
  assertClassicRuntimeSourceCompleteness,
  compileClassicRuntimeAssets,
} from './classic-runtime-assets.ts';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');

await assertClassicRuntimeSourceCompleteness(repoRoot);
await compileClassicRuntimeAssets(repoRoot);
console.log(
  `[classic-runtime] OK: ${CLASSIC_RUNTIME_ASSETS.length} strict TS sources own ${CLASSIC_RUNTIME_ASSETS.length} stable classic-script URLs.`,
);
