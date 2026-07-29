import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataConnection } from '../../types/index.ts';

const mocks = vi.hoisted(() => {
  const runtime = {
    beginHostRoom: vi.fn(),
    beginGuestRoom: vi.fn(),
    endRoom: vi.fn(),
    retireConnection: vi.fn(),
    announceGuestCapability: vi.fn(),
    adoptHostCapability: vi.fn(),
    adoptHostResult: vi.fn(),
    prepareHost: vi.fn(),
    offerHostCurrent: vi.fn(),
    offerHostCurrentSettled: vi.fn(),
    beginGuestTransfer: vi.fn(),
    abandonGuestTransfer: vi.fn(),
    adoptGuestDescriptor: vi.fn(),
    applyControl: vi.fn(),
    scheduleHostControl: vi.fn(),
    cancelPendingHostControl: vi.fn(),
    retireCurrent: vi.fn(),
    settleHostNaturalEnd: vi.fn(),
    ownsSession: vi.fn(),
    ownsGuestTransfer: vi.fn(),
    hasReadyRenderer: vi.fn(),
    positionSeconds: vi.fn(),
    durationSeconds: vi.fn(),
    snapshot: vi.fn(),
  };
  return {
    gateEnabled: true,
    roomKind: 'standard' as 'standard' | 'pro',
    runtime,
    createRuntime: vi.fn((_options: unknown) => runtime),
    registerHandlers: vi.fn(),
    safeSend: vi.fn(),
    getHostNow: vi.fn(() => 12_345),
    logWarn: vi.fn(),
  };
});

vi.mock('../../core/log.ts', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
    error: vi.fn(),
  },
}));

vi.mock('../../core/session.ts', () => ({
  INSTANCE_ID: 'test-instance',
}));

vi.mock('../../network/protocol.ts', () => ({
  registerHandlers: mocks.registerHandlers,
}));

vi.mock('../../network/peer-state.ts', () => ({
  safeSend: mocks.safeSend,
}));

vi.mock('../../network/shared-clock.ts', () => ({
  getHostNow: mocks.getHostNow,
}));

vi.mock('../../rooms/authority.ts', () => ({
  getRoomContext: () => ({
    kind: mocks.roomKind,
    roomId: null,
    role: 'idle',
    coordinatorId: null,
    epoch: 0,
    snapshotRevision: 0,
    capabilities: [],
  }),
}));

vi.mock('../legacy-bounded-file-gate.ts', () => ({
  isLegacyBoundedFileEnabled: () => mocks.gateEnabled,
}));

vi.mock('../legacy-bounded-file-v1-runtime.ts', () => ({
  createLegacyBoundedFileV1Runtime: mocks.createRuntime,
}));

const PRODUCT_MODULE_PATH = '../legacy-bounded-file-v1-product.ts';

interface CapturedRuntimeOptions {
  readonly nowRoomTimeMs: () => number;
  readonly emitFrame: (connection: DataConnection, frame: object) => boolean;
  readonly onFailure: (failure: { readonly stage: string; readonly error: unknown }) => void;
  readonly onLegacyFallback: (
    connection: DataConnection,
    commit: {
      readonly legacySessionId: number;
      readonly purpose: 'current' | 'preload';
      readonly queueItemId: string;
      readonly reason: string;
    },
  ) => void | Promise<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function connection(peer = 'peer-1'): DataConnection {
  return {
    peer,
    open: true,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as DataConnection;
}

function descriptorFrame() {
  return {
    type: 'file-r2-record-descriptor',
    bridgeVersion: 1,
    legacySessionId: 7,
    purpose: 'current',
    scope: {
      roomEpoch: 'room-epoch',
      bridgeGeneration: 1,
      bindingId: 'transfer-7',
      queueItemId: 'q_1234567890123456789012',
      sourceIdentity: 'source-7',
    },
    descriptorId: 'descriptor-7',
    descriptorVersion: 1,
    publication: {
      name: 'track.mp3',
      mime: 'audio/mpeg',
      encodedSize: 12_345,
    },
  } as const;
}

function activeRuntimeDefaults(): void {
  mocks.runtime.beginHostRoom.mockResolvedValue({ status: 'active', role: 'host' });
  mocks.runtime.beginGuestRoom.mockResolvedValue({ status: 'active', role: 'guest' });
  mocks.runtime.endRoom.mockResolvedValue(undefined);
  mocks.runtime.retireConnection.mockResolvedValue(true);
  mocks.runtime.announceGuestCapability.mockReturnValue(true);
  mocks.runtime.adoptHostCapability.mockReturnValue('recorded');
  mocks.runtime.adoptHostResult.mockReturnValue('ready');
  mocks.runtime.prepareHost.mockResolvedValue({ status: 'ready', durationSeconds: 90 });
  mocks.runtime.offerHostCurrent.mockResolvedValue({ status: 'descriptor-sent' });
  mocks.runtime.offerHostCurrentSettled.mockResolvedValue({ status: 'ready' });
  mocks.runtime.beginGuestTransfer.mockReturnValue(true);
  mocks.runtime.abandonGuestTransfer.mockResolvedValue(true);
  mocks.runtime.adoptGuestDescriptor.mockResolvedValue({
    status: 'ready',
    durationSeconds: 90,
  });
  mocks.runtime.applyControl.mockResolvedValue({
    status: 'buffered',
  });
  mocks.runtime.scheduleHostControl.mockResolvedValue({ status: 'bypass' });
  mocks.runtime.cancelPendingHostControl.mockReturnValue(null);
  mocks.runtime.retireCurrent.mockResolvedValue(false);
  mocks.runtime.settleHostNaturalEnd.mockResolvedValue({
    status: 'settled',
    snapshot: {
      phase: 'stopped',
      queueItemId: 'q_1234567890123456789012',
      legacySessionId: 7,
      positionSeconds: 0,
      durationSeconds: 90,
    },
  });
  mocks.runtime.ownsSession.mockReturnValue(true);
  mocks.runtime.ownsGuestTransfer.mockReturnValue(true);
  mocks.runtime.hasReadyRenderer.mockReturnValue(true);
  mocks.runtime.positionSeconds.mockReturnValue(12);
  mocks.runtime.durationSeconds.mockReturnValue(90);
  mocks.runtime.snapshot.mockReturnValue({
    schemaVersion: 1,
    active: true,
    role: 'host',
    roomKind: 'standard',
    roomEpoch: 'room-epoch',
    generation: 1,
    current: null,
    hostConnections: 1,
    guestCapabilityAnnounced: false,
  });
  mocks.safeSend.mockReturnValue(true);
}

async function loadProduct() {
  return import(PRODUCT_MODULE_PATH);
}

describe('legacy bounded file V1 product adapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.gateEnabled = true;
    mocks.roomKind = 'standard';
    activeRuntimeDefaults();
  });

  it('injects only the stable V1 clock/send boundary into one runtime singleton', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    await product.beginHostRoom('123456');

    expect(mocks.createRuntime).toHaveBeenCalledTimes(1);
    const options = mocks.createRuntime.mock.calls[0]?.[0] as CapturedRuntimeOptions;
    const conn = connection();
    const frame = {
      type: 'file-bounded-v1-capability',
      bridgeVersion: 1,
      descriptorVersion: 1,
    } as const;

    expect(options.nowRoomTimeMs()).toBe(12_345);
    expect(options.emitFrame(conn, frame)).toBe(true);
    expect(mocks.safeSend).toHaveBeenCalledWith(conn, frame);

    options.onFailure({ stage: 'host-publication', error: new Error('signed-url') });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      '[LegacyBoundedV1Product] Runtime failure at host-publication',
    );
    expect(mocks.logWarn.mock.calls.flat()).not.toContain('signed-url');
  });

  it('emits an exact stable FILE_PREPARE marker immediately before a negotiated descriptor', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    await product.beginHostRoom('123456');
    const options = mocks.createRuntime.mock.calls[0]?.[0] as CapturedRuntimeOptions;
    const conn = connection();
    const descriptor = descriptorFrame();
    mocks.safeSend.mockClear();

    expect(options.emitFrame(conn, descriptor)).toBe(true);
    expect(mocks.safeSend.mock.calls).toEqual([
      [
        conn,
        {
          type: 'file-prepare',
          name: 'track.mp3',
          mime: 'audio/mpeg',
          size: 12_345,
          queueItemId: 'q_1234567890123456789012',
          sessionId: 7,
          autoPlayDelayMs: 0,
          delivery: 'r2-record',
        },
      ],
      [conn, descriptor],
    ]);
  });

  it('withholds a descriptor when its marker fails and preserves the exact fallback dispatch', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    await product.beginHostRoom('123456');
    const options = mocks.createRuntime.mock.calls[0]?.[0] as CapturedRuntimeOptions;
    const conn = connection();
    const descriptor = descriptorFrame();
    const fallback = vi.fn();
    product.registerLegacyFallbackDispatcher(fallback);
    mocks.safeSend.mockClear();
    mocks.safeSend.mockReturnValueOnce(false);
    mocks.runtime.offerHostCurrent.mockImplementationOnce(async (target: DataConnection) => {
      if (!options.emitFrame(target, descriptor)) {
        options.onLegacyFallback(target, {
          legacySessionId: descriptor.legacySessionId,
          purpose: descriptor.purpose,
          queueItemId: descriptor.scope.queueItemId,
          reason: 'descriptor-send-failed',
        });
        return { status: 'legacy-committed' };
      }
      return { status: 'descriptor-sent' };
    });

    await expect(product.offerHostCurrent(conn)).resolves.toEqual({
      status: 'legacy-committed',
    });
    expect(mocks.safeSend).toHaveBeenCalledTimes(1);
    expect(mocks.safeSend).toHaveBeenCalledWith(
      conn,
      expect.objectContaining({ type: 'file-prepare', delivery: 'r2-record' }),
    );
    expect(mocks.safeSend).not.toHaveBeenCalledWith(conn, descriptor);
    expect(fallback).toHaveBeenCalledWith(conn, {
      legacySessionId: 7,
      purpose: 'current',
      queueItemId: 'q_1234567890123456789012',
      reason: 'descriptor-send-failed',
    });
  });

  it('emits neither marker nor descriptor while peer capability remains unknown', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    await product.beginHostRoom('123456');
    const conn = connection();
    mocks.safeSend.mockClear();
    mocks.runtime.offerHostCurrent.mockResolvedValueOnce({ status: 'pending' });

    await expect(product.offerHostCurrent(conn)).resolves.toEqual({ status: 'pending' });
    expect(mocks.safeSend).not.toHaveBeenCalled();
  });

  it('registers the three additive handlers once and routes them only inside an owned standard room', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const conn = connection();
    const descriptorObserver = vi.fn();

    expect(product.initialize()).toBe(true);
    expect(product.initialize()).toBe(true);
    expect(mocks.registerHandlers).toHaveBeenCalledTimes(1);

    await product.beginHostRoom('123456');
    product.registerGuestDescriptorObserver(descriptorObserver);
    const handlers = mocks.registerHandlers.mock.calls[0]?.[0] as Record<
      string,
      (frame: never, connection: DataConnection) => void | Promise<void>
    >;
    const capability = { type: 'file-bounded-v1-capability' };
    const descriptor = { type: 'file-r2-record-descriptor' };
    const result = { type: 'file-r2-record-result' };

    await handlers['file-bounded-v1-capability']?.(capability as never, conn);
    await handlers['file-r2-record-descriptor']?.(descriptor as never, conn);
    await handlers['file-r2-record-result']?.(result as never, conn);

    expect(mocks.runtime.adoptHostCapability).toHaveBeenCalledWith(conn, capability);
    expect(mocks.runtime.adoptGuestDescriptor).toHaveBeenCalledWith(conn, descriptor);
    expect(mocks.runtime.adoptHostResult).toHaveBeenCalledWith(conn, result);
    expect(descriptorObserver).toHaveBeenCalledTimes(1);

    mocks.roomKind = 'pro';
    await handlers['file-bounded-v1-capability']?.(capability as never, conn);
    await handlers['file-r2-record-descriptor']?.(descriptor as never, conn);
    await handlers['file-r2-record-result']?.(result as never, conn);

    expect(mocks.runtime.adoptHostCapability).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.adoptGuestDescriptor).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.adoptHostResult).toHaveBeenCalledTimes(1);
    expect(descriptorObserver).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'ready', durationSeconds: 90 },
    { status: 'fallback' },
    { status: 'stale' },
  ] as const)(
    'publishes the detailed guest descriptor outcome to one product observer: %o',
    async (outcome) => {
      const { legacyBoundedFileV1Product: product } = await loadProduct();
      const conn = connection();
      const observer = vi.fn();
      mocks.runtime.adoptGuestDescriptor.mockResolvedValueOnce(outcome);

      product.initialize();
      await product.beginGuestRoom(conn);
      product.registerGuestDescriptorObserver(observer);
      const handlers = mocks.registerHandlers.mock.calls[0]?.[0] as Record<
        string,
        (frame: never, connection: DataConnection) => void | Promise<void>
      >;
      const frame = { type: 'file-r2-record-descriptor', descriptorId: 'descriptor-1' };

      await handlers['file-r2-record-descriptor']?.(frame as never, conn);

      expect(observer).toHaveBeenCalledTimes(1);
      const event = observer.mock.calls[0]?.[0];
      expect(event).toEqual({ connection: conn, frame, outcome });
      expect(Object.isFrozen(event)).toBe(true);
    },
  );

  it('isolates descriptor observer failures and honors its exact disposer', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const conn = connection();
    product.initialize();
    await product.beginGuestRoom(conn);
    const handlers = mocks.registerHandlers.mock.calls[0]?.[0] as Record<
      string,
      (frame: never, connection: DataConnection) => void | Promise<void>
    >;
    const frame = { type: 'file-r2-record-descriptor' };
    const throwingObserver = vi.fn(() => {
      throw new Error('observer-secret');
    });

    const disposeThrowing = product.registerGuestDescriptorObserver(throwingObserver);
    await expect(
      handlers['file-r2-record-descriptor']?.(frame as never, conn),
    ).resolves.toBeUndefined();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      '[LegacyBoundedV1Product] Guest descriptor observer failed',
    );
    expect(mocks.logWarn.mock.calls.flat()).not.toContain('observer-secret');

    const rejectingObserver = vi.fn(() => Promise.reject(new Error('observer-secret')));
    product.registerGuestDescriptorObserver(rejectingObserver);
    disposeThrowing();
    await handlers['file-r2-record-descriptor']?.(frame as never, conn);
    await Promise.resolve();
    expect(mocks.logWarn).toHaveBeenCalledWith(
      '[LegacyBoundedV1Product] Guest descriptor observer rejected',
    );

    const disposeRejecting = product.registerGuestDescriptorObserver(rejectingObserver);
    disposeRejecting();
    rejectingObserver.mockClear();
    await handlers['file-r2-record-descriptor']?.(frame as never, conn);
    expect(rejectingObserver).not.toHaveBeenCalled();
  });

  it('creates a new immutable host incarnation and room token for every standard room begin', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const conn = connection();

    expect(await product.beginHostRoom('123456')).toEqual({
      status: 'active',
      role: 'host',
    });
    expect(await product.beginHostRoom('654321')).toEqual({
      status: 'active',
      role: 'host',
    });

    const first = mocks.runtime.beginHostRoom.mock.calls[0]?.[0];
    const second = mocks.runtime.beginHostRoom.mock.calls[1]?.[0];
    expect(first).toMatchObject({
      kind: 'standard',
      roomEpoch: 'v1:test-instance:1',
      storageRoomId: '123456',
    });
    expect(second).toMatchObject({
      kind: 'standard',
      roomEpoch: 'v1:test-instance:2',
      storageRoomId: '654321',
    });
    expect(first.roomToken).not.toBe(second.roomToken);
    expect(Object.isFrozen(first.roomToken)).toBe(true);

    await expect(product.offerHostCurrent(conn)).resolves.toEqual({
      status: 'descriptor-sent',
    });
    expect(mocks.runtime.offerHostCurrent).toHaveBeenCalledWith(conn);
    expect(mocks.runtime.offerHostCurrent.mock.calls[0]).toHaveLength(1);
  });

  it('waits for the exact current host delivery only while the same standard room owns it', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const conn = connection();
    await product.beginHostRoom('123456');

    await expect(
      product.offerHostCurrentSettled(conn, 'q_1234567890123456789012', 7),
    ).resolves.toEqual({ status: 'ready' });
    expect(mocks.runtime.offerHostCurrentSettled).toHaveBeenCalledWith(
      conn,
      'q_1234567890123456789012',
      7,
    );
  });

  it('fails a stale settled-offer waiter closed when its room lifecycle ends', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const conn = connection();
    const pending = deferred<{ status: 'ready' }>();
    await product.beginHostRoom('123456');
    mocks.runtime.offerHostCurrentSettled.mockImplementationOnce(() => pending.promise);

    const settlement = product.offerHostCurrentSettled(conn, 'q_1234567890123456789012', 7);
    await vi.waitFor(() => expect(mocks.runtime.offerHostCurrentSettled).toHaveBeenCalledTimes(1));
    await product.endRoom();
    pending.resolve({ status: 'ready' });

    await expect(settlement).resolves.toEqual({ status: 'bypass' });
  });

  it('delegates one exact host natural-end settlement inside its owned lifecycle', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    await product.beginHostRoom('123456');

    await expect(
      product.settleHostNaturalEnd('q_1234567890123456789012', 7),
    ).resolves.toMatchObject({ status: 'settled' });
    expect(mocks.runtime.settleHostNaturalEnd).toHaveBeenCalledWith('q_1234567890123456789012', 7);
  });

  it('discards a natural-end settlement that completes after room teardown', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const pending = deferred<{ status: 'not-ended' }>();
    await product.beginHostRoom('123456');
    mocks.runtime.settleHostNaturalEnd.mockImplementationOnce(() => pending.promise);

    const settlement = product.settleHostNaturalEnd('q_1234567890123456789012', 7);
    await vi.waitFor(() => expect(mocks.runtime.settleHostNaturalEnd).toHaveBeenCalledTimes(1));
    await product.endRoom();
    pending.resolve({ status: 'not-ended' });

    await expect(settlement).resolves.toEqual({ status: 'bypass' });
  });

  it.each(['', '000001', '12345', '1234567', 'abcdef', ' 123456'])(
    'rejects an invalid standard storage room id before opening product resources: %s',
    async (storageRoomId) => {
      const { legacyBoundedFileV1Product: product } = await loadProduct();

      await expect(product.beginHostRoom(storageRoomId)).rejects.toThrow(TypeError);
      expect(mocks.runtime.beginHostRoom).not.toHaveBeenCalled();
    },
  );

  it('revokes a previously owned room before rejecting an invalid host successor', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const conn = connection();
    await product.beginHostRoom('123456');
    mocks.runtime.offerHostCurrent.mockClear();

    await expect(product.beginHostRoom('000001')).rejects.toThrow(TypeError);
    expect(mocks.runtime.endRoom).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.beginHostRoom).toHaveBeenCalledTimes(1);
    await expect(product.offerHostCurrent(conn)).resolves.toEqual({ status: 'bypass' });
    expect(mocks.runtime.offerHostCurrent).not.toHaveBeenCalled();
  });

  it('supports guest lifecycle, exact connection retirement, and idempotent room cleanup', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const conn = connection();

    await expect(product.beginGuestRoom(conn)).resolves.toEqual({
      status: 'active',
      role: 'guest',
    });
    expect(mocks.runtime.beginGuestRoom).toHaveBeenCalledWith({
      kind: 'standard',
      hostConnection: conn,
    });
    await expect(product.retireConnection(conn)).resolves.toBe(true);
    await expect(product.abandonGuestTransfer(conn, 'q_1', 7)).resolves.toBe(true);
    await product.endRoom();
    await product.endRoom();

    expect(mocks.runtime.retireConnection).toHaveBeenCalledWith(conn);
    expect(mocks.runtime.abandonGuestTransfer).toHaveBeenCalledWith(conn, 'q_1', 7);
    expect(mocks.runtime.endRoom).toHaveBeenCalledTimes(1);
  });

  it('does not retain product authority when a room replacement fails', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    await product.beginHostRoom('123456');
    mocks.runtime.beginGuestRoom.mockRejectedValueOnce(new Error('guest-room-failed'));
    mocks.runtime.ownsSession.mockClear();

    await expect(product.beginGuestRoom(connection())).rejects.toThrow('guest-room-failed');
    expect(product.ownsSession('q_1', 1)).toBe(false);
    expect(mocks.runtime.ownsSession).not.toHaveBeenCalled();
  });

  it('serializes concurrent guest replacements and publishes only the newest begin lease', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const firstConnection = connection('guest-a');
    const secondConnection = connection('guest-b');
    const firstBegin = deferred<{ status: 'active'; role: 'guest' }>();
    mocks.runtime.beginGuestRoom
      .mockImplementationOnce(() => firstBegin.promise)
      .mockResolvedValueOnce({ status: 'active', role: 'guest' });

    const firstResult = product.beginGuestRoom(firstConnection);
    await vi.waitFor(() => expect(mocks.runtime.beginGuestRoom).toHaveBeenCalledTimes(1));
    const secondResult = product.beginGuestRoom(secondConnection);
    firstBegin.resolve({ status: 'active', role: 'guest' });

    await expect(firstResult).resolves.toEqual({ status: 'bypass' });
    await expect(secondResult).resolves.toEqual({ status: 'active', role: 'guest' });
    expect(mocks.runtime.beginGuestRoom.mock.calls.map((call) => call[0].hostConnection)).toEqual([
      firstConnection,
      secondConnection,
    ]);
    expect(product.announceGuestCapability(secondConnection)).toBe(true);
  });

  it('invalidates a pending guest begin before endRoom performs runtime cleanup', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const conn = connection();
    const pendingBegin = deferred<{ status: 'active'; role: 'guest' }>();
    mocks.runtime.beginGuestRoom.mockImplementationOnce(() => pendingBegin.promise);

    const beginResult = product.beginGuestRoom(conn);
    await vi.waitFor(() => expect(mocks.runtime.beginGuestRoom).toHaveBeenCalledTimes(1));
    const ending = product.endRoom();
    expect(product.announceGuestCapability(conn)).toBe(false);
    pendingBegin.resolve({ status: 'active', role: 'guest' });

    await expect(beginResult).resolves.toEqual({ status: 'bypass' });
    await ending;
    expect(mocks.runtime.endRoom).toHaveBeenCalledTimes(1);
    expect(product.ownsSession('q_1', 1)).toBe(false);
  });

  it('serializes a host-to-guest replacement without exposing the stale host completion', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const pendingHost = deferred<{ status: 'active'; role: 'host' }>();
    mocks.runtime.beginHostRoom.mockImplementationOnce(() => pendingHost.promise);
    const hostResult = product.beginHostRoom('123456');
    await vi.waitFor(() => expect(mocks.runtime.beginHostRoom).toHaveBeenCalledTimes(1));

    const guestConnection = connection();
    const guestResult = product.beginGuestRoom(guestConnection);
    pendingHost.resolve({ status: 'active', role: 'host' });

    await expect(hostResult).resolves.toEqual({ status: 'bypass' });
    await expect(guestResult).resolves.toEqual({ status: 'active', role: 'guest' });
    expect(mocks.runtime.beginGuestRoom).toHaveBeenCalledWith({
      kind: 'standard',
      hostConnection: guestConnection,
    });
  });

  it('lets a successor own the product after a stale begin failure', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const staleBegin = deferred<{ status: 'active'; role: 'guest' }>();
    mocks.runtime.beginGuestRoom
      .mockImplementationOnce(() => staleBegin.promise)
      .mockResolvedValueOnce({ status: 'active', role: 'guest' });

    const staleResult = product.beginGuestRoom(connection('guest-a'));
    await vi.waitFor(() => expect(mocks.runtime.beginGuestRoom).toHaveBeenCalledTimes(1));
    const successorResult = product.beginGuestRoom(connection('guest-b'));
    staleBegin.reject(new Error('stale-begin-failed'));

    await expect(staleResult).rejects.toThrow('stale-begin-failed');
    await expect(successorResult).resolves.toEqual({ status: 'active', role: 'guest' });
    expect(product.positionSeconds()).toBe(12);
    expect(mocks.runtime.positionSeconds).toHaveBeenCalledTimes(1);
  });

  it('defers exact per-connection legacy fallback to the registered dispatcher', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const options = mocks.createRuntime.mock.calls[0]?.[0] as CapturedRuntimeOptions;
    const conn = connection();
    const commit = {
      legacySessionId: 7,
      purpose: 'current',
      queueItemId: 'q_1234567890123456789012',
      reason: 'capability-timeout',
    } as const;
    const dispatcher = vi.fn();

    await expect(options.onLegacyFallback(conn, commit)).rejects.toThrow(
      'Legacy bounded V1 fallback dispatcher is unavailable',
    );
    expect(mocks.logWarn).toHaveBeenCalledWith(
      '[LegacyBoundedV1Product] Legacy fallback requested before its dispatcher was registered',
    );

    const unregister = product.registerLegacyFallbackDispatcher(dispatcher);
    await options.onLegacyFallback(conn, commit);
    expect(dispatcher).toHaveBeenCalledWith(conn, commit);

    unregister();
    await expect(options.onLegacyFallback(conn, commit)).rejects.toThrow(
      'Legacy bounded V1 fallback dispatcher is unavailable',
    );
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the delivery barrier pending until the exact fallback dispatcher settles', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const options = mocks.createRuntime.mock.calls[0]?.[0] as CapturedRuntimeOptions;
    const conn = connection();
    const pending = deferred<void>();
    const dispatcher = vi.fn(() => pending.promise);
    const commit = {
      legacySessionId: 7,
      purpose: 'current',
      queueItemId: 'q_1234567890123456789012',
      reason: 'capability-timeout',
    } as const;
    product.registerLegacyFallbackDispatcher(dispatcher);

    let settled = false;
    const delivery = Promise.resolve(options.onLegacyFallback(conn, commit)).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    pending.resolve();
    await delivery;
    expect(settled).toBe(true);
  });

  it('sanitizes a rejected fallback before failing its delivery barrier closed', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const options = mocks.createRuntime.mock.calls[0]?.[0] as CapturedRuntimeOptions;
    const conn = connection();
    const dispatcher = vi.fn(() => Promise.reject(new Error('signed-secret')));
    product.registerLegacyFallbackDispatcher(dispatcher);

    await expect(
      options.onLegacyFallback(conn, {
        legacySessionId: 7,
        purpose: 'current',
        queueItemId: 'q_1234567890123456789012',
        reason: 'capability-timeout',
      }),
    ).rejects.toThrow('Legacy bounded V1 fallback dispatch failed');
    expect(mocks.logWarn.mock.calls.flat()).not.toContain('signed-secret');
  });

  it('fails closed without installing handlers or touching lifecycle resources when the beta gate is off', async () => {
    mocks.gateEnabled = false;
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const conn = connection();

    expect(product.initialize()).toBe(false);
    await expect(product.beginHostRoom('123456')).resolves.toEqual({ status: 'bypass' });
    await expect(product.beginGuestRoom(conn)).resolves.toEqual({ status: 'bypass' });
    expect(product.announceGuestCapability(conn)).toBe(false);
    expect(product.beginGuestTransfer({ queueItemId: 'q_1', legacySessionId: 1 })).toBe(false);
    await expect(product.abandonGuestTransfer(conn, 'q_1', 1)).resolves.toBe(false);
    await expect(product.offerHostCurrentSettled(conn, 'q_1', 1)).resolves.toEqual({
      status: 'bypass',
    });
    await expect(product.settleHostNaturalEnd('q_1', 1)).resolves.toEqual({
      status: 'bypass',
    });
    expect(product.positionSeconds()).toBeNull();
    expect(product.durationSeconds()).toBeNull();
    expect(product.snapshot()).toMatchObject({ active: false, role: 'bypass' });

    expect(mocks.registerHandlers).not.toHaveBeenCalled();
    expect(mocks.runtime.beginHostRoom).not.toHaveBeenCalled();
    expect(mocks.runtime.beginGuestRoom).not.toHaveBeenCalled();
    expect(mocks.runtime.announceGuestCapability).not.toHaveBeenCalled();
    expect(mocks.runtime.beginGuestTransfer).not.toHaveBeenCalled();
    expect(mocks.runtime.abandonGuestTransfer).not.toHaveBeenCalled();
    expect(mocks.runtime.offerHostCurrentSettled).not.toHaveBeenCalled();
    expect(mocks.runtime.settleHostNaturalEnd).not.toHaveBeenCalled();
    expect(mocks.safeSend).not.toHaveBeenCalled();
  });

  it('keeps PRO rooms on a complete no-op data path and cleans a prior owned standard room once', async () => {
    const { legacyBoundedFileV1Product: product } = await loadProduct();
    const conn = connection();
    await product.beginHostRoom('123456');

    mocks.roomKind = 'pro';
    await expect(product.beginGuestRoom(conn)).resolves.toEqual({ status: 'bypass' });
    await expect(
      product.prepareHost({
        blob: new Blob(['a']),
        name: 'a.mp3',
        mime: 'audio/mpeg',
        queueItemId: 'q_1',
        sourceIdentity: 'source',
        transferSessionId: 'transfer',
        legacySessionId: 1,
      }),
    ).resolves.toEqual({ status: 'bypass' });
    await expect(product.offerHostCurrent(conn)).resolves.toEqual({ status: 'bypass' });
    await expect(product.offerHostCurrentSettled(conn, 'q_1', 1)).resolves.toEqual({
      status: 'bypass',
    });
    await expect(product.settleHostNaturalEnd('q_1', 1)).resolves.toEqual({
      status: 'bypass',
    });
    await expect(
      product.applyControl({
        kind: 'pause',
        queueItemId: 'q_1',
        legacySessionId: 1,
        positionSeconds: 0,
        atRoomTimeMs: 1,
      }),
    ).resolves.toEqual({ status: 'bypass' });
    expect(product.ownsSession('q_1', 1)).toBe(false);
    expect(product.hasReadyRenderer('q_1', 1)).toBe(false);
    await expect(product.abandonGuestTransfer(conn, 'q_1', 1)).resolves.toBe(false);

    expect(mocks.runtime.endRoom).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.beginGuestRoom).not.toHaveBeenCalled();
    expect(mocks.runtime.prepareHost).not.toHaveBeenCalled();
    expect(mocks.runtime.offerHostCurrent).not.toHaveBeenCalled();
    expect(mocks.runtime.offerHostCurrentSettled).not.toHaveBeenCalled();
    expect(mocks.runtime.settleHostNaturalEnd).not.toHaveBeenCalled();
    expect(mocks.runtime.applyControl).not.toHaveBeenCalled();
    expect(mocks.runtime.abandonGuestTransfer).not.toHaveBeenCalled();
    expect(mocks.safeSend).not.toHaveBeenCalled();
  });
});
