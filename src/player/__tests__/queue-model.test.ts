import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getState, resetState, setState } from '../../core/state.ts';
import type { PlaylistItem, PlaylistWireItem, QueueItemId } from '../../types/index.ts';
import {
  applyPlaylistSnapshot,
  commitPlaylistItems,
  createPlaylistSnapshot,
  createQueueItemId,
  findQueueItemIndex,
  getCurrentQueueItemIndex,
  isQueueItemId,
  moveQueueItemBefore,
  parsePlaylistSnapshot,
  selectQueueItemById,
} from '../queue-model.ts';

const QID_A = '00000000-0000-4000-8000-000000000001' as QueueItemId;
const QID_B = '00000000-0000-4000-8000-000000000002' as QueueItemId;
const QID_C = '00000000-0000-4000-8000-000000000003' as QueueItemId;

function fileItem(queueItemId: QueueItemId, name: string): PlaylistItem {
  return {
    queueItemId,
    type: 'file',
    name,
    videoId: null,
    playlistId: null,
  };
}

function wireItem(queueItemId: QueueItemId, name: string): PlaylistWireItem {
  return {
    queueItemId,
    type: 'file',
    name,
    videoId: null,
    playlistId: null,
  };
}

describe('queue model', () => {
  beforeEach(() => {
    resetState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates distinct, secure UUIDv4 queue occurrence IDs', () => {
    const first = createQueueItemId();
    const second = createQueueItemId();

    expect(isQueueItemId(first)).toBe(true);
    expect(isQueueItemId(second)).toBe(true);
    expect(second).not.toBe(first);
  });

  it('uses secure random bytes when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues<T extends ArrayBufferView>(value: T): T {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        bytes.forEach((_byte, index) => {
          bytes[index] = index;
        });
        return value;
      },
    });

    expect(createQueueItemId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('keeps duplicate media occurrences distinct by queueItemId', () => {
    const items = [fileItem(QID_A, 'same.mp3'), fileItem(QID_B, 'same.mp3')];
    setState('playlist.items', items);

    expect(findQueueItemIndex(QID_A)).toBe(0);
    expect(findQueueItemIndex(QID_B)).toBe(1);
    expect(items[0]?.name).toBe(items[1]?.name);
  });

  it('serializes only wire-safe metadata while preserving occurrence IDs', () => {
    const localFile = new File(['audio'], 'local.mp3', { type: 'audio/mpeg' });
    const item: PlaylistItem = {
      ...fileItem(QID_A, localFile.name),
      file: localFile,
      title: 'Local',
      isExpanded: true,
    };

    setState('playlist.items', [item]);

    expect(createPlaylistSnapshot().list).toEqual([
      {
        queueItemId: QID_A,
        type: 'file',
        name: 'local.mp3',
        title: 'Local',
        videoId: null,
        playlistId: null,
      },
    ]);
  });

  it('rejects malformed, duplicate, and dangling-current snapshots', () => {
    expect(
      parsePlaylistSnapshot({
        list: [wireItem(QID_A, 'a.mp3'), wireItem(QID_A, 'again.mp3')],
        revision: 1,
        currentQueueItemId: QID_A,
      }),
    ).toBeNull();

    expect(
      parsePlaylistSnapshot({
        list: [wireItem(QID_A, 'a.mp3')],
        revision: 1,
        currentQueueItemId: QID_B,
      }),
    ).toBeNull();

    expect(
      parsePlaylistSnapshot({
        list: [{ ...wireItem(QID_A, 'a.mp3'), file: {} }],
        revision: 1,
        currentQueueItemId: QID_A,
      }),
    ).toBeNull();
  });

  it('classifies monotonic apply, duplicate, conflict, stale, and invalid snapshots', () => {
    const first = {
      list: [wireItem(QID_A, 'a.mp3')],
      revision: 2,
      currentQueueItemId: QID_A,
    };

    expect(applyPlaylistSnapshot(first)).toBe('applied');
    expect(getState('playlist.items')).toEqual(first.list);
    expect(getState('playlist.currentQueueItemId')).toBe(QID_A);
    expect(getState('playlist.revision')).toBe(2);

    expect(applyPlaylistSnapshot(first)).toBe('duplicate');

    expect(
      applyPlaylistSnapshot({
        list: [wireItem(QID_B, 'conflict.mp3')],
        revision: 2,
        currentQueueItemId: QID_B,
      }),
    ).toBe('conflict');
    expect(
      applyPlaylistSnapshot({
        list: [wireItem(QID_B, 'stale.mp3')],
        revision: 1,
        currentQueueItemId: QID_B,
      }),
    ).toBe('stale');
    expect(getState('playlist.items')).toEqual(first.list);

    expect(
      applyPlaylistSnapshot({
        list: [wireItem(QID_B, 'invalid.mp3'), wireItem(QID_B, 'duplicate.mp3')],
        revision: 3,
        currentQueueItemId: QID_B,
      }),
    ).toBe('invalid');
    expect(createPlaylistSnapshot()).toEqual(first);
  });

  it('rebases a changed revision-zero authority but preserves an identical baseline', () => {
    setState('playlist.items', [fileItem(QID_A, 'old.mp3')]);
    setState('playlist.currentQueueItemId', QID_A);
    setState('playlist.revision', 42);

    const emptyRevisionZero = {
      list: [],
      revision: 0,
      currentQueueItemId: null,
      bootstrap: true,
    };
    expect(applyPlaylistSnapshot(emptyRevisionZero, 'rebase')).toBe('rebased');
    expect(createPlaylistSnapshot()).toEqual({
      list: [],
      revision: 0,
      currentQueueItemId: null,
    });

    expect(applyPlaylistSnapshot(emptyRevisionZero, 'rebase')).toBe('rebased');
    expect(applyPlaylistSnapshot(emptyRevisionZero)).toBe('duplicate');
  });

  it('increments revision once per commit and preserves current identity through reorder', () => {
    const a = fileItem(QID_A, 'a.mp3');
    const b = fileItem(QID_B, 'b.mp3');
    const c = fileItem(QID_C, 'c.mp3');

    const initial = commitPlaylistItems([a, b, c], { currentQueueItemId: QID_B });
    expect(initial.revision).toBe(1);

    const reordered = moveQueueItemBefore(QID_B, QID_A, [a, b, c]);
    expect(reordered).toEqual([b, a, c]);
    expect(reordered?.[0]).toBe(b);

    const committed = commitPlaylistItems(reordered ?? []);
    expect(committed.revision).toBe(2);
    expect(committed.currentQueueItemId).toBe(QID_B);
    expect(getCurrentQueueItemIndex()).toBe(0);
  });

  it('rejects invalid host commits without changing revision or items', () => {
    const valid = fileItem(QID_A, 'a.mp3');
    commitPlaylistItems([valid]);

    expect(() =>
      commitPlaylistItems([{ ...fileItem(QID_B, 'b.mp3'), queueItemId: 'not-a-uuid' }]),
    ).toThrow('Invalid queueItemId');
    expect(getState('playlist.items')).toEqual([valid]);
    expect(getState('playlist.revision')).toBe(1);
  });

  it('rejects invalid/no-op moves and resolves selection from stable IDs', () => {
    const items = [fileItem(QID_A, 'a.mp3'), fileItem(QID_B, 'b.mp3')];
    setState('playlist.items', items);

    expect(moveQueueItemBefore(QID_A, QID_A)).toBeNull();
    expect(moveQueueItemBefore(QID_A, QID_B)).toBeNull();
    expect(moveQueueItemBefore(QID_C, null)).toBeNull();
    expect(selectQueueItemById(QID_B)).toBe(true);
    expect(getCurrentQueueItemIndex()).toBe(1);
    expect(selectQueueItemById(QID_C)).toBe(false);
    expect(getState('playlist.currentQueueItemId')).toBe(QID_B);
  });
});
