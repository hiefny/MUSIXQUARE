import { afterEach, describe, expect, it, vi } from 'vitest';

import { R2RecordCryptoV2 } from '../../share/r2-record-crypto-v2.ts';
import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
} from '../sources/encoded-audio-source.ts';
import {
  R2RecordEncodedAudioSource,
  type R2RecordEncodedAudioSourceCiphertextCache,
  type R2RecordEncodedAudioSourceOptions,
} from '../sources/r2-record-encoded-audio-source.ts';

const { downloadRecord } = vi.hoisted(() => ({
  downloadRecord:
    vi.fn<
      (
        roomId: string,
        objectId: string,
        expectedSize: number,
        signal?: AbortSignal,
      ) => Promise<ArrayBuffer>
    >(),
}));

vi.mock('../../share/r2-client.ts', () => ({
  downloadR2RecordObject: downloadRecord,
}));

const SET_ID = '10000000-0000-4000-8000-000000000001';
const RECORD_ZERO_ID = '20000000-0000-4000-8000-000000000001';
const RECORD_ONE_ID = '20000000-0000-4000-8000-000000000002';

async function encryptedFixture(): Promise<{
  readonly options: R2RecordEncodedAudioSourceOptions;
  readonly ciphertextByObjectId: ReadonlyMap<string, ArrayBuffer>;
}> {
  const recordSize = R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES;
  const plaintextSize = recordSize + 4;
  const encryptor = await R2RecordCryptoV2.createEncryptor(SET_ID, plaintextSize);
  const secretDescriptor = encryptor.takeSecretDescriptor();
  const first = new Uint8Array(recordSize);
  first[recordSize - 2] = 11;
  first[recordSize - 1] = 12;
  const second = new Uint8Array([13, 14, 15, 16]);
  const firstLease = await encryptor.encryptRecord(0, first);
  const firstCiphertext = await firstLease.bytesForUpload().arrayBuffer();
  firstLease.acknowledgeUploaded();
  const secondLease = await encryptor.encryptRecord(1, second);
  const secondCiphertext = await secondLease.bytesForUpload().arrayBuffer();
  secondLease.acknowledgeUploaded();
  encryptor.dispose();
  first.fill(0);
  second.fill(0);

  return {
    options: {
      storageRoomId: '123456',
      setId: SET_ID,
      identity: 'source:queue-one:transfer-one',
      metadata: { name: 'concert.flac', mime: 'audio/flac' },
      secretDescriptor,
      records: [
        {
          index: 0,
          objectId: RECORD_ZERO_ID,
          plaintextSize: recordSize,
          encryptedSize: recordSize + 16,
        },
        {
          index: 1,
          objectId: RECORD_ONE_ID,
          plaintextSize: 4,
          encryptedSize: 20,
        },
      ],
      expiresAtEpochMs: Date.now() + 60_000,
    },
    ciphertextByObjectId: new Map([
      [RECORD_ZERO_ID, firstCiphertext],
      [RECORD_ONE_ID, secondCiphertext],
    ]),
  };
}

afterEach(() => {
  vi.useRealTimers();
  downloadRecord.mockReset();
  vi.restoreAllMocks();
});

describe('R2RecordEncodedAudioSource', () => {
  it('reads exactly across authenticated record boundaries and reuses one-record cache', async () => {
    const fixture = await encryptedFixture();
    downloadRecord.mockImplementation(async (roomId, objectId, expectedSize) => {
      expect(roomId).toBe('123456');
      const ciphertext = fixture.ciphertextByObjectId.get(objectId);
      if (!ciphertext || ciphertext.byteLength !== expectedSize) {
        throw new Error('unexpected record request');
      }
      return ciphertext.slice(0);
    });
    const source = await R2RecordEncodedAudioSource.create(fixture.options);
    const recordSize = R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES;

    await expect(source.readAt(recordSize - 2, 6, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([11, 12, 13, 14, 15, 16]),
    );
    await expect(source.readAt(recordSize, 2, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([13, 14]),
    );

    expect(downloadRecord.mock.calls.map((call) => call[1])).toEqual([
      RECORD_ZERO_ID,
      RECORD_ONE_ID,
    ]);
    await source.close();
  });

  it('keeps an already-open record source readable after a one-hour pause', async () => {
    const fixture = await encryptedFixture();
    vi.useFakeTimers();
    const startedAt = new Date('2026-07-28T06:00:00.000Z');
    vi.setSystemTime(startedAt);
    downloadRecord.mockImplementation(async (_roomId, objectId) => {
      const ciphertext = fixture.ciphertextByObjectId.get(objectId);
      if (!ciphertext) throw new Error('unexpected record request');
      return ciphertext.slice(0);
    });
    const source = await R2RecordEncodedAudioSource.create({
      ...fixture.options,
      expiresAtEpochMs: startedAt.getTime() + 6 * 60 * 60_000,
    });
    const recordSize = R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES;

    // Record zero models the decoded position at pause. Record one must still
    // be downloadable/authenticatable when playback resumes more than an hour
    // later; it is intentionally not primed into either source cache.
    await expect(source.readAt(recordSize - 1, 1, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([12]),
    );
    vi.setSystemTime(startedAt.getTime() + 61 * 60_000);
    await expect(source.readAt(recordSize, 4, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([13, 14, 15, 16]),
    );
    expect(downloadRecord.mock.calls.map((call) => call[1])).toEqual([
      RECORD_ZERO_ID,
      RECORD_ONE_ID,
    ]);
    await source.close();
  });

  it('reuses descriptor-scoped authenticated ciphertext across fresh source incarnations', async () => {
    const fixture = await encryptedFixture();
    downloadRecord.mockImplementation(async (_roomId, objectId) => {
      const ciphertext = fixture.ciphertextByObjectId.get(objectId);
      if (!ciphertext) throw new Error('unexpected record request');
      return ciphertext.slice(0);
    });
    const cached = new Map<number, ArrayBuffer>();
    const ciphertextCache: R2RecordEncodedAudioSourceCiphertextCache = {
      get(recordIndex, expectedSize) {
        const bytes = cached.get(recordIndex);
        return bytes?.byteLength === expectedSize ? bytes : null;
      },
      put(recordIndex, ciphertext) {
        cached.set(recordIndex, ciphertext.slice(0));
      },
    };

    const first = await R2RecordEncodedAudioSource.create(
      fixture.options,
      undefined,
      ciphertextCache,
    );
    await expect(first.readAt(0, 1, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([0]),
    );
    await first.close();

    const second = await R2RecordEncodedAudioSource.create(
      fixture.options,
      undefined,
      ciphertextCache,
    );
    await expect(second.readAt(0, 1, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([0]),
    );
    await second.close();

    expect(downloadRecord).toHaveBeenCalledTimes(1);
  });

  it('does not poison the descriptor cache with an unauthenticated response', async () => {
    const fixture = await encryptedFixture();
    const exact = fixture.ciphertextByObjectId.get(RECORD_ZERO_ID);
    if (!exact) throw new Error('missing test ciphertext');
    const corrupt = new Uint8Array(exact.slice(0));
    corrupt[0] ^= 0xff;
    downloadRecord
      .mockResolvedValueOnce(corrupt.buffer.slice(0))
      .mockResolvedValueOnce(exact.slice(0));
    const cached = new Map<number, ArrayBuffer>();
    const ciphertextCache: R2RecordEncodedAudioSourceCiphertextCache = {
      get(recordIndex, expectedSize) {
        const bytes = cached.get(recordIndex);
        return bytes?.byteLength === expectedSize ? bytes : null;
      },
      put(recordIndex, ciphertext) {
        cached.set(recordIndex, ciphertext.slice(0));
      },
    };

    const failed = await R2RecordEncodedAudioSource.create(
      fixture.options,
      undefined,
      ciphertextCache,
    );
    await expect(failed.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceIntegrityError,
    );
    expect(cached.size).toBe(0);
    await failed.close();

    const retry = await R2RecordEncodedAudioSource.create(
      fixture.options,
      undefined,
      ciphertextCache,
    );
    await expect(retry.readAt(0, 1, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([0]),
    );
    await retry.close();

    const cachedRetry = await R2RecordEncodedAudioSource.create(
      fixture.options,
      undefined,
      ciphertextCache,
    );
    await expect(cachedRetry.readAt(0, 1, new AbortController().signal)).resolves.toEqual(
      new Uint8Array([0]),
    );
    await cachedRetry.close();
    expect(downloadRecord).toHaveBeenCalledTimes(2);
  });

  it('aborts an active object request and settles close idempotently', async () => {
    const fixture = await encryptedFixture();
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    downloadRecord.mockImplementation(
      (_roomId, _objectId, _expectedSize, signal) =>
        new Promise<ArrayBuffer>((_resolve, reject) => {
          started();
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const source = await R2RecordEncodedAudioSource.create(fixture.options);
    const read = source.readAt(0, 1, new AbortController().signal);
    await requestStarted;

    const firstClose = source.close();
    const secondClose = source.close();

    expect(secondClose).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
    await expect(read).rejects.toBeInstanceOf(EncodedSourceClosedError);
    await expect(source.readAt(0, 1, new AbortController().signal)).rejects.toBeInstanceOf(
      EncodedSourceClosedError,
    );
  });

  it('fails closed when authenticated ciphertext is changed', async () => {
    const fixture = await encryptedFixture();
    const ciphertext = new Uint8Array(
      fixture.ciphertextByObjectId.get(RECORD_ONE_ID)?.slice(0) ?? new ArrayBuffer(0),
    );
    ciphertext[0] ^= 0xff;
    downloadRecord.mockImplementation(async (_roomId, objectId) => {
      if (objectId === RECORD_ONE_ID) return ciphertext.buffer.slice(0);
      const exact = fixture.ciphertextByObjectId.get(objectId);
      if (!exact) throw new Error('unexpected record request');
      return exact.slice(0);
    });
    const source = await R2RecordEncodedAudioSource.create(fixture.options);

    await expect(
      source.readAt(R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES, 1, new AbortController().signal),
    ).rejects.toBeInstanceOf(EncodedSourceIntegrityError);
    await source.close();
  });

  it('keeps a deep-seek read waiting while an exposed tail record is still uploading', async () => {
    vi.useFakeTimers();
    const fixture = await encryptedFixture();
    const startedAt = Date.now();
    const ciphertext = fixture.ciphertextByObjectId.get(RECORD_ONE_ID);
    if (!ciphertext) throw new Error('missing encrypted tail fixture');
    const source = await R2RecordEncodedAudioSource.create({
      ...fixture.options,
      expiresAtEpochMs: startedAt + 5 * 60_000,
    });
    downloadRecord.mockImplementation(async (_roomId, objectId) => {
      if (objectId !== RECORD_ONE_ID) throw new Error('unexpected record request');
      if (Date.now() - startedAt < 61_000) {
        throw new Error('REMOTE_SHARE_DOWNLOAD_HTTP_404');
      }
      return ciphertext.slice(0);
    });

    const read = source.readAt(
      R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES,
      4,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(62_000);

    await expect(read).resolves.toEqual(new Uint8Array([13, 14, 15, 16]));
    expect(downloadRecord.mock.calls.length).toBeGreaterThan(1);
    await source.close();
  });

  it('bounds a missing ahead record instead of leaving playback loading until set expiry', async () => {
    vi.useFakeTimers();
    const fixture = await encryptedFixture();
    const source = await R2RecordEncodedAudioSource.create({
      ...fixture.options,
      expiresAtEpochMs: Date.now() + 3_600_000,
    });
    downloadRecord.mockRejectedValue(new Error('REMOTE_SHARE_DOWNLOAD_HTTP_404'));

    const read = source.readAt(0, 1, new AbortController().signal);
    const rejection = expect(read).rejects.toThrow(
      'R2 record remained unavailable past its bounded wait',
    );
    await vi.advanceTimersByTimeAsync(181_000);
    await rejection;

    expect(downloadRecord.mock.calls.length).toBeGreaterThan(1);
    await source.close();
  });
});
