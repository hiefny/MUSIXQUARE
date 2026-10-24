/**
 * @vitest-environment jsdom
 *
 * Standard host (sharer) side of the system-audio device evidence, Phase 5
 * prep T2 and T3. Driven through the real host and Standard SFU modules, the
 * real delivery policy, peer-state, state, bus and managed timers; not matched
 * in source text.
 *
 * T3: the host lines the Phase 5 device criteria read from the sharer's
 * /debug console file (`?mxqrLog=info`), with their exact text, argument count
 * and log level: the direct call (info), the direct-route failure handoff to
 * the SFU (warn; a Standard SFU attempt has device evidence only when this
 * line is in the sharer's file) and the SFU publication (info).
 *
 * T2: the Standard SFU publisher's music sender tuning, which C4-1 moves into
 * system-audio-media.ts: the capture track is asked once for exactly
 * {echoCancellation, noiseSuppression, autoGainControl: false}, the sender
 * carries one 256 kbps encoding, and neither step can fail the publication.
 * The Standard direct call's tuning is pinned in system-audio-host.test.ts;
 * the PRO publishers' in pro-system-audio-direct.test.ts and
 * src/pro-room/__tests__/system-audio-pro-publish-evidence.test.ts.
 *
 * Replaced, all native seams: RTCPeerConnection and the Cloudflare Realtime
 * API behind fetchWithCapability (__helpers__/system-audio-publisher-natives
 * .ts), the PeerJS-style transport's call() (a local fake set through the real
 * peer-state setPeer), the local capture module (active, one stereo track),
 * the Standard TURN loader, Web Audio and media teardown (unused on the host
 * path). The log is spied, not replaced. Each test pins main bd94075c, whose
 * system-audio code is the 9.0.7 runtime. Peer ids are synthetic.
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
import {
  PublisherPeerConnection,
  makeCaptureTrack,
  publisherRealtime,
  type CaptureTrack,
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

type Level = 'debug' | 'info' | 'warn' | 'error';
type Line = [Level, ...unknown[]];

// Synthetic peer id; the host lines print its first eight characters.
const GUEST_ID = 'guestRmt-0001-peer';
const CALLED = '[SysAudioHost] Called guest guestRmt: original stereo stream';
const handedToSfu = (reason: string) =>
  `[SysAudioSFU] Direct route failed; handing guestRmt to SFU: ${reason}`;
const PUBLISHED = '[SysAudioSFU] Published system audio to Cloudflare SFU (publisher_session_1)';
const MUSIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};
// The direct call's connect deadline (system-audio-host.ts).
const DIRECT_CONNECT_TIMEOUT_MS = 5_000;
// The publisher's two Realtime calls each answer on the next macrotask.
const PUBLISH_SETTLE_MS = 10;

const HOST_LINE =
  /Called guest|Direct route failed; handing|Published system audio to Cloudflare SFU/u;

let lines: Line[] = [];
let track: CaptureTrack;
let guestConn: { open: boolean; peer: string; send: ReturnType<typeof vi.fn> };

/** Every host line the device criteria read, at whatever level it was logged. */
function evidence(): Line[] {
  return lines.filter(([, first]) => typeof first === 'string' && HOST_LINE.test(first));
}

/** A direct media call as the transport hands it back: its 'close' fires once. */
function makeDirectCall() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let closed = false;
  const mediaConn = {
    peer: GUEST_ID,
    metadata: { type: 'system-audio-stereo' },
    peerConnection: { connectionState: 'new', iceConnectionState: 'new' },
    on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
    close: () => {
      if (closed) return;
      closed = true;
      handlers.get('close')?.();
    },
  };
  return { mediaConn: mediaConn as unknown as MediaConnection };
}

function remoteGuest(): ConnectedPeer {
  return {
    id: GUEST_ID,
    label: 'Peer 1',
    slot: 1,
    status: 'connected',
    connectionType: 'remote',
    joinOrder: 1,
    conn: guestConn as unknown as DataConnection,
  } as ConnectedPeer;
}

function framesSent(): string[] {
  return guestConn.send.mock.calls.map(([frame]) => (frame as { type: string }).type);
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const publisherSender = () => PublisherPeerConnection.instances[0]?.senders[0];

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
  track = makeCaptureTrack();
  capture.stream = new FakeMediaStream([track]) as unknown as MediaStream;
  guestConn = { open: true, peer: GUEST_ID, send: vi.fn() };
  setState('network.connectedPeers', [remoteGuest()]);
  lines = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
      lines.push([level, ...args]);
    });
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

/** The share starts with one remote guest on a warm direct call. */
async function shareWithDirectCall() {
  const call = makeDirectCall();
  const peer = { call: vi.fn(() => call.mediaConn) };
  setPeer(peer as never);
  bus.emit('system-audio:streams-ready');
  await advance(0);
  expect(peer.call).toHaveBeenCalledTimes(1);
  return call;
}

describe('Standard host device evidence lines', () => {
  it('logs the direct call at info with the first eight characters of the guest id', async () => {
    await shareWithDirectCall();
    expect(evidence()).toEqual([['info', CALLED]]);
    expect(publisherRealtime.requests).toEqual([]);
  });

  it('logs the failed direct route at warn, then the SFU publication at info, when the transport closes the call', async () => {
    const call = await shareWithDirectCall();
    call.mediaConn.close();
    await advance(PUBLISH_SETTLE_MS);

    expect(evidence()).toEqual([
      ['info', CALLED],
      ['warn', handedToSfu('media-connection-closed')],
      ['info', PUBLISHED],
    ]);
    // The guest gets the rolling-release STOP and START, then the READY.
    expect(framesSent()).toEqual([
      MSG.SYSTEM_AUDIO_STOP,
      MSG.SYSTEM_AUDIO_START,
      MSG.SYSTEM_AUDIO_SFU_READY,
    ]);
  });

  it('logs the same pair with the connect-timeout reason when the call never connects', async () => {
    await shareWithDirectCall();
    await advance(DIRECT_CONNECT_TIMEOUT_MS - 1);
    expect(evidence()).toEqual([['info', CALLED]]);

    await advance(1);
    expect(evidence()).toEqual([
      ['info', CALLED],
      ['warn', handedToSfu('connect-timeout')],
    ]);
    await advance(PUBLISH_SETTLE_MS);
    expect(evidence()).toEqual([
      ['info', CALLED],
      ['warn', handedToSfu('connect-timeout')],
      ['info', PUBLISHED],
    ]);
  });
});

describe('Standard SFU publisher music sender tuning (T2)', () => {
  it('asks the capture track once for the music constraints and sends one 256 kbps encoding', async () => {
    const call = await shareWithDirectCall();
    // The direct call's own sender tuning runs inside the transport, which is
    // faked here, so every constraint request below is the SFU publisher's.
    expect(track.constraintRequests).toEqual([]);
    call.mediaConn.close();
    await advance(PUBLISH_SETTLE_MS);

    expect(track.constraintRequests).toEqual([MUSIC_CONSTRAINTS]);
    const sender = publisherSender();
    expect(sender?.track).toBe(track);
    expect(sender?.setParameters).toHaveBeenCalledTimes(1);
    expect(sender?.setParameters).toHaveBeenCalledWith({ encodings: [{ maxBitrate: 256000 }] });
    expect(sender?.applied).toEqual({ encodings: [{ maxBitrate: 256000 }] });
  });

  // A rejection the publisher left unhandled would fail the run as an
  // unhandled error even though the assertions below pass.
  it.each(['reject', 'throw'] as const)(
    'still publishes and still sets the bitrate when applyConstraints would %s',
    async (how) => {
      track.refuseConstraints(how);
      const call = await shareWithDirectCall();
      call.mediaConn.close();
      await advance(PUBLISH_SETTLE_MS);

      expect(track.constraintRequests).toEqual([MUSIC_CONSTRAINTS]);
      expect(publisherSender()?.applied).toEqual({ encodings: [{ maxBitrate: 256000 }] });
      expect(evidence().at(-1)).toEqual(['info', PUBLISHED]);
      expect(framesSent().at(-1)).toBe(MSG.SYSTEM_AUDIO_SFU_READY);
    },
  );

  it('still publishes with the music constraints when the sender parameters cannot be read', async () => {
    PublisherPeerConnection.onSender = (sender) =>
      sender.getParameters.mockImplementation(() => {
        throw new TypeError('getParameters is not supported');
      });
    const call = await shareWithDirectCall();
    call.mediaConn.close();
    await advance(PUBLISH_SETTLE_MS);

    expect(track.constraintRequests).toEqual([MUSIC_CONSTRAINTS]);
    expect(publisherSender()?.setParameters).not.toHaveBeenCalled();
    expect(evidence().at(-1)).toEqual(['info', PUBLISHED]);
    expect(framesSent().at(-1)).toBe(MSG.SYSTEM_AUDIO_SFU_READY);
  });
});
