/**
 * @vitest-environment jsdom
 *
 * Standard-room SYSTEM_AUDIO_START frames have one constructor,
 * createSystemAudioStartFrame, so every sender announces the same normalized
 * surface and never forwards raw metadata text.
 *
 * The production senders on main aa62fe34, each pinned by behaviour (Phase 5
 * prep T6 replaced a source-text check of their files):
 * - audio/system-capture.ts, the share start broadcast: system-capture-stop
 *   .test.ts "publishes the allowlisted surface after reading settings before
 *   video teardown" and "still stops discarded video and uses DISPLAY when
 *   getSettings throws".
 * - player/playback.ts, the late-join bootstrap on peer connect:
 *   playback-extended.test.ts "sends system audio bootstrap without file
 *   playback payloads".
 * - network/system-audio-host.ts (a late peer, the direct-route failure
 *   handoff and the remote fallback after an SFU outage): below, driven
 *   through the real host and Standard SFU modules, the real delivery policy,
 *   protocol router, peer-state, state, bus and managed timers.
 *
 * Phase 5 5B-OV2 removed a sixth sender, network/system-audio-sfu.ts (a late
 * LAN peer whose SFU capability marker arrived after the peer event): the host
 * no longer reads that marker (old-version survey OV-B05), so a late LAN peer
 * gets the host's late-peer START once and goes to the SFU at once (the row
 * "Standard SFU, late ninth LAN listener" below).
 *
 * Replaced, as in system-audio-standard-publish-evidence.test.ts, all native
 * seams: RTCPeerConnection and the Cloudflare Realtime API
 * (__helpers__/system-audio-publisher-natives.ts), the transport's call() (a
 * local fake set through the real peer-state setPeer), the local capture
 * module (active, one stereo track), the Standard TURN loader and Web Audio.
 * Peer ids are synthetic.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { ConnectedPeer, DataConnection, MediaConnection } from '../../types/index.ts';
import { setPeer } from '../peer-state.ts';
import { registerSystemAudioHostListeners } from '../system-audio-host.ts';
import { registerSystemAudioSfuListeners } from '../system-audio-sfu.ts';
import { createSystemAudioStartFrame, readSystemAudioStartSurface } from '../system-audio-start.ts';
import {
  PublisherPeerConnection,
  makeCaptureTrack,
  publisherRealtime,
} from './__helpers__/system-audio-publisher-natives.ts';
import { FakeMediaStream } from './__helpers__/system-audio-receive-harness.ts';

const capture = vi.hoisted(() => ({ stream: null as MediaStream | null }));

vi.mock('../../i18n/index.ts', () => ({ t: (key: string) => key }));
vi.mock('../../audio/context.ts', () => ({ getAudioContext: () => null }));
vi.mock('../../audio/engine.ts', () => ({ initAudio: async () => {}, getWidener: () => null }));
vi.mock('../../player/transport.ts', () => ({ stopAllMedia: () => {} }));
vi.mock('../../core/capability.ts', async () => {
  const { publisherRealtime: fake } =
    await import('./__helpers__/system-audio-publisher-natives.ts');
  return {
    fetchWithCapability: fake.fetchWithCapability,
    isCapabilityChallengeCancelled: () => false,
  };
});
vi.mock('../standard-room-prerequisites.ts', () => ({
  getStandardRoomTurnCredentials: async () => null,
}));
vi.mock('../../audio/system-capture.ts', () => ({
  getCapturedAudioStream: () => capture.stream,
  isSystemAudioActive: () => true,
}));

describe('system audio start metadata', () => {
  beforeEach(() => resetState());

  it('uses the current synthetic metadata as the late-join source of truth', () => {
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio',
      systemAudioMode: 'sharing',
      systemAudioSurface: 'window',
    });

    expect(createSystemAudioStartFrame()).toEqual({
      type: MSG.SYSTEM_AUDIO_START,
      surface: 'window',
    });
  });

  it('normalizes explicit, missing, and future values without forwarding raw text', () => {
    expect(createSystemAudioStartFrame('browser')).toEqual({
      type: MSG.SYSTEM_AUDIO_START,
      surface: 'browser',
    });
    expect(createSystemAudioStartFrame()).toEqual({
      type: MSG.SYSTEM_AUDIO_START,
      surface: 'display',
    });
    expect(readSystemAudioStartSurface({ surface: 'private window title' })).toBe('display');
  });
});

// The publisher's two Realtime calls each answer on the next macrotask.
const PUBLISH_SETTLE_MS = 10;

// What the sharer's metadata holds, and the only START a guest may receive
// for it: a surface other than the 'display' default (a frame without one
// would read as 'display'), and a future value that must arrive normalized.
const SURFACES = [
  { stored: 'browser', sent: 'browser' },
  { stored: 'private window title', sent: 'display' },
] as const;

type FakeConn = { open: boolean; peer: string; send: ReturnType<typeof vi.fn> };

let conns: FakeConn[] = [];

function guest(index: number, connectionType: 'local' | 'remote'): ConnectedPeer {
  const id = `guest${connectionType === 'local' ? 'Lan' : 'Rmt'}-${String(index).padStart(4, '0')}-peer`;
  const conn: FakeConn = { open: true, peer: id, send: vi.fn() };
  conns.push(conn);
  return {
    id,
    label: `Peer ${index}`,
    slot: index,
    status: 'connected',
    connectionType,
    joinOrder: index,
    conn: conn as unknown as DataConnection,
  } as ConnectedPeer;
}

/** A direct media call as the transport hands it back: its 'close' fires once. */
function directCall(peerId: string): MediaConnection {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let closed = false;
  return {
    peer: peerId,
    metadata: { type: 'system-audio-stereo' },
    peerConnection: { connectionState: 'new', iceConnectionState: 'new' },
    on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
    close: () => {
      if (closed) return;
      closed = true;
      handlers.get('close')?.();
    },
  } as unknown as MediaConnection;
}

/** The transport: every direct call it placed, by peer id. */
function installTransport(): Map<string, MediaConnection> {
  const calls = new Map<string, MediaConnection>();
  setPeer({
    call: vi.fn((peerId: string) => {
      const call = directCall(peerId);
      calls.set(peerId, call);
      return call;
    }),
  } as never);
  return calls;
}

/** Every START frame any guest connection received, with its receiver. */
function startFrames(): Array<{ to: string; frame: unknown }> {
  return conns.flatMap((conn) =>
    conn.send.mock.calls
      .map(([frame]) => frame as { type?: string })
      .filter((frame) => frame.type === MSG.SYSTEM_AUDIO_START)
      .map((frame) => ({ to: conn.peer, frame })),
  );
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('every Standard START sender sends the shared normalized frame', () => {
  beforeAll(() => {
    registerSystemAudioHostListeners();
    registerSystemAudioSfuListeners();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('RTCPeerConnection', PublisherPeerConnection);
    vi.stubGlobal('MediaStream', FakeMediaStream);
    PublisherPeerConnection.reset();
    publisherRealtime.reset();
    resetState();
    setState('network.appRole', 'host');
    setState('network.sessionCode', '000001');
    capture.stream = new FakeMediaStream([makeCaptureTrack()]) as unknown as MediaStream;
    conns = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.spyOn(log, level).mockImplementation(() => {});
    }
  });

  afterEach(() => {
    bus.emit('system-audio:stop');
    setPeer(null);
    clearAllManagedTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function shareWithSurface(stored: string): void {
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio',
      systemAudioMode: 'sharing',
      systemAudioSurface: stored as 'browser',
    });
  }

  it.each(SURFACES)('host, late peer: $stored is sent as $sent', async ({ stored, sent }) => {
    shareWithSurface(stored);
    installTransport();
    bus.emit('system-audio:streams-ready');
    await advance(0);

    const late = guest(1, 'remote');
    setState('network.connectedPeers', [late]);
    bus.emit('orchestrator:peer-joined', late.id);
    await advance(0);

    expect(startFrames()).toEqual([
      { to: late.id, frame: { type: MSG.SYSTEM_AUDIO_START, surface: sent } },
    ]);
  });

  it.each(SURFACES)(
    'host, direct-route failure handoff: $stored is sent as $sent',
    async ({ stored, sent }) => {
      shareWithSurface(stored);
      const listener = guest(1, 'remote');
      setState('network.connectedPeers', [listener]);
      const calls = installTransport();
      bus.emit('system-audio:streams-ready');
      await advance(0);
      expect(startFrames()).toEqual([]);

      calls.get(listener.id)?.close();
      await advance(PUBLISH_SETTLE_MS);

      // The STOP and START that re-enter the guest's placeholder (SA-2,
      // kept), then the READY.
      expect(conns[0]?.send.mock.calls.map(([frame]) => frame)).toEqual([
        { type: MSG.SYSTEM_AUDIO_STOP },
        { type: MSG.SYSTEM_AUDIO_START, surface: sent },
        expect.objectContaining({ type: MSG.SYSTEM_AUDIO_SFU_READY }),
      ]);
      expect(startFrames()).toHaveLength(1);
    },
  );

  it.each(SURFACES)(
    'host, remote fallback after an SFU outage: $stored is sent as $sent',
    async ({ stored, sent }) => {
      shareWithSurface(stored);
      // Nine remote listeners: eight take the direct slots, the ninth the SFU.
      const listeners = Array.from({ length: 9 }, (_, index) => guest(index + 1, 'remote'));
      setState('network.connectedPeers', listeners);
      installTransport();
      bus.emit('system-audio:streams-ready');
      await advance(PUBLISH_SETTLE_MS);
      const sfuListener = listeners[8]!;
      expect(PublisherPeerConnection.instances).toHaveLength(1);

      // A direct listener leaves, which frees one direct slot, and then the
      // SFU publication fails at runtime.
      const [leaving, ...staying] = listeners;
      setState('network.connectedPeers', staying);
      bus.emit('network:peer-disconnected', leaving!.id);
      PublisherPeerConnection.instances[0]!.setConnectionState('failed');
      await advance(0);

      expect(startFrames()).toEqual([
        { to: sfuListener.id, frame: { type: MSG.SYSTEM_AUDIO_START, surface: sent } },
      ]);
    },
  );

  it.each(SURFACES)(
    'Standard SFU, late ninth LAN listener: $stored is sent as $sent, once, by the host (5B-OV2)',
    async ({ stored, sent }) => {
      shareWithSurface(stored);
      // Eight LAN listeners hold every direct slot.
      const listeners = Array.from({ length: 8 }, (_, index) => guest(index + 1, 'local'));
      setState('network.connectedPeers', listeners);
      installTransport();
      bus.emit('system-audio:streams-ready');
      await advance(0);

      // A ninth LAN listener joins: the host's late-peer START, then the SFU.
      const late = guest(9, 'local');
      setState('network.connectedPeers', [...listeners, late]);
      bus.emit('orchestrator:peer-joined', late.id);
      await advance(PUBLISH_SETTLE_MS);

      expect(startFrames()).toEqual([
        { to: late.id, frame: { type: MSG.SYSTEM_AUDIO_START, surface: sent } },
      ]);
      const lateFrames = conns.at(-1)!.send.mock.calls.map(([frame]) => frame as { type?: string });
      expect(lateFrames.map((frame) => frame.type)).toEqual([
        MSG.SYSTEM_AUDIO_START,
        MSG.SYSTEM_AUDIO_SFU_READY,
      ]);
      expect(lateFrames[1]).toMatchObject({ audience: 'all' });
    },
  );
});
