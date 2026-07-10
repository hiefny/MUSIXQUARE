/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetState, setState } from '../../core/state.ts';

const mocks = vi.hoisted(() => ({
  createChunkEncryptionPlan: vi.fn(),
  encryptFileChunk: vi.fn(),
  contentMd5Base64: vi.fn(),
  requestMultipartUploadSession: vi.fn(),
  requestMultipartPartUrls: vi.fn(),
  uploadMultipartPart: vi.fn(),
  completeMultipartUpload: vi.fn(),
  abortMultipartUpload: vi.fn(),
}));

vi.mock('../crypto.ts', () => ({
  createChunkEncryptionPlan: mocks.createChunkEncryptionPlan,
  encryptFileChunk: mocks.encryptFileChunk,
}));

vi.mock('../md5.ts', () => ({
  contentMd5Base64: mocks.contentMd5Base64,
}));

vi.mock('../r2-client.ts', () => ({
  REMOTE_SHARE_MAX_PLAINTEXT_BYTES: 5 * 1024 * 1024 * 1024,
  requestMultipartUploadSession: mocks.requestMultipartUploadSession,
  requestMultipartPartUrls: mocks.requestMultipartPartUrls,
  uploadMultipartPart: mocks.uploadMultipartPart,
  completeMultipartUpload: mocks.completeMultipartUpload,
  abortMultipartUpload: mocks.abortMultipartUpload,
}));

describe('remote multipart upload pipeline', () => {
  beforeEach(() => {
    resetState();
    vi.resetAllMocks();
    setState('network.sessionCode', '123456');
    const plan = {
      keyB64: 'key',
      ivB64: 'nonce',
      cryptoVersion: 2 as const,
      plainSize: 9,
      encryptedSize: 41,
      chunkSize: 8,
      chunkCount: 2,
      tagBytes: 16,
    };
    mocks.createChunkEncryptionPlan.mockResolvedValue(plan);
    mocks.encryptFileChunk
      .mockResolvedValueOnce(new ArrayBuffer(24))
      .mockResolvedValueOnce(new ArrayBuffer(17));
    mocks.contentMd5Base64
      .mockResolvedValueOnce('AAAAAAAAAAAAAAAAAAAAAA==')
      .mockResolvedValueOnce('AQEBAQEBAQEBAQEBAQEBAQ==');
    mocks.requestMultipartUploadSession.mockResolvedValue({
      protocolVersion: 4,
      endpoint: 'https://share.example.test',
      objectId: '11111111-1111-4111-8111-111111111111',
      controlToken: 'control',
      downloadUrl:
        'https://share.example.test/download/123456/11111111-1111-4111-8111-111111111111',
      expiresAt: Date.now() + 60_000,
    });
    mocks.requestMultipartPartUrls.mockImplementation(
      async (_session: unknown, parts: Array<{ partNumber: number; contentMd5: string }>) =>
        parts.map(({ partNumber, contentMd5 }) => ({
          partNumber,
          uploadUrl: `https://account.r2.cloudflarestorage.com/key?partNumber=${partNumber}`,
          uploadHeaders: { 'content-md5': contentMd5 },
        })),
    );
    mocks.uploadMultipartPart.mockImplementation(async (target, _encrypted, onProgress) => {
      onProgress?.(1);
      return { partNumber: target.partNumber, etag: String(target.partNumber).padStart(32, '0') };
    });
    mocks.completeMultipartUpload.mockResolvedValue({
      objectId: '11111111-1111-4111-8111-111111111111',
      downloadUrl:
        'https://share.example.test/download/123456/11111111-1111-4111-8111-111111111111',
      expiresAt: Date.now() + 60_000,
    });
    mocks.abortMultipartUpload.mockResolvedValue(undefined);
  });

  it('encrypts and uploads one bounded record at a time before completing', async () => {
    const file = new File([new Uint8Array(9)], 'podcast.wav', { type: 'audio/wav' });
    const progress = vi.fn();
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    const descriptor = await uploadRemoteFile(file, 7, 0, progress);

    expect(mocks.encryptFileChunk.mock.calls.map((call) => call[2])).toEqual([0, 1]);
    expect(mocks.requestMultipartPartUrls.mock.calls.map((call) => call[1])).toEqual([
      [{ partNumber: 1, contentMd5: 'AAAAAAAAAAAAAAAAAAAAAA==' }],
      [{ partNumber: 2, contentMd5: 'AQEBAQEBAQEBAQEBAQEBAQ==' }],
    ]);
    expect(mocks.uploadMultipartPart).toHaveBeenCalledTimes(2);
    expect(mocks.completeMultipartUpload).toHaveBeenCalledWith(
      expect.anything(),
      '123456',
      [
        { partNumber: 1, etag: '00000000000000000000000000000001' },
        { partNumber: 2, etag: '00000000000000000000000000000002' },
      ],
      undefined,
    );
    expect(mocks.abortMultipartUpload).not.toHaveBeenCalled();
    expect(descriptor).toMatchObject({
      cryptoVersion: 2,
      chunkCount: 2,
      encryptedSize: 41,
      size: 9,
    });
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it('aborts the multipart session after a part failure', async () => {
    mocks.uploadMultipartPart.mockRejectedValue(new Error('REMOTE_SHARE_UPLOAD_HTTP_400'));
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    await expect(
      uploadRemoteFile(new File([new Uint8Array(9)], 'podcast.wav'), 7, 0),
    ).rejects.toBeInstanceOf(Error);
    expect(mocks.abortMultipartUpload).toHaveBeenCalledOnce();
    expect(mocks.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('refreshes an expired UploadPart URL without re-encrypting or re-hashing', async () => {
    mocks.uploadMultipartPart.mockRejectedValueOnce(new Error('REMOTE_SHARE_UPLOAD_HTTP_403'));
    const { uploadRemoteFile } = await import('../remote-upload.ts');
    await uploadRemoteFile(new File([new Uint8Array(9)], 'podcast.wav'), 7, 0);

    expect(mocks.encryptFileChunk).toHaveBeenCalledTimes(2);
    expect(mocks.contentMd5Base64).toHaveBeenCalledTimes(2);
    expect(mocks.requestMultipartPartUrls.mock.calls.map((call) => call[1])).toEqual([
      [{ partNumber: 1, contentMd5: 'AAAAAAAAAAAAAAAAAAAAAA==' }],
      [{ partNumber: 1, contentMd5: 'AAAAAAAAAAAAAAAAAAAAAA==' }],
      [{ partNumber: 2, contentMd5: 'AQEBAQEBAQEBAQEBAQEBAQ==' }],
    ]);
    expect(mocks.abortMultipartUpload).not.toHaveBeenCalled();
  });
});
