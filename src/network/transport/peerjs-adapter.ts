import type {
  TransportCallOptions,
  TransportMediaConnection,
  TransportPeer,
  TransportPeerOptions,
} from './types.ts';

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
  const peerjs = await import('peerjs');
  const Peer = peerjs.Peer as PeerJsModule['Peer'];
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

  const peer = requestedId ? new Peer(requestedId, peerOptions) : new Peer(peerOptions);
  const nativeCall = peer.call?.bind(peer);
  if (nativeCall) {
    peer.call = (
      peerId: string,
      stream: MediaStream,
      options?: TransportCallOptions,
    ): TransportMediaConnection => {
      // PeerJS natively owns the one-shot offer transform. Sender tuning is a
      // MUSIXQUARE transport extension, so keep it out of PeerJS's retained
      // connection options and apply it once after PeerJS synchronously adds
      // the stream's tracks to its fresh media RTCPeerConnection.
      const { senderTuning, ...nativeOptions } = options ?? {};
      const mediaConnection = nativeCall(peerId, stream, nativeOptions);
      if (senderTuning) {
        for (const sender of mediaConnection.peerConnection?.getSenders() ?? []) {
          try {
            senderTuning(sender);
          } catch {
            // Tuning is advisory; it cannot invalidate an otherwise healthy call.
          }
        }
      }
      return mediaConnection;
    };
  }
  return peer;
}
