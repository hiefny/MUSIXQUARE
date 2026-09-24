import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IncrementalAacDecoder } from '../aac-decoder.ts';
import { isAudioDecoderStartupError } from '../startup-error.ts';
import type { AudioCodec, EncodedPacket } from 'mediabunny';

const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  ready: vi.fn(async () => undefined),
  decode: vi.fn(),
  reset: vi.fn(async () => undefined),
  free: vi.fn(async () => undefined),
}));

vi.mock('@wasm-audio-decoders/aac', () => ({
  AACDecoderWebWorker: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    ready = mocks.ready();
    decodeFrames = mocks.decode;
    reset = mocks.reset;
    free = mocks.free;
  },
}));

vi.mock('../worker-call.ts', () => ({
  decoderWorkerCall: (_worker: unknown, result: Promise<unknown>) => result,
}));

vi.mock('mediabunny', () => ({
  CustomAudioDecoder: class {},
  AudioSample: class {
    constructor(options: object) {
      Object.assign(this, options);
    }
  },
}));

function create(config: Partial<AudioDecoderConfig> = {}) {
  const decoder = new IncrementalAacDecoder();
  const onSample = vi.fn();
  Object.assign(decoder, {
    codec: 'aac',
    config: { codec: 'mp4a.40.2', sampleRate: 24000, numberOfChannels: 1, ...config },
    onSample,
  });
  return { decoder, onSample };
}

function packet(timestamp: number): EncodedPacket {
  return { timestamp, data: new Uint8Array([1, 2, 3]) } as EncodedPacket;
}

function pcm(channels: number, sampleRate = 48000) {
  return {
    errors: [],
    samplesDecoded: 2,
    sampleRate,
    channelData: Array.from({ length: channels }, (_unused, channel) =>
      new Float32Array(2).fill(channel + 1),
    ),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('incremental AAC decoder', () => {
  it('marks worker bootstrap failures retryable without marking corrupt frames', async () => {
    mocks.ready.mockRejectedValueOnce(new Error('worker bootstrap interrupted'));
    const first = create();
    const failure = await first.decoder.init().catch((error: unknown) => error);
    expect(isAudioDecoderStartupError(failure)).toBe(true);
    await first.decoder.close();
    expect(mocks.free).toHaveBeenCalledOnce();

    const retry = create();
    await retry.decoder.init();
    mocks.decode.mockResolvedValueOnce({ ...pcm(2), errors: [{ message: 'corrupt AAC frame' }] });
    const corrupt = await retry.decoder.decode(packet(0)).catch((error: unknown) => error);
    expect(corrupt).toBeInstanceOf(Error);
    expect(isAudioDecoderStartupError(corrupt)).toBe(false);
    await retry.decoder.close();
  });

  it.each(['mp4a.40.2', 'mp4a.40.02', 'mp4a.40.5', 'mp4a.40.05', 'mp4a.40.29'])(
    'accepts verified LC/HE profile %s',
    (codec) => {
      expect(
        IncrementalAacDecoder.supports('aac', { codec, sampleRate: 24000, numberOfChannels: 1 }),
      ).toBe(true);
    },
  );

  it.each(['mp4a.40.42', 'mp4a.40.1', 'mp4a.40.23', 'not-a-codec'])(
    'refuses unsupported profile %s',
    (codec) => {
      expect(
        IncrementalAacDecoder.supports('aac', { codec, sampleRate: 24000, numberOfChannels: 1 }),
      ).toBe(false);
    },
  );

  it('does not claim non-AAC data or missing decoder configuration', () => {
    expect(IncrementalAacDecoder.supports('aac', null)).toBe(false);
    expect(
      IncrementalAacDecoder.supports('mp3' as AudioCodec, {
        codec: 'mp4a.40.2',
        sampleRate: 24000,
        numberOfChannels: 1,
      }),
    ).toBe(false);
  });

  it('passes only the ASC view to raw M4A decoding and leaves ADTS header detection enabled', async () => {
    const bytes = new Uint8Array([99, 18, 16, 99]);
    const raw = create({ description: new DataView(bytes.buffer, 1, 2) });
    await raw.decoder.init();
    expect(mocks.options).toHaveBeenLastCalledWith({
      audioSpecificConfig: new Uint8Array([18, 16]),
    });
    const adts = create();
    await adts.decoder.init();
    expect(mocks.options).toHaveBeenLastCalledWith({ audioSpecificConfig: undefined });
  });

  it('keeps the post-priming packet timestamp and decoded HE-AAC rate/channel count', async () => {
    const { decoder, onSample } = create();
    await decoder.init();
    mocks.decode.mockResolvedValueOnce({
      errors: [],
      samplesDecoded: 0,
      sampleRate: 0,
      channelData: [],
    });
    await decoder.decode(packet(-1024 / 24000));
    expect(onSample).not.toHaveBeenCalled();
    mocks.decode.mockResolvedValueOnce(pcm(2));
    await decoder.decode(packet(0));
    expect(onSample).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: 0, sampleRate: 48000, numberOfChannels: 2 }),
    );
  });

  it('maps FAAD surround channels into Web Audio speaker order', async () => {
    const { decoder, onSample } = create({ numberOfChannels: 6 });
    await decoder.init();
    mocks.decode.mockResolvedValueOnce(pcm(6));
    await decoder.decode(packet(5));
    expect(Array.from(onSample.mock.calls[0][0].data as Float32Array)).toEqual([
      1, 1, 3, 3, 2, 2, 6, 6, 4, 4, 5, 5,
    ]);
  });

  it('does not publish a decode result which settles after disposal', async () => {
    const { decoder, onSample } = create();
    await decoder.init();
    let finish!: (value: ReturnType<typeof pcm>) => void;
    mocks.decode.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = decoder.decode(packet(1));
    await decoder.close();
    finish(pcm(2));
    await pending;
    expect(onSample).not.toHaveBeenCalled();
    await decoder.close();
    expect(mocks.free).toHaveBeenCalledOnce();
  });

  it('surfaces corrupt frames and rejects malformed PCM instead of shifting time', async () => {
    const { decoder, onSample } = create();
    await decoder.init();
    mocks.decode.mockResolvedValueOnce({ ...pcm(2), errors: [{ message: 'corrupt AAC frame' }] });
    await expect(decoder.decode(packet(0))).rejects.toThrow('corrupt AAC frame');
    mocks.decode.mockResolvedValueOnce({ ...pcm(2), sampleRate: Number.NaN });
    await expect(decoder.decode(packet(0))).rejects.toThrow('invalid PCM');
    expect(onSample).not.toHaveBeenCalled();
  });

  it('rejects a later sample-rate change instead of silently changing the established sample clock', async () => {
    const { decoder, onSample } = create();
    await decoder.init();
    mocks.decode.mockResolvedValueOnce(pcm(2));
    await decoder.decode(packet(0));
    mocks.decode.mockResolvedValueOnce(pcm(2, 44100));
    await expect(decoder.decode(packet(1))).rejects.toThrow('output format changed');
    expect(onSample).toHaveBeenCalledOnce();
  });
});
