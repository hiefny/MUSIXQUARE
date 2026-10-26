/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { resetState, setState } from '../../core/state.ts';
import { MSG } from '../../core/constants.ts';
import type { ConnectedPeer, DataConnection, MediaConnection } from '../../types/index.ts';
import type { TransportCallOptions } from '../transport/types.ts';

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

vi.mock('../opus-stereo-sdp.ts', () => ({ forceStereoSdp: (sdp: string) => sdp }));

import { registerSystemAudioHostListeners } from '../system-audio-host.ts';
import {
  endSystemAudioShareDelivery,
  getFrozenSystemAudioSfuAudience,
  getSystemAudioShareDeliverySnapshot,
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
  setState('network.appRole', 'host');
  mocks.isSystemAudioActive.mockReturnValue(true);
  mocks.getCapturedAudioStream.mockReturnValue(null);
  registerSystemAudioHostListeners();
});

afterEach(() => {
  bus.emit('system-audio:stop');
  bus.clear();
  endSystemAudioShareDelivery();
});

describe('bounded direct system-audio host delivery', () => {
  // Every LAN guest is SFU-capable (5B-OV2, old-version survey OV-B05): the
  // host no longer tells guests that sent SYSTEM_AUDIO_SFU_CAPABILITY from
  // clients below 8.4.38, so no LAN guest is 'unsupported' and none gets an
  // immediate STOP.
  it('starts a nine-LAN-guest share on the SFU with no direct call and no STOP (5B-OV2)', () => {
    const peers = Array.from({ length: 9 }, (_, index) => makeLocalPeer(index + 1));
    setState('network.connectedPeers', peers);

    bus.emit('system-audio:streams-ready');

    expect(mocks.getPeer).not.toHaveBeenCalled();
    expect(mocks.safeSend).not.toHaveBeenCalled();
    expect(getSystemAudioShareDeliverySnapshot()).toMatchObject({
      mode: 'all-sfu',
      directPeerIds: [],
      sfuPeerIds: peers.map((peer) => peer.id),
    });
  });

  it('sends a late ninth LAN guest START and leaves it to the SFU, with no direct call and no STOP (5B-OV2)', () => {
    const peers = Array.from({ length: 8 }, (_, index) => makeLocalPeer(index + 1));
    const call = vi.fn(() => makeMediaConnection().mediaConn);
    mocks.getPeer.mockReturnValue({ call });
    mocks.getCapturedAudioStream.mockReturnValue({} as MediaStream);
    setState('network.connectedPeers', peers);
    bus.emit('system-audio:streams-ready');
    expect(call).toHaveBeenCalledTimes(8);

    const late = makeLocalPeer(9);
    setState('network.connectedPeers', [...peers, late]);
    bus.emit('orchestrator:peer-joined', late.id);

    expect(call).toHaveBeenCalledTimes(8);
    expect(
      mocks.safeSend.mock.calls.filter(([conn]) => conn === late.conn).map(([, frame]) => frame),
    ).toEqual([expect.objectContaining({ type: MSG.SYSTEM_AUDIO_START })]);
    expect(getSystemAudioShareDeliverySnapshot().sfuPeerIds).toEqual([late.id]);
    expect(getFrozenSystemAudioSfuAudience(late.id)).toBe('all');
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

  it('hands a failed LAN direct call to the SFU with the all audience instead of only stopping it (5B-OV2)', () => {
    const local = makeLocalPeer(1);
    const direct = makeMediaConnection();
    mocks.getPeer.mockReturnValue({ call: vi.fn(() => direct.mediaConn) });
    mocks.getCapturedAudioStream.mockReturnValue({} as MediaStream);
    setState('network.connectedPeers', [local]);
    const handoff = vi.fn();
    bus.on('system-audio:sfu-peer-needed', handoff);

    bus.emit('system-audio:streams-ready');
    direct.emit('error', new Error('offer failed'));

    expect(handoff).toHaveBeenCalledWith(local.id, 'offer failed');
    expect(getSystemAudioShareDeliverySnapshot()).toMatchObject({
      directPeerIds: [],
      sfuPeerIds: [local.id],
    });
    expect(getFrozenSystemAudioSfuAudience(local.id)).toBe('all');
    expect(
      mocks.safeSend.mock.calls.filter(([conn]) => conn === local.conn).map(([, frame]) => frame),
    ).toEqual([
      { type: MSG.SYSTEM_AUDIO_STOP },
      expect.objectContaining({ type: MSG.SYSTEM_AUDIO_START }),
    ]);
  });

  // 5B-G1 guard (passes before and after): a guest whose attach the receive
  // slot refuses keeps its direct call open (system-audio-receive-slot-
  // contract.test.ts, S9 row: closeCount 0 until STOP). The host hands a peer
  // to the SFU only on the call's close, its error or the connect timeout
  // before 'open', so an open call that stays open gets no STOP, START or
  // READY handoff.
  it.each([
    {
      transport: 'a fresh media peer connection (PeerJS)',
      pc: () =>
        ({
          connectionState: 'new',
          iceConnectionState: 'new',
          setLocalDescription: vi.fn(async () => {}),
          getSenders: vi.fn(() => []),
        }) as unknown as RTCPeerConnection,
      connects: (pc: RTCPeerConnection) => {
        Object.assign(pc, { connectionState: 'connected', iceConnectionState: 'connected' });
      },
    },
    {
      transport: 'an already-connected shared peer connection (Cloudflare)',
      pc: () =>
        ({
          connectionState: 'connected',
          iceConnectionState: 'connected',
          setLocalDescription: vi.fn(async () => {}),
          getSenders: vi.fn(() => []),
        }) as unknown as RTCPeerConnection,
      connects: () => undefined,
    },
  ])(
    'keeps an opened direct call with no close or error for 60 s with no SFU handoff, on $transport',
    async ({ pc: makePc, connects }) => {
      vi.useFakeTimers();
      const { setManagedTimer, clearManagedTimer } = await import('../../core/timers.ts');
      const timers = new Map<string, ReturnType<typeof setTimeout>>();
      vi.mocked(clearManagedTimer).mockImplementation((name: string) => {
        clearTimeout(timers.get(name));
        timers.delete(name);
      });
      vi.mocked(setManagedTimer).mockImplementation(
        (name: string, fn: () => void, delayMs: number) => {
          clearTimeout(timers.get(name));
          timers.set(
            name,
            setTimeout(() => {
              timers.delete(name);
              fn();
            }, delayMs),
          );
        },
      );
      try {
        for (const peer of [makeLocalPeer(1), makeRemotePeer(2)]) {
          bus.emit('system-audio:stop');
          bus.clear();
          endSystemAudioShareDelivery();
          vi.mocked(mocks.safeSend).mockClear();
          registerSystemAudioHostListeners();
          const pc = makePc();
          const direct = makeMediaConnection(pc);
          mocks.getPeer.mockReturnValue({ call: vi.fn(() => direct.mediaConn) });
          mocks.getCapturedAudioStream.mockReturnValue({} as MediaStream);
          setState('network.connectedPeers', [peer]);
          const handoff = vi.fn();
          bus.on('system-audio:sfu-peer-needed', handoff);

          bus.emit('system-audio:streams-ready');
          connects(pc);
          direct.emit('open');
          await vi.advanceTimersByTimeAsync(60_000);

          expect(handoff).not.toHaveBeenCalled();
          expect(direct.mediaConn.close).not.toHaveBeenCalled();
          expect(getSystemAudioShareDeliverySnapshot()).toMatchObject({
            directPeerIds: [peer.id],
            sfuPeerIds: [],
          });
          const frames = mocks.safeSend.mock.calls
            .filter(([conn]) => conn === peer.conn)
            .map(([, frame]) => (frame as { type: string }).type);
          expect(frames).not.toContain(MSG.SYSTEM_AUDIO_STOP);
          expect(frames).not.toContain(MSG.SYSTEM_AUDIO_START);
          expect(frames).not.toContain(MSG.SYSTEM_AUDIO_SFU_READY);
        }
      } finally {
        for (const timer of timers.values()) clearTimeout(timer);
        vi.mocked(setManagedTimer).mockReset();
        vi.mocked(clearManagedTimer).mockReset();
        vi.useRealTimers();
      }
    },
  );

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
      (() => void) | undefined;
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
    const callOptions = (
      call.mock.calls[0] as unknown as [string, MediaStream, TransportCallOptions]
    )[2];
    callOptions?.senderTuning?.(sender);

    expect(call).toHaveBeenCalledWith(
      peer.id,
      capturedStream,
      expect.objectContaining({
        metadata: { type: 'system-audio-stereo' },
        sdpTransform: expect.any(Function),
        senderTuning: expect.any(Function),
      }),
    );
    expect(pc.setLocalDescription).toBe(originalSetLocalDescription);
    expect(sender.track?.applyConstraints).toHaveBeenCalledWith({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(sender.setParameters).toHaveBeenCalledWith(
      expect.objectContaining({ encodings: [{ maxBitrate: 256000 }] }),
    );
  });

  // Phase 5 C4-1 moves this tuning into system-audio-media.ts, shared with
  // both SFU publishers. These are the direct call's edges today: only an
  // audio sender is tuned, a missing encoding list becomes one encoding, and
  // a sender that lists no encoding is left alone (the PRO LAN-direct
  // publisher still sets those parameters back; pro-system-audio-direct.test).
  it.each([
    {
      name: 'a non-audio sender',
      kind: 'video',
      parameters: { encodings: [{}] },
      constrained: false,
      set: null,
    },
    {
      name: 'a sender without a track',
      kind: null,
      parameters: { encodings: [{}] },
      constrained: false,
      set: null,
    },
    {
      name: 'a sender without an encoding list',
      kind: 'audio',
      parameters: {},
      constrained: true,
      set: { encodings: [{ maxBitrate: 256000 }] },
    },
    {
      name: 'a sender that lists no encoding',
      kind: 'audio',
      parameters: { encodings: [] },
      constrained: true,
      set: null,
    },
  ])('direct-call sender tuning on $name', ({ kind, parameters, constrained, set }) => {
    const peer = makeLocalPeer(1);
    const applyConstraints = vi.fn(async () => {});
    const sender = {
      track: kind === null ? null : { kind, applyConstraints },
      getParameters: vi.fn(() => structuredClone(parameters) as RTCRtpSendParameters),
      setParameters: vi.fn(async () => {}),
    } as unknown as RTCRtpSender;
    const direct = makeMediaConnection({
      setLocalDescription: vi.fn(async () => {}),
    } as unknown as RTCPeerConnection);
    const call = vi.fn(() => direct.mediaConn);
    mocks.getPeer.mockReturnValue({ call });
    mocks.getCapturedAudioStream.mockReturnValue({} as MediaStream);
    setState('network.connectedPeers', [peer]);

    bus.emit('system-audio:streams-ready');
    const callOptions = (
      call.mock.calls[0] as unknown as [string, MediaStream, TransportCallOptions]
    )[2];
    expect(callOptions?.senderTuning).toBeTypeOf('function');
    callOptions?.senderTuning?.(sender);

    expect(applyConstraints).toHaveBeenCalledTimes(constrained ? 1 : 0);
    if (set === null) {
      expect(sender.setParameters).not.toHaveBeenCalled();
    } else {
      expect(sender.setParameters).toHaveBeenCalledTimes(1);
      expect(sender.setParameters).toHaveBeenCalledWith(set);
    }
  });
});
