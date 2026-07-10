#!/usr/bin/env node
/**
 * check-bus-pairing.mjs
 *
 * Static guard for EventBus emit/listen pairing.
 *
 * The bus is compile-time type-safe through src/core/events.ts EventMap, so
 * event names and payloads are guaranteed valid.
 * What TypeScript cannot see is whether an emitted event has any LISTENER, or
 * whether a listener waits for an event nobody emits. This guard closes that
 * runtime mismatch gap.
 *
 * It uses existence-pairing analysis:
 *   - DEAD EMIT     : bus.emit('x') exists, but no .on('x') in production code.
 *   - ORPHAN LISTEN : .on('x') exists, but no bus.emit('x') in production code.
 *
 * Scope / deliberate limitations (honest, not magic):
 *   - Only hand-authored domain events ("domain:action", i.e. contains ':' and
 *     does NOT start with 'state:'). The auto-derived state:* events legitimately
 *     have no listener most of the time, so including them would be pure noise.
 *   - Only string-literal event names. Dynamic names (template/variable) are
 *     skipped. Domain events in this repo are always literals.
 *   - Test files (__tests__, *.test.ts, *.spec.ts) are excluded from BOTH sets,
 *     so a test-only listener cannot mask a real production dead emit.
 *   - This is EXISTENCE pairing, not timing. Whether a listener is registered
 *     before the emit fires is out of scope (and not a pairing bug).
 *
 * Known-intentional or accepted cases go in ALLOWLIST below, each with a reason.
 *
 * Exit code: 0 if clean (modulo allowlist), 1 if findings remain.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// ── Allowlist ────────────────────────────────────────────────────
// Events intentionally unpaired in production. Format: name -> reason.
const ALLOWLIST = new Map([
  // 'example:event', 'reason it is intentionally unpaired',
]);

// ── Matchers ─────────────────────────────────────────────────────
// \s* spans newlines, so multiline emit(\n 'name') is caught.
const EMIT_RE = /\bbus\.emit\(\s*['"]([^'"]+)['"]/g;
const LISTEN_RE = /\.(?:on|once)\(\s*['"]([^'"]+)['"]/g;

const isDomainEvent = (name) => name.includes(':') && !name.startsWith('state:');

// Strip comments so example event names inside doc comments (e.g. the
// "bus.emit('audo:ready')" typo example in events.ts) are not mistaken for
// real call sites. The ':' guard on line comments leaves URLs ("http://")
// intact; event names never appear in emit/on call positions inside a URL.
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

function collect(text, file, re, target) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    if (!isDomainEvent(name)) continue;
    if (!target.has(name)) target.set(name, []);
    target.get(name).push(`${relative(ROOT, file)}:${lineOf(text, m.index)}`);
  }
}

const emits = new Map();
const listens = new Map();

for (const file of walk(SRC)) {
  const text = stripComments(readFileSync(file, 'utf8'));
  collect(text, file, EMIT_RE, emits);
  collect(text, file, LISTEN_RE, listens);
}

const emitNames = new Set(emits.keys());
const listenNames = new Set(listens.keys());

const deadEmits = [...emitNames]
  .filter((n) => !listenNames.has(n) && !ALLOWLIST.has(n))
  .sort();
const orphanListeners = [...listenNames]
  .filter((n) => !emitNames.has(n) && !ALLOWLIST.has(n))
  .sort();

// ── Report ───────────────────────────────────────────────────────
const pad = (s) => `  ${s}`;
console.log('── EventBus pairing check ──────────────────────────────');
console.log(
  `domain events: ${emitNames.size} emitted, ${listenNames.size} listened` +
    (ALLOWLIST.size ? `, ${ALLOWLIST.size} allowlisted` : ''),
);
console.log('');

if (deadEmits.length) {
  console.log(`DEAD EMITS (emitted, no production listener): ${deadEmits.length}`);
  for (const n of deadEmits) {
    console.log(pad(`'${n}'`));
    for (const loc of emits.get(n)) console.log(pad(pad(`emit  ${loc}`)));
  }
  console.log('');
}

if (orphanListeners.length) {
  console.log(`ORPHAN LISTENERS (listened, no production emitter): ${orphanListeners.length}`);
  for (const n of orphanListeners) {
    console.log(pad(`'${n}'`));
    for (const loc of listens.get(n)) console.log(pad(pad(`on    ${loc}`)));
  }
  console.log('');
}

if (!deadEmits.length && !orphanListeners.length) {
  console.log('OK — every domain event is paired (or allowlisted).');
  process.exit(0);
}

console.log(`Total findings: ${deadEmits.length + orphanListeners.length}`);
process.exit(1);
