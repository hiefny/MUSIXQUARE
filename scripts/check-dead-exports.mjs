#!/usr/bin/env node
/**
 * Binding-aware dead-export ratchet.
 *
 * TypeScript resolves references to the declaration they actually target, so
 * unrelated exports that happen to share a name no longer keep each other
 * alive. Value/type space and prod/test/self evidence are reported separately.
 *
 * The binding-aware 22/81 count baselines record the reviewed runtime and
 * server-authority surfaces. Fully-dead exports remain forbidden, and both
 * counts are shrink-only.
 * Module reachability is report-only and includes static value imports,
 * type-only imports, dynamic import(), and new URL(..., import.meta.url) worker
 * edges. It must not be treated as proof that a staged module is dead.
 *
 * Deliberate boundaries:
 * - overload declarations are one TypeScript binding;
 * - re-export sites that resolve to one declaration are reported together, so
 *   this guard does not claim that each alias surface is independently live;
 * - default exports remain outside the historical ratchet and are counted in
 *   the report instead of being silently ignored;
 * - constant-string import() helpers are resolved, while genuinely computed
 *   module/property names remain unknowable statically;
 * - HTML has no TypeScript binding graph, so only an unambiguous exported name
 *   receives conservative external-reference credit.
 */

import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { analyzeDeadExports } from './lib/dead-export-analyzer.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
// Reviewed binding-by-binding on 2026-07-28. The test-only additions are
// explicit regression seams from server authority, stable audio routing, and
// remote file delivery. The self-only additions are test-observed seams,
// module-local API types, or the central event/type barrel; no fully-dead
// export is allowed.
const TEST_ONLY_BASELINE_COUNT = 22;
const SELF_ONLY_BASELINE_COUNT = 81;

function kindCounts(entries) {
  return entries.reduce(
    (counts, entry) => {
      counts[entry.kind] += 1;
      return counts;
    },
    { value: 0, type: 0 },
  );
}

function formatSites(entry) {
  return entry.sites.map((site) => `${site.name} @ ${site.file}`).join(', ');
}

function printEntries(title, entries) {
  if (!entries.length) return;
  console.log(`${title}: ${entries.length}`);
  for (const entry of entries) {
    console.log(
      `  [${entry.kind}] ${formatSites(entry)} ` +
        `(refs prod=${entry.refs.prod}, test=${entry.refs.test}, self=${entry.refs.self})`,
    );
  }
  console.log('');
}

function printReport(result) {
  const fullyDeadKinds = kindCounts(result.fullyDead);
  const testOnlyKinds = kindCounts(result.testOnly);
  const selfOnlyKinds = kindCounts(result.selfOnly);
  const reachability = result.moduleReachability;

  console.log('=== Dead-export check (TypeScript bindings) ===');
  console.log(
    `${result.prodFileCount} prod files, ${result.bindingCount} exported bindings; ` +
      `fully-dead: ${result.fullyDead.length} ` +
      `(value ${fullyDeadKinds.value}, type ${fullyDeadKinds.type}), ` +
      `test-only: ${result.testOnly.length} ` +
      `(value ${testOnlyKinds.value}, type ${testOnlyKinds.type}; ` +
      `baseline ${TEST_ONLY_BASELINE_COUNT}), ` +
      `self-only: ${result.selfOnly.length} ` +
      `(value ${selfOnlyKinds.value}, type ${selfOnlyKinds.type}; ` +
      `baseline ${SELF_ONLY_BASELINE_COUNT})`,
  );
  console.log('');

  let failed = false;
  if (result.fullyDead.length) {
    failed = true;
    printEntries('FULLY-DEAD EXPORTS (must remain zero)', result.fullyDead);
  }
  if (result.testOnly.length > TEST_ONLY_BASELINE_COUNT) {
    failed = true;
    console.log(
      `TEST-ONLY BINDING COUNT GREW: ${result.testOnly.length} > ` +
        `historical baseline ${TEST_ONLY_BASELINE_COUNT}`,
    );
    console.log('  Review each exact binding: use a /ForTests$/ suffix only for a real test seam;');
    console.log('  do not raise this count merely to silence the binding-aware result.');
    console.log('');
  }
  if (result.selfOnly.length > SELF_ONLY_BASELINE_COUNT) {
    failed = true;
    console.log(
      `SELF-ONLY BINDING COUNT GREW: ${result.selfOnly.length} > ` +
        `historical baseline ${SELF_ONLY_BASELINE_COUNT}`,
    );
    console.log(
      '  Remove unnecessary exports first; preserve test-observed or barrel surfaces only',
    );
    console.log('  after an explicit binding-level review.');
    console.log('');
  }

  printEntries('info: test-only bindings', result.testOnly);
  console.log(
    `info: self-only bindings: ${result.selfOnly.length} ` +
      `(value ${selfOnlyKinds.value}, type ${selfOnlyKinds.type})`,
  );
  console.log('');

  console.log('info: module reachability (report-only; static/type/dynamic/worker URL edges):');
  console.log(
    `  ${reachability.reachable}/${reachability.total} reachable from ` +
      `${reachability.roots.join(', ') || '(no entry root)'}; ` +
      `${reachability.unreachable} unreachable`,
  );
  for (const file of reachability.unreachableFiles) console.log(`  - ${file}`);
  console.log('');

  console.log(
    `info: default exports excluded by the historical guard scope: ` +
      `${result.ignoredDefaultExports.length}`,
  );
  console.log('');

  if (result.ambiguousExternalNames.length) {
    console.log('note: ambiguous identifiers in HTML were not assigned to an export binding:');
    console.log(`  ${result.ambiguousExternalNames.join(', ')}`);
    console.log('');
  }

  if (!failed) {
    console.log('OK - no fully-dead exports and reviewed binding counts remain within ratchet.');
    return 0;
  }
  console.log('Guard remains failed pending exact binding review; baselines were not raised.');
  return 1;
}

const [mode, rootArgument] = process.argv.slice(2);
if (mode === '--analyze-json') {
  const root = rootArgument ? resolve(rootArgument) : ROOT;
  console.log(JSON.stringify(analyzeDeadExports({ root })));
  process.exit(0);
}

process.exit(printReport(analyzeDeadExports({ root: ROOT })));
