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

export function getRuntimeTransportConfig(): {
  provider: TransportProvider;
  signalingUrl?: string;
  peerJsServer?: PeerJsServerConfig;
} {
  const runtime = (window as RuntimeWindow).__MUSIXQUARE_TRANSPORT__;
  const envProvider = readEnv('VITE_MUSIXQUARE_TRANSPORT');
  const providerSetting = normalizeProvider(runtime?.provider ?? envProvider);
  const signalingUrl =
    readString(runtime?.signalingUrl) ?? readEnv('VITE_MUSIXQUARE_SIGNALING_URL');

  const provider =
    providerSetting === 'auto' ? (signalingUrl ? 'cloudflare' : 'peerjs') : providerSetting;

  return {
    provider,
    signalingUrl,
    peerJsServer: runtime?.peerServer ?? (window as RuntimeWindow).__MUSIXQUARE_PEER_SERVER__,
  };
}
