/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { REMOTE_SHARE_MAX_BYTES } from '../../core/constants.ts';

const mocks = vi.hoisted(() => ({
  encryptFile: vi.fn(),
  uploadEncryptedBlob: vi.fn(),
}));

const Q0 = '10000000-0000-4000-8000-000000000001';
const Q1 = '10000000-0000-4000-8000-000000000002';
const Q2 = '10000000-0000-4000-8000-000000000003';
const Q3 = '10000000-0000-4000-8000-000000000004';

vi.mock('../crypto.ts', () => ({ encryptFile: mocks.encryptFile }));
vi.mock('../r2-client.ts', () => ({ uploadEncryptedBlob: mocks.uploadEncryptedBlob }));

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
  setState('network.sessionCode', '123456');
  mocks.encryptFile.mockResolvedValue({
    encryptedBlob: new Blob([new Uint8Array(20)]),
    keyB64: 'a2V5',
    ivB64: 'aXY=',
  });
  mocks.uploadEncryptedBlob.mockResolvedValue({
    objectId: '00000000-0000-4000-8000-000000000001',
    downloadUrl:
      'https://share.musixquare.com/download/123456/00000000-0000-4000-8000-000000000001',
    expiresAt: Date.now() + 60_000,
  });
});

describe('remote upload contract', () => {
  it('rejects a malformed queue occurrence before reserving or encrypting', async () => {
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    const file = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });

    await expect(uploadRemoteFile(file, 1, 'not-a-queue-item-id')).rejects.toThrow(
      'REMOTE_SHARE_INVALID_IDENTITY',
    );
    expect(mocks.encryptFile).not.toHaveBeenCalled();
  });

  it('rejects empty and over-200-MiB source files before encryption', async () => {
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    const empty = new File([], 'empty.wav');
    const oversized = new File(['x'], 'large.wav');
    Object.defineProperty(oversized, 'size', {
      configurable: true,
      value: REMOTE_SHARE_MAX_BYTES + 1,
    });

    await expect(uploadRemoteFile(empty, 1, Q0)).rejects.toThrow('REMOTE_SHARE_FILE_TOO_LARGE');
    await expect(uploadRemoteFile(oversized, 1, Q0)).rejects.toThrow('REMOTE_SHARE_FILE_TOO_LARGE');
    expect(mocks.encryptFile).not.toHaveBeenCalled();
  });

  it('requires the exact whole-file AES-GCM tag length', async () => {
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    const file = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });
    mocks.encryptFile.mockResolvedValueOnce({
      encryptedBlob: new Blob([new Uint8Array(19)]),
      keyB64: 'a2V5',
      ivB64: 'aXY=',
    });

    await expect(uploadRemoteFile(file, 1, Q0)).rejects.toThrow(
      'REMOTE_SHARE_ENCRYPTED_SIZE_MISMATCH',
    );
    expect(mocks.uploadEncryptedBlob).not.toHaveBeenCalled();
  });

  it('publishes a descriptor whose sizes match the fixed contract', async () => {
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    const file = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });

    await expect(uploadRemoteFile(file, 7, Q2)).resolves.toMatchObject({
      size: 4,
      encryptedSize: 20,
      sessionId: 7,
      queueItemId: Q2,
    });
  });

  it('accepts the exact 200 MiB boundary when encryption reports one 16-byte tag', async () => {
    const originalDeviceMemory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    const file = new File(['x'], 'max.wav');
    const encryptedBlob = new Blob(['x']);
    Object.defineProperty(file, 'size', { configurable: true, value: REMOTE_SHARE_MAX_BYTES });
    Object.defineProperty(encryptedBlob, 'size', {
      configurable: true,
      value: REMOTE_SHARE_MAX_BYTES + 16,
    });
    mocks.encryptFile.mockResolvedValueOnce({
      encryptedBlob,
      keyB64: 'a2V5',
      ivB64: 'aXY=',
    });

    try {
      await expect(uploadRemoteFile(file, 9, Q3)).resolves.toMatchObject({
        size: REMOTE_SHARE_MAX_BYTES,
        encryptedSize: REMOTE_SHARE_MAX_BYTES + 16,
      });
    } finally {
      if (originalDeviceMemory) {
        Object.defineProperty(navigator, 'deviceMemory', originalDeviceMemory);
      } else {
        Reflect.deleteProperty(navigator, 'deviceMemory');
      }
    }
  });

  it('rejects an unsafe iOS whole-file crypto peak before encryption', async () => {
    const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone)',
    });
    const file = new File(['x'], 'large-mobile.wav');
    Object.defineProperty(file, 'size', { configurable: true, value: 80 * 1024 * 1024 });
    const { reserveDecodeMemoryWithinBudget } = await import('../../player/decode-admission.ts');
    const pendingNativeDecode = reserveDecodeMemoryWithinBudget(1 * 1024 * 1024);

    try {
      const { uploadRemoteFile } = await import('../remote-upload.ts');
      await expect(uploadRemoteFile(file, 9, Q3)).rejects.toMatchObject({
        reason: 'transport-working-set',
      });
      expect(mocks.encryptFile).not.toHaveBeenCalled();
    } finally {
      pendingNativeDecode.release();
      if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent);
    }
  });

  it('admits concurrent whole-file uploads against one shared transport ledger', async () => {
    const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone)',
    });
    const fileA = new File(['a'], 'a.wav');
    const fileB = new File(['b'], 'b.wav');
    for (const file of [fileA, fileB]) {
      Object.defineProperty(file, 'size', { configurable: true, value: 41 * 1024 * 1024 });
    }
    const encryptedBlob = new Blob(['ciphertext']);
    Object.defineProperty(encryptedBlob, 'size', {
      configurable: true,
      value: 41 * 1024 * 1024 + 16,
    });
    let resolveFirstEncryption!: (value: {
      encryptedBlob: Blob;
      keyB64: string;
      ivB64: string;
    }) => void;
    mocks.encryptFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstEncryption = resolve;
        }),
    );

    try {
      const { uploadRemoteFile } = await import('../remote-upload.ts');
      const first = uploadRemoteFile(fileA, 1, Q0);
      await vi.waitFor(() => expect(mocks.encryptFile).toHaveBeenCalledOnce());

      await expect(uploadRemoteFile(fileB, 2, Q1)).rejects.toMatchObject({
        reason: 'transport-working-set',
      });
      expect(mocks.encryptFile).toHaveBeenCalledOnce();

      resolveFirstEncryption({ encryptedBlob, keyB64: 'a2V5', ivB64: 'aXY=' });
      await expect(first).resolves.toMatchObject({ name: 'a.wav', sessionId: 1 });
    } finally {
      if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent);
    }
  });
});
