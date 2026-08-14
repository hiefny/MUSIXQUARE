import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Every hand-authored domain bus event must remain paired (emit <-> listen).
// scripts/check-bus-pairing.mjs owns the analysis and is also exposed through
// `npm run guard:bus-pairing`; this test invokes it as a subprocess to avoid
// coupling TypeScript test resolution to the .mjs module.
const script = fileURLToPath(new URL('../../../scripts/check-bus-pairing.mjs', import.meta.url));

describe('EventBus emit/listen pairing', () => {
  it('has no dead emits or orphan listeners', () => {
    let output: string;
    try {
      output = execFileSync('node', [script], { encoding: 'utf8' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      throw new Error(`Bus pairing check failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`, {
        cause: err,
      });
    }
    expect(output).toContain('OK');
  });
});
