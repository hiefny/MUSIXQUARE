import * as appBuild from '../../../scripts/live-smoke-app-build.mts';
import * as rateLimitRetry from '../../../scripts/live-smoke-rate-limit-retry.mts';

/**
 * The shared smoke modules a transpiled smoke may import. A data: module
 * cannot resolve the smoke's relative imports, so each is handed the copy this
 * test process imported, which keeps those modules' error classes the ones
 * tests assert on.
 */
const LINKED_MODULES = [
  {
    pattern: /import\s*\{([^}]*)\}\s*from\s*'\.\/live-smoke-rate-limit-retry\.mts';/,
    global: '__mxqrSmokeRateLimitRetry',
    module: rateLimitRetry,
    required: true,
  },
  {
    pattern: /import\s*\{([^}]*)\}\s*from\s*'\.\/live-smoke-app-build\.mts';/,
    global: '__mxqrSmokeAppBuild',
    module: appBuild,
    required: false,
  },
] as const;

/** Evaluates a transpiled live smoke as a data: module with its shared imports linked. */
export async function importTranspiledLiveSmoke(compiled: string): Promise<void> {
  const fixtureGlobal = globalThis as typeof globalThis & Record<string, unknown>;
  let linked = compiled;
  for (const entry of LINKED_MODULES) {
    if (!entry.pattern.test(linked)) {
      if (entry.required) {
        throw new Error('live smoke fixture cannot find the rate-limit retry import');
      }
      continue;
    }
    fixtureGlobal[entry.global] = entry.module;
    linked = linked.replace(entry.pattern, `const {$1} = globalThis.${entry.global};`);
  }
  try {
    await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(linked)}`);
  } finally {
    for (const entry of LINKED_MODULES) delete fixtureGlobal[entry.global];
  }
}
