import { describe, expect, it } from 'vitest';
import {
  emptyPlaylistSlots,
  parseStoredPlaylistSlots,
  referencedPlaylistAssetIds,
  storedPlaylistSlots,
  summarizePlaylistSlots,
  swapActivePlaylist,
} from '../../../cloudflare/pro-room-playlists.ts';

type Item = {
  queueItemId: string;
  source: { kind: 'youtube' } | { kind: 'pro-r2'; assetId: string; byteLength: number };
};

const youtube = (queueItemId: string): Item => ({ queueItemId, source: { kind: 'youtube' } });
const file = (queueItemId: string, assetId: string, byteLength: number): Item => ({
  queueItemId,
  source: { kind: 'pro-r2', assetId, byteLength },
});
const isId = (value: string) => /^[a-z0-9-]{1,64}$/u.test(value);

describe('PRO room playlist slots', () => {
  it('validates the stored record strictly', () => {
    const valid = { schemaVersion: 1, activeSlot: 1, orders: [['a', 'b'], [], ['c']] };
    expect(parseStoredPlaylistSlots(valid, 1000, isId)).toEqual(valid);
    for (const invalid of [
      null,
      [],
      { ...valid, schemaVersion: 2 },
      { ...valid, extra: true },
      { ...valid, activeSlot: 3 },
      { ...valid, orders: [['a'], []] },
      { ...valid, orders: [['a'], ['b'], []] },
      { ...valid, orders: [['a'], [], ['a']] },
      { ...valid, orders: [['A B'], [], []] },
      { ...valid, orders: [[1], [], []] },
    ]) {
      expect(parseStoredPlaylistSlots(invalid, 1000, isId)).toBeNull();
    }
    expect(parseStoredPlaylistSlots(valid, 1, isId)).toBeNull();
  });

  it('stores nothing for a single playlist at slot 0', () => {
    expect(storedPlaylistSlots(undefined)).toBeNull();
    expect(storedPlaylistSlots(emptyPlaylistSlots<Item>())).toBeNull();
    expect(storedPlaylistSlots({ activeSlot: 2, inactive: [[youtube('a')], [], []] })).toEqual({
      schemaVersion: 1,
      activeSlot: 2,
      orders: [['a'], [], []],
    });
  });

  it('summarizes counts and file sizes per playlist', () => {
    const active = [youtube('a'), file('b', 'asset-1', 100)];
    const slots = { activeSlot: 0, inactive: [[], [file('c', 'asset-1', 100)], [youtube('d')]] };
    expect(summarizePlaylistSlots(active, slots)).toEqual({
      activeSlot: 0,
      slots: [
        { count: 2, bytes: 100 },
        { count: 1, bytes: 100 },
        { count: 1, bytes: null },
      ],
    });
    expect(summarizePlaylistSlots([], undefined).slots).toEqual([
      { count: 0, bytes: null },
      { count: 0, bytes: null },
      { count: 0, bytes: null },
    ]);
    expect([...referencedPlaylistAssetIds([], slots)]).toEqual(['asset-1']);
  });

  it('swaps the active playlist with another slot', () => {
    const swapped = swapActivePlaylist([youtube('a')], undefined, 2);
    expect(swapped.active).toEqual([]);
    expect(swapped.slots).toEqual({ activeSlot: 2, inactive: [[youtube('a')], [], []] });
    const back = swapActivePlaylist(swapped.active, swapped.slots, 0);
    expect(back.active).toEqual([youtube('a')]);
    expect(storedPlaylistSlots(back.slots)).toBeNull();
  });
});
