/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, resetState, setState } from '../../core/state.ts';
import { REMOTE_SHARE_MAX_BYTES } from '../../core/constants.ts';

const mocks = vi.hoisted(() => ({ uploadWholeObject: vi.fn() }));

const Q0 = '10000000-0000-4000-8000-000000000001';
const DOWNLOAD_TOKEN = `${'p'.repeat(40)}.${'s'.repeat(43)}`;

vi.mock('../r2-client.ts', () => ({ uploadWholeObject: mocks.uploadWholeObject }));

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
  setState('network.sessionCode', '123456');
  mocks.uploadWholeObject.mockResolvedValue({
    objectId: '00000000-0000-4000-8000-000000000001',
    downloadUrl:
      'https://share.musixquare.com/download/123456/00000000-0000-4000-8000-000000000001',
    storedSize: 4,
    expiresAt: Date.now() + 60_000,
    downloadToken: DOWNLOAD_TOKEN,
  });
});

describe('remote upload contract', () => {
  it('uploads the original File through the sole whole-object contract', async () => {
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    const file = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });

    await expect(uploadRemoteFile(file, 7, Q0)).resolves.toMatchObject({
      storageFormat: 'whole-v1',
      storedSize: 4,
      size: 4,
      sessionId: 7,
      queueItemId: Q0,
      downloadToken: DOWNLOAD_TOKEN,
    });
    expect(mocks.uploadWholeObject).toHaveBeenCalledWith(
      file,
      expect.objectContaining({
        roomId: '123456',
        size: 4,
        requestRoomUploadAssertion: expect.any(Function),
      }),
      expect.any(Function),
      undefined,
    );
    expect(getState('share.remote').upload).toMatchObject({ status: 'done', progress: 1 });

    const uploadMeta = mocks.uploadWholeObject.mock.calls[0]?.[1] as {
      requestRoomUploadAssertion?: (request: Record<string, unknown>) => Promise<string | null>;
    };
    if (!uploadMeta.requestRoomUploadAssertion) throw new Error('missing assertion provider');
    await expect(
      uploadMeta.requestRoomUploadAssertion({
        actorId: `rsa_${'a'.repeat(43)}`,
        requestId: `rs3_${'r'.repeat(43)}`,
        sessionId: 7,
        queueItemId: Q0,
        size: 4,
        bodySha256: 'A'.repeat(43),
      }),
    ).rejects.toThrow('REMOTE_SHARE_UPLOAD_ASSERTION_UNAVAILABLE');
  });

  it('rejects invalid identity and source sizes before upload', async () => {
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    const file = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });

    await expect(uploadRemoteFile(file, 0, Q0)).rejects.toThrow('REMOTE_SHARE_INVALID_IDENTITY');
    await expect(uploadRemoteFile(file, 1, 'not-a-queue-item-id')).rejects.toThrow(
      'REMOTE_SHARE_INVALID_IDENTITY',
    );
    await expect(uploadRemoteFile(new File([], 'empty.mp3'), 1, Q0)).rejects.toThrow(
      'REMOTE_SHARE_FILE_TOO_LARGE',
    );
    const tooLarge = new File(['x'], 'large.wav');
    Object.defineProperty(tooLarge, 'size', { value: REMOTE_SHARE_MAX_BYTES + 1 });
    await expect(uploadRemoteFile(tooLarge, 1, Q0)).rejects.toThrow('REMOTE_SHARE_FILE_TOO_LARGE');
    expect(mocks.uploadWholeObject).not.toHaveBeenCalled();
  });

  it('does not publish speculative preload progress into foreground state', async () => {
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    const file = new File(['data'], 'song.mp3', { type: 'audio/mpeg' });

    await uploadRemoteFile(file, 7, Q0, { publishState: false });

    expect(getState('share.remote').upload.status).toBe('idle');
  });
});
