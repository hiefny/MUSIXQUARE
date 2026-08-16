#!/usr/bin/env node
/**
 * check-import-graph.mts
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
 *     the ratchet. The former two-cycle baseline has been removed. Every SCC
 *     now fails; do not reintroduce a baseline entry to silence a finding.
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
// All reviewed production cycles have been removed. Keep this empty: a future
// cycle is a regression and must be broken rather than recorded here.
interface SccBaseline {
  readonly members: readonly string[];
}

const SCC_BASELINE: readonly SccBaseline[] = [];

// ── RULE C allowlist ─────────────────────────────────────────────
// ui modules importable from ANY non-ui production file.
const UI_OPEN_MODULES = new Map<string, string>([
  ['src/ui/toast.ts', 'app-wide notification primitive (18+ importers by design)'],
  ['src/ui/dialog.ts', 'app-wide modal primitive'],
  [
    'src/ui/user-text-font.ts',
    'app-wide script-aware font boundary for user and external text renderers',
  ],
]);

// Specific (importer -> ui module) exceptions, each with a reason.
// `importer` is an exact file key; `importerPrefix` covers a directory.
interface UiLayeringAllowance {
  readonly importer?: string;
  readonly importerPrefix?: string;
  readonly target: string;
  readonly reason: string;
}

const UI_LAYERING_ALLOWLIST: readonly UiLayeringAllowance[] = [
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
// real edges. Same approach as scripts/check-bus-pairing.mts.
function stripComments(text: string): string {
  return (
    text
      // Blank block comments but keep their newlines so line numbers stay accurate.
      .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  );
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

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

const toKey = (absolutePath: string): string => relative(ROOT, absolutePath).split('\\').join('/');

function resolveSpec(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // bare module (peerjs, …)
  if (!specifier.endsWith('.ts')) return null; // css/assets (i18n font imports)
  return toKey(resolve(dirname(file), specifier));
}

// ── Build the graph ──────────────────────────────────────────────

const files = walk(SRC);
const fileKeys = files.map(toKey);
const fileSet = new Set(fileKeys);

type EdgeKind = 'static' | 'dynamic';

interface ImportEdge {
  readonly target: string;
  readonly line: number;
  readonly kind: EdgeKind;
}

/** key -> resolved production import edges */
const edges = new Map<string, ImportEdge[]>(
  fileKeys.map((key): [string, ImportEdge[]] => [key, []]),
);

for (const file of files) {
  const key = toKey(file);
  const text = stripComments(readFileSync(file, 'utf8'));

  const outgoing = edges.get(key);
  if (!outgoing) throw new Error(`Missing import-graph node for ${key}`);

  const add = (specifier: string, index: number, kind: EdgeKind): void => {
    const target = resolveSpec(file, specifier);
    if (!target || !fileSet.has(target)) return;
    outgoing.push({ target, line: lineOf(text, index), kind });
  };

  let match: RegExpExecArray | null;
  FROM_RE.lastIndex = 0;
  while ((match = FROM_RE.exec(text))) {
    if (match[2]) continue; // `import type` / `export type … from` — no runtime edge
    const specifier = match[4];
    if (specifier) add(specifier, match.index, 'static');
  }
  SIDE_EFFECT_RE.lastIndex = 0;
  while ((match = SIDE_EFFECT_RE.exec(text))) {
    const specifier = match[1];
    if (specifier) add(specifier, match.index, 'static');
  }
  DYNAMIC_RE.lastIndex = 0;
  while ((match = DYNAMIC_RE.exec(text))) {
    const specifier = match[1];
    if (specifier) add(specifier, match.index, 'dynamic');
  }
}

// ── RULE A: app.ts is import-terminal ────────────────────────────

const ruleAViolations: string[] = [];
for (const [importer, list] of edges) {
  if (importer === APP) continue;
  for (const e of list) {
    if (e.target === APP) {
      ruleAViolations.push(`${importer}:${e.line} ${e.kind} import of ${APP}`);
    }
  }
}

// ── RULE B: SCC baseline ratchet (static value edges only) ───────

function mapNumber(map: ReadonlyMap<string, number>, key: string): number {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing Tarjan state for ${key}`);
  return value;
}

function computeSccs(): string[][] {
  // Tarjan, a few hundred nodes at this repository's scale, so plain recursion is fine.
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  const staticTargets = (key: string): string[] =>
    (edges.get(key) ?? []).filter((edge) => edge.kind === 'static').map((edge) => edge.target);

  function strongConnect(vertex: string): void {
    index.set(vertex, counter);
    low.set(vertex, counter);
    counter++;
    stack.push(vertex);
    onStack.add(vertex);

    for (const target of staticTargets(vertex)) {
      if (!index.has(target)) {
        strongConnect(target);
        low.set(vertex, Math.min(mapNumber(low, vertex), mapNumber(low, target)));
      } else if (onStack.has(target)) {
        low.set(vertex, Math.min(mapNumber(low, vertex), mapNumber(index, target)));
      }
    }

    if (mapNumber(low, vertex) === mapNumber(index, vertex)) {
      const component: string[] = [];
      let member: string;
      do {
        const popped = stack.pop();
        if (popped === undefined) throw new Error('Tarjan stack underflow');
        member = popped;
        onStack.delete(member);
        component.push(member);
      } while (member !== vertex);
      if (component.length > 1) sccs.push(component.sort());
    }
  }

  for (const k of fileKeys) if (!index.has(k)) strongConnect(k);
  return sccs;
}

const sccs = computeSccs();
const ruleBViolations: string[][] = [];
const baselineSets = SCC_BASELINE.map(({ members }) => new Set(members));
for (const scc of sccs) {
  const covered = baselineSets.some((b) => scc.every((f) => b.has(f)));
  if (!covered) {
    ruleBViolations.push(scc);
  }
}

// ── RULE C: ui layering ──────────────────────────────────────────

const isUiModule = (key: string): boolean => key.startsWith('src/ui/');

function uiImportAllowed(importer: string, target: string): boolean {
  if (UI_OPEN_MODULES.has(target)) return true;
  return UI_LAYERING_ALLOWLIST.some(
    (a) =>
      a.target === target &&
      ((a.importer && a.importer === importer) ||
        (a.importerPrefix && importer.startsWith(a.importerPrefix))),
  );
}

const ruleCViolations: string[] = [];
const usedAllowlistEntries = new Set<UiLayeringAllowance>();
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

const pad = (value: string): string => `  ${value}`;
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
  console.log(pad('Break the cycle (leaf extraction / peer-state-style primitive import);'));
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
    const importer = a.importer ?? (a.importerPrefix ? `${a.importerPrefix}*` : '(unknown)');
    console.log(pad(`${importer} -> ${a.target}`));
  }
  console.log('');
}

if (!findings) {
  console.log('OK — app.ts is import-terminal, no new cycles, ui layering respected.');
  process.exit(0);
}

console.log(`Total findings: ${findings}`);
process.exit(1);
