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
});
