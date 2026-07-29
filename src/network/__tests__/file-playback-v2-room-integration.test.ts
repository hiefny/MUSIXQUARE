/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataConnection, PeerInstance } from '../../types/index.ts';

const mocks = vi.hoisted(() => {
  const applicationState = { established: false };
  const applicationSessions = {
    beginHostConnection: vi.fn(() => true),
    beginGuestConnection: vi.fn(() => true),
    sendRequired: vi.fn(() => true),
    receive: vi.fn(() => ({
      handled: true,
      established: applicationState.established,
      clockBecameReady: false,
      updateRequired: false,
    })),
    establishedChannel: vi.fn(() => (applicationState.established ? Object.freeze({}) : null)),
    phase: vi.fn(() => (applicationState.established ? 'established' : 'handshaking')),
    closeConnection: vi.fn(),
  };
  const productRuntime = {
    enabled: vi.fn(() => true),
    beginGuestRoom: vi.fn(() => true),
    endRoom: vi.fn(),
  };
  return {
    applicationState,
    applicationSessions,
    productRuntime,
    getPeer: vi.fn(),
    detectConnectionType: vi.fn(() => Promise.resolve('local' as const)),
    startWorkerTimer: vi.fn(),
    showToast: vi.fn(),
  };
});

vi.mock('../../player/file-playback-engine-gate.ts', () => ({
  isFilePlaybackEngineV2Enabled: () => true,
  getFilePlaybackEngineMode: () => 'v2',
}));

vi.mock('../file-playback-application-session.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../file-playback-application-session.ts')>();
  return {
    ...actual,
    getFilePlaybackApplicationSessionManager: () => mocks.applicationSessions,
  };
});

vi.mock('../../player/file-playback-product-runtime.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../player/file-playback-product-runtime.ts')>();
  return {
    ...actual,
    getFilePlaybackProductRuntime: () => mocks.productRuntime,
  };
});

vi.mock('../peer-state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../peer-state.ts')>();
  return {
    ...actual,
    getPeer: mocks.getPeer,
    detectConnectionType: mocks.detectConnectionType,
  };
});

vi.mock('../sync-worker.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync-worker.ts')>();
  return { ...actual, startWorkerTimer: mocks.startWorkerTimer };
});

vi.mock('../../ui/toast.ts', () => ({ showToast: mocks.showToast }));
vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { t } from '../../i18n/index.ts';
import { invalidateGuestJoinAttempt, joinSession } from '../guest.ts';
import { handleHostIncomingConnection } from '../host.ts';

type FiringConnection = DataConnection & {
  readonly fire: (event: string, ...args: unknown[]) => void;
  open: boolean;
};

function makeConnection(peerId: string): FiringConnection {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const conn = {
    peer: peerId,
    open: false,
    send: vi.fn(),
    close: vi.fn(() => {
      conn.open = false;
    }),
    off: vi.fn((event: string, callback: (...args: unknown[]) => void) => {
      const current = handlers.get(event) ?? [];
      handlers.set(
        event,
        current.filter((candidate) => candidate !== callback),
      );
    }),
    on(event: string, callback: (...args: unknown[]) => void) {
      const current = handlers.get(event) ?? [];
      current.push(callback);
      handlers.set(event, current);
    },
    fire(event: string, ...args: unknown[]) {
      if (event === 'open') conn.open = true;
      if (event === 'close') conn.open = false;
      for (const callback of [...(handlers.get(event) ?? [])]) callback(...args);
    },
  };
  return conn as unknown as FiringConnection;
}

function standardRoom(): void {
  setState('room.context', {
    kind: 'standard',
    roomId: null,
    role: 'idle',
    coordinatorId: null,
    epoch: 0,
    snapshotRevision: 0,
    capabilities: [],
  });
}

beforeEach(() => {
  clearAllManagedTimers();
  resetState();
  bus.clear();
  vi.clearAllMocks();
  mocks.applicationState.established = false;
  mocks.applicationSessions.beginHostConnection.mockReturnValue(true);
  mocks.applicationSessions.beginGuestConnection.mockReturnValue(true);
  mocks.applicationSessions.sendRequired.mockReturnValue(true);
  mocks.applicationSessions.receive.mockImplementation(() => ({
    handled: true,
    established: mocks.applicationState.established,
    clockBecameReady: false,
    updateRequired: false,
  }));
  mocks.applicationSessions.establishedChannel.mockImplementation(() =>
    mocks.applicationState.established ? (Object.freeze({}) as never) : null,
  );
  mocks.productRuntime.beginGuestRoom.mockReturnValue(true);
  standardRoom();
});

afterEach(() => {
  invalidateGuestJoinAttempt();
  clearAllManagedTimers();
});

describe('standard-room V2 application admission', () => {
  it('keeps a host peer handshaking until the exact application session is established', () => {
    setState('network.appRole', 'host');
    setState('network.myId', 'HOST01');
    const conn = makeConnection('guest-v2');
    const connected = vi.fn();
    bus.on('network:peer-connected', connected);

    handleHostIncomingConnection(conn);
    conn.fire('open');

    expect(mocks.applicationSessions.beginHostConnection).toHaveBeenCalledWith(conn, conn.peer);
    expect(mocks.applicationSessions.sendRequired).toHaveBeenCalledWith(
      conn,
      expect.objectContaining({ type: MSG.WELCOME }),
    );
    expect(connected).not.toHaveBeenCalled();
    expect(getState('network.connectedPeers').find((peer) => peer.id === conn.peer)?.status).toBe(
      'handshaking',
    );

    mocks.applicationState.established = true;
    conn.fire('data', { type: 'file-playback-test-established' });

    expect(connected).toHaveBeenCalledOnce();
    expect(connected).toHaveBeenCalledWith(conn);
    expect(getState('network.connectedPeers').find((peer) => peer.id === conn.peer)?.status).toBe(
      'connected',
    );
  });

  it('keeps guest join UI pending until APPLIED and starts sync only after establishment', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'guest-v2');
    const conn = makeConnection('HOST01');
    mocks.getPeer.mockReturnValue({
      open: true,
      connect: vi.fn(() => conn),
    } as unknown as PeerInstance);
    const connected = vi.fn();
    const joined = vi.fn();
    bus.on('network:peer-connected', connected);
    bus.on('setup:guest-join-success', joined);

    joinSession('HOST01');
    expect(mocks.productRuntime.beginGuestRoom).toHaveBeenCalledOnce();
    conn.fire('open');

    expect(mocks.applicationSessions.beginGuestConnection).toHaveBeenCalledWith(conn, 'guest-v2');
    expect(getState('network.hostConn')).toBe(conn);
    expect(getState('network.isConnecting')).toBe(true);
    expect(connected).not.toHaveBeenCalled();
    expect(joined).not.toHaveBeenCalled();
    expect(mocks.startWorkerTimer).not.toHaveBeenCalled();

    mocks.applicationState.established = true;
    conn.fire('data', { type: 'file-playback-test-established' });

    expect(getState('network.isConnecting')).toBe(false);
    expect(connected).toHaveBeenCalledWith(conn);
    expect(joined).toHaveBeenCalledOnce();
    expect(mocks.startWorkerTimer).toHaveBeenCalledWith('sync', 1000);
  });

  it('publishes a version mismatch as one persistent inline failure without a toast', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'guest-v2');
    const conn = makeConnection('HOST01');
    mocks.getPeer.mockReturnValue({
      open: true,
      connect: vi.fn(() => conn),
    } as unknown as PeerInstance);
    const failure = vi.fn();
    bus.on('setup:guest-join-failure', failure);
    mocks.applicationSessions.receive.mockReturnValueOnce({
      handled: true,
      established: false,
      clockBecameReady: false,
      updateRequired: true,
    });

    joinSession('HOST01');
    conn.fire('open');
    conn.fire('data', { type: 'file-playback-test-version-mismatch' });

    expect(failure).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: 'FILE_PLAYBACK_UPDATE_REQUIRED' }),
      userMessage: t('error.app_version_mismatch'),
    });
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('publishes a failed handshake as one persistent inline failure without a toast', () => {
    setState('network.appRole', 'guest');
    setState('network.myId', 'guest-v2');
    const conn = makeConnection('HOST01');
    mocks.getPeer.mockReturnValue({
      open: true,
      connect: vi.fn(() => conn),
    } as unknown as PeerInstance);
    const failure = vi.fn();
    bus.on('setup:guest-join-failure', failure);

    joinSession('HOST01');
    conn.fire('open');
    conn.fire('close');

    expect(failure).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: 'FILE_PLAYBACK_HANDSHAKE_FAILED' }),
      userMessage: t('error.session_handshake_failed'),
    });
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});

describe('PRO isolation', () => {
  it('never creates a V2 application session for a PRO transport', () => {
    setState('room.context', {
      kind: 'pro',
      roomId: '000001',
      role: 'coordinator',
      coordinatorId: 'HOST01',
      epoch: 1,
      snapshotRevision: 1,
      capabilities: [],
    });
    setState('network.appRole', 'host');
    setState('network.myId', 'HOST01');
    const conn = makeConnection('pro-controller');
    const connected = vi.fn();
    bus.on('network:peer-connected', connected);

    handleHostIncomingConnection(conn);
    conn.fire('open');

    expect(connected).toHaveBeenCalledWith(conn);
    expect(mocks.applicationSessions.beginHostConnection).not.toHaveBeenCalled();
    expect(mocks.applicationSessions.sendRequired).not.toHaveBeenCalled();
    expect(mocks.applicationSessions.receive).not.toHaveBeenCalled();
    expect(mocks.productRuntime.beginGuestRoom).not.toHaveBeenCalled();
  });
});
