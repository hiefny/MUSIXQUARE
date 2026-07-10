/**
 * @vitest-environment jsdom
 *
 * Pin tests for the host-publish supersession semantics in the Cloudflare
 * Realtime SFU bridge (F-2403, 2026-06-13).
 *
 * publishHostTracks dangles in its Realtime fetch chain for seconds. Before
 * the fix, a publish that failed AFTER the share was stopped (supersession —
 * cleanupHostSfu bumps hostPublishEpoch and resets hostSfuUnavailable)
 * re-poisoned hostSfuUnavailable=true from its catch, with cleanupHostSfu(false)
 * deliberately preserving the flag. The NEXT share's ensureHostPublication then
 * returned null immediately — no publish attempt, no sfu-fallback emit — and
 * remote guests sat on the receive watchdog until "receive failed".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { bus } from '../../core/events.ts';
import { fetchWithCapability } from '../../core/capability.ts';
import { MSG } from '../../core/constants.ts';
import { setManagedTimer } from '../../core/timers.ts';
import { safeSend } from '../peer-state.ts';
import type { ConnectedPeer, DataConnection } from '../../types/index.ts';

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
  // Record connectionstatechange listeners so a test can fire a runtime state
  // transition (F-2403); existing tests that never fire are unaffected.
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
  addTransceiver = vi.fn(() => ({
    mid: '0',
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
  fetchMock.mockImplementation((input, _cap, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('get-turn-config')) {
      // Both TURN endpoints fail fast → base STUN config, no extra suspense.
      return Promise.resolve({ ok: false } as Response);
    }
    const action = init?.body ? (JSON.parse(String(init.body)) as { action: string }).action : '?';
    return new Promise<Response>((resolve, reject) => {
      pendingRealtimeCalls.push({
        action,
        resolve: (json: unknown) =>
          resolve({ ok: true, json: async () => json } as unknown as Response),
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
  pendingRealtimeCalls = [];
  pcInstances = [];
  (globalThis as Record<string, unknown>).RTCPeerConnection = MockRTCPeerConnection;
  installFetchRouting();
});

afterEach(() => {
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

    // Restarted share: before the fix this returned null at the
    // hostSfuUnavailable gate — no publish attempt, no fallback, remote
    // guests starved until the receive watchdog.
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
      sessionOwnerExpiresAt: Math.floor(Date.now() / 1000) + 10_800,
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

    // The hostSfuUnavailable gate must suppress a republish — no new session,
    // no re-subscribe storm.
    const before = countNewSessionCalls();
    bus.emit('system-audio:streams-ready');
    await new Promise((r) => setTimeout(r, 0));
    expect(countNewSessionCalls()).toBe(before);
  });

  it('uses the host owner token for its SFU calls but never publishes it to guests', async () => {
    const mod = await loadSfuModuleAsHostWithRemoteGuest();
    await publishHostSuccessfully(mod);

    const realtimeBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('cloudflare-realtime'))
      .map(([, , init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(realtimeBodies.find((body) => body.action === 'tracks-new')).toMatchObject({
      sessionId: 'host-sess-1',
      sessionOwnerToken: 'host-owner-token',
    });

    await vi.waitFor(() => expect(safeSend).toHaveBeenCalled());
    const publishedMessage = vi.mocked(safeSend).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(publishedMessage).toMatchObject({ sessionId: 'host-sess-1' });
    expect(publishedMessage).not.toHaveProperty('sessionOwnerToken');
    expect(JSON.stringify(publishedMessage)).not.toContain('host-owner-token');
  });

  it('refreshes the host owner token before expiry and closes with the latest token', async () => {
    const mod = await loadSfuModuleAsHostWithRemoteGuest();
    await publishHostSuccessfully(mod);

    const refreshTimer = vi
      .mocked(setManagedTimer)
      .mock.calls.filter(([name]) => name === 'system-audio-sfu-host-owner-refresh')
      .at(-1);
    expect(refreshTimer).toBeDefined();
    const refreshCallback = refreshTimer?.[1];
    refreshCallback?.();

    await resolveRealtime('session-owner-refresh', {
      sessionId: 'host-sess-1',
      sessionOwnerToken: 'host-owner-token-refreshed',
      sessionOwnerExpiresAt: Math.floor(Date.now() / 1000) + 10_800,
    });
    await vi.waitFor(() => {
      expect(mod.getSystemAudioSfuDebugSnapshot().host.ownerTokenExpiresAt).toBeGreaterThan(
        Date.now() / 1000,
      );
    });

    const refreshBody = fetchMock.mock.calls
      .filter(([, , init]) => init?.body)
      .map(([, , init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
      .find((body) => body.action === 'session-owner-refresh');
    expect(refreshBody).toMatchObject({
      sessionId: 'host-sess-1',
      sessionOwnerToken: 'host-owner-token',
    });

    bus.emit('system-audio:stop');
    const closeBody = fetchMock.mock.calls
      .filter(([, , init]) => init?.body)
      .map(([, , init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
      .filter((body) => body.action === 'tracks-close')
      .at(-1);
    expect(closeBody).toMatchObject({
      sessionId: 'host-sess-1',
      sessionOwnerToken: 'host-owner-token-refreshed',
    });
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

async function loadSfuModuleAsRemoteGuest() {
  const mod = await import('../system-audio-sfu.ts');
  mod.registerSystemAudioSfuListeners();
  bus.emit('system-audio:stop');

  const hostConn = { open: true, send: vi.fn(), peer: 'host' } as unknown as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.hostConn', hostConn);
  setState('network.connectionType', 'remote');

  const { registerHandler } = await import('../protocol.ts');
  const sfuReadyHandler = vi
    .mocked(registerHandler)
    .mock.calls.find((call) => call[0] === MSG.SYSTEM_AUDIO_SFU_READY)?.[1] as
    | ((data: unknown, conn?: unknown) => void)
    | undefined;
  expect(sfuReadyHandler).toBeDefined();

  return { mod, hostConn, sfuReadyHandler: sfuReadyHandler! };
}

function makeSfuReadyPayload(sessionId: string, trackName: string) {
  return {
    version: 1 as const,
    sessionId,
    tracks: [{ trackName, channel: 'L' as const, mid: '0' }],
  };
}

describe('guest SFU reclassify-mid-subscribe (F-2402)', () => {
  it('stops an in-flight subscription when guest cleanup lands during new-session', async () => {
    const { mod, hostConn, sfuReadyHandler } = await loadSfuModuleAsRemoteGuest();

    sfuReadyHandler(makeSfuReadyPayload('host-sess-old', 'audio-old'), hostConn);
    await vi.waitFor(() => {
      expect(pendingRealtimeCalls.some((call) => call.action === 'new-session')).toBe(true);
      expect(mod.getSystemAudioSfuDebugSnapshot().guest.pcState).not.toBeNull();
    });
    const stalePc = pcInstances[0];

    bus.emit('system-audio:host-stopped');
    expect(stalePc.close).toHaveBeenCalledTimes(1);
    expect(mod.getSystemAudioSfuDebugSnapshot().guest).toMatchObject({
      pcState: null,
      sessionId: null,
      subscriptionKey: null,
      connectInFlight: false,
      receiving: false,
    });

    await resolveRealtime('new-session', {
      sessionId: 'guest-sess-stale',
      sessionOwnerToken: 'guest-owner-stale',
      sessionOwnerExpiresAt: Math.floor(Date.now() / 1000) + 10_800,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pendingRealtimeCalls.some((call) => call.action === 'tracks-new')).toBe(false);
    expect(mod.getSystemAudioSfuDebugSnapshot().guest).toMatchObject({
      pcState: null,
      sessionId: null,
      subscriptionKey: null,
      connectInFlight: false,
    });
  });

  it('a stale listener, catch, and finally cannot tear down a successor subscription', async () => {
    const { mod, hostConn, sfuReadyHandler } = await loadSfuModuleAsRemoteGuest();

    sfuReadyHandler(makeSfuReadyPayload('host-sess-old', 'audio-old'), hostConn);
    await vi.waitFor(() => {
      expect(pendingRealtimeCalls.filter((call) => call.action === 'new-session')).toHaveLength(1);
    });
    const stalePc = pcInstances[0] as unknown as MockRTCPeerConnection;

    sfuReadyHandler(makeSfuReadyPayload('host-sess-new', 'audio-new'), hostConn);
    await vi.waitFor(() => {
      expect(pcInstances).toHaveLength(2);
      expect(pendingRealtimeCalls.filter((call) => call.action === 'new-session')).toHaveLength(2);
    });
    const successorPc = pcInstances[1] as unknown as MockRTCPeerConnection;
    expect(stalePc.close).toHaveBeenCalledTimes(1);
    expect(successorPc.close).not.toHaveBeenCalled();

    const [staleFirstCall] = pendingRealtimeCalls.splice(0, 1);
    staleFirstCall.reject(new Error('STALE_FIRST_ENDPOINT'));
    await vi.waitFor(() => {
      expect(pendingRealtimeCalls.filter((call) => call.action === 'new-session')).toHaveLength(2);
    });
    const [staleRetry] = pendingRealtimeCalls.splice(1, 1);
    staleRetry.reject(new Error('STALE_SECOND_ENDPOINT'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    stalePc.connectionState = 'failed';
    stalePc._emit('connectionstatechange');
    expect(mod.getSystemAudioSfuDebugSnapshot().guest).toMatchObject({
      subscriptionKey: 'host-sess-new:audio-new',
      connectInFlight: true,
    });
    expect(successorPc.close).not.toHaveBeenCalled();

    await resolveRealtime('new-session', {
      sessionId: 'guest-sess-new',
      sessionOwnerToken: 'guest-owner-new',
      sessionOwnerExpiresAt: Math.floor(Date.now() / 1000) + 10_800,
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: 'o' },
      tracks: [{ mid: '0', trackName: 'audio-new' }],
    });
    await resolveRealtime('renegotiate', {});
    await vi.waitFor(() => {
      expect(mod.getSystemAudioSfuDebugSnapshot().guest).toMatchObject({
        sessionId: 'guest-sess-new',
        subscriptionKey: 'host-sess-new:audio-new',
        connectInFlight: false,
      });
    });
    expect(successorPc.close).not.toHaveBeenCalled();
  });

  it('a reclassify-to-local during connectGuestTrack must not resurrect a torn-down receive', async () => {
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
    // guards). With the fix it returns before touching any of this.
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
      sessionOwnerExpiresAt: Math.floor(Date.now() / 1000) + 10_800,
    });
    await resolveRealtime('tracks-new', {
      sessionDescription: { type: 'offer', sdp: 'o' },
      tracks: [{ mid: '0', trackName: 'audio-L' }],
    });
    await resolveRealtime('renegotiate', {});

    const guestBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('cloudflare-realtime'))
      .map(([, , init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(guestBodies.find((body) => body.action === 'tracks-new')).toMatchObject({
      sessionId: 'guest-sess',
      sessionOwnerToken: 'guest-owner-token',
    });
    expect(guestBodies.find((body) => body.action === 'renegotiate')).toMatchObject({
      sessionId: 'guest-sess',
      sessionOwnerToken: 'guest-owner-token',
    });
    expect(
      vi
        .mocked(setManagedTimer)
        .mock.calls.some(([name]) => name === 'system-audio-sfu-guest-owner-refresh'),
    ).toBe(true);

    // connectGuestTrack is now parked at await initAudio with guestPc set.
    await vi.waitFor(() => {
      expect(mod.getSystemAudioSfuDebugSnapshot().guest.pcState).not.toBeNull();
    });

    // Reclassify to local → cleanupGuestSfu(false) nulls guestPc mid-flight.
    setState('network.connectionType', 'local');
    expect(mod.getSystemAudioSfuDebugSnapshot().guest.pcState).toBeNull();

    // Release initAudio: the recheck must bail before recreating anything.
    releaseInit();
    await new Promise((r) => setTimeout(r, 0));

    const guest = mod.getSystemAudioSfuDebugSnapshot().guest;
    expect(guest.merger).toBe(false);
    expect(guest.receiving).toBe(false);
    expect(guest.sourceL).toBe(false);

    delete (globalThis as Record<string, unknown>).MediaStream;
  });
});
