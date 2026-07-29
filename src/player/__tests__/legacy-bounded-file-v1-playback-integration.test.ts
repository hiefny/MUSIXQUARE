/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import { clearAllManagedTimers } from '../../core/timers.ts';
import type {
  ConnectedPeer,
  DataConnection,
  PlaylistItem,
  QueueItemId,
  ResidentFile,
} from '../../types/index.ts';
import { setPlaybackFilePlaying } from '../ownership.ts';

const QID = '00000000-0000-4000-8000-000000000101' as QueueItemId;
const LEGACY_SESSION_ID = 41;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
  delivery: 'direct' as 'direct' | 'pending' | 'r2' | 'unsupported',
  hostNow: 10_000,
  productSnapshot: null as unknown,
  offerTasks: new WeakMap<object, Map<string, Promise<unknown>>>(),
  fallbackDispatcher: null as
    | null
    | ((connection: object, commit: Readonly<Record<string, unknown>>) => Promise<void>),
  initialize: vi.fn(() => true),
  registerLegacyFallbackDispatcher: vi.fn(),
  registerGuestDescriptorObserver: vi.fn(() => vi.fn()),
  snapshot: vi.fn(),
  offerHostCurrentSettled: vi.fn(),
  ownsSession: vi.fn(),
  positionSeconds: vi.fn(),
  durationSeconds: vi.fn(),
  applyControl: vi.fn(),
  resolvePeerFileDelivery: vi.fn(),
  markLateLocalPeerForR2: vi.fn(),
  unicastFile: vi.fn(),
  shareRemoteFileIfNeeded: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock('../legacy-bounded-file-v1-product.ts', () => ({
  legacyBoundedFileV1Product: {
    initialize: mocks.initialize,
    registerLegacyFallbackDispatcher: mocks.registerLegacyFallbackDispatcher,
    registerGuestDescriptorObserver: mocks.registerGuestDescriptorObserver,
    snapshot: mocks.snapshot,
    offerHostCurrentSettled: mocks.offerHostCurrentSettled,
    ownsSession: mocks.ownsSession,
    positionSeconds: mocks.positionSeconds,
    durationSeconds: mocks.durationSeconds,
    applyControl: mocks.applyControl,
  },
}));

vi.mock('../../share/file-delivery-policy.ts', () => ({
  isGuestR2FileDelivery: vi.fn(() => false),
  markLateLocalPeerForR2: mocks.markLateLocalPeerForR2,
  resolvePeerFileDelivery: mocks.resolvePeerFileDelivery,
}));

vi.mock('../../storage/transfer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/transfer.ts')>();
  return {
    ...actual,
    handleLegacyBoundedV1GuestDescriptorEvent: vi.fn(),
    unicastFile: mocks.unicastFile,
  };
});

vi.mock('../../share/remote-share.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../share/remote-share.ts')>();
  return {
    ...actual,
    shareRemoteFileIfNeeded: mocks.shareRemoteFileIfNeeded,
  };
});

vi.mock('../../network/shared-clock.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../network/shared-clock.ts')>();
  return {
    ...actual,
    getHostNow: vi.fn(() => mocks.hostNow),
  };
});

vi.mock('../../network/peer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../network/peer.ts')>();
  return {
    ...actual,
    broadcast: mocks.broadcast,
    isRemoteGuest: vi.fn(() => false),
    safeSend: vi.fn((connection: DataConnection, frame: unknown) => {
      if (!connection.open) return false;
      connection.send(frame);
      return true;
    }),
  };
});

const { initPlayback, offerLegacyBoundedV1CurrentToPeer } = await import('../playback.ts');

function productSnapshot(
  phase: 'idle' | 'playing' | 'paused' | 'stopped' = 'stopped',
  positionSeconds = 0,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: 1,
    active: true,
    role: 'host',
    roomKind: 'standard',
    roomEpoch: 'room-epoch-1',
    generation: 1,
    current: Object.freeze({
      queueItemId: QID,
      legacySessionId: LEGACY_SESSION_ID,
      state: 'ready',
      phase,
      positionSeconds,
      durationSeconds: 180,
      pendingControl: null,
    }),
    hostConnections: 1,
    guestCapabilityAnnounced: false,
  });
}

function playlistItem(): PlaylistItem {
  return {
    queueItemId: QID,
    type: 'file',
    name: 'bounded.mp3',
    title: 'Bounded',
    videoId: null,
    playlistId: null,
  };
}

function connection(peer = 'guest-1'): DataConnection {
  return {
    open: true,
    peer,
    send: vi.fn(),
  } as unknown as DataConnection;
}

function arrangeHostCurrent(
  conn: DataConnection,
  options: Readonly<{
    isDataTarget?: boolean;
    phase?: 'idle' | 'playing' | 'paused' | 'stopped';
  }> = {},
): ResidentFile {
  const blob = new File(['bounded-payload'], 'bounded.mp3', { type: 'audio/mpeg' });
  const resident: ResidentFile = {
    queueItemId: QID,
    indexHint: 0,
    name: blob.name,
    sessionId: LEGACY_SESSION_ID,
    blob,
    mime: blob.type,
    size: blob.size,
  };
  const peer: ConnectedPeer = {
    id: conn.peer,
    slot: 1,
    label: 'Guest 1',
    conn,
    isOp: false,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: options.isDataTarget ?? true,
    joinOrder: 1,
    connectionType: 'local',
    lastHeartbeat: 0,
  };
  mocks.productSnapshot = productSnapshot(options.phase);
  setState('playlist.items', [playlistItem()]);
  setState('playlist.currentQueueItemId', QID);
  setState('files.current', resident);
  setState('network.connectedPeers', [peer]);
  return resident;
}

beforeEach(() => {
  resetState();
  bus.clear();
  clearAllManagedTimers();
  vi.clearAllMocks();

  mocks.delivery = 'direct';
  mocks.hostNow = 10_000;
  mocks.productSnapshot = productSnapshot();
  mocks.offerTasks = new WeakMap();
  mocks.snapshot.mockImplementation(() => mocks.productSnapshot);
  mocks.positionSeconds.mockImplementation(() => {
    const current = (mocks.productSnapshot as { current?: { positionSeconds?: number } }).current;
    return current?.positionSeconds ?? null;
  });
  mocks.durationSeconds.mockReturnValue(180);
  mocks.resolvePeerFileDelivery.mockImplementation(() => mocks.delivery);
  mocks.ownsSession.mockImplementation(
    (queueItemId: QueueItemId, legacySessionId: number) =>
      queueItemId === QID && legacySessionId === LEGACY_SESSION_ID,
  );
  mocks.unicastFile.mockResolvedValue(undefined);
  mocks.shareRemoteFileIfNeeded.mockResolvedValue(undefined);
  mocks.registerLegacyFallbackDispatcher.mockImplementation((dispatcher) => {
    mocks.fallbackDispatcher = dispatcher;
    return vi.fn();
  });
  mocks.offerHostCurrentSettled.mockImplementation(
    (conn: object, queueItemId: QueueItemId, legacySessionId: number) => {
      let tasks = mocks.offerTasks.get(conn);
      if (!tasks) {
        tasks = new Map();
        mocks.offerTasks.set(conn, tasks);
      }
      const key = `${queueItemId}:${legacySessionId}`;
      const existing = tasks.get(key);
      if (existing) return existing;
      const task = (async () => {
        if (!mocks.fallbackDispatcher) {
          throw new Error('fallback dispatcher was not registered');
        }
        await mocks.fallbackDispatcher(conn, {
          queueItemId,
          legacySessionId,
          purpose: 'current',
          reason: 'capability-timeout',
        });
        return Object.freeze({ status: 'legacy-committed' });
      })();
      tasks.set(key, task);
      return task;
    },
  );

  initPlayback();
});

afterEach(() => {
  // Reject any intentionally parked delivery-route waiter before clearing the
  // bus, so one test cannot leak a promise into the next room incarnation.
  bus.emit('state:network.sessionCode', '__test-cleanup__', 'network.sessionCode');
  clearAllManagedTimers();
});

describe('bounded V1 stable-fallback settlement', () => {
  it('settles at the exact FILE_PREPARE boundary without waiting for the full payload', async () => {
    const conn = connection();
    const resident = arrangeHostCurrent(conn);
    const payload = deferred<void>();
    mocks.unicastFile.mockReturnValueOnce(payload.promise);

    const offered = offerLegacyBoundedV1CurrentToPeer(conn);

    await expect(offered).resolves.toBe(true);
    expect(conn.send).toHaveBeenCalledWith({
      type: MSG.FILE_PREPARE,
      name: resident.name,
      queueItemId: QID,
      sessionId: LEGACY_SESSION_ID,
      size: resident.blob.size,
      mime: resident.mime,
      autoPlayDelayMs: 0,
    });
    expect(mocks.unicastFile).toHaveBeenCalledOnce();

    // The payload is deliberately still unresolved. The settlement barrier is
    // the ordered selection/control boundary, not a whole-file transfer wait.
    let payloadSettled = false;
    void payload.promise.then(() => {
      payloadSettled = true;
    });
    await Promise.resolve();
    expect(payloadSettled).toBe(false);

    payload.resolve();
    await payload.promise;
  });

  it.each(['guest-fallback', 'descriptor-result-timeout'] as const)(
    'replays the current timeline behind a late %s selection fallback',
    async (reason) => {
      const conn = connection();
      arrangeHostCurrent(conn, { phase: 'playing' });
      mocks.productSnapshot = productSnapshot('playing', 23.5);
      if (!mocks.fallbackDispatcher) throw new Error('fallback dispatcher was not registered');

      await mocks.fallbackDispatcher(conn, {
        queueItemId: QID,
        legacySessionId: LEGACY_SESSION_ID,
        purpose: 'current',
        reason,
      });

      expect(conn.send).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: MSG.FILE_PREPARE,
          queueItemId: QID,
          sessionId: LEGACY_SESSION_ID,
        }),
      );
      expect(conn.send).toHaveBeenNthCalledWith(2, {
        type: MSG.PLAY,
        time: 23.5,
        queueItemId: QID,
        hostPlayAt: 10_200,
      });
    },
  );

  it('keeps a pending route parked, then flushes and settles without self-deadlock', async () => {
    const conn = connection();
    arrangeHostCurrent(conn, { isDataTarget: false });
    mocks.delivery = 'pending';

    let settled = false;
    const offered = offerLegacyBoundedV1CurrentToPeer(conn).then((value) => {
      settled = true;
      return value;
    });

    await vi.waitFor(() => {
      expect(mocks.resolvePeerFileDelivery).toHaveBeenCalled();
    });
    expect(settled).toBe(false);
    expect(conn.send).not.toHaveBeenCalled();

    mocks.delivery = 'direct';
    const [peer] = getState('network.connectedPeers');
    if (!peer) throw new Error('connected peer is missing');
    setState('network.connectedPeers', [{ ...peer, isDataTarget: true }]);
    bus.emit('orchestrator:peer-data-target-ready', conn.peer);

    await expect(offered).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(mocks.unicastFile).toHaveBeenCalledOnce();
    });
    expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_PREPARE }));
  });

  it('settles every same-key waiter created re-entrantly during flush', async () => {
    const conn = connection();
    arrangeHostCurrent(conn, { isDataTarget: false });
    mocks.delivery = 'pending';
    if (!mocks.fallbackDispatcher) throw new Error('fallback dispatcher was not registered');
    const commit = {
      queueItemId: QID,
      legacySessionId: LEGACY_SESSION_ID,
      purpose: 'current',
      reason: 'capability-timeout',
    } as const;

    const detachedFallback = mocks.fallbackDispatcher(conn, commit);
    await vi.waitFor(() => {
      expect(mocks.resolvePeerFileDelivery).toHaveBeenCalledOnce();
    });

    let callsAfterParking = 0;
    let reentrantFallback: Promise<void> | null = null;
    mocks.resolvePeerFileDelivery.mockImplementation(() => {
      callsAfterParking += 1;
      // First call: offerHostCurrentSettled joins the parked waiter.
      // Second call: the flush probes the parked entry. Re-enter at that exact
      // point so another caller joins the same key while the pass is active.
      if (callsAfterParking === 2) {
        reentrantFallback = mocks.fallbackDispatcher!(conn, commit);
      }
      return mocks.delivery;
    });

    bus.emit('orchestrator:peer-data-target-ready', conn.peer);
    await vi.waitFor(() => {
      expect(reentrantFallback).not.toBeNull();
    });

    let detachedSettled = false;
    void detachedFallback.then(() => {
      detachedSettled = true;
    });
    await Promise.resolve();
    expect(detachedSettled).toBe(false);

    mocks.delivery = 'direct';
    const [peer] = getState('network.connectedPeers');
    if (!peer) throw new Error('connected peer is missing');
    setState('network.connectedPeers', [{ ...peer, isDataTarget: true }]);
    bus.emit('orchestrator:peer-data-target-ready', conn.peer);

    await expect(detachedFallback).resolves.toBeUndefined();
    await expect(reentrantFallback!).resolves.toBeUndefined();
    expect(conn.send).toHaveBeenCalledWith(expect.objectContaining({ type: MSG.FILE_PREPARE }));
    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(mocks.unicastFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'peer disconnect',
      reject: (conn: DataConnection) => bus.emit('network:peer-disconnected', conn.peer),
      message: 'peer disconnected',
    },
    {
      label: 'room incarnation change',
      reject: () => bus.emit('state:network.sessionCode', 'NEW001', 'network.sessionCode'),
      message: 'room incarnation changed',
    },
  ])('rejects a pending fallback on $label', async ({ reject, message }) => {
    const conn = connection();
    arrangeHostCurrent(conn, { isDataTarget: false });
    mocks.delivery = 'pending';

    const offered = offerLegacyBoundedV1CurrentToPeer(conn).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(mocks.resolvePeerFileDelivery).toHaveBeenCalled();
    });

    reject(conn);

    const error = await offered;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('rejects only the superseded exact connection when the same peer reconnects', async () => {
    const oldConnection = connection('reconnecting-guest');
    const newConnection = connection('reconnecting-guest');
    const resident = arrangeHostCurrent(oldConnection, { isDataTarget: false });
    const [oldPeer] = getState('network.connectedPeers');
    if (!oldPeer) throw new Error('old connected peer is missing');
    setState('network.connectedPeers', [
      oldPeer,
      {
        ...oldPeer,
        conn: newConnection,
        joinOrder: 2,
      },
    ]);
    mocks.delivery = 'pending';
    if (!mocks.fallbackDispatcher) throw new Error('fallback dispatcher was not registered');

    const oldFallback = mocks
      .fallbackDispatcher(oldConnection, {
        queueItemId: QID,
        legacySessionId: LEGACY_SESSION_ID,
        purpose: 'current',
        reason: 'capability-timeout',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    const newFallback = mocks.fallbackDispatcher(newConnection, {
      queueItemId: QID,
      legacySessionId: LEGACY_SESSION_ID,
      purpose: 'current',
      reason: 'capability-timeout',
    });
    let newSettled = false;
    void newFallback.finally(() => {
      newSettled = true;
    });

    await vi.waitFor(() => {
      expect(mocks.resolvePeerFileDelivery).toHaveBeenCalledTimes(2);
    });
    setState('network.activeHostConnByPeerId', new Map([[newConnection.peer, newConnection]]));

    bus.emit('network:peer-connection-replaced', oldConnection.peer);

    const error = await oldFallback;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('connection was replaced');
    expect(newSettled).toBe(false);
    expect(oldConnection.send).not.toHaveBeenCalled();
    expect(newConnection.send).not.toHaveBeenCalled();

    mocks.delivery = 'direct';
    setState('network.connectedPeers', [
      {
        ...oldPeer,
        conn: newConnection,
        isDataTarget: true,
        joinOrder: 2,
      },
    ]);
    bus.emit('orchestrator:peer-data-target-ready', newConnection.peer);

    await expect(newFallback).resolves.toBeUndefined();
    expect(newConnection.send).toHaveBeenCalledWith({
      type: MSG.FILE_PREPARE,
      name: resident.name,
      queueItemId: QID,
      sessionId: LEGACY_SESSION_ID,
      size: resident.blob.size,
      mime: resident.mime,
      autoPlayDelayMs: 0,
    });
  });

  it('rejects an earlier parked fallback when a later attempt observes the closed connection', async () => {
    const conn = connection();
    arrangeHostCurrent(conn, { isDataTarget: false });
    mocks.delivery = 'pending';
    if (!mocks.fallbackDispatcher) throw new Error('fallback dispatcher was not registered');

    const offered = offerLegacyBoundedV1CurrentToPeer(conn).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(mocks.resolvePeerFileDelivery).toHaveBeenCalledOnce();
    });

    conn.open = false;
    await expect(
      mocks.fallbackDispatcher(conn, {
        queueItemId: QID,
        legacySessionId: LEGACY_SESSION_ID,
        purpose: 'preload',
        reason: 'capability-timeout',
      }),
    ).rejects.toThrow('connection is closed');

    const error = await offered;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('connection is closed');
  });
});

describe('bounded V1 late-join timeline ordering', () => {
  it('uses canonical scheduled-playing phase while semantic UI activity still looks stopped', async () => {
    const conn = connection();
    arrangeHostCurrent(conn, { phase: 'playing' });
    mocks.productSnapshot = productSnapshot('playing', 17.25);
    const settlement = deferred<Readonly<{ status: 'descriptor-sent' }>>();
    mocks.offerHostCurrentSettled.mockReturnValueOnce(settlement.promise);

    bus.emit('network:peer-connected', conn);

    expect(mocks.offerHostCurrentSettled).toHaveBeenCalledWith(conn, QID, LEGACY_SESSION_ID);
    expect(conn.send).not.toHaveBeenCalled();

    settlement.resolve(Object.freeze({ status: 'descriptor-sent' }));

    await vi.waitFor(() => {
      expect(conn.send).toHaveBeenCalledOnce();
    });
    expect(conn.send).toHaveBeenCalledWith({
      type: MSG.PLAY,
      time: 17.25,
      queueItemId: QID,
      name: 'bounded.mp3',
      hostPlayAt: 10_200,
    });
  });

  it('uses canonical paused phase instead of stale playing UI activity', async () => {
    const conn = connection();
    arrangeHostCurrent(conn, { phase: 'paused' });
    mocks.productSnapshot = productSnapshot('paused', 41.5);
    setPlaybackFilePlaying();
    const settlement = deferred<Readonly<{ status: 'descriptor-sent' }>>();
    mocks.offerHostCurrentSettled.mockReturnValueOnce(settlement.promise);

    bus.emit('network:peer-connected', conn);
    expect(conn.send).not.toHaveBeenCalled();

    settlement.resolve(Object.freeze({ status: 'descriptor-sent' }));

    await vi.waitFor(() => {
      expect(conn.send).toHaveBeenCalledOnce();
    });
    expect(conn.send).toHaveBeenCalledWith({
      type: MSG.PAUSE,
      time: 41.5,
      queueItemId: QID,
      reason: 'pause',
    });
  });
});
