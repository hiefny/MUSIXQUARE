import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Ratchet: no NEW fully-dead exports in prod src/, and the test-only export
// count may not grow. The actual analysis lives in
// scripts/check-dead-exports.mjs (single source of truth, also runnable via
// `npm run guard:dead-exports`). We invoke it as a subprocess so this .ts
// test doesn't depend on .mjs type resolution; a non-zero exit means
// findings, and we surface the script's report.
const script = fileURLToPath(new URL('../../../scripts/check-dead-exports.mjs', import.meta.url));

describe('Dead-export ratchet', () => {
  it('has no new fully-dead exports and the test-only count is within baseline', () => {
    let output = '';
    try {
      output = execFileSync('node', [script], { encoding: 'utf8' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`Dead-export check failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
    expect(output).toContain('OK');
  });
});
