/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { MSG } from '../../core/constants.ts';
import type { ConnectedPeer, DataConnection, MediaConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  getPeer: vi.fn<() => { call: ReturnType<typeof vi.fn> } | null>(() => null),
  getCapturedAudioStream: vi.fn<() => MediaStream | null>(() => null),
  safeSend: vi.fn(),
  isSystemAudioActive: vi.fn(() => true),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../core/timers.ts', () => ({ setManagedTimer: vi.fn(), clearManagedTimer: vi.fn() }));

vi.mock('../peer-state.ts', () => ({
  getPeer: mocks.getPeer,
  safeSend: mocks.safeSend,
}));

vi.mock('../../audio/system-capture.ts', () => ({
  isSystemAudioActive: mocks.isSystemAudioActive,
  getCapturedAudioStream: mocks.getCapturedAudioStream,
}));

vi.mock('../peer.ts', () => ({ forceStereoSdp: (sdp: string) => sdp }));

import { registerSystemAudioHostListeners } from '../system-audio-host.ts';
import {
  endSystemAudioShareDelivery,
  getSystemAudioShareDeliverySnapshot,
  resetLocalSystemAudioSfuCapabilities,
} from '../system-audio-delivery.ts';

function makeLocalPeer(index: number): ConnectedPeer {
  const id = `legacy-${index}`;
  return {
    id,
    label: `Peer ${index}`,
    status: 'connected',
    connectionType: 'local',
    joinOrder: index,
    conn: { open: true, peer: id, send: vi.fn() } as unknown as DataConnection,
  } as ConnectedPeer;
}

function makeRemotePeer(index: number): ConnectedPeer {
  return { ...makeLocalPeer(index), connectionType: 'remote' } as ConnectedPeer;
}

function makeMediaConnection(peerConnection: RTCPeerConnection | null = null) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const mediaConn = {
    metadata: { type: 'system-audio-stereo' },
    peerConnection,
    close: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
  } as unknown as MediaConnection;
  return {
    mediaConn,
    emit(event: string, ...args: unknown[]): void {
      handlers.get(event)?.(...args);
    },
  };
}

beforeEach(() => {
  bus.clear();
  resetState();
  vi.clearAllMocks();
  endSystemAudioShareDelivery();
  resetLocalSystemAudioSfuCapabilities();
  setState('network.appRole', 'host');
  mocks.isSystemAudioActive.mockReturnValue(true);
  mocks.getCapturedAudioStream.mockReturnValue(null);
  registerSystemAudioHostListeners();
});

afterEach(() => {
  bus.emit('system-audio:stop');
  bus.clear();
  endSystemAudioShareDelivery();
  resetLocalSystemAudioSfuCapabilities();
});

describe('bounded direct system-audio host delivery', () => {
  it('immediately stops a ninth legacy LAN guest before checking direct-call support', () => {
    const peers = Array.from({ length: 9 }, (_, index) => makeLocalPeer(index + 1));
    setState('network.connectedPeers', peers);

    bus.emit('system-audio:streams-ready');

    expect(mocks.getPeer).toHaveBeenCalledTimes(8);
    expect(mocks.safeSend).toHaveBeenCalledTimes(9);
    expect(mocks.safeSend).toHaveBeenCalledWith(peers[8].conn, {
      type: MSG.SYSTEM_AUDIO_STOP,
    });
  });

  it('releases the old frozen route when the same peerId gets a new exact connection', () => {
    const peer = makeLocalPeer(1);
    setState('network.connectedPeers', [peer]);
    bus.emit('system-audio:streams-ready');
    expect(getSystemAudioShareDeliverySnapshot().directPeerIds).toEqual([peer.id]);

    bus.emit('network:peer-connection-replaced', peer.id);

    expect(getSystemAudioShareDeliverySnapshot().directPeerIds).toEqual([]);
  });

  it('keeps the warm direct route when a remote peer is later relabeled local', () => {
    const remote = {
      ...makeLocalPeer(1),
      id: 'remote-relabel',
      connectionType: 'remote' as const,
    } as ConnectedPeer;
    mocks.getPeer.mockReturnValue({ call: vi.fn(() => makeMediaConnection().mediaConn) });
    mocks.getCapturedAudioStream.mockReturnValue({} as MediaStream);
    setState('network.connectedPeers', [remote]);
    bus.emit('system-audio:streams-ready');

    setState('network.connectedPeers', [
      { ...remote, connectionType: 'local' as const } as ConnectedPeer,
    ]);
    bus.emit('system-audio:sfu-fallback', 'test-outage');

    expect(getSystemAudioShareDeliverySnapshot().directPeerIds).toEqual([remote.id]);
    expect(getSystemAudioShareDeliverySnapshot().fallbackDirectPeerIds).toEqual([]);
  });

  it('hands an asynchronous remote direct negotiation failure to the SFU', () => {
    const remote = makeRemotePeer(1);
    const direct = makeMediaConnection();
    const call = vi.fn(() => direct.mediaConn);
    mocks.getPeer.mockReturnValue({ call });
    mocks.getCapturedAudioStream.mockReturnValue({} as MediaStream);
    setState('network.connectedPeers', [remote]);
    const handoff = vi.fn();
    bus.on('system-audio:sfu-peer-needed', handoff);

    bus.emit('system-audio:streams-ready');
    direct.emit('error', new Error('offer failed'));

    expect(handoff).toHaveBeenCalledWith(remote.id, 'offer failed');
    expect(getSystemAudioShareDeliverySnapshot()).toMatchObject({
      directPeerIds: [],
      sfuPeerIds: [remote.id],
    });
    expect(mocks.safeSend).toHaveBeenCalledWith(
      remote.conn,
      expect.objectContaining({ type: MSG.SYSTEM_AUDIO_START }),
    );
    const handoffFrames = mocks.safeSend.mock.calls
      .filter(([conn]) => conn === remote.conn)
      .map(([, frame]) => frame);
    expect(handoffFrames.slice(-2)).toEqual([
      { type: MSG.SYSTEM_AUDIO_STOP },
      expect.objectContaining({ type: MSG.SYSTEM_AUDIO_START }),
    ]);
    bus.emit('system-audio:sfu-fallback', 'sfu also failed');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('hands an unexpected direct close to the SFU while the data peer remains live', () => {
    const remote = makeRemotePeer(1);
    const direct = makeMediaConnection();
    mocks.getPeer.mockReturnValue({ call: vi.fn(() => direct.mediaConn) });
    mocks.getCapturedAudioStream.mockReturnValue({} as MediaStream);
    setState('network.connectedPeers', [remote]);
    const handoff = vi.fn();
    bus.on('system-audio:sfu-peer-needed', handoff);

    bus.emit('system-audio:streams-ready');
    direct.emit('close');

    expect(handoff).toHaveBeenCalledWith(remote.id, 'media-connection-closed');
    expect(getSystemAudioShareDeliverySnapshot()).toMatchObject({
      directPeerIds: [],
      sfuPeerIds: [remote.id],
    });
  });

  it('hands a stalled offer on an already-connected shared peer connection to the SFU', async () => {
    const remote = makeRemotePeer(1);
    const pc = {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      setLocalDescription: vi.fn(async () => {}),
      getSenders: vi.fn(() => []),
    } as unknown as RTCPeerConnection;
    const direct = makeMediaConnection(pc);
    mocks.getPeer.mockReturnValue({ call: vi.fn(() => direct.mediaConn) });
    mocks.getCapturedAudioStream.mockReturnValue({} as MediaStream);
    setState('network.connectedPeers', [remote]);
    const handoff = vi.fn();
    bus.on('system-audio:sfu-peer-needed', handoff);

    bus.emit('system-audio:streams-ready');
    const { setManagedTimer } = await import('../../core/timers.ts');
    const timeout = vi
      .mocked(setManagedTimer)
      .mock.calls.find(([name]) => name === `sys-audio-direct-connect:${remote.id}`)?.[1] as
      | (() => void)
      | undefined;
    expect(timeout).toBeTypeOf('function');
    timeout!();

    expect(handoff).toHaveBeenCalledWith(remote.id, 'connect-timeout');
    expect(getSystemAudioShareDeliverySnapshot()).toMatchObject({
      directPeerIds: [],
      sfuPeerIds: [remote.id],
    });
  });

  it('does not let a replaced media call late-close delete its successor timer', async () => {
    const peer = makeLocalPeer(1);
    const firstPc = {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      setLocalDescription: vi.fn(async () => {}),
      getSenders: vi.fn(() => []),
    } as unknown as RTCPeerConnection;
    const replacementPc = {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      setLocalDescription: vi.fn(async () => {}),
      getSenders: vi.fn(() => []),
    } as unknown as RTCPeerConnection;
    const first = makeMediaConnection(firstPc);
    const replacement = makeMediaConnection(replacementPc);
    const call = vi
      .fn()
      .mockReturnValueOnce(first.mediaConn)
      .mockReturnValueOnce(replacement.mediaConn);
    mocks.getPeer.mockReturnValue({ call });
    mocks.getCapturedAudioStream.mockReturnValue({} as MediaStream);
    setState('network.connectedPeers', [peer]);

    bus.emit('system-audio:streams-ready');
    expect(call).toHaveBeenCalledTimes(1);

    bus.emit('network:peer-connection-replaced', peer.id);
    bus.emit('orchestrator:peer-data-target-ready', peer.id);
    expect(call).toHaveBeenCalledTimes(2);

    const { clearManagedTimer } = await import('../../core/timers.ts');
    const clearsBeforeStaleClose = vi
      .mocked(clearManagedTimer)
      .mock.calls.filter(([name]) => name === `sys-audio-direct-connect:${peer.id}`).length;
    first.emit('close');
    first.emit('open');
    bus.emit('orchestrator:peer-data-target-ready', peer.id);

    expect(call).toHaveBeenCalledTimes(2);
    expect(replacement.mediaConn.close).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(clearManagedTimer)
        .mock.calls.filter(([name]) => name === `sys-audio-direct-connect:${peer.id}`),
    ).toHaveLength(clearsBeforeStaleClose);
  });

  it('keeps the former dual-mono aggregate budget on the one stereo sender', async () => {
    const peer = makeLocalPeer(1);
    const senderParameters: RTCRtpSendParameters = {
      codecs: [],
      headerExtensions: [],
      rtcp: {},
      encodings: [{}],
      transactionId: 'test',
    };
    const sender = {
      track: {
        kind: 'audio',
        applyConstraints: vi.fn(async () => {}),
      },
      getParameters: vi.fn(() => senderParameters),
      setParameters: vi.fn(async () => {}),
    } as unknown as RTCRtpSender;
    const originalSetLocalDescription = vi.fn(async () => {});
    const pc = {
      setLocalDescription: originalSetLocalDescription,
      getSenders: vi.fn(() => [sender]),
    } as unknown as RTCPeerConnection;
    const direct = makeMediaConnection(pc);
    const call = vi.fn(() => direct.mediaConn);
    const capturedStream = {} as MediaStream;
    mocks.getPeer.mockReturnValue({ call });
    mocks.getCapturedAudioStream.mockReturnValue(capturedStream);
    setState('network.connectedPeers', [peer]);

    bus.emit('system-audio:streams-ready');
    await pc.setLocalDescription({ type: 'offer', sdp: 'offer-sdp' });

    expect(call).toHaveBeenCalledWith(peer.id, capturedStream, {
      metadata: { type: 'system-audio-stereo' },
    });
    expect(sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({ encodings: [{ maxBitrate: 256000 }] }),
    );
  });
});
