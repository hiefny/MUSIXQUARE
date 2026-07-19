import { describe, expect, it } from 'vitest';
import type { PlaylistItem, QueueItemId } from '../../types/index.ts';
import {
  findRemovedProRoomQueueItemIds,
  resolveProRoomRemovalTransition,
} from '../playlist-transition.ts';

const A = '11111111-1111-4111-8111-111111111111' as QueueItemId;
const B = '22222222-2222-4222-8222-222222222222' as QueueItemId;
const C = '33333333-3333-4333-8333-333333333333' as QueueItemId;
const D = '44444444-4444-4444-8444-444444444444' as QueueItemId;

function row(queueItemId: QueueItemId): PlaylistItem {
  return {
    queueItemId,
    type: 'youtube',
    name: queueItemId,
    videoId: 'dQw4w9WgXcQ',
    playlistId: null,
  };
}

describe('PRO playlist removal transitions', () => {
  it('reports every removed stable identity, including non-current preload owners', () => {
    expect(
      findRemovedProRoomQueueItemIds([row(A), row(B), row(C), row(D)], [row(A), row(C)]),
    ).toEqual([B, D]);
  });

  it('chooses the first surviving row after current when earlier rows are removed too', () => {
    expect(
      resolveProRoomRemovalTransition([row(A), row(B), row(C), row(D)], [row(C), row(D)], B),
    ).toEqual({ removedCurrent: true, successorQueueItemId: C });
  });

  it('falls back to the nearest surviving previous row', () => {
    expect(resolveProRoomRemovalTransition([row(A), row(B), row(C)], [row(A)], C)).toEqual({
      removedCurrent: true,
      successorQueueItemId: A,
    });
  });

  it('uses a surviving shuffle successor before visible queue order', () => {
    expect(
      resolveProRoomRemovalTransition(
        [row(A), row(B), row(C), row(D)],
        [row(A), row(C), row(D)],
        B,
        D,
      ),
    ).toEqual({ removedCurrent: true, successorQueueItemId: D });
  });

  it('rejects a stale shuffle hint and falls back to the sequential successor', () => {
    expect(
      resolveProRoomRemovalTransition([row(A), row(B), row(C)], [row(A), row(C)], B, D),
    ).toEqual({ removedCurrent: true, successorQueueItemId: C });
  });

  it('does not report a transition when current survives', () => {
    expect(resolveProRoomRemovalTransition([row(A), row(B)], [row(B), row(A)], A)).toEqual({
      removedCurrent: false,
      successorQueueItemId: null,
    });
  });

  it('reports an empty successor when the queue is exhausted', () => {
    expect(resolveProRoomRemovalTransition([row(A)], [], A)).toEqual({
      removedCurrent: true,
      successorQueueItemId: null,
    });
  });
});
