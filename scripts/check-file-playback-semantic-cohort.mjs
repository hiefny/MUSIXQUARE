#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { analyzeFilePlaybackSemanticCohort } from './lib/file-playback-semantic-cohort-analyzer.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
if (args.some((argument) => argument !== '--print-digest')) {
  console.error('Usage: node scripts/check-file-playback-semantic-cohort.mjs [--print-digest]');
  console.error('This guard intentionally has no automatic update mode.');
  process.exit(2);
}

const result = analyzeFilePlaybackSemanticCohort({ root: ROOT });
console.log('=== Universal file-playback semantic cohort ===');
console.log(
  `${result.coreFileCount} closed core files + ${result.integrationFileCount} integration roots, ` +
    `${result.edgeCount} classified runtime edges ` +
    `(${result.integrationBoundaryEdgeCount} opaque integration-support edges), ` +
    `${result.packageClosure.length} locked runtime packages`,
);
console.log(`digest: ${result.digest}`);
console.log(`required suffix: ${result.suffix}`);

if (args.includes('--print-digest')) {
  console.log(
    'No files were changed; copy the required suffix only after reviewing the semantic diff.',
  );
}

if (!result.violations.length) {
  console.log('OK - semantic surface is closed and the cohort suffix matches.');
  process.exit(0);
}

console.error(`FAILED - ${result.violations.length} semantic cohort finding(s):`);
for (const violation of result.violations) console.error(`  - ${violation}`);
process.exit(1);
