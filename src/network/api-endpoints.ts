const PRODUCTION_ORIGIN = 'https://musixquare.com';

/**
 * Keep local development convenient while making E2E builds fail closed to
 * their own origin. A broken local test server must never fall through to a
 * production Worker and pollute production traffic or test results.
 */
export function localFirstApiEndpoints(
  path: `/api/${string}`,
  mode = import.meta.env.MODE,
  baseHref = typeof window === 'undefined' ? undefined : window.location.href,
): string[] {
  const candidates = mode === 'e2e' ? [path] : [path, `${PRODUCTION_ORIGIN}${path}`];
  if (!baseHref) return candidates;

  // On musixquare.com the relative endpoint and canonical fallback resolve to
  // the same Worker route. Treating them as two retries doubled every failed
  // control request (and could turn one timeout into two). Keep the fallback
  // for local/staging origins, but issue each absolute request target once.
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    let identity = candidate;
    try {
      identity = new URL(candidate, baseHref).href;
    } catch {
      // Leave malformed candidates to the ordinary fetch/error path.
    }
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
