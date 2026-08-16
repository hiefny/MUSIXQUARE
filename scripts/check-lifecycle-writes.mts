#!/usr/bin/env node
/**
 * check-lifecycle-writes.mts
 *
 * Static ratchet guard for the playback concurrency-control write discipline
 * documented in docs/design/playback-concurrency-invariants.md.
 *
 * The lifecycle contract requires direct state writes to be enforced in CI.
 * This script also covers the other statically checkable writer sets
 * the invariant matrix names:
 *
 *   CHECK 1: zero direct `setState('playback.lifecycle', ...)` calls in prod.
 *     All lifecycle writes go through transition() → ownership.ts
 *     setPlaybackLifecycleState (or the sanctioned batch writers, CHECK 2).
 *
 *   CHECK 2: `'playback.lifecycle':` as a batchSetState key only in the
 *     sanctioned writer files, with EXACT max occurrence counts (ownership.ts:
 *     setPlaybackLifecycleState + setPlaybackIdle; network/peer.ts:
 *     session-leave full reset). Exact counts: a new batch writer must show up
 *     here for review, not slip in silently.
 *
 *   CHECK 3: setPlaybackLifecycleState() prod CALLERS = lifecycle.ts only
 *     (definition in ownership.ts excluded via the `function ` lookbehind).
 *
 *   CHECK 4: setPlayPreloadedInProgress() prod callers ⊆ {decode.ts,
 *     transport.ts}. The flag has exactly two sanctioned writers: decode.ts's
 *     compare-before-clear activation owner (begin/finishPreloadActivation)
 *     and stopAllMedia's must-reset-together block (contract C4). A third
 *     writer is precisely how the documented flag-stomp double-play window
 *     (contract C1) re-opens.
 *
 *   CHECK 5: newLoadEpoch() prod callers ⊆ {player/playlist.ts,
 *     player/playback.ts, player/transport.ts, demo/mode.ts}. Epoch
 *     allocation is ENTRY-POINT-ONLY discipline — a load function allocating
 *     an epoch would self-abort at its own post-decode checkpoint. The
 *     allowlist is intentionally file-level because line numbers churn;
 *     ordering/protocol invariants belong to the concurrency tests
 *     (src/player/__tests__/concurrency-invariants.test.ts), and an eager
 *     static rule here would fight the deliberate supersession-window
 *     semantics. The aliases getLoadToken/incrementLoadToken were removed;
 *     an empty-allowlist check on the old call name remains so the name
 *     cannot be reintroduced as a fresh export + prod call.
 *
 * Deliberately NOT checked statically: clear-iff-current ordering, the
 * flag-stomp window, pendingPlayTime preserve/clear policy — those are
 * timing/protocol invariants covered by tests, not grep-able shapes.
 *
 * Scope / mechanics (mirrors check-bus-pairing.mts / check-chunk-pump.mts):
 *   - Comments stripped before matching (doc comments mention these symbols).
 *   - Test files (__tests__, *.test.ts, *.spec.ts, *.d.ts) excluded — tests
 *     legitimately write lifecycle state directly to stage scenarios.
 *   - Paths normalized to forward slashes (Windows dev environment).
 *   - Definitions excluded from "caller" checks via a `function ` lookbehind;
 *     bare import-list mentions don't match because callers require a `(`.
 *
 * Exit code: 0 if clean, 1 if findings remain.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// ── Allowlists ───────────────────────────────────────────────────

// CHECK 2: batchSetState object-key writers, exact max counts + reasons.
interface LifecycleBatchAllowance {
  readonly max: number;
  readonly reason: string;
}

const LIFECYCLE_BATCH_KEY_ALLOWLIST = new Map<string, LifecycleBatchAllowance>([
  [
    'src/player/ownership.ts',
    {
      max: 2,
      reason: 'setPlaybackLifecycleState (FSM apply) + setPlaybackIdle (sanctioned idle reset)',
    },
  ],
  [
    'src/network/peer.ts',
    { max: 1, reason: 'session-leave full state reset (resets the FSM with everything else)' },
  ],
]);

// CHECK 3-5: file-level caller allowlists.
const LIFECYCLE_SETTER_CALLERS = new Set<string>(['src/player/lifecycle.ts']);
const PRELOADED_FLAG_CALLERS = new Set<string>(['src/player/decode.ts', 'src/player/transport.ts']);
const LOAD_EPOCH_CALLERS = new Set<string>([
  'src/player/playlist.ts',
  'src/player/playback.ts',
  'src/player/transport.ts',
  'src/demo/mode.ts',
]);

// ── Matchers ─────────────────────────────────────────────────────
const DIRECT_SETSTATE_RE = /\bsetState\(\s*['"]playback\.lifecycle['"]/g;
const BATCH_KEY_RE = /['"]playback\.lifecycle['"]\s*:/g;
// `(?<!function )` excludes the definitions in ownership.ts/_state.ts;
// import-list mentions have no trailing `(` so they never match.
const LIFECYCLE_SETTER_CALL_RE = /(?<!function )\bsetPlaybackLifecycleState\s*\(/g;
const PRELOADED_FLAG_CALL_RE = /(?<!function )\bsetPlayPreloadedInProgress\s*\(/g;
const LOAD_EPOCH_CALL_RE = /(?<!function )\bnewLoadEpoch\s*\(/g;
// Legacy-name tombstone for the removed load-token alias.
// The symbol no longer exists anywhere in src — this regex can only fire if
// someone reintroduces the NAME as a fresh definition and calls it in prod.
const LOAD_TOKEN_ALIAS_CALL_RE = /(?<!function )\bincrementLoadToken\s*\(/g;

// Strip comments so doc mentions are not mistaken for call sites. The ':'
// guard on line comments leaves URLs intact.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

// Normalize to forward slashes — path.relative yields backslashes on Windows.
const rel = (file: string): string => relative(ROOT, file).replace(/\\/g, '/');

const sources = new Map<string, string>(); // relPath -> comment-stripped text
for (const file of walk(SRC)) {
  sources.set(rel(file), stripComments(readFileSync(file, 'utf8')));
}

const count = (text: string, expression: RegExp): number => (text.match(expression) ?? []).length;
const findings: string[] = [];

// ── CHECK 1: zero direct setState('playback.lifecycle') ─────────
for (const [relPath, text] of sources) {
  const n = count(text, DIRECT_SETSTATE_RE);
  if (n > 0) {
    findings.push(
      `DIRECT LIFECYCLE WRITE: ${relPath} calls setState('playback.lifecycle', ...) ${n}x — ` +
        `all prod writes must go through transition() (src/player/lifecycle.ts)`,
    );
  }
}

// ── CHECK 2: batch-key writers ratchet ───────────────────────────
for (const [relPath, text] of sources) {
  const n = count(text, BATCH_KEY_RE);
  if (n === 0) continue;
  const allowed = LIFECYCLE_BATCH_KEY_ALLOWLIST.get(relPath);
  if (!allowed) {
    findings.push(
      `UNSANCTIONED BATCH WRITER: ${relPath} writes the 'playback.lifecycle' key ${n}x — ` +
        `sanctioned batch writers are ownership.ts + network/peer.ts only`,
    );
  } else if (n > allowed.max) {
    findings.push(
      `RATCHET REGRESSION: ${relPath} writes the 'playback.lifecycle' key ${n}x (max ${allowed.max}) — ` +
        `a new batch writer must be reviewed against the FSM contract first`,
    );
  }
}

// ── CHECK 3-5: caller-set subsets ────────────────────────────────
interface CallerCheck {
  readonly name: string;
  readonly re: RegExp;
  readonly allow: ReadonlySet<string>;
  readonly hint: string;
}

const CALLER_CHECKS = [
  {
    name: 'setPlaybackLifecycleState',
    re: LIFECYCLE_SETTER_CALL_RE,
    allow: LIFECYCLE_SETTER_CALLERS,
    hint: 'lifecycle writes are FSM-owned — route through transition()',
  },
  {
    name: 'setPlayPreloadedInProgress',
    re: PRELOADED_FLAG_CALL_RE,
    allow: PRELOADED_FLAG_CALLERS,
    hint:
      'the activation flag has exactly two sanctioned writers (decode.ts owner seq, ' +
      'transport.ts stopAllMedia) — a third re-opens the flag-stomp double-play window (C1/C4)',
  },
  {
    name: 'newLoadEpoch',
    re: LOAD_EPOCH_CALL_RE,
    allow: LOAD_EPOCH_CALLERS,
    hint:
      'epoch allocation is entry-point-only — a load function allocating an epoch self-aborts ' +
      'at its own checkpoint (see invariants doc §1 M1)',
  },
  {
    name: 'incrementLoadToken (legacy alias)',
    // Empty allowlist tombstone: the alias export no longer exists. Any call
    // under the old name means the symbol was reintroduced.
    re: LOAD_TOKEN_ALIAS_CALL_RE,
    allow: new Set<string>(),
    hint:
      'legacy alias of newLoadEpoch, deleted 2026-06-12 — do not reintroduce the old name; ' +
      'use the epoch API (see invariants doc §1 M1)',
  },
] satisfies readonly CallerCheck[];

for (const check of CALLER_CHECKS) {
  for (const [relPath, text] of sources) {
    const n = count(text, check.re);
    if (n === 0) continue;
    if (!check.allow.has(relPath)) {
      findings.push(`UNSANCTIONED CALLER: ${relPath} calls ${check.name}() ${n}x — ${check.hint}`);
    }
  }
}

// ── Report ───────────────────────────────────────────────────────
console.log('── Playback lifecycle/concurrency write-discipline check ──');
console.log(
  `scanned ${sources.size} prod files; ` +
    `${LIFECYCLE_BATCH_KEY_ALLOWLIST.size} batch writers + ` +
    `${LIFECYCLE_SETTER_CALLERS.size + PRELOADED_FLAG_CALLERS.size + LOAD_EPOCH_CALLERS.size} caller files allowlisted`,
);
console.log('');

if (!findings.length) {
  console.log('OK — lifecycle writes FSM-owned; flag and epoch writer sets within ratchet.');
  process.exit(0);
}

for (const f of findings) console.log(`  ${f}`);
console.log('');
console.log(`Total findings: ${findings.length}`);
process.exit(1);
