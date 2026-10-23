#!/usr/bin/env node
/**
 * check-navigation-sinks.mts (guard:navigation-sinks)
 *
 * Static ratchet for the page navigation owner (registry RO-23, with RO-22 and
 * RO-30; docs/design/page-navigation-ownership.md). The resource-ownership
 * guard counts these sinks per file; this guard pins each one to the function
 * that owns it and pins who may ask the owner to navigate, so a new requester
 * cannot build its own navigation, promotion or Back machine.
 *
 *   CHECK 1 Location navigation sinks, per `file :: function`: calls of
 *     reload/replace/assign on a `location` receiver, and writes to
 *     `location`, `X.location` or a property of a location receiver
 *     (`location.href = …`). Allowed: the owner's reload sink, the navigation
 *     intents in core/navigation.ts, the account login popup (another window),
 *     and the locale navigation (owner decision 7, 2026-10-23).
 *   CHECK 2 `SKIP_WAITING` messages, per `file :: function`: the update
 *     machine in sw-register.ts and the hard-reset promotion (until Phase 3
 *     C6-10 makes it ask the update machine).
 *   CHECK 3 History traversal (back/go/forward on a `history` receiver), per
 *     `file :: function`: the Back leave in back-button-history.ts and the
 *     guard's navigateBack port in app.ts.
 *   CHECK 4 Requesters of the owner, per file: calls of scheduleSessionReset
 *     and scheduleDocumentReload outside core/session-reset.ts's own
 *     definitions.
 *   CHECK 5 Unload-exemption claimers, per file: calls of claimUnloadExemption
 *     (the owner's action and the same-tab login).
 *   CHECK 6 Retired names stay gone: no production declaration or export of a
 *     name the Phase 2 owner replaced (restoreSessionReset,
 *     requestDocumentReload, DocumentReloadAttempt, the intentional-navigation
 *     flag functions, setSessionResetReleaseHandler and the old test seams).
 *
 * Every list is exact: a new site fails as unsanctioned, a count above its
 * baseline fails as a regression, and a count below it fails until the
 * baseline is lowered in the same change, with the reason.
 *
 * Out of scope: anchors and forms that navigate on activation (account.ts's
 * Google login link), `window.open`, location reads, receivers resolved only
 * by type, and src/ files outside production (tests, *.d.ts). Scope:
 * production TypeScript under src/. The checks walk the TypeScript AST, so
 * comments and unrelated strings never count.
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

type Baseline = ReadonlyMap<string, Allowance>;

// ── Baselines ────────────────────────────────────────────────────────────

/** CHECK 1: location navigation sinks, per `file :: function`. */
const LOCATION_SINK_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/core/navigation.ts :: navigateToAppHome',
    { count: 1, reason: 'home intent, replace: leaving does not keep the room URL in history' },
  ],
  [
    'src/core/navigation.ts :: pushAppHome',
    { count: 1, reason: 'home intent, push: the setup-guest Back buttons (owner decision 6)' },
  ],
  [
    'src/core/navigation.ts :: returnToRoomStart',
    { count: 1, reason: 'the /CODE return, after its six-digit check' },
  ],
  [
    'src/core/session-reset.ts :: startQueuedReload.navigate',
    { count: 1, reason: "the navigation owner's reload sink, inside the claim fence" },
  ],
  [
    'src/i18n/localized-app-document.ts :: requestFullDocumentNavigation',
    {
      count: 1,
      reason:
        'locale navigation, outside the owner by owner decision 7 (2026-10-23): the fail-safe ' +
        'full-document switch to a localized entry when the History API cannot rewrite the path, ' +
        'after a cancelable mxqr:locale-navigation-request; it never claims the unload exemption, ' +
        'so a live session still asks before leaving',
    },
  ],
  [
    'src/ui/account.ts :: openIsolatedAccountLoginPopup',
    { count: 1, reason: 'the Google login popup window, not this document' },
  ],
]);

/** CHECK 2: 'SKIP_WAITING' messages, per `file :: function`. */
const SKIP_WAITING_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/core/sw-hard-reset.ts :: activatePendingServiceWorkerForHardReset',
    {
      count: 1,
      reason: 'hard-reset promotion, the logo prepare step (Phase 3 C6-10 makes it ask)',
    },
  ],
  [
    'src/sw-register.ts :: registerServiceWorker.doRegister.handleWaitingWorker',
    {
      count: 4,
      reason:
        'the update machine: Apply, the cooldown and hidden-tab promotions (Phase 3 C6-9 gives ' +
        'them one activateWaitingWorker sink)',
    },
  ],
]);

/** CHECK 3: history traversal (back/go/forward), per `file :: function`. */
const HISTORY_TRAVERSAL_BASELINE: Baseline = new Map<string, Allowance>([
  [
    'src/app.ts :: initBackButtonGuard.navigateBack',
    { count: 1, reason: "the Back guard's port: an unused guard entry passes Back on" },
  ],
  [
    'src/core/back-button-history.ts :: createBackButtonHistory.back',
    { count: 1, reason: "the confirmed leave's traversal past this document's entries" },
  ],
]);

/** CHECK 4: scheduleSessionReset / scheduleDocumentReload callers, per file. */
const OWNER_REQUESTER_BASELINE: Baseline = new Map<string, Allowance>([
  ['src/app.ts', { count: 2, reason: 'the confirmed Back leave and the lazy-feature reload' }],
  ['src/core/navigation.ts', { count: 2, reason: 'the home and /CODE intents' }],
  [
    'src/core/session-reset.ts',
    { count: 1, reason: "the owner's own bounded reload after a back-forward cache return" },
  ],
  ['src/network/peer.ts', { count: 1, reason: 'reload after a stale session' }],
  [
    'src/pro-room/runtime.ts',
    { count: 3, reason: 'terminal PRO recovery: superseded tab, removal, session end' },
  ],
  ['src/sw-register.ts', { count: 1, reason: 'the update reload outside a room' }],
  ['src/ui/keep-open-notice.ts', { count: 1, reason: 'leave from the keep-open notice' }],
  ['src/ui/player-controls.ts', { count: 1, reason: 'the logo reset (prepare: SW promotion)' }],
  ['src/ui/setup-guest.ts', { count: 3, reason: 'guest join recovery reloads' }],
  ['src/ui/setup-host.ts', { count: 1, reason: 'host start recovery reload' }],
  ['src/ui/setup.ts', { count: 4, reason: 'reconnect and PIN-removal fallbacks' }],
]);

/** CHECK 5: claimUnloadExemption callers, per file. */
const UNLOAD_EXEMPTION_BASELINE: Baseline = new Map<string, Allowance>([
  ['src/core/session-reset.ts', { count: 1, reason: 'the owner, from action start to settle' }],
  ['src/ui/account.ts', { count: 1, reason: 'the same-tab Google login, 10-minute bound' }],
]);

/** CHECK 6: names the Phase 2 owner replaced (C6-4 to C6-13). */
const RETIRED_NAMES = new Map<string, string>([
  ['restoreSessionReset', 'use the request isCurrent() (C6-8)'],
  ['requestDocumentReload', 'use scheduleDocumentReload (C6-5)'],
  ['DocumentReloadAttempt', 'the owner holds reload attempts (C6-5)'],
  ['markIntentionalNav', 'use claimUnloadExemption (C6-7)'],
  ['clearIntentionalNav', 'release your own unload-exemption claim (C6-7)'],
  ['isIntentionalNav', 'beforeunload reads the claims (C6-7)'],
  ['setSessionResetReleaseHandler', 'use setSessionResetWindowLayer (C6-11)'],
  ['__resetSessionResetForTests', 'use __resetPageNavigationForTests (C6-13)'],
  ['__resetDocumentReloadForTests', 'use __resetPageNavigationForTests (C6-13)'],
]);

const OWNER_VERBS = new Set(['scheduleSessionReset', 'scheduleDocumentReload']);
const LOCATION_METHODS = new Set(['reload', 'replace', 'assign']);
const HISTORY_TRAVERSAL_METHODS = new Set(['back', 'go', 'forward']);

// ── Input ────────────────────────────────────────────────────────────────

export interface NavigationSinksInput {
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

export function loadNavigationSinksInput(root: string = repoRoot): NavigationSinksInput {
  const files: string[] = [];
  walk(path.join(root, 'src'), root, files);
  const sources = new Map<string, string>();
  for (const relPath of files.filter(isProductionSource).sort()) {
    sources.set(relPath, readFileSync(path.join(root, relPath), 'utf8'));
  }
  return { sources };
}

// ── AST helpers ──────────────────────────────────────────────────────────

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** Name of a property access (`a.b`) or string-keyed element access (`a['b']`). */
function memberName(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

/** Last identifier of a receiver: `window.location` -> `location`. */
function receiverName(expression: ts.Expression): string | null {
  const current = unwrap(expression);
  if (ts.isIdentifier(current)) return current.text;
  return memberName(current);
}

function isAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

function propertyNameText(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText();
}

/** The name a function-like node is known by, or null for an anonymous one. */
function functionName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name
  ) {
    return propertyNameText(node.name);
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      return propertyNameText(parent.name);
    }
  }
  return null;
}

/** Named functions around a node, outermost first: `outer.inner`. */
function functionChain(node: ts.Node): string {
  const names: string[] = [];
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    const name = functionName(current);
    if (name) names.unshift(name);
  }
  return names.length > 0 ? names.join('.') : '<module>';
}

// ── Analysis ─────────────────────────────────────────────────────────────

interface Facts {
  readonly locationSinks: Map<string, number>;
  readonly skipWaitingSends: Map<string, number>;
  readonly historyTraversals: Map<string, number>;
  readonly ownerRequests: Map<string, number>;
  readonly unloadExemptionClaims: Map<string, number>;
  readonly retiredNames: string[];
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function isLocationReceiver(expression: ts.Expression): boolean {
  return receiverName(expression) === 'location';
}

function declaredName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name
  ) {
    return node.name.text;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isExportSpecifier(node)) return node.name.text;
  return null;
}

function collectFacts(input: NavigationSinksInput): Facts {
  const facts: Facts = {
    locationSinks: new Map(),
    skipWaitingSends: new Map(),
    historyTraversals: new Map(),
    ownerRequests: new Map(),
    unloadExemptionClaims: new Map(),
    retiredNames: [],
  };
  for (const [relPath, text] of input.sources) {
    const file = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const site = (node: ts.Node): string => `${relPath} :: ${functionChain(node)}`;
    visit(file, (node) => {
      const declared = declaredName(node);
      if (declared !== null && RETIRED_NAMES.has(declared)) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        facts.retiredNames.push(`${relPath}:${line} ${declared}`);
      }

      if (ts.isStringLiteralLike(node) && node.text === 'SKIP_WAITING') {
        bump(facts.skipWaitingSends, site(node));
      }

      const member = memberName(node);
      if (
        member !== null &&
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      ) {
        const receiver = node.expression;
        const call = node.parent;
        const called = ts.isCallExpression(call) && call.expression === node;
        if (called && LOCATION_METHODS.has(member) && isLocationReceiver(receiver)) {
          bump(facts.locationSinks, site(node));
        } else if (
          isAssignmentTarget(node) &&
          (member === 'location' || isLocationReceiver(receiver))
        ) {
          bump(facts.locationSinks, site(node));
        }
        if (
          called &&
          HISTORY_TRAVERSAL_METHODS.has(member) &&
          receiverName(receiver) === 'history'
        ) {
          bump(facts.historyTraversals, site(node));
        }
      } else if (ts.isIdentifier(node) && node.text === 'location' && isAssignmentTarget(node)) {
        bump(facts.locationSinks, site(node));
      }

      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        const name = ts.isIdentifier(callee) ? callee.text : memberName(callee);
        if (name !== null && OWNER_VERBS.has(name)) bump(facts.ownerRequests, relPath);
        if (name === 'claimUnloadExemption') bump(facts.unloadExemptionClaims, relPath);
      }
    });
  }
  return facts;
}

interface ExactCheck {
  readonly label: string;
  readonly hint: string;
  readonly measured: ReadonlyMap<string, number>;
  readonly baseline: Baseline;
}

function compareExact(check: ExactCheck, findings: string[]): void {
  for (const [key, count] of [...check.measured].sort(([a], [b]) => a.localeCompare(b))) {
    const allowance = check.baseline.get(key);
    if (!allowance) {
      findings.push(`UNSANCTIONED ${check.label}: ${key} has ${count} - ${check.hint}`);
    } else if (count > allowance.count) {
      findings.push(
        `RATCHET REGRESSION ${check.label}: ${key} has ${count}, baseline ${allowance.count} - ${check.hint}`,
      );
    }
  }
  for (const [key, allowance] of check.baseline) {
    const count = check.measured.get(key) ?? 0;
    if (count < allowance.count) {
      findings.push(
        `STALE BASELINE ${check.label}: ${key} has ${count}, baseline ${allowance.count} - ` +
          'lower or remove its entry in this change',
      );
    }
  }
}

function total(measured: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const count of measured.values()) sum += count;
  return sum;
}

export interface NavigationSinksReport {
  readonly findings: readonly string[];
  readonly productionFiles: number;
  readonly counts: Readonly<Record<string, number>>;
}

export function analyzeNavigationSinks(input: NavigationSinksInput): NavigationSinksReport {
  const facts = collectFacts(input);
  const findings: string[] = [];
  const checks: readonly ExactCheck[] = [
    {
      label: 'location navigation',
      hint: 'navigate through core/session-reset.ts (scheduleSessionReset, scheduleDocumentReload) or an intent in core/navigation.ts',
      measured: facts.locationSinks,
      baseline: LOCATION_SINK_BASELINE,
    },
    {
      label: 'SKIP_WAITING send',
      hint: 'promote a waiting worker through the update machine in src/sw-register.ts',
      measured: facts.skipWaitingSends,
      baseline: SKIP_WAITING_BASELINE,
    },
    {
      label: 'history traversal',
      hint: 'Back belongs to core/back-button-guard.ts and core/back-button-history.ts (RO-30)',
      measured: facts.historyTraversals,
      baseline: HISTORY_TRAVERSAL_BASELINE,
    },
    {
      label: 'navigation owner requester',
      hint: 'a new requester of scheduleSessionReset/scheduleDocumentReload is reviewed here and in RO-23',
      measured: facts.ownerRequests,
      baseline: OWNER_REQUESTER_BASELINE,
    },
    {
      label: 'unload-exemption claim',
      hint: 'navigate through the owner, which claims the exemption for its action',
      measured: facts.unloadExemptionClaims,
      baseline: UNLOAD_EXEMPTION_BASELINE,
    },
  ];
  for (const check of checks) compareExact(check, findings);
  for (const entry of facts.retiredNames) {
    const name = entry.slice(entry.lastIndexOf(' ') + 1);
    findings.push(`RETIRED NAME: ${entry} - ${RETIRED_NAMES.get(name) ?? 'retired'}`);
  }
  const counts: Record<string, number> = {};
  for (const check of checks) counts[check.label] = total(check.measured);
  return { findings, productionFiles: input.sources.size, counts };
}

export function assertNavigationSinks(input: NavigationSinksInput): NavigationSinksReport {
  const report = analyzeNavigationSinks(input);
  if (report.findings.length > 0) {
    throw new Error(
      `Navigation-sink check failed:\n${report.findings
        .map((finding) => `  - ${finding}`)
        .join('\n')}\n` +
        'See docs/design/page-navigation-ownership.md. Lower a baseline in the change that ' +
        'removes a site; add or raise one only with the reason and an RO-23 update.',
    );
  }
  return report;
}

function main(argv: readonly string[]): void {
  const rootArgument = argv.find((argument) => argument.startsWith('--root='));
  const root = rootArgument ? path.resolve(rootArgument.slice('--root='.length)) : repoRoot;
  const report = assertNavigationSinks(loadNavigationSinksInput(root));
  const summary = Object.entries(report.counts)
    .map(([label, count]) => `${label} ${count}`)
    .join(', ');
  console.log(
    `[navigation-sinks] OK: ${report.productionFiles} production files; ${summary}; ` +
      `${RETIRED_NAMES.size} retired names absent.`,
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
