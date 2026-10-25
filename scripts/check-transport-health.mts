#!/usr/bin/env node
/**
 * check-transport-health.mts (guard:transport-health)
 *
 * Static ratchet for the one transport-health read path (Phase 4, C5-4;
 * docs/design/realtime-runtime-ownership.md, registry RO-17) and for the
 * link-liveness owner it reads (Phase 4, C5-10 and C5-9; registry RO-15).
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
 * It also keeps one Cloudflare logical data connection's (Standard or PRO
 * room) liveness and close with their one owner, LinkLiveness in src/network/transport/link-liveness.ts:
 *
 *   CHECK 3 Retired names: the identifiers of the machines the owner replaced
 *     in the connection (C5-6 the original route's grace and restart gate,
 *     C5-7 the background-resume probe, C5-10 the grace key field and the
 *     first close cause) and in the isolated control side route (C5-9 its
 *     outage deadline, that deadline's wait for the original route and the
 *     grace of a route that cannot restart) appear in no production file but
 *     the owner's module, where some of them live on.
 *   CHECK 4 Close port: production code constructs the owner once, in
 *     cloudflare-signaling.ts, and the connection's private terminate() is
 *     referenced only inside the `close` port it hands that owner, so every
 *     close (the channels, the credit sender, the side route and close(reason)
 *     included) goes through the owner.
 *   CHECK 5 One close input: inside link-liveness.ts the close port is called
 *     only from LinkLiveness.close(cause), which keeps the link's first cause;
 *     elsewhere in the module a `close` is read only as this.close(cause).
 *
 * Every list is exact: a new site fails as unsanctioned, a count above its
 * baseline fails as a regression, and a count below it fails until the
 * baseline is lowered in the same change, with the reason. CHECK 3 to 5 have
 * no allowance: every hit is a finding.
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

const LIVENESS_MODULE = 'src/network/transport/link-liveness.ts';
const LIVENESS_CLASS = 'LinkLiveness';
const CONNECTION_MODULE = 'src/network/transport/cloudflare-signaling.ts';
const CONNECTION_CLASS = 'CloudflareDataConnection';
/** The connection's close: the owner's close port is its only caller. */
const CLOSE_METHOD = 'terminate';
/** The owner's close input, and the name of its close port. */
const CLOSE_INPUT = 'close';

/**
 * CHECK 3: the names the connection's and the side route's liveness machines
 * had before the owner took them over, with the step that retired them. Only
 * LIVENESS_MODULE may use them. The C5-9 names are control isolation's (its
 * side PC's outage deadline and timer, the original-route readiness it read
 * and the transition notice it took, and its non-renewing grace timer); of
 * them only the owner's `originalDown` flag lives on. Test files are out of
 * scope.
 */
const RETIRED_LIVENESS_NAMES = new Map<string, string>([
  ['scheduleDisconnectedGrace', 'C5-6 original-route grace'],
  ['cancelDisconnectedGrace', 'C5-6 original-route grace'],
  ['connectionInterrupted', 'C5-6 original-route interruption'],
  ['iceRestartAttempted', 'C5-6 restart gate'],
  ['backgroundResumeRecoveryArmed', 'C5-7 resume probe'],
  ['backgroundResumeProbePingId', 'C5-7 resume probe'],
  ['backgroundResumeSawDisconnected', 'C5-7 resume probe'],
  ['backgroundResumeLivenessTimerKey', 'C5-7 resume probe'],
  ['backgroundResumeDisconnectedTimerKey', 'C5-7 resume probe'],
  ['clearBackgroundResumeRecovery', 'C5-7 resume probe'],
  ['isBackgroundResumeProbePong', 'C5-7 resume probe'],
  ['randomResumeProbePingId', 'C5-7 resume probe'],
  ['BACKGROUND_RESUME_LIVENESS_TIMEOUT_MS', 'C5-7 resume probe'],
  ['BACKGROUND_RESUME_DISCONNECTED_PROBE_MS', 'C5-7 resume probe'],
  ['disconnectedGraceTimerKey', 'C5-10 grace key field'],
  ['closeCause', 'C5-10 first close cause'],
  ['beginInterruption', 'C5-9 side outage deadline'],
  ['armDeadline', 'C5-9 side outage deadline'],
  ['restartExpired', 'C5-9 side outage deadline'],
  ['endInterruption', 'C5-9 side outage deadline'],
  ['originalReady', "C5-9 side outage's wait for the original route"],
  ['originalChanged', "C5-9 side outage's wait for the original route"],
  ['originalDown', "C5-9 side outage's wait for the original route"],
  ['disconnectedTimer', 'C5-9 side grace without restart'],
]);

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

/**
 * The name a node gives: an identifier, a private name without its `#`, or a
 * string-literal member name or element-access key. Other strings and
 * comments name nothing.
 */
function givenName(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPrivateIdentifier(node)) return node.text.slice(1);
  if (!ts.isStringLiteralLike(node)) return null;
  const parent = node.parent;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return node.text;
  return (parent as { name?: ts.Node }).name === node ? node.text : null;
}

/** Uses of each retired liveness name in one file. */
function retiredNameUses(source: ts.SourceFile): Map<string, number> {
  const uses = new Map<string, number>();
  visit(source, (node) => {
    const name = givenName(node);
    if (name !== null && RETIRED_LIVENESS_NAMES.has(name)) {
      uses.set(name, (uses.get(name) ?? 0) + 1);
    }
  });
  return uses;
}

interface MemberRead {
  readonly name: string;
  /** The object read from; null for a destructuring key. */
  readonly receiver: ts.Node | null;
}

/**
 * `a.member`, `a?.member`, `a['member']` or `{ member } = a`: the member read,
 * if any (`a.connectionState`, `{ iceConnectionState } = pc`, `this.terminate`).
 */
function memberRead(node: ts.Node): MemberRead | null {
  if (ts.isPropertyAccessExpression(node)) {
    const name = givenName(node.name);
    return name === null ? null : { name, receiver: node.expression };
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return { name: node.argumentExpression.text, receiver: node.expression };
  }
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = node.propertyName ?? node.name;
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) {
      return { name: key.text, receiver: null };
    }
  }
  return null;
}

function countRawStateReads(source: ts.SourceFile): number {
  let count = 0;
  visit(source, (node) => {
    const field = memberRead(node)?.name;
    if (field !== undefined && RAW_STATE_FIELDS.has(field)) count += 1;
  });
  return count;
}

function within(node: ts.Node, container: ts.Node | null): boolean {
  return container !== null && node.pos >= container.pos && node.end <= container.end;
}

function findClass(source: ts.SourceFile, name: string): ts.ClassDeclaration | null {
  for (const statement of source.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) return statement;
  }
  return null;
}

function findMethod(owner: ts.ClassDeclaration, name: string): ts.MethodDeclaration | null {
  for (const member of owner.members) {
    if (ts.isMethodDeclaration(member) && givenName(member.name) === name) return member;
  }
  return null;
}

/** `new LinkLiveness(...)` expressions in one file. */
function ownerConstructions(source: ts.SourceFile): ts.NewExpression[] {
  const found: ts.NewExpression[] = [];
  visit(source, (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === LIVENESS_CLASS
    ) {
      found.push(node);
    }
  });
  return found;
}

/** The `close` member of the ports object literal a construction passes. */
function closePortOf(construction: ts.NewExpression): ts.Node | null {
  for (const argument of construction.arguments ?? []) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (property.name && givenName(property.name) === CLOSE_INPUT) return property;
    }
  }
  return null;
}

/** `this.ports` or a local `ports`: the owner's ports object. */
function isPortsReceiver(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === 'ports';
  return (
    ts.isPropertyAccessExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword &&
    node.name.text === 'ports'
  );
}

function isPrivate(method: ts.MethodDeclaration): boolean {
  return (
    ts.isPrivateIdentifier(method.name) ||
    (method.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
  );
}

interface LivenessOwnerFacts {
  readonly findings: readonly string[];
  readonly retiredNamesInOwner: number;
  readonly closePortCalls: number;
}

/** CHECK 4: the connection reaches terminate() only from the owner's close port. */
function checkConnectionClosePort(
  parsed: ReadonlyMap<string, ts.SourceFile>,
  constructions: ReadonlyArray<{ readonly relPath: string; readonly node: ts.NewExpression }>,
  findings: string[],
): void {
  for (const { relPath } of constructions) {
    if (relPath === CONNECTION_MODULE) continue;
    findings.push(
      `SECOND LIVENESS OWNER: ${relPath} constructs ${LIVENESS_CLASS} - ` +
        `only ${CONNECTION_CLASS} creates the owner of its link`,
    );
  }
  const connection = parsed.get(CONNECTION_MODULE);
  const connectionClass = connection ? findClass(connection, CONNECTION_CLASS) : null;
  if (!connection || !connectionClass) {
    findings.push(
      `MISSING FILE: ${CONNECTION_CLASS} not found in ${CONNECTION_MODULE} - ` +
        'its close port cannot be verified',
    );
    return;
  }
  const own = constructions.filter(({ relPath }) => relPath === CONNECTION_MODULE);
  if (own.length !== 1) {
    findings.push(
      `OWNER CONSTRUCTION: ${CONNECTION_MODULE} constructs ${LIVENESS_CLASS} ` +
        `${own.length} time(s), expected 1`,
    );
  }
  const port = own.length === 1 ? closePortOf(own[0]!.node) : null;
  const method = findMethod(connectionClass, CLOSE_METHOD);
  if (!method) {
    findings.push(
      `MISSING CLOSE: ${CONNECTION_CLASS}.${CLOSE_METHOD}() not found - ` +
        'update this guard and RO-15 with the close it became',
    );
  } else if (!isPrivate(method)) {
    findings.push(
      `PUBLIC CLOSE: ${CONNECTION_CLASS}.${CLOSE_METHOD}() is not private - ` +
        `callers close the link through close(reason) and ${LIVENESS_CLASS}`,
    );
  }
  let inPort = 0;
  let outside = 0;
  visit(connection, (node) => {
    if (memberRead(node)?.name !== CLOSE_METHOD) return;
    if (within(node, port)) inPort += 1;
    else outside += 1;
  });
  if (outside > 0) {
    findings.push(
      `CLOSE PORT BYPASS: ${CONNECTION_MODULE} reaches ${CLOSE_METHOD}() ${outside} time(s) ` +
        `outside the ${CLOSE_INPUT} port it hands ${LIVENESS_CLASS} - ` +
        `close the link through the owner (liveness.${CLOSE_INPUT}(cause))`,
    );
  }
  if (port === null || inPort !== 1) {
    findings.push(
      `MISSING CLOSE PORT: the ${CLOSE_INPUT} port of ${LIVENESS_CLASS} in ${CONNECTION_MODULE} ` +
        `must call ${CLOSE_METHOD}() exactly once (found ${port === null ? 'no port' : inPort})`,
    );
  }
}

/** CHECK 5: inside the owner, the close port is reached only from close(cause). */
function checkOwnerCloseInput(owner: ts.SourceFile | undefined, findings: string[]): number {
  const ownerClass = owner ? findClass(owner, LIVENESS_CLASS) : null;
  const input = ownerClass ? findMethod(ownerClass, CLOSE_INPUT) : null;
  if (!owner || !input?.body) {
    findings.push(
      `MISSING CLOSE INPUT: ${LIVENESS_CLASS}.${CLOSE_INPUT}(cause) not found in ${LIVENESS_MODULE} - ` +
        'the link has no close input',
    );
    return 0;
  }
  const body = input.body;
  let calls = 0;
  let outside = 0;
  visit(owner, (node) => {
    const read = memberRead(node);
    if (read?.name !== CLOSE_INPUT) return;
    if (within(node, body)) {
      if (read.receiver !== null && isPortsReceiver(read.receiver)) calls += 1;
      return;
    }
    // Elsewhere the owner closes only through its own input, this.close(cause);
    // an aliased or destructured port, or any other close, counts.
    if (read.receiver?.kind !== ts.SyntaxKind.ThisKeyword) outside += 1;
  });
  if (outside > 0) {
    findings.push(
      `CLOSE PORT BYPASS: ${LIVENESS_MODULE} reads ${CLOSE_INPUT} ${outside} time(s) outside ` +
        `${LIVENESS_CLASS}.${CLOSE_INPUT}(cause) other than this.${CLOSE_INPUT}(cause) - the owner ` +
        "closes only through its close input, which keeps the link's first cause and alone calls " +
        'the close port',
    );
  }
  if (calls !== 1) {
    findings.push(
      `MISSING CLOSE PORT: ${LIVENESS_CLASS}.${CLOSE_INPUT}(cause) must call its ` +
        `${CLOSE_INPUT} port exactly once (found ${calls})`,
    );
  }
  return calls;
}

function analyzeLivenessOwner(input: TransportHealthInput): LivenessOwnerFacts {
  const findings: string[] = [];
  let retiredNamesInOwner = 0;
  const parsed = new Map<string, ts.SourceFile>();
  const constructions: Array<{ relPath: string; node: ts.NewExpression }> = [];
  for (const [relPath, text] of input.sources) {
    const source = parse(relPath, text);
    parsed.set(relPath, source);
    const uses = [...retiredNameUses(source)].sort(([a], [b]) => a.localeCompare(b));
    for (const [name, count] of uses) {
      if (relPath === LIVENESS_MODULE) {
        retiredNamesInOwner += count;
        continue;
      }
      findings.push(
        `RETIRED LIVENESS NAME: ${relPath} uses ${name} ${count} time(s) - the ` +
          `${RETIRED_LIVENESS_NAMES.get(name)} belongs to ${LIVENESS_CLASS} in ${LIVENESS_MODULE}`,
      );
    }
    for (const node of ownerConstructions(source)) constructions.push({ relPath, node });
  }
  checkConnectionClosePort(parsed, constructions, findings);
  const closePortCalls = checkOwnerCloseInput(parsed.get(LIVENESS_MODULE), findings);
  return { findings, retiredNamesInOwner, closePortCalls };
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
  /** CHECK 3: uses of the retired names inside the owner's own module. */
  readonly retiredNamesInOwner: number;
  /** CHECK 5: calls of the owner's close port from its close input. */
  readonly closePortCalls: number;
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

  const owner = analyzeLivenessOwner(input);
  findings.push(...owner.findings);

  let rawStateReads = 0;
  for (const count of measured.values()) rawStateReads += count;
  return {
    findings,
    scopedFiles,
    rawStateReads,
    pairedConsumers,
    retiredNamesInOwner: owner.retiredNamesInOwner,
    closePortCalls: owner.closePortCalls,
  };
}

export function assertTransportHealth(input: TransportHealthInput): TransportHealthReport {
  const report = analyzeTransportHealth(input);
  if (report.findings.length > 0) {
    throw new Error(
      `Transport-health check failed:\n${report.findings
        .map((finding) => `  - ${finding}`)
        .join('\n')}\n` +
        'See docs/design/realtime-runtime-ownership.md. Lower a baseline in the change that ' +
        'removes a read; add or raise one only with the reason and an RO-17 update. The ' +
        'link-liveness checks have no allowance: an owner change updates RO-15 and this guard.',
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
      `${report.pairedConsumers} consumers on ${HEALTH_MODULE}; ` +
      `${RETIRED_LIVENESS_NAMES.size} retired liveness names only in ${LIVENESS_MODULE}; ` +
      `${CLOSE_METHOD}() only from the ${CLOSE_INPUT} port of ${LIVENESS_CLASS}.`,
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
