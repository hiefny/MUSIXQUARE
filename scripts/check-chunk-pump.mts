#!/usr/bin/env node
/**
 * check-chunk-pump.mts
 *
 * Static ratchet guard for the shared chunk-pump engine.
 *
 * The multi-peer chunk pump once existed as separate copies in
 * transfer-send.ts (broadcastFile) and preload.ts (backgroundTransfer), so
 * backpressure behavior could diverge between the sibling paths. The copies
 * were unified into src/storage/chunk-pump.ts (pumpChunksToPeers). This guard
 * keeps that shared-engine design as a CI invariant:
 *
 *   CHECK 1 (ratchet): `bufferedAmount` — the telltale of an inline
 *     backpressure pump — may appear only in allowlisted files, each with an
 *     EXACT max occurrence count. Exact counts matter: the two allowlisted
 *     wrapper files (which keep their single-peer unicast pumps) are
 *     precisely the files most at risk of regrowing an inline BROADCAST
 *     pump, so a file-level pass would defeat the guard.
 *
 *   CHECK 2 (pairing): both broadcast wrappers must still import
 *     pumpChunksToPeers from './chunk-pump.ts', so deleting the shared-engine
 *     call cannot pass CHECK 1 by also deleting the bufferedAmount loop.
 *
 * Scope / deliberate limitations:
 *   - Comments are stripped before matching (e.g. network/protocol.ts
 *     mentions bufferedAmount inside a comment — that must not trip).
 *   - Test files (__tests__, *.test.ts, *.spec.ts, *.d.ts) are excluded.
 *   - Paths are normalized to forward slashes (Windows dev environment).
 *
 * Exit code: 0 if clean, 1 if findings remain.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// ── Allowlist ────────────────────────────────────────────────────
// Files allowed to reference bufferedAmount, with EXACT max counts + reasons.
interface BufferedAmountAllowance {
  readonly max: number;
  readonly reason: string;
}

const BUFFERED_AMOUNT_ALLOWLIST = new Map<string, BufferedAmountAllowance>([
  [
    'src/storage/chunk-pump.ts',
    { max: 1, reason: 'THE shared multi-peer pump engine — the only sanctioned broadcast loop' },
  ],
  [
    'src/storage/transfer-send.ts',
    {
      max: 1,
      reason:
        'unicastFile single-peer degenerate pump — intentional divergence (FILE_RESUME / return-on-timeout semantics)',
    },
  ],
  [
    'src/storage/preload.ts',
    {
      max: 1,
      reason:
        'unicastPreload single-peer degenerate pump — intentional divergence (_activePreloadUnicasts registry semantics)',
    },
  ],
]);

// ── Pump pairing ─────────────────────────────────────────────────
// Both broadcast wrappers must import the shared engine symbol.
const PUMP_IMPORTERS: readonly string[] = [
  'src/storage/transfer-send.ts',
  'src/storage/preload.ts',
];
const PUMP_IMPORT_RE =
  /import\s*\{[^}]*\bpumpChunksToPeers\b[^}]*\}\s*from\s*['"]\.\/chunk-pump\.ts['"]/;

// ── Matchers ─────────────────────────────────────────────────────
const BUFFERED_AMOUNT_RE = /\bbufferedAmount\b/g;

// Strip comments so doc-comment mentions of bufferedAmount are not mistaken
// for real pump code. The ':' guard on line comments leaves URLs intact.
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

const findings: string[] = [];
let scanned = 0;
let referencing = 0;

const sources = new Map<string, string>(); // relPath -> comment-stripped text
for (const file of walk(SRC)) {
  sources.set(rel(file), stripComments(readFileSync(file, 'utf8')));
}

// ── CHECK 1: bufferedAmount ratchet ──────────────────────────────
for (const [relPath, text] of sources) {
  scanned++;
  const count = (text.match(BUFFERED_AMOUNT_RE) ?? []).length;
  if (count === 0) continue;
  referencing++;

  const allowed = BUFFERED_AMOUNT_ALLOWLIST.get(relPath);
  if (!allowed) {
    findings.push(
      `UNSANCTIONED PUMP: ${relPath} references bufferedAmount ${count}x — ` +
        `multi-peer chunk streaming must go through pumpChunksToPeers (src/storage/chunk-pump.ts)`,
    );
  } else if (count > allowed.max) {
    findings.push(
      `RATCHET REGRESSION: ${relPath} references bufferedAmount ${count}x (max ${allowed.max}) — ` +
        `an inline pump is regrowing; route it through pumpChunksToPeers instead`,
    );
  }
}

// ── CHECK 2: shared-engine pairing ───────────────────────────────
for (const relPath of PUMP_IMPORTERS) {
  const text = sources.get(relPath);
  if (text === undefined) {
    findings.push(`MISSING FILE: ${relPath} not found — pump pairing cannot be verified`);
    continue;
  }
  if (!PUMP_IMPORT_RE.test(text)) {
    findings.push(
      `UNPAIRED WRAPPER: ${relPath} no longer imports pumpChunksToPeers from './chunk-pump.ts' — ` +
        `its broadcast path must use the shared engine`,
    );
  }
}

// ── Report ───────────────────────────────────────────────────────
console.log('── Chunk-pump ratchet check ────────────────────────────');
console.log(
  `scanned ${scanned} prod files; ${referencing} reference bufferedAmount, ` +
    `${BUFFERED_AMOUNT_ALLOWLIST.size} allowlisted`,
);
console.log('');

if (!findings.length) {
  console.log('OK — single shared pump engine; unicast degenerates within ratchet limits.');
  process.exit(0);
}

for (const f of findings) console.log(`  ${f}`);
console.log('');
console.log(`Total findings: ${findings.length}`);
process.exit(1);
