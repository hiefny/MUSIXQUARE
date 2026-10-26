import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Ratchet: keep the production import graph clean — app.ts import-terminal
// (RULE A), no static runtime import cycles
// (RULE B), ui-layering respected so wire-protocol code can never import
// from a render module again (RULE C), and no import across a listed boundary
// such as the PRO room into the Standard system-audio receive adapters
// (RULE D). The actual
// analysis lives in scripts/check-import-graph.mts (single source of truth,
// also runnable via `node scripts/check-import-graph.mts`). We invoke it as
// a subprocess so the CLI's stdout and exit code are tested together; a
// non-zero exit means findings, and we surface the script's report.
const script = fileURLToPath(new URL('../../../scripts/check-import-graph.mts', import.meta.url));
const youtubeIframe = fileURLToPath(new URL('../../youtube/iframe.ts', import.meta.url));

describe('Production import graph', () => {
  it('has no bootstrap back-imports, new cycles, ui-layering violations or crossed boundaries', () => {
    let output: string;
    try {
      output = execFileSync('node', [script], { encoding: 'utf8' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`Import graph check failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`, {
        cause: err,
      });
    }
    expect(output).toContain('OK');
  });

  it('keeps the YouTube iframe runtime independent from the player coordinator', () => {
    const source = readFileSync(youtubeIframe, 'utf8');
    expect(source).not.toMatch(/\bfrom\s+['"]\.\/player\.ts['"]/);
  });
});
