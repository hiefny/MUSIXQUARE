import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectProductionSecurityFindings,
  formatProductionSecurityFailure,
} from './production-security-guard-lib.mts';

// Release gate entry point. It always runs: there is deliberately no
// main-module detection, so a mismatch can never turn this gate into a no-op.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const failure = formatProductionSecurityFailure(
  await collectProductionSecurityFindings({ repoRoot, env: process.env }),
);

if (failure) {
  for (const line of failure) {
    console.error(line);
  }
  process.exit(1);
}

console.log('[prod-security-guard] OK: no unapproved bypass or retired rollout flags.');
