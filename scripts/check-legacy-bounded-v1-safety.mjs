#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import {
  analyzeLegacyBoundedV1Safety,
  DEFAULT_LEGACY_BOUNDED_V1_FORBIDDEN_MODULE_FILES,
} from './lib/legacy-bounded-v1-safety-analyzer.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

if (process.argv.length !== 2) {
  console.error('Usage: node scripts/check-legacy-bounded-v1-safety.mjs');
  process.exit(2);
}

const result = analyzeLegacyBoundedV1Safety({ root: ROOT });
console.log('=== Legacy bounded-file V1 safety boundary ===');
console.log(
  `${result.protectedFileCount} production modules; ` +
    `${DEFAULT_LEGACY_BOUNDED_V1_FORBIDDEN_MODULE_FILES.length} forbidden old V2 modules`,
);

if (!result.violations.length) {
  console.log(
    'OK - protected bounded-V1 modules contain no direct DataConnection lifecycle authority or old V2 runtime import.',
  );
  process.exit(0);
}

console.error(`FAILED - ${result.violations.length} bounded-V1 safety finding(s):`);
for (const violation of result.violations) console.error(`  - ${violation}`);
process.exit(1);
