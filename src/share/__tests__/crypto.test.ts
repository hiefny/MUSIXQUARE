/** @vitest-environment jsdom */

import { webcrypto } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decryptR2WholeBlobV2,
  encryptR2WholeBlobV2,
  type R2WholeBlobDecryptionV2Options,
} from '../crypto.ts';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decryptOptions(
  encryptedSize: number,
  overrides: Partial<R2WholeBlobDecryptionV2Options> = {},
): R2WholeBlobDecryptionV2Options {
  return {
    expectedPlaintextSize: 4,
    expectedEncryptedSize: encryptedSize,
    keyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    ivB64: 'AAAAAAAAAAAAAAAA',
    name: 'tone.wav',
    mime: 'audio/wav',
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('R2 whole-Blob V2 crypto', () => {
  it('round-trips exact AES-256-GCM material and creates a deterministic File', async () => {
    const plaintext = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' });
    const encrypted = await encryptR2WholeBlobV2(plaintext);

    expect(encrypted.plaintextSize).toBe(4);
    expect(encrypted.encryptedSize).toBe(20);
    expect(encrypted.encryptedBlob.size).toBe(20);
    expect(encrypted.keyB64).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
    expect(encrypted.ivB64).toMatch(/^[A-Za-z0-9+/]{16}$/u);
    expect(Object.getPrototypeOf(encrypted)).toBeNull();
    expect(Object.isFrozen(encrypted)).toBe(true);

    const ciphertext = await encrypted.encryptedBlob.arrayBuffer();
    const file = await decryptR2WholeBlobV2(
      ciphertext,
      decryptOptions(encrypted.encryptedSize, {
        keyB64: encrypted.keyB64,
        ivB64: encrypted.ivB64,
      }),
    );
    expect(file.name).toBe('tone.wav');
    expect(file.type).toBe('audio/wav');
    expect(file.lastModified).toBe(0);
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it.each(['tamper', 'wrong-key', 'wrong-iv'] as const)(
    'rejects authenticated decryption after %s',
    async (kind) => {
      const encrypted = await encryptR2WholeBlobV2(new Blob([new Uint8Array([1, 2, 3, 4])]));
      const ciphertext = new Uint8Array(await encrypted.encryptedBlob.arrayBuffer());
      const options = decryptOptions(encrypted.encryptedSize, {
        keyB64: kind === 'wrong-key' ? bytesToBase64(new Uint8Array(32).fill(7)) : encrypted.keyB64,
        ivB64: kind === 'wrong-iv' ? bytesToBase64(new Uint8Array(12).fill(9)) : encrypted.ivB64,
      });
      if (kind === 'tamper') ciphertext[0] = (ciphertext[0] ?? 0) ^ 0x80;

      await expect(decryptR2WholeBlobV2(ciphertext.buffer, options)).rejects.toThrow(
        'REMOTE_SHARE_V2_DECRYPT_FAILED',
      );
    },
  );

  it('rejects noncanonical or wrong-sized key/IV material before WebCrypto import', async () => {
    const encrypted = await encryptR2WholeBlobV2(new Blob([new Uint8Array([1, 2, 3, 4])]));
    const ciphertext = await encrypted.encryptedBlob.arrayBuffer();
    const canonicalZeroKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const noncanonicalZeroKey = `${canonicalZeroKey.slice(0, -2)}B=`;
    expect(atob(noncanonicalZeroKey)).toBe(atob(canonicalZeroKey));

    await expect(
      decryptR2WholeBlobV2(
        ciphertext,
        decryptOptions(encrypted.encryptedSize, {
          keyB64: noncanonicalZeroKey,
          ivB64: encrypted.ivB64,
        }),
      ),
    ).rejects.toThrow('REMOTE_SHARE_V2_KEY_INVALID');
    await expect(
      decryptR2WholeBlobV2(
        ciphertext,
        decryptOptions(encrypted.encryptedSize, {
          keyB64: encrypted.keyB64,
          ivB64: bytesToBase64(new Uint8Array(11)),
        }),
      ),
    ).rejects.toThrow('REMOTE_SHARE_V2_IV_INVALID');
  });

  it('rejects declared ciphertext/tag mismatches before decryption', async () => {
    const encrypted = await encryptR2WholeBlobV2(new Blob([new Uint8Array([1, 2, 3, 4])]));
    const ciphertext = await encrypted.encryptedBlob.arrayBuffer();

    await expect(
      decryptR2WholeBlobV2(
        ciphertext,
        decryptOptions(encrypted.encryptedSize, {
          expectedEncryptedSize: encrypted.encryptedSize - 1,
          keyB64: encrypted.keyB64,
          ivB64: encrypted.ivB64,
        }),
      ),
    ).rejects.toThrow('REMOTE_SHARE_V2_ENCRYPTED_SIZE_MISMATCH');
  });

  it('discards encryption completed after its owning signal aborts', async () => {
    const controller = new AbortController();
    const originalEncrypt = webcrypto.subtle.encrypt.bind(webcrypto.subtle);
    vi.spyOn(webcrypto.subtle, 'encrypt').mockImplementation(async (algorithm, key, data) => {
      const result = await originalEncrypt(algorithm, key, data);
      controller.abort();
      return result;
    });

    await expect(
      encryptR2WholeBlobV2(new Blob([new Uint8Array([1, 2, 3, 4])]), controller.signal),
    ).rejects.toThrow('REMOTE_SHARE_ABORTED');
  });

  it('discards decryption completed after its owning signal aborts', async () => {
    const encrypted = await encryptR2WholeBlobV2(new Blob([new Uint8Array([1, 2, 3, 4])]));
    const ciphertext = await encrypted.encryptedBlob.arrayBuffer();
    const controller = new AbortController();
    const originalDecrypt = webcrypto.subtle.decrypt.bind(webcrypto.subtle);
    vi.spyOn(webcrypto.subtle, 'decrypt').mockImplementation(async (algorithm, key, data) => {
      const result = await originalDecrypt(algorithm, key, data);
      controller.abort();
      return result;
    });

    await expect(
      decryptR2WholeBlobV2(
        ciphertext,
        decryptOptions(encrypted.encryptedSize, {
          keyB64: encrypted.keyB64,
          ivB64: encrypted.ivB64,
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow('REMOTE_SHARE_ABORTED');
  });
});
