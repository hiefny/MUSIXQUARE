import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { getState, resetState, setState } from '../../core/state.ts';
import type { ConnectedPeer, DataConnection, ProtocolMsg } from '../../types/index.ts';
import {
  acceptStandardQueueMutationRequest,
  initStandardQueueMutationAuthority,
  sendStandardQueueMutationRequest,
  settleStandardQueueMutationRequest,
  standardQueueMutationTimingForTests,
} from '../queue-mutation-authority.ts';
import { handleData } from '../protocol.ts';
import { STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES } from '../standard-room-authority.ts';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const QUEUE_ITEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function connection(peer = 'peer-1'): DataConnection & { send: ReturnType<typeof vi.fn> } {
  return { peer, open: true, send: vi.fn() } as unknown as DataConnection & {
    send: ReturnType<typeof vi.fn>;
  };
}

function connectedPeer(conn: DataConnection, isOp = true): ConnectedPeer {
  return {
    id: conn.peer,
    slot: 1,
    label: 'Peer 1',
    conn,
    isOp,
    preloadedQueueItemIds: new Set(),
    status: 'connected',
    isDataTarget: true,
    joinOrder: 1,
    connectionType: 'local',
    lastHeartbeat: Date.now(),
  };
}

function configureGuest(conn: DataConnection): void {
  setState('network.appRole', 'guest');
  setState('network.hostConn', conn);
  setState('network.isOperator', true);
}

function configureHost(conn: DataConnection): void {
  setState('network.appRole', 'host');
  setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
  setState('network.connectedPeers', [connectedPeer(conn)]);
}

function addYoutubeRequest(): ProtocolMsg<typeof MSG.REQUEST_PLAYLIST_ADD_YOUTUBE> {
  return {
    type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
    requestId: REQUEST_ID,
    baseRevision: 0,
    sourceUrl: 'https://www.youtube.com/watch?v=a1B2c3D4e5F',
    title: 'Test video',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetState();
  initStandardQueueMutationAuthority();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('standard queue mutation result fence', () => {
  it('reports a silent legacy host without retrying the mutation', () => {
    const conn = connection('host');
    configureGuest(conn);
    const failures: Array<[string, string | null]> = [];
    const unsubscribe = bus.on('standard-room:queue-mutation-failed', (reason, code) => {
      failures.push([reason, code]);
    });

    expect(sendStandardQueueMutationRequest(addYoutubeRequest())).toBe(true);
    expect(conn.send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(standardQueueMutationTimingForTests.acceptTimeoutMs);
    expect(failures).toEqual([['accept-timeout', null]]);
    expect(conn.send).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('accepts then settles without writing guest playlist state', async () => {
    const conn = connection('host');
    configureGuest(conn);
    setState('playlist.revision', 4);
    const failures = vi.fn();
    const unsubscribe = bus.on('standard-room:queue-mutation-failed', failures);

    sendStandardQueueMutationRequest(addYoutubeRequest());
    await handleData(
      {
        type: MSG.OPERATOR_QUEUE_MUTATION_RESULT,
        requestId: REQUEST_ID,
        phase: 'accepted',
        outcome: null,
        revision: 4,
        code: null,
      },
      conn,
    );
    await handleData(
      {
        type: MSG.OPERATOR_QUEUE_MUTATION_RESULT,
        requestId: REQUEST_ID,
        phase: 'settled',
        outcome: 'applied',
        revision: 5,
        code: null,
      },
      conn,
    );
    vi.advanceTimersByTime(standardQueueMutationTimingForTests.settleTimeoutMs + 1);

    expect(failures).not.toHaveBeenCalled();
    expect(getState('playlist.items')).toEqual([]);
    expect(getState('playlist.revision')).toBe(4);
    expect(conn.send).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('times out a host that accepted but never settled', async () => {
    const conn = connection('host');
    configureGuest(conn);
    const failures: Array<[string, string | null]> = [];
    const unsubscribe = bus.on('standard-room:queue-mutation-failed', (reason, code) => {
      failures.push([reason, code]);
    });

    sendStandardQueueMutationRequest(addYoutubeRequest());
    await handleData(
      {
        type: MSG.OPERATOR_QUEUE_MUTATION_RESULT,
        requestId: REQUEST_ID,
        phase: 'accepted',
        outcome: null,
        revision: 0,
        code: null,
      },
      conn,
    );
    vi.advanceTimersByTime(standardQueueMutationTimingForTests.settleTimeoutMs);

    expect(failures).toEqual([['settle-timeout', null]]);
    unsubscribe();
  });

  it('silently cancels pending feedback when the authority connection changes', () => {
    const conn = connection('host');
    configureGuest(conn);
    const failures = vi.fn();
    const unsubscribe = bus.on('standard-room:queue-mutation-failed', failures);

    sendStandardQueueMutationRequest(addYoutubeRequest());
    setState('network.hostConn', null);
    vi.advanceTimersByTime(standardQueueMutationTimingForTests.settleTimeoutMs + 1);

    expect(failures).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('silently cancels pending feedback when operator authority is revoked', () => {
    const conn = connection('host');
    configureGuest(conn);
    const failures = vi.fn();
    const unsubscribe = bus.on('standard-room:queue-mutation-failed', failures);

    sendStandardQueueMutationRequest(addYoutubeRequest());
    setState('network.isOperator', false);
    vi.advanceTimersByTime(standardQueueMutationTimingForTests.settleTimeoutMs + 1);

    expect(failures).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('disposes pending feedback and replaces lifecycle ownership when reinitialized', () => {
    const conn = connection('host');
    configureGuest(conn);
    const failures = vi.fn();
    const unsubscribe = bus.on('standard-room:queue-mutation-failed', failures);

    sendStandardQueueMutationRequest(addYoutubeRequest());
    initStandardQueueMutationAuthority();
    vi.advanceTimersByTime(standardQueueMutationTimingForTests.settleTimeoutMs + 1);

    expect(failures).not.toHaveBeenCalled();

    configureGuest(conn);
    expect(sendStandardQueueMutationRequest(addYoutubeRequest())).toBe(true);
    setState('network.hostConn', null);
    vi.advanceTimersByTime(standardQueueMutationTimingForTests.settleTimeoutMs + 1);

    expect(failures).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('replays both phases for an identical duplicate host request', () => {
    const conn = connection('operator');
    configureHost(conn);
    const input = {
      conn,
      requestId: REQUEST_ID,
      requestName: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
      fingerprint: 'add-youtube:a1B2c3D4e5F',
    };

    expect(acceptStandardQueueMutationRequest(input)).toBe('accepted');
    expect(conn.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'accepted', outcome: null }),
    );
    setState('playlist.revision', 1);
    expect(settleStandardQueueMutationRequest(conn, REQUEST_ID, { outcome: 'applied' })).toBe(true);
    conn.send.mockClear();

    expect(acceptStandardQueueMutationRequest(input)).toBe('duplicate');
    expect(conn.send.mock.calls.map(([message]) => message)).toEqual([
      expect.objectContaining({ phase: 'accepted', revision: 0 }),
      expect.objectContaining({ phase: 'settled', outcome: 'applied', revision: 1 }),
    ]);
  });

  it('fails closed for a legacy administrator without explicit queue authority', () => {
    const conn = connection('operator');
    configureHost(conn);

    expect(
      acceptStandardQueueMutationRequest({
        conn,
        requestId: REQUEST_ID,
        requestName: MSG.REQUEST_PLAYLIST_REMOVE,
        fingerprint: `remove:${QUEUE_ITEM_ID}`,
      }),
    ).toBe('unauthorized');
    expect(conn.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'settled',
        outcome: 'rejected',
        code: 'unauthorized',
      }),
    );
  });

  it('accepts remove and reorder from an explicit media manager', () => {
    const conn = connection('media-manager');
    configureHost(conn);
    setState('network.connectedPeers', [
      {
        ...getState('network.connectedPeers')[0],
        roomCapabilities: ['media.add', 'queue.mutate', 'asset.upload'],
      },
    ]);

    expect(
      acceptStandardQueueMutationRequest({
        conn,
        requestId: REQUEST_ID,
        requestName: MSG.REQUEST_PLAYLIST_REMOVE,
        fingerprint: `remove:${QUEUE_ITEM_ID}`,
      }),
    ).toBe('accepted');
  });

  it('routes owner-sibling queue mutation through the physical host authority fence', () => {
    const conn = connection('owner-sibling');
    setState('network.appRole', 'host');
    setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
    setState('network.connectedPeers', [connectedPeer(conn, true)]);
    setState('network.connectedPeers', [
      {
        ...getState('network.connectedPeers')[0],
        isAuthenticated: true,
        memberId: 'member_abcdefghijklmnopqrstuv',
        roomCapabilities: [...STANDARD_ROOM_OWNER_PRODUCT_CAPABILITIES],
      },
    ]);

    expect(
      acceptStandardQueueMutationRequest({
        conn,
        requestId: REQUEST_ID,
        requestName: MSG.REQUEST_PLAYLIST_REMOVE,
        fingerprint: `remove:${QUEUE_ITEM_ID}`,
      }),
    ).toBe('accepted');
    expect(conn.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: MSG.OPERATOR_QUEUE_MUTATION_RESULT,
        phase: 'accepted',
        outcome: null,
      }),
    );
  });
});
