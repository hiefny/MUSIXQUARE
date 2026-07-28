import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Production must not gain fully dead exports, and the test-only export count
// may not grow. scripts/check-dead-exports.mjs owns the analysis and is also
// exposed through `npm run guard:dead-exports`; this test invokes it as a
// subprocess to avoid coupling TypeScript test resolution to the .mjs module.
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
  }, 60_000);
});
