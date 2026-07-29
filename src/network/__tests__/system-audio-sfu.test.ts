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
  getSystemAudioShareDeliverySnapshot,
  markLocalSystemAudioSfuCapable,
  reserveSystemAudioFallbackDirect,
  resetGuestSystemAudioShareRoute,
  resetLocalSystemAudioSfuCapabilities,
} from '../system-audio-delivery.ts';

const systemAudioGuestMocks = vi.hoisted(() => ({
  awaitTrustedReceptionBoundary: vi.fn(async () => true),
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
  getStreamL: vi.fn(),
  getStreamR: vi.fn(),
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
  safeSend: vi.fn(),
}));

vi.mock('../system-audio-guest.ts', () => ({
  cleanupGuestSystemAudio: vi.fn(),
  awaitTrustedSystemAudioReceptionBoundary:
    systemAudioGuestMocks.awaitTrustedReceptionBoundary,
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
let pcInstances: Array<{ close: ReturnType<typeof vi.fn> }>;

class MockRTCPeerConnection {
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
  addTransceiver = vi.fn(() => ({
    mid: String(this._nextTransceiverMid++),
    sender: { getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} },
  }));
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'sdp' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'ans' }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  // Guest subscribe reads receiver tracks off the transceivers after
  // setRemoteDescription; one audio transceiver drives a single connectGuestTrack.
  getTransceivers = vi.fn(() => [
    { mid: '0', receiver: { track: { kind: 'audio', id: 'g-track-L' } } },
  ]);
  constructor() {
    pcInstances.push(this);
  }
}

function installFetchRouting(): void {
  fetchMock.mockImplementation((input, _capability, init) => {
    const url = String(input);
    if (url.includes('get-turn-config')) {
      // Both TURN endpoints fail fast → base STUN config, no extra suspense.
      return Promise.resolve(new Response(null, { status: 404 }));
    }
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
  vi.mocked(capture.getStreamL).mockReturnValue(fakeStream);
  vi.mocked(capture.getStreamR).mockReturnValue(fakeStream);
  vi.mocked(capture.isSystemAudioActive).mockReturnValue(true);

  setState('network.appRole', 'host');
  setState('network.connectedPeers', [makeRemotePeer('remote-1')]);
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
      sessionDescription: { type: 'answer', sdp: 'a' },
      tracks: [
        { trackName: 'audio-L', mid: '0' },
        { trackName: 'audio-R', mid: '1' },
      ],
    });

    await vi.waitFor(() => {
      const closeBody = fetchMock.mock.calls
        .map(([, , init]) => (init?.body ? JSON.parse(String(init.body)) : null))
        .find((body) => body?.action === 'tracks-close');
      expect(closeBody).toMatchObject({
        sessionId: 'orphan-host-session',
        sessionOwnerToken: 'orphan-host-owner',
        payload: { tracks: [{ mid: '0' }, { mid: '1' }], force: true },
      });
    });
    expect(fallbackSpy).toHaveBeenCalledTimes(1);
    expect(mod.getSystemAudioSfuDebugSnapshot().host.unavailable).toBe(true);
    await resolveRealtime('tracks-close', {});
  });
});

describe('host SFU runtime connection failure (F-2403)', () => {
  async function publishHostSuccessfully(mod: typeof import('../system-audio-sfu.ts')) {
    // publishHostTracks builds `new MediaStream([trackL, trackR])`; stub it for
    // the node test env (the existing tests reject at new-session, before this).
    (globalThis as Record<string, unknown>).MediaStream = class {
      constructor(_tracks?: unknown) {}
    };
    bus.emit('system-audio:streams-ready');
    await resolveRealtime('new-session', {
      sessionId: 'host-sess-1',
      sessionOwnerToken: 'host-owner-token',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'answer', sdp: 'a' },
      tracks: [
        { trackName: 'audio-L', mid: '0' },
        { trackName: 'audio-R', mid: '1' },
      ],
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
      payload: { tracks: [{ mid: '0' }, { mid: '1' }], force: true },
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
    vi.mocked(capture.getStreamL).mockReturnValue(fakeStream);
    vi.mocked(capture.getStreamR).mockReturnValue(fakeStream);
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
    vi.mocked(capture.getStreamL).mockReturnValue(fakeStream);
    vi.mocked(capture.getStreamR).mockReturnValue(fakeStream);
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
    vi.mocked(capture.getStreamL).mockReturnValue(fakeStream);
    vi.mocked(capture.getStreamR).mockReturnValue(fakeStream);
    vi.mocked(capture.isSystemAudioActive).mockReturnValue(true);
    const remotePeers = Array.from({ length: 8 }, (_, index) =>
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
      sessionDescription: { type: 'answer', sdp: 'a' },
      tracks: [
        { trackName: 'audio-L', mid: '0' },
        { trackName: 'audio-R', mid: '1' },
      ],
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
    vi.mocked(capture.getStreamL).mockReturnValue(fakeStream);
    vi.mocked(capture.getStreamR).mockReturnValue(fakeStream);
    vi.mocked(capture.isSystemAudioActive).mockReturnValue(true);
    const remotePeers = Array.from({ length: 8 }, (_, index) =>
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

    capabilityHandler!({ version: 1, localAudience: true }, localPeer.conn as DataConnection);
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
    expect(stoppedConnections).toEqual([localPeer.conn]);
  });
});

describe('guest SFU teardown and successor ownership (F-2402)', () => {
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
        version: 1,
        audience: 'remote',
        sessionId: 'host-successor-publication',
        tracks: [{ trackName: 'audio-L-successor', channel: 'L', mid: '0' }],
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
        version: 1,
        audience: 'remote',
        sessionId: 'host-partial-publication',
        tracks: [{ trackName: 'audio-L-partial', channel: 'L', mid: '0' }],
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
      tracks: [{ mid: 'allocated-mid-0', trackName: 'audio-L-partial' }],
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
        version: 1,
        audience: 'remote',
        sessionId: 'host-publication-before-fallback',
        tracks: [{ trackName: 'audio-L-before-fallback', channel: 'L', mid: '0' }],
      },
      hostConn,
    );
    await waitForNewSessionCalls(1);
    const deliveryHandoff = vi.fn();
    bus.on('system-audio:delivery-handoff', deliveryHandoff);
    handler!(
      {
        version: 1,
        audience: 'remote',
        sessionId: 'queued-host-publication',
        tracks: [{ trackName: 'queued-audio-L', channel: 'L', mid: '0' }],
      },
      hostConn,
    );

    // The direct fallback wins while the first subscribe is in flight. This
    // must cancel that attempt and discard its queued successor.
    bus.emit('system-audio:incoming-call', {} as never, 'L');
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
        version: 1,
        audience: 'remote',
        sessionId: 'late-host-publication',
        tracks: [{ trackName: 'late-audio-L', channel: 'L', mid: '0' }],
      },
      hostConn,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(countNewSessionCalls()).toBe(1);

    // The next authenticated START is the route-reset boundary.
    bus.emit('system-audio:host-started');
    handler!(
      {
        version: 1,
        audience: 'remote',
        sessionId: 'next-share-publication',
        tracks: [{ trackName: 'next-share-audio-L', channel: 'L', mid: '0' }],
      },
      hostConn,
    );
    await waitForNewSessionCalls(2);
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.directRouteFrozen).toBe(false);

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
        version: 1,
        audience: 'remote',
        sessionId: 'failed-host-publication',
        tracks: [{ trackName: 'failed-audio-L', channel: 'L', mid: '0' }],
      },
      hostConn,
    );
    await waitForNewSessionCalls(1);
    handler!(
      {
        version: 1,
        audience: 'remote',
        sessionId: 'retry-host-publication',
        tracks: [{ trackName: 'retry-audio-L', channel: 'L', mid: '0' }],
      },
      hostConn,
    );

    await resolveRealtime('new-session', {
      sessionId: 'failed-guest-session',
      sessionOwnerToken: 'failed-guest-owner',
    });
    await resolveRealtime('tracks-new', {
      errorCode: 'FIRST_SUBSCRIBE_FAILED',
      tracks: [{ mid: 'failed-mid', trackName: 'failed-audio-L' }],
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

  it('freezes all-audience SFU before the async RTC-config await can be preempted', async () => {
    const mod = await import('../system-audio-sfu.ts');
    mod.registerSystemAudioSfuListeners();
    bus.emit('system-audio:stop');
    const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
    setState('network.connectionType', 'local');

    let releaseTurn: (() => void) | undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseTurn = () => resolve(new Response(null, { status: 404 }));
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
        version: 1,
        audience: 'all',
        sessionId: 'all-audience-await',
        tracks: [{ trackName: 'all-await-L', channel: 'L', mid: '0' }],
      },
      hostConn,
    );
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.shareRoute).toBe('sfu-all');

    bus.emit('system-audio:incoming-call', {} as never, 'L');
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.shareRoute).toBe('sfu-all');
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.directRouteFrozen).toBe(false);

    releaseTurn?.();
    await waitForNewSessionCalls(1);
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
        version: 1,
        audience: 'remote',
        sessionId: 'host-publication-1',
        tracks: [{ trackName: 'audio-L-1', channel: 'L', mid: '0' }],
      },
      hostConn,
    );
    await waitForNewSessionCalls(1);
    handler!(
      {
        version: 1,
        audience: 'remote',
        sessionId: 'host-publication-2',
        tracks: [{ trackName: 'audio-L-2', channel: 'L', mid: '0' }],
      },
      hostConn,
    );

    await resolveRealtime('new-session', {
      sessionId: 'guest-publication-1',
      sessionOwnerToken: 'guest-owner-1',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: 'o' },
      tracks: [{ mid: '0', trackName: 'audio-L-1' }],
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
    // would recreate the merger + flip receiving=true (the resurrection this
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
        version: 1,
        sessionId: 'host-sess',
        tracks: [{ trackName: 'audio-L', channel: 'L', mid: '0' }],
      },
      hostConn,
    );

    await resolveRealtime('new-session', {
      sessionId: 'guest-sess',
      sessionOwnerToken: 'guest-owner-token',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: 'o' },
      tracks: [{ mid: '0', trackName: 'audio-L' }],
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
    expect(guest.merger).toBe(false);
    expect(guest.receiving).toBe(false);
    expect(guest.sourceL).toBe(false);

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
        version: 1,
        sessionId: 'trusted-boundary-host-session',
        tracks: [{ trackName: 'audio-L', channel: 'L', mid: '0' }],
      },
      hostConn,
    );
    await resolveRealtime('new-session', {
      sessionId: 'trusted-boundary-guest-session',
      sessionOwnerToken: 'trusted-boundary-owner-token',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: 'o' },
      tracks: [{ mid: '0', trackName: 'audio-L' }],
    });
    await resolveRealtime('renegotiate', {});

    await vi.waitFor(() => {
      expect(systemAudioGuestMocks.awaitTrustedReceptionBoundary).toHaveBeenCalledWith('sfu-L');
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
    markLocalSystemAudioSfuCapable('replaced-peer');
    expect(getSystemAudioShareDeliverySnapshot().capablePeerIds).toContain('replaced-peer');

    bus.emit('network:peer-connection-replaced', 'replaced-peer');

    expect(getSystemAudioShareDeliverySnapshot().capablePeerIds).not.toContain('replaced-peer');
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
      version: 1,
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
        version: 1,
        audience: 'remote',
        sessionId: 'remote-only',
        tracks: [{ trackName: 'audio-L', channel: 'L', mid: '0' }],
      },
      hostConn,
    );
    expect(countNewSessionCalls()).toBe(0);

    handler!(
      {
        version: 1,
        audience: 'all',
        sessionId: 'all-audience',
        tracks: [{ trackName: 'audio-L', channel: 'L', mid: '0' }],
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
        version: 1,
        audience: 'remote',
        sessionId: 'frozen-host-publication',
        tracks: [{ trackName: 'frozen-audio-L', channel: 'L', mid: '0' }],
      },
      hostConn,
    );
    await resolveRealtime('new-session', {
      sessionId: 'frozen-guest-session',
      sessionOwnerToken: 'frozen-guest-owner',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: 'o' },
      tracks: [{ mid: '0', trackName: 'frozen-audio-L' }],
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
        version: 1,
        audience: 'all',
        sessionId: 'host-publication-lan-overflow',
        tracks: [{ trackName: 'audio-L', channel: 'L', mid: '0' }],
      },
      firstHostConn,
    );
    await resolveRealtime('new-session', {
      sessionId: 'guest-session-lan-overflow',
      sessionOwnerToken: 'guest-owner-lan-overflow',
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: 'o' },
      tracks: [{ mid: '0', trackName: 'audio-L' }],
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
        version: 1,
        audience: 'all',
        sessionId: 'same-host-retry',
        tracks: [{ trackName: 'audio-L-retry', channel: 'L', mid: '0' }],
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
        version: 1,
        audience: 'all',
        sessionId: 'replacement-host-publication',
        tracks: [{ trackName: 'audio-L-rejoined', channel: 'L', mid: '0' }],
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
