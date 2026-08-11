/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers, getManagedTimer } from '../../core/timers.ts';
import type { DataConnection, PeerInstance } from '../../types/index.ts';
import { registerProRoomSignalingReconnectHandler } from '../../pro-room/lifecycle-hook.ts';

const mocks = vi.hoisted(() => ({
  createTransportPeer: vi.fn(),
  fetchWithCapability: vi.fn(),
  getRuntimeTransportConfig: vi.fn(),
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

vi.mock('../../ui/dialog.ts', () => ({ showDialog: mocks.showDialog }));
vi.mock('../../ui/toast.ts', () => ({ showToast: mocks.showToast }));

import { getPeer, setPeer } from '../peer-state.ts';
import { __standardRoomPrerequisitesForTests } from '../standard-room-prerequisites.ts';
import {
  claimGuestDirectSystemAudioRoute,
  getGuestSystemAudioShareRoute,
  getSystemAudioShareDeliverySnapshot,
  markLocalSystemAudioSfuCapable,
} from '../system-audio-delivery.ts';
import {
  cancelPendingSessionSetup,
  createHostSessionWithShortCode,
  joinSession,
  leaveSession,
  recoverPeerAfterBackground,
} from '../peer.ts';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type FiringPeer = PeerInstance & {
  fire: (event: string, ...args: unknown[]) => void;
  destroy: ReturnType<typeof vi.fn>;
  reconnect: ReturnType<typeof vi.fn>;
  recoverAfterBackground: ReturnType<typeof vi.fn>;
  setRtcConfiguration: ReturnType<typeof vi.fn>;
};

function makePeer(id: string, initiallyOpen: boolean): FiringPeer {
  const handlers = new Map<string, Set<(...args: never[]) => void>>();
  const peer = {
    id,
    open: initiallyOpen,
    destroyed: false,
    disconnected: false,
    connect: vi.fn(),
    reconnect: vi.fn(),
    recoverAfterBackground: vi.fn(() => ({ status: 'not-applicable' as const })),
    setRtcConfiguration: vi.fn(),
    destroy: vi.fn(() => {
      peer.destroyed = true;
      peer.open = false;
      // Deliberately emit nothing. Cancellation must settle independently of
      // adapter-specific destroy/error behaviour.
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

async function waitForTransportCalls(count: number): Promise<void> {
  await vi.waitFor(() => expect(mocks.createTransportPeer).toHaveBeenCalledTimes(count));
}

beforeEach(() => {
  __standardRoomPrerequisitesForTests.reset();
  clearAllManagedTimers();
  resetState();
  setPeer(null);
  bus.clear();
  vi.clearAllMocks();
  setState('network.appRole', 'host');
  setState('setup.sessionStarted', false);
  mocks.getRuntimeTransportConfig.mockReturnValue({
    provider: 'cloudflare' as const,
    signalingUrl: 'https://signal.example.test/api/rooms',
  });
  mocks.fetchWithCapability.mockResolvedValue(
    Response.json({
      provider: 'test',
      iceServers: [{ urls: 'turn:turn.example.test:3478' }],
    }),
  );
});

afterEach(() => {
  registerProRoomSignalingReconnectHandler(null);
  setState('setup.sessionStarted', false);
  cancelPendingSessionSetup();
  clearAllManagedTimers();
  vi.useRealTimers();
  setPeer(null);
});

describe('network initialization ownership', () => {
  it('claims a Cloudflare host room while TURN loads but returns the code only after both', async () => {
    const pendingTurn = deferred<Response>();
    mocks.fetchWithCapability.mockReturnValueOnce(pendingTurn.promise);
    const peer = makePeer('PARALLEL-HOST', true);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);

    let codeReturned = false;
    const session = createHostSessionWithShortCode(1).then((code) => {
      codeReturned = true;
      return code;
    });

    await waitForTransportCalls(1);
    expect(codeReturned).toBe(false);
    expect(peer.setRtcConfiguration).not.toHaveBeenCalled();
    expect(mocks.createTransportPeer.mock.calls[0]?.[1]).toMatchObject({
      provider: 'cloudflare',
      deferRtcUntilConfigured: true,
    });

    pendingTurn.resolve(
      Response.json({
        provider: 'test',
        iceServers: [{ urls: 'turn:turn.example.test:3478' }],
      }),
    );

    await expect(session).resolves.toMatch(/^\d{6}$/);
    expect(peer.setRtcConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        iceServers: expect.arrayContaining([
          expect.objectContaining({ urls: 'turn:turn.example.test:3478' }),
        ]),
      }),
    );
  });

  it('does not publish a code when signaling closes after peer-open but before TURN settles', async () => {
    const pendingTurn = deferred<Response>();
    mocks.fetchWithCapability.mockReturnValueOnce(pendingTurn.promise);
    const peer = makePeer('CLOSED-WHILE-TURN-PENDING', true);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);
    const ready = vi.fn();
    bus.on('network:peer-ready', ready);

    const session = createHostSessionWithShortCode(1);
    await waitForTransportCalls(1);
    peer.open = false;
    peer.fire('disconnected');

    pendingTurn.resolve(
      Response.json({
        provider: 'test',
        iceServers: [{ urls: 'turn:turn.example.test:3478' }],
      }),
    );

    await expect(session).rejects.toThrow('PEER_NOT_OPEN_AFTER_PREREQUISITES');
    expect(ready).not.toHaveBeenCalled();
    expect(getState('network.myId')).toBeNull();
    expect(peer.destroy).toHaveBeenCalled();
  });

  it('installs TURN as soon as it settles but still waits for Cloudflare peer-open', async () => {
    const pendingTurn = deferred<Response>();
    mocks.fetchWithCapability.mockReturnValueOnce(pendingTurn.promise);
    const peer = makePeer('TURN-FIRST-HOST', false);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);

    let codeReturned = false;
    const session = createHostSessionWithShortCode(1).then((code) => {
      codeReturned = true;
      return code;
    });
    await waitForTransportCalls(1);

    pendingTurn.resolve(
      Response.json({
        provider: 'test',
        iceServers: [{ urls: 'turn:turn.example.test:3478' }],
      }),
    );
    await vi.waitFor(() => expect(peer.setRtcConfiguration).toHaveBeenCalledOnce());
    expect(codeReturned).toBe(false);

    peer.fire('open', peer.id);
    await expect(session).resolves.toMatch(/^\d{6}$/);
  });

  it('cleans the peer-open waiter when TURN capability acquisition rejects first', async () => {
    const cancellation = new Error('CAPABILITY_CANCELLED');
    cancellation.name = 'CapabilityChallengeCancelled';
    mocks.fetchWithCapability.mockRejectedValueOnce(cancellation);
    const peer = makePeer('TURN-REJECTED-HOST', false);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);

    const session = createHostSessionWithShortCode(1);
    await waitForTransportCalls(1);
    await expect(session).rejects.toBe(cancellation);

    expect(getManagedTimer('peer-open-timeout')).toBeNull();
    expect(peer.destroy).toHaveBeenCalledOnce();
    expect(peer.setRtcConfiguration).not.toHaveBeenCalled();
  });

  it('does not install late TURN or publish a code after setup cancellation', async () => {
    const pendingTurn = deferred<Response>();
    mocks.fetchWithCapability.mockReturnValueOnce(pendingTurn.promise);
    const peer = makePeer('CANCELLED-BEFORE-TURN', false);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);
    const ready = vi.fn();
    bus.on('network:peer-ready', ready);

    const session = createHostSessionWithShortCode(1);
    await waitForTransportCalls(1);
    cancelPendingSessionSetup();

    await expect(session).rejects.toThrow('NETWORK_INIT_CANCELLED');
    pendingTurn.resolve(
      Response.json({
        provider: 'test',
        iceServers: [{ urls: 'turn:turn.example.test:3478' }],
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(peer.setRtcConfiguration).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    expect(peer.destroy).toHaveBeenCalledOnce();
  });

  it('lets a superseding host reuse pending TURN without configuring the stale peer', async () => {
    const pendingTurn = deferred<Response>();
    mocks.fetchWithCapability.mockReturnValueOnce(pendingTurn.promise);
    const stalePeer = makePeer('SUPERSEDED-HOST', false);
    const currentPeer = makePeer('CURRENT-HOST', true);
    mocks.createTransportPeer.mockResolvedValueOnce(stalePeer).mockResolvedValueOnce(currentPeer);

    const staleSession = createHostSessionWithShortCode(1).catch((error: unknown) => error);
    await waitForTransportCalls(1);
    const currentSession = createHostSessionWithShortCode(1);
    await waitForTransportCalls(2);
    await expect(staleSession).resolves.toMatchObject({ message: 'NETWORK_INIT_CANCELLED' });

    pendingTurn.resolve(
      Response.json({
        provider: 'test',
        iceServers: [{ urls: 'turn:turn.example.test:3478' }],
      }),
    );

    await expect(currentSession).resolves.toMatch(/^\d{6}$/);
    expect(mocks.fetchWithCapability).toHaveBeenCalledOnce();
    expect(stalePeer.setRtcConfiguration).not.toHaveBeenCalled();
    expect(currentPeer.setRtcConfiguration).toHaveBeenCalledOnce();
    expect(stalePeer.destroy).toHaveBeenCalled();
  });

  it('reuses one page-scoped TURN request after id-taken without configuring the stale peer', async () => {
    const pendingTurn = deferred<Response>();
    mocks.fetchWithCapability.mockReturnValueOnce(pendingTurn.promise);
    const takenPeer = makePeer('TAKEN-HOST', false);
    const acceptedPeer = makePeer('ACCEPTED-HOST', true);
    mocks.createTransportPeer.mockResolvedValueOnce(takenPeer).mockResolvedValueOnce(acceptedPeer);

    const session = createHostSessionWithShortCode(2);
    await waitForTransportCalls(1);
    takenPeer.fire('error', { type: 'id-taken', message: 'ID_TAKEN' });
    await waitForTransportCalls(2);

    pendingTurn.resolve(
      Response.json({
        provider: 'test',
        iceServers: [{ urls: 'turn:turn.example.test:3478' }],
      }),
    );

    await expect(session).resolves.toMatch(/^\d{6}$/);
    expect(mocks.fetchWithCapability).toHaveBeenCalledOnce();
    expect(takenPeer.setRtcConfiguration).not.toHaveBeenCalled();
    expect(acceptedPeer.setRtcConfiguration).toHaveBeenCalledOnce();
    expect(takenPeer.destroy).toHaveBeenCalledOnce();
  });

  it('keeps PeerJS host creation TURN-first and does not request the Cloudflare RTC gate', async () => {
    mocks.getRuntimeTransportConfig.mockReturnValue({
      provider: 'peerjs' as const,
      peerJsServer: { host: 'peer.example.test' },
    });
    const pendingTurn = deferred<Response>();
    mocks.fetchWithCapability.mockReturnValueOnce(pendingTurn.promise);
    const peer = makePeer('PEERJS-HOST', true);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);

    const session = createHostSessionWithShortCode(1);
    await Promise.resolve();
    expect(mocks.createTransportPeer).not.toHaveBeenCalled();

    pendingTurn.resolve(
      Response.json({
        provider: 'test',
        iceServers: [{ urls: 'turn:turn.example.test:3478' }],
      }),
    );
    await expect(session).resolves.toMatch(/^\d{6}$/);

    expect(mocks.createTransportPeer.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        provider: 'peerjs',
        config: expect.objectContaining({
          iceServers: expect.arrayContaining([
            expect.objectContaining({ urls: 'turn:turn.example.test:3478' }),
          ]),
        }),
      }),
    );
    expect(mocks.createTransportPeer.mock.calls[0]?.[1]).not.toHaveProperty(
      'deferRtcUntilConfigured',
    );
    expect(peer.setRtcConfiguration).not.toHaveBeenCalled();
  });

  it('keeps a Cloudflare guest TURN-first and never enables the host RTC gate', async () => {
    const pendingTurn = deferred<Response>();
    mocks.fetchWithCapability.mockReturnValueOnce(pendingTurn.promise);
    const peer = makePeer('CLOUDFLARE-GUEST', false);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);
    setState('network.appRole', 'guest');

    joinSession('123456');
    await vi.waitFor(() => expect(mocks.fetchWithCapability).toHaveBeenCalledOnce());
    expect(mocks.createTransportPeer).not.toHaveBeenCalled();

    pendingTurn.resolve(
      Response.json({
        provider: 'test',
        iceServers: [{ urls: 'turn:turn.example.test:3478' }],
      }),
    );
    await waitForTransportCalls(1);

    expect(mocks.createTransportPeer.mock.calls[0]?.[0]).toBeNull();
    expect(mocks.createTransportPeer.mock.calls[0]?.[1]).not.toHaveProperty(
      'deferRtcUntilConfigured',
    );
    expect(peer.setRtcConfiguration).not.toHaveBeenCalled();
    cancelPendingSessionSetup();
  });

  it('keeps an idle ordinary host on the in-place signaling recovery surface', async () => {
    vi.useFakeTimers();
    const peer = makePeer('STANDARD-HOST', true);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);
    const sessionCode = await createHostSessionWithShortCode(1);
    setState('network.sessionCode', sessionCode);
    setState('setup.sessionStarted', true);

    expect(mocks.createTransportPeer).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        deferRtcUntilConfigured: true,
        config: expect.objectContaining({
          iceServers: expect.not.arrayContaining([
            expect.objectContaining({ urls: 'turn:turn.example.test:3478' }),
          ]),
        }),
      }),
    );
    expect(peer.setRtcConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        iceServers: expect.arrayContaining([
          expect.objectContaining({ urls: 'turn:turn.example.test:3478' }),
        ]),
      }),
    );

    peer.fire('disconnected');
    expect(getState('network.signalingHealth').status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getState('network.signalingHealth').status).toBe('reconnecting');
    expect(mocks.showDialog).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('publishes bounded partial signaling recovery and briefly reports success', async () => {
    vi.useFakeTimers();
    const peer = makePeer('STANDARD-HOST', true);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);
    await createHostSessionWithShortCode(1);
    setState('setup.sessionStarted', true);
    setState('network.connectedPeers', [
      {
        id: 'guest-1',
        slot: 1,
        label: 'Guest',
        joinOrder: 1,
        status: 'connected',
        isOp: false,
        preloadedQueueItemIds: new Set(),
        isDataTarget: true,
        connectionType: 'local',
        lastHeartbeat: Date.now(),
        conn: { open: true } as DataConnection,
      },
    ]);

    peer.fire('disconnected');
    expect(getState('network.signalingHealth')).toMatchObject({
      status: 'reconnecting',
      attempt: 1,
      maxAttempts: 5,
    });

    peer.disconnected = false;
    peer.fire('open', peer.id);
    expect(getState('network.signalingHealth').status).toBe('recovered');

    await vi.advanceTimersByTimeAsync(4_000);
    expect(getState('network.signalingHealth').status).toBe('healthy');
    expect(mocks.showDialog).not.toHaveBeenCalled();
  });

  it('keeps a host-only playing session active while signaling reconnects', async () => {
    vi.useFakeTimers();
    const peer = makePeer('STANDARD-HOST', true);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);
    await createHostSessionWithShortCode(1);
    setState('setup.sessionStarted', true);
    setState('playback.activity', 'playing');

    peer.fire('disconnected');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getState('network.signalingHealth')).toMatchObject({
      status: 'reconnecting',
      maxAttempts: 5,
    });
    expect(mocks.showDialog).not.toHaveBeenCalled();
  });

  it('re-evaluates a signaling-loss check that skipped a stale-open guest connection', async () => {
    vi.useFakeTimers();
    const peer = makePeer('STANDARD-GUEST', true);
    peer.recoverAfterBackground.mockReturnValue({ status: 'monitoring' });
    mocks.createTransportPeer.mockResolvedValueOnce(peer);
    await createHostSessionWithShortCode(1);
    setState('setup.sessionStarted', true);
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true } as DataConnection);

    peer.fire('disconnected');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.showDialog).not.toHaveBeenCalled();

    expect(recoverPeerAfterBackground(60_000)).toEqual({ status: 'monitoring' });
    expect(peer.recoverAfterBackground).toHaveBeenCalledWith(60_000);
    setState('network.hostConn', null);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.showDialog).toHaveBeenCalledOnce();
  });

  it('cancels the generic signaling-loss dialog when foreground recovery closes the guest RTC', async () => {
    vi.useFakeTimers();
    const peer = makePeer('STANDARD-GUEST', true);
    peer.recoverAfterBackground.mockReturnValue({ status: 'stale-connection-closed' });
    mocks.createTransportPeer.mockResolvedValueOnce(peer);
    await createHostSessionWithShortCode(1);
    setState('setup.sessionStarted', true);
    setState('network.appRole', 'guest');
    setState('network.hostConn', { open: true } as DataConnection);

    peer.fire('disconnected');
    expect(recoverPeerAfterBackground(60_000)).toEqual({
      status: 'stale-connection-closed',
    });
    setState('network.hostConn', null);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.showDialog).not.toHaveBeenCalled();
  });

  it('publishes exhaustion after the fifth unsuccessful signaling attempt', async () => {
    vi.useFakeTimers();
    const peer = makePeer('STANDARD-HOST', true);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);
    await createHostSessionWithShortCode(1);
    setState('setup.sessionStarted', true);
    setState('network.connectedPeers', [
      {
        id: 'guest-1',
        slot: 1,
        label: 'Guest',
        joinOrder: 1,
        status: 'connected',
        isOp: false,
        preloadedQueueItemIds: new Set(),
        isDataTarget: true,
        connectionType: 'local',
        lastHeartbeat: Date.now(),
        conn: { open: true } as DataConnection,
      },
    ]);

    peer.fire('disconnected');
    await vi.advanceTimersByTimeAsync(30_000);

    expect(peer.reconnect).toHaveBeenCalledTimes(5);
    expect(getState('network.signalingHealth')).toEqual({
      status: 'exhausted',
      attempt: 0,
      maxAttempts: 5,
    });
    expect(mocks.showDialog).not.toHaveBeenCalled();
  });

  it('keeps ordinary-room signaling reconnect independent of the PRO ticket hook', async () => {
    const peer = makePeer('STANDARD-HOST', true);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);
    const prepareFreshTicket = vi.fn(async () => true);
    registerProRoomSignalingReconnectHandler(prepareFreshTicket);
    await createHostSessionWithShortCode(1);
    vi.useFakeTimers();

    peer.fire('disconnected');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(peer.reconnect).toHaveBeenCalledOnce();
    expect(prepareFreshTicket).not.toHaveBeenCalled();
  });

  it('surfaces a guest peer initialization error exactly once', async () => {
    const pendingPeer = makePeer('GUEST-INIT', false);
    const errors = vi.fn();
    bus.on('network:error', errors);
    setState('network.appRole', 'guest');
    mocks.createTransportPeer.mockResolvedValueOnce(pendingPeer);

    joinSession('HOST01');
    await waitForTransportCalls(1);
    await vi.waitFor(() => expect(getPeer()).toBe(pendingPeer));

    pendingPeer.fire('error', {
      type: 'socket-error',
      message: 'SIGNALING_START_FAILED',
    });

    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toMatchObject({
      type: 'socket-error',
      message: 'SIGNALING_START_FAILED',
    });
    expect(getState('network.isConnecting')).toBe(false);
    expect(pendingPeer.destroy).toHaveBeenCalledOnce();
  });

  it('settles peer-open immediately when setup cancellation clears its timeout', async () => {
    const pendingPeer = makePeer('HOST-A', false);
    mocks.createTransportPeer.mockResolvedValueOnce(pendingPeer);

    const init = createHostSessionWithShortCode(1);
    await waitForTransportCalls(1);
    await vi.waitFor(() => expect(getPeer()).toBe(pendingPeer));

    markLocalSystemAudioSfuCapable('stale-capability');
    claimGuestDirectSystemAudioRoute();
    cancelPendingSessionSetup();

    await expect(init).rejects.toThrow('NETWORK_INIT_CANCELLED');
    expect(pendingPeer.destroy).toHaveBeenCalled();
    expect(getPeer()).toBeNull();
    expect(getSystemAudioShareDeliverySnapshot().capablePeerIds).toEqual([]);
    expect(getGuestSystemAudioShareRoute()).toBe('unselected');
  });

  it('invalidates a pending peer-open when the session is left', async () => {
    const pendingPeer = makePeer('HOST-LEAVE', false);
    mocks.createTransportPeer.mockResolvedValueOnce(pendingPeer);

    const init = createHostSessionWithShortCode(1);
    await waitForTransportCalls(1);
    await vi.waitFor(() => expect(getPeer()).toBe(pendingPeer));

    markLocalSystemAudioSfuCapable('stale-capability');
    claimGuestDirectSystemAudioRoute();
    leaveSession();

    await expect(init).rejects.toThrow('NETWORK_INIT_CANCELLED');
    expect(pendingPeer.destroy).toHaveBeenCalled();
    expect(getPeer()).toBeNull();
    expect(getState('network.appRole')).toBe('idle');
    expect(getSystemAudioShareDeliverySnapshot().capablePeerIds).toEqual([]);
    expect(getGuestSystemAudioShareRoute()).toBe('unselected');
  });

  it('lets a new host init supersede an older peer-open without an explicit cancel', async () => {
    const peerA = makePeer('HOST-A', false);
    const peerB = makePeer('HOST-B', true);
    mocks.createTransportPeer.mockResolvedValueOnce(peerA).mockResolvedValueOnce(peerB);

    const initA = createHostSessionWithShortCode(1);
    const initAResult = initA.catch((error: unknown) => error);
    await waitForTransportCalls(1);
    await vi.waitFor(() => expect(getPeer()).toBe(peerA));

    const initB = createHostSessionWithShortCode(1);
    await waitForTransportCalls(2);

    await expect(initAResult).resolves.toMatchObject({ message: 'NETWORK_INIT_CANCELLED' });
    await expect(initB).resolves.toMatch(/^\d{6}$/);
    expect(peerA.destroy).toHaveBeenCalled();
    expect(getPeer()).toBe(peerB);
    expect(getState('network.myId')).toBe('HOST-B');
  });

  it('does not let an old peer reconnect timer act on its replacement', async () => {
    vi.useFakeTimers();
    const peerA = makePeer('HOST-A', true);
    const peerB = makePeer('HOST-B', true);
    mocks.createTransportPeer.mockResolvedValueOnce(peerA).mockResolvedValueOnce(peerB);

    const firstCode = await createHostSessionWithShortCode(1);
    setState('network.sessionCode', firstCode);
    setState('setup.sessionStarted', true);
    peerA.fire('disconnected');

    await createHostSessionWithShortCode(1);
    setState('network.sessionCode', '654321');
    setState('setup.sessionStarted', true);
    peerB.disconnected = true;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(getPeer()).toBe(peerB);
    expect(peerA.reconnect).not.toHaveBeenCalled();
    expect(peerB.reconnect).not.toHaveBeenCalled();
  });

  it('does not let an old peer grace timer evaluate its replacement', async () => {
    vi.useFakeTimers();
    const peerA = makePeer('HOST-A', true);
    const peerB = makePeer('HOST-B', true);
    mocks.createTransportPeer.mockResolvedValueOnce(peerA).mockResolvedValueOnce(peerB);

    const firstCode = await createHostSessionWithShortCode(1);
    setState('network.sessionCode', firstCode);
    setState('setup.sessionStarted', true);
    peerA.fire('disconnected');

    await createHostSessionWithShortCode(1);
    setState('network.sessionCode', '654321');
    setState('setup.sessionStarted', true);

    // Let A's reconnect timer expire while B is healthy, then disconnect only
    // B before A's grace period expires. A's grace must not evaluate B.
    await vi.advanceTimersByTimeAsync(1_000);
    peerB.disconnected = true;
    setState('network.appRole', 'guest');
    setState('network.hostConn', null);
    await vi.advanceTimersByTimeAsync(4_000);

    expect(getPeer()).toBe(peerB);
    expect(mocks.showDialog).not.toHaveBeenCalled();
  });

  it('does not let host A publish after cancellation and host B succeeds', async () => {
    const lateA = deferred<PeerInstance>();
    const peerA = makePeer('HOST-A', true);
    const peerB = makePeer('HOST-B', true);
    const ready = vi.fn();
    bus.on('network:peer-ready', ready);
    mocks.createTransportPeer
      .mockImplementationOnce(() => lateA.promise)
      .mockResolvedValueOnce(peerB);

    const initA = createHostSessionWithShortCode(1);
    await waitForTransportCalls(1);

    cancelPendingSessionSetup();
    setState('network.appRole', 'host');
    const initB = createHostSessionWithShortCode(1);
    await waitForTransportCalls(2);
    await expect(initB).resolves.toMatch(/^\d{6}$/);

    lateA.resolve(peerA);
    await expect(initA).rejects.toThrow('NETWORK_INIT_CANCELLED');

    expect(peerA.destroy).toHaveBeenCalledOnce();
    expect(getPeer()).toBe(peerB);
    expect(getState('network.myId')).toBe('HOST-B');
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith('HOST-B');
  });
});
