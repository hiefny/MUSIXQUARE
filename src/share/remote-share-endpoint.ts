const PRODUCTION_ENDPOINT = 'https://share.musixquare.com';

function normalizeEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      return null;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function isProductionAppHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'musixquare.com' || normalized.endsWith('.musixquare.com');
}

function isTrustedLocalDevelopmentHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

export function resolveRemoteShareEndpointPolicy(options: {
  hostname: string;
  injected?: unknown;
  stored?: unknown;
  allowRuntimeOverrides: boolean;
}): string | null {
  if (isProductionAppHost(options.hostname)) return PRODUCTION_ENDPOINT;
  if (!options.allowRuntimeOverrides && !isTrustedLocalDevelopmentHost(options.hostname)) {
    return null;
  }
  return normalizeEndpoint(options.injected) ?? normalizeEndpoint(options.stored);
}
