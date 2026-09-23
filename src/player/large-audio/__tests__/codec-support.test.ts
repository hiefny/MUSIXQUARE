import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLargeAudioTrack } from '../index.ts';

const mocks = vi.hoisted(() => ({
  codec: 'opus',
  dispose: vi.fn(),
  canDecode: vi.fn(async () => true),
  firstTimestamp: vi.fn(async () => 0),
}));

vi.mock('mediabunny', async (importOriginal) => {
  const original = await importOriginal<typeof import('mediabunny')>();
  return {
    ...original,
    Input: class {
      async getPrimaryAudioTrack() {
        return {
          getCodec: async () => mocks.codec,
          canDecode: mocks.canDecode,
          getFirstTimestamp: mocks.firstTimestamp,
        };
      }
      dispose = mocks.dispose;
    },
  };
});

afterEach(() => vi.clearAllMocks());

describe('bounded engine codec eligibility', () => {
  it.each(['opus', 'vorbis', 'aac'])(
    'refuses unverified %s timing before decoding or scanning the track',
    async (codec) => {
      mocks.codec = codec;
      await expect(openLargeAudioTrack(new Blob([new Uint8Array(32)]))).rejects.toThrow(
        `Unsupported large audio codec: ${codec}`,
      );
      expect(mocks.canDecode).not.toHaveBeenCalled();
      expect(mocks.firstTimestamp).not.toHaveBeenCalled();
      expect(mocks.dispose).toHaveBeenCalledOnce();
    },
  );
});
