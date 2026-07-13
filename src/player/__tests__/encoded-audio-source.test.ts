import { describe, expect, it } from 'vitest';

import {
  BlobEncodedAudioSource,
  getBlobObjectIdentity,
} from '../sources/blob-encoded-audio-source.ts';
import {
  ENCODED_AUDIO_SOURCE_MAX_IDENTITY_LENGTH,
  EncodedSourceClosedError,
  EncodedSourceRangeError,
  isEncodedAudioSourceIdentity,
  validateExactRead,
} from '../sources/encoded-audio-source.ts';

describe('validateExactRead', () => {
  it('accepts exact in-bounds and zero-length reads', () => {
    expect(validateExactRead(10, 2, 4)).toBe(6);
    expect(validateExactRead(10, 10, 0)).toBe(10);
  });

  it.each([
    [10, -1, 1],
    [10, 0.5, 1],
    [10, 0, -1],
    [10, 0, 11],
    [10, Number.MAX_SAFE_INTEGER, 1],
  ])('rejects an invalid read (%s, %s, %s)', (size, offset, length) => {
    expect(() => validateExactRead(size, offset, length)).toThrow(EncodedSourceRangeError);
  });
});

describe('encoded source identity', () => {
  it('bounds opaque identities without trimming or coercion', () => {
    expect(isEncodedAudioSourceIdentity('source:fixture')).toBe(true);
    expect(isEncodedAudioSourceIdentity('x'.repeat(ENCODED_AUDIO_SOURCE_MAX_IDENTITY_LENGTH))).toBe(
      true,
    );
    expect(isEncodedAudioSourceIdentity('')).toBe(false);
    expect(
      isEncodedAudioSourceIdentity('x'.repeat(ENCODED_AUDIO_SOURCE_MAX_IDENTITY_LENGTH + 1)),
    ).toBe(false);
    expect(isEncodedAudioSourceIdentity(1)).toBe(false);
  });
});

describe('BlobEncodedAudioSource', () => {
  it('reads exact slices without exposing a filename-derived identity', async () => {
    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4, 5])], { type: 'audio/flac' });
    const source = new BlobEncodedAudioSource(blob, { metadata: { name: 'sample.flac' } });

    await expect(source.readAt(2, 3, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([2, 3, 4]),
    );
    expect(source.kind).toBe('blob');
    expect(source.size).toBe(6);
    expect(source.metadata).toEqual({ name: 'sample.flac', mime: 'audio/flac' });
    expect(source.identity).toMatch(/^blob:/);
  });

  it('uses object identity even when two blobs have identical metadata and bytes', () => {
    const first = new Blob(['same'], { type: 'audio/flac' });
    const second = new Blob(['same'], { type: 'audio/flac' });

    expect(getBlobObjectIdentity(first)).toBe(getBlobObjectIdentity(first));
    expect(getBlobObjectIdentity(first)).not.toBe(getBlobObjectIdentity(second));
  });

  it('accepts an explicit queue/transfer-owned identity', () => {
    const source = new BlobEncodedAudioSource(new Blob(['x']), { identity: 'qid:q1/sid:7' });
    expect(source.identity).toBe('qid:q1/sid:7');
  });

  it('rejects reads that are aborted before publication', async () => {
    const controller = new AbortController();
    controller.abort(new Error('superseded'));
    const source = new BlobEncodedAudioSource(new Blob(['abcdef']));

    await expect(source.readAt(0, 1, controller.signal)).rejects.toThrow('superseded');
  });

  it('makes close idempotent and prevents later reads', async () => {
    const source = new BlobEncodedAudioSource(new Blob(['abcdef']));
    await source.close();
    await source.close();

    await expect(source.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceClosedError,
    );
  });
});
