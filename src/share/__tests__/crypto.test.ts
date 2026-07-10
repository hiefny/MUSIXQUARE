import { describe, expect, it } from 'vitest';
import {
  createChunkEncryptionPlan,
  decryptChunkedStreamToMemory,
  decryptCipherChunkForTests,
  encryptFileChunk,
} from '../crypto.ts';

async function bytes(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

describe('remote share chunk crypto', () => {
  it('encrypts and authenticates one bounded record at a time', async () => {
    const plain = new Uint8Array(8 * 1024 * 1024 + 123);
    for (let index = 0; index < plain.length; index += 4093) plain[index] = index % 251;
    const source = new File([plain], 'session.wav', { type: 'audio/wav' });
    const plan = await createChunkEncryptionPlan(source);

    expect(plan.cryptoVersion).toBe(2);
    expect(plan.chunkCount).toBe(2);
    expect(plan.encryptedSize).toBe(source.size + 32);

    const parts: ArrayBuffer[] = [];
    for (let index = 0; index < plan.chunkCount; index += 1) {
      parts.push(await encryptFileChunk(source, plan, index));
    }
    const cipher = new Blob(parts);
    expect(cipher.size).toBe(plan.encryptedSize);

    const restored = await decryptChunkedStreamToMemory({
      body: cipher.stream(),
      keyB64: plan.keyB64,
      noncePrefixB64: plan.ivB64,
      plainSize: plan.plainSize,
      encryptedSize: plan.encryptedSize,
      chunkSize: plan.chunkSize,
      chunkCount: plan.chunkCount,
      tagBytes: plan.tagBytes,
      name: source.name,
      mime: source.type,
    });
    expect(restored.name).toBe(source.name);
    expect(restored.type).toBe(source.type);
    expect(await bytes(restored)).toEqual(await bytes(source));
  }, 60_000);

  it('can decrypt an individual record for range playback', async () => {
    const source = new File([new Uint8Array(90_000).map((_, i) => i % 251)], 'range.wav');
    const plan = await createChunkEncryptionPlan(source);
    const cipher = await encryptFileChunk(source, plan, 0);
    const plain = await decryptCipherChunkForTests(cipher, {
      keyB64: plan.keyB64,
      noncePrefixB64: plan.ivB64,
      plainSize: plan.plainSize,
      encryptedSize: plan.encryptedSize,
      chunkSize: plan.chunkSize,
      chunkCount: plan.chunkCount,
      tagBytes: plan.tagBytes,
      index: 0,
    });
    expect(new Uint8Array(plain)).toEqual(new Uint8Array(await source.arrayBuffer()));
  });

  it('rejects tampered ciphertext', async () => {
    const source = new File([new Uint8Array([9, 8, 7, 6])], 'tamper.wav');
    const plan = await createChunkEncryptionPlan(source);
    const corrupted = new Uint8Array(await encryptFileChunk(source, plan, 0));
    corrupted[0] ^= 0xff;

    await expect(
      decryptCipherChunkForTests(corrupted, {
        keyB64: plan.keyB64,
        noncePrefixB64: plan.ivB64,
        plainSize: plan.plainSize,
        encryptedSize: plan.encryptedSize,
        chunkSize: plan.chunkSize,
        chunkCount: plan.chunkCount,
        tagBytes: plan.tagBytes,
        index: 0,
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  it('rejects inconsistent metadata before reading a response', async () => {
    await expect(
      decryptChunkedStreamToMemory({
        body: new Blob([new Uint8Array(32)]).stream(),
        keyB64: 'AA==',
        noncePrefixB64: 'AA==',
        plainSize: 4,
        encryptedSize: 32,
        chunkSize: 8 * 1024 * 1024,
        chunkCount: 2,
        name: 'bad.wav',
        mime: 'audio/wav',
      }),
    ).rejects.toThrow('REMOTE_SHARE_CRYPTO_METADATA_INVALID');
  });
});
