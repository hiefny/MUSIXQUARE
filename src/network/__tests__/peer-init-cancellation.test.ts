/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type { PeerInstance } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  createTransportPeer: vi.fn(),
  fetchWithCapability: vi.fn(),
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
  getRuntimeTransportConfig: () => ({
    provider: 'cloudflare' as const,
    signalingUrl: 'https://signal.example.test/api/rooms',
  }),
}));

import { getPeer, setPeer } from '../peer-state.ts';
import {
  cancelPendingSessionSetup,
  connectProRoomTransport,
  createHostSessionWithShortCode,
  disconnectProRoomTransport,
  joinSession,
  leaveSession,
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
};

function makePeer(id: string, initiallyOpen: boolean): FiringPeer {
  const handlers = new Map<string, Set<(...args: never[]) => void>>();
  const peer = {
    id,
    open: initiallyOpen,
    destroyed: false,
    disconnected: false,
    connect: vi.fn(),
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
  clearAllManagedTimers();
  resetState();
  setPeer(null);
  bus.clear();
  vi.clearAllMocks();
  setState('network.appRole', 'host');
  setState('setup.sessionStarted', false);
  mocks.fetchWithCapability.mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      provider: 'test',
      iceServers: [{ urls: 'turn:turn.example.test:3478' }],
    }),
  });
});

afterEach(() => {
  setState('setup.sessionStarted', false);
  cancelPendingSessionSetup();
  clearAllManagedTimers();
  setPeer(null);
});

describe('network initialization ownership', () => {
  it('opens an authenticated PRO coordinator without entering the standard room flow', async () => {
    const peer = makePeer('000001', true);
    mocks.createTransportPeer.mockResolvedValueOnce(peer);
    const access = {
      roomCode: '000001',
      ticket: `${'a'.repeat(32)}.${'b'.repeat(43)}`,
      role: 'coordinator' as const,
      coordinatorEpoch: 4,
    };

    await connectProRoomTransport(access);

    expect(mocks.createTransportPeer).toHaveBeenCalledWith(
      '000001',
      expect.objectContaining({ proSignaling: access, provider: 'cloudflare' }),
    );
    expect(getState('network.appRole')).toBe('host');
    expect(getState('network.sessionCode')).toBe('000001');
    expect(getState('network.maxGuestSlots')).toBe(32);

    disconnectProRoomTransport();
    expect(peer.destroy).toHaveBeenCalled();
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

    cancelPendingSessionSetup();

    await expect(init).rejects.toThrow('NETWORK_INIT_CANCELLED');
    expect(pendingPeer.destroy).toHaveBeenCalled();
    expect(getPeer()).toBeNull();
  });

  it('invalidates a pending peer-open when the session is left', async () => {
    const pendingPeer = makePeer('HOST-LEAVE', false);
    mocks.createTransportPeer.mockResolvedValueOnce(pendingPeer);

    const init = createHostSessionWithShortCode(1);
    await waitForTransportCalls(1);
    await vi.waitFor(() => expect(getPeer()).toBe(pendingPeer));

    leaveSession();

    await expect(init).rejects.toThrow('NETWORK_INIT_CANCELLED');
    expect(pendingPeer.destroy).toHaveBeenCalled();
    expect(getPeer()).toBeNull();
    expect(getState('network.appRole')).toBe('idle');
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
