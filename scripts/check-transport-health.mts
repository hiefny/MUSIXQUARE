#!/usr/bin/env node
/**
 * check-transport-health.mts (guard:transport-health)
 *
 * Static ratchet for the one transport-health read path (Phase 4, C5-4;
 * docs/design/realtime-runtime-ownership.md, registry RO-17).
 * src/network/transport-health.ts reads a data connection's raw RTC state (and,
 * since C5-8, its link-liveness owner's view of the original route) and
 * answers the bulk, preload and heartbeat questions through pure predicates.
 * This guard keeps the host's bulk senders, preload lanes and heartbeat
 * monitor on that path:
 *
 *   CHECK 1 Raw state reads, per file: `connectionState` and
 *     `iceConnectionState` as a property access, a string-keyed element
 *     access or an object destructuring key, in src/storage/** and
 *     src/network/heartbeat-monitor.ts. The only allowed read is the
 *     heartbeat monitor's stale-peer warning, which prints the PC state and
 *     decides nothing.
 *   CHECK 2 Pairing: chunk-pump.ts, preload.ts and heartbeat-monitor.ts still
 *     import their predicates from transport-health.ts, so deleting a health
 *     check cannot pass CHECK 1.
 *
 * Every list is exact: a new site fails as unsanctioned, a count above its
 * baseline fails as a regression, and a count below it fails until the
 * baseline is lowered in the same change, with the reason.
 *
 * Out of scope and allowed: media-PC readers (system-audio-*, the PRO system
 * audio paths), the provider's own liveness readers in src/network/transport/
 * (isDataConnectionAlive and the restart machines), system-audio-host.ts's
 * shared data-PC reads and onboarding diagnostics. Scope: production
 * TypeScript under src/ (tests, __tests__ and *.d.ts excluded). The checks walk
 * the TypeScript AST, so comments and unrelated strings never count.
 *
 * Exit code: 0 if clean, 1 if findings remain.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Allowance {
  readonly count: number;
  readonly reason: string;
}

// ── Baselines ────────────────────────────────────────────────────────────

const HEALTH_MODULE = 'src/network/transport-health.ts';
const RAW_STATE_FIELDS = new Set(['connectionState', 'iceConnectionState']);

/** CHECK 1: raw state reads inside the guarded scope, per file. */
const RAW_STATE_READ_BASELINE = new Map<string, Allowance>([
  [
    'src/network/heartbeat-monitor.ts',
    {
      count: 1,
      reason: 'the stale-peer warning prints the PC state for diagnosis and decides nothing',
    },
  ],
]);

/** CHECK 2: each consumer and the predicates it must import from the health module. */
const REQUIRED_HEALTH_IMPORTS = new Map<string, readonly string[]>([
  ['src/storage/chunk-pump.ts', ['isBulkWritable', 'readTransportHealth']],
  ['src/storage/preload.ts', ['isRecoverablyInterrupted', 'readTransportHealth']],
  [
    'src/network/heartbeat-monitor.ts',
    ['heartbeatStaleThreshold', 'honoursRecoveryLease', 'readTransportHealth'],
  ],
]);

function inGuardedScope(relPath: string): boolean {
  return relPath.startsWith('src/storage/') || relPath === 'src/network/heartbeat-monitor.ts';
}

// ── Input ────────────────────────────────────────────────────────────────

export interface TransportHealthInput {
  /** Repository-relative production path (forward slashes) to source text. */
  readonly sources: ReadonlyMap<string, string>;
}

function isProductionSource(relPath: string): boolean {
  if (!/\.(?:m?ts|tsx)$/u.test(relPath)) return false;
  if (/\.d\.m?ts$/u.test(relPath)) return false;
  if (/\.(?:test|spec)\.m?tsx?$/u.test(relPath)) return false;
  return !relPath.split('/').includes('__tests__');
}

function walk(directory: string, root: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules') continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, root, out);
    else out.push(path.relative(root, full).replace(/\\/gu, '/'));
  }
}

export function loadTransportHealthInput(root: string = repoRoot): TransportHealthInput {
  const files: string[] = [];
  walk(path.join(root, 'src'), root, files);
  const sources = new Map<string, string>();
  for (const relPath of files.filter(isProductionSource).sort()) {
    sources.set(relPath, readFileSync(path.join(root, relPath), 'utf8'));
  }
  return { sources };
}

// ── AST facts ────────────────────────────────────────────────────────────

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function parse(relPath: string, text: string): ts.SourceFile {
  return ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** `a.connectionState`, `a?.iceConnectionState`, `a['connectionState']`, `{ connectionState } = a`. */
function rawStateField(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = node.propertyName ?? node.name;
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) return key.text;
  }
  return null;
}

function countRawStateReads(source: ts.SourceFile): number {
  let count = 0;
  visit(source, (node) => {
    const field = rawStateField(node);
    if (field !== null && RAW_STATE_FIELDS.has(field)) count += 1;
  });
  return count;
}

/** Names a file imports by value or type from the health module. */
function healthImports(relPath: string, source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = path.posix.join(path.posix.dirname(relPath), statement.moduleSpecifier.text);
    if (target !== HEALTH_MODULE) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      names.add((element.propertyName ?? element.name).text);
    }
  }
  return names;
}

// ── Analysis ─────────────────────────────────────────────────────────────

export interface TransportHealthReport {
  readonly findings: readonly string[];
  readonly scopedFiles: number;
  readonly rawStateReads: number;
  readonly pairedConsumers: number;
}

export function analyzeTransportHealth(input: TransportHealthInput): TransportHealthReport {
  const findings: string[] = [];
  const measured = new Map<string, number>();
  let scopedFiles = 0;
  for (const [relPath, text] of input.sources) {
    if (!inGuardedScope(relPath)) continue;
    scopedFiles += 1;
    const count = countRawStateReads(parse(relPath, text));
    if (count > 0) measured.set(relPath, count);
  }

  const hint = `read transport state through ${HEALTH_MODULE} (readTransportHealth and its predicates)`;
  for (const [relPath, count] of [...measured].sort(([a], [b]) => a.localeCompare(b))) {
    const allowance = RAW_STATE_READ_BASELINE.get(relPath);
    if (!allowance) {
      findings.push(`UNSANCTIONED raw state read: ${relPath} has ${count} - ${hint}`);
    } else if (count > allowance.count) {
      findings.push(
        `RATCHET REGRESSION raw state read: ${relPath} has ${count}, baseline ${allowance.count} - ${hint}`,
      );
    }
  }
  for (const [relPath, allowance] of RAW_STATE_READ_BASELINE) {
    const count = measured.get(relPath) ?? 0;
    if (count < allowance.count) {
      findings.push(
        `STALE BASELINE raw state read: ${relPath} has ${count}, baseline ${allowance.count} - ` +
          'lower or remove its entry in this change',
      );
    }
  }

  if (!input.sources.has(HEALTH_MODULE)) {
    findings.push(`MISSING FILE: ${HEALTH_MODULE} not found - the read path has no home`);
  }
  let pairedConsumers = 0;
  for (const [relPath, required] of REQUIRED_HEALTH_IMPORTS) {
    const text = input.sources.get(relPath);
    if (text === undefined) {
      findings.push(`MISSING FILE: ${relPath} not found - its pairing cannot be verified`);
      continue;
    }
    const imported = healthImports(relPath, parse(relPath, text));
    const missing = required.filter((name) => !imported.has(name));
    if (missing.length > 0) {
      findings.push(
        `UNPAIRED CONSUMER: ${relPath} no longer imports ${missing.join(', ')} from ` +
          `${HEALTH_MODULE} - its transport check must stay on the shared read path`,
      );
    } else {
      pairedConsumers += 1;
    }
  }

  let rawStateReads = 0;
  for (const count of measured.values()) rawStateReads += count;
  return { findings, scopedFiles, rawStateReads, pairedConsumers };
}

export function assertTransportHealth(input: TransportHealthInput): TransportHealthReport {
  const report = analyzeTransportHealth(input);
  if (report.findings.length > 0) {
    throw new Error(
      `Transport-health check failed:\n${report.findings
        .map((finding) => `  - ${finding}`)
        .join('\n')}\n` +
        'See docs/design/realtime-runtime-ownership.md. Lower a baseline in the change that ' +
        'removes a read; add or raise one only with the reason and an RO-17 update.',
    );
  }
  return report;
}

function main(argv: readonly string[]): void {
  const rootArgument = argv.find((argument) => argument.startsWith('--root='));
  const root = rootArgument ? path.resolve(rootArgument.slice('--root='.length)) : repoRoot;
  const report = assertTransportHealth(loadTransportHealthInput(root));
  console.log(
    `[transport-health] OK: ${report.scopedFiles} guarded files; ` +
      `raw state reads ${report.rawStateReads} (allowlisted); ` +
      `${report.pairedConsumers} consumers on ${HEALTH_MODULE}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
