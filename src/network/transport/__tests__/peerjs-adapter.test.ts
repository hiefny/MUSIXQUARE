import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { TransportDataConnection, TransportMediaConnection } from '../types.ts';

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  nativeCall: vi.fn(),
  nativeConnect: vi.fn(),
  on: vi.fn(),
}));

vi.mock('peerjs', () => ({
  Peer: class FakePeerJsPeer {
    call = mocks.nativeCall;
    connect = mocks.nativeConnect;
    on = mocks.on;

    constructor(...args: unknown[]) {
      mocks.constructor(...args);
    }
  },
}));

import { createPeerJsPeer } from '../peerjs-adapter.ts';

describe('PeerJS transport media options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates SDP transformation to PeerJS and tunes each new call sender once', async () => {
    const firstSender = { track: { kind: 'audio' } } as RTCRtpSender;
    const secondSender = { track: { kind: 'audio' } } as RTCRtpSender;
    const firstConnection = {
      peerConnection: { getSenders: () => [firstSender] },
    } as unknown as TransportMediaConnection;
    const secondConnection = {
      peerConnection: { getSenders: () => [secondSender] },
    } as unknown as TransportMediaConnection;
    mocks.nativeCall.mockReturnValueOnce(firstConnection).mockReturnValueOnce(secondConnection);
    const peer = await createPeerJsPeer('requested-peer', {
      provider: 'peerjs',
      config: { iceServers: [] },
    });
    const stream = {} as MediaStream;
    const transform = vi.fn((sdp: string) => `${sdp}|stereo`);
    const tuneSender = vi.fn();

    expect(
      peer.call?.('guest-1', stream, { sdpTransform: transform, senderTuning: tuneSender }),
    ).toBe(firstConnection);
    expect(
      peer.call?.('guest-2', stream, { sdpTransform: transform, senderTuning: tuneSender }),
    ).toBe(secondConnection);

    expect(mocks.nativeCall).toHaveBeenNthCalledWith(1, 'guest-1', stream, {
      sdpTransform: transform,
    });
    expect(mocks.nativeCall).toHaveBeenNthCalledWith(2, 'guest-2', stream, {
      sdpTransform: transform,
    });
    expect(transform).not.toHaveBeenCalled();
    expect(tuneSender.mock.calls).toEqual([[firstSender], [secondSender]]);
  });
});

class FakePeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = 'connected';
  iceConnectionState: RTCIceConnectionState = 'disconnected';

  transition(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

class FakeDataConnection extends EventEmitter {
  peer = 'same-peer';
  open = true;
  peerConnection = new FakePeerConnection();
  close = vi.fn(() => {
    this.open = false;
    this.emit('close');
  });
}

describe('PeerJS terminal data transport state', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(['outgoing', 'incoming'] as const)(
    'closes an established %s connection when aggregate state fails before ICE',
    async (direction) => {
      const conn = new FakeDataConnection();
      mocks.nativeConnect.mockReturnValue(conn);
      const peer = await createPeerJsPeer(null, { provider: 'peerjs', config: {} });
      if (direction === 'outgoing') {
        expect(peer.connect('same-peer', { reliable: true })).toBe(conn);
        expect(mocks.nativeConnect).toHaveBeenCalledWith('same-peer', { reliable: true });
      } else {
        const listener = mocks.on.mock.calls.find(([event]) => event === 'connection')?.[1] as
          ((connection: TransportDataConnection) => void) | undefined;
        expect(listener).toBeDefined();
        listener?.(conn as unknown as TransportDataConnection);
      }
      const closed = vi.fn();
      conn.on('close', closed);
      conn.peerConnection.transition('failed');
      expect(conn.peerConnection.iceConnectionState).toBe('disconnected');
      expect(conn.close).toHaveBeenCalledTimes(1);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(conn.open).toBe(false);
      conn.peerConnection.transition('closed');
      expect(conn.close).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves transient disconnection and closes only on terminal state', async () => {
    const conn = new FakeDataConnection();
    mocks.nativeConnect.mockReturnValue(conn);
    const peer = await createPeerJsPeer(null, { provider: 'peerjs', config: {} });
    peer.connect('same-peer');
    conn.peerConnection.transition('disconnected');
    conn.peerConnection.transition('connecting');
    conn.peerConnection.transition('connected');
    expect(conn.close).not.toHaveBeenCalled();
    conn.peerConnection.transition('closed');
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  it('defers an already terminal state until callers can observe the close', async () => {
    const conn = new FakeDataConnection();
    conn.peerConnection.connectionState = 'failed';
    mocks.nativeConnect.mockReturnValue(conn);
    const peer = await createPeerJsPeer(null, { provider: 'peerjs', config: {} });
    peer.connect('same-peer');
    const closed = vi.fn();
    conn.on('close', closed);
    expect(closed).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  it('releases the old exact connection listener without closing a replacement', async () => {
    const old = new FakeDataConnection();
    const replacement = new FakeDataConnection();
    mocks.nativeConnect.mockReturnValueOnce(old).mockReturnValueOnce(replacement);
    const removeListener = vi.spyOn(old.peerConnection, 'removeEventListener');
    const peer = await createPeerJsPeer(null, { provider: 'peerjs', config: {} });
    peer.connect('same-peer');
    peer.connect('same-peer');
    old.close();
    expect(removeListener).toHaveBeenCalledWith('connectionstatechange', expect.any(Function));
    expect(old.listenerCount('close')).toBe(0);
    old.peerConnection.transition('failed');
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(replacement.close).not.toHaveBeenCalled();
    replacement.peerConnection.transition('failed');
    expect(replacement.close).toHaveBeenCalledTimes(1);
  });
});
