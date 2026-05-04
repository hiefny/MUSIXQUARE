import type { TransportPeer, TransportPeerOptions } from './types.ts';

type PeerJsOptions = {
  debug?: number;
  config?: RTCConfiguration;
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
  key?: string;
};

type PeerJsModule = {
  Peer: new (idOrOptions?: string | PeerJsOptions, options?: PeerJsOptions) => TransportPeer;
};

export async function createPeerJsPeer(
  requestedId: string | null,
  options: TransportPeerOptions,
): Promise<TransportPeer> {
  const { Peer } = (await import('peerjs')) as unknown as PeerJsModule;
  const peerOptions: PeerJsOptions = {
    debug: options.debug,
    config: options.config,
  };
  const customServer = options.peerJsServer;
  if (customServer) {
    if (customServer.host) peerOptions.host = customServer.host;
    if (customServer.port) peerOptions.port = customServer.port;
    if (customServer.path) peerOptions.path = customServer.path;
    if (typeof customServer.secure === 'boolean') peerOptions.secure = customServer.secure;
    if (customServer.key) peerOptions.key = customServer.key;
  }

  return requestedId ? new Peer(requestedId, peerOptions) : new Peer(peerOptions);
}
