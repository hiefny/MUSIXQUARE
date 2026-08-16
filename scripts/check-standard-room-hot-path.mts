#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_FILES = Object.freeze({
  appWorker: 'cloudflare/app-worker.ts',
  signalingWorker: 'cloudflare/signaling-worker.ts',
  peer: 'src/network/peer.ts',
  setupHost: 'src/ui/setup-host.ts',
  setupGuest: 'src/ui/setup-guest.ts',
});

const ATOMIC_SERVICE_CONTROL_CALLS = new Set([
  'consumeAbuseRateLimit',
  'consumeAbuseRateLimitIdempotent',
  'consumeAbuseRateLimitPair',
]);

export interface StandardRoomHotPathSources {
  appWorker: string;
  signalingWorker: string;
  peer: string;
  setupHost: string;
  setupGuest: string;
}

export interface StandardRoomHotPathResult {
  capabilityPowDifficulty: 12;
  turnAtomicConsumes: 1;
  standardWebSocketServiceControlConsumes: 0;
  signalingStartsBeforeTurn: true;
  inviteReturnsBeforeTurn: true;
  rtcConfigurationFence: true;
}

interface ReachableRemoteCallOptions {
  skipNames?: ReadonlySet<string>;
  countFetch?: boolean;
}

type FunctionWithBody = ts.FunctionDeclaration & { body: ts.Block };
type MethodWithBody = ts.MethodDeclaration & { body: ts.Block };
type LocalCallable = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function functionHasBody(node: ts.FunctionDeclaration): node is FunctionWithBody {
  return node.body !== undefined;
}

function methodHasBody(node: ts.MethodDeclaration): node is MethodWithBody {
  return node.body !== undefined;
}

function sourceFile(fileName: string, source: string): ts.SourceFile {
  const kind = fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const diagnostics =
    'parseDiagnostics' in parsed && Array.isArray(parsed.parseDiagnostics)
      ? parsed.parseDiagnostics
      : [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const start =
      first !== null &&
      typeof first === 'object' &&
      'start' in first &&
      typeof first.start === 'number'
        ? first.start
        : 0;
    throw new Error(`${fileName} could not be parsed near offset ${start}.`);
  }
  return parsed;
}

function nodeText(node: ts.Node, parsed: ts.SourceFile): string {
  return node.getText(parsed);
}

function callName(call: ts.CallExpression): string | null {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function collect<NodeType extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is NodeType,
): NodeType[];
function collect(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[];
function collect(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function findNamedFunction(parsed: ts.SourceFile, name: string): FunctionWithBody {
  const matches = collect(
    parsed,
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  const match = matches[0];
  if (matches.length !== 1 || !match || !functionHasBody(match)) {
    throw new Error(`Expected exactly one ${name}() function in ${parsed.fileName}.`);
  }
  return match;
}

function callsNamed(root: ts.Node, names: ReadonlySet<string>): ts.CallExpression[] {
  return collect(
    root,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && names.has(callName(node) ?? ''),
  );
}

function localCallables(parsed: ts.SourceFile): Map<string, LocalCallable> {
  const callables = new Map<string, LocalCallable>();
  for (const node of collect(parsed, ts.isFunctionDeclaration)) {
    if (node.name?.text && node.body) callables.set(node.name.text, node);
  }
  for (const node of collect(parsed, ts.isVariableDeclaration)) {
    if (
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      callables.set(node.name.text, node.initializer);
    }
  }
  return callables;
}

function importedNames(parsed: ts.SourceFile, modulePath: string): Set<string> {
  const names = new Set<string>();
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== modulePath
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      names.add(element.name.text);
    }
  }
  return names;
}

function reachableRemoteCalls(
  root: ts.Node,
  parsed: ts.SourceFile,
  remoteNames: ReadonlySet<string>,
  options: ReachableRemoteCallOptions = {},
): string[] {
  const callables = localCallables(parsed);
  const boundaries: string[] = [];
  const expand = (node: ts.Node, stack: ReadonlySet<string>): void => {
    for (const call of collect(node, ts.isCallExpression)) {
      const name = callName(call);
      if (!name || options.skipNames?.has(name)) continue;
      if (remoteNames.has(name) || (options.countFetch === true && name === 'fetch')) {
        boundaries.push(name);
        continue;
      }
      const local = callables.get(name);
      if (!local || stack.has(name)) continue;
      expand(local, new Set([...stack, name]));
    }
  };
  expand(root, new Set());
  return boundaries;
}

function variableInitializer(parsed: ts.SourceFile, name: string): ts.Expression {
  const matches = collect(
    parsed,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  );
  const match = matches[0];
  if (matches.length !== 1 || !match?.initializer) {
    throw new Error(`Expected exactly one initialized ${name} variable in ${parsed.fileName}.`);
  }
  return match.initializer;
}

function containsIdentifier(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'u').test(text);
}

function taintedTurnIdentifiers(scope: ts.Node, parsed: ts.SourceFile): Set<string> {
  const tainted = new Set<string>([
    'getStandardRoomTurnCredentials',
    'settleDeferredHostRtcConfiguration',
    'turnCredentialsRequest',
  ]);
  const declarations = collect(
    scope,
    (node): node is ts.FunctionDeclaration | ts.VariableDeclaration =>
      ts.isFunctionDeclaration(node) ||
      (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !!node.initializer),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const name = ts.isFunctionDeclaration(declaration)
        ? declaration.name?.text
        : ts.isIdentifier(declaration.name)
          ? declaration.name.text
          : undefined;
      if (!name || tainted.has(name)) continue;
      const text = nodeText(declaration, parsed);
      if (![...tainted].some((candidate) => containsIdentifier(text, candidate))) continue;
      tainted.add(name);
      changed = true;
    }
  }
  return tainted;
}

function nearestFunctionLike(node: ts.Node): ts.SignatureDeclaration | null {
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isFunctionLike(parent)) return parent;
    parent = parent.parent;
  }
  return null;
}

function propertyValue(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
  parsed: ts.SourceFile,
): string | null {
  const property = objectLiteral.properties.find((item) => {
    if (!('name' in item) || !item.name) return false;
    return nodeText(item.name, parsed).replace(/^['"]|['"]$/gu, '') === propertyName;
  });
  if (!property || !ts.isPropertyAssignment(property)) return null;
  return nodeText(property.initializer, parsed);
}

function findDefaultFetchMethod(parsed: ts.SourceFile): MethodWithBody {
  const exports = parsed.statements.filter(
    (statement): statement is ts.ExportAssignment =>
      ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  const exportAssignment = exports[0];
  const exportedExpression =
    exportAssignment && ts.isSatisfiesExpression(exportAssignment.expression)
      ? exportAssignment.expression.expression
      : exportAssignment?.expression;
  if (
    exports.length !== 1 ||
    !exportAssignment ||
    !exportedExpression ||
    !ts.isObjectLiteralExpression(exportedExpression)
  ) {
    throw new Error(`Expected one default object export in ${parsed.fileName}.`);
  }
  const method = exportedExpression.properties.find(
    (property) => ts.isMethodDeclaration(property) && property.name.getText(parsed) === 'fetch',
  );
  if (!method || !ts.isMethodDeclaration(method) || !methodHasBody(method)) {
    throw new Error(`Expected a default fetch() method in ${parsed.fileName}.`);
  }
  return method;
}

function isInsideProBranch(node: ts.Node, parsed: ts.SourceFile): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isIfStatement(parent)) {
      const condition = nodeText(parent.expression, parsed);
      if (/\bproMatch\b/u.test(condition)) {
        const start = child.getStart(parsed);
        return (
          start >= parent.thenStatement.getStart(parsed) && start < parent.thenStatement.getEnd()
        );
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

function assertTurnAdmission(appWorkerSource: string, failures: string[]): void {
  const parsed = sourceFile(SOURCE_FILES.appWorker, appWorkerSource);
  const powDifficulty = nodeText(
    variableInitializer(parsed, 'CAPABILITY_POW_DIFFICULTY_DEFAULT'),
    parsed,
  );
  if (powDifficulty !== '12') {
    failures.push(
      `default capability proof-of-work difficulty must remain 12; found ${powDifficulty}`,
    );
  }

  const handler = findNamedFunction(parsed, 'handleTurnConfig');
  const guardCalls = callsNamed(handler, new Set(['guardSensitiveRequest']));
  if (guardCalls.length !== 1) {
    failures.push('standard TURN must invoke guardSensitiveRequest exactly once');
    return;
  }

  const guardCall = guardCalls[0];
  const options = guardCall?.arguments.at(-1);
  if (
    !options ||
    !ts.isObjectLiteralExpression(options) ||
    propertyValue(options, 'combinePerCapabilityRateLimit', parsed) !== 'true'
  ) {
    failures.push('standard TURN must opt into the single composite primary/capability limit');
  }

  const serviceControlNames = importedNames(parsed, './service-maintenance.ts');
  const directAtomicCalls = reachableRemoteCalls(handler, parsed, serviceControlNames, {
    skipNames: new Set(['guardSensitiveRequest']),
  });
  if (directAtomicCalls.length > 0) {
    failures.push('handleTurnConfig must not add an atomic consume beside its shared guard');
  }

  const sharedGuard = findNamedFunction(parsed, 'guardSensitiveRequest');
  const compositeBranches = collect(
    sharedGuard.body,
    (node): node is ts.IfStatement =>
      ts.isIfStatement(node) &&
      nodeText(node.expression, parsed).includes('options.combinePerCapabilityRateLimit'),
  );
  if (compositeBranches.length !== 1) {
    failures.push('guardSensitiveRequest must have one explicit composite-rate branch');
    return;
  }

  const compositeBranch = compositeBranches[0];
  if (!compositeBranch) return;
  const compositeStatementIndex = sharedGuard.body.statements.indexOf(compositeBranch);
  if (compositeStatementIndex < 0) {
    failures.push('composite TURN admission must remain a top-level guard branch');
    return;
  }

  const disabledAuthBranches = sharedGuard.body.statements.filter(
    (statement) =>
      ts.isIfStatement(statement) &&
      nodeText(statement.expression, parsed).includes('!isCapabilityAuthEnabled(env)'),
  );
  if (disabledAuthBranches.length !== 1) {
    failures.push('guardSensitiveRequest must retain one isolated capability-disabled branch');
    return;
  }

  const productionPrefix = sharedGuard.body.statements
    .slice(0, compositeStatementIndex)
    .filter((statement) => statement !== disabledAuthBranches[0]);
  const prefixRemoteCalls = productionPrefix.flatMap((statement) =>
    reachableRemoteCalls(statement, parsed, serviceControlNames, { countFetch: true }),
  );
  if (prefixRemoteCalls.length > 0) {
    failures.push(
      `standard TURN must not make a remote security decision before its composite branch; found ${prefixRemoteCalls.join(', ')}`,
    );
  }

  const branchCalls = callsNamed(
    compositeBranch.thenStatement,
    new Set(['checkPaidRateLimit', 'checkPaidRateLimitPair', ...ATOMIC_SERVICE_CONTROL_CALLS]),
  );
  const branchCallNames = branchCalls.map(callName);
  if (branchCallNames.length !== 1 || branchCallNames[0] !== 'checkPaidRateLimitPair') {
    failures.push(
      `composite TURN branch must make one rate decision; found ${branchCallNames.join(', ') || 'none'}`,
    );
  }

  const compositeRemoteCalls = reachableRemoteCalls(
    compositeBranch.thenStatement,
    parsed,
    serviceControlNames,
    { countFetch: true },
  );
  if (
    compositeRemoteCalls.length !== 1 ||
    compositeRemoteCalls[0] !== 'consumeAbuseRateLimitPair'
  ) {
    failures.push(
      `standard TURN production path must reach one composite remote decision; found ${compositeRemoteCalls.join(', ') || 'none'}`,
    );
  }

  const pairHelper = findNamedFunction(parsed, 'checkPaidRateLimitPair');
  const atomicCalls = callsNamed(pairHelper, ATOMIC_SERVICE_CONTROL_CALLS).map(callName);
  if (atomicCalls.length !== 1 || atomicCalls[0] !== 'consumeAbuseRateLimitPair') {
    failures.push(
      `standard TURN composite helper must reach exactly one atomic pair consume; found ${atomicCalls.join(', ') || 'none'}`,
    );
  }
}

function assertSignalingBoundary(signalingWorkerSource: string, failures: string[]): void {
  const parsed = sourceFile(SOURCE_FILES.signalingWorker, signalingWorkerSource);
  const standardRate = findNamedFunction(parsed, 'checkStandardWsRateLimit');
  const serviceControlNames = importedNames(parsed, './service-maintenance.ts');
  const standardRateText = nodeText(standardRate, parsed);
  if (!standardRateText.includes('MUSIXQUARE_ROOMS')) {
    failures.push('standard WebSocket admission must remain in the standard-room namespace');
  }
  if (
    standardRateText.includes('MUSIXQUARE_SERVICE_CONTROL') ||
    callsNamed(standardRate, ATOMIC_SERVICE_CONTROL_CALLS).length > 0
  ) {
    failures.push('standard WebSocket admission must not synchronously depend on service-control');
  }
  const standardRemoteCalls = reachableRemoteCalls(standardRate, parsed, serviceControlNames, {
    countFetch: true,
  });
  if (standardRemoteCalls.length !== 1 || standardRemoteCalls[0] !== 'fetch') {
    failures.push(
      `standard WebSocket admission must use one same-tier Durable Object fetch; found ${standardRemoteCalls.join(', ') || 'none'}`,
    );
  }

  const fetchMethod = findDefaultFetchMethod(parsed);
  const maintenanceStatements = fetchMethod.body.statements.filter(
    (statement) => callsNamed(statement, new Set(['gateServiceMaintenance'])).length > 0,
  );
  if (maintenanceStatements.length !== 1) {
    failures.push('signaling router must retain exactly one outer maintenance gate');
  } else {
    const maintenanceRemoteCalls = reachableRemoteCalls(
      maintenanceStatements[0] ?? fetchMethod.body,
      parsed,
      serviceControlNames,
    );
    if (
      maintenanceRemoteCalls.length !== 1 ||
      maintenanceRemoteCalls[0] !== 'gateServiceMaintenance'
    ) {
      failures.push('outer signaling maintenance must remain the only common Service-Control call');
    }
  }

  const proBranches = fetchMethod.body.statements.filter(
    (statement) =>
      ts.isIfStatement(statement) && nodeText(statement.expression, parsed) === 'proMatch',
  );
  if (proBranches.length !== 1) {
    failures.push('signaling router must retain one isolated PRO branch');
  }
  const standardPathStatements = fetchMethod.body.statements.filter(
    (statement) => statement !== maintenanceStatements[0] && statement !== proBranches[0],
  );
  const standardServiceControlCalls = standardPathStatements.flatMap((statement) =>
    reachableRemoteCalls(statement, parsed, serviceControlNames),
  );
  if (standardServiceControlCalls.length > 0) {
    failures.push(
      `standard WebSocket path must not reach Service-Control outside maintenance; found ${standardServiceControlCalls.join(', ')}`,
    );
  }

  const standardCalls = callsNamed(fetchMethod, new Set(['checkStandardWsRateLimit']));
  if (standardCalls.length !== 1 || standardCalls.some((call) => isInsideProBranch(call, parsed))) {
    failures.push('ordinary WebSocket admission must use exactly one standard-room rate decision');
  }
  const proCalls = callsNamed(fetchMethod, new Set(['checkProRateLimit']));
  if (proCalls.length !== 1 || proCalls.some((call) => !isInsideProBranch(call, parsed))) {
    failures.push('PRO rate admission must remain isolated inside the PRO branch');
  }
}

function assertInviteReturnsBeforeTurn(peerSource: string, failures: string[]): void {
  const parsed = sourceFile(SOURCE_FILES.peer, peerSource);
  const initNetwork = findNamedFunction(parsed, 'initNetwork');
  const declarations = collect(
    initNetwork.body,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'turnCredentialsRequest',
  );
  const turnCredentialsDeclaration = declarations[0];
  if (
    declarations.length !== 1 ||
    !turnCredentialsDeclaration?.initializer ||
    !nodeText(turnCredentialsDeclaration.initializer, parsed).includes(
      'getStandardRoomTurnCredentials',
    )
  ) {
    failures.push('initNetwork must start one reusable standard-room TURN request');
    return;
  }

  const claimBranches = collect(
    initNetwork.body,
    (node): node is ts.IfStatement =>
      ts.isIfStatement(node) && nodeText(node.expression, parsed) === 'canClaimWhileTurnLoads',
  );
  if (claimBranches.length !== 1) {
    failures.push('initNetwork must keep one signaling-while-TURN-loads branch');
    return;
  }

  const claimBranch = claimBranches[0];
  if (!claimBranch) return;
  const branch = claimBranch.thenStatement;
  const transportCalls = callsNamed(branch, new Set(['createTransportPeer']));
  if (transportCalls.length !== 1) {
    failures.push('parallel host initialization must create exactly one signaling transport');
    return;
  }

  const transportCall = transportCalls[0];
  if (!transportCall) return;
  const transportStart = transportCall.getStart(parsed);
  const earlyTurnWaits = collect(
    branch,
    (node) =>
      ts.isAwaitExpression(node) &&
      node.getStart(parsed) < transportStart &&
      /\b(?:turnCredentialsRequest|getStandardRoomTurnCredentials|rtcConfigurationRequest)\b/u.test(
        nodeText(node.expression, parsed),
      ),
  );
  if (earlyTurnWaits.length > 0) {
    failures.push('host signaling must start before awaiting TURN configuration');
  }

  if (turnCredentialsDeclaration.getStart(parsed) > claimBranch.getStart(parsed)) {
    failures.push('TURN warmup must start before entering the parallel signaling branch');
  }

  const branchText = nodeText(branch, parsed);
  if (!/deferRtcUntilConfigured\s*:\s*true/u.test(branchText)) {
    failures.push('parallel room claim must retain the RTC-configuration construction fence');
  }
  if (!branchText.includes('setRtcConfiguration')) {
    failures.push('parallel room claim must settle the RTC configuration gate');
  }

  const backgroundSettles = callsNamed(branch, new Set(['settleDeferredHostRtcConfiguration']));
  const backgroundSettle = backgroundSettles[0];
  if (
    backgroundSettles.length !== 1 ||
    !backgroundSettle ||
    !ts.isVoidExpression(backgroundSettle.parent)
  ) {
    failures.push('host TURN settlement must start exactly once as an observed background task');
  }

  let deferredSettlement: FunctionWithBody;
  try {
    deferredSettlement = findNamedFunction(parsed, 'settleDeferredHostRtcConfiguration');
  } catch {
    failures.push('parallel host initialization must retain its deferred RTC settlement helper');
    return;
  }
  if (
    callsNamed(deferredSettlement, new Set(['setRtcConfiguration'])).length !== 1 ||
    !collect(
      deferredSettlement,
      (node) =>
        ts.isAwaitExpression(node) &&
        containsIdentifier(nodeText(node.expression, parsed), 'turnCredentialsRequest'),
    ).length
  ) {
    failures.push('deferred RTC settlement must await TURN and release the RTC gate exactly once');
  }

  const directReturns = collect(
    branch,
    (node): node is ts.ReturnStatement =>
      ts.isReturnStatement(node) &&
      nearestFunctionLike(node) === initNetwork &&
      node.expression !== undefined,
  );
  const inviteReturns = directReturns.filter(
    (node) => node.expression !== undefined && nodeText(node.expression, parsed) === 'id',
  );
  if (inviteReturns.length !== 1) {
    failures.push('parallel host initialization must return one peer-open invite id');
    return;
  }

  const inviteReturn = inviteReturns[0];
  if (!inviteReturn) return;
  const idDeclarations = collect(
    branch,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'id' &&
      node.initializer !== undefined,
  );
  const idDeclaration = idDeclarations[0];
  if (
    idDeclarations.length !== 1 ||
    !idDeclaration?.initializer ||
    !ts.isAwaitExpression(idDeclaration.initializer) ||
    !containsIdentifier(nodeText(idDeclaration.initializer.expression, parsed), 'peerOpenRequest')
  ) {
    failures.push('invite id must come from the peer-open promise alone');
    return;
  }

  const tainted = taintedTurnIdentifiers(initNetwork.body, parsed);
  const waitsBeforeInvite = collect(
    branch,
    (node): node is ts.AwaitExpression =>
      ts.isAwaitExpression(node) &&
      nearestFunctionLike(node) === initNetwork &&
      node.getStart(parsed) < inviteReturn.getStart(parsed),
  );
  const turnWaitsBeforeInvite = waitsBeforeInvite.filter((wait) => {
    const text = nodeText(wait.expression, parsed);
    return [...tainted].some((name) => containsIdentifier(text, name));
  });
  if (turnWaitsBeforeInvite.length > 0) {
    failures.push('invite code must return after peer-open without awaiting TURN settlement');
  }

  const publishStart = branchText.indexOf('owner.peerReadyPublished = true');
  const returnStart = inviteReturn.getStart(parsed) - branch.getStart(parsed);
  if (publishStart < 0 || publishStart > returnStart) {
    failures.push('peer-open ownership must be published before returning the invite id');
  }
}

function assertSetupStartsTransportDirectly(
  setupHostSource: string,
  setupGuestSource: string,
  failures: string[],
): void {
  const forbiddenPreflight = /\b(?:waitForStandardRoomReadiness|assertCapabilityServiceReady)\b/u;
  if (forbiddenPreflight.test(setupHostSource)) {
    failures.push('host setup must start signaling without a control-plane readiness preflight');
  }
  if (forbiddenPreflight.test(setupGuestSource)) {
    failures.push('guest setup must start signaling without a control-plane readiness preflight');
  }

  const host = sourceFile(SOURCE_FILES.setupHost, setupHostSource);
  const guest = sourceFile(SOURCE_FILES.setupGuest, setupGuestSource);
  if (callsNamed(host, new Set(['createHostSessionWithShortCode'])).length !== 1) {
    failures.push('host setup must retain one direct signaling-owned room creation call');
  }
  if (callsNamed(guest, new Set(['joinSession'])).length < 2) {
    failures.push('guest setup must retain direct standard-room join calls');
  }
}

export async function loadStandardRoomHotPathSources(
  root = repoRoot,
): Promise<StandardRoomHotPathSources> {
  const [appWorker, signalingWorker, peer, setupHost, setupGuest] = await Promise.all([
    readFile(path.resolve(root, SOURCE_FILES.appWorker), 'utf8'),
    readFile(path.resolve(root, SOURCE_FILES.signalingWorker), 'utf8'),
    readFile(path.resolve(root, SOURCE_FILES.peer), 'utf8'),
    readFile(path.resolve(root, SOURCE_FILES.setupHost), 'utf8'),
    readFile(path.resolve(root, SOURCE_FILES.setupGuest), 'utf8'),
  ]);
  return { appWorker, signalingWorker, peer, setupHost, setupGuest };
}

export function assertStandardRoomHotPath(
  sources: StandardRoomHotPathSources,
): StandardRoomHotPathResult {
  const failures: string[] = [];
  assertTurnAdmission(sources.appWorker, failures);
  assertSignalingBoundary(sources.signalingWorker, failures);
  assertInviteReturnsBeforeTurn(sources.peer, failures);
  assertSetupStartsTransportDirectly(sources.setupHost, sources.setupGuest, failures);
  if (failures.length > 0) {
    throw new Error(
      `Standard-room security/performance policy failed:\n${failures
        .map((failure) => `  - ${failure}`)
        .join('\n')}`,
    );
  }
  return {
    capabilityPowDifficulty: 12,
    turnAtomicConsumes: 1,
    standardWebSocketServiceControlConsumes: 0,
    signalingStartsBeforeTurn: true,
    inviteReturnsBeforeTurn: true,
    rtcConfigurationFence: true,
  };
}

async function main(): Promise<void> {
  const sources = await loadStandardRoomHotPathSources();
  const result = assertStandardRoomHotPath(sources);
  console.log(
    `[standard-room-hot-path] OK: PoW ${result.capabilityPowDifficulty}, ` +
      `${result.turnAtomicConsumes} TURN atomic consume, ` +
      `${result.standardWebSocketServiceControlConsumes} standard-WS service-control consumes, ` +
      'the invite returns after peer-open before TURN settles, and the RTC fence remains enabled.',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
