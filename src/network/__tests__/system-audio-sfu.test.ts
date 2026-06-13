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
import type { ConnectedPeer } from '../../types/index.ts';

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
  addEventListener = vi.fn();
  connectionState = 'new';
  iceConnectionState = 'new';
  signalingState = 'stable';
  addTransceiver = vi.fn(() => ({
    mid: '0',
    sender: { getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} },
  }));
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'sdp' }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async () => {});
  constructor() {
    pcInstances.push(this);
  }
}

function installFetchRouting(): void {
  fetchMock.mockImplementation((url: string, _cap: string, init?: RequestInit) => {
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
