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
  readonly cancelRecordSetCreateIntent: ReturnType<typeof vi.fn>;
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
      expiresAt: Date.now() + 120_000,
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
  const cancelRecordSetCreateIntent = vi.fn(async () => undefined);
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
    now: Date.now,
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
    cancelRecordSetCreateIntent,
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
    cancelRecordSetCreateIntent,
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

  it('retains whole-object cleanup authority when removal fails and retries explicitly', async () => {
    const deleteObject = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['deleteObject']>>()
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_OBJECT_CLEANUP_NETWORK'))
      .mockResolvedValue('deleted');
    const setup = harness({ deleteObject });
    const publication = await setup.publisher.publish(source());

    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).rejects.toThrow(
      'File playback R2 queue item cleanup failed',
    );
    expect(setup.publisher.current(QUEUE_ID)).toBe(publication);
    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
    expect(setup.publisher.current(QUEUE_ID)).toBeNull();
    expect(deleteObject).toHaveBeenCalledTimes(2);
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

  it('publishes an authenticated one-record set and deletes the exact set on retirement', async () => {
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

  it('resolves first-record readiness while immutable tail records upload ahead', async () => {
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
        if (session.recordCount === 1) {
          return {
            v: 2 as const,
            setId: session.setId,
            index,
            objectId: session.records[index]!.objectId,
            expiresAt: session.expiresAt,
            readyRecordCount: 1,
            recordCount: 1,
            complete: true,
            downloadUrl: session.records[index]!.downloadUrl,
          };
        }
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
    await vi.waitFor(() => expect(setup.uploadRecord).toHaveBeenCalledTimes(2));
    expect(publication.recordCount).toBe(2);
    expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBe(publication);

    secondCompletion.resolve({
      v: 2,
      setId: RECORD_SET_ID,
      index: 1,
      objectId: RECORD_OBJECT_ONE,
      expiresAt: Date.now() + 120_000,
      readyRecordCount: 2,
      recordCount: 2,
      complete: true,
      downloadUrl: 'https://share.musixquare.com/123456/1',
    });
    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
    expect(setup.deleteRecordSet).toHaveBeenCalledOnce();
  });

  it('keeps an exposed tail alive through an extended transient upload retry budget', async () => {
    const uploadRecord = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['uploadRecord']>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_UPLOAD_NETWORK'))
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_UPLOAD_NETWORK'))
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_UPLOAD_NETWORK'))
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_UPLOAD_NETWORK'))
      .mockResolvedValue(undefined);
    const setup = harness({ uploadRecord });
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
    expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBe(publication);

    await vi.waitFor(() => expect(uploadRecord).toHaveBeenCalledTimes(6), { timeout: 5_000 });

    await expect(setup.publisher.cancelPendingRecordSet(QUEUE_ID)).resolves.toBe(false);
    expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBe(publication);
    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
  });

  it('retires a first-ready set on tail failure without revoking an active reader', async () => {
    const createdSetIds: string[] = [];
    const createRecordSet = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['createRecordSet']>>()
      .mockImplementation(async (meta) => {
        const setId = crypto.randomUUID();
        createdSetIds.push(setId);
        return {
          v: 2 as const,
          storageRoomId: meta.storageRoomId,
          setId,
          recordSize: meta.recordSize,
          recordCount: meta.recordCount,
          expiresAt: Date.now() + 120_000,
          setToken: `set-token:${setId}`,
          cleanupToken: CLEANUP_TOKEN,
          records: Array.from({ length: meta.recordCount }, (_, index) => {
            const plaintextSize =
              index === meta.recordCount - 1
                ? meta.plaintextSize - index * meta.recordSize
                : meta.recordSize;
            return {
              index,
              objectId: crypto.randomUUID(),
              plaintextSize,
              encryptedSize: plaintextSize + 16,
              downloadUrl: `https://share.musixquare.com/${meta.storageRoomId}/${index}`,
            };
          }),
        };
      });
    const uploadRecord = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['uploadRecord']>>()
      .mockImplementationOnce(async () => undefined)
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_UPLOAD_HTTP_400'))
      .mockImplementation(async () => undefined);
    let oldCleanupFailed = false;
    const deleteRecordSet = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['deleteRecordSet']>>()
      .mockImplementation(async (session) => {
        if (!oldCleanupFailed && session.setId === createdSetIds[0]) {
          oldCleanupFailed = true;
          throw new Error('REMOTE_SHARE_RECORD_SET_CLEANUP_NETWORK');
        }
      });
    const setup = harness({ createRecordSet, uploadRecord, deleteRecordSet });
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
    await vi.waitFor(() => expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBeNull());
    // The descriptor was already offered after record zero completed. Tail
    // failure removes it from future offers but keeps its readable first
    // record alive until expiry or explicit queue/room retirement.
    expect(setup.deleteRecordSet).not.toHaveBeenCalled();

    await expect(
      setup.publisher.publishRecordSet(large, {
        storageRoomId: '123456',
        applicationSessionId: 'application-session',
      }),
    ).resolves.toMatchObject({ recordCount: 2 });
    expect(createRecordSet).toHaveBeenCalledTimes(2);
    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).rejects.toThrow(
      'File playback R2 queue item cleanup failed',
    );
    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
    expect(deleteRecordSet).toHaveBeenCalledTimes(3);
  });

  it('does not reuse a publication near expiry and republishes the exact source', async () => {
    let now = 1_000_000;
    let generation = 0;
    const createRecordSet = vi.fn(async (meta) => {
      generation += 1;
      const setId = `60000000-0000-4000-8000-${String(generation).padStart(12, '0')}`;
      return {
        v: 2 as const,
        storageRoomId: meta.storageRoomId,
        setId,
        recordSize: meta.recordSize,
        recordCount: meta.recordCount,
        expiresAt: now + 120_000,
        setToken: `set-token:${generation}`,
        cleanupToken: CLEANUP_TOKEN,
        records: [
          {
            index: 0,
            objectId: `70000000-0000-4000-8000-${String(generation).padStart(12, '0')}`,
            plaintextSize: meta.plaintextSize,
            encryptedSize: meta.plaintextSize + 16,
            downloadUrl: `https://share.musixquare.com/${meta.storageRoomId}/${generation}`,
          },
        ],
      };
    });
    const setup = harness({ now: () => now, createRecordSet });
    const options = {
      storageRoomId: '123456',
      applicationSessionId: 'application-session',
    } as const;
    const input = source();
    const first = await setup.publisher.publishRecordSet(input, options);

    now = first.expiresAtEpochMs - 60_000;
    expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBeNull();
    const second = await setup.publisher.publishRecordSet(input, options);

    expect(second.setId).not.toBe(first.setId);
    expect(createRecordSet).toHaveBeenCalledTimes(2);
    expect(setup.deleteRecordSet).not.toHaveBeenCalled();
    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
    expect(setup.deleteRecordSet).toHaveBeenCalledTimes(2);
  });

  it('retries an ambiguous record-completion timeout without re-uploading ciphertext', async () => {
    const completeRecord = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['completeRecord']>>()
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_COMPLETE_TIMEOUT'))
      .mockImplementation(async (session, index) => ({
        v: 2 as const,
        setId: session.setId,
        index,
        objectId: session.records[index]!.objectId,
        expiresAt: session.expiresAt,
        readyRecordCount: index + 1,
        recordCount: session.recordCount,
        complete: index + 1 === session.recordCount,
        downloadUrl: session.records[index]!.downloadUrl,
      }));
    const setup = harness({ completeRecord });

    await expect(
      setup.publisher.publishRecordSet(source(), {
        storageRoomId: '123456',
        applicationSessionId: 'application-session',
      }),
    ).resolves.toMatchObject({ recordCount: 1 });

    expect(setup.createRecordSet).toHaveBeenCalledOnce();
    expect(setup.uploadRecord).toHaveBeenCalledOnce();
    expect(completeRecord).toHaveBeenCalledTimes(2);
    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
  });

  it('does not retry an owner abort as a transient record-completion failure', async () => {
    const completeRecord = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['completeRecord']>>()
      .mockRejectedValue(new Error('REMOTE_SHARE_ABORTED'));
    const setup = harness({ completeRecord });

    await expect(
      setup.publisher.publishRecordSet(source(), {
        storageRoomId: '123456',
        applicationSessionId: 'application-session',
      }),
    ).rejects.toThrow('REMOTE_SHARE_ABORTED');

    expect(setup.createRecordSet).toHaveBeenCalledOnce();
    expect(setup.uploadRecord).toHaveBeenCalledOnce();
    expect(completeRecord).toHaveBeenCalledOnce();
    expect(setup.deleteRecordSet).toHaveBeenCalledOnce();
  });

  it('retains one publication intent across ambiguous create retries', async () => {
    const createRecordSet = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['createRecordSet']>>()
      .mockRejectedValue(new Error('REMOTE_SHARE_RECORD_SET_CREATE_TIMEOUT'));
    const setup = harness({ createRecordSet });
    const publishSource = source();
    const options = {
      storageRoomId: '123456',
      applicationSessionId: 'application-session',
    } as const;

    await expect(setup.publisher.publishRecordSet(publishSource, options)).rejects.toThrow(
      'REMOTE_SHARE_RECORD_SET_CREATE_TIMEOUT',
    );
    await expect(setup.publisher.publishRecordSet(publishSource, options)).rejects.toThrow(
      'REMOTE_SHARE_RECORD_SET_CREATE_TIMEOUT',
    );

    expect(createRecordSet).toHaveBeenCalledTimes(2);
    const firstIntent = createRecordSet.mock.calls[0]![0].publicationIntentId;
    expect(firstIntent).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(createRecordSet.mock.calls[1]![0].publicationIntentId).toBe(firstIntent);
    expect(setup.uploadRecord).not.toHaveBeenCalled();
    expect(setup.deleteRecordSet).not.toHaveBeenCalled();

    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
    expect(setup.cancelRecordSetCreateIntent).toHaveBeenCalledOnce();
    expect(setup.cancelRecordSetCreateIntent.mock.calls[0]![0].publicationIntentId).toBe(
      firstIntent,
    );
  });

  it('cancels a retained ambiguous intent after its in-flight attempt has settled', async () => {
    const createRecordSet = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['createRecordSet']>>()
      .mockRejectedValue(new Error('REMOTE_SHARE_RECORD_SET_CREATE_TIMEOUT'));
    const setup = harness({ createRecordSet });

    await expect(
      setup.publisher.publishRecordSet(source(), {
        storageRoomId: '123456',
        applicationSessionId: 'application-session',
      }),
    ).rejects.toThrow('REMOTE_SHARE_RECORD_SET_CREATE_TIMEOUT');

    await expect(setup.publisher.cancelPendingRecordSet(QUEUE_ID)).resolves.toBe(true);
    expect(setup.cancelRecordSetCreateIntent).toHaveBeenCalledOnce();
    expect(setup.cancelRecordSetCreateIntent.mock.calls[0]![0].publicationIntentId).toBe(
      createRecordSet.mock.calls[0]![0].publicationIntentId,
    );
  });

  it('keeps an idempotency-conflicted intent poisoned instead of rotating its key', async () => {
    const createRecordSet = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['createRecordSet']>>()
      .mockRejectedValue(new Error('REMOTE_SHARE_RECORD_SET_CREATE_IDEMPOTENCY_CONFLICT'));
    const setup = harness({ createRecordSet });
    const publishSource = source();
    const options = {
      storageRoomId: '123456',
      applicationSessionId: 'application-session',
    } as const;

    await expect(setup.publisher.publishRecordSet(publishSource, options)).rejects.toThrow(
      'REMOTE_SHARE_RECORD_SET_CREATE_IDEMPOTENCY_CONFLICT',
    );
    await expect(setup.publisher.publishRecordSet(publishSource, options)).rejects.toThrow(
      'REMOTE_SHARE_RECORD_SET_CREATE_IDEMPOTENCY_CONFLICT',
    );

    expect(createRecordSet).toHaveBeenCalledTimes(2);
    expect(createRecordSet.mock.calls[1]![0].publicationIntentId).toBe(
      createRecordSet.mock.calls[0]![0].publicationIntentId,
    );
    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
    expect(setup.cancelRecordSetCreateIntent).toHaveBeenCalledOnce();
  });

  it('retires an exposed superseded upload without revoking its active reader', async () => {
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
    let generation = 0;
    const createRecordSet = vi.fn(async (meta) => {
      generation += 1;
      const setId = `60000000-0000-4000-8000-${String(generation).padStart(12, '0')}`;
      return {
        v: 2 as const,
        storageRoomId: meta.storageRoomId,
        setId,
        recordSize: meta.recordSize,
        recordCount: meta.recordCount,
        expiresAt: Date.now() + 120_000,
        setToken: `set-token:${generation}`,
        cleanupToken: CLEANUP_TOKEN,
        records: Array.from({ length: meta.recordCount }, (_, index) => {
          const plaintextSize =
            index === meta.recordCount - 1
              ? meta.plaintextSize - index * meta.recordSize
              : meta.recordSize;
          return {
            index,
            objectId: `70000000-0000-4000-8000-${String(generation * 10 + index).padStart(12, '0')}`,
            plaintextSize,
            encryptedSize: plaintextSize + 16,
            downloadUrl: `https://share.musixquare.com/${meta.storageRoomId}/${generation}/${index}`,
          };
        }),
      };
    });
    const completeRecord = vi.fn(async (session, index) => {
      if (session.recordCount === 1) {
        return {
          v: 2 as const,
          setId: session.setId,
          index,
          objectId: session.records[index]!.objectId,
          expiresAt: session.expiresAt,
          readyRecordCount: 1,
          recordCount: 1,
          complete: true,
          downloadUrl: session.records[index]!.downloadUrl,
        };
      }
      if (generation === 1 && index === 1) return secondCompletion.promise;
      return {
        v: 2 as const,
        setId: session.setId,
        index,
        objectId: session.records[index]!.objectId,
        expiresAt: session.expiresAt,
        readyRecordCount: index + 1,
        recordCount: session.recordCount,
        complete: index + 1 === session.recordCount,
        downloadUrl: session.records[index]!.downloadUrl,
      };
    });
    const setup = harness({
      createRecordSet,
      completeRecord,
    });
    const large = source({
      blob: new File([new Uint8Array(8 * 1024 * 1024), new Uint8Array([9])], 'large.flac', {
        type: 'audio/flac',
        lastModified: 0,
      }),
      name: 'large.flac',
      mime: 'audio/flac',
    });
    const pending = setup.publisher.publishRecordSet(large, {
      storageRoomId: '123456',
      applicationSessionId: 'application-session',
    });
    const publication = await pending;
    await vi.waitFor(() => expect(setup.uploadRecord).toHaveBeenCalledTimes(2));

    const cancellation = setup.publisher.cancelPendingRecordSet(QUEUE_ID);
    secondCompletion.resolve({
      v: 2,
      setId: RECORD_SET_ID,
      index: 1,
      objectId: RECORD_OBJECT_ONE,
      expiresAt: Date.now() + 120_000,
      readyRecordCount: 2,
      recordCount: 2,
      complete: true,
      downloadUrl: 'https://share.musixquare.com/123456/1',
    });
    await expect(cancellation).resolves.toBe(true);
    expect(publication.recordCount).toBe(2);
    expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBeNull();
    expect(setup.deleteRecordSet).not.toHaveBeenCalled();

    const completed = await setup.publisher.publishRecordSet(large, {
      storageRoomId: '123456',
      applicationSessionId: 'application-session',
    });
    expect(completed.setId).not.toBe(publication.setId);
    await vi.waitFor(() => expect(completeRecord).toHaveBeenCalledTimes(4));
    await Promise.resolve();
    await expect(setup.publisher.cancelPendingRecordSet(QUEUE_ID)).resolves.toBe(false);
    expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBe(completed);
    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
    expect(setup.deleteRecordSet).toHaveBeenCalledTimes(2);
  });

  it('retains record cleanup authority and makes a failed queue removal explicitly retryable', async () => {
    const deleteRecordSet = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['deleteRecordSet']>>()
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_SET_CLEANUP_NETWORK'))
      .mockResolvedValue(undefined);
    const setup = harness({ deleteRecordSet });
    const publication = await setup.publisher.publishRecordSet(source(), {
      storageRoomId: '123456',
      applicationSessionId: 'application-session',
    });

    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).rejects.toThrow(
      'File playback R2 queue item cleanup failed',
    );
    expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBe(publication);
    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
    expect(setup.publisher.currentRecordSet(QUEUE_ID)).toBeNull();
    expect(deleteRecordSet).toHaveBeenCalledTimes(2);
  });

  it('retains cleanup authority after close failure and retries on the next close', async () => {
    const deleteRecordSet = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['deleteRecordSet']>>()
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_SET_CLEANUP_NETWORK'))
      .mockResolvedValue(undefined);
    const setup = harness({ deleteRecordSet });
    await setup.publisher.publishRecordSet(source(), {
      storageRoomId: '123456',
      applicationSessionId: 'application-session',
    });

    await expect(setup.publisher.close()).rejects.toThrow(
      'File playback R2 publisher cleanup failed',
    );
    await expect(setup.publisher.close()).resolves.toBeUndefined();
    expect(deleteRecordSet).toHaveBeenCalledTimes(2);
  });

  it('preserves a partial-set cleanup token and retries it before republishing', async () => {
    const uploadRecord = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['uploadRecord']>>()
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_UPLOAD_NETWORK'))
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_UPLOAD_NETWORK'))
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_UPLOAD_NETWORK'))
      .mockResolvedValue(undefined);
    const deleteRecordSet = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['deleteRecordSet']>>()
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_SET_CLEANUP_NETWORK'))
      .mockResolvedValue(undefined);
    const setup = harness({ deleteRecordSet, uploadRecord });

    await expect(
      setup.publisher.publishRecordSet(source(), {
        storageRoomId: '123456',
        applicationSessionId: 'application-session',
      }),
    ).rejects.toThrow('File playback R2 partial record-set cleanup failed');

    await expect(
      setup.publisher.publishRecordSet(source(), {
        storageRoomId: '123456',
        applicationSessionId: 'application-session',
      }),
    ).resolves.toMatchObject({ recordCount: 1 });
    expect(deleteRecordSet).toHaveBeenCalledTimes(2);
    expect(setup.createRecordSet).toHaveBeenCalledTimes(2);
  });

  it('prunes an expired rotated set, preserves failed cleanup, and retries opportunistically', async () => {
    let now = 1_000_000;
    let generation = 0;
    const createRecordSet = vi.fn(async (meta) => {
      generation += 1;
      const suffix = String(generation).padStart(12, '0');
      return {
        v: 2 as const,
        storageRoomId: meta.storageRoomId,
        setId: `60000000-0000-4000-8000-${suffix}`,
        recordSize: meta.recordSize,
        recordCount: meta.recordCount,
        expiresAt: now + 300_000,
        setToken: `set-token:${generation}`,
        cleanupToken: crypto.randomUUID(),
        records: [
          {
            index: 0,
            objectId: `70000000-0000-4000-8000-${suffix}`,
            plaintextSize: meta.plaintextSize,
            encryptedSize: meta.plaintextSize + 16,
            downloadUrl: `https://share.musixquare.com/${meta.storageRoomId}/${generation}`,
          },
        ],
      };
    });
    const deleteRecordSet = vi
      .fn<NonNullable<FilePlaybackR2WholeBlobPublisherRuntime['deleteRecordSet']>>()
      .mockRejectedValueOnce(new Error('REMOTE_SHARE_RECORD_SET_CLEANUP_NETWORK'))
      .mockResolvedValue(undefined);
    const setup = harness({ now: () => now, createRecordSet, deleteRecordSet });
    const options = {
      storageRoomId: '123456',
      applicationSessionId: 'application-session',
    } as const;
    const input = source();
    const first = await setup.publisher.publishRecordSet(input, options);

    now = first.expiresAtEpochMs - 60_000;
    const second = await setup.publisher.publishRecordSet(input, options);
    expect(second.setId).not.toBe(first.setId);
    expect(deleteRecordSet).not.toHaveBeenCalled();

    now = first.expiresAtEpochMs + 1;
    expect(await setup.publisher.publishRecordSet(input, options)).toBe(second);
    await vi.waitFor(() => expect(deleteRecordSet).toHaveBeenCalledTimes(1));
    await expect(deleteRecordSet.mock.results[0]!.value).rejects.toThrow(
      'REMOTE_SHARE_RECORD_SET_CLEANUP_NETWORK',
    );
    expect(await setup.publisher.publishRecordSet(input, options)).toBe(second);
    await vi.waitFor(() => expect(deleteRecordSet).toHaveBeenCalledTimes(2));

    await expect(setup.publisher.removeQueueItem(QUEUE_ID)).resolves.toBe(true);
    expect(deleteRecordSet).toHaveBeenCalledTimes(3);
  });
});
