/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

import type { QueueItemId } from '../../types/index.ts';
import {
  FilePlaybackR2WholeBlobPublisher,
  type FilePlaybackR2WholeBlobPublishSource,
  type FilePlaybackR2WholeBlobPublisherRuntime,
} from '../file-playback-r2-whole-blob-publisher.ts';

const ROOM_TOKEN = Object.freeze({ room: 'r2-publisher' });
const QUEUE_ID = '10000000-0000-4000-8000-000000000001' as QueueItemId;
const OBJECT_ID = '40000000-0000-4000-8000-000000000001';
const RECORD_SET_ID = '60000000-0000-4000-8000-000000000001';
const RECORD_OBJECT_ZERO = '70000000-0000-4000-8000-000000000001';
const RECORD_OBJECT_ONE = '70000000-0000-4000-8000-000000000002';
const CLEANUP_TOKEN = '50000000-0000-4000-8000-000000000001';
const KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const IV_B64 = 'AAAAAAAAAAAAAAAA';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function source(overrides: Partial<FilePlaybackR2WholeBlobPublishSource> = {}) {
  return Object.freeze({
    queueItemId: QUEUE_ID,
    sourceIdentity: 'source:r2-publisher',
    transferSessionId: 'transfer:r2-publisher',
    blob: new File([new Uint8Array([1, 2, 3, 4])], 'take.wav', {
      type: 'audio/wav',
      lastModified: 0,
    }),
    name: 'take.wav',
    mime: 'audio/wav',
    ...overrides,
  });
}

interface Harness {
  readonly publisher: FilePlaybackR2WholeBlobPublisher;
  readonly encrypt: ReturnType<typeof vi.fn>;
  readonly upload: ReturnType<typeof vi.fn>;
  readonly deleteObject: ReturnType<typeof vi.fn>;
  readonly reserveTransport: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
  readonly waitForMemoryReservationChange: ReturnType<typeof vi.fn>;
  readonly createRecordSet: ReturnType<typeof vi.fn>;
  readonly uploadRecord: ReturnType<typeof vi.fn>;
  readonly completeRecord: ReturnType<typeof vi.fn>;
  readonly deleteRecordSet: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<FilePlaybackR2WholeBlobPublisherRuntime> = {}): Harness {
  const release = vi.fn();
  const encrypt = vi.fn(async (blob: Blob) => ({
    encryptedBlob: new Blob([new Uint8Array(blob.size + 16)]),
    plaintextSize: blob.size,
    encryptedSize: blob.size + 16,
    keyB64: KEY_B64,
    ivB64: IV_B64,
  }));
  const upload = vi.fn(async () => ({
    objectId: OBJECT_ID,
    expiresAt: 100_000,
    cleanupToken: CLEANUP_TOKEN,
  }));
  const deleteObject = vi.fn(async () => 'deleted' as const);
  const reserveTransport = vi.fn(() => ({
    handoffToRetainedEncoded: vi.fn(() => {
      throw new Error('publisher must not retain encoded receive memory');
    }),
    release,
  }));
  const waitForMemoryReservationChange = vi.fn(async () => false);
  const createRecordSet = vi.fn(
    async (meta: Parameters<FilePlaybackR2WholeBlobPublisherRuntime['createRecordSet']>[0]) => ({
      v: 2 as const,
      storageRoomId: meta.storageRoomId,
      setId: RECORD_SET_ID,
      recordSize: meta.recordSize,
      recordCount: meta.recordCount,
      expiresAt: Date.now() + 60_000,
      setToken: 'set-token',
      cleanupToken: CLEANUP_TOKEN,
      records: Array.from({ length: meta.recordCount }, (_, index) => {
        const plaintextSize =
          index === meta.recordCount - 1
            ? meta.plaintextSize - index * meta.recordSize
            : meta.recordSize;
        return {
          index,
          objectId: index === 0 ? RECORD_OBJECT_ZERO : RECORD_OBJECT_ONE,
          plaintextSize,
          encryptedSize: plaintextSize + 16,
          downloadUrl: `https://share.musixquare.com/${meta.storageRoomId}/${index}`,
        };
      }),
    }),
  );
  const requestRecordUpload = vi.fn(
    async (
      session: Awaited<ReturnType<FilePlaybackR2WholeBlobPublisherRuntime['createRecordSet']>>,
      index: number,
    ) => {
      const record = session.records[index]!;
      return {
        v: 2 as const,
        setId: session.setId,
        index,
        objectId: record.objectId,
        plaintextSize: record.plaintextSize,
        encryptedSize: record.encryptedSize,
        uploadUrl: `https://upload.example/${record.objectId}`,
        uploadHeaders: Object.freeze({ 'content-type': 'application/octet-stream' }),
        uploadUrlExpiresAt: Date.now() + 30_000,
        expiresAt: session.expiresAt,
        downloadUrl: record.downloadUrl,
      };
    },
  );
  const uploadRecord = vi.fn(async () => undefined);
  const completeRecord = vi.fn(
    async (
      session: Awaited<ReturnType<FilePlaybackR2WholeBlobPublisherRuntime['createRecordSet']>>,
      index: number,
    ) => ({
      v: 2 as const,
      setId: session.setId,
      index,
      objectId: session.records[index]!.objectId,
      expiresAt: session.expiresAt,
      readyRecordCount: index + 1,
      recordCount: session.recordCount,
      complete: index + 1 === session.recordCount,
      downloadUrl: session.records[index]!.downloadUrl,
    }),
  );
  const deleteRecordSet = vi.fn(async () => undefined);
  const runtime: FilePlaybackR2WholeBlobPublisherRuntime = {
    createStorageRoomId: () => 'storage_room_publisher',
    encrypt,
    upload,
    deleteObject,
    reserveTransport,
    resolveMemoryBudget: () => ({
      tier: 'ios',
      maxDecodedPcmBytes: 192 * 1024 * 1024,
      maxDecodeWorkingSetBytes: 320 * 1024 * 1024,
    }),
    livePcmBytes: () => 77,
    waitForMemoryReservationChange,
    createRecordSet,
    requestRecordUpload,
    uploadRecord,
    completeRecord,
    deleteRecordSet,
    ...overrides,
  };
  return {
    publisher: new FilePlaybackR2WholeBlobPublisher({
      roomToken: ROOM_TOKEN,
      runtime,
    }),
    encrypt,
    upload,
    deleteObject,
    reserveTransport,
    release,
    waitForMemoryReservationChange,
    createRecordSet,
    uploadRecord,
    completeRecord,
    deleteRecordSet,
  };
}

describe('FilePlaybackR2WholeBlobPublisher', () => {
  it('reserves iOS transport memory before encrypting and exposes no cleanup token', async () => {
    const setup = harness();
    const input = source();
    const publication = await setup.publisher.publish(input);

    expect(setup.reserveTransport).toHaveBeenCalledWith(20, {
      budget: expect.objectContaining({ tier: 'ios' }),
      fileName: 'take.wav',
      retainedPcmBytes: 77,
    });
    expect(setup.reserveTransport.mock.invocationCallOrder[0]).toBeLessThan(
      setup.encrypt.mock.invocationCallOrder[0]!,
    );
    expect(setup.release).toHaveBeenCalledOnce();
    expect(publication).toMatchObject({
      schemaVersion: 1,
      queueItemId: QUEUE_ID,
      sourceIdentity: 'source:r2-publisher',
      storageRoomId: 'storage_room_publisher',
      objectId: OBJECT_ID,
      encodedSize: 4,
      encryptedSize: 20,
      expiresAtEpochMs: 100_000,
    });
    expect(Object.keys(publication)).not.toContain('cleanupToken');
    expect(setup.publisher.current(QUEUE_ID)).toBe(publication);
  });

  it('coalesces the exact Blob source and rejects a conflicting queue occurrence', async () => {
    const encryption = deferred<{
      encryptedBlob: Blob;
      plaintextSize: number;
      encryptedSize: number;
      keyB64: string;
      ivB64: string;
    }>();
    const setup = harness({ encrypt: vi.fn(() => encryption.promise) });
    const input = source();
    const first = setup.publisher.publish(input);
    expect(setup.publisher.publish(input)).toBe(first);
    await expect(
      setup.publisher.publish(source({ sourceIdentity: 'source:conflict' })),
    ).rejects.toThrow('SOURCE_CONFLICT');

    encryption.resolve({
      encryptedBlob: new Blob([new Uint8Array(20)]),
      plaintextSize: 4,
      encryptedSize: 20,
      keyB64: KEY_B64,
      ivB64: IV_B64,
    });
    await expect(first).resolves.toMatchObject({ objectId: OBJECT_ID });
    expect(setup.upload).toHaveBeenCalledOnce();
  });

  it('retires one uploaded object with its publisher-private cleanup capability', async () => {
    const setup = harness();
    await setup.publisher.publish(source());

    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
    expect(setup.deleteObject).toHaveBeenCalledWith(
      'storage_room_publisher',
      OBJECT_ID,
      CLEANUP_TOKEN,
    );
    expect(setup.publisher.current(QUEUE_ID)).toBeNull();
    await expect(setup.publisher.publish(source())).rejects.toThrow('SOURCE_RETIRED');
  });

  it('aborts in-flight publication on queue removal without uploading stale bytes', async () => {
    const encryption = deferred<{
      encryptedBlob: Blob;
      plaintextSize: number;
      encryptedSize: number;
      keyB64: string;
      ivB64: string;
    }>();
    const setup = harness({ encrypt: vi.fn(() => encryption.promise) });
    const pending = setup.publisher.publish(source());
    const removal = setup.publisher.removeQueueItem(QUEUE_ID);
    encryption.resolve({
      encryptedBlob: new Blob([new Uint8Array(20)]),
      plaintextSize: 4,
      encryptedSize: 20,
      keyB64: KEY_B64,
      ivB64: IV_B64,
    });

    await expect(pending).rejects.toThrow('SOURCE_STALE');
    await expect(removal).resolves.toBe(true);
    expect(setup.upload).not.toHaveBeenCalled();
    expect(setup.release).toHaveBeenCalledOnce();
  });

  it('deletes an object whose success arrived after room close instead of publishing it', async () => {
    const uploaded = deferred<{
      objectId: string;
      expiresAt: number;
      cleanupToken: string;
    }>();
    const setup = harness({ upload: vi.fn(() => uploaded.promise) });
    const pending = setup.publisher.publish(source());
    await vi.waitFor(() => expect(setup.encrypt).toHaveBeenCalledOnce());
    const closing = setup.publisher.close();
    uploaded.resolve({ objectId: OBJECT_ID, expiresAt: 100_000, cleanupToken: CLEANUP_TOKEN });

    await expect(pending).rejects.toThrow('SOURCE_STALE');
    await closing;
    expect(setup.deleteObject).toHaveBeenCalledWith(
      'storage_room_publisher',
      OBJECT_ID,
      CLEANUP_TOKEN,
    );
    expect(setup.publisher.current(QUEUE_ID)).toBeNull();
  });

  it('deletes a record set whose creation succeeds after room close', async () => {
    const created =
      deferred<Awaited<ReturnType<FilePlaybackR2WholeBlobPublisherRuntime['createRecordSet']>>>();
    const createRecordSet = vi.fn(() => created.promise);
    const setup = harness({ createRecordSet });
    const ready = setup.publisher.publishRecordSet(source(), {
      storageRoomId: '123456',
      applicationSessionId: 'application-session',
    });
    const readyOutcome = ready.catch((error: unknown) => error);
    await vi.waitFor(() => expect(createRecordSet).toHaveBeenCalledOnce());

    const closing = setup.publisher.close();
    const lateSession = {
      v: 2 as const,
      storageRoomId: '123456',
      setId: RECORD_SET_ID,
      recordSize: 8 * 1024 * 1024,
      recordCount: 1,
      expiresAt: Date.now() + 60_000,
      setToken: 'set-token',
      cleanupToken: CLEANUP_TOKEN,
      records: [
        {
          index: 0,
          objectId: RECORD_OBJECT_ZERO,
          plaintextSize: 4,
          encryptedSize: 20,
          downloadUrl: 'https://share.musixquare.com/123456/0',
        },
      ],
    };
    created.resolve(lateSession);

    await expect(readyOutcome).resolves.toMatchObject({
      message: 'FILE_PLAYBACK_R2_RECORD_PUBLISH_SOURCE_STALE',
    });
    await closing;
    expect(setup.deleteRecordSet).toHaveBeenCalledWith(lateSession);
    expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBeNull();
  });

  it('closes every published object once and remains idempotent', async () => {
    const setup = harness();
    await setup.publisher.publish(source());
    const first = setup.publisher.close();
    expect(setup.publisher.close()).toBe(first);
    await first;
    expect(setup.deleteObject).toHaveBeenCalledOnce();
    await expect(setup.publisher.publish(source())).rejects.toThrow('PUBLISHER_CLOSED');
  });

  it('rejects malformed sources before allocating memory', async () => {
    const setup = harness();
    await expect(
      setup.publisher.publish({ ...source(), unexpected: true } as never),
    ).rejects.toThrow(/source is invalid/u);
    await expect(setup.publisher.publish(source({ mime: 'not-a-mime' }))).rejects.toThrow(
      /source is invalid/u,
    );
    expect(setup.reserveTransport).not.toHaveBeenCalled();
    expect(setup.encrypt).not.toHaveBeenCalled();
  });

  it('publishes authenticated records after record zero and deletes the exact set on retirement', async () => {
    const setup = harness();
    const publication = await setup.publisher.publishRecordSet(source(), {
      storageRoomId: '123456',
      applicationSessionId: 'application-session',
    });

    expect(publication).toMatchObject({
      schemaVersion: 1,
      queueItemId: QUEUE_ID,
      sourceIdentity: 'source:r2-publisher',
      transferSessionId: 'transfer:r2-publisher',
      applicationSessionId: 'application-session',
      storageRoomId: '123456',
      setId: RECORD_SET_ID,
      encodedSize: 4,
      recordCount: 1,
    });
    expect(publication.records).toEqual([
      {
        index: 0,
        objectId: RECORD_OBJECT_ZERO,
        plaintextSize: 4,
        encryptedSize: 20,
      },
    ]);
    expect(Object.keys(publication)).not.toEqual(
      expect.arrayContaining(['cleanupToken', 'setToken', 'uploadUrl']),
    );
    expect(setup.uploadRecord).toHaveBeenCalledOnce();
    expect((setup.uploadRecord.mock.calls[0]?.[1] as Blob).size).toBe(20);
    expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBe(publication);

    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
    expect(setup.deleteRecordSet).toHaveBeenCalledOnce();
    expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBeNull();
  });

  it('resolves first-record readiness while the remaining immutable records upload ahead', async () => {
    const secondCompletion = deferred<{
      v: 2;
      setId: string;
      index: number;
      objectId: string;
      expiresAt: number;
      readyRecordCount: number;
      recordCount: number;
      complete: boolean;
      downloadUrl: string;
    }>();
    const setup = harness({
      completeRecord: vi.fn(async (session, index) => {
        if (index === 1) return secondCompletion.promise;
        return {
          v: 2 as const,
          setId: session.setId,
          index,
          objectId: session.records[index]!.objectId,
          expiresAt: session.expiresAt,
          readyRecordCount: 1,
          recordCount: session.recordCount,
          complete: false,
          downloadUrl: session.records[index]!.downloadUrl,
        };
      }),
    });
    const large = source({
      blob: new File([new Uint8Array(8 * 1024 * 1024), new Uint8Array([9])], 'large.flac', {
        type: 'audio/flac',
        lastModified: 0,
      }),
      name: 'large.flac',
      mime: 'audio/flac',
    });

    const publication = await setup.publisher.publishRecordSet(large, {
      storageRoomId: '123456',
      applicationSessionId: 'application-session',
    });
    expect(publication.recordCount).toBe(2);
    expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBe(publication);
    await vi.waitFor(() => expect(setup.uploadRecord).toHaveBeenCalledTimes(2));

    secondCompletion.resolve({
      v: 2,
      setId: RECORD_SET_ID,
      index: 1,
      objectId: RECORD_OBJECT_ONE,
      expiresAt: publication.expiresAtEpochMs,
      readyRecordCount: 2,
      recordCount: 2,
      complete: true,
      downloadUrl: 'https://share.musixquare.com/123456/1',
    });
    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
    expect(setup.deleteRecordSet).toHaveBeenCalledOnce();
  });
});
