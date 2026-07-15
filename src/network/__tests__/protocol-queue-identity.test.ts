import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CHUNK_SIZE, MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import { handleData, registerHandler } from '../protocol.ts';

const QID_A = '00000000-0000-4000-8000-000000000001' as QueueItemId;

function connection(peer: string): DataConnection {
  return { peer } as DataConnection;
}

beforeEach(() => {
  resetState();
  bus.clear();
});

describe('queue identity protocol validation', () => {
  it('accepts only bounded integer PRO snapshot invalidations', async () => {
    const handler = vi.fn();
    registerHandler(MSG.PRO_ROOM_INVALIDATED, handler);
    const conn = connection('pro-member');

    await handleData({ type: MSG.PRO_ROOM_INVALIDATED, revision: 4, playlistRevision: 2 }, conn);
    await handleData({ type: MSG.PRO_ROOM_INVALIDATED, revision: -1, playlistRevision: 2 }, conn);
    await handleData({ type: MSG.PRO_ROOM_INVALIDATED, revision: 5, playlistRevision: 1.5 }, conn);
    await handleData(
      {
        type: MSG.PRO_ROOM_INVALIDATED,
        revision: Number.MAX_SAFE_INTEGER + 1,
        playlistRevision: 3,
      },
      conn,
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('dispatches only complete, internally consistent playlist snapshots', async () => {
    const handler = vi.fn();
    registerHandler(MSG.PLAYLIST_UPDATE, handler);
    const conn = connection('snapshot-peer');
    const item = {
      queueItemId: QID_A,
      type: 'file',
      name: 'a.mp3',
      videoId: null,
      playlistId: null,
    };

    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [item],
        revision: 1,
        currentQueueItemId: QID_A,
        bootstrap: true,
      },
      conn,
    );
    expect(handler).toHaveBeenCalledTimes(1);

    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [item, { ...item }],
        revision: 2,
        currentQueueItemId: QID_A,
      },
      conn,
    );
    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [item],
        revision: 2,
        currentQueueItemId: '00000000-0000-4000-8000-000000000002',
      },
      conn,
    );
    await handleData(
      {
        type: MSG.PLAYLIST_UPDATE,
        list: [item],
        revision: 2,
        currentQueueItemId: QID_A,
        bootstrap: false,
      },
      conn,
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps chunk offsets separate from queue occurrence identity', async () => {
    const handler = vi.fn();
    registerHandler(MSG.FILE_CHUNK, handler);
    const conn = connection('file-chunk-peer');
    const base = {
      type: MSG.FILE_CHUNK,
      chunk: new Uint8Array([1]),
      chunkIndex: 0,
      queueItemId: QID_A,
      sessionId: 1,
      total: 1,
      name: 'a.mp3',
      size: 1,
    };

    await handleData(base, conn);
    expect(handler).toHaveBeenCalledTimes(1);

    await handleData({ ...base, chunkIndex: undefined, index: 0 }, conn);
    await handleData({ ...base, queueItemId: undefined }, conn);
    await handleData({ ...base, chunk: new Uint8Array(CHUNK_SIZE + 1) }, conn);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('requires the queue item plus transfer session on preload control frames', async () => {
    const handler = vi.fn();
    registerHandler(MSG.PRELOAD_ACK, handler);
    const conn = connection('preload-ack-peer');

    await handleData({ type: MSG.PRELOAD_ACK, queueItemId: QID_A, sessionId: 7 }, conn);
    await handleData({ type: MSG.PRELOAD_ACK, queueItemId: QID_A }, conn);
    await handleData({ type: MSG.PRELOAD_ACK, sessionId: 7 }, conn);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects playback commands that identify a row only by an old index', async () => {
    const handler = vi.fn();
    registerHandler(MSG.PLAY, handler);
    const conn = connection('play-peer');

    await handleData({ type: MSG.PLAY, time: 0, queueItemId: QID_A }, conn);
    await handleData({ type: MSG.PLAY, time: 0, index: 0 }, conn);

    expect(handler).toHaveBeenCalledTimes(1);
  });
});
