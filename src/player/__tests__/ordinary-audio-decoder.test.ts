/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isAudioDecodeAdmissionError,
  memoryReservationStatsForTests,
} from '../decode-admission.ts';
import {
  decodeOrdinaryAudio,
  decodeOrdinaryAudioWithAdmission,
} from '../ordinary-audio-decoder.ts';
import type { OrdinaryAudioDecodeRequest } from '../file-playback-source-factory.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function audioBlob(): Blob {
  return new Blob([new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0])], {
    type: 'audio/mpeg',
  });
}

function audioBuffer(length = 48_000): AudioBuffer {
  return {
    duration: length / 48_000,
    sampleRate: 48_000,
    numberOfChannels: 2,
    length,
  } as AudioBuffer;
}

function audioContext(
  decodeAudioData: (audioData: ArrayBuffer) => Promise<AudioBuffer>,
  sampleRate = 48_000,
): AudioContext {
  return { sampleRate, decodeAudioData } as AudioContext;
}

function request(
  blob: Blob,
  context: AudioContext,
  signal: AbortSignal = new AbortController().signal,
): OrdinaryAudioDecodeRequest {
  return {
    blob,
    audioContext: context,
    signal,
    sourceIdentity: 'blob:test-source',
  };
}

function expectNoDecodeReservation(): void {
  expect(memoryReservationStatsForTests().decodeBytes).toBe(0);
}

afterEach(() => {
  vi.restoreAllMocks();
  expectNoDecodeReservation();
});

describe('decodeOrdinaryAudio', () => {
  it('rejects unknown-duration iOS input before whole-Blob allocation', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone)');
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      throw new Error('metadata unavailable');
    });
    const blob = audioBlob();
    const read = vi.fn(async () => new ArrayBuffer(blob.size));
    Object.defineProperty(blob, 'arrayBuffer', { configurable: true, value: read });
    const decode = vi.fn(async () => audioBuffer());

    const error = await decodeOrdinaryAudio(request(blob, audioContext(decode))).catch(
      (reason: unknown) => reason,
    );

    expect(isAudioDecodeAdmissionError(error)).toBe(true);
    if (isAudioDecodeAdmissionError(error)) expect(error.reason).toBe('estimated-pcm');
    expect(read).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it('honors abort before admission or whole-Blob allocation', async () => {
    const abort = new AbortController();
    const reason = new Error('cancel before decode');
    abort.abort(reason);
    const blob = audioBlob();
    const read = vi.fn(async () => new ArrayBuffer(blob.size));
    Object.defineProperty(blob, 'arrayBuffer', { configurable: true, value: read });
    const decode = vi.fn(async () => audioBuffer());

    await expect(
      decodeOrdinaryAudio(request(blob, audioContext(decode), abort.signal)),
    ).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it('releases admission after abort during the uncancellable Blob read', async () => {
    const abort = new AbortController();
    const reason = new Error('cancel during Blob read');
    const blobRead = deferred<ArrayBuffer>();
    const blob = audioBlob();
    const read = vi.fn(() => blobRead.promise);
    Object.defineProperty(blob, 'arrayBuffer', { configurable: true, value: read });
    const decode = vi.fn(async () => audioBuffer());

    const pending = decodeOrdinaryAudio(request(blob, audioContext(decode), abort.signal));
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(memoryReservationStatsForTests().decodeBytes).toBeGreaterThan(0);

    abort.abort(reason);
    blobRead.resolve(new ArrayBuffer(blob.size));

    await expect(pending).rejects.toBe(reason);
    expect(decode).not.toHaveBeenCalled();
  });

  it('keeps the lease until native decode settles after abort', async () => {
    const abort = new AbortController();
    const reason = new Error('cancel during native decode');
    const nativeDecode = deferred<AudioBuffer>();
    const decode = vi.fn(() => nativeDecode.promise);
    const pending = decodeOrdinaryAudio(request(audioBlob(), audioContext(decode), abort.signal));
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());

    abort.abort(reason);
    expect(memoryReservationStatsForTests().decodeBytes).toBeGreaterThan(0);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    nativeDecode.resolve(audioBuffer());
    await expect(pending).rejects.toBe(reason);
  });

  it('uses the exact supplied AudioContext and preserves its receiver', async () => {
    let context!: AudioContext;
    const decode = vi.fn(function (this: AudioContext) {
      expect(this).toBe(context);
      return Promise.resolve(audioBuffer());
    });
    context = audioContext(decode);

    const result = await decodeOrdinaryAudio(request(audioBlob(), context));

    expect(decode).toHaveBeenCalledOnce();
    result.release();
  });

  it('rejects the measured PCM footprint and releases its reservation', async () => {
    const oversized = audioBuffer(200_000_000);
    const error = await decodeOrdinaryAudio(
      request(audioBlob(), audioContext(vi.fn(async () => oversized))),
    ).catch((reason: unknown) => reason);

    expect(isAudioDecodeAdmissionError(error)).toBe(true);
    if (isAudioDecodeAdmissionError(error)) expect(error.reason).toBe('decoded-pcm');
  });

  it('returns a one-shot construction release', async () => {
    const result = await decodeOrdinaryAudio(
      request(audioBlob(), audioContext(vi.fn(async () => audioBuffer()))),
    );
    expect(memoryReservationStatsForTests().decodeBytes).toBeGreaterThan(0);

    result.release();
    expectNoDecodeReservation();
    expect(() => result.release()).not.toThrow();
    expectNoDecodeReservation();
  });

  it('rejects accessors, symbols, and extras without invoking request accessors', async () => {
    const blob = audioBlob();
    const context = audioContext(vi.fn(async () => audioBuffer()));
    let accessorReads = 0;
    const accessor = {
      blob,
      audioContext: context,
      signal: new AbortController().signal,
      get sourceIdentity() {
        accessorReads += 1;
        return 'blob:accessor';
      },
    };
    await expect(decodeOrdinaryAudio(accessor as OrdinaryAudioDecodeRequest)).rejects.toThrow(
      TypeError,
    );
    expect(accessorReads).toBe(0);

    const extra = { ...request(blob, context), extra: true };
    await expect(decodeOrdinaryAudio(extra as OrdinaryAudioDecodeRequest)).rejects.toThrow(
      TypeError,
    );

    const symbol = Symbol('unexpected');
    const withSymbol = Object.assign(request(blob, context), { [symbol]: true });
    await expect(decodeOrdinaryAudio(withSymbol)).rejects.toThrow(TypeError);
  });

  it('snapshots ownership functions without invoking accessors or observing reentrant mutation', async () => {
    let accessorReads = 0;
    const accessorOwnership = {
      get assertCurrent() {
        accessorReads += 1;
        return () => undefined;
      },
      waitForMemoryReservationChange: async () => false,
    };
    await expect(
      decodeOrdinaryAudioWithAdmission(
        audioBlob(),
        audioContext(vi.fn(async () => audioBuffer())),
        'accessor.mp3',
        accessorOwnership,
      ),
    ).rejects.toThrow(TypeError);
    expect(accessorReads).toBe(0);

    const replacement = vi.fn();
    const original = vi.fn(() => {
      ownership.assertCurrent = replacement;
    });
    const ownership = {
      assertCurrent: original,
      waitForMemoryReservationChange: async () => false,
    };
    const result = await decodeOrdinaryAudioWithAdmission(
      audioBlob(),
      audioContext(vi.fn(async () => audioBuffer())),
      'mutation.mp3',
      ownership,
    );

    result.release();
    expect(original).toHaveBeenCalledTimes(4);
    expect(replacement).not.toHaveBeenCalled();
  });
});
