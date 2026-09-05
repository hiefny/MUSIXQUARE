/**
 * @vitest-environment jsdom
 *
 * Contract tests for host-publish supersession in the Cloudflare Realtime SFU
 * bridge.
 *
 * publishHostTracks can remain in its Realtime fetch chain for seconds. A
 * failure after supersession must not set hostSfuUnavailable for the next
 * share or run cleanup against successor state; otherwise the next publication
 * returns null and remote guests wait until the receive watchdog expires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { fetchWithCapability } from '../../core/capability.ts';
import { MSG } from '../../core/constants.ts';
import { setManagedTimer } from '../../core/timers.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';
import {
  beginSystemAudioShareDelivery,
  getSystemAudioShareDeliverySnapshot,
  isSystemAudioDirectFailurePeer,
  markLocalSystemAudioSfuCapable,
  promoteSystemAudioPeerDeliveryToSfu,
  reserveSystemAudioFallbackDirect,
  resetGuestSystemAudioShareRoute,
  resetLocalSystemAudioSfuCapabilities,
} from '../system-audio-delivery.ts';

const systemAudioGuestMocks = vi.hoisted(() => ({
  awaitTrustedReceptionBoundary: vi.fn(async () => true),
  beginTrustedReception: vi.fn(),
  cleanupGuestSystemAudio: vi.fn(),
}));

const standardRoomPrerequisiteMocks = vi.hoisted(() => ({
  getTurnCredentials: vi.fn(),
}));

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../i18n/index.ts', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../core/timers.ts', () => ({
  setManagedTimer: vi.fn(),
  clearManagedTimer: vi.fn(),
  getManagedTimer: vi.fn(() => null),
}));

vi.mock('../../core/capability.ts', () => ({
  fetchWithCapability: vi.fn(),
  isCapabilityChallengeCancelled: vi.fn(() => false),
}));

vi.mock('../../audio/context.ts', () => ({
  getAudioContext: vi.fn(() => null),
}));

vi.mock('../../audio/engine.ts', () => ({
  initAudio: vi.fn(async () => {}),
  getWidener: vi.fn(() => null),
}));

vi.mock('../../audio/system-capture.ts', () => ({
  getCapturedAudioStream: vi.fn(),
  isSystemAudioActive: vi.fn(() => true),
}));

vi.mock('../../player/ownership.ts', () => ({
  claimPlaybackOwner: vi.fn(),
  setSystemAudioReceiving: vi.fn(),
}));

vi.mock('../protocol.ts', () => ({
  registerHandler: vi.fn(),
}));

vi.mock('../peer-state.ts', () => ({
  safeSend: vi.fn(() => true),
}));

vi.mock('../standard-room-prerequisites.ts', () => ({
  getStandardRoomTurnCredentials: standardRoomPrerequisiteMocks.getTurnCredentials,
}));

vi.mock('../system-audio-guest.ts', () => ({
  cleanupGuestSystemAudio: systemAudioGuestMocks.cleanupGuestSystemAudio,
  beginTrustedSystemAudioReception: systemAudioGuestMocks.beginTrustedReception,
  awaitTrustedSystemAudioReceptionBoundary: systemAudioGuestMocks.awaitTrustedReceptionBoundary,
}));

vi.mock('../webrtc-audio-decoder-primer.ts', () => ({
  cleanupWebRtcAudioDecoderPrimer: vi.fn(),
  getAudioTrackStreamKey: vi.fn(() => 'key'),
  primeWebRtcAudioDecoder: vi.fn(() => null),
}));

// ─── Harness ───────────────────────────────────────────────────────────────

const fetchMock = vi.mocked(fetchWithCapability);

interface PendingRealtimeCall {
  action: string;
  resolve: (json: unknown) => void;
  reject: (error: unknown) => void;
}

let pendingRealtimeCalls: PendingRealtimeCall[];
let pcInstances: MockRTCPeerConnection[];
const OPUS_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10',
  '',
].join('\r\n');
const OPUS_STEREO_SDP = [
  'v=0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10; stereo=1; sprop-stereo=1; maxaveragebitrate=256000',
  '',
].join('\r\n');

class MockRTCPeerConnection {
  readonly configuration: RTCConfiguration | undefined;
  close = vi.fn();
  // Record connectionstatechange listeners so tests can fire runtime states.
  _listeners: Record<string, Array<() => void>> = {};
  addEventListener = vi.fn((type: string, cb: () => void) => {
    (this._listeners[type] ||= []).push(cb);
  });
  _emit(type: string) {
    for (const cb of this._listeners[type] || []) cb();
  }
  connectionState = 'new';
  iceConnectionState = 'new';
  signalingState = 'stable';
  ontrack: ((event: unknown) => void) | null = null;
  _nextTransceiverMid = 0;
  senderGetParameters = vi.fn(() => ({ encodings: [{}] }));
  senderSetParameters = vi.fn(async () => {});
  addTransceiver = vi.fn((track: MediaStreamTrack) => ({
    mid: String(this._nextTransceiverMid++),
    sender: {
      track,
      getParameters: this.senderGetParameters,
      setParameters: this.senderSetParameters,
    },
  }));
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'sdp' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'ans' }));
  setLocalDescription = vi.fn<(description: RTCSessionDescriptionInit) => Promise<void>>(
    async () => {},
  );
  setRemoteDescription = vi.fn<(description: RTCSessionDescriptionInit) => Promise<void>>(
    async () => {},
  );
  // Guest subscribe reads receiver tracks off the transceivers after
  // setRemoteDescription; one audio transceiver drives a single connectGuestTrack.
  getTransceivers = vi.fn(() => [
    { mid: '0', receiver: { track: { kind: 'audio', id: 'g-track-L' } } },
  ]);
  constructor(configuration?: RTCConfiguration) {
    this.configuration = configuration;
    pcInstances.push(this);
  }
}

function installFetchRouting(): void {
  fetchMock.mockImplementation((_input, _capability, init) => {
    const action = init?.body ? (JSON.parse(String(init.body)) as { action: string }).action : '?';
    return new Promise<Response>((resolve, reject) => {
      pendingRealtimeCalls.push({
        action,
        resolve: (json: unknown) => resolve(Response.json(json)),
        reject,
      });
    });
  });
}

/** Reject every pending + subsequently-retried Realtime call (callRealtime
 *  loops over two endpoints) until the chain stops issuing new ones. */
async function rejectAllRealtimeCalls(): Promise<void> {
  for (let round = 0; round < 6; round++) {
    const batch = pendingRealtimeCalls.splice(0, pendingRealtimeCalls.length);
    for (const call of batch) call.reject(new Error('REALTIME_NETWORK_TEST'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function makeRemotePeer(id: string): ConnectedPeer {
  return {
    id,
    label: `Peer ${id}`,
    status: 'connected',
    connectionType: 'remote',
    conn: { open: true, send: vi.fn(), peer: id },
  } as unknown as ConnectedPeer;
}

function makeLocalPeer(id: string): ConnectedPeer {
  return {
    id,
    label: `Peer ${id}`,
    status: 'connected',
    connectionType: 'local',
    conn: { open: true, send: vi.fn(), peer: id },
  } as unknown as ConnectedPeer;
}

/** The module is imported ONCE (no vi.resetModules — that would split the
 *  bus/state/mock instances between the SUT and this file). beforeEach's
 *  bus.clear() drops the previous test's listeners, so re-registering here
 *  yields exactly one live set; the 'system-audio:stop' emit then resets the
 *  module's host-publish state (cleanupHostSfu(true): epoch bump, flag reset,
 *  pc/session/promise nulled) to a clean baseline. */
async function loadSfuModuleAsHostWithRemoteGuest() {
  const mod = await import('../system-audio-sfu.ts');
  mod.registerSystemAudioSfuListeners();
  bus.emit('system-audio:stop');

  const capture = await import('../../audio/system-capture.ts');
  const fakeStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
  vi.mocked(capture.getCapturedAudioStream).mockReturnValue(fakeStream);
  vi.mocked(capture.isSystemAudioActive).mockReturnValue(true);

  setState('network.appRole', 'host');
  // Current supported rooms stay on their already-connected P2P transport.
  // Fill the legacy eight-call ceiling so this SFU transport harness exercises
  // the remaining overflow route explicitly.
  setState(
    'network.connectedPeers',
    Array.from({ length: 9 }, (_, index) => makeRemotePeer(`remote-${index + 1}`)),
  );
  return mod;
}

async function waitForNewSessionCalls(expected: number): Promise<void> {
  await vi.waitFor(() => {
    const seen = fetchMock.mock.calls.filter(
      ([url, , init]) =>
        String(url).includes('cloudflare-realtime') &&
        init?.body &&
        (JSON.parse(String(init.body)) as { action: string }).action === 'new-session',
    ).length;
    expect(seen).toBeGreaterThanOrEqual(expected);
  });
}

function countNewSessionCalls(): number {
  return fetchMock.mock.calls.filter(
    ([url, , init]) =>
      String(url).includes('cloudflare-realtime') &&
      init?.body &&
      (JSON.parse(String(init.body)) as { action: string }).action === 'new-session',
  ).length;
}

/** Resolve the first pending Realtime call for `action` with `json`, then let
 *  the awaiting chain advance. */
async function resolveRealtime(action: string, json: unknown): Promise<void> {
  await vi.waitFor(() => {
    expect(pendingRealtimeCalls.some((c) => c.action === action)).toBe(true);
  });
  const idx = pendingRealtimeCalls.findIndex((c) => c.action === action);
  const [call] = pendingRealtimeCalls.splice(idx, 1);
  call.resolve(json);
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  resetState();
  bus.clear();
  vi.clearAllMocks();
  systemAudioGuestMocks.awaitTrustedReceptionBoundary.mockResolvedValue(true);
  standardRoomPrerequisiteMocks.getTurnCredentials.mockReset();
  standardRoomPrerequisiteMocks.getTurnCredentials.mockResolvedValue(null);
  pendingRealtimeCalls = [];
  pcInstances = [];
  resetLocalSystemAudioSfuCapabilities();
  resetGuestSystemAudioShareRoute();
  (globalThis as Record<string, unknown>).RTCPeerConnection = MockRTCPeerConnection;
  installFetchRouting();
});

afterEach(() => {
  resetLocalSystemAudioSfuCapabilities();
  resetGuestSystemAudioShareRoute();
  delete (globalThis as Record<string, unknown>).RTCPeerConnection;
  vi.restoreAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('shared Standard-room TURN configuration', () => {
  it('starts host session allocation while TURN credentials are still pending', async () => {
    let releaseTurn: (() => void) | undefined;
    standardRoomPrerequisiteMocks.getTurnCredentials.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          releaseTurn = () => resolve(null);
        }),
    );
    await loadSfuModuleAsHostWithRemoteGuest();

    bus.emit('system-audio:streams-ready');
    await waitForNewSessionCalls(1);

    expect(standardRoomPrerequisiteMocks.getTurnCredentials).toHaveBeenCalledTimes(1);
    expect(pcInstances).toHaveLength(0);

    releaseTurn?.();
    await resolveRealtime('new-session', {
      sessionId: 'parallel-host-session',
      sessionOwnerToken: 'parallel-host-owner',
    });
    await vi.waitFor(() => expect(pcInstances).toHaveLength(1));

    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
  });

  it('builds the host SFU peer connection from the page-scoped TURN credential owner', async () => {
    standardRoomPrerequisiteMocks.getTurnCredentials.mockResolvedValue({
      provider: 'cloudflare',
      source: '/api/get-turn-config',
      iceServers: [
        {
          urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349'],
          username: 'cached-user',
          credential: 'cached-credential',
        },
      ],
    });
    await loadSfuModuleAsHostWithRemoteGuest();

    bus.emit('system-audio:streams-ready');
    await waitForNewSessionCalls(1);

    expect(standardRoomPrerequisiteMocks.getTurnCredentials).toHaveBeenCalledTimes(1);
    expect(standardRoomPrerequisiteMocks.getTurnCredentials.mock.calls[0]?.[0]).toBeInstanceOf(
      AbortSignal,
    );
    expect(pcInstances[0]?.configuration).toEqual({
      iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
          urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349'],
          username: 'cached-user',
          credential: 'cached-credential',
        },
      ],
      bundlePolicy: 'max-bundle',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/get-turn-config'))).toBe(
      false,
    );

    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
  });

  it('keeps Cloudflare STUN for a guest when the shared TURN owner has no credentials', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');
    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;

    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'host-shared-turn-publication',
        track: { trackName: 'audio-stereo-shared-turn', mid: '0' },
      },
      hostConn,
    );
    await waitForNewSessionCalls(1);

    expect(standardRoomPrerequisiteMocks.getTurnCredentials).toHaveBeenCalledTimes(1);
    expect(standardRoomPrerequisiteMocks.getTurnCredentials.mock.calls[0]?.[0]).toBeInstanceOf(
      AbortSignal,
    );
    expect(pcInstances[0]?.configuration).toEqual({
      iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
      bundlePolicy: 'max-bundle',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/get-turn-config'))).toBe(
      false,
    );

    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
  });
});

describe('single original stereo SFU contract', () => {
  it('publishes the original capture as one 256 kbps track with a stereo client offer', async () => {
    const mod = await loadSfuModuleAsHostWithRemoteGuest();
    bus.emit('system-audio:streams-ready');
    await waitForNewSessionCalls(1);

    const hostPc = pcInstances[pcInstances.length - 1];
    hostPc.createOffer.mockResolvedValueOnce({ type: 'offer', sdp: OPUS_SDP });
    await resolveRealtime('new-session', {
      sessionId: 'single-stereo-host-session',
      sessionOwnerToken: 'single-stereo-host-owner',
    });

    await vi.waitFor(() => {
      expect(pendingRealtimeCalls.some((call) => call.action === 'tracks-new')).toBe(true);
    });
    const tracksNewBody = fetchMock.mock.calls
      .map(([, , init]) => (init?.body ? JSON.parse(String(init.body)) : null))
      .find((body) => body?.action === 'tracks-new');
    expect(tracksNewBody.payload.tracks).toHaveLength(1);
    expect(tracksNewBody.payload.sessionDescription.sdp).toContain('stereo=1');
    expect(tracksNewBody.payload.sessionDescription.sdp).toContain('sprop-stereo=1');
    expect(tracksNewBody.payload.sessionDescription.sdp).toContain('maxaveragebitrate=256000');

    const capture = await import('../../audio/system-capture.ts');
    const capturedStream = vi.mocked(capture.getCapturedAudioStream).mock.results.at(-1)?.value;
    const capturedTrack = capturedStream?.getAudioTracks()[0];
    expect(hostPc.addTransceiver).toHaveBeenCalledTimes(1);
    expect(hostPc.addTransceiver).toHaveBeenCalledWith(capturedTrack, {
      direction: 'sendonly',
      streams: [capturedStream],
    });
    await vi.waitFor(() => {
      expect(hostPc.senderSetParameters).toHaveBeenCalledWith({
        encodings: [{ maxBitrate: 256000 }],
      });
    });

    const trackName = tracksNewBody.payload.tracks[0].trackName as string;
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'answer', sdp: OPUS_STEREO_SDP },
      tracks: [{ trackName, mid: '0' }],
    });
    await vi.waitFor(() => {
      expect(hostPc.setRemoteDescription).toHaveBeenCalledWith({
        type: 'answer',
        sdp: OPUS_STEREO_SDP,
      });
    });

    const { safeSend } = await import('../peer-state.ts');
    await vi.waitFor(() => {
      expect(safeSend).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: MSG.SYSTEM_AUDIO_SFU_READY,
          version: 2,
          track: { trackName, mid: '0' },
        }),
      );
    });

    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
    expect(mod.getSystemAudioSfuDebugSnapshot().host.publishedTrack).toBeNull();
  });

  it('retries the explicit direct-failure marker until a READY frame is sent', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const capture = await import('../../audio/system-capture.ts');
    const fakeStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
    vi.mocked(capture.getCapturedAudioStream).mockReturnValue(fakeStream);
    vi.mocked(capture.isSystemAudioActive).mockReturnValue(true);
    const remote = makeRemotePeer('direct-failure-peer');
    setState('network.appRole', 'host');
    setState('network.connectedPeers', [remote]);
    beginSystemAudioShareDelivery([remote]);
    expect(promoteSystemAudioPeerDeliveryToSfu(remote)).toBe(true);

    const { safeSend } = await import('../peer-state.ts');
    vi.mocked(safeSend).mockReturnValueOnce(false);
    bus.emit('system-audio:sfu-peer-needed', remote.id, 'offer failed');
    await resolveRealtime('new-session', {
      sessionId: 'direct-failure-host-session',
      sessionOwnerToken: 'direct-failure-host-owner',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'answer', sdp: OPUS_STEREO_SDP },
      tracks: [{ trackName: 'audio-stereo-handoff', mid: '0' }],
    });

    await vi.waitFor(() => {
      expect(
        vi
          .mocked(safeSend)
          .mock.calls.filter(
            ([, message]) => (message as { type?: string }).type === MSG.SYSTEM_AUDIO_SFU_READY,
          ),
      ).toHaveLength(1);
    });
    bus.emit('orchestrator:peer-evaluated', remote.id);
    bus.emit('orchestrator:peer-evaluated', remote.id);

    await vi.waitFor(() => {
      expect(
        vi
          .mocked(safeSend)
          .mock.calls.filter(
            ([, message]) => (message as { type?: string }).type === MSG.SYSTEM_AUDIO_SFU_READY,
          ),
      ).toHaveLength(3);
    });
    const readyMessages = vi
      .mocked(safeSend)
      .mock.calls.map(([, message]) => message as Record<string, unknown>)
      .filter((message) => message.type === MSG.SYSTEM_AUDIO_SFU_READY);
    expect(readyMessages).toHaveLength(3);
    expect(readyMessages[0]).toMatchObject({ audience: 'all', handoffFromDirect: true });
    expect(readyMessages[1]).toMatchObject({ audience: 'all', handoffFromDirect: true });
    expect(readyMessages[2]).toMatchObject({ audience: 'all' });
    expect(readyMessages[2]).not.toHaveProperty('handoffFromDirect');

    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
  });

  it('keeps the subscriber offer authoritative and returns a stereo client answer', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');

    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;
    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'single-stereo-publication',
        track: { trackName: 'single-stereo-track', mid: '0' },
      },
      hostConn,
    );
    await waitForNewSessionCalls(1);

    const guestPc = pcInstances[pcInstances.length - 1];
    guestPc.createAnswer.mockResolvedValueOnce({ type: 'answer', sdp: OPUS_SDP });
    await resolveRealtime('new-session', {
      sessionId: 'single-stereo-guest-session',
      sessionOwnerToken: 'single-stereo-guest-owner',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: OPUS_SDP },
      tracks: [{ mid: '0', trackName: 'single-stereo-track' }],
    });

    await vi.waitFor(() => {
      expect(pendingRealtimeCalls.some((call) => call.action === 'renegotiate')).toBe(true);
    });
    expect(guestPc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: OPUS_SDP });
    expect(guestPc.setLocalDescription.mock.calls[0]?.[0]?.sdp).toContain('stereo=1');
    expect(guestPc.setLocalDescription.mock.calls[0]?.[0]?.sdp).toContain('sprop-stereo=1');

    const renegotiateBody = fetchMock.mock.calls
      .map(([, , init]) => (init?.body ? JSON.parse(String(init.body)) : null))
      .find((body) => body?.action === 'renegotiate');
    expect(renegotiateBody.payload.sessionDescription.sdp).toContain('maxaveragebitrate=256000');
    await resolveRealtime('renegotiate', {});

    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.pcState).toBeNull();
  });
});

describe('host publish failure × supersession (F-2403)', () => {
  it('a publish failing AFTER the share stopped must not poison hostSfuUnavailable or emit a stale fallback', async () => {
    const mod = await loadSfuModuleAsHostWithRemoteGuest();
    const fallbackSpy = vi.fn();
    bus.on('system-audio:sfu-fallback', fallbackSpy);

    bus.emit('system-audio:streams-ready');
    await waitForNewSessionCalls(1);

    // Share stopped while new-session is in flight: supersession cleanup
    // bumps the epoch, resets the flag, closes the in-flight pc.
    bus.emit('system-audio:stop');
    expect(pcInstances[0].close).toHaveBeenCalled();

    await rejectAllRealtimeCalls();

    const snapshot = mod.getSystemAudioSfuDebugSnapshot();
    expect(snapshot.host.unavailable).toBe(false);
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('the NEXT share after a stale failure still attempts a real publish', async () => {
    const mod = await loadSfuModuleAsHostWithRemoteGuest();

    bus.emit('system-audio:streams-ready');
    await waitForNewSessionCalls(1);
    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();

    // A restarted share must pass the hostSfuUnavailable gate; otherwise there
    // is no publish attempt or fallback and remote guests wait for the watchdog.
    bus.emit('system-audio:streams-ready');
    await waitForNewSessionCalls(2);

    expect(mod.getSystemAudioSfuDebugSnapshot().host.publishInFlight).toBe(true);
  });

  it('a publish failing in the CURRENT epoch still flags unavailable and emits the fallback (positive control)', async () => {
    const mod = await loadSfuModuleAsHostWithRemoteGuest();
    const fallbackSpy = vi.fn();
    bus.on('system-audio:sfu-fallback', fallbackSpy);

    bus.emit('system-audio:streams-ready');
    await waitForNewSessionCalls(1);
    await rejectAllRealtimeCalls();

    const snapshot = mod.getSystemAudioSfuDebugSnapshot();
    expect(snapshot.host.unavailable).toBe(true);
    expect(fallbackSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a Cloudflare publisher answer that did not negotiate Opus stereo', async () => {
    const mod = await loadSfuModuleAsHostWithRemoteGuest();
    const fallbackSpy = vi.fn();
    bus.on('system-audio:sfu-fallback', fallbackSpy);

    bus.emit('system-audio:streams-ready');
    await resolveRealtime('new-session', {
      sessionId: 'mono-answer-session',
      sessionOwnerToken: 'mono-answer-owner',
    });
    const hostPc = pcInstances[pcInstances.length - 1] as unknown as MockRTCPeerConnection;
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'answer', sdp: OPUS_SDP },
      tracks: [{ trackName: 'audio-stereo', mid: '0' }],
    });

    await vi.waitFor(() => expect(fallbackSpy).toHaveBeenCalledTimes(1));
    expect(hostPc.setRemoteDescription).not.toHaveBeenCalled();
    expect(mod.getSystemAudioSfuDebugSnapshot().host.unavailable).toBe(true);
    await rejectAllRealtimeCalls();
  });

  it('closes accepted host tracks when local SDP adoption fails before publication commit', async () => {
    const mod = await loadSfuModuleAsHostWithRemoteGuest();
    const fallbackSpy = vi.fn();
    bus.on('system-audio:sfu-fallback', fallbackSpy);
    (globalThis as Record<string, unknown>).MediaStream = class {
      constructor(_tracks?: unknown) {}
    };

    bus.emit('system-audio:streams-ready');
    await resolveRealtime('new-session', {
      sessionId: 'orphan-host-session',
      sessionOwnerToken: 'orphan-host-owner',
    });
    const hostPc = pcInstances[pcInstances.length - 1] as unknown as MockRTCPeerConnection;
    hostPc.setRemoteDescription.mockRejectedValueOnce(new Error('LOCAL_SDP_REJECTED'));
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'answer', sdp: OPUS_STEREO_SDP },
      tracks: [{ trackName: 'audio-stereo', mid: '0' }],
    });

    await vi.waitFor(() => {
      const closeBody = fetchMock.mock.calls
        .map(([, , init]) => (init?.body ? JSON.parse(String(init.body)) : null))
        .find((body) => body?.action === 'tracks-close');
      expect(closeBody).toMatchObject({
        sessionId: 'orphan-host-session',
        sessionOwnerToken: 'orphan-host-owner',
        payload: { tracks: [{ mid: '0' }], force: true },
      });
    });
    expect(fallbackSpy).toHaveBeenCalledTimes(1);
    expect(mod.getSystemAudioSfuDebugSnapshot().host.unavailable).toBe(true);
    await resolveRealtime('tracks-close', {});
  });
});

describe('host SFU runtime connection failure (F-2403)', () => {
  async function publishHostSuccessfully(mod: typeof import('../system-audio-sfu.ts')) {
    bus.emit('system-audio:streams-ready');
    await resolveRealtime('new-session', {
      sessionId: 'host-sess-1',
      sessionOwnerToken: 'host-owner-token',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'answer', sdp: OPUS_STEREO_SDP },
      tracks: [{ trackName: 'audio-stereo', mid: '0' }],
    });
    await vi.waitFor(() => {
      expect(mod.getSystemAudioSfuDebugSnapshot().host.sessionId).toBe('host-sess-1');
    });
    const tracksNewBody = fetchMock.mock.calls
      .map(([, , init]) => (init?.body ? JSON.parse(String(init.body)) : null))
      .find((body) => body?.action === 'tracks-new');
    expect(tracksNewBody).toMatchObject({
      sessionId: 'host-sess-1',
      sessionOwnerToken: 'host-owner-token',
    });
    const { safeSend } = await import('../peer-state.ts');
    const readyMessage = vi
      .mocked(safeSend)
      .mock.calls.map(([, message]) => message as Record<string, unknown>)
      .find((message) => message.type === MSG.SYSTEM_AUDIO_SFU_READY);
    expect(readyMessage).toMatchObject({ sessionId: 'host-sess-1' });
    expect(readyMessage).not.toHaveProperty('sessionOwnerToken');
  }

  it('a runtime failed connection degrades to fallback and does NOT republish (no storm)', async () => {
    const mod = await loadSfuModuleAsHostWithRemoteGuest();
    const fallbackSpy = vi.fn();
    bus.on('system-audio:sfu-fallback', fallbackSpy);

    await publishHostSuccessfully(mod);
    const hostPc = pcInstances[pcInstances.length - 1] as unknown as MockRTCPeerConnection;

    // Runtime transport death AFTER a healthy publish (distinct from the
    // publish-time throw path already covered above).
    hostPc.connectionState = 'failed';
    hostPc._emit('connectionstatechange');

    expect(fallbackSpy).toHaveBeenCalledTimes(1);
    const snap = mod.getSystemAudioSfuDebugSnapshot();
    expect(snap.host.unavailable).toBe(true);
    expect(snap.host.sessionId).toBeNull();
    const closeBody = fetchMock.mock.calls
      .map(([, , init]) => (init?.body ? JSON.parse(String(init.body)) : null))
      .find((body) => body?.action === 'tracks-close');
    expect(closeBody).toMatchObject({
      sessionId: 'host-sess-1',
      sessionOwnerToken: 'host-owner-token',
      payload: { tracks: [{ mid: '0' }], force: true },
    });
    await resolveRealtime('tracks-close', {});

    // The hostSfuUnavailable gate must suppress a republish — no new session,
    // no re-subscribe storm.
    const before = countNewSessionCalls();
    bus.emit('system-audio:streams-ready');
    await new Promise((r) => setTimeout(r, 0));
    expect(countNewSessionCalls()).toBe(before);
  });

  it('a failed event from a SUPERSEDED host pc leaves the live state untouched', async () => {
    const mod = await loadSfuModuleAsHostWithRemoteGuest();
    await publishHostSuccessfully(mod);
    const stalePc = pcInstances[pcInstances.length - 1] as unknown as MockRTCPeerConnection;

    // Supersede: stop nulls hostPc (cleanupHostSfu, epoch bump, flag reset).
    bus.emit('system-audio:stop');

    const fallbackSpy = vi.fn();
    bus.on('system-audio:sfu-fallback', fallbackSpy);
    stalePc.connectionState = 'failed';
    stalePc._emit('connectionstatechange');

    // hostPc !== stalePc → the guard returns: no fallback, flag untouched.
    expect(fallbackSpy).not.toHaveBeenCalled();
    expect(mod.getSystemAudioSfuDebugSnapshot().host.unavailable).toBe(false);
  });
});

describe('bounded large-room SFU failure policy', () => {
  const retryTimerCalls = () =>
    vi
      .mocked(setManagedTimer)
      .mock.calls.filter(([name]) => name === 'system-audio-sfu-host-retry');

  async function loadSfuModuleWithCapableLocalGuests(count = 9) {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');

    const capture = await import('../../audio/system-capture.ts');
    const fakeStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
    vi.mocked(capture.getCapturedAudioStream).mockReturnValue(fakeStream);
    vi.mocked(capture.isSystemAudioActive).mockReturnValue(true);

    const peers = Array.from({ length: count }, (_, index) => makeLocalPeer(`local-${index + 1}`));
    peers.forEach((peer) => markLocalSystemAudioSfuCapable(peer.id));
    setState('network.appRole', 'host');
    setState('network.connectedPeers', peers);
    return { mod, peers };
  }

  it('waits for its one bounded retry before stopping large-room SFU targets', async () => {
    const { peers } = await loadSfuModuleWithCapableLocalGuests();
    const { safeSend } = await import('../peer-state.ts');

    bus.emit('system-audio:streams-ready');
    await waitForNewSessionCalls(1);
    await rejectAllRealtimeCalls();

    expect(retryTimerCalls()).toHaveLength(1);
    const callsAfterInitialFailure = countNewSessionCalls();
    bus.emit('system-audio:streams-ready');
    expect(countNewSessionCalls()).toBe(callsAfterInitialFailure);
    bus.emit('orchestrator:peer-evaluated', peers[0].id);
    expect(
      vi
        .mocked(safeSend)
        .mock.calls.some(
          ([, message]) => (message as { type?: string }).type === MSG.SYSTEM_AUDIO_STOP,
        ),
    ).toBe(false);

    const retry = retryTimerCalls()[0]?.[1] as (() => void) | undefined;
    expect(retry).toBeTypeOf('function');
    retry!();
    await waitForNewSessionCalls(callsAfterInitialFailure + 1);
    await rejectAllRealtimeCalls();

    const stoppedConnections = vi
      .mocked(safeSend)
      .mock.calls.filter(
        ([, message]) => (message as { type?: string }).type === MSG.SYSTEM_AUDIO_STOP,
      )
      .map(([conn]) => conn);
    expect(stoppedConnections).toHaveLength(peers.length);
    expect(stoppedConnections).toEqual(expect.arrayContaining(peers.map((peer) => peer.conn)));
    expect(retryTimerCalls()).toHaveLength(1);
  });

  it('keeps all-audience retry policy when ICE later relabels every peer as remote', async () => {
    const { mod, peers } = await loadSfuModuleWithCapableLocalGuests();

    bus.emit('system-audio:streams-ready');
    await waitForNewSessionCalls(1);
    setState(
      'network.connectedPeers',
      peers.map((peer) => ({ ...peer, connectionType: 'remote' as const })),
    );
    await rejectAllRealtimeCalls();

    expect(mod.getSystemAudioSfuDebugSnapshot().host.delivery.sfuAudiences).toEqual(
      Object.fromEntries(peers.map((peer) => [peer.id, 'all'])),
    );
    expect(retryTimerCalls()).toHaveLength(1);
  });

  it('keeps eight remote fallback calls alive and stops only overflow SFU waiters', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const capture = await import('../../audio/system-capture.ts');
    const fakeStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
    vi.mocked(capture.getCapturedAudioStream).mockReturnValue(fakeStream);
    vi.mocked(capture.isSystemAudioActive).mockReturnValue(true);
    const peers = Array.from({ length: 9 }, (_, index) => makeRemotePeer(`remote-${index + 1}`));
    setState('network.appRole', 'host');
    setState('network.connectedPeers', peers);
    bus.on('system-audio:sfu-fallback', () => {
      peers.slice(0, 8).forEach((peer) => reserveSystemAudioFallbackDirect(peer.id));
    });
    const { safeSend } = await import('../peer-state.ts');

    bus.emit('system-audio:streams-ready');
    await waitForNewSessionCalls(1);
    await rejectAllRealtimeCalls();

    const stoppedConnections = vi
      .mocked(safeSend)
      .mock.calls.filter(
        ([, message]) => (message as { type?: string }).type === MSG.SYSTEM_AUDIO_STOP,
      )
      .map(([conn]) => conn);
    expect(stoppedConnections).toEqual([peers[8].conn]);
    expect(retryTimerCalls()).toHaveLength(0);
  });

  it('retries once for a late capable LAN guest without republishing to frozen remote fallbacks', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const capture = await import('../../audio/system-capture.ts');
    const fakeStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
    vi.mocked(capture.getCapturedAudioStream).mockReturnValue(fakeStream);
    vi.mocked(capture.isSystemAudioActive).mockReturnValue(true);
    const remotePeers = Array.from({ length: 9 }, (_, index) =>
      makeRemotePeer(`remote-${index + 1}`),
    );
    setState('network.appRole', 'host');
    setState('network.connectedPeers', remotePeers);
    bus.on('system-audio:sfu-fallback', () => {
      remotePeers.forEach((peer) => reserveSystemAudioFallbackDirect(peer.id));
    });

    bus.emit('system-audio:streams-ready');
    await waitForNewSessionCalls(1);
    await rejectAllRealtimeCalls();

    const localPeer = makeLocalPeer('late-local');
    markLocalSystemAudioSfuCapable(localPeer.id);
    setState('network.connectedPeers', [...remotePeers, localPeer]);
    (globalThis as Record<string, unknown>).MediaStream = class {
      constructor(_tracks?: unknown) {}
    };

    bus.emit('orchestrator:peer-joined', localPeer.id);
    await waitForNewSessionCalls(2);
    await resolveRealtime('new-session', {
      sessionId: 'late-local-publication',
      sessionOwnerToken: 'late-local-owner',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'answer', sdp: OPUS_STEREO_SDP },
      tracks: [{ trackName: 'audio-stereo', mid: '0' }],
    });

    const { safeSend } = await import('../peer-state.ts');
    await vi.waitFor(() => {
      const readyCalls = vi
        .mocked(safeSend)
        .mock.calls.filter(
          ([, message]) => (message as { type?: string }).type === MSG.SYSTEM_AUDIO_SFU_READY,
        );
      expect(readyCalls).toHaveLength(1);
      expect(readyCalls[0]?.[0]).toBe(localPeer.conn);
    });
    expect(retryTimerCalls()).toHaveLength(0);
  });

  it('uses the same bounded retry when LAN capability arrives after the peer event', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const capture = await import('../../audio/system-capture.ts');
    const fakeStream = { getAudioTracks: () => [{ kind: 'audio' }] } as unknown as MediaStream;
    vi.mocked(capture.getCapturedAudioStream).mockReturnValue(fakeStream);
    vi.mocked(capture.isSystemAudioActive).mockReturnValue(true);
    const remotePeers = Array.from({ length: 9 }, (_, index) =>
      makeRemotePeer(`remote-${index + 1}`),
    );
    setState('network.appRole', 'host');
    setState('network.connectedPeers', remotePeers);
    bus.on('system-audio:sfu-fallback', () => {
      remotePeers.forEach((peer) => reserveSystemAudioFallbackDirect(peer.id));
    });

    bus.emit('system-audio:streams-ready');
    await waitForNewSessionCalls(1);
    await rejectAllRealtimeCalls();

    const localPeer = makeLocalPeer('capability-late-local');
    setState('network.connectedPeers', [...remotePeers, localPeer]);
    setState(
      'network.activeHostConnByPeerId',
      new Map([[localPeer.id, localPeer.conn as DataConnection]]),
    );
    const { registerHandler } = await import('../protocol.ts');
    const capabilityHandler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_CAPABILITY)?.[1] as
      | ((data: unknown, conn?: DataConnection) => void)
      | undefined;
    expect(capabilityHandler).toBeDefined();

    capabilityHandler!({ version: 2, localAudience: true }, localPeer.conn as DataConnection);
    await waitForNewSessionCalls(2);
    await rejectAllRealtimeCalls();

    const { safeSend } = await import('../peer-state.ts');
    expect(
      vi
        .mocked(safeSend)
        .mock.calls.filter(
          ([, message]) => (message as { type?: string }).type === MSG.SYSTEM_AUDIO_START,
        )
        .map(([conn]) => conn),
    ).toEqual([localPeer.conn]);
    const stoppedConnections = vi
      .mocked(safeSend)
      .mock.calls.filter(
        ([, message]) => (message as { type?: string }).type === MSG.SYSTEM_AUDIO_STOP,
      )
      .map(([conn]) => conn);
    expect(stoppedConnections).toContain(localPeer.conn);
    expect(stoppedConnections.at(-1)).toBe(localPeer.conn);
  });
});

describe('guest SFU teardown and successor ownership (F-2402)', () => {
  it.each(['closed', 'failed'])(
    'ignores a retired guest PC %s event while preserving current failure cleanup',
    async (retiredState) => {
      const mod = await import('../system-audio-sfu.ts');
      mod.registerSystemAudioSfuListeners();
      bus.emit('system-audio:stop');
      const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
      setState('network.appRole', 'guest');
      setState('network.hostConn', hostConn);
      setState('network.connectionType', 'remote');
      const { registerHandler } = await import('../protocol.ts');
      const handler = vi
        .mocked(registerHandler)
        .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
        | ((data: unknown, conn?: DataConnection) => void)
        | undefined;
      expect(handler).toBeDefined();

      handler!(
        {
          version: 2,
          audience: 'remote',
          sessionId: 'retired-host-publication',
          track: { trackName: 'retired-host-track', mid: '0' },
        },
        hostConn,
      );
      await waitForNewSessionCalls(1);
      const retiredPc = pcInstances[0];
      bus.emit('system-audio:stop');
      handler!(
        {
          version: 2,
          audience: 'remote',
          sessionId: 'successor-host-publication',
          track: { trackName: 'successor-host-track', mid: '0' },
        },
        hostConn,
      );
      await waitForNewSessionCalls(2);
      const currentPc = pcInstances[1];
      const currentSignal = fetchMock.mock.calls.at(-1)?.[2]?.signal;
      const currentState = mod.getSystemAudioSfuDebugSnapshot().guest;
      expect(currentPc.close).not.toHaveBeenCalled();
      expect(currentSignal?.aborted).toBe(false);
      expect(currentState.connectInFlight).toBe(true);

      retiredPc.connectionState = retiredState;
      retiredPc._emit('connectionstatechange');
      expect(currentPc.close).not.toHaveBeenCalled();
      expect(currentSignal?.aborted).toBe(false);
      expect(mod.getSystemAudioSfuDebugSnapshot().guest).toEqual(currentState);

      currentPc.connectionState = 'failed';
      currentPc._emit('connectionstatechange');
      expect(currentPc.close).toHaveBeenCalledOnce();
      expect(currentSignal?.aborted).toBe(true);
      expect(mod.getSystemAudioSfuDebugSnapshot().guest).toMatchObject({
        pcState: null,
        subscriptionKey: null,
        connectInFlight: false,
      });
    },
  );

  it('does not let a late guest session response resurrect a stopped subscription', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');
    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;

    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'stopped-host-publication',
        track: { trackName: 'stopped-host-track', mid: '0' },
      },
      hostConn,
    );
    await waitForNewSessionCalls(1);
    const stalePc = pcInstances[0];

    bus.emit('system-audio:stop');
    expect(stalePc.close).toHaveBeenCalled();
    await resolveRealtime('new-session', {
      sessionId: 'late-stopped-guest-session',
      sessionOwnerToken: 'late-stopped-guest-owner',
    });
    await Promise.resolve();

    expect(pendingRealtimeCalls.some((call) => call.action === 'tracks-new')).toBe(false);
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.sessionId).toBeNull();
  });

  it('does not abort the successor request while replacing the previous guest subscription', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');

    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;
    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'host-successor-publication',
        track: { trackName: 'audio-stereo-successor', mid: '0' },
      },
      hostConn,
    );

    await waitForNewSessionCalls(1);
    const request = fetchMock.mock.calls.find(
      ([url, , init]) =>
        String(url).includes('cloudflare-realtime') &&
        init?.body &&
        (JSON.parse(String(init.body)) as { action: string }).action === 'new-session',
    );
    expect(request?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect((request?.[2]?.signal as AbortSignal).aborted).toBe(false);
    bus.emit('system-audio:stop');
    expect((request?.[2]?.signal as AbortSignal).aborted).toBe(true);
  });

  it('closes exact guest mids returned by a failed partial tracks-new response', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');

    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;
    expect(handler).toBeDefined();

    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'host-partial-publication',
        track: { trackName: 'audio-stereo-partial', mid: '0' },
      },
      hostConn,
    );
    await resolveRealtime('new-session', {
      sessionId: 'guest-partial-session',
      sessionOwnerToken: 'guest-partial-owner',
    });
    await resolveRealtime('tracks-new', {
      errorCode: 'TRACKS_PARTIAL',
      errorDescription: 'one track was allocated before failure',
      tracks: [{ mid: 'allocated-mid-0', trackName: 'audio-stereo-partial' }],
    });

    await vi.waitFor(() => {
      const closeBody = fetchMock.mock.calls
        .map(([, , init]) => (init?.body ? JSON.parse(String(init.body)) : null))
        .find((body) => body?.action === 'tracks-close');
      expect(closeBody).toMatchObject({
        sessionId: 'guest-partial-session',
        sessionOwnerToken: 'guest-partial-owner',
        payload: { tracks: [{ mid: 'allocated-mid-0' }], force: true },
      });
    });
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.pcState).toBeNull();
    await resolveRealtime('tracks-close', {});
  });

  it('freezes a direct fallback route against queued and delayed SFU_READY until the next START', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');

    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;
    expect(handler).toBeDefined();

    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'host-publication-before-fallback',
        track: { trackName: 'audio-stereo-before-fallback', mid: '0' },
      },
      hostConn,
    );
    await waitForNewSessionCalls(1);
    const deliveryHandoff = vi.fn();
    bus.on('system-audio:delivery-handoff', deliveryHandoff);
    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'queued-host-publication',
        track: { trackName: 'queued-audio-stereo', mid: '0' },
      },
      hostConn,
    );

    // The direct fallback wins while the first subscribe is in flight. This
    // must cancel that attempt and discard its queued successor.
    bus.emit('system-audio:incoming-call', {} as never, 'STEREO');
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.directRouteFrozen).toBe(true);
    expect(deliveryHandoff).toHaveBeenCalledTimes(1);
    await resolveRealtime('new-session', {
      sessionId: 'superseded-guest-session',
      sessionOwnerToken: 'superseded-guest-owner',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(countNewSessionCalls()).toBe(1);

    // A late READY from the failed SFU publication remains ignored for this
    // share, so direct and SFU audio cannot play together.
    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'late-host-publication',
        track: { trackName: 'late-audio-stereo', mid: '0' },
      },
      hostConn,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(countNewSessionCalls()).toBe(1);

    // The next authenticated START is the route-reset boundary.
    bus.emit('system-audio:host-started');
    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'next-share-publication',
        track: { trackName: 'next-share-audio-stereo', mid: '0' },
      },
      hostConn,
    );
    await waitForNewSessionCalls(2);
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.directRouteFrozen).toBe(false);

    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
  });

  it('accepts an authenticated explicit direct-to-SFU failure handoff without overlapping routes', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    // The host can still see this peer as unknown/remote while the guest has
    // already proved the LAN path. An explicit failed-direct handoff remains
    // authoritative in that short classification gap.
    setState('network.connectionType', 'local');
    setState('player.currentTrackMeta', {
      type: 'file',
      name: 'system-audio-receiving',
      systemAudioMode: 'receiving',
      systemAudioSurface: 'window',
    });

    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;
    expect(handler).toBeDefined();

    bus.emit('system-audio:incoming-call', {} as never, 'STEREO');
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.directRouteFrozen).toBe(true);

    handler!(
      {
        version: 2,
        audience: 'remote',
        handoffFromDirect: true,
        sessionId: 'direct-failure-publication',
        track: { trackName: 'audio-stereo-handoff', mid: '0' },
      },
      hostConn,
    );

    expect(systemAudioGuestMocks.cleanupGuestSystemAudio).toHaveBeenCalledTimes(1);
    expect(systemAudioGuestMocks.beginTrustedReception).toHaveBeenCalledWith('window');
    await waitForNewSessionCalls(1);
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.directRouteFrozen).toBe(false);
    bus.emit('system-audio:incoming-call', {} as never, 'STEREO');
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.directRouteFrozen).toBe(false);
    expect(countNewSessionCalls()).toBe(1);

    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
  });

  it('hands a queued retry READY forward when the first guest subscribe fails', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');
    const handoff = vi.fn();
    bus.on('system-audio:delivery-handoff', handoff);

    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;
    expect(handler).toBeDefined();

    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'failed-host-publication',
        track: { trackName: 'failed-audio-stereo', mid: '0' },
      },
      hostConn,
    );
    await waitForNewSessionCalls(1);
    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'retry-host-publication',
        track: { trackName: 'retry-audio-stereo', mid: '0' },
      },
      hostConn,
    );

    await resolveRealtime('new-session', {
      sessionId: 'failed-guest-session',
      sessionOwnerToken: 'failed-guest-owner',
    });
    await resolveRealtime('tracks-new', {
      errorCode: 'FIRST_SUBSCRIBE_FAILED',
      tracks: [{ mid: 'failed-mid', trackName: 'failed-audio-stereo' }],
    });

    await waitForNewSessionCalls(2);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.subscriptionKey).toContain(
      'retry-host-publication',
    );
    const closeBody = fetchMock.mock.calls
      .map(([, , init]) => (init?.body ? JSON.parse(String(init.body)) : null))
      .find((body) => body?.action === 'tracks-close');
    expect(closeBody).toMatchObject({
      sessionId: 'failed-guest-session',
      sessionOwnerToken: 'failed-guest-owner',
      payload: { tracks: [{ mid: 'failed-mid' }], force: true },
    });

    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
  });

  it('freezes all-audience SFU while RTC config and the guest session start concurrently', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'local');

    let releaseTurn: (() => void) | undefined;
    standardRoomPrerequisiteMocks.getTurnCredentials.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          releaseTurn = () => resolve(null);
        }),
    );
    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;

    handler!(
      {
        version: 2,
        audience: 'all',
        sessionId: 'all-audience-await',
        track: { trackName: 'all-await-stereo', mid: '0' },
      },
      hostConn,
    );
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.shareRoute).toBe('sfu-all');

    bus.emit('system-audio:incoming-call', {} as never, 'STEREO');
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.shareRoute).toBe('sfu-all');
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.directRouteFrozen).toBe(false);
    expect(standardRoomPrerequisiteMocks.getTurnCredentials).toHaveBeenCalledTimes(1);
    // Session allocation is independent of TURN and now overlaps that wait.
    expect(countNewSessionCalls()).toBe(1);

    releaseTurn?.();
    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
  });

  it('queues a successor publication instead of dropping READY while the first subscribe is in flight', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');
    const engine = await import('../../audio/engine.ts');
    vi.mocked(engine.initAudio).mockResolvedValue(undefined);
    vi.mocked(engine.getWidener).mockReturnValue(null);

    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;
    expect(handler).toBeDefined();

    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'host-publication-1',
        track: { trackName: 'audio-stereo-1', mid: '0' },
      },
      hostConn,
    );
    await waitForNewSessionCalls(1);
    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'host-publication-2',
        track: { trackName: 'audio-stereo-2', mid: '0' },
      },
      hostConn,
    );

    await resolveRealtime('new-session', {
      sessionId: 'guest-publication-1',
      sessionOwnerToken: 'guest-owner-1',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: 'o' },
      tracks: [{ mid: '0', trackName: 'audio-stereo-1' }],
    });
    await resolveRealtime('renegotiate', {});

    await waitForNewSessionCalls(2);
    await vi.waitFor(() => {
      expect(mod.getSystemAudioSfuDebugSnapshot().guest.subscriptionKey).toContain(
        'host-publication-2',
      );
    });
    const closeBody = fetchMock.mock.calls
      .map(([, , init]) => (init?.body ? JSON.parse(String(init.body)) : null))
      .find((body) => body?.action === 'tracks-close');
    expect(closeBody).toMatchObject({
      sessionId: 'guest-publication-1',
      sessionOwnerToken: 'guest-owner-1',
      payload: { tracks: [{ mid: '0' }], force: true },
    });

    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
  });

  it('a host stop during connectGuestTrack must not resurrect a torn-down receive', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop'); // clean baseline

    // Guest with a remote host connection (not local → subscribe is allowed).
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');

    // Make the audio graph "ready" so that WITHOUT the recheck connectGuestTrack
    // would recreate the source + flip receiving=true (the resurrection this
    // guards), so it must return before touching any of this.
    const engine = await import('../../audio/engine.ts');
    const ctxMod = await import('../../audio/context.ts');
    vi.mocked(engine.getWidener).mockReturnValue({ input: {} } as never);
    vi.mocked(ctxMod.getAudioContext).mockReturnValue({
      state: 'running',
      createChannelMerger: vi.fn(() => ({ connect: vi.fn() })),
      createMediaStreamSource: vi.fn(() => ({ connect: vi.fn() })),
    } as never);
    (globalThis as Record<string, unknown>).MediaStream = class {
      constructor(_tracks?: unknown) {}
    };

    // Hold connectGuestTrack at its initAudio await so we can tear down mid-flight.
    let releaseInit: () => void = () => {};
    vi.mocked(engine.initAudio).mockImplementation(
      () => new Promise<void>((resolve) => (releaseInit = () => resolve())),
    );

    // registerHandler is mocked → capture the SFU-ready handler it registered.
    const { registerHandler } = await import('../protocol.ts');
    const sfuReadyHandler = vi
      .mocked(registerHandler)
      .mock.calls.find((c) => c[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;
    expect(sfuReadyHandler).toBeDefined();

    sfuReadyHandler!(
      {
        version: 2,
        sessionId: 'host-sess',
        track: { trackName: 'audio-stereo', mid: '0' },
      },
      hostConn,
    );

    await resolveRealtime('new-session', {
      sessionId: 'guest-sess',
      sessionOwnerToken: 'guest-owner-token',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: 'o' },
      tracks: [{ mid: '0', trackName: 'audio-stereo' }],
    });
    await resolveRealtime('renegotiate', {});

    const guestSessionCalls = fetchMock.mock.calls
      .map(([, , init]) => (init?.body ? JSON.parse(String(init.body)) : null))
      .filter((body) => body?.action === 'tracks-new' || body?.action === 'renegotiate');
    expect(guestSessionCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'tracks-new',
          sessionId: 'guest-sess',
          sessionOwnerToken: 'guest-owner-token',
        }),
        expect.objectContaining({
          action: 'renegotiate',
          sessionId: 'guest-sess',
          sessionOwnerToken: 'guest-owner-token',
        }),
      ]),
    );

    // connectGuestTrack is now parked at await initAudio with guestPc set.
    await vi.waitFor(() => {
      expect(mod.getSystemAudioSfuDebugSnapshot().guest.pcState).not.toBeNull();
    });

    // Host stop nulls guestPc while connectGuestTrack is parked at initAudio.
    bus.emit('system-audio:host-stopped');
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.pcState).toBeNull();
    await vi.waitFor(() => {
      const closeBody = fetchMock.mock.calls
        .map(([, , init]) => (init?.body ? JSON.parse(String(init.body)) : null))
        .find((body) => body?.action === 'tracks-close');
      expect(closeBody).toMatchObject({
        sessionId: 'guest-sess',
        sessionOwnerToken: 'guest-owner-token',
        payload: { tracks: [{ mid: '0' }], force: true },
      });
    });
    await resolveRealtime('tracks-close', {});

    // Release initAudio: the recheck must bail before recreating anything.
    releaseInit();
    await new Promise((r) => setTimeout(r, 0));

    const guest = mod.getSystemAudioSfuDebugSnapshot().guest;
    expect(guest.receiving).toBe(false);
    expect(guest.sourceStereo).toBe(false);

    delete (globalThis as Record<string, unknown>).MediaStream;
  });

  it('does not attach an SFU track before the trusted owner-switch boundary settles', async () => {
    const trustedBoundary = (() => {
      let resolve!: (ready: boolean) => void;
      const promise = new Promise<boolean>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    systemAudioGuestMocks.awaitTrustedReceptionBoundary.mockReturnValueOnce(
      trustedBoundary.promise,
    );

    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');

    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');

    const engine = await import('../../audio/engine.ts');
    vi.mocked(engine.initAudio).mockResolvedValue(undefined);

    const { registerHandler } = await import('../protocol.ts');
    const sfuReadyHandler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;
    expect(sfuReadyHandler).toBeDefined();

    sfuReadyHandler!(
      {
        version: 2,
        sessionId: 'trusted-boundary-host-session',
        track: { trackName: 'audio-stereo', mid: '0' },
      },
      hostConn,
    );
    await resolveRealtime('new-session', {
      sessionId: 'trusted-boundary-guest-session',
      sessionOwnerToken: 'trusted-boundary-owner-token',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: 'o' },
      tracks: [{ mid: '0', trackName: 'audio-stereo' }],
    });
    await resolveRealtime('renegotiate', {});

    await vi.waitFor(() => {
      expect(systemAudioGuestMocks.awaitTrustedReceptionBoundary).toHaveBeenCalledWith(
        'sfu-stereo',
      );
    });
    expect(engine.initAudio).not.toHaveBeenCalled();

    trustedBoundary.resolve(true);
    await vi.waitFor(() => {
      expect(engine.initAudio).toHaveBeenCalledTimes(1);
    });

    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
  });
});

describe('LAN SFU audience negotiation', () => {
  it('does not inherit local SFU capability across exact-connection replacement', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    setState('network.appRole', 'host');
    const replaced = makeRemotePeer('replaced-peer');
    setState('network.connectedPeers', [replaced]);
    beginSystemAudioShareDelivery([replaced]);
    expect(promoteSystemAudioPeerDeliveryToSfu(replaced)).toBe(true);
    markLocalSystemAudioSfuCapable('replaced-peer');
    expect(getSystemAudioShareDeliverySnapshot().capablePeerIds).toContain('replaced-peer');
    expect(isSystemAudioDirectFailurePeer('replaced-peer')).toBe(true);

    bus.emit('network:peer-connection-replaced', 'replaced-peer');

    expect(getSystemAudioShareDeliverySnapshot().capablePeerIds).not.toContain('replaced-peer');
    expect(isSystemAudioDirectFailurePeer('replaced-peer')).toBe(false);
    expect(getSystemAudioShareDeliverySnapshot().sfuPeerIds).not.toContain('replaced-peer');
  });

  it('advertises local-audience support when a guest data connection opens', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);

    bus.emit('network:peer-connected', hostConn);

    const { safeSend } = await import('../peer-state.ts');
    expect(safeSend).toHaveBeenCalledWith(hostConn, {
      type: MSG.SYSTEM_AUDIO_SFU_CAPABILITY,
      version: 2,
      localAudience: true,
    });
  });

  it('accepts only an explicit all-audience publication while classified local', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'local');

    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;
    expect(handler).toBeDefined();

    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'remote-only',
        track: { trackName: 'audio-stereo', mid: '0' },
      },
      hostConn,
    );
    expect(countNewSessionCalls()).toBe(0);

    handler!(
      {
        version: 2,
        audience: 'all',
        sessionId: 'all-audience',
        track: { trackName: 'audio-stereo', mid: '0' },
      },
      hostConn,
    );
    await waitForNewSessionCalls(1);
    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
  });

  it('keeps an accepted SFU route frozen when ICE later relabels the guest as local', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'remote');
    const engine = await import('../../audio/engine.ts');
    vi.mocked(engine.initAudio).mockResolvedValue(undefined);
    vi.mocked(engine.getWidener).mockReturnValue(null);

    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;
    handler!(
      {
        version: 2,
        audience: 'remote',
        sessionId: 'frozen-host-publication',
        track: { trackName: 'frozen-audio-stereo', mid: '0' },
      },
      hostConn,
    );
    await resolveRealtime('new-session', {
      sessionId: 'frozen-guest-session',
      sessionOwnerToken: 'frozen-guest-owner',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: 'o' },
      tracks: [{ mid: '0', trackName: 'frozen-audio-stereo' }],
    });
    await resolveRealtime('renegotiate', {});
    await vi.waitFor(() => {
      expect(mod.getSystemAudioSfuDebugSnapshot().guest.pcState).not.toBeNull();
    });

    setState('network.connectionType', 'local');
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.pcState).not.toBeNull();

    bus.emit('system-audio:stop');
    await resolveRealtime('tracks-close', {});
  });
});

describe('guest SFU receive limit', () => {
  it.each(['unchanged', 'failed receiver', 'new publication', 'new host connection'])(
    'keeps the receiver and its original limit on duplicate READY, then handles %s',
    async (next) => {
      const mod = await import('../system-audio-sfu.ts');
      mod.registerSystemAudioSfuListeners();
      bus.emit('system-audio:stop');
      const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
      setState('network.appRole', 'guest');
      setState('network.hostConn', hostConn);
      setState('network.connectionType', 'remote');
      const engine = await import('../../audio/engine.ts');
      const ctxMod = await import('../../audio/context.ts');
      const source = { connect: vi.fn(), disconnect: vi.fn() };
      vi.mocked(engine.getWidener).mockReturnValue({ input: {} } as never);
      vi.mocked(ctxMod.getAudioContext).mockReturnValue({
        state: 'running',
        createMediaStreamSource: vi.fn(() => source),
      } as never);
      (globalThis as Record<string, unknown>).MediaStream = class {
        constructor(_tracks?: unknown) {}
      };
      const { registerHandler } = await import('../protocol.ts');
      const handler = vi
        .mocked(registerHandler)
        .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)![1];
      const ready = {
        type: MSG.SYSTEM_AUDIO_SFU_READY,
        version: 2 as const,
        audience: 'remote' as const,
        sessionId: 'stable-host-publication',
        track: { trackName: 'stable-audio', mid: '0' },
      };
      await handler(ready, hostConn);
      await resolveRealtime('new-session', {
        sessionId: 'stable-guest-session',
        sessionOwnerToken: 'stable-guest-owner',
      });
      await resolveRealtime('tracks-new', {
        sessionDescription: { type: 'offer', sdp: 'o' },
        tracks: [{ mid: '0', trackName: 'stable-audio' }],
      });
      await resolveRealtime('renegotiate', {});
      await vi.waitFor(() => {
        expect(mod.getSystemAudioSfuDebugSnapshot().guest.receiving).toBe(true);
      });
      // Let the successful subscribe promise settle before the host's next
      // peer-evaluated announcement of its unchanged publication.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const receivingPc = pcInstances[0];
      await handler(ready, hostConn);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(countNewSessionCalls()).toBe(1);
      expect(receivingPc.close).not.toHaveBeenCalled();
      expect(source.disconnect).not.toHaveBeenCalled();
      expect(mod.getSystemAudioSfuDebugSnapshot().guest.receiving).toBe(true);
      expect(
        vi
          .mocked(setManagedTimer)
          .mock.calls.filter(([name]) => name === 'system-audio-sfu-guest-limit'),
      ).toHaveLength(1);
      if (next !== 'unchanged') {
        let nextHost = hostConn;
        let nextReady = ready;
        if (next === 'failed receiver') {
          receivingPc.connectionState = 'failed';
          receivingPc._emit('connectionstatechange');
        } else if (next === 'new publication') {
          nextReady = { ...ready, sessionId: 'next-host-publication' };
        } else {
          nextHost = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
          setState('network.hostConn', nextHost);
          await handler(ready, hostConn);
          expect(countNewSessionCalls()).toBe(1);
        }
        await handler(nextReady, nextHost);
        await waitForNewSessionCalls(2);
        expect(receivingPc.close).toHaveBeenCalled();
      }
      bus.emit('system-audio:stop');
      await rejectAllRealtimeCalls();
    },
  );

  it('limits local-overflow SFU reception and blocks the same host connection until rejoin', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');

    const firstHostConn = {
      open: true,
      send: vi.fn(),
      peer: 'host-first',
    } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', firstHostConn);
    setState('network.connectionType', 'local');

    const engine = await import('../../audio/engine.ts');
    const ctxMod = await import('../../audio/context.ts');
    vi.mocked(engine.getWidener).mockReturnValue({ input: {} } as never);
    vi.mocked(ctxMod.getAudioContext).mockReturnValue({
      state: 'running',
      createChannelMerger: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
      createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    } as never);
    (globalThis as Record<string, unknown>).MediaStream = class {
      constructor(_tracks?: unknown) {}
    };

    const { registerHandler } = await import('../protocol.ts');
    const handler = vi
      .mocked(registerHandler)
      .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
      | ((data: unknown, conn?: unknown) => void)
      | undefined;
    expect(handler).toBeDefined();

    handler!(
      {
        version: 2,
        audience: 'all',
        sessionId: 'host-publication-lan-overflow',
        track: { trackName: 'audio-stereo', mid: '0' },
      },
      firstHostConn,
    );
    await resolveRealtime('new-session', {
      sessionId: 'guest-session-lan-overflow',
      sessionOwnerToken: 'guest-owner-lan-overflow',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: 'o' },
      tracks: [{ mid: '0', trackName: 'audio-stereo' }],
    });
    await resolveRealtime('renegotiate', {});

    await vi.waitFor(() => {
      expect(mod.getSystemAudioSfuDebugSnapshot().guest.receiving).toBe(true);
    });
    const limitTimerCall = vi
      .mocked(setManagedTimer)
      .mock.calls.find(([name]) => name === 'system-audio-sfu-guest-limit');
    expect(limitTimerCall?.[2]).toBe(2 * 60 * 60 * 1000);
    const expireLimit = limitTimerCall?.[1] as (() => void) | undefined;
    expect(expireLimit).toBeTypeOf('function');

    const toastSpy = vi.fn();
    bus.on('ui:show-toast', toastSpy);
    expireLimit!();
    expect(mod.getSystemAudioSfuDebugSnapshot().guest).toMatchObject({
      receiving: false,
      limitTimerActive: false,
      limitBlocked: true,
    });
    expect(toastSpy).toHaveBeenCalledWith('system_audio.remote_receive_limit');

    const callsBeforeBlockedReady = countNewSessionCalls();
    handler!(
      {
        version: 2,
        audience: 'all',
        sessionId: 'same-host-retry',
        track: { trackName: 'audio-stereo-retry', mid: '0' },
      },
      firstHostConn,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(countNewSessionCalls()).toBe(callsBeforeBlockedReady);

    const replacementHostConn = {
      open: true,
      send: vi.fn(),
      peer: 'host-rejoined',
    } as unknown as DataConnection;
    setState('network.hostConn', replacementHostConn);
    handler!(
      {
        version: 2,
        audience: 'all',
        sessionId: 'replacement-host-publication',
        track: { trackName: 'audio-stereo-rejoined', mid: '0' },
      },
      replacementHostConn,
    );
    await waitForNewSessionCalls(callsBeforeBlockedReady + 1);
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.limitBlocked).toBe(false);

    bus.emit('system-audio:stop');
    await rejectAllRealtimeCalls();
    delete (globalThis as Record<string, unknown>).MediaStream;
  });
});
