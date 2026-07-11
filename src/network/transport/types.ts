export type TransportProvider = 'peerjs' | 'cloudflare';

export interface TransportConnectOptions {
  reliable?: boolean;
  metadata?: unknown;
  roomPassword?: string;
}

interface TransportCallOptions {
  metadata?: Record<string, unknown>;
}

export interface TransportDataConnection {
  peer: string;
  open: boolean;
  metadata?: unknown;
  peerConnection?: RTCPeerConnection;
  dataChannel?: RTCDataChannel;
  controlChannel?: RTCDataChannel;

  send(data: unknown): void;
  close(): void;
  on(event: 'open', callback: () => void): void;
  on(event: 'data', callback: (data: unknown) => void): void;
  on(event: 'close', callback: () => void): void;
  on(event: 'error', callback: (error: unknown) => void): void;
  off?(event: 'open', callback: () => void): void;
  off?(event: 'data', callback: (data: unknown) => void): void;
  off?(event: 'close', callback: () => void): void;
  off?(event: 'error', callback: (error: unknown) => void): void;
}

export interface TransportMediaConnection {
  peer?: string;
  metadata?: Record<string, unknown>;
  peerConnection?: RTCPeerConnection;

  answer(stream?: MediaStream): void;
  close(): void;
  on(event: 'stream', callback: (stream: MediaStream) => void): void;
  on(event: 'close', callback: () => void): void;
  on(event: 'error', callback: (error: unknown) => void): void;
  off?(event: 'stream', callback: (stream: MediaStream) => void): void;
  off?(event: 'close', callback: () => void): void;
  off?(event: 'error', callback: (error: unknown) => void): void;
}

export interface TransportPeer {
  id?: string;
  open: boolean;
  destroyed: boolean;
  disconnected: boolean;

  connect(peerId: string, options?: TransportConnectOptions): TransportDataConnection;
  call?(
    peerId: string,
    stream: MediaStream,
    options?: TransportCallOptions,
  ): TransportMediaConnection;
  reconnect?(): void;
  setRoomPassword?(password: string | null): void;
  destroy(): void;
  on(event: 'open', callback: (id: string) => void): void;
  on(event: 'error', callback: (error: unknown) => void): void;
  on(event: 'disconnected', callback: () => void): void;
  on(event: 'connection', callback: (conn: TransportDataConnection) => void): void;
  on(event: 'call', callback: (mediaConn: TransportMediaConnection) => void): void;
  off(event: 'open', callback: (id: string) => void): void;
  off(event: 'error', callback: (error: unknown) => void): void;
  off(event: 'disconnected', callback: () => void): void;
  off(event: 'connection', callback: (conn: TransportDataConnection) => void): void;
  off(event: 'call', callback: (mediaConn: TransportMediaConnection) => void): void;
}

export interface PeerJsServerConfig {
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
  key?: string;
}

export interface TransportPeerOptions {
  debug?: number;
  config: RTCConfiguration;
  provider: TransportProvider;
  signalingUrl?: string;
  peerJsServer?: PeerJsServerConfig;
}
