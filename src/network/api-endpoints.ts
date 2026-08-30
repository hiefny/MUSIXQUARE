const PRODUCTION_ORIGIN = 'https://musixquare.com';

function readLocalProductionApiFallbackOverride(): unknown {
  return import.meta.env?.VITE_MUSIXQUARE_ALLOW_LOCAL_PRODUCTION_API_FALLBACK;
}

/** Accept one explicit public build input; truthy aliases must stay disabled. */
export function localProductionApiFallbackEnabled(
  value: unknown = readLocalProductionApiFallbackOverride(),
): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/** Identify hostnames whose network traffic must remain local by default. */
export function isLoopbackHostname(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const hostname = value.trim().toLowerCase().replace(/\.$/u, '');
  const unbracketedHostname =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (
    unbracketedHostname === 'localhost' ||
    unbracketedHostname.endsWith('.localhost') ||
    unbracketedHostname === '::1'
  ) {
    return true;
  }
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/u.test(unbracketedHostname)) return true;

  const ipv4Hostname = unbracketedHostname.startsWith('::ffff:')
    ? unbracketedHostname.slice('::ffff:'.length)
    : unbracketedHostname;
  const octets = ipv4Hostname.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

/** Identify browser origins whose network traffic must remain local by default. */
export function isLoopbackBrowserHref(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Keep local development convenient while making E2E builds fail closed to
 * their own origin. A broken local test server must never fall through to a
 * production Worker and pollute production traffic or test results.
 */
export function localFirstApiEndpoints(
  path: `/api/${string}`,
  mode = import.meta.env.MODE,
  baseHref = typeof window === 'undefined' ? undefined : window.location.href,
  localProductionFallback: unknown = readLocalProductionApiFallbackOverride(),
): string[] {
  const keepLocal =
    mode === 'e2e' ||
    (isLoopbackBrowserHref(baseHref) &&
      !localProductionApiFallbackEnabled(localProductionFallback));
  const candidates = keepLocal ? [path] : [path, `${PRODUCTION_ORIGIN}${path}`];
  if (!baseHref) return candidates;

  // On musixquare.com the relative endpoint and canonical fallback resolve to
  // the same Worker route. Treating them as two retries doubled every failed
  // control request (and could turn one timeout into two). Keep the fallback
  // for public staging origins, but issue each absolute request target once.
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
