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

  it('bounds playlist switch and transfer requests to the room playlists', async () => {
    const switchHandler = vi.fn();
    const transferHandler = vi.fn();
    registerHandler(MSG.REQUEST_PLAYLIST_SWITCH, switchHandler);
    registerHandler(MSG.REQUEST_PLAYLIST_TRANSFER, transferHandler);
    const conn = liveConnection();
    const switchRequest = {
      type: MSG.REQUEST_PLAYLIST_SWITCH,
      requestId: REQUEST_ID,
      baseRevision: 2,
      slot: 2,
    } as const;
    await handleData(switchRequest, conn);
    await handleData({ ...switchRequest, slot: 3 }, conn);
    await handleData({ ...switchRequest, slot: 1.5 }, conn);
    await handleData({ ...switchRequest, extra: true }, conn);
    expect(switchHandler).toHaveBeenCalledTimes(1);

    const transfer = {
      type: MSG.REQUEST_PLAYLIST_TRANSFER,
      requestId: REQUEST_ID,
      baseRevision: 2,
      queueItemIds: [QID_A, QID_B],
      targetSlots: [1, 2],
      mode: 'copy',
    } as const;
    await handleData(transfer, conn);
    await handleData({ ...transfer, mode: 'move' }, conn);
    await handleData({ ...transfer, mode: 'swap' }, conn);
    await handleData({ ...transfer, targetSlots: [] }, conn);
    await handleData({ ...transfer, targetSlots: [0, 1, 2] }, conn);
    await handleData({ ...transfer, targetSlots: [1, 1] }, conn);
    await handleData({ ...transfer, queueItemIds: [QID_A, QID_A] }, conn);
    expect(transferHandler).toHaveBeenCalledTimes(2);
  });

  it('accepts only an exact three-playlist summary from the host', async () => {
    const handler = vi.fn();
    registerHandler(MSG.PLAYLIST_SLOTS, handler);
    const conn = liveHostConnection();
    const summary = {
      type: MSG.PLAYLIST_SLOTS,
      activeSlot: 1,
      slots: [
        { count: 3, bytes: 1024 },
        { count: 0, bytes: null },
        { count: 2, bytes: null },
      ],
    } as const;
    await handleData(summary, conn);
    await handleData({ ...summary, slots: summary.slots.slice(0, 2) }, conn);
    await handleData({ ...summary, activeSlot: 3 }, conn);
    await handleData(
      { ...summary, slots: [{ count: -1, bytes: null }, ...summary.slots.slice(1)] },
      conn,
    );
    await handleData(
      { ...summary, slots: [{ count: 1, bytes: null, extra: 1 }, ...summary.slots.slice(1)] },
      conn,
    );
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
