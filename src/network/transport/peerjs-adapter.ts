import type {
  TransportCallOptions,
  TransportDataConnection,
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

function observeTerminalDataState(conn: TransportDataConnection): void {
  const pc = conn.peerConnection;
  if (!pc) return;
  let observing = true;
  const cleanup = (): void => {
    observing = false;
    pc.removeEventListener('connectionstatechange', onStateChange);
    conn.off?.('close', cleanup);
  };
  const onStateChange = (): void => {
    if (!observing || (pc.connectionState !== 'failed' && pc.connectionState !== 'closed')) {
      return;
    }
    // PeerJS observes ICE state only. DTLS can already be terminal while ICE
    // remains disconnected and the data channel still reports open. Let the
    // ordinary connection close path release the session in that case too.
    cleanup();
    conn.close();
  };
  pc.addEventListener('connectionstatechange', onStateChange);
  conn.on('close', cleanup);
  // Keep callers able to install their normal connection handlers first.
  queueMicrotask(onStateChange);
}

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
  const nativeConnect = peer.connect.bind(peer);
  peer.connect = (peerId, connectOptions) => {
    const conn = nativeConnect(peerId, connectOptions);
    // PeerJS can return undefined when called after signaling disconnect,
    // despite the transport's established-connection return type.
    if (conn) observeTerminalDataState(conn);
    return conn;
  };
  peer.on('connection', observeTerminalDataState);
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
