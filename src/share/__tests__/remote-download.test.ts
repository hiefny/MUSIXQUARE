/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteFileSharePayload } from '../../types/index.ts';

const mocks = vi.hoisted(() => ({ downloadWholeObject: vi.fn() }));

vi.mock('../r2-client.ts', () => ({ downloadWholeObject: mocks.downloadWholeObject }));

function descriptor(): RemoteFileSharePayload {
  return {
    roomId: '123456',
    objectId: '00000000-0000-4000-8000-000000000001',
    downloadUrl:
      'https://share.musixquare.com/download/123456/00000000-0000-4000-8000-000000000001',
    storageFormat: 'whole-v1',
    storedSize: 4,
    downloadToken: `${'p'.repeat(40)}.${'s'.repeat(43)}`,
    name: 'song.mp3',
    mime: 'audio/mpeg',
    size: 4,
    queueItemId: '10000000-0000-4000-8000-000000000001',
    sessionId: 1,
    expiresAt: Date.now() + 60_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.downloadWholeObject.mockResolvedValue(new TextEncoder().encode('data').buffer);
});

describe('remote download integrity', () => {
  it('turns an authenticated whole object directly into a File', async () => {
    const { downloadRemoteFile } = await import('../remote-download.ts');
    const value = descriptor();

    await expect(downloadRemoteFile(value)).resolves.toMatchObject({
      name: 'song.mp3',
      size: 4,
      type: 'audio/mpeg',
    });
    expect(mocks.downloadWholeObject).toHaveBeenCalledWith(
      value.roomId,
      value.objectId,
      value.storedSize,
      value.downloadToken,
      value.downloadUrl,
      undefined,
      undefined,
    );
  });

  it('binds stored and downloaded lengths to the descriptor', async () => {
    const { downloadRemoteFile } = await import('../remote-download.ts');
    const value = descriptor();

    await expect(downloadRemoteFile({ ...value, storedSize: 3 })).rejects.toThrow(
      'REMOTE_SHARE_DOWNLOAD_SIZE_MISMATCH',
    );
    expect(mocks.downloadWholeObject).not.toHaveBeenCalled();

    mocks.downloadWholeObject.mockResolvedValueOnce(new ArrayBuffer(3));
    await expect(downloadRemoteFile(value)).rejects.toThrow('REMOTE_SHARE_OBJECT_SIZE_MISMATCH');
  });

  it('discards a completed download when its owner aborts', async () => {
    const { downloadRemoteFile } = await import('../remote-download.ts');
    const abort = new AbortController();
    let finish!: (bytes: ArrayBuffer) => void;
    mocks.downloadWholeObject.mockImplementationOnce(
      () => new Promise<ArrayBuffer>((resolve) => (finish = resolve)),
    );

    const pending = downloadRemoteFile(descriptor(), undefined, abort.signal);
    abort.abort();
    finish(new TextEncoder().encode('data').buffer);

    await expect(pending).rejects.toThrow('REMOTE_SHARE_ABORTED');
  });
});
