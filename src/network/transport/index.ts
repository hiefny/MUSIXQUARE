import { createCloudflarePeer } from './cloudflare-signaling.ts';
import { createPeerJsPeer } from './peerjs-adapter.ts';
import type { TransportPeer, TransportPeerOptions } from './types.ts';

export async function createTransportPeer(
  requestedId: string | null,
  options: TransportPeerOptions,
): Promise<TransportPeer> {
  if (options.provider === 'cloudflare') {
    return createCloudflarePeer(requestedId, options);
  }
  return createPeerJsPeer(requestedId, options);
}

export type {
  PeerJsServerConfig,
  TransportDataConnection,
  TransportMediaConnection,
  TransportPeer,
  TransportPeerOptions,
  TransportProvider,
} from './types.ts';
