#!/usr/bin/env node
/**
 * check-import-graph.mjs
 *
 * Static guard for the production import graph.
 *
 * Three rules over src/ production files:
 *
 *   RULE A — app.ts is import-terminal (hard, no allowlist).
 *     The bootstrap module imports every domain and runs top-level side
 *     effects; ANY export it offers is an affordance for feature code to
 *     back-import it, collapsing the whole app graph into one SCC (that is
 *     exactly how ui/setup-shared.ts -> app.ts created a 6-file cycle
 *     containing the composition root). Both static and dynamic import()
 *     specifiers resolving to src/app.ts are banned.
 *
 *   RULE B — SCC baseline ratchet.
 *     Strongly-connected components are computed over STATIC VALUE imports
 *     only. Type-only imports (`import type` / `export type ... from`) do
 *     not create runtime cycles and are excluded. Dynamic import() is ALSO
 *     excluded here: it is this repo's sanctioned lazy cycle-break idiom
 *     (player/transport.ts -> playlist.ts etc.) — counting those edges
 *     would merge the player domain into one giant baseline SCC and weaken
 *     the ratchet. Every SCC found must be a SUBSET of a recorded baseline
 *     entry: shrinkage passes (update the baseline when it does), growth or
 *     any new cycle fails. Do NOT add baseline entries to silence a finding.
 *
 *   RULE C — ui layering (allowlist of importer -> ui-module pairs).
 *     Files outside src/ui/ may import from src/ui/ only via the entries
 *     below. For example, network/sync.ts importing wire caps from
 *     ui/chat-render.ts was acyclic, so no SCC
 *     rule can catch its reintroduction — only a layering rule can.
 *     src/app.ts is exempt as importer (the composition root imports
 *     everything by design). Allowlist is shrink-only: remove entries when
 *     the import disappears; never broaden without an explicit decision.
 *
 * Scope / deliberate limitations (honest, not magic):
 *   - Only relative specifiers ending in '.ts' are resolved. Bare modules
 *     ('peerjs') and dynamic CSS imports (i18n font loading) are skipped.
 *   - Test files (__tests__, *.test.ts, *.spec.ts, *.d.ts) are excluded.
 *   - This repo imports with explicit .ts extensions and single quotes
 *     exclusively; multi-line import statements end with `} from '...'`,
 *     which the statement regex handles.
 *
 * Exit code: 0 if clean (modulo baseline/allowlist), 1 if findings remain.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

const APP = 'src/app.ts';

// ── RULE B baseline ──────────────────────────────────────────────
// The two reviewed pre-existing cycles are frozen as a shrink-only baseline.
// Any new member or cycle fails the guard.
const SCC_BASELINE = [
  {
    reason:
      'audio/system-capture <-> player/transport: system-audio mode and file transport ' +
      'mutually arbitrate playback ownership (audit-hardened cluster; untangling is its ' +
      'own project, not a drive-by)',
    members: ['src/audio/system-capture.ts', 'src/player/transport.ts'],
  },
  {
    reason:
      'youtube domain-internal init wiring cluster (player/iframe/handlers/sync); ' +
      'single-domain, intentional until a youtube-internal refactor',
    members: [
      'src/youtube/handlers.ts',
      'src/youtube/iframe.ts',
      'src/youtube/player.ts',
      'src/youtube/sync.ts',
    ],
  },
];

// ── RULE C allowlist ─────────────────────────────────────────────
// ui modules importable from ANY non-ui production file.
const UI_OPEN_MODULES = new Map([
  ['src/ui/toast.ts', 'app-wide notification primitive (18+ importers by design)'],
  ['src/ui/dialog.ts', 'app-wide modal primitive'],
  [
    'src/ui/user-text-font.ts',
    'app-wide script-aware font boundary for user and external text renderers',
  ],
]);

// Specific (importer -> ui module) exceptions, each with a reason.
// `importer` is an exact file key; `importerPrefix` covers a directory.
const UI_LAYERING_ALLOWLIST = [
  {
    importer: 'src/player/playlist.ts',
    target: 'src/ui/large-room-warnings.ts',
    reason: 'file-share entry consults the shared large-room warning latch',
  },
  {
    importerPrefix: 'src/chat/',
    target: 'src/ui/chat-render.ts',
    reason:
      'chat-render.ts header documents direct importability of its render ' +
      'primitives by chat/protocol.ts and chat/commands.ts (decomposition design)',
  },
  {
    importer: 'src/demo/mode.ts',
    target: 'src/ui/setup-shared.ts',
    reason: 'demo mode tears down the setup overlay (hideSetupOverlay)',
  },
  {
    importer: 'src/demo/mode.ts',
    target: 'src/ui/dom.ts',
    reason: 'demo mode syncs the overlay-open body class',
  },
  {
    importer: 'src/demo/mode.ts',
    target: 'src/ui/theme-chrome.ts',
    reason: 'demo mode swaps theme-color chrome on enter/exit',
  },
];

// ── Matchers ─────────────────────────────────────────────────────
// Statement-level: `import/export ... from '...'`. The clause between the
// keyword and `from` may span lines (multi-line named imports) but can never
// contain ';' or '=' — that wall stops `export type Foo = ...` declarations
// from swallowing a later real import. Group 2 set => type-only, no edge.
const FROM_RE = /\b(import|export)\s+(type\s+)?([^;=]*?)\bfrom\s+'([^']+)'/g;
// Side-effect imports: `import './x.ts';`
const SIDE_EFFECT_RE = /\bimport\s+'([^']+)'/g;
// Dynamic imports: `import('./x.ts')`
const DYNAMIC_RE = /\bimport\(\s*'([^']+)'\s*\)/g;

// Strip comments so import examples inside doc comments are not mistaken for
// real edges. Same approach as scripts/check-bus-pairing.mjs.
function stripComments(text) {
  return text
    // Blank block comments but keep their newlines so line numbers stay accurate.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir, out = []) {
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

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

const toKey = (absPath) => relative(ROOT, absPath).split('\\').join('/');

function resolveSpec(file, spec) {
  if (!spec.startsWith('.')) return null; // bare module (peerjs, …)
  if (!spec.endsWith('.ts')) return null; // css/assets (i18n font imports)
  return toKey(resolve(dirname(file), spec));
}

// ── Build the graph ──────────────────────────────────────────────

const files = walk(SRC);
const fileKeys = files.map(toKey);
const fileSet = new Set(fileKeys);

/** key -> Array<{ target, line, kind: 'static' | 'dynamic' }> */
const edges = new Map(fileKeys.map((k) => [k, []]));

for (const file of files) {
  const key = toKey(file);
  const text = stripComments(readFileSync(file, 'utf8'));

  const add = (spec, index, kind) => {
    const target = resolveSpec(file, spec);
    if (!target || !fileSet.has(target)) return;
    edges.get(key).push({ target, line: lineOf(text, index), kind });
  };

  let m;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(text))) {
    if (m[2]) continue; // `import type` / `export type … from` — no runtime edge
    add(m[4], m.index, 'static');
  }
  SIDE_EFFECT_RE.lastIndex = 0;
  while ((m = SIDE_EFFECT_RE.exec(text))) add(m[1], m.index, 'static');
  DYNAMIC_RE.lastIndex = 0;
  while ((m = DYNAMIC_RE.exec(text))) add(m[1], m.index, 'dynamic');
}

// ── RULE A: app.ts is import-terminal ────────────────────────────

const ruleAViolations = [];
for (const [importer, list] of edges) {
  if (importer === APP) continue;
  for (const e of list) {
    if (e.target === APP) {
      ruleAViolations.push(`${importer}:${e.line} ${e.kind} import of ${APP}`);
    }
  }
}

// ── RULE B: SCC baseline ratchet (static value edges only) ───────

function computeSccs() {
  // Tarjan, iterative-friendly sizes (~170 nodes) so plain recursion is fine.
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];
  let counter = 0;

  const staticTargets = (k) =>
    edges.get(k).filter((e) => e.kind === 'static').map((e) => e.target);

  function strongConnect(v) {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of staticTargets(v)) {
      if (!index.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }

    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp.sort());
    }
  }

  for (const k of fileKeys) if (!index.has(k)) strongConnect(k);
  return sccs;
}

const sccs = computeSccs();
const ruleBViolations = [];
const baselineSets = SCC_BASELINE.map((b) => new Set(b.members));
for (const scc of sccs) {
  const covered = baselineSets.some((b) => scc.every((f) => b.has(f)));
  if (!covered) {
    ruleBViolations.push(scc);
  }
}

// ── RULE C: ui layering ──────────────────────────────────────────

const isUiModule = (k) => k.startsWith('src/ui/');

function uiImportAllowed(importer, target) {
  if (UI_OPEN_MODULES.has(target)) return true;
  return UI_LAYERING_ALLOWLIST.some(
    (a) =>
      a.target === target &&
      ((a.importer && a.importer === importer) ||
        (a.importerPrefix && importer.startsWith(a.importerPrefix))),
  );
}

const ruleCViolations = [];
const usedAllowlistEntries = new Set();
for (const [importer, list] of edges) {
  if (importer === APP) continue; // composition root imports everything by design
  if (isUiModule(importer)) continue;
  for (const e of list) {
    if (!isUiModule(e.target)) continue;
    if (uiImportAllowed(importer, e.target)) {
      const entry = UI_LAYERING_ALLOWLIST.find(
        (a) =>
          a.target === e.target &&
          ((a.importer && a.importer === importer) ||
            (a.importerPrefix && importer.startsWith(a.importerPrefix))),
      );
      if (entry) usedAllowlistEntries.add(entry);
      continue;
    }
    ruleCViolations.push(`${importer}:${e.line} ${e.kind} import of ${e.target}`);
  }
}

// ── Report ───────────────────────────────────────────────────────

const pad = (s) => `  ${s}`;
const edgeCount = [...edges.values()].reduce((n, l) => n + l.length, 0);
console.log('── Import graph check ──────────────────────────────────');
console.log(
  `${fileKeys.length} production files, ${edgeCount} resolved edges, ` +
    `${sccs.length} SCC(s) found, ${SCC_BASELINE.length} baselined`,
);
console.log('');

let findings = 0;

if (ruleAViolations.length) {
  findings += ruleAViolations.length;
  console.log(`RULE A — app.ts must be import-terminal: ${ruleAViolations.length} violation(s)`);
  for (const v of ruleAViolations) console.log(pad(v));
  console.log(
    pad('Fix: move the needed behavior into a core/ leaf module (see core/wake-lock.ts).'),
  );
  console.log('');
}

if (ruleBViolations.length) {
  findings += ruleBViolations.length;
  console.log(`RULE B — new or grown import cycle(s): ${ruleBViolations.length}`);
  for (const scc of ruleBViolations) {
    console.log(pad(`cycle of ${scc.length}:`));
    for (const f of scc) console.log(pad(pad(f)));
  }
  console.log(
    pad('Break the cycle (leaf extraction / peer-state-style primitive import);'),
  );
  console.log(pad('do NOT add baseline entries to silence this.'));
  console.log('');
}

if (ruleCViolations.length) {
  findings += ruleCViolations.length;
  console.log(`RULE C — non-ui file imports a ui module: ${ruleCViolations.length} violation(s)`);
  for (const v of ruleCViolations) console.log(pad(v));
  console.log(
    pad('Wire contracts belong in core/constants.ts; render primitives stay ui-internal.'),
  );
  console.log('');
}

// Non-fatal hygiene note: allowlist entries whose import disappeared should
// be deleted (shrink-only ratchet). Reported, not failed, so a concurrent
// refactor cannot brick CI.
const staleEntries = UI_LAYERING_ALLOWLIST.filter((a) => !usedAllowlistEntries.has(a));
if (staleEntries.length && !findings) {
  console.log('note: stale RULE C allowlist entries (import gone — delete them):');
  for (const a of staleEntries) {
    console.log(pad(`${a.importer ?? a.importerPrefix + '*'} -> ${a.target}`));
  }
  console.log('');
}

if (!findings) {
  console.log('OK — app.ts is import-terminal, no new cycles, ui layering respected.');
  process.exit(0);
}

console.log(`Total findings: ${findings}`);
process.exit(1);
