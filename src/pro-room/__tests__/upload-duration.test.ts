import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeProRoomUploadDuration } from '../upload-duration.ts';

afterEach(() => vi.useRealTimers());

describe('optional upload duration from bounded local file metadata', () => {
  it.each([
    ['test-01.mp3', 87.48],
    ['large-audio-chirp.mp3', 5.041633],
    ['large-audio-chirp.flac', 5],
    ['large-audio-chirp-lc-stereo.m4a', 5],
    ['large-audio-chirp-lc-leading-edit.m4a', 6],
    ['large-audio-chirp-lc-stereo.aac', 5.03873],
  ])('reads real %s metadata without playing or decoding the file', async (filename, expected) => {
    const bytes = await readFile(new URL(`../../../e2e/fixtures/${filename}`, import.meta.url));
    const file = new File([bytes], filename);
    const wholeFileRead = vi.spyOn(file, 'arrayBuffer');
    expect(await probeProRoomUploadDuration(file)).toBeCloseTo(expected, 3);
    expect(wholeFileRead).not.toHaveBeenCalled();
  });

  it('reads a huge FLAC header without allocating or reading its encoded/PCM body', async () => {
    const bytes = await readFile(
      new URL('../../../e2e/fixtures/large-audio-chirp.flac', import.meta.url),
    );
    const slice = vi.fn((start = 0, end = bytes.length) => new Blob([bytes.subarray(start, end)]));
    const file = { size: 600 * 1024 * 1024, slice } as unknown as Blob;
    expect(await probeProRoomUploadDuration(file)).toBe(5);
    expect(
      slice.mock.calls.reduce((total, [start = 0, end = 0]) => total + end - start, 0),
    ).toBeLessThan(256);
  });

  it('leaves an actual Ogg/Opus stream unknown instead of mistaking its granule for a zero-based duration', async () => {
    // FFmpeg 8.0.1: -f lavfi -i anullsrc=r=48000:cl=mono -t 0.05 -c:a libopus -f ogg
    const encoded =
      'T2dnUwACAAAAAAAAAADTJxX8AAAAAB4NctoBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAANMnFfwBAAAAymKMLgE9T3B1c1RhZ3MMAAAATGF2ZjYyLjMuMTAwAQAAAB0AAABlbmNvZGVyPUxhdmM2Mi4xMS4xMDAgbGlib3B1c09nZ1MABJgKAAAAAAAA0ycV/AIAAABXjU7MAwMDA/j//vj//vj//g==';
    expect(await probeProRoomUploadDuration(new Blob([Buffer.from(encoded, 'base64')]))).toBeNull();
  });

  it.each([0, 3, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'does not read invalid file size %s',
    async (size) => {
      const slice = vi.fn();
      expect(await probeProRoomUploadDuration({ size, slice } as unknown as Blob)).toBeNull();
      expect(slice).not.toHaveBeenCalled();
    },
  );

  it('does not start any file read after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const slice = vi.fn();
    expect(
      await probeProRoomUploadDuration({ size: 100, slice } as unknown as Blob, controller.signal),
    ).toBeNull();
    expect(slice).not.toHaveBeenCalled();
  });

  it('stops a stalled local range on cancellation and releases its reader', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const slice = vi.fn(() => ({ stream: () => new ReadableStream({ cancel }) }));
    const pending = probeProRoomUploadDuration(
      { size: 100, slice } as unknown as Blob,
      controller.signal,
    );
    await vi.waitFor(() => expect(slice).toHaveBeenCalledOnce());
    controller.abort();
    expect(await pending).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('limits a non-cooperative range to five seconds and cleans its timers', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const slice = vi.fn(() => ({ stream: () => new ReadableStream({ cancel }) }));
    const pending = probeProRoomUploadDuration({ size: 100, slice } as unknown as Blob);
    // Allow the lazy parser module to resolve before advancing the deadline.
    await vi.waitFor(() => expect(slice).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats unreadable local blobs as optional metadata failure', async () => {
    const slice = vi.fn(() => {
      throw new Error('FILE_UNAVAILABLE');
    });
    expect(await probeProRoomUploadDuration({ size: 100, slice } as unknown as Blob)).toBeNull();
  });
});
