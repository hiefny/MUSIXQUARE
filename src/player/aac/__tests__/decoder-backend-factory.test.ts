import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../webcodecs-batch-decoder.ts', () => ({
  createAacWebCodecsBatchDecoder: vi.fn(),
}));

import {
  AacDecoderBackendIntegrityError,
  AacDecoderBackendUnavailableError,
  type AacDecoderBackend,
  type AacDecoderBackendGenerationOptions,
  type AacDecoderBackendId,
} from '../decoder-backend.ts';
import { createAacDecoderBackend } from '../decoder-backend-factory.ts';
import { createAacWebCodecsBatchDecoder } from '../webcodecs-batch-decoder.ts';

const createWebCodecs = vi.mocked(createAacWebCodecsBatchDecoder);

function generationOptions(firstAccessUnitOrdinal = 0): AacDecoderBackendGenerationOptions {
  return {
    coreConfiguration: {
      mpegId: 0,
      profile: 1,
      coreAudioObjectType: 2,
      sampleRateIndex: 4,
      channelConfiguration: 2,
      protectionAbsent: true,
      rawDataBlocks: 1,
    },
    firstAccessUnitOrdinal,
    framing: { kind: 'adts' },
  };
}

function fakeBackend(
  close = vi.fn(),
  framing: AacDecoderBackendGenerationOptions['framing'] = Object.freeze({ kind: 'adts' }),
): AacDecoderBackend {
  return {
    id: 'webcodecs',
    coreSampleRateHz: 44_100,
    channels: 2,
    firstAccessUnitOrdinal: 0,
    framing,
    async decodeBatch() {
      throw new Error('not used by factory tests');
    },
    close,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return Object.freeze({ promise, resolve, reject });
}

describe('AAC decoder backend factory', () => {
  beforeEach(() => {
    createWebCodecs.mockReset();
  });

  it('passes one canonical frozen snapshot and the exact signal to WebCodecs', async () => {
    const input = generationOptions(Number.MAX_SAFE_INTEGER - 7);
    const signal = new AbortController().signal;
    const backend: AacDecoderBackend = {
      ...fakeBackend(),
      firstAccessUnitOrdinal: Number.MAX_SAFE_INTEGER - 7,
    };
    let receivedOptions: Readonly<AacDecoderBackendGenerationOptions> | null = null;
    createWebCodecs.mockImplementationOnce(async (options, receivedSignal) => {
      receivedOptions = options;
      expect(receivedSignal).toBe(signal);
      return backend;
    });

    const result = await createAacDecoderBackend('webcodecs', input, signal);

    expect(result).toBe(backend);
    expect(createWebCodecs).toHaveBeenCalledOnce();
    expect(createWebCodecs.mock.calls[0]).toHaveLength(2);
    expect(receivedOptions).not.toBe(input);
    expect(receivedOptions).toEqual(input);
    expect(Object.isFrozen(receivedOptions)).toBe(true);
    expect(Object.isFrozen(receivedOptions!.coreConfiguration)).toBe(true);
    expect(Object.isFrozen(receivedOptions!.framing)).toBe(true);

    (input as { firstAccessUnitOrdinal: number }).firstAccessUnitOrdinal = 0;
    (input.coreConfiguration as { sampleRateIndex: number }).sampleRateIndex = 3;
    expect(receivedOptions!.firstAccessUnitOrdinal).toBe(Number.MAX_SAFE_INTEGER - 7);
    expect(receivedOptions!.coreConfiguration.sampleRateIndex).toBe(4);
    expect(backend.close).not.toHaveBeenCalled();
  });

  it('passes a detached canonical raw framing snapshot and verifies the backend postcondition', async () => {
    const description: [number, number, number, number, number] = [0x12, 0x10, 0x56, 0xe5, 0x00];
    const input = {
      ...generationOptions(9),
      framing: { kind: 'raw' as const, description },
    };
    const backend = {
      ...fakeBackend(vi.fn(), {
        kind: 'raw',
        description: Object.freeze([0x12, 0x10, 0x56, 0xe5, 0x00] as const),
      }),
      firstAccessUnitOrdinal: 9,
    };
    let received: Readonly<AacDecoderBackendGenerationOptions> | null = null;
    createWebCodecs.mockImplementationOnce(async (options) => {
      received = options;
      return backend;
    });

    await expect(
      createAacDecoderBackend('webcodecs', input, new AbortController().signal),
    ).resolves.toBe(backend);
    description.fill(0);

    expect(received!.framing).toEqual({
      kind: 'raw',
      description: [0x12, 0x10, 0x56, 0xe5, 0x00],
    });
    expect((received!.framing as { readonly description: readonly number[] }).description).not.toBe(
      description,
    );
  });

  it('rejects a same-core raw backend that reports a different exact ASC form', async () => {
    const close = vi.fn();
    const input = {
      ...generationOptions(),
      framing: {
        kind: 'raw' as const,
        description: [0x12, 0x10, 0x56, 0xe5, 0x00] as const,
      },
    };
    const backend = fakeBackend(
      close,
      Object.freeze({
        kind: 'raw' as const,
        description: Object.freeze([0x12, 0x10] as const),
      }),
    );
    createWebCodecs.mockResolvedValueOnce(backend);

    await expect(
      createAacDecoderBackend('webcodecs', input, new AbortController().signal),
    ).rejects.toBeInstanceOf(AacDecoderBackendIntegrityError);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects the unadmitted Symphonia branch without touching WebCodecs', async () => {
    await expect(
      createAacDecoderBackend('symphonia-wasm', generationOptions(), new AbortController().signal),
    ).rejects.toMatchObject({
      name: 'AacDecoderBackendUnavailableError',
      message: expect.stringMatching(/not been admitted/i),
    });
    expect(createWebCodecs).not.toHaveBeenCalled();
  });

  it('rejects an invalid id before inspecting options and never falls back', async () => {
    const options = new Proxy(generationOptions(), {
      ownKeys() {
        throw new Error('options must not be inspected for an invalid id');
      },
    });

    await expect(
      createAacDecoderBackend(
        'other-backend' as AacDecoderBackendId,
        options,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(createWebCodecs).not.toHaveBeenCalled();
  });

  it('preserves a WebCodecs failure exactly and performs no substitution retry', async () => {
    const failure = new AacDecoderBackendUnavailableError('cohort WebCodecs failed');
    createWebCodecs.mockRejectedValueOnce(failure);

    await expect(
      createAacDecoderBackend('webcodecs', generationOptions(), new AbortController().signal),
    ).rejects.toBe(failure);
    expect(createWebCodecs).toHaveBeenCalledOnce();
  });

  it.each([
    ['backend id', { id: 'symphonia-wasm' }],
    ['sample rate', { coreSampleRateHz: 48_000 }],
    ['channels', { channels: 1 }],
    ['generation origin', { firstAccessUnitOrdinal: 1 }],
    ['framing', { framing: { kind: 'raw', description: [0x12, 0x10] } }],
    ['decode method', { decodeBatch: null }],
  ])(
    'rejects a mismatched %s postcondition, closes once, and never falls back',
    async (_label, override) => {
      const close = vi.fn();
      const backend = { ...fakeBackend(close), ...override } as unknown as AacDecoderBackend;
      createWebCodecs.mockResolvedValueOnce(backend);

      await expect(
        createAacDecoderBackend('webcodecs', generationOptions(), new AbortController().signal),
      ).rejects.toBeInstanceOf(AacDecoderBackendIntegrityError);
      expect(close).toHaveBeenCalledOnce();
      expect(createWebCodecs).toHaveBeenCalledOnce();
    },
  );

  it('does not let cleanup failure hide a backend postcondition mismatch', async () => {
    const close = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    const backend = {
      ...fakeBackend(close),
      coreSampleRateHz: 48_000,
    } as AacDecoderBackend;
    createWebCodecs.mockResolvedValueOnce(backend);

    await expect(
      createAacDecoderBackend('webcodecs', generationOptions(), new AbortController().signal),
    ).rejects.toBeInstanceOf(AacDecoderBackendIntegrityError);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects a backend without a callable close and performs no fallback', async () => {
    const backend = {
      ...fakeBackend(),
      close: null,
    } as unknown as AacDecoderBackend;
    createWebCodecs.mockResolvedValueOnce(backend);

    await expect(
      createAacDecoderBackend('webcodecs', generationOptions(), new AbortController().signal),
    ).rejects.toBeInstanceOf(AacDecoderBackendIntegrityError);
    expect(createWebCodecs).toHaveBeenCalledOnce();
  });

  it('gives abort exact precedence over a hostile postcondition getter', async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ stage: 'backend-getter' });
    const close = vi.fn();
    const backend = fakeBackend(close);
    Object.defineProperty(backend, 'id', {
      configurable: true,
      get() {
        controller.abort(reason);
        throw new Error('hostile id getter');
      },
    });
    createWebCodecs.mockResolvedValueOnce(backend);

    await expect(
      createAacDecoderBackend('webcodecs', generationOptions(), controller.signal),
    ).rejects.toBe(reason);
    expect(close).toHaveBeenCalledOnce();
    expect(createWebCodecs).toHaveBeenCalledOnce();
  });

  it('gives a pre-aborted signal precedence before id or option inspection', async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ stage: 'pre' });
    controller.abort(reason);
    let inspected = false;
    const options = new Proxy(generationOptions(), {
      ownKeys(target) {
        inspected = true;
        return Reflect.ownKeys(target);
      },
    });

    await expect(
      createAacDecoderBackend('invalid' as AacDecoderBackendId, options, controller.signal),
    ).rejects.toBe(reason);
    expect(inspected).toBe(false);
    expect(createWebCodecs).not.toHaveBeenCalled();
  });

  it('gives an abort triggered by hostile option reflection exact precedence', async () => {
    const controller = new AbortController();
    const reason = new Error('hostile options aborted');
    const reflectionFailure = new Error('reflection failure must not win');
    const options = new Proxy(generationOptions(), {
      ownKeys() {
        controller.abort(reason);
        throw reflectionFailure;
      },
    });

    await expect(createAacDecoderBackend('webcodecs', options, controller.signal)).rejects.toBe(
      reason,
    );
    expect(createWebCodecs).not.toHaveBeenCalled();
  });

  it('gives an abort during a rejecting WebCodecs call exact precedence', async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ stage: 'creator-reject' });
    const decoderFailure = new Error('decoder rejection must not win');
    createWebCodecs.mockImplementationOnce(async () => {
      controller.abort(reason);
      throw decoderFailure;
    });

    await expect(
      createAacDecoderBackend('webcodecs', generationOptions(), controller.signal),
    ).rejects.toBe(reason);
    expect(createWebCodecs).toHaveBeenCalledOnce();
  });

  it('closes a post-resolution backend exactly once before returning the abort reason', async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ stage: 'post-resolve' });
    const pending = deferred<AacDecoderBackend>();
    const close = vi.fn();
    const backend = fakeBackend(close);
    createWebCodecs.mockReturnValueOnce(pending.promise);
    const creating = createAacDecoderBackend('webcodecs', generationOptions(), controller.signal);

    pending.resolve(backend);
    controller.abort(reason);

    await expect(creating).rejects.toBe(reason);
    expect(close).toHaveBeenCalledOnce();
    expect(createWebCodecs).toHaveBeenCalledOnce();
  });

  it('does not let a post-resolution close throw replace the abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('post-resolve abort');
    const close = vi.fn(() => {
      throw new Error('cleanup failure');
    });
    const backend = fakeBackend(close);
    createWebCodecs.mockImplementationOnce(async () => {
      controller.abort(reason);
      return backend;
    });

    await expect(
      createAacDecoderBackend('webcodecs', generationOptions(), controller.signal),
    ).rejects.toBe(reason);
    expect(close).toHaveBeenCalledOnce();
  });

  it('best-effort reads a hostile close only once without masking post-resolution abort', async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ stage: 'hostile-close' });
    let closeReads = 0;
    const backend: AacDecoderBackend = {
      id: 'webcodecs',
      coreSampleRateHz: 44_100,
      channels: 2,
      firstAccessUnitOrdinal: 0,
      framing: Object.freeze({ kind: 'adts' }),
      async decodeBatch() {
        throw new Error('not used');
      },
      get close(): () => void {
        closeReads += 1;
        throw new Error('close getter failed');
      },
    };
    createWebCodecs.mockImplementationOnce(async () => {
      controller.abort(reason);
      return backend;
    });

    await expect(
      createAacDecoderBackend('webcodecs', generationOptions(), controller.signal),
    ).rejects.toBe(reason);
    expect(closeReads).toBe(1);
  });

  it('requires an exact AbortSignal before selecting any branch', async () => {
    await expect(
      createAacDecoderBackend('webcodecs', generationOptions(), {} as AbortSignal),
    ).rejects.toBeInstanceOf(TypeError);
    expect(createWebCodecs).not.toHaveBeenCalled();
  });
});
