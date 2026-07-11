import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MSG } from '../../core/constants.ts';
import { bus } from '../../core/events.ts';
import { resetState } from '../../core/state.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import { handleData, registerHandler } from '../protocol.ts';

const QID = '00000000-0000-4000-8000-000000000001' as QueueItemId;

function connection(peer: string): DataConnection {
  return { peer } as DataConnection;
}

beforeEach(() => {
  resetState();
  bus.clear();
});

describe('correlated file request protocol', () => {
  it('dispatches only fully correlated FILE_WAIT responses', async () => {
    const handler = vi.fn();
    registerHandler(MSG.FILE_WAIT, handler);
    const conn = connection('file-wait-host');
    const valid = {
      type: MSG.FILE_WAIT,
      requestId: 1,
      queueItemId: QID,
      sessionId: 7,
      message: 'Host file is not ready yet',
      reason: 'not_ready',
    };

    await handleData(valid, conn);
    await handleData({ ...valid, requestId: undefined }, conn);
    await handleData({ ...valid, requestId: 0 }, conn);
    await handleData({ ...valid, queueItemId: undefined }, conn);
    await handleData({ ...valid, sessionId: 1.5 }, conn);
    await handleData({ ...valid, message: '' }, conn);
    await handleData({ ...valid, message: 'x'.repeat(513) }, conn);
    await handleData({ ...valid, reason: 'x'.repeat(129) }, conn);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('requires requestId on current-file requests and validates optional session IDs', async () => {
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_CURRENT_FILE, handler);
    const conn = connection('current-file-guest');
    const valid = {
      type: MSG.REQUEST_CURRENT_FILE,
      requestId: 2,
      queueItemId: QID,
      name: 'track.wav',
      reason: 'no_buffer',
    };

    await handleData(valid, conn);
    await handleData({ ...valid, sessionId: 8 }, conn);
    await handleData({ ...valid, requestId: undefined }, conn);
    await handleData({ ...valid, requestId: Number.MAX_SAFE_INTEGER + 1 }, conn);
    await handleData({ ...valid, sessionId: 0 }, conn);
    await handleData({ ...valid, reason: 'x'.repeat(129) }, conn);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('requires the complete recovery request tuple', async () => {
    const handler = vi.fn();
    registerHandler(MSG.REQUEST_DATA_RECOVERY, handler);
    const conn = connection('recovery-guest');
    const valid = {
      type: MSG.REQUEST_DATA_RECOVERY,
      requestId: 3,
      queueItemId: QID,
      nextChunk: 0,
      fileName: 'track.wav',
    };

    await handleData(valid, conn);
    await handleData({ ...valid, sessionId: 9 }, conn);
    await handleData({ ...valid, requestId: -1 }, conn);
    await handleData({ ...valid, queueItemId: undefined }, conn);
    await handleData({ ...valid, nextChunk: -1 }, conn);
    await handleData({ ...valid, fileName: '' }, conn);
    await handleData({ ...valid, sessionId: Number.NaN }, conn);

    expect(handler).toHaveBeenCalledTimes(2);
  });
});
