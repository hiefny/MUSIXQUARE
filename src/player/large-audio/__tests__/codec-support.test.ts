import { ALL_FORMATS, HLS, type InputFormat } from 'mediabunny';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLargeAudioTrack } from '../index.ts';

const mocks = vi.hoisted(() => ({
  codec: 'opus',
  format: 'mp4',
  inputFormats: null as readonly InputFormat[] | null,
  dispose: vi.fn(),
  canDecode: vi.fn(async () => true),
  firstTimestamp: vi.fn(async () => 0),
  decoderConfig: vi.fn(async () => ({
    codec: 'mp4a.40.42',
    sampleRate: 48000,
    numberOfChannels: 2,
  })),
}));

vi.mock('mediabunny', async (importOriginal) => {
  const original = await importOriginal<typeof import('mediabunny')>();
  return {
    ...original,
    Input: class {
      constructor(options: { formats: readonly InputFormat[] }) {
        mocks.inputFormats = options.formats;
      }
      async getFormat() {
        if (mocks.format === 'mp4') return new original.Mp4InputFormat();
        if (mocks.format === 'quicktime') return new original.QuickTimeInputFormat();
        if (mocks.format === 'mpegts') return new original.MpegTsInputFormat();
        return new original.MatroskaInputFormat();
      }
      async getPrimaryAudioTrack() {
        return {
          getCodec: async () => mocks.codec,
          canDecode: mocks.canDecode,
          getFirstTimestamp: mocks.firstTimestamp,
          getDecoderConfig: mocks.decoderConfig,
        };
      }
      dispose = mocks.dispose;
    },
  };
});

afterEach(() => vi.clearAllMocks());
beforeEach(() => {
  mocks.format = 'mp4';
  mocks.inputFormats = null;
  mocks.decoderConfig.mockResolvedValue({
    codec: 'mp4a.40.42',
    sampleRate: 48000,
    numberOfChannels: 2,
  });
});

describe('bounded engine codec eligibility', () => {
  it.each(['opus', 'vorbis'])(
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
  it('refuses an unverified AAC profile before decoding or scanning the track', async () => {
    mocks.codec = 'aac';
    await expect(openLargeAudioTrack(new Blob([new Uint8Array(32)]))).rejects.toThrow(
      'Unsupported large AAC profile',
    );
    expect(mocks.canDecode).not.toHaveBeenCalled();
    expect(mocks.firstTimestamp).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it.each(['quicktime', 'mpegts', 'matroska'])(
    'refuses unverified AAC container %s',
    async (format) => {
      mocks.codec = 'aac';
      mocks.format = format;
      mocks.decoderConfig.mockResolvedValue({
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        numberOfChannels: 2,
      });
      await expect(openLargeAudioTrack(new Blob([new Uint8Array(32)]))).rejects.toThrow(
        'Unsupported large AAC container',
      );
      expect(mocks.canDecode).not.toHaveBeenCalled();
      expect(mocks.firstTimestamp).not.toHaveBeenCalled();
      expect(mocks.dispose).toHaveBeenCalledOnce();
    },
  );
});

describe('bounded engine container detection', () => {
  it('detects every Mediabunny container except the HLS playlist demuxer, in Mediabunny order', async () => {
    mocks.codec = 'opus';
    await expect(openLargeAudioTrack(new Blob([new Uint8Array(32)]))).rejects.toThrow(
      'Unsupported large audio codec: opus',
    );
    const expected = ALL_FORMATS.filter((format) => format !== HLS);
    expect(mocks.inputFormats).not.toContain(HLS);
    expect(mocks.inputFormats).toHaveLength(expected.length);
    expected.forEach((format, index) => expect(mocks.inputFormats?.[index]).toBe(format));
  });
});
