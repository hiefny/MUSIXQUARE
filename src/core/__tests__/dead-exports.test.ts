import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Production must not gain fully dead exports, and the test-only/self-only
// export counts may not grow. scripts/check-dead-exports.mts owns the analysis and is also
// exposed through `npm run guard:dead-exports`; this test invokes the real CLI
// so its report and non-zero failure exit remain part of the contract.
const script = fileURLToPath(new URL('../../../scripts/check-dead-exports.mts', import.meta.url));
// This guard builds and walks a TypeScript program for the entire repository.
// It can legitimately exceed one minute when the full Vitest suite is sharing
// CPU on Windows, so keep the larger allowance local to this analysis. The
// subprocess timeout still prevents a stalled analyzer from hanging forever.
const DEAD_EXPORT_PROCESS_TIMEOUT_MS = 110_000;
const DEAD_EXPORT_TEST_TIMEOUT_MS = 120_000;

describe('Dead-export ratchet', () => {
  it(
    'has no fully-dead exports and exact shrink-only counts at the current baselines',
    () => {
      let output: string;
      try {
        output = execFileSync('node', [script], {
          encoding: 'utf8',
          timeout: DEAD_EXPORT_PROCESS_TIMEOUT_MS,
        });
      } catch (err) {
        const e = err as { code?: string; stdout?: string; stderr?: string };
        const timeoutDetail =
          e.code === 'ETIMEDOUT' ? `Analysis exceeded ${DEAD_EXPORT_PROCESS_TIMEOUT_MS}ms.\n` : '';
        throw new Error(
          `Dead-export check failed:\n${timeoutDetail}${e.stdout ?? ''}${e.stderr ?? ''}`,
          { cause: err },
        );
      }
      const summary = output.split(/\r?\n/u).find((line) => line.includes('fully-dead:'));
      expect(summary).toBeDefined();
      expect(summary).toContain('fully-dead: 0 ');
      expect(summary).toContain('test-only: 22 ');
      // The former count of 79 was accidental: the retired UI-kit inline
      // script declared a local React setter named `setTheme`, and the HTML
      // fallback conservatively credited that text to the unrelated exported
      // settings binding. With executable inline JavaScript removed, the
      // binding is classified honestly as self-only again.
      expect(summary).toContain('baseline 22), self-only: 80 ');
      expect(summary).toMatch(/self-only: 80 .*baseline 80\)$/u);
      expect(output).toContain('OK');
    },
    DEAD_EXPORT_TEST_TIMEOUT_MS,
  );
});
