const PRODUCTION_ORIGIN = 'https://musixquare.com';

/**
 * Keep local development convenient while making E2E builds fail closed to
 * their own origin. A broken local test server must never fall through to a
 * production Worker and pollute production traffic or test results.
 */
export function localFirstApiEndpoints(
  path: `/api/${string}`,
  mode = import.meta.env.MODE,
): string[] {
  return mode === 'e2e' ? [path] : [path, `${PRODUCTION_ORIGIN}${path}`];
}
