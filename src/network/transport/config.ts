import type { PeerJsServerConfig, TransportProvider } from './types.ts';

type RuntimeTransportConfig = {
  provider?: TransportProvider | 'auto';
  signalingUrl?: string;
  peerServer?: PeerJsServerConfig;
};

type RuntimeWindow = Window & {
  __MUSIXQUARE_TRANSPORT__?: RuntimeTransportConfig;
  __MUSIXQUARE_PEER_SERVER__?: PeerJsServerConfig;
};

const PUBLIC_SIGNALING_URL = 'wss://signal.musixquare.com/api/rooms';

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

export function resolveTransportProviderForHost(
  value: unknown,
  signalingUrl?: string,
  hostname = location.hostname,
): TransportProvider {
  if (getPublicSignalingUrlForHost(hostname)) return 'cloudflare';

  const providerSetting = normalizeProvider(value);
  return providerSetting === 'auto' ? (signalingUrl ? 'cloudflare' : 'peerjs') : providerSetting;
}

export function getRuntimeTransportConfig(): {
  provider: TransportProvider;
  signalingUrl?: string;
  peerJsServer?: PeerJsServerConfig;
} {
  const runtime = (window as RuntimeWindow).__MUSIXQUARE_TRANSPORT__;
  const envProvider = readEnv('VITE_MUSIXQUARE_TRANSPORT');
  const signalingUrl =
    readString(runtime?.signalingUrl) ??
    readEnv('VITE_MUSIXQUARE_SIGNALING_URL') ??
    getPublicSignalingUrlForHost();

  const provider = resolveTransportProviderForHost(runtime?.provider ?? envProvider, signalingUrl);

  return {
    provider,
    signalingUrl,
    peerJsServer: runtime?.peerServer ?? (window as RuntimeWindow).__MUSIXQUARE_PEER_SERVER__,
  };
}
