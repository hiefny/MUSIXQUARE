import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../core/constants.ts';
import { resetState, setState } from '../../core/state.ts';
import type { DataConnection } from '../../types/index.ts';
import { handleData, registerHandler } from '../protocol.ts';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const QID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const QID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function liveConnection(): DataConnection {
  const conn = { peer: 'operator-1', open: true } as DataConnection;
  setState('network.appRole', 'host');
  setState('network.activeHostConnByPeerId', new Map([[conn.peer, conn]]));
  return conn;
}

function liveHostConnection(): DataConnection {
  const conn = { peer: 'host', open: true } as DataConnection;
  setState('network.appRole', 'guest');
  setState('network.hostConn', conn);
  return conn;
}

beforeEach(() => resetState());

describe('standard operator queue request protocol', () => {
  it('accepts only an exact bounded YouTube add shape', async () => {
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_PLAYLIST_ADD_YOUTUBE, handler);
    const conn = liveConnection();
    const valid = {
      type: MSG.REQUEST_PLAYLIST_ADD_YOUTUBE,
      requestId: REQUEST_ID,
      baseRevision: 0,
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Video',
    } as const;

    await handleData(valid, conn);
    await handleData({ ...valid, requestId: 'predictable' }, conn);
    await handleData({ ...valid, extra: true }, conn);
    await handleData({ ...valid, sourceUrl: 'x'.repeat(2049) }, conn);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('requires unique stable IDs for delete-many', async () => {
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_PLAYLIST_REMOVE, handler);
    const conn = liveConnection();
    const valid = {
      type: MSG.REQUEST_PLAYLIST_REMOVE,
      requestId: REQUEST_ID,
      baseRevision: 3,
      queueItemIds: [QID_A, QID_B],
    } as const;

    await handleData(valid, conn);
    await handleData({ ...valid, requestId: QID_A, queueItemIds: [QID_A, QID_A] }, conn);
    await handleData({ ...valid, requestId: QID_B, queueItemIds: [] }, conn);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid revisions and self-anchored reorders', async () => {
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_PLAYLIST_REORDER, handler);
    const conn = liveConnection();
    const valid = {
      type: MSG.REQUEST_PLAYLIST_REORDER,
      requestId: REQUEST_ID,
      baseRevision: 4,
      queueItemId: QID_A,
      beforeQueueItemId: QID_B,
    } as const;

    await handleData(valid, conn);
    await handleData({ ...valid, requestId: QID_A, baseRevision: -1 }, conn);
    await handleData({ ...valid, requestId: QID_B, beforeQueueItemId: QID_A }, conn);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('accepts only coherent exact queue mutation result phases', async () => {
    const handler = vi.fn();
    registerHandler(MSG.OPERATOR_QUEUE_MUTATION_RESULT, handler);
    const conn = liveHostConnection();
    const accepted = {
      type: MSG.OPERATOR_QUEUE_MUTATION_RESULT,
      requestId: REQUEST_ID,
      phase: 'accepted',
      outcome: null,
      revision: 4,
      code: null,
    } as const;

    await handleData(accepted, conn);
    await handleData({ ...accepted, outcome: 'applied' }, conn);
    await handleData(
      {
        ...accepted,
        phase: 'settled',
        outcome: 'rejected',
        code: 'unbounded-code',
      },
      conn,
    );
    await handleData({ ...accepted, extra: true }, conn);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
