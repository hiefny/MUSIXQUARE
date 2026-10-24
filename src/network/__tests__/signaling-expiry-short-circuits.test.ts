/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { log } from '../../core/log.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import type { DataConnection, PeerInstance } from '../../types/index.ts';
import { registerProRoomSignalingReconnectHandler } from '../../pro-room/lifecycle-hook.ts';

/**
 * Characterization of peer.ts's outer signaling-recovery loop after a
 * confirmed Standard room expiry (PR #471), before Phase 4 moves its backoff
 * schedule. Each entry point checks the transport's terminal reason itself,
 * so every case reports expiry WITHOUT first delivering
 * 'signaling-recovery-blocked': it is that entry point's own check that must
 * stop retries, publish 'expired' and leave the live RTC and media alone.
 */
const mocks = vi.hoisted(() => ({
  createTransportPeer: vi.fn(),
  fetchWithCapability: vi.fn(),
  getRuntimeTransportConfig: vi.fn(),
  prepareRoomSessionFeatures: vi.fn((_signal?: AbortSignal) => Promise.resolve()),
  showDialog: vi.fn(async () => ({ action: 'cancel' })),
  showToast: vi.fn(),
}));

vi.mock('../../core/capability.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/capability.ts')>();
  return { ...actual, fetchWithCapability: mocks.fetchWithCapability };
});
vi.mock('../transport/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transport/index.ts')>();
  return { ...actual, createTransportPeer: mocks.createTransportPeer };
});
vi.mock('../transport/config.ts', () => ({
  getRuntimeTransportConfig: mocks.getRuntimeTransportConfig,
}));
vi.mock('../room-session-feature-loader.ts', () => ({
  prepareRoomSessionFeatures: mocks.prepareRoomSessionFeatures,
}));
vi.mock('../../ui/dialog.ts', () => ({ showDialog: mocks.showDialog }));
vi.mock('../../ui/toast.ts', () => ({ showToast: mocks.showToast }));

import { setPeer } from '../peer-state.ts';
import { __standardRoomPrerequisitesForTests } from '../standard-room-prerequisites.ts';
import {
  cancelPendingSessionSetup,
  createHostSessionWithShortCode,
  recoverPeerAfterBackground,
  retryPeerSignalingConnection,
} from '../peer.ts';

type FiringPeer = PeerInstance & {
  fire: (event: string, ...args: unknown[]) => void;
  destroy: ReturnType<typeof vi.fn>;
  reconnect: ReturnType<typeof vi.fn>;
  recoverAfterBackground: ReturnType<typeof vi.fn>;
  markSignalingUnavailable: ReturnType<typeof vi.fn>;
};

function makePeer(id: string): FiringPeer {
  const handlers = new Map<string, Set<(...args: never[]) => void>>();
  const peer = {
    id,
    open: true,
    destroyed: false,
    disconnected: false,
    connect: vi.fn(),
    reconnect: vi.fn(),
    recoverAfterBackground: vi.fn(() => ({ status: 'not-applicable' as const })),
    markSignalingUnavailable: vi.fn(() => true),
    setRtcConfiguration: vi.fn(),
    destroy: vi.fn(() => {
      peer.destroyed = true;
      peer.open = false;
    }),
    on: vi.fn((event: string, callback: (...args: never[]) => void) => {
      const callbacks = handlers.get(event) ?? new Set();
      callbacks.add(callback);
      handlers.set(event, callbacks);
    }),
    off: vi.fn((event: string, callback: (...args: never[]) => void) => {
      handlers.get(event)?.delete(callback);
    }),
    fire(event: string, ...args: unknown[]) {
      if (event === 'open') peer.open = true;
      if (event === 'disconnected') peer.disconnected = true;
      for (const callback of [...(handlers.get(event) ?? [])]) {
        callback(...(args as never[]));
      }
    },
  };
  return peer as unknown as FiringPeer;
}

let expired = false;

/** A started Standard session whose transport reports expiry once `expired` is set. */
async function session(role: 'host' | 'guest') {
  vi.useFakeTimers();
  const peer = makePeer(`EXPIRY-${role.toUpperCase()}`);
  peer.getSignalingRecoveryBlockReason = () => (expired ? 'room-expired' : null);
  mocks.createTransportPeer.mockResolvedValueOnce(peer);
  const code = await createHostSessionWithShortCode(1);
  setState('setup.sessionStarted', true);
  const hostConn = { open: true, close: vi.fn() } as unknown as DataConnection;
  if (role === 'guest') {
    setState('network.appRole', 'guest');
    setState('network.hostConn', hostConn);
  } else {
    // An active Standard coordinator, so the browser connectivity hints apply.
    setState('network.sessionCode', code);
  }
  setState('playback.activity', 'playing');
  const stopMedia = vi.fn();
  bus.on('player:stop-all-media', stopMedia);
  return { peer, hostConn, stopMedia };
}

/** What every short-circuit leaves behind. */
function expectStopped(
  s: Awaited<ReturnType<typeof session>>,
  reconnects: number,
  role: 'host' | 'guest',
): void {
  expect(getState('network.signalingHealth').status).toBe('expired');
  expect(getManagedTimer('peer-signaling-reconnect')).toBeNull();
  expect(getManagedTimer('peer-disconnect-grace')).toBeNull();
  expect(s.peer.reconnect).toHaveBeenCalledTimes(reconnects);
  expect(s.peer.destroy).not.toHaveBeenCalled();
  if (role === 'guest') {
    expect(getState('network.hostConn')).toBe(s.hostConn);
    expect(s.hostConn.close).not.toHaveBeenCalled();
  }
  expect(getState('playback.activity')).toBe('playing');
  expect(s.stopMedia).not.toHaveBeenCalled();
  expect(mocks.showDialog).not.toHaveBeenCalled();
}

beforeEach(() => {
  __standardRoomPrerequisitesForTests.reset();
  clearAllManagedTimers();
  resetState();
  setPeer(null);
  bus.clear();
  vi.clearAllMocks();
  expired = false;
  setState('network.appRole', 'host');
  setState('setup.sessionStarted', false);
  mocks.getRuntimeTransportConfig.mockReturnValue({
    provider: 'cloudflare' as const,
    signalingUrl: 'https://signal.example.test/api/rooms',
    signalingFallbackUrl: 'wss://signal-alt.example.test/api/rooms',
  });
  mocks.fetchWithCapability.mockResolvedValue(
    Response.json({ provider: 'test', iceServers: [{ urls: 'turn:turn.example.test:3478' }] }),
  );
});

afterEach(() => {
  registerProRoomSignalingReconnectHandler(null);
  setState('setup.sessionStarted', false);
  cancelPendingSessionSetup();
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setPeer(null);
});

describe('peer.ts expiry short-circuits', () => {
  it("stops at the 'disconnected' event itself", async () => {
    const s = await session('guest');
    const warn = vi.spyOn(log, 'warn');
    expired = true;
    s.peer.fire('disconnected');
    await vi.advanceTimersByTimeAsync(60_000);
    expectStopped(s, 0, 'guest');
    expect(warn).not.toHaveBeenCalledWith(
      '[Transport] Signaling unavailable; recovering admission separately from existing RTC channels',
      expect.anything(),
    );
  });

  it('stops a scheduled reconnect that fires after expiry', async () => {
    const s = await session('guest');
    s.peer.fire('disconnected');
    expect(getManagedTimer('peer-signaling-reconnect')).not.toBeNull();
    expired = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expectStopped(s, 0, 'guest');
  });

  it('stops scheduling the next attempt when expiry lands during reconnect()', async () => {
    const s = await session('guest');
    s.peer.reconnect.mockImplementation(() => {
      expired = true;
    });
    s.peer.fire('disconnected');
    await vi.advanceTimersByTimeAsync(1_000);
    // Checked right after reconnect(), not at the next scheduled attempt.
    expectStopped(s, 1, 'guest');
    await vi.advanceTimersByTimeAsync(60_000);
    expectStopped(s, 1, 'guest');
  });

  it('stops at the disconnect grace when expiry lands between attempts', async () => {
    const s = await session('guest');
    // Leave signaling down with no surviving data channel, so the grace would act.
    setState('network.hostConn', null);
    s.peer.fire('disconnected');
    await vi.advanceTimersByTimeAsync(4_500);
    expect(s.peer.reconnect).toHaveBeenCalledTimes(2);
    expired = true;
    await vi.advanceTimersByTimeAsync(500);
    expect(getState('network.signalingHealth').status).toBe('expired');
    expect(getManagedTimer('peer-signaling-reconnect')).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.peer.reconnect).toHaveBeenCalledTimes(2);
    expect(s.stopMedia).not.toHaveBeenCalled();
    expect(mocks.showDialog).not.toHaveBeenCalled();
  });

  it('stops a reconnect that was waiting for a fresh PRO-format ticket', async () => {
    // Defensive: only a PRO-format code in a Standard context takes this branch.
    const s = await session('guest');
    setState('network.sessionCode', '012345');
    let release!: (ready: boolean) => void;
    registerProRoomSignalingReconnectHandler(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    s.peer.fire('disconnected');
    await vi.advanceTimersByTimeAsync(1_000);
    expired = true;
    release(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expectStopped(s, 0, 'guest');
  });

  it('refuses a manual retry', async () => {
    const s = await session('guest');
    s.peer.fire('disconnected');
    expired = true;
    expect(retryPeerSignalingConnection()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expectStopped(s, 0, 'guest');
  });

  it('passes a foreground resume result through without re-arming the grace', async () => {
    const s = await session('guest');
    s.peer.recoverAfterBackground.mockReturnValue({ status: 'monitoring' });
    s.peer.fire('disconnected');
    expect(getManagedTimer('peer-disconnect-grace')).not.toBeNull();
    expired = true;
    expect(recoverPeerAfterBackground(60_000)).toEqual({ status: 'monitoring' });
    expect(s.peer.recoverAfterBackground).toHaveBeenCalledWith(60_000);
    expectStopped(s, 0, 'guest');
    await vi.advanceTimersByTimeAsync(60_000);
    expectStopped(s, 0, 'guest');
  });

  it('does not restart an exhausted host on foreground return', async () => {
    const s = await session('host');
    s.peer.fire('disconnected');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.peer.reconnect).toHaveBeenCalledTimes(5);
    expect(getState('network.signalingHealth').status).toBe('exhausted');
    expired = true;
    recoverPeerAfterBackground(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expectStopped(s, 5, 'host');
  });

  it("does not report recovery on a late 'open'", async () => {
    const s = await session('guest');
    s.peer.fire('disconnected');
    expired = true;
    s.peer.fire('open');
    expectStopped(s, 0, 'guest');
  });

  it("logs the confirmed expiry once on 'signaling-recovery-blocked', and nothing without expiry", async () => {
    const s = await session('guest');
    const info = vi.spyOn(log, 'info');
    const line =
      '[Transport] Confirmed room expiry; signaling retries cancelled, RTC/media retained';
    s.peer.fire('signaling-recovery-blocked');
    expect(info).not.toHaveBeenCalledWith(line);
    expect(getState('network.signalingHealth').status).toBe('healthy');
    expired = true;
    s.peer.fire('signaling-recovery-blocked');
    expect(info.mock.calls.filter(([message]) => message === line)).toEqual([[line]]);
    expectStopped(s, 0, 'guest');
  });

  it('ignores the offline and online hints for an expired host', async () => {
    const s = await session('host');
    window.dispatchEvent(new Event('offline'));
    expect(s.peer.markSignalingUnavailable).toHaveBeenCalledOnce();
    expired = true;
    window.dispatchEvent(new Event('offline'));
    expect(s.peer.markSignalingUnavailable).toHaveBeenCalledOnce();
    s.peer.disconnected = true;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(60_000);
    expectStopped(s, 0, 'host');
  });
});
