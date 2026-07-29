import { describe, expect, it } from 'vitest';

import { createLegacyBoundedFileV1NegotiationLedger } from '../legacy-bounded-file-v1-negotiation.ts';

const QUEUE_ITEM_ID_1 = '00000000-0000-4000-8000-000000000001';
const QUEUE_ITEM_ID_2 = '00000000-0000-4000-8000-000000000002';

interface TestConnection {
  readonly peer: string;
}

interface TestPublication {
  readonly queueItemId: string;
  readonly sourceIdentity: string;
  readonly transferSessionId: string;
  readonly applicationSessionId: string;
  readonly marker: string;
}

class ManualScheduler {
  #nextId = 1;
  readonly #callbacks = new Map<number, () => void>();
  readonly scheduledDelays: number[] = [];

  readonly schedule = (callback: () => void, delayMs: number): number => {
    const id = this.#nextId;
    this.#nextId += 1;
    this.scheduledDelays.push(delayMs);
    this.#callbacks.set(id, callback);
    return id;
  };

  readonly cancel = (id: number): void => {
    this.#callbacks.delete(id);
  };

  fireNext(): boolean {
    const entry = this.#callbacks.entries().next().value as
      | readonly [number, () => void]
      | undefined;
    if (!entry) return false;
    this.#callbacks.delete(entry[0]);
    entry[1]();
    return true;
  }

  get size(): number {
    return this.#callbacks.size;
  }
}

function connection(peer = 'same-peer-id'): TestConnection {
  return { peer };
}

function scope(
  suffix = '1',
  overrides: Partial<{
    roomEpoch: string;
    bridgeGeneration: string;
    bindingId: string;
    queueItemId: string;
    sourceIdentity: string;
  }> = {},
) {
  return {
    roomEpoch: overrides.roomEpoch ?? 'room-epoch-1',
    bridgeGeneration: overrides.bridgeGeneration ?? 'bridge-generation-1',
    bindingId: overrides.bindingId ?? `binding-${suffix}`,
    queueItemId: overrides.queueItemId ?? QUEUE_ITEM_ID_1,
    sourceIdentity: overrides.sourceIdentity ?? `source:bounded-v1:${suffix}`,
  };
}

function descriptor(
  deliveryScope = scope(),
  overrides: Partial<{
    legacySessionId: number;
    purpose: 'current' | 'preload';
    descriptorId: string;
  }> = {},
) {
  return {
    type: 'file-r2-record-descriptor' as const,
    bridgeVersion: 1 as const,
    legacySessionId: overrides.legacySessionId ?? 7,
    purpose: overrides.purpose ?? ('current' as const),
    scope: deliveryScope,
    descriptorId: overrides.descriptorId ?? 'descriptor-1',
    descriptorVersion: 1 as const,
    publication: {
      queueItemId: deliveryScope.queueItemId,
      sourceIdentity: deliveryScope.sourceIdentity,
      transferSessionId: deliveryScope.bindingId,
      applicationSessionId: deliveryScope.roomEpoch,
      marker: overrides.descriptorId ?? 'descriptor-1',
    },
  };
}

function result(
  offered = descriptor(),
  outcome: 'ready' | 'fallback' = 'ready',
  resultScope = offered.scope,
) {
  return {
    type: 'file-r2-record-result' as const,
    bridgeVersion: 1 as const,
    legacySessionId: offered.legacySessionId,
    scope: resultScope,
    descriptorId: offered.descriptorId,
    descriptorVersion: 1 as const,
    outcome,
  };
}

function capability() {
  return {
    type: 'file-bounded-v1-capability' as const,
    bridgeVersion: 1 as const,
    descriptorVersion: 1 as const,
  };
}

function harness() {
  const scheduler = new ManualScheduler();
  const descriptors: Array<{
    connection: TestConnection;
    frame: ReturnType<typeof descriptor>;
  }> = [];
  const commits: Array<{
    connection: TestConnection;
    reason: string;
    descriptorId: string;
  }> = [];
  let descriptorResult = true;
  const ledger = createLegacyBoundedFileV1NegotiationLedger<
    TestConnection,
    TestPublication,
    number
  >({
    capabilityTimeoutMs: 750,
    descriptorResultTimeoutMs: 15_000,
    scheduleTimeout: scheduler.schedule,
    cancelTimeout: scheduler.cancel,
    onDescriptor: (target, frame) => {
      descriptors.push({
        connection: target,
        frame: frame as ReturnType<typeof descriptor>,
      });
      return descriptorResult;
    },
    onLegacyCommit: (target, commit) => {
      commits.push({
        connection: target,
        reason: commit.reason,
        descriptorId: commit.descriptorId,
      });
    },
  });
  return {
    ledger,
    scheduler,
    descriptors,
    commits,
    rejectDescriptorSend(): void {
      descriptorResult = false;
    },
  };
}

describe('legacy bounded file V1 negotiation ledger', () => {
  it('announces once per exact connection and completes the capable ready path', () => {
    const h = harness();
    const conn = connection();
    const offered = descriptor();

    expect(h.ledger.announceCapability(conn)).toEqual(capability());
    expect(h.ledger.announceCapability(conn)).toBeNull();
    expect(h.ledger.offerDescriptor(conn, offered)).toEqual({
      status: 'pending',
      duplicate: false,
    });
    expect(h.scheduler.scheduledDelays).toEqual([750]);
    expect(h.ledger.recordCapability(conn, capability())).toEqual({
      status: 'accepted',
      descriptorsDispatched: 1,
    });
    expect(h.scheduler.scheduledDelays).toEqual([750, 15_000]);
    expect(h.descriptors).toHaveLength(1);
    expect(h.ledger.recordResult(conn, result(offered))).toEqual({ status: 'ready' });
    expect(h.scheduler.size).toBe(0);
    expect(h.ledger.recordResult(conn, result(offered))).toEqual({ status: 'duplicate' });
    expect(h.ledger.snapshot(conn)?.deliveries).toMatchObject([
      { state: 'ready', active: true, fallbackReason: null },
    ]);
    expect(h.commits).toHaveLength(0);
  });

  it('commits a non-capable connection to legacy exactly once and rejects late switching', () => {
    const h = harness();
    const conn = connection();
    const offered = descriptor();

    expect(h.ledger.commitConnectionToLegacy(conn)).toEqual({
      status: 'committed',
      deliveriesCommitted: 0,
    });
    expect(h.ledger.offerDescriptor(conn, offered)).toEqual({
      status: 'legacy-committed',
      duplicate: false,
    });
    expect(h.commits).toEqual([
      {
        connection: conn,
        reason: 'capability-unavailable',
        descriptorId: offered.descriptorId,
      },
    ]);
    expect(h.ledger.offerDescriptor(conn, offered)).toEqual({
      status: 'legacy-committed',
      duplicate: true,
    });
    expect(h.ledger.recordCapability(conn, capability())).toEqual({
      status: 'legacy-committed',
      descriptorsDispatched: 0,
    });
    expect(h.ledger.recordResult(conn, result(offered))).toEqual({
      status: 'legacy-committed',
    });
    expect(h.commits).toHaveLength(1);
    expect(h.descriptors).toHaveLength(0);
  });

  it('times out capability discovery once and makes a late capability terminal', () => {
    const h = harness();
    const conn = connection();
    const offered = descriptor();

    h.ledger.offerDescriptor(conn, offered);
    expect(h.scheduler.scheduledDelays).toEqual([750]);
    expect(h.scheduler.fireNext()).toBe(true);
    expect(h.commits.map((entry) => entry.reason)).toEqual(['capability-timeout']);
    expect(h.ledger.snapshot(conn)?.capability).toBe('legacy-only');
    expect(h.ledger.recordCapability(conn, capability()).status).toBe('legacy-committed');
    expect(h.ledger.recordResult(conn, result(offered)).status).toBe('legacy-committed');
    expect(h.commits).toHaveLength(1);
  });

  it('times out a sent descriptor without globally disabling later bounded offers', () => {
    const h = harness();
    const conn = connection();
    const first = descriptor();
    const secondScope = scope('2', {
      bindingId: 'binding-2',
      queueItemId: QUEUE_ITEM_ID_2,
      sourceIdentity: 'source:bounded-v1:2',
    });
    const second = descriptor(secondScope, {
      legacySessionId: 8,
      descriptorId: 'descriptor-2',
    });

    h.ledger.recordCapability(conn, capability());
    expect(h.ledger.offerDescriptor(conn, first).status).toBe('descriptor-sent');
    expect(h.scheduler.scheduledDelays).toEqual([15_000]);
    expect(h.scheduler.fireNext()).toBe(true);
    expect(h.commits.map((entry) => entry.reason)).toEqual(['descriptor-result-timeout']);

    expect(h.ledger.offerDescriptor(conn, second).status).toBe('descriptor-sent');
    expect(h.descriptors).toHaveLength(2);
    expect(h.ledger.recordResult(conn, result(second)).status).toBe('ready');
    expect(h.commits).toHaveLength(1);
  });

  it('falls back once when descriptor dispatch fails without throwing or closing transport', () => {
    const h = harness();
    const conn = connection();
    const offered = descriptor();
    h.rejectDescriptorSend();
    h.ledger.recordCapability(conn, capability());

    expect(h.ledger.offerDescriptor(conn, offered).status).toBe('legacy-committed');
    expect(h.commits.map((entry) => entry.reason)).toEqual(['descriptor-send-failed']);
    expect(h.ledger.recordResult(conn, result(offered)).status).toBe('legacy-committed');
    expect(h.commits).toHaveLength(1);
  });

  it('ignores duplicate, late, stale, and exact-scope-mismatched results', () => {
    const h = harness();
    const conn = connection();
    const offered = descriptor();
    h.ledger.recordCapability(conn, capability());
    h.ledger.offerDescriptor(conn, offered);

    const wrongScope = scope('wrong', {
      bindingId: 'binding-wrong',
      queueItemId: QUEUE_ITEM_ID_2,
      sourceIdentity: 'source:bounded-v1:wrong',
    });
    expect(h.ledger.recordResult(conn, result(offered, 'ready', wrongScope)).status).toBe('stale');
    expect(
      h.ledger.recordResult(conn, {
        ...result(offered),
        descriptorId: 'descriptor-other',
      }).status,
    ).toBe('stale');
    expect(h.ledger.snapshot(conn)?.deliveries[0]?.state).toBe('descriptor-sent');

    expect(h.ledger.recordResult(conn, result(offered, 'fallback')).status).toBe(
      'legacy-committed',
    );
    expect(h.ledger.recordResult(conn, result(offered)).status).toBe('legacy-committed');
    expect(h.commits).toHaveLength(1);
  });

  it('isolates a reconnect with the same peer ID by exact connection object', () => {
    const h = harness();
    const oldConnection = connection('peer-1');
    const newConnection = connection('peer-1');
    const oldOffer = descriptor();
    const newScope = scope('new', {
      bridgeGeneration: 'bridge-generation-2',
      bindingId: 'binding-new',
      queueItemId: QUEUE_ITEM_ID_2,
      sourceIdentity: 'source:bounded-v1:new',
    });
    const newOffer = descriptor(newScope, {
      legacySessionId: 9,
      descriptorId: 'descriptor-new',
    });

    h.ledger.offerDescriptor(oldConnection, oldOffer);
    h.scheduler.fireNext();
    expect(h.ledger.snapshot(oldConnection)?.capability).toBe('legacy-only');

    expect(h.ledger.announceCapability(newConnection)).toEqual(capability());
    h.ledger.recordCapability(newConnection, capability());
    expect(h.ledger.offerDescriptor(newConnection, newOffer).status).toBe('descriptor-sent');
    expect(h.ledger.recordResult(newConnection, result(newOffer)).status).toBe('ready');
    expect(h.ledger.snapshot(newConnection)?.capability).toBe('capable');
    expect(h.descriptors[0]?.connection).toBe(newConnection);
  });

  it('keeps fallback isolated per peer when another peer becomes ready', () => {
    const h = harness();
    const legacyPeer = connection('legacy-peer');
    const boundedPeer = connection('bounded-peer');
    const offered = descriptor();

    h.ledger.offerDescriptor(legacyPeer, offered);
    h.ledger.recordCapability(boundedPeer, capability());
    h.ledger.offerDescriptor(boundedPeer, offered);
    expect(h.ledger.recordResult(boundedPeer, result(offered)).status).toBe('ready');
    h.scheduler.fireNext();

    expect(h.commits).toEqual([
      {
        connection: legacyPeer,
        reason: 'capability-timeout',
        descriptorId: offered.descriptorId,
      },
    ]);
    expect(h.ledger.snapshot(boundedPeer)?.deliveries[0]?.state).toBe('ready');
  });

  it('retires a prior purpose scope and cannot let its late result replace the successor', () => {
    const h = harness();
    const conn = connection();
    const first = descriptor();
    const successorScope = scope('successor', {
      bindingId: 'binding-successor',
      queueItemId: QUEUE_ITEM_ID_2,
      sourceIdentity: 'source:bounded-v1:successor',
    });
    const successor = descriptor(successorScope, {
      legacySessionId: 8,
      descriptorId: 'descriptor-successor',
    });
    h.ledger.recordCapability(conn, capability());
    h.ledger.offerDescriptor(conn, first);
    h.ledger.offerDescriptor(conn, successor);

    expect(h.ledger.recordResult(conn, result(first)).status).toBe('stale');
    expect(h.ledger.recordResult(conn, result(successor)).status).toBe('ready');
    expect(h.ledger.snapshot(conn)?.deliveries).toMatchObject([
      { state: 'retired', active: false },
      { state: 'ready', active: true },
    ]);
  });

  it('fails closed on authority, binding, descriptor, and same-scope identity conflicts', () => {
    const h = harness();
    const conn = connection();
    const first = descriptor();
    h.ledger.offerDescriptor(conn, first);

    const foreignAuthority = descriptor(
      scope('foreign', {
        roomEpoch: 'room-epoch-2',
        bridgeGeneration: 'bridge-generation-2',
        bindingId: 'binding-foreign',
        queueItemId: QUEUE_ITEM_ID_2,
        sourceIdentity: 'source:bounded-v1:foreign',
      }),
      { legacySessionId: 8, descriptorId: 'descriptor-foreign' },
    );
    expect(h.ledger.offerDescriptor(conn, foreignAuthority).status).toBe('authority-mismatch');

    const reusedBinding = descriptor(
      scope('reused', {
        bindingId: first.scope.bindingId,
        queueItemId: QUEUE_ITEM_ID_2,
        sourceIdentity: 'source:bounded-v1:reused',
      }),
      { legacySessionId: 8, descriptorId: 'descriptor-reused' },
    );
    expect(h.ledger.offerDescriptor(conn, reusedBinding).status).toBe('identity-conflict');

    expect(
      h.ledger.offerDescriptor(conn, {
        ...first,
        legacySessionId: first.legacySessionId + 1,
      }).status,
    ).toBe('identity-conflict');
    expect(h.ledger.snapshot(conn)?.deliveries).toHaveLength(1);
  });

  it('retires connections without invoking fallback and never revives that identity', () => {
    const h = harness();
    const conn = connection();
    const offered = descriptor();
    h.ledger.offerDescriptor(conn, offered);

    expect(h.ledger.retireConnection(conn)).toBe(true);
    expect(h.scheduler.size).toBe(0);
    expect(h.commits).toHaveLength(0);
    expect(h.ledger.recordCapability(conn, capability()).status).toBe('retired');
    expect(h.ledger.offerDescriptor(conn, offered).status).toBe('retired');
    expect(h.ledger.recordResult(conn, result(offered)).status).toBe('retired');
    expect(h.ledger.announceCapability(conn)).toBeNull();
  });
});
