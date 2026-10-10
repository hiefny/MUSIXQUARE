import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  developerQueueMode,
  initialQueueModeState,
  normalizeStoredQueueMode,
  parseQueueModeValues,
  PLAYLIST_MAX_ITEMS,
  publicQueueMode,
  shuffledQueueItemIds,
  type QueueModePlaylistItem,
  type RoomWithQueueMode,
  type StoredQueueMode,
} from '../../../cloudflare/pro-room-queue-mode.ts';

const A = '0b6f2f3e-8a4c-4d2b-9e1f-3a5b7c9d1e2f';
const B = '1c7e3a4f-5b6d-4e8f-a1b2-c3d4e5f6a7b8';
const C = '2d8f4b5a-6c7e-4f90-b2c3-d4e5f6a7b8c9';
const NOT_IN_PLAYLIST = '3e9a5c6b-7d8f-4a01-8c3d-e5f6a7b8c9d0';
const NOT_V4 = '4fab6d7c-8e9a-1b12-9d4e-f6a7b8c9d0e1';
const UPPERCASE = 'ABCDEF01-2345-4678-89AB-CDEF01234567';

const playlistOf = (...ids: string[]): QueueModePlaylistItem[] =>
  ids.map((queueItemId) => ({ queueItemId }));
const PLAYLIST = playlistOf(A, B, C);

function values(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { repeatMode: 0, shuffleEnabled: false, shuffleOrder: [], ...overrides };
}

function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { revision: 3, updatedAtMs: 1_700_000_000_000, ...values(overrides) };
}

function room(queueMode: Partial<StoredQueueMode> = {}): RoomWithQueueMode {
  return {
    roomCode: '000001',
    playlistRevision: 9,
    queueMode: {
      revision: 4,
      updatedAtMs: 1234,
      repeatMode: 1,
      shuffleEnabled: true,
      shuffleOrder: [C, A, B],
      ...queueMode,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PRO queue mode participant input', () => {
  it.each([0, 1, 2] as const)('accepts repeat mode %s without shuffle', (repeatMode) => {
    expect(parseQueueModeValues(values({ repeatMode }), PLAYLIST)).toEqual({
      repeatMode,
      shuffleEnabled: false,
      shuffleOrder: [],
    });
  });

  it('accepts an exact shuffle permutation and returns a copy of it', () => {
    const shuffleOrder = [C, A, B];
    const parsed = parseQueueModeValues(values({ shuffleEnabled: true, shuffleOrder }), PLAYLIST);
    expect(parsed).toEqual({ repeatMode: 0, shuffleEnabled: true, shuffleOrder: [C, A, B] });
    expect(parsed?.shuffleOrder).not.toBe(shuffleOrder);
  });

  it('matches queue item ids case-insensitively when they are in the playlist', () => {
    expect(
      parseQueueModeValues(
        values({ shuffleEnabled: true, shuffleOrder: [UPPERCASE] }),
        playlistOf(UPPERCASE),
      ),
    ).toEqual({ repeatMode: 0, shuffleEnabled: true, shuffleOrder: [UPPERCASE] });
  });

  it('accepts shuffle on an empty playlist with an empty order', () => {
    expect(parseQueueModeValues(values({ shuffleEnabled: true }), [])).toEqual({
      repeatMode: 0,
      shuffleEnabled: true,
      shuffleOrder: [],
    });
  });

  it.each([
    ['an extra key', values({ extra: true })],
    ['stored-only keys', stored()],
    ['a missing key', { repeatMode: 0, shuffleEnabled: false }],
    ['an array', [0, false, []]],
    ['null', null],
    ['a string', 'repeat'],
  ])('rejects %s', (_label, value) => {
    expect(parseQueueModeValues(value, PLAYLIST)).toBeNull();
  });

  it.each([3, -1, '1', 1.5, null])('rejects repeat mode %j', (repeatMode) => {
    expect(parseQueueModeValues(values({ repeatMode }), PLAYLIST)).toBeNull();
  });

  it.each(['true', 1, null])('rejects shuffle flag %j', (shuffleEnabled) => {
    expect(parseQueueModeValues(values({ shuffleEnabled }), PLAYLIST)).toBeNull();
  });

  it.each([
    ['a string order', `${A},${B},${C}`],
    ['an object order', { 0: A, 1: B, 2: C }],
    ['an order over the playlist cap', Array.from({ length: PLAYLIST_MAX_ITEMS + 1 }, () => A)],
  ])('rejects %s', (_label, shuffleOrder) => {
    expect(PLAYLIST_MAX_ITEMS).toBe(1000);
    expect(
      parseQueueModeValues(values({ shuffleEnabled: true, shuffleOrder }), PLAYLIST),
    ).toBeNull();
  });

  it.each([
    ['a non-string id', PLAYLIST, [A, B, 42]],
    ['a non-v4 UUID that is in the playlist', playlistOf(A, B, NOT_V4), [A, B, NOT_V4]],
    ['an id that is not in the playlist', PLAYLIST, [A, B, NOT_IN_PLAYLIST]],
    ['a duplicate id', PLAYLIST, [A, A, B]],
    ['a partial permutation', PLAYLIST, [A, B]],
  ])('rejects a shuffle order with %s', (_label, playlist, shuffleOrder) => {
    expect(
      parseQueueModeValues(values({ shuffleEnabled: true, shuffleOrder }), playlist),
    ).toBeNull();
  });

  it('rejects a non-empty order while shuffle is off', () => {
    expect(parseQueueModeValues(values({ shuffleOrder: [A, B, C] }), PLAYLIST)).toBeNull();
    expect(parseQueueModeValues(values({ shuffleOrder: [A] }), PLAYLIST)).toBeNull();
  });
});

describe('PRO queue mode stored state restore', () => {
  it('restores a valid stored state with its revision and timestamp', () => {
    expect(
      normalizeStoredQueueMode(
        stored({ repeatMode: 2, shuffleEnabled: true, shuffleOrder: [B, C, A] }),
        PLAYLIST,
      ),
    ).toEqual({
      revision: 3,
      updatedAtMs: 1_700_000_000_000,
      repeatMode: 2,
      shuffleEnabled: true,
      shuffleOrder: [B, C, A],
    });
    expect(normalizeStoredQueueMode(initialQueueModeState(), PLAYLIST)).toEqual({
      revision: 0,
      updatedAtMs: 0,
      repeatMode: 0,
      shuffleEnabled: false,
      shuffleOrder: [],
    });
  });

  it.each(['revision', 'updatedAtMs'])('requires %s to be a safe non-negative integer', (field) => {
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
      expect(normalizeStoredQueueMode(stored({ [field]: invalid }), PLAYLIST)).toBeNull();
    }
    const missing = stored();
    delete missing[field];
    expect(normalizeStoredQueueMode(missing, PLAYLIST)).toBeNull();
    expect(
      normalizeStoredQueueMode(stored({ [field]: Number.MAX_SAFE_INTEGER }), PLAYLIST),
    ).not.toBeNull();
  });

  it('rejects participant-shaped values and orders that reference removed items', () => {
    expect(normalizeStoredQueueMode(values(), PLAYLIST)).toBeNull();
    expect(
      normalizeStoredQueueMode(
        stored({ shuffleEnabled: true, shuffleOrder: [A, B, C] }),
        playlistOf(A, B),
      ),
    ).toBeNull();
  });
});

describe('PRO queue mode projections', () => {
  it('returns a public snapshot whose order cannot mutate the room', () => {
    const source = room();
    const projected = publicQueueMode(source);
    expect(projected).toEqual({
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: '000001',
      revision: 4,
      playlistRevision: 9,
      updatedAtMs: 1234,
      repeatMode: 1,
      shuffleEnabled: true,
      shuffleOrder: [C, A, B],
    });
    projected.shuffleOrder.push(A);
    projected.shuffleOrder.reverse();
    expect(source.queueMode.shuffleOrder).toEqual([C, A, B]);
  });

  it.each([
    [0, 'off'],
    [1, 'all'],
    [2, 'one'],
  ] as const)('maps repeat mode %s to %s for developers without the order', (repeatMode, label) => {
    const projected = developerQueueMode(room({ repeatMode }));
    expect(projected).toEqual({
      schemaVersion: 1,
      view: 'queue-mode',
      roomCode: '000001',
      revision: 4,
      playlistRevision: 9,
      updatedAtMs: 1234,
      repeatMode: label,
      shuffleEnabled: true,
    });
    expect(projected).not.toHaveProperty('shuffleOrder');
  });
});

describe('PRO queue shuffle', () => {
  it('returns a permutation of the playlist without mutating it', () => {
    expect(shuffledQueueItemIds([])).toEqual([]);
    expect(shuffledQueueItemIds(playlistOf(A))).toEqual([A]);
    const playlist = playlistOf(A, B, C);
    const shuffled = shuffledQueueItemIds(playlist);
    expect([...shuffled].sort()).toEqual([A, B, C].sort());
    expect(playlist).toEqual(playlistOf(A, B, C));
  });

  it('draws one random value per swap from the platform CSPRNG', () => {
    const getRandomValues = vi
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint32Array) array[0] = 0;
        return array;
      });
    // Fisher-Yates with every draw at zero: swap [2]<->[0], then [1]<->[0].
    expect(shuffledQueueItemIds(playlistOf(A, B, C))).toEqual([B, C, A]);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });
});
