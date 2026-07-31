/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { REMOTE_SHARE_MAX_BYTES } from '../../core/constants.ts';

const mocks = vi.hoisted(() => ({
  encryptFile: vi.fn(),
  supportsPlainWholeObjectUpload: vi.fn(),
  uploadEncryptedBlob: vi.fn(),
  uploadPlainBlob: vi.fn(),
}));

const Q0 = '10000000-0000-4000-8000-000000000001';
const Q1 = '10000000-0000-4000-8000-000000000002';
const Q2 = '10000000-0000-4000-8000-000000000003';
const Q3 = '10000000-0000-4000-8000-000000000004';

vi.mock('../crypto.ts', () => ({ encryptFile: mocks.encryptFile }));
vi.mock('../r2-client.ts', () => ({
  supportsPlainWholeObjectUpload: mocks.supportsPlainWholeObjectUpload,
  uploadEncryptedBlob: mocks.uploadEncryptedBlob,
  uploadPlainBlob: mocks.uploadPlainBlob,
}));

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
  setState('network.sessionCode', '123456');
  mocks.supportsPlainWholeObjectUpload.mockResolvedValue(false);
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
  mocks.uploadPlainBlob.mockResolvedValue({
    objectId: '00000000-0000-4000-8000-000000000002',
    downloadUrl:
      'https://share.musixquare.com/v3/plain/download/123456/00000000-0000-4000-8000-000000000002',
    expiresAt: Date.now() + 60_000,
    downloadToken: `${'p'.repeat(40)}.${'s'.repeat(43)}`,
  });
});

describe('remote upload contract', () => {
  it('uploads the original File without invoking Web Crypto when plaintext v1 is available', async () => {
    mocks.supportsPlainWholeObjectUpload.mockResolvedValueOnce(true);
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    const file = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });

    await expect(uploadRemoteFile(file, 7, Q2)).resolves.toMatchObject({
      storageFormat: 'plain-whole-v1',
      storedSize: 4,
      size: 4,
      sessionId: 7,
      queueItemId: Q2,
      downloadToken: expect.any(String),
    });
    expect(mocks.encryptFile).not.toHaveBeenCalled();
    expect(mocks.uploadEncryptedBlob).not.toHaveBeenCalled();
    expect(mocks.uploadPlainBlob).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ roomId: '123456', size: 4 }),
      expect.any(Function),
      undefined,
    );
  });

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

  it('keeps speculative uploads out of the foreground remote-share state', async () => {
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    const file = new File(['data'], 'next.mp3', { type: 'audio/mpeg' });
    const before = getState('share.remote').upload;

    await expect(uploadRemoteFile(file, 7, Q2, { publishState: false })).resolves.toMatchObject({
      queueItemId: Q2,
      sessionId: 7,
    });

    expect(getState('share.remote').upload).toEqual(before);
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

  it('does not reject an iOS upload from a predicted crypto memory peak', async () => {
    const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone)',
    });
    const file = new File(['x'], 'large-mobile.wav');
    Object.defineProperty(file, 'size', { configurable: true, value: 80 * 1024 * 1024 });
    const encryptedBlob = new Blob(['ciphertext']);
    Object.defineProperty(encryptedBlob, 'size', {
      configurable: true,
      value: file.size + 16,
    });
    mocks.encryptFile.mockResolvedValueOnce({ encryptedBlob, keyB64: 'a2V5', ivB64: 'aXY=' });
    const { reserveDecodeMemoryWithinBudget } = await import('../../player/decode-admission.ts');
    const pendingNativeDecode = reserveDecodeMemoryWithinBudget(1 * 1024 * 1024);

    try {
      const { uploadRemoteFile } = await import('../remote-upload.ts');
      await expect(uploadRemoteFile(file, 9, Q3)).resolves.toMatchObject({
        size: file.size,
        encryptedSize: file.size + 16,
      });
      expect(mocks.encryptFile).toHaveBeenCalledOnce();
    } finally {
      pendingNativeDecode.release();
      if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent);
    }
  });

  it('does not serialize concurrent uploads behind a predictive memory ledger', async () => {
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
    mocks.encryptFile.mockResolvedValueOnce({
      encryptedBlob,
      keyB64: 'a2V5',
      ivB64: 'aXY=',
    });

    try {
      const { uploadRemoteFile } = await import('../remote-upload.ts');
      const first = uploadRemoteFile(fileA, 1, Q0);
      await vi.waitFor(() => expect(mocks.encryptFile).toHaveBeenCalledOnce());

      await expect(uploadRemoteFile(fileB, 2, Q1)).resolves.toMatchObject({
        name: 'b.wav',
        sessionId: 2,
      });
      expect(mocks.encryptFile).toHaveBeenCalledTimes(2);

      resolveFirstEncryption({ encryptedBlob, keyB64: 'a2V5', ivB64: 'aXY=' });
      await expect(first).resolves.toMatchObject({ name: 'a.wav', sessionId: 1 });
      expect(mocks.uploadEncryptedBlob).toHaveBeenCalledTimes(2);
    } finally {
      if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent);
    }
  });
});
