#!/usr/bin/env node
/**
 * Binding-aware dead-export ratchet.
 *
 * TypeScript resolves references to the declaration they actually target, so
 * unrelated exports that happen to share a name no longer keep each other
 * alive. Value/type space and prod/test/self evidence are reported separately.
 *
 * The binding-aware 22/80 count baselines record the reviewed runtime and
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

type ExportKind = 'value' | 'type';

interface ExportSite {
  readonly name: string;
  readonly file: string;
}

interface ExportReferences {
  readonly prod: number;
  readonly test: number;
  readonly self: number;
  readonly externalFallback: number;
}

interface ExportEntry {
  readonly kind: ExportKind;
  readonly sites: readonly ExportSite[];
  readonly refs: ExportReferences;
}

interface ModuleReachability {
  readonly roots: readonly string[];
  readonly total: number;
  readonly reachable: number;
  readonly unreachable: number;
  readonly unreachableFiles: readonly string[];
}

interface DeadExportAnalysis {
  readonly prodFileCount: number;
  readonly bindingCount: number;
  readonly fullyDead: readonly ExportEntry[];
  readonly testOnly: readonly ExportEntry[];
  readonly selfOnly: readonly ExportEntry[];
  readonly live: readonly ExportEntry[];
  readonly sanctionedSeams: readonly ExportEntry[];
  readonly ambiguousExternalNames: readonly string[];
  readonly ignoredDefaultExports: readonly unknown[];
  readonly moduleReachability: ModuleReachability;
}

type AnalyzeDeadExports = (options: { readonly root: string }) => DeadExportAnalysis;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isExportSite(value: unknown): value is ExportSite {
  return isRecord(value) && typeof value.name === 'string' && typeof value.file === 'string';
}

function isExportEntry(value: unknown): value is ExportEntry {
  if (!isRecord(value) || (value.kind !== 'value' && value.kind !== 'type')) return false;
  if (!Array.isArray(value.sites) || !value.sites.every(isExportSite)) return false;
  const refs = value.refs;
  return (
    isRecord(refs) &&
    typeof refs.prod === 'number' &&
    typeof refs.test === 'number' &&
    typeof refs.self === 'number' &&
    typeof refs.externalFallback === 'number'
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isEntryArray(value: unknown): value is readonly ExportEntry[] {
  return Array.isArray(value) && value.every(isExportEntry);
}

function isModuleReachability(value: unknown): value is ModuleReachability {
  return (
    isRecord(value) &&
    isStringArray(value.roots) &&
    typeof value.total === 'number' &&
    typeof value.reachable === 'number' &&
    typeof value.unreachable === 'number' &&
    isStringArray(value.unreachableFiles)
  );
}

function isDeadExportAnalysis(value: unknown): value is DeadExportAnalysis {
  return (
    isRecord(value) &&
    typeof value.prodFileCount === 'number' &&
    typeof value.bindingCount === 'number' &&
    isEntryArray(value.fullyDead) &&
    isEntryArray(value.testOnly) &&
    isEntryArray(value.selfOnly) &&
    isEntryArray(value.live) &&
    isEntryArray(value.sanctionedSeams) &&
    isStringArray(value.ambiguousExternalNames) &&
    Array.isArray(value.ignoredDefaultExports) &&
    isModuleReachability(value.moduleReachability)
  );
}

function loadAnalyzer(moduleValue: unknown): AnalyzeDeadExports {
  if (!isRecord(moduleValue) || typeof moduleValue.analyzeDeadExports !== 'function') {
    throw new TypeError('dead-export analyzer does not export analyzeDeadExports()');
  }
  const analyze = moduleValue.analyzeDeadExports;
  return (options) => {
    const result: unknown = Reflect.apply(analyze, undefined, [options]);
    if (!isDeadExportAnalysis(result)) {
      throw new TypeError('dead-export analyzer returned an invalid result');
    }
    return result;
  };
}

const analyzerModuleUrl = new URL('./lib/dead-export-analyzer.mts', import.meta.url).href;
const analyzerModule: unknown = await import(analyzerModuleUrl);
const analyzeDeadExports = loadAnalyzer(analyzerModule);

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
// Reviewed binding-by-binding through 2026-08-10. The test-only additions are
// explicit regression seams from server authority, stable audio routing, and
// remote file delivery. The self-only additions are test-observed seams,
// module-local API types, or the central event/type barrel; no fully-dead
// export is allowed.
const TEST_ONLY_BASELINE_COUNT = 22;
const SELF_ONLY_BASELINE_COUNT = 80;

function kindCounts(entries: readonly ExportEntry[]): Record<ExportKind, number> {
  return entries.reduce(
    (counts, entry) => {
      counts[entry.kind] += 1;
      return counts;
    },
    { value: 0, type: 0 },
  );
}

function formatSites(entry: ExportEntry): string {
  return entry.sites.map((site) => `${site.name} @ ${site.file}`).join(', ');
}

function printEntries(title: string, entries: readonly ExportEntry[]): void {
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

function printReport(result: DeadExportAnalysis): number {
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
