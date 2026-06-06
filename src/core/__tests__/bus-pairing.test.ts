import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Ratchet: keep every hand-authored domain bus event paired (emit <-> listen).
// The actual analysis lives in scripts/check-bus-pairing.mjs (single source of
// truth, also runnable via `npm run guard:bus-pairing`). We invoke it as a
// subprocess so this .ts test doesn't depend on .mjs type resolution; a
// non-zero exit means findings, and we surface the script's report.
const script = fileURLToPath(new URL('../../../scripts/check-bus-pairing.mjs', import.meta.url));

describe('EventBus emit/listen pairing', () => {
  it('has no dead emits or orphan listeners', () => {
    let output = '';
    try {
      output = execFileSync('node', [script], { encoding: 'utf8' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`Bus pairing check failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
    expect(output).toContain('OK');
  });
});
