import * as rateLimitRetry from '../../../scripts/live-smoke-rate-limit-retry.mts';

const RATE_LIMIT_RETRY_IMPORT =
  /import\s*\{([^}]*)\}\s*from\s*'\.\/live-smoke-rate-limit-retry\.mts';/;
const RATE_LIMIT_RETRY_GLOBAL = '__mxqrSmokeRateLimitRetry';

/**
 * Evaluates a transpiled live smoke as a data: module. Such a module cannot
 * resolve the smoke's relative import of the shared rate-limit retry, so it is
 * handed the copy this test process imported, which keeps that module's error
 * class the one tests assert on.
 */
export async function importTranspiledLiveSmoke(compiled: string): Promise<void> {
  if (!RATE_LIMIT_RETRY_IMPORT.test(compiled)) {
    throw new Error('live smoke fixture cannot find the rate-limit retry import');
  }
  const fixtureGlobal = globalThis as typeof globalThis & Record<string, unknown>;
  fixtureGlobal[RATE_LIMIT_RETRY_GLOBAL] = rateLimitRetry;
  try {
    const linked = compiled.replace(
      RATE_LIMIT_RETRY_IMPORT,
      `const {$1} = globalThis.${RATE_LIMIT_RETRY_GLOBAL};`,
    );
    await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(linked)}`);
  } finally {
    delete fixtureGlobal[RATE_LIMIT_RETRY_GLOBAL];
  }
}
