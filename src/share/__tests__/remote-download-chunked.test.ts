/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteFileSharePayload } from '../../types/index.ts';
import { createChunkEncryptionPlan, encryptFileChunk } from '../crypto.ts';
import { downloadRemoteFile } from '../remote-download.ts';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('chunked remote download integration', () => {
  it('streams, authenticates, and reconstructs a v2 encrypted file', async () => {
    localStorage.setItem('musixquare-remote-share-endpoint', 'https://share.example.test');
    const source = new File(
      [new Uint8Array(90_000).map((_, index) => (index * 17) % 251)],
      'long-session.wav',
      { type: 'audio/wav' },
    );
    const plan = await createChunkEncryptionPlan(source);
    const encryptedParts: ArrayBuffer[] = [];
    for (let index = 0; index < plan.chunkCount; index += 1) {
      encryptedParts.push(await encryptFileChunk(source, plan, index));
    }
    const cipher = await new Blob(encryptedParts).arrayBuffer();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(cipher, {
        status: 200,
        headers: {
          'content-length': String(cipher.byteLength),
          'content-type': 'application/octet-stream',
        },
      }),
    );
    const descriptor: RemoteFileSharePayload = {
      roomId: '123456',
      objectId: '11111111-1111-4111-8111-111111111111',
      downloadUrl:
        'https://share.example.test/download/123456/11111111-1111-4111-8111-111111111111',
      keyB64: plan.keyB64,
      ivB64: plan.ivB64,
      name: source.name,
      mime: source.type,
      size: source.size,
      encryptedSize: cipher.byteLength,
      index: 0,
      sessionId: 7,
      expiresAt: Date.now() + 60_000,
      cryptoVersion: 2,
      chunkSize: plan.chunkSize,
      chunkCount: plan.chunkCount,
      tagBytes: plan.tagBytes,
    };
    const progress = vi.fn();

    const restored = await downloadRemoteFile(descriptor, progress);

    expect(restored.name).toBe(source.name);
    expect(restored.type).toBe(source.type);
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(
      new Uint8Array(await source.arrayBuffer()),
    );
    expect(progress).toHaveBeenLastCalledWith(1);
  });
});
