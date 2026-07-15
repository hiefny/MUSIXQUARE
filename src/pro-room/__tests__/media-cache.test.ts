import { describe, expect, it } from 'vitest';
import type { ProRoomR2Source } from '../contracts.ts';
import { ProRoomAssetCache, proRoomAssetCacheKey } from '../media-cache.ts';

function mediaSource(assetId: string, version: number, byteLength: number): ProRoomR2Source {
  return {
    kind: 'pro-r2',
    assetId,
    version,
    byteLength,
    mime: 'application/octet-stream',
  };
}

describe('PRO room RAM asset cache', () => {
  it('keys immutable media by asset and version and restores the requested safe name/MIME', () => {
    const cache = new ProRoomAssetCache(8);
    const v1 = mediaSource('asset_00000000001', 1, 4);
    const v2 = mediaSource('asset_00000000001', 2, 4);
    cache.put(v1, new File(['data'], 'original.bin', { type: 'application/octet-stream' }));

    const hit = cache.get(v1, 'orchestra.flac');
    expect(hit?.name).toBe('orchestra.flac');
    expect(hit?.type).toBe('audio/flac');
    expect(hit?.size).toBe(4);
    expect(cache.get(v2)).toBeNull();
    expect(proRoomAssetCacheKey(v1)).not.toBe(proRoomAssetCacheKey(v2));
  });

  it('evicts the least recently used entries while keeping a strict byte ledger', () => {
    const cache = new ProRoomAssetCache(6);
    const a = mediaSource('asset_00000000001', 1, 3);
    const b = mediaSource('asset_00000000002', 1, 3);
    const c = mediaSource('asset_00000000003', 1, 3);
    cache.put(a, new File(['aaa'], 'a.mp3'));
    cache.put(b, new File(['bbb'], 'b.mp3'));
    expect(cache.get(a)).not.toBeNull();

    cache.put(c, new File(['ccc'], 'c.mp3'));
    expect(cache.get(b)).toBeNull();
    expect(cache.get(a)).not.toBeNull();
    expect(cache.get(c)).not.toBeNull();
    expect(cache.size).toBe(2);
    expect(cache.totalBytes).toBe(6);
  });

  it('fails closed on size mismatch and supports explicit asset/session cleanup', () => {
    const cache = new ProRoomAssetCache(8);
    const v1 = mediaSource('asset_00000000001', 1, 4);
    const v2 = mediaSource('asset_00000000001', 2, 4);
    expect(() => cache.put(v1, new File(['bad'], 'bad.mp3'))).toThrow(
      'PRO_ROOM_CACHE_SIZE_MISMATCH',
    );

    cache.put(v1, new File(['data'], 'v1.mp3'));
    cache.put(v2, new File(['next'], 'v2.mp3'));
    expect(cache.deleteAsset(v1.assetId)).toBe(2);
    expect(cache.totalBytes).toBe(0);

    cache.put(v1, new File(['data'], 'v1.mp3'));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.totalBytes).toBe(0);
  });

  it('cannot be configured above the 200 MiB product boundary', () => {
    expect(() => new ProRoomAssetCache(0)).toThrow('PRO_ROOM_CACHE_INVALID_BUDGET');
    expect(() => new ProRoomAssetCache(200 * 1024 * 1024 + 1)).toThrow(
      'PRO_ROOM_CACHE_INVALID_BUDGET',
    );
  });
});
