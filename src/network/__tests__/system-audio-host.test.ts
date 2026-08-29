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

vi.mock('../../core/timers.ts', () => ({ setManagedTimer: vi.fn() }));

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

  it('uses the frozen remote audience for fallback after ICE relabels the peer local', () => {
    const remote = {
      ...makeLocalPeer(1),
      id: 'remote-relabel',
      connectionType: 'remote' as const,
    } as ConnectedPeer;
    setState('network.connectedPeers', [remote]);
    bus.emit('system-audio:streams-ready');

    setState('network.connectedPeers', [
      { ...remote, connectionType: 'local' as const } as ConnectedPeer,
    ]);
    bus.emit('system-audio:sfu-fallback', 'test-outage');

    expect(getSystemAudioShareDeliverySnapshot().fallbackDirectPeerIds).toEqual([remote.id]);
  });

  it('does not let a replaced media call late-close delete its successor', () => {
    const peer = makeLocalPeer(1);
    const first = makeMediaConnection();
    const replacement = makeMediaConnection();
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

    first.emit('close');
    bus.emit('orchestrator:peer-data-target-ready', peer.id);

    expect(call).toHaveBeenCalledTimes(2);
    expect(replacement.mediaConn.close).not.toHaveBeenCalled();
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
