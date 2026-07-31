/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteFileSharePayload } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({
  decryptToFile: vi.fn(),
  downloadEncryptedObject: vi.fn(),
  downloadPlainObject: vi.fn(),
}));

vi.mock('../crypto.ts', () => ({ decryptToFile: mocks.decryptToFile }));
vi.mock('../r2-client.ts', () => ({
  downloadEncryptedObject: mocks.downloadEncryptedObject,
  downloadPlainObject: mocks.downloadPlainObject,
}));

function descriptor(): RemoteFileSharePayload {
  return {
    roomId: '123456',
    objectId: '00000000-0000-4000-8000-000000000001',
    downloadUrl:
      'https://share.musixquare.com/download/123456/00000000-0000-4000-8000-000000000001',
    keyB64: 'a2V5',
    ivB64: 'aXY=',
    name: 'song.mp3',
    mime: 'audio/mpeg',
    size: 4,
    encryptedSize: 20,
    queueItemId: '10000000-0000-4000-8000-000000000001',
    sessionId: 1,
    expiresAt: Date.now() + 60_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.downloadEncryptedObject.mockResolvedValue(new ArrayBuffer(20));
  mocks.downloadPlainObject.mockResolvedValue(new TextEncoder().encode('data').buffer);
  mocks.decryptToFile.mockResolvedValue(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));
});

describe('remote download integrity', () => {
  it('turns an authorized plaintext object directly into a File', async () => {
    const { downloadRemoteFile } = await import('../remote-download.ts');
    const value: RemoteFileSharePayload = {
      roomId: '123456',
      objectId: '00000000-0000-4000-8000-000000000002',
      downloadUrl:
        'https://share.musixquare.com/v3/plain/download/123456/00000000-0000-4000-8000-000000000002',
      storageFormat: 'plain-whole-v1',
      storedSize: 4,
      downloadToken: `${'p'.repeat(40)}.${'s'.repeat(43)}`,
      name: 'song.mp3',
      mime: 'audio/mpeg',
      size: 4,
      queueItemId: '10000000-0000-4000-8000-000000000001',
      sessionId: 1,
      expiresAt: Date.now() + 60_000,
    };

    await expect(downloadRemoteFile(value)).resolves.toMatchObject({
      name: 'song.mp3',
      size: 4,
      type: 'audio/mpeg',
    });
    expect(mocks.downloadPlainObject).toHaveBeenCalledWith(
      value.roomId,
      value.objectId,
      value.storedSize,
      value.downloadToken,
      value.downloadUrl,
      undefined,
      undefined,
    );
    expect(mocks.decryptToFile).not.toHaveBeenCalled();
  });

  it('binds download and plaintext lengths to the descriptor', async () => {
    const { downloadRemoteFile } = await import('../remote-download.ts');
    const value = descriptor();

    await expect(downloadRemoteFile(value)).resolves.toMatchObject({ size: 4 });
    expect(mocks.downloadEncryptedObject).toHaveBeenCalledWith(
      value.roomId,
      value.objectId,
      value.encryptedSize,
      value.downloadUrl,
      undefined,
      undefined,
    );

    mocks.downloadEncryptedObject.mockResolvedValueOnce(new ArrayBuffer(19));
    await expect(downloadRemoteFile(value)).rejects.toThrow('REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH');

    mocks.decryptToFile.mockResolvedValueOnce(
      new File(['wrong'], 'song.mp3', { type: 'audio/mpeg' }),
    );
    await expect(downloadRemoteFile(value)).rejects.toThrow('REMOTE_SHARE_PLAINTEXT_SIZE_MISMATCH');
  });

  it('discards a decrypt result when the owner aborts during Web Crypto work', async () => {
    const { downloadRemoteFile } = await import('../remote-download.ts');
    const abort = new AbortController();
    let finishDecrypt!: (file: File) => void;
    mocks.decryptToFile.mockImplementationOnce(
      () =>
        new Promise<File>((resolve) => {
          finishDecrypt = resolve;
        }),
    );

    const pending = downloadRemoteFile(descriptor(), undefined, abort.signal);
    await vi.waitFor(() => expect(mocks.decryptToFile).toHaveBeenCalledOnce());
    abort.abort();
    finishDecrypt(new File(['data'], 'song.mp3', { type: 'audio/mpeg' }));

    await expect(pending).rejects.toThrow('REMOTE_SHARE_ABORTED');
  });
});
