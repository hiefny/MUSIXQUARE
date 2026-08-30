import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransportMediaConnection } from '../types.ts';

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  nativeCall: vi.fn(),
}));

vi.mock('peerjs', () => ({
  Peer: class FakePeerJsPeer {
    call = mocks.nativeCall;

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
