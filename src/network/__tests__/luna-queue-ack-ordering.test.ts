import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import type { DataConnection, ProtocolMsg } from '../../types/index.ts';
import {
  initStandardQueueMutationAuthority,
  sendStandardQueueMutationRequest,
  standardQueueMutationTimingForTests,
} from '../queue-mutation-authority.ts';
import { handleData } from '../protocol.ts';

const HOST_A = 'host-a';
const QID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const QID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST_A = '11111111-1111-4111-8111-111111111111';
const REQUEST_B = '22222222-2222-4222-8222-222222222222';
const subscriptions: Array<() => void> = [];

type RemoveRequest = ProtocolMsg<typeof MSG.REQUEST_PLAYLIST_REMOVE>;

function connection(peer: string): DataConnection & { send: ReturnType<typeof vi.fn> } {
  return { peer, open: true, send: vi.fn() } as unknown as DataConnection & {
    send: ReturnType<typeof vi.fn>;
  };
}

function configureGuest(conn: DataConnection): void {
  setState('network.appRole', 'guest');
  setState('network.hostConn', conn);
  setState('network.isOperator', true);
  setState('network.standardRoomCapabilities', ['queue.mutate']);
}

function removeRequest(requestId: string, queueItemId: string): RemoveRequest {
  return {
    type: MSG.REQUEST_PLAYLIST_REMOVE,
    requestId,
    baseRevision: 0,
    queueItemIds: [queueItemId],
  };
}

function result(
  requestId: string,
  phase: 'accepted' | 'settled',
  outcome: null | 'applied' | 'rejected',
  revision = 1,
  code: null | 'conflict' = null,
) {
  return {
    type: MSG.OPERATOR_QUEUE_MUTATION_RESULT,
    requestId,
    phase,
    outcome,
    revision,
    code,
  } as const;
}

async function deliver(conn: DataConnection, frame: ReturnType<typeof result>): Promise<void> {
  await handleData(frame, conn);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  initStandardQueueMutationAuthority();
});

afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  initStandardQueueMutationAuthority();
  vi.useRealTimers();
});

describe('standard queue mutation acknowledgement ordering', () => {
  it('drains two requests when accepted and settled acknowledgements interleave in reverse order', async () => {
    const conn = connection(HOST_A);
    configureGuest(conn);
    const failures: unknown[][] = [];
    const refresh = vi.fn();
    const offFailure = bus.on('standard-room:queue-mutation-failed', (...args) =>
      failures.push(args),
    );
    const offRefresh = bus.on('playlist:refresh-requested', refresh);
    subscriptions.push(offFailure, offRefresh);

    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_A, QID_A))).toBe(true);
    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_B, QID_B))).toBe(true);
    await deliver(conn, result(REQUEST_B, 'accepted', null, 0));
    await deliver(conn, result(REQUEST_A, 'accepted', null, 0));
    await deliver(conn, result(REQUEST_A, 'settled', 'applied', 1));
    await deliver(conn, result(REQUEST_B, 'settled', 'applied', 2));
    // Duplicate late acceptance follows its terminal frame and must be inert.
    await deliver(conn, result(REQUEST_A, 'accepted', null, 0));
    vi.advanceTimersByTime(standardQueueMutationTimingForTests.settleTimeoutMs + 1);

    expect(failures).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
    expect(getState('playlist.items')).toEqual([]);
    offFailure();
    offRefresh();
  });

  it('does not let a stale terminal ACK for a finished request clear a newer request', async () => {
    const conn = connection(HOST_A);
    configureGuest(conn);
    const failures: Array<[string, string | null]> = [];
    const off = bus.on('standard-room:queue-mutation-failed', (reason, code) =>
      failures.push([reason, code]),
    );
    subscriptions.push(off);

    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_A, QID_A))).toBe(true);
    await deliver(conn, result(REQUEST_A, 'settled', 'applied'));
    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_B, QID_B))).toBe(true);
    await deliver(conn, result(REQUEST_A, 'settled', 'rejected', 1, 'conflict'));
    await deliver(conn, result(REQUEST_B, 'accepted', null, 0));
    vi.advanceTimersByTime(standardQueueMutationTimingForTests.settleTimeoutMs + 1);

    expect(failures).toEqual([['settle-timeout', null]]);
    off();
  });

  it('ignores a same-peer old-host accepted ACK for the new request and preserves its accept timeout', async () => {
    const oldHost = connection(HOST_A);
    const newHost = connection(HOST_A);
    configureGuest(oldHost);
    const failures: Array<[string, string | null]> = [];
    const off = bus.on('standard-room:queue-mutation-failed', (reason, code) =>
      failures.push([reason, code]),
    );
    subscriptions.push(off);

    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_A, QID_A))).toBe(true);
    configureGuest(newHost);
    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_B, QID_B))).toBe(true);
    await deliver(oldHost, result(REQUEST_B, 'accepted', null, 0));
    vi.advanceTimersByTime(standardQueueMutationTimingForTests.acceptTimeoutMs + 1);

    expect(failures).toEqual([['accept-timeout', null]]);
    off();
  });

  it('ignores a same-peer old-host settled ACK after valid acceptance and preserves the settle timeout', async () => {
    const oldHost = connection(HOST_A);
    const newHost = connection(HOST_A);
    configureGuest(oldHost);
    const failures: Array<[string, string | null]> = [];
    const off = bus.on('standard-room:queue-mutation-failed', (reason, code) =>
      failures.push([reason, code]),
    );
    subscriptions.push(off);

    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_A, QID_A))).toBe(true);
    configureGuest(newHost);
    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_B, QID_B))).toBe(true);
    await deliver(newHost, result(REQUEST_B, 'accepted', null, 0));
    await deliver(oldHost, result(REQUEST_B, 'settled', 'rejected', 1, 'conflict'));
    vi.advanceTimersByTime(standardQueueMutationTimingForTests.settleTimeoutMs + 1);

    expect(failures).toEqual([['settle-timeout', null]]);
    off();
  });

  it('cancels revoked-capability feedback and keeps a newly authorized request independent of stale ACKs', async () => {
    const conn = connection(HOST_A);
    configureGuest(conn);
    const failures: Array<[string, string | null]> = [];
    const off = bus.on('standard-room:queue-mutation-failed', (reason, code) =>
      failures.push([reason, code]),
    );
    subscriptions.push(off);

    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_A, QID_A))).toBe(true);
    setState('network.standardRoomCapabilities', []);
    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_B, QID_B))).toBe(false);
    expect(conn.send).toHaveBeenCalledTimes(1);
    setState('network.standardRoomCapabilities', ['queue.mutate']);
    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_B, QID_B))).toBe(true);
    await deliver(conn, result(REQUEST_A, 'settled', 'rejected', 0, 'conflict'));
    await deliver(conn, result(REQUEST_B, 'accepted', null, 0));
    vi.advanceTimersByTime(standardQueueMutationTimingForTests.settleTimeoutMs + 1);

    expect(failures).toEqual([
      ['rejected', 'unauthorized'],
      ['settle-timeout', null],
    ]);
    off();
  });

  it('clears the previous session scope so stale same-connection ACKs cannot settle post-reset work', async () => {
    const conn = connection(HOST_A);
    configureGuest(conn);
    const failures: Array<[string, string | null]> = [];
    const off = bus.on('standard-room:queue-mutation-failed', (reason, code) =>
      failures.push([reason, code]),
    );
    subscriptions.push(off);

    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_A, QID_A))).toBe(true);
    initStandardQueueMutationAuthority();
    expect(sendStandardQueueMutationRequest(removeRequest(REQUEST_B, QID_B))).toBe(true);
    await deliver(conn, result(REQUEST_A, 'settled', 'rejected', 0, 'conflict'));
    await deliver(conn, result(REQUEST_B, 'accepted', null, 0));
    vi.advanceTimersByTime(standardQueueMutationTimingForTests.settleTimeoutMs + 1);

    expect(failures).toEqual([['settle-timeout', null]]);
    off();
  });
});
