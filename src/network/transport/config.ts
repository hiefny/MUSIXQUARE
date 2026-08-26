import type { PeerJsServerConfig, TransportProvider } from './types.ts';

type RuntimeTransportConfig = {
  provider?: TransportProvider | 'auto';
  signalingUrl?: string;
  signalingFallbackUrl?: string;
  peerServer?: PeerJsServerConfig;
};

type RuntimeWindow = Window & {
  __MUSIXQUARE_TRANSPORT__?: RuntimeTransportConfig;
  __MUSIXQUARE_PEER_SERVER__?: PeerJsServerConfig;
};

const PUBLIC_SIGNALING_URL = 'wss://signal.musixquare.com/api/rooms';
const PUBLIC_SIGNALING_FALLBACK_URL = 'wss://signal-alt.musixquare.com/api/rooms';

export function isLocalTransportHost(hostname = location.hostname): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

export function getPublicSignalingUrlForHost(hostname = location.hostname): string | undefined {
  return isLocalTransportHost(hostname) ? undefined : PUBLIC_SIGNALING_URL;
}

function getPublicSignalingFallbackUrlForHost(hostname = location.hostname): string | undefined {
  return isLocalTransportHost(hostname) ? undefined : PUBLIC_SIGNALING_FALLBACK_URL;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeProvider(value: unknown): TransportProvider | 'auto' {
  if (value === 'cloudflare' || value === 'peerjs' || value === 'auto') return value;
  return 'auto';
}

function readEnv(key: string): string | undefined {
  const env = import.meta.env as Record<string, unknown> | undefined;
  return readString(env?.[key]);
}

function parseSignalingBaseUrl(value: unknown): URL | null {
  const source = readString(value);
  if (!source) return null;
  try {
    const url = new URL(source);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    if (
      (url.protocol !== 'wss:' && url.protocol !== 'ws:') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url;
  } catch {
    return null;
  }
}

/**
 * Accept only a genuinely separate WebSocket origin with the same route base.
 * A path-only alias would keep the same browser connection pool and therefore
 * cannot serve as the iOS route-handoff escape hatch.
 */
export function normalizeSignalingFallbackUrl(
  primaryValue: unknown,
  fallbackValue: unknown,
): string | undefined {
  const primary = parseSignalingBaseUrl(primaryValue);
  const fallback = parseSignalingBaseUrl(fallbackValue);
  if (
    !primary ||
    !fallback ||
    fallback.protocol !== primary.protocol ||
    fallback.origin === primary.origin ||
    fallback.pathname !== primary.pathname
  ) {
    return undefined;
  }
  return fallback.toString();
}

function resolveSignalingFallbackUrlForHost(
  primaryValue: unknown,
  configuredFallbackValue: unknown,
  hostname = location.hostname,
): string | undefined {
  const publicPrimary = parseSignalingBaseUrl(getPublicSignalingUrlForHost(hostname));
  const defaultFallback =
    parseSignalingBaseUrl(primaryValue)?.toString() === publicPrimary?.toString()
      ? getPublicSignalingFallbackUrlForHost(hostname)
      : undefined;
  return normalizeSignalingFallbackUrl(primaryValue, configuredFallbackValue ?? defaultFallback);
}

export function resolveTransportProviderForHost(
  value: unknown,
  signalingUrl?: string,
  hostname = location.hostname,
): TransportProvider {
  if (getPublicSignalingUrlForHost(hostname)) return 'cloudflare';

  const providerSetting = normalizeProvider(value);
  return providerSetting === 'auto' ? (signalingUrl ? 'cloudflare' : 'peerjs') : providerSetting;
}

export function getRuntimeTransportConfig(hostname = location.hostname): {
  provider: TransportProvider;
  signalingUrl?: string;
  signalingFallbackUrl?: string;
  peerJsServer?: PeerJsServerConfig;
} {
  const runtime = (window as RuntimeWindow).__MUSIXQUARE_TRANSPORT__;
  const envProvider = readEnv('VITE_MUSIXQUARE_TRANSPORT');
  const signalingUrl =
    readString(runtime?.signalingUrl) ??
    readEnv('VITE_MUSIXQUARE_SIGNALING_URL') ??
    getPublicSignalingUrlForHost(hostname);

  const configuredSignalingFallbackUrl =
    readString(runtime?.signalingFallbackUrl) ?? readEnv('VITE_MUSIXQUARE_SIGNALING_FALLBACK_URL');
  const signalingFallbackUrl = resolveSignalingFallbackUrlForHost(
    signalingUrl,
    configuredSignalingFallbackUrl,
    hostname,
  );

  const provider = resolveTransportProviderForHost(
    runtime?.provider ?? envProvider,
    signalingUrl,
    hostname,
  );

  return {
    provider,
    signalingUrl,
    signalingFallbackUrl,
    peerJsServer: runtime?.peerServer ?? (window as RuntimeWindow).__MUSIXQUARE_PEER_SERVER__,
  };
}
