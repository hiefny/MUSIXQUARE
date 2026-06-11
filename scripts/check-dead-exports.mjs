#!/usr/bin/env node
/**
 * check-dead-exports.mjs
 *
 * Static ratchet guard for dead exports in production source.
 *
 * The 2026-06-11 full-project analysis found ~130 exported symbols in src/
 * with no production importer. A fix batch deleted the worst offenders; this
 * script freezes the remainder so the set can only SHRINK:
 *
 *   FULLY-DEAD : exported symbol with ZERO token references outside its own
 *                declaration site(s) anywhere in src/, e2e/, scripts/,
 *                index.html or public/. Ratchet: any fully-dead export NOT in
 *                FULLY_DEAD_BASELINE below fails the check (exit 1). The
 *                baseline is shrink-only — delete entries as the symbols are
 *                removed; NEVER add entries to silence a finding (delete the
 *                rogue export instead).
 *
 *   TEST-ONLY  : referenced only by unit tests (src/** __tests__ / *.test.ts).
 *                Reported as INFO with a per-file list, plus a frozen COUNT
 *                ratchet: the check fails only if the count GROWS above
 *                TEST_ONLY_BASELINE_COUNT (a new test-only export needs a
 *                deliberate decision, not a drive-by). Shrink updates are
 *                manual. Symbols matching the sanctioned test-seam naming
 *                convention /ForTests$/ (e.g. __resetXxxForTests) are exempt
 *                entirely — that suffix IS the repo's explicit contract for
 *                "exported for tests on purpose".
 *
 *   SELF-ONLY  : referenced only within its defining file (the `export`
 *                keyword is unnecessary). Counted as INFO only — not part of
 *                the ratchet; clean up opportunistically.
 *
 * Scope / deliberate limitations (honest, not magic):
 *   - Token-level (word-boundary identifier) matching, same approach as the
 *     prior analysis. It CANNOT see string-based dynamic dispatch — string
 *     literal contents ARE tokenized (conservative: a name mentioned in a
 *     registry string keeps the symbol alive), but anything wired through
 *     computed names is invisible. Spot-check candidates referenced from
 *     index.html / public/ inline scripts or the chat command registry
 *     (src/chat/commands.ts) before deleting.
 *   - Same-named exports in different files cannot be told apart: a reference
 *     to the NAME anywhere keeps every declaration of that name alive
 *     (conservative direction — over-LIVE, never false-dead).
 *   - Re-export bindings (`export { x } from './y.ts'`) are treated as
 *     additional declaration sites of the same name, not separate symbols.
 *   - `export default` is out of scope: the only defaults are the i18n locale
 *     tables, loaded dynamically by the i18n loader; name-token matching is
 *     meaningless for them.
 *   - e2e/ references count as LIVE, not TEST-ONLY: e2e drives the built app
 *     through page-level hooks, so a symbol it names is product surface.
 *   - Comments are stripped before parsing AND before reference counting
 *     (same stripComments as the sibling check-* scripts), so doc-comment
 *     mentions neither create exports nor keep symbols alive.
 *   - Only top-level (column-0) export statements are parsed; this repo is
 *     consistently formatted, and nested `export` is illegal in modules.
 *
 * Exit code: 0 if clean (modulo baseline), 1 if findings remain.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// ── FULLY-DEAD baseline ──────────────────────────────────────────
// Frozen 2026-06-11 from the current tree, after the same-day deletion batch
// removed the mechanically-safe ones. Shrink-only: remove an entry when the
// symbol (or its export) is deleted; adding entries requires an explicit
// owner decision recorded in the reason. Format: { symbol, file, reason }.
const FULLY_DEAD_BASELINE = [
  {
    symbol: 'cancelPendingBroadcast',
    file: 'src/storage/transfer-send.ts',
    reason:
      'cancel affordance shipped with the broadcast debounce (000ff02d); zero callers today, ' +
      'but its doc comment names session-leave/cancel as intended call sites — this smells ' +
      'like a MISSING cancel-propagation call (15th-audit matrix discipline), not dead weight. ' +
      'Owner: either wire it into session-leave teardown or delete it together with the ' +
      're-export below.',
  },
  {
    symbol: 'cancelPendingBroadcast',
    file: 'src/storage/transfer.ts',
    reason: 're-export binding of the transfer-send.ts entry above; same triage decision.',
  },
  {
    symbol: 'getPendingSetupRole',
    file: 'src/ui/setup-shared.ts',
    reason:
      'getter has zero callers, but the backing _pendingSetupRole is still WRITTEN from ' +
      'setup.ts / setup-host.ts / setup-guest.ts / setup-shared.ts:417 — write-only module ' +
      'state means either a missing read (regression) or a whole vestigial mechanism. ' +
      'Deleting only the getter would hide that smell from this guard; owner to triage the ' +
      'mechanism as a unit.',
  },
];

// ── TEST-ONLY count baseline ─────────────────────────────────────
// Number of exports referenced only by unit tests (excluding the sanctioned
// /ForTests$/ seams). Fails only if the count GROWS; update manually when it
// shrinks. Frozen 2026-06-11.
const TEST_ONLY_BASELINE_COUNT = 18;

// ── Walk / strip helpers (mirrors check-bus-pairing.mjs) ─────────

function stripComments(text) {
  return text
    // Blank block comments but keep their newlines so line numbers stay accurate.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

const rel = (file) => relative(ROOT, file).replace(/\\/g, '/');

function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(full, exts, out);
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const isTestPath = (relPath) =>
  relPath.includes('/__tests__/') ||
  relPath.endsWith('.test.ts') ||
  relPath.endsWith('.spec.ts');

const isProdSrc = (relPath) =>
  relPath.startsWith('src/') && relPath.endsWith('.ts') &&
  !relPath.endsWith('.d.ts') && !isTestPath(relPath);

// ── Gather the corpus ────────────────────────────────────────────
// corpus: relPath -> comment-stripped text, tagged by role:
//   'prod'  : src prod .ts (declaration source + live-reference source)
//   'test'  : src unit tests (test-only-reference source)
//   'live'  : e2e/, scripts/, index.html, public/ (live-reference source)

const corpus = new Map(); // relPath -> { text, role }

for (const file of walk(join(ROOT, 'src'), ['.ts'])) {
  const relPath = rel(file);
  if (relPath.endsWith('.d.ts')) continue;
  const role = isTestPath(relPath) ? 'test' : 'prod';
  corpus.set(relPath, { text: stripComments(readFileSync(file, 'utf8')), role });
}

for (const dir of ['e2e', 'scripts']) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs, ['.ts', '.js', '.mjs', '.html'])) {
    const relPath = rel(file);
    // Self-exclusion: the baseline below names the very symbols it freezes;
    // counting this file as a reference source would keep every baselined
    // symbol "alive" and report the whole baseline as stale.
    if (relPath === 'scripts/check-dead-exports.mjs') continue;
    const raw = readFileSync(file, 'utf8');
    const text = relPath.endsWith('.html')
      ? stripComments(stripHtmlComments(raw))
      : stripComments(raw);
    corpus.set(relPath, { text, role: 'live' });
  }
}

{
  const idx = join(ROOT, 'index.html');
  if (existsSync(idx)) {
    corpus.set('index.html', {
      text: stripComments(stripHtmlComments(readFileSync(idx, 'utf8'))),
      role: 'live',
    });
  }
  const pub = join(ROOT, 'public');
  if (existsSync(pub)) {
    for (const file of walk(pub, ['.js', '.mjs', '.html'])) {
      const raw = readFileSync(file, 'utf8');
      const relPath = rel(file);
      corpus.set(relPath, {
        text: relPath.endsWith('.html')
          ? stripComments(stripHtmlComments(raw))
          : stripComments(raw),
        role: 'live',
      });
    }
  }
}

// ── Parse top-level exports from prod src ────────────────────────

// Declaration forms (column-0 anchored; see header for why that is safe).
const DECL_RES = [
  /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+interface\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+type\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/gm,
];
// Export lists: `export { a, b }` / `export { a } from './x.ts'` (may span lines).
const LIST_RE = /^export\s*(type\s+)?\{([^}]*)\}/gm;

/** name -> { files: Map<relPath, declCount>, kinds: Set<string> } */
const exportsByName = new Map();

function recordExport(name, relPath) {
  if (!exportsByName.has(name)) {
    exportsByName.set(name, { files: new Map() });
  }
  const entry = exportsByName.get(name);
  entry.files.set(relPath, (entry.files.get(relPath) ?? 0) + 1);
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

for (const [relPath, { text, role }] of corpus) {
  if (role !== 'prod') continue;
  for (const re of DECL_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) recordExport(m[1], relPath);
  }
  LIST_RE.lastIndex = 0;
  let m;
  while ((m = LIST_RE.exec(text))) {
    for (const part of m[2].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      // `local as exported` — the EXPORTED name is the public surface.
      const asMatch = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(piece);
      if (!asMatch) continue;
      recordExport(asMatch[2] ?? asMatch[1], relPath);
    }
  }
}

// ── Tokenize the corpus once ─────────────────────────────────────
// relPath -> Map<identifier, count>. Identifier = word-boundary token; string
// literal contents are included on purpose (registry-string conservatism).

const TOKEN_RE = /[A-Za-z_$][\w$]*/g;
const tokensByFile = new Map();
for (const [relPath, { text }] of corpus) {
  const counts = new Map();
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text))) {
    counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  tokensByFile.set(relPath, counts);
}

// ── Classify each exported name ──────────────────────────────────

const SANCTIONED_SEAM_RE = /ForTests$/;

const fullyDead = []; // { name, files: [relPath] }
const testOnly = []; // { name, files: [relPath] }
const selfOnly = []; // { name, files: [relPath] }

for (const [name, { files }] of exportsByName) {
  if (SANCTIONED_SEAM_RE.test(name)) continue; // sanctioned test seam

  let liveRefs = 0; // prod/e2e/scripts/html refs outside declaration sites
  let selfRefs = 0; // refs in a declaring file beyond its own declarations
  let testRefs = 0; // unit-test refs

  for (const [relPath, counts] of tokensByFile) {
    const n = counts.get(name) ?? 0;
    if (n === 0) continue;
    const role = corpus.get(relPath).role;
    if (role === 'test') {
      testRefs += n;
    } else if (files.has(relPath)) {
      // Declaring file: tokens beyond the declaration count are real uses.
      selfRefs += Math.max(0, n - files.get(relPath));
    } else {
      liveRefs += n;
    }
  }

  const fileList = [...files.keys()].sort();
  if (liveRefs > 0) continue; // LIVE
  if (selfRefs > 0) selfOnly.push({ name, files: fileList });
  else if (testRefs > 0) testOnly.push({ name, files: fileList });
  else fullyDead.push({ name, files: fileList });
}

const byName = (a, b) => a.name.localeCompare(b.name);
fullyDead.sort(byName);
testOnly.sort(byName);
selfOnly.sort(byName);

// ── Apply the ratchets ───────────────────────────────────────────

const baselineKey = (symbol, file) => `${symbol} @ ${file}`;
const baselineSet = new Set(FULLY_DEAD_BASELINE.map((b) => baselineKey(b.symbol, b.file)));

const newDead = [];
const coveredBaselineKeys = new Set();
for (const { name, files } of fullyDead) {
  for (const file of files) {
    const key = baselineKey(name, file);
    if (baselineSet.has(key)) coveredBaselineKeys.add(key);
    else newDead.push(key);
  }
}
const staleBaseline = FULLY_DEAD_BASELINE.filter(
  (b) => !coveredBaselineKeys.has(baselineKey(b.symbol, b.file)),
);

const testOnlyGrowth = testOnly.length > TEST_ONLY_BASELINE_COUNT;

// ── Report ───────────────────────────────────────────────────────

const pad = (s) => `  ${s}`;
const prodFileCount = [...corpus.values()].filter((c) => c.role === 'prod').length;
console.log('── Dead-export check ───────────────────────────────────');
console.log(
  `${prodFileCount} prod files, ${exportsByName.size} exported names; ` +
    `fully-dead: ${fullyDead.length} (baseline ${FULLY_DEAD_BASELINE.length}), ` +
    `test-only: ${testOnly.length} (baseline ${TEST_ONLY_BASELINE_COUNT}), ` +
    `self-only: ${selfOnly.length} (info)`,
);
console.log('');

let failed = false;

if (newDead.length) {
  failed = true;
  console.log(`NEW FULLY-DEAD EXPORTS (not in baseline): ${newDead.length}`);
  for (const key of newDead.sort()) console.log(pad(key));
  console.log(pad('Fix: delete the export (preferred) — do NOT add baseline entries.'));
  console.log('');
}

if (testOnlyGrowth) {
  failed = true;
  console.log(
    `TEST-ONLY EXPORT COUNT GREW: ${testOnly.length} > baseline ${TEST_ONLY_BASELINE_COUNT}`,
  );
  console.log(
    pad('A new test-only export needs a decision: either it is a sanctioned seam'),
  );
  console.log(
    pad('(rename it to the /ForTests$/ convention) or the test should use the'),
  );
  console.log(pad('public surface. Raising the baseline requires owner review.'));
  console.log('');
}

// INFO: per-file test-only list (non-fatal).
if (testOnly.length) {
  console.log(`info: test-only exports (${testOnly.length}, non-fatal):`);
  const byFile = new Map();
  for (const { name, files } of testOnly) {
    for (const f of files) {
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(name);
    }
  }
  for (const f of [...byFile.keys()].sort()) {
    console.log(pad(`${f}: ${byFile.get(f).sort().join(', ')}`));
  }
  console.log('');
}

if (selfOnly.length) {
  console.log(
    `info: self-only exports (${selfOnly.length}) — used only inside their own file; ` +
      'the export keyword is unnecessary. Clean up opportunistically.',
  );
  console.log('');
}

// Non-fatal hygiene note (mirrors import-graph stale-allowlist reporting):
// baseline entries whose symbol is gone or no longer dead should be removed.
if (staleBaseline.length && !failed) {
  console.log('note: stale FULLY_DEAD_BASELINE entries (no longer fully-dead — delete them):');
  for (const b of staleBaseline) console.log(pad(baselineKey(b.symbol, b.file)));
  console.log('');
}
if (testOnly.length < TEST_ONLY_BASELINE_COUNT && !failed) {
  console.log(
    `note: test-only count shrank (${testOnly.length} < ${TEST_ONLY_BASELINE_COUNT}) — ` +
      'lower TEST_ONLY_BASELINE_COUNT to lock in the progress.',
  );
  console.log('');
}

if (!failed) {
  console.log('OK — no new fully-dead exports; test-only count within ratchet.');
  process.exit(0);
}

console.log('Total findings: ' + (newDead.length + (testOnlyGrowth ? 1 : 0)));
process.exit(1);
