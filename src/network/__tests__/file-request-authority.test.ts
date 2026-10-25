import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MSG } from '../../core/constants.ts';
import type { DataConnection, QueueItemId } from '../../types/index.ts';
import {
  beginFileRequest,
  completeFileRequest,
  getCurrentFileRequestOwnerForTests,
  isCurrentFileRequestOwner,
  isFileRequestId,
  isPendingRecoveryRequestFor,
  matchFileWaitResponse,
  resetFileRequestAuthority,
  sendFileRequest,
} from '../file-request-authority.ts';

const QID_A = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const QID_B = '00000000-0000-4000-8000-000000000002' as QueueItemId;

function connection(peer = 'host'): DataConnection {
  return { peer, open: true, send: vi.fn() } as unknown as DataConnection;
}

beforeEach(() => {
  resetFileRequestAuthority();
});

describe('file request authority', () => {
  it('allocates unique positive-safe request IDs and sends the owned tuple', () => {
    const conn = connection();
    const first = beginFileRequest(conn, QID_A);
    const second = beginFileRequest(conn, QID_B, 7);

    expect(isFileRequestId(first.requestId)).toBe(true);
    expect(isFileRequestId(second.requestId)).toBe(true);
    expect(second.requestId).toBeGreaterThan(first.requestId);
    expect(
      sendFileRequest(second, {
        type: MSG.REQUEST_DATA_RECOVERY,
        nextChunk: 3,
        fileName: 'b.wav',
      }),
    ).toBe(true);
    expect(conn.send).toHaveBeenCalledWith({
      type: MSG.REQUEST_DATA_RECOVERY,
      nextChunk: 3,
      fileName: 'b.wav',
      requestId: second.requestId,
      queueItemId: QID_B,
      sessionId: 7,
    });
  });

  it('requires exact connection identity even when peer IDs match', () => {
    const currentConn = connection('same-host');
    const replacedConn = connection('same-host');
    const owner = beginFileRequest(currentConn, QID_A);
    const response = {
      requestId: owner.requestId,
      queueItemId: QID_A,
      message: 'wait',
    };

    expect(matchFileWaitResponse(replacedConn, response)).toBeNull();
    expect(matchFileWaitResponse(currentConn, response)).toBe(owner);
  });

  it('rejects a replaced request even for the same queue occurrence', () => {
    const conn = connection();
    const first = beginFileRequest(conn, QID_A);
    const second = beginFileRequest(conn, QID_A);

    expect(
      matchFileWaitResponse(conn, {
        requestId: first.requestId,
        queueItemId: QID_A,
        message: 'late',
      }),
    ).toBeNull();
    expect(
      matchFileWaitResponse(conn, {
        requestId: second.requestId,
        queueItemId: QID_A,
        message: 'current',
      }),
    ).toBe(second);
  });

  it('matches optional session presence and value exactly for FILE_WAIT', () => {
    const conn = connection();
    const owner = beginFileRequest(conn, QID_A, 11);
    const base = { requestId: owner.requestId, queueItemId: QID_A, message: 'wait' };

    expect(matchFileWaitResponse(conn, base)).toBeNull();
    expect(matchFileWaitResponse(conn, { ...base, sessionId: 10 })).toBeNull();
    expect(matchFileWaitResponse(conn, { ...base, sessionId: 11 })).toBe(owner);

    const unscoped = beginFileRequest(conn, QID_A);
    const unscopedBase = {
      requestId: unscoped.requestId,
      queueItemId: QID_A,
      message: 'wait',
    };
    expect(matchFileWaitResponse(conn, { ...unscopedBase, sessionId: 11 })).toBeNull();
    expect(matchFileWaitResponse(conn, unscopedBase)).toBe(unscoped);
  });

  it('prevents a stale owner or completion from clearing its successor', () => {
    const conn = connection();
    beginFileRequest(conn, QID_A, 4);
    const second = beginFileRequest(conn, QID_B, 5);

    expect(completeFileRequest(conn, QID_A, 4)).toBe(false);
    expect(isCurrentFileRequestOwner(second)).toBe(true);
    expect(getCurrentFileRequestOwnerForTests()).toBe(second);

    expect(completeFileRequest(conn, QID_B, 4)).toBe(false);
    expect(completeFileRequest(conn, QID_B, 5)).toBe(true);
    expect(getCurrentFileRequestOwnerForTests()).toBeNull();
  });

  it('lets an unscoped request adopt a successful exact-queue transfer session', () => {
    const conn = connection();
    beginFileRequest(conn, QID_A);

    expect(completeFileRequest(conn, QID_A, 91)).toBe(true);
    expect(getCurrentFileRequestOwnerForTests()).toBeNull();
  });

  it('releases a current owner when its connection closes before send', () => {
    const conn = connection();
    const owner = beginFileRequest(conn, QID_A);
    Object.assign(conn, { open: false });

    expect(
      sendFileRequest(owner, {
        type: MSG.REQUEST_CURRENT_FILE,
        name: 'a.wav',
      }),
    ).toBe(false);
    expect(getCurrentFileRequestOwnerForTests()).toBeNull();
    expect(conn.send).not.toHaveBeenCalled();
  });

  // C5-12 (RO-18): before its route is published, a guest awaiting a preload
  // takes a main FILE_START only for the exact tuple its own recovery asked for.
  it('answers a pending recovery only for its sent request, connection and exact session', () => {
    const conn = connection();
    const owner = beginFileRequest(conn, QID_A, 7);
    expect(isPendingRecoveryRequestFor(conn, QID_A, 7)).toBe(false);

    expect(
      sendFileRequest(owner, { type: MSG.REQUEST_DATA_RECOVERY, nextChunk: 0, fileName: 'a.wav' }),
    ).toBe(true);
    expect(isPendingRecoveryRequestFor(conn, QID_A, 7)).toBe(true);
    expect(isPendingRecoveryRequestFor(connection(), QID_A, 7)).toBe(false);
    expect(isPendingRecoveryRequestFor(conn, QID_B, 7)).toBe(false);
    expect(isPendingRecoveryRequestFor(conn, QID_A, 8)).toBe(false);

    expect(completeFileRequest(conn, QID_A, 7)).toBe(true);
    expect(isPendingRecoveryRequestFor(conn, QID_A, 7)).toBe(false);
  });

  it('does not treat a current-file request, an unscoped recovery or a replaced one as pending', () => {
    const conn = connection();
    const current = beginFileRequest(conn, QID_A, 7);
    expect(sendFileRequest(current, { type: MSG.REQUEST_CURRENT_FILE, name: 'a.wav' })).toBe(true);
    expect(isPendingRecoveryRequestFor(conn, QID_A, 7)).toBe(false);

    const unscoped = beginFileRequest(conn, QID_A);
    expect(
      sendFileRequest(unscoped, {
        type: MSG.REQUEST_DATA_RECOVERY,
        nextChunk: 0,
        fileName: 'a.wav',
      }),
    ).toBe(true);
    expect(isPendingRecoveryRequestFor(conn, QID_A, 7)).toBe(false);

    const recovery = beginFileRequest(conn, QID_A, 7);
    expect(
      sendFileRequest(recovery, {
        type: MSG.REQUEST_DATA_RECOVERY,
        nextChunk: 0,
        fileName: 'a.wav',
      }),
    ).toBe(true);
    beginFileRequest(conn, QID_A, 7);
    expect(isPendingRecoveryRequestFor(conn, QID_A, 7)).toBe(false);

    const again = beginFileRequest(conn, QID_A, 7);
    sendFileRequest(again, { type: MSG.REQUEST_DATA_RECOVERY, nextChunk: 0, fileName: 'a.wav' });
    resetFileRequestAuthority();
    expect(isPendingRecoveryRequestFor(conn, QID_A, 7)).toBe(false);
  });
});
