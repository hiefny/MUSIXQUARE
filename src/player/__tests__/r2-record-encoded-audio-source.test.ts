import { afterEach, describe, expect, it, vi } from 'vitest';

import { R2RecordCryptoV2 } from '../../share/r2-record-crypto-v2.ts';
import {
  EncodedSourceClosedError,
  EncodedSourceIntegrityError,
} from '../sources/encoded-audio-source.ts';
import {
  R2RecordEncodedAudioSource,
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
    await vi.advanceTimersByTimeAsync(61_000);
    await rejection;

    expect(downloadRecord.mock.calls.length).toBeGreaterThan(1);
    await source.close();
  });
});
