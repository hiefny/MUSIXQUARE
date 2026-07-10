import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Ratchet: keep the production import graph clean — app.ts import-terminal
// (RULE A), no new/grown import cycles beyond the frozen 2-SCC baseline
// (RULE B), and ui-layering respected so wire-protocol code can never import
// from a render module again (RULE C, the ARCH-WIRECAPS class). The actual
// analysis lives in scripts/check-import-graph.mjs (single source of truth,
// also runnable via `node scripts/check-import-graph.mjs`). We invoke it as
// a subprocess so this .ts test doesn't depend on .mjs type resolution; a
// non-zero exit means findings, and we surface the script's report.
const script = fileURLToPath(new URL('../../../scripts/check-import-graph.mjs', import.meta.url));

describe('Production import graph', () => {
  it('has no bootstrap back-imports, new cycles, or ui-layering violations', () => {
    let output = '';
    try {
      output = execFileSync('node', [script], { encoding: 'utf8' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`Import graph check failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
    expect(output).toContain('OK');
  });
});
