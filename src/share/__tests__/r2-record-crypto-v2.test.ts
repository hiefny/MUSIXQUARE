import { afterEach, describe, expect, it, vi } from 'vitest';

import { R2RecordCryptoV2 } from '../r2-record-crypto-v2.ts';

const OBJECT_A = '00000000-0000-4000-8000-000000000001';
const OBJECT_B = '00000000-0000-4000-8000-000000000002';
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const FIXED_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const FIXED_NONCE_B64 = 'AAECAwQFBgc=';
// Independently generated with node:crypto createCipheriv(), not this module.
const FIXED_AAD_HEX =
  '4d555349585155415245005232004145532d3235362d47434d005245434f5244000000000230303030303030302d303030302d343030302d383030302d303030303030303030303031000000000000000300800000000000010000000000000003';
const FIXED_CIPHERTEXT_HEX = '2806556b9825573060d2299fb8876aeb628f78';
const FIXED_INDEX_ONE_AAD_HEX =
  '4d555349585155415245005232004145532d3235362d47434d005245434f5244000000000230303030303030302d303030302d343030302d383030302d303030303030303030303031000000000080000300800000000000020000000100000003';
const FIXED_INDEX_ONE_CIPHERTEXT_HEX = 'e1e8a9f3af919374aafa80a369cdfeea2d533f';

function mutable(value: object): Record<PropertyKey, unknown> {
  return Object.fromEntries(Reflect.ownKeys(value).map((key) => [key, Reflect.get(value, key)]));
}

function corruptFinalBase64PadBits(value: string): string {
  const index = value.length - 2;
  const sextet = BASE64_ALPHABET.indexOf(value[index] ?? '');
  return `${value.slice(0, index)}${BASE64_ALPHABET[sextet | 1]}${value.slice(index + 1)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function bufferSourceBytes(value: BufferSource): Uint8Array {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  return new Uint8Array(value).slice();
}

async function readyEncryptor(size: number, objectId = OBJECT_A) {
  const encryptor = await R2RecordCryptoV2.createEncryptor(objectId, size);
  const secret = encryptor.takeSecretDescriptor();
  return { encryptor, secret };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R2 record crypto V2 descriptors', () => {
  it('separates redacted R2 metadata from the one-shot protected secret descriptor', async () => {
    expect(Object.hasOwn(R2RecordCryptoV2, 'create')).toBe(false);
    expect(Object.hasOwn(R2RecordCryptoV2, 'createEncryptorForTests')).toBe(false);
    const encryptor = await R2RecordCryptoV2.createEncryptor(OBJECT_A, 3);

    expect(Object.keys(encryptor.metadata)).toEqual([
      'formatVersion',
      'objectId',
      'plaintextSize',
      'recordSize',
      'recordCount',
      'noncePrefixB64',
    ]);
    expect(encryptor.metadata).toMatchObject({
      formatVersion: 2,
      objectId: OBJECT_A,
      plaintextSize: 3,
      recordSize: 8 * 1024 * 1024,
      recordCount: 1,
    });
    expect(Object.hasOwn(encryptor.metadata, 'keyB64')).toBe(false);
    expect(Object.getPrototypeOf(encryptor.metadata)).toBeNull();
    expect(Object.isFrozen(encryptor.metadata)).toBe(true);
    expect(Reflect.ownKeys(encryptor)).toEqual(['metadata']);
    expect(JSON.stringify(encryptor)).not.toContain('keyB64');
    const reflectedEncryptorConstructor = Object.getPrototypeOf(encryptor).constructor as new (
      ...args: unknown[]
    ) => unknown;
    expect(() => new reflectedEncryptorConstructor({})).toThrow(
      'R2_V2_INTERNAL_CONSTRUCTION_FORBIDDEN',
    );

    const secret = encryptor.takeSecretDescriptor();
    expect(Object.keys(secret)).toEqual([
      'formatVersion',
      'objectId',
      'plaintextSize',
      'recordSize',
      'recordCount',
      'noncePrefixB64',
      'keyB64',
    ]);
    expect(secret.keyB64).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
    expect(secret.noncePrefixB64).toMatch(/^[A-Za-z0-9+/]{11}=$/u);
    expect(Object.getPrototypeOf(secret)).toBeNull();
    expect(Object.isFrozen(secret)).toBe(true);
    expect(() => R2RecordCryptoV2.canonicalizeMetadata(secret)).toThrow('R2_V2_DESCRIPTOR_INVALID');
    expect(() => encryptor.takeSecretDescriptor()).toThrow('R2_V2_SECRET_ALREADY_TAKEN');

    const serializedEncryptor = JSON.stringify(encryptor);
    expect(serializedEncryptor).not.toContain('keyB64');
    expect(serializedEncryptor).not.toContain(secret.keyB64);
    const decryptor = await R2RecordCryptoV2.createDecryptor(secret);
    expect(Reflect.ownKeys(decryptor)).toEqual(['metadata']);
    expect(JSON.stringify(decryptor)).not.toContain('keyB64');
    expect(JSON.stringify(decryptor)).not.toContain(secret.keyB64);
    const reflectedDecryptorConstructor = Object.getPrototypeOf(decryptor).constructor as new (
      ...args: unknown[]
    ) => unknown;
    expect(() => new reflectedDecryptorConstructor({})).toThrow(
      'R2_V2_INTERNAL_CONSTRUCTION_FORBIDDEN',
    );
    decryptor.dispose();
    encryptor.dispose();
  });

  it('returns exact frozen data descriptors and rejects extras, symbols, and accessors', async () => {
    const { encryptor, secret } = await readyEncryptor(1);
    for (const value of [encryptor.metadata, secret]) {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        expect(descriptor).toMatchObject({
          configurable: false,
          enumerable: true,
          writable: false,
        });
        expect(descriptor.get).toBeUndefined();
        expect(descriptor.set).toBeUndefined();
      }
    }

    const metadataExtra = mutable(encryptor.metadata);
    Object.defineProperty(metadataExtra, 'extra', { value: true, enumerable: false });
    expect(() => R2RecordCryptoV2.canonicalizeMetadata(metadataExtra)).toThrow(
      'R2_V2_DESCRIPTOR_INVALID',
    );
    const metadataSymbol = mutable(encryptor.metadata);
    Object.defineProperty(metadataSymbol, Symbol('extra'), { value: true, enumerable: false });
    expect(() => R2RecordCryptoV2.canonicalizeMetadata(metadataSymbol)).toThrow(
      'R2_V2_DESCRIPTOR_INVALID',
    );
    const secretExtra = { ...mutable(secret), extra: true };
    expect(() => R2RecordCryptoV2.canonicalizeSecretDescriptor(secretExtra)).toThrow(
      'R2_V2_DESCRIPTOR_INVALID',
    );

    const getter = vi.fn(() => secret.keyB64);
    const accessor = mutable(secret);
    Object.defineProperty(accessor, 'keyB64', { enumerable: true, get: getter });
    expect(() => R2RecordCryptoV2.canonicalizeSecretDescriptor(accessor)).toThrow(
      'R2_V2_DESCRIPTOR_INVALID',
    );
    expect(getter).not.toHaveBeenCalled();
    encryptor.dispose();
  });

  it('detaches transparent Proxy values and rejects throwing or reentrant descriptor traps', async () => {
    const { encryptor, secret } = await readyEncryptor(1);
    const target = mutable(secret);
    const get = vi.fn(() => {
      throw new Error('get trap must not run');
    });
    const canonical = R2RecordCryptoV2.canonicalizeSecretDescriptor(new Proxy(target, { get }));
    expect(get).not.toHaveBeenCalled();
    target.objectId = OBJECT_B;
    expect(canonical.objectId).toBe(OBJECT_A);

    const throwing = new Proxy(mutable(secret), {
      ownKeys() {
        throw new Error('hostile ownKeys');
      },
    });
    expect(() => R2RecordCryptoV2.canonicalizeSecretDescriptor(throwing)).toThrow(
      'R2_V2_DESCRIPTOR_INVALID',
    );

    let nestedError: unknown;
    const reentrantTarget = mutable(encryptor.metadata);
    const reentrant = new Proxy(reentrantTarget, {
      getPrototypeOf(value) {
        try {
          R2RecordCryptoV2.canonicalizeMetadata(reentrantTarget);
        } catch (error) {
          nestedError = error;
        }
        return Reflect.getPrototypeOf(value);
      },
    });
    expect(() => R2RecordCryptoV2.canonicalizeMetadata(reentrant)).toThrow(
      'R2_V2_DESCRIPTOR_REENTRANT',
    );
    expect(nestedError).toMatchObject({ message: 'R2_V2_DESCRIPTOR_REENTRANT' });
    expect(R2RecordCryptoV2.canonicalizeMetadata(reentrantTarget).objectId).toBe(OBJECT_A);
    encryptor.dispose();
  });

  it('requires canonical padded base64 with exact 32-byte key and 8-byte nonce lengths', async () => {
    const { encryptor, secret } = await readyEncryptor(1);
    const invalidSecrets = [
      { keyB64: secret.keyB64.slice(0, -1) },
      { keyB64: ` ${secret.keyB64}` },
      { keyB64: `-${secret.keyB64.slice(1)}` },
      { keyB64: corruptFinalBase64PadBits(secret.keyB64) },
      { noncePrefixB64: secret.noncePrefixB64.slice(0, -1) },
      { noncePrefixB64: `${secret.noncePrefixB64}\n` },
      { noncePrefixB64: corruptFinalBase64PadBits(secret.noncePrefixB64) },
    ];
    for (const patch of invalidSecrets) {
      expect(() =>
        R2RecordCryptoV2.canonicalizeSecretDescriptor({ ...mutable(secret), ...patch }),
      ).toThrow('R2_V2_DESCRIPTOR_INVALID');
    }
    expect(() =>
      R2RecordCryptoV2.canonicalizeMetadata({
        ...mutable(encryptor.metadata),
        noncePrefixB64: secret.noncePrefixB64.slice(0, -1),
      }),
    ).toThrow('R2_V2_DESCRIPTOR_INVALID');
    encryptor.dispose();
  });

  it('preserves zero-byte, final-record, concatenated-range, and overflow contracts', async () => {
    const zero = await R2RecordCryptoV2.createEncryptor(OBJECT_A, 0);
    const zeroSecret = zero.takeSecretDescriptor();
    expect(zero.metadata.recordCount).toBe(0);
    expect(R2RecordCryptoV2.getCiphertextSize(zero.metadata)).toBe(0);
    await expect(zero.encryptRecord(0, new Uint8Array())).rejects.toThrow(
      'R2_V2_ENCRYPTION_COMPLETE',
    );
    const zeroDecryptor = await R2RecordCryptoV2.createDecryptor(zeroSecret);
    await expect(zeroDecryptor.decryptRecord(0, new Uint8Array())).rejects.toThrow(
      'R2_V2_RECORD_INDEX_INVALID',
    );
    zeroDecryptor.dispose();

    const recordSize = R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES;
    const ranged = await R2RecordCryptoV2.createEncryptor(OBJECT_A, recordSize * 2 + 5);
    const first = R2RecordCryptoV2.getRecordLayout(ranged.metadata, 0);
    const second = R2RecordCryptoV2.getRecordLayout(ranged.metadata, 1);
    const last = R2RecordCryptoV2.getRecordLayout(ranged.metadata, 2);
    expect(first).toEqual({
      recordIndex: 0,
      plaintextOffset: 0,
      plaintextLength: recordSize,
      ciphertextOffset: 0,
      ciphertextLength: recordSize + 16,
    });
    expect(second.ciphertextOffset).toBe(recordSize + 16);
    expect(last).toEqual({
      recordIndex: 2,
      plaintextOffset: recordSize * 2,
      plaintextLength: 5,
      ciphertextOffset: (recordSize + 16) * 2,
      ciphertextLength: 21,
    });
    expect(last.ciphertextOffset + last.ciphertextLength).toBe(
      R2RecordCryptoV2.getCiphertextSize(ranged.metadata),
    );
    ranged.dispose();

    const valid = mutable(zeroSecret);
    valid.plaintextSize = Number.MAX_SAFE_INTEGER;
    valid.recordCount = Math.ceil(Number.MAX_SAFE_INTEGER / recordSize);
    expect(() => R2RecordCryptoV2.canonicalizeSecretDescriptor(valid)).toThrow(
      'R2_V2_DESCRIPTOR_INVALID',
    );
    expect(() =>
      R2RecordCryptoV2.canonicalizeMetadata({
        ...mutable(zero.metadata),
        plaintextSize: recordSize,
        recordCount: 0x1_0000_0000,
      }),
    ).toThrow('R2_V2_DESCRIPTOR_INVALID');
    for (const index of [-1, -0, 0.5, 3, 0x1_0000_0000, Number.MAX_SAFE_INTEGER]) {
      expect(() => R2RecordCryptoV2.getRecordLayout(ranged.metadata, index)).toThrow(
        'R2_V2_RECORD_INDEX_INVALID',
      );
    }
  });
});

describe('R2 record crypto V2 encryption state machine', () => {
  it('keeps the same index retryable for every pre-SubtleCrypto input or abort error', async () => {
    const encryptor = await R2RecordCryptoV2.createEncryptor(OBJECT_A, 3);
    await expect(encryptor.encryptRecord(0, new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'R2_V2_SECRET_NOT_TAKEN',
    );
    encryptor.takeSecretDescriptor();
    await expect(encryptor.encryptRecord(1, new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'R2_V2_RECORD_SEQUENCE_INVALID',
    );
    await expect(encryptor.encryptRecord(0, new Uint8Array([1, 2]))).rejects.toThrow(
      'R2_V2_PLAINTEXT_LENGTH_INVALID',
    );

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      encryptor.encryptRecord(0, new Uint8Array([1, 2, 3]), preAborted.signal),
    ).rejects.toThrow('R2_V2_ABORTED');

    let proxyTrapCalls = 0;
    let proxyReentry: Promise<unknown> | undefined;
    const proxiedBytes = new Proxy(new Uint8Array([1, 2, 3]), {
      getPrototypeOf() {
        proxyTrapCalls += 1;
        proxyReentry = encryptor.encryptRecord(0, new Uint8Array([1, 2, 3]));
        throw new Error('instanceof/prototype trap must not run');
      },
      get() {
        proxyTrapCalls += 1;
        throw new Error('property trap must not run');
      },
    });
    await expect(
      encryptor.encryptRecord(0, proxiedBytes as unknown as Uint8Array<ArrayBuffer>),
    ).rejects.toThrow('R2_V2_RECORD_BYTES_INVALID');
    expect(proxyTrapCalls).toBe(0);
    expect(proxyReentry).toBeUndefined();

    if (typeof SharedArrayBuffer !== 'undefined') {
      const shared = new Uint8Array(new SharedArrayBuffer(3));
      await expect(
        encryptor.encryptRecord(0, shared as unknown as Uint8Array<ArrayBuffer>),
      ).rejects.toThrow('R2_V2_RECORD_BYTES_INVALID');
    }

    const lease = await encryptor.encryptRecord(0, new Uint8Array([1, 2, 3]));
    expect(lease.bytesForUpload().size).toBe(19);
    lease.acknowledgeUploaded();
  });

  it('holds one immutable ciphertext lease and advances only after acknowledgement', async () => {
    const recordSize = R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES;
    const { encryptor } = await readyEncryptor(recordSize + 3);
    const plaintext = new Uint8Array(recordSize);
    plaintext[0] = 1;
    plaintext[recordSize - 1] = 2;
    const firstLease = await encryptor.encryptRecord(0, plaintext);
    const firstBlob = firstLease.bytesForUpload();
    expect(firstLease.bytesForUpload()).toBe(firstBlob);
    expect(Object.isFrozen(firstBlob)).toBe(true);
    expect(firstBlob.size).toBe(recordSize + 16);

    const callerCopy = new Uint8Array(await firstBlob.arrayBuffer());
    const originalPrefix = callerCopy.slice(0, 64);
    callerCopy.fill(0);
    expect(new Uint8Array(await firstLease.bytesForUpload().arrayBuffer()).slice(0, 64)).toEqual(
      originalPrefix,
    );
    await expect(encryptor.encryptRecord(1, new Uint8Array([3, 4, 5]))).rejects.toThrow(
      'R2_V2_RECORD_LEASE_PENDING',
    );

    firstLease.acknowledgeUploaded();
    expect(() => firstLease.bytesForUpload()).toThrow('R2_V2_RECORD_LEASE_RELEASED');
    expect(() => firstLease.acknowledgeUploaded()).toThrow('R2_V2_RECORD_LEASE_RELEASED');
    await expect(encryptor.encryptRecord(1, new Uint8Array([3, 4]))).rejects.toThrow(
      'R2_V2_PLAINTEXT_LENGTH_INVALID',
    );
    await expect(encryptor.encryptRecord(1, new Uint8Array([3, 4, 5, 6]))).rejects.toThrow(
      'R2_V2_PLAINTEXT_LENGTH_INVALID',
    );
    const finalLease = await encryptor.encryptRecord(1, new Uint8Array([3, 4, 5]));
    expect(finalLease.bytesForUpload().size).toBe(19);
    finalLease.acknowledgeUploaded();
    await expect(encryptor.encryptRecord(2, new Uint8Array())).rejects.toThrow(
      'R2_V2_ENCRYPTION_COMPLETE',
    );
  });

  it('permanently poisons the encryptor after crypto reject, post-call abort, or abnormal output', async () => {
    const subtle = globalThis.crypto.subtle;

    const rejected = await readyEncryptor(1);
    vi.spyOn(subtle, 'encrypt').mockRejectedValueOnce(new Error('native failure'));
    await expect(rejected.encryptor.encryptRecord(0, new Uint8Array([1]))).rejects.toThrow(
      'R2_V2_RECORD_ENCRYPT_FAILED',
    );
    await expect(rejected.encryptor.encryptRecord(0, new Uint8Array([1]))).rejects.toThrow(
      'R2_V2_ENCRYPTOR_POISONED',
    );
    vi.mocked(subtle.encrypt).mockRestore();

    const aborted = await readyEncryptor(1);
    const controller = new AbortController();
    vi.spyOn(subtle, 'encrypt').mockImplementationOnce(async () => {
      controller.abort();
      return new ArrayBuffer(17);
    });
    await expect(
      aborted.encryptor.encryptRecord(0, new Uint8Array([1]), controller.signal),
    ).rejects.toThrow('R2_V2_ABORTED');
    await expect(aborted.encryptor.encryptRecord(0, new Uint8Array([1]))).rejects.toThrow(
      'R2_V2_ENCRYPTOR_POISONED',
    );
    vi.mocked(subtle.encrypt).mockRestore();

    const abortRace = await readyEncryptor(1);
    const racingController = new AbortController();
    vi.spyOn(subtle, 'encrypt').mockImplementationOnce(async () => {
      racingController.abort();
      throw new Error('native rejection must lose to abort');
    });
    await expect(
      abortRace.encryptor.encryptRecord(0, new Uint8Array([1]), racingController.signal),
    ).rejects.toThrow('R2_V2_ABORTED');
    await expect(abortRace.encryptor.encryptRecord(0, new Uint8Array([1]))).rejects.toThrow(
      'R2_V2_ENCRYPTOR_POISONED',
    );
    vi.mocked(subtle.encrypt).mockRestore();

    const abnormal = await readyEncryptor(1);
    vi.spyOn(subtle, 'encrypt').mockResolvedValueOnce(new ArrayBuffer(1));
    await expect(abnormal.encryptor.encryptRecord(0, new Uint8Array([1]))).rejects.toThrow(
      'R2_V2_CIPHERTEXT_LENGTH_INVALID',
    );
    await expect(abnormal.encryptor.encryptRecord(0, new Uint8Array([1]))).rejects.toThrow(
      'R2_V2_ENCRYPTOR_POISONED',
    );
  });

  it('rejects synchronous SubtleCrypto reentry without corrupting the outer operation or key', async () => {
    const { encryptor, secret } = await readyEncryptor(2);
    const plaintext = new Uint8Array([4, 2]);
    const subtle = globalThis.crypto.subtle;
    const nativeEncrypt = subtle.encrypt.bind(subtle);
    let reentry: Promise<unknown> | undefined;
    vi.spyOn(subtle, 'encrypt').mockImplementation((algorithm, key, data) => {
      reentry = encryptor.encryptRecord(0, plaintext);
      void reentry.catch(() => undefined);
      return nativeEncrypt(algorithm, key, data);
    });

    const lease = await encryptor.encryptRecord(0, plaintext);
    await expect(reentry).rejects.toThrow('R2_V2_RECORD_OPERATION_IN_PROGRESS');
    vi.mocked(subtle.encrypt).mockRestore();
    const ciphertext = await lease.bytesForUpload().arrayBuffer();
    const decryptor = await R2RecordCryptoV2.createDecryptor(secret);
    await expect(decryptor.decryptRecord(0, ciphertext)).resolves.toEqual(plaintext);
    lease.acknowledgeUploaded();
    decryptor.dispose();
  });

  it('disposes key, nonce, and cached lease state deterministically', async () => {
    const beforeSecret = await R2RecordCryptoV2.createEncryptor(OBJECT_A, 1);
    beforeSecret.dispose();
    beforeSecret.dispose();
    expect(() => beforeSecret.takeSecretDescriptor()).toThrow('R2_V2_ENCRYPTOR_DISPOSED');
    await expect(beforeSecret.encryptRecord(0, new Uint8Array([1]))).rejects.toThrow(
      'R2_V2_ENCRYPTOR_DISPOSED',
    );

    const pending = await readyEncryptor(1);
    const lease = await pending.encryptor.encryptRecord(0, new Uint8Array([1]));
    pending.encryptor.dispose();
    expect(() => lease.bytesForUpload()).toThrow('R2_V2_RECORD_LEASE_RELEASED');
    expect(() => lease.acknowledgeUploaded()).toThrow('R2_V2_RECORD_LEASE_RELEASED');
    await expect(pending.encryptor.encryptRecord(0, new Uint8Array([1]))).rejects.toThrow(
      'R2_V2_ENCRYPTOR_DISPOSED',
    );

    const duringCrypto = await readyEncryptor(1);
    vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementationOnce(async () => {
      duringCrypto.encryptor.dispose();
      return new ArrayBuffer(17);
    });
    await expect(duringCrypto.encryptor.encryptRecord(0, new Uint8Array([1]))).rejects.toThrow(
      'R2_V2_ENCRYPTOR_DISPOSED',
    );
  });

  it('decrypts the independent known-answer vector with the exact AAD and IV golden', async () => {
    const fixedSecret = {
      formatVersion: 2,
      objectId: OBJECT_A,
      plaintextSize: 3,
      recordSize: R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES,
      recordCount: 1,
      noncePrefixB64: FIXED_NONCE_B64,
      keyB64: FIXED_KEY_B64,
    };
    const decryptor = await R2RecordCryptoV2.createDecryptor(fixedSecret);
    const subtle = globalThis.crypto.subtle;
    const nativeDecrypt = subtle.decrypt.bind(subtle);
    let aadHex = '';
    let ivHex = '';
    vi.spyOn(subtle, 'decrypt').mockImplementation((algorithm, key, data) => {
      const aes = algorithm as AesGcmParams;
      aadHex = bytesToHex(bufferSourceBytes(aes.additionalData!));
      ivHex = bytesToHex(bufferSourceBytes(aes.iv));
      return nativeDecrypt(algorithm, key, data);
    });

    const plaintext = await decryptor.decryptRecord(0, hexToBytes(FIXED_CIPHERTEXT_HEX));
    expect(aadHex).toBe(FIXED_AAD_HEX);
    expect(ivHex).toBe('000102030405060700000000');
    expect(plaintext).toEqual(new Uint8Array([1, 2, 3]));
    decryptor.dispose();
  });

  it('pins the nonzero record index to unsigned 32-bit big-endian IV and AAD encoding', async () => {
    const recordSize = R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES;
    const decryptor = await R2RecordCryptoV2.createDecryptor({
      formatVersion: 2,
      objectId: OBJECT_A,
      plaintextSize: recordSize + 3,
      recordSize,
      recordCount: 2,
      noncePrefixB64: FIXED_NONCE_B64,
      keyB64: FIXED_KEY_B64,
    });
    const subtle = globalThis.crypto.subtle;
    const nativeDecrypt = subtle.decrypt.bind(subtle);
    let aadHex = '';
    let ivHex = '';
    vi.spyOn(subtle, 'decrypt').mockImplementation((algorithm, key, data) => {
      const aes = algorithm as AesGcmParams;
      aadHex = bytesToHex(bufferSourceBytes(aes.additionalData!));
      ivHex = bytesToHex(bufferSourceBytes(aes.iv));
      return nativeDecrypt(algorithm, key, data);
    });

    const plaintext = await decryptor.decryptRecord(1, hexToBytes(FIXED_INDEX_ONE_CIPHERTEXT_HEX));
    expect(aadHex).toBe(FIXED_INDEX_ONE_AAD_HEX);
    expect(ivHex).toBe('000102030405060700000001');
    expect(plaintext).toEqual(new Uint8Array([1, 2, 3]));
    decryptor.dispose();
  });
});

describe('R2 record crypto V2 decryption', () => {
  it('rejects tamper, wrong key/object/index/total metadata, truncation, and extra bytes', async () => {
    const small = await readyEncryptor(4);
    const smallLease = await small.encryptor.encryptRecord(0, new Uint8Array([1, 2, 3, 4]));
    const encrypted = new Uint8Array(await smallLease.bytesForUpload().arrayBuffer());
    const decryptor = await R2RecordCryptoV2.createDecryptor(small.secret);

    const tampered = encrypted.slice();
    tampered[0] ^= 0x80;
    await expect(decryptor.decryptRecord(0, tampered)).rejects.toThrow('R2_V2_RECORD_AUTH_FAILED');
    await expect(decryptor.decryptRecord(0, encrypted.slice(0, -1))).rejects.toThrow(
      'R2_V2_CIPHERTEXT_LENGTH_INVALID',
    );
    const extended = new Uint8Array(encrypted.byteLength + 1);
    extended.set(encrypted);
    await expect(decryptor.decryptRecord(0, extended)).rejects.toThrow(
      'R2_V2_CIPHERTEXT_LENGTH_INVALID',
    );

    const other = await readyEncryptor(4, OBJECT_B);
    const wrongKey = await R2RecordCryptoV2.createDecryptor({
      ...mutable(small.secret),
      keyB64: other.secret.keyB64,
    });
    const wrongObject = await R2RecordCryptoV2.createDecryptor({
      ...mutable(small.secret),
      objectId: OBJECT_B,
    });
    await expect(wrongKey.decryptRecord(0, encrypted)).rejects.toThrow('R2_V2_RECORD_AUTH_FAILED');
    await expect(wrongObject.decryptRecord(0, encrypted)).rejects.toThrow(
      'R2_V2_RECORD_AUTH_FAILED',
    );

    const recordSize = R2RecordCryptoV2.RECORD_PLAINTEXT_BYTES;
    const indexed = await readyEncryptor(recordSize * 2);
    const indexedLease = await indexed.encryptor.encryptRecord(0, new Uint8Array(recordSize));
    const fullCiphertext = await indexedLease.bytesForUpload().arrayBuffer();
    const indexedDecryptor = await R2RecordCryptoV2.createDecryptor(indexed.secret);
    await expect(indexedDecryptor.decryptRecord(1, fullCiphertext)).rejects.toThrow(
      'R2_V2_RECORD_AUTH_FAILED',
    );
    const wrongTotal = await R2RecordCryptoV2.createDecryptor({
      ...mutable(indexed.secret),
      plaintextSize: recordSize * 2 - 1,
      recordCount: 2,
    });
    await expect(wrongTotal.decryptRecord(0, fullCiphertext)).rejects.toThrow(
      'R2_V2_RECORD_AUTH_FAILED',
    );

    for (const value of [decryptor, wrongKey, wrongObject, indexedDecryptor, wrongTotal]) {
      value.dispose();
    }
    small.encryptor.dispose();
    other.encryptor.dispose();
    indexed.encryptor.dispose();
  });

  it('gives abort priority, blocks synchronous reentry, remains usable, and disposes', async () => {
    const { encryptor, secret } = await readyEncryptor(2);
    const lease = await encryptor.encryptRecord(0, new Uint8Array([4, 2]));
    const ciphertext = await lease.bytesForUpload().arrayBuffer();
    const decryptor = await R2RecordCryptoV2.createDecryptor(secret);
    const subtle = globalThis.crypto.subtle;
    const nativeDecrypt = subtle.decrypt.bind(subtle);
    let reentry: Promise<unknown> | undefined;
    vi.spyOn(subtle, 'decrypt').mockImplementation((algorithm, key, data) => {
      reentry = decryptor.decryptRecord(0, ciphertext);
      void reentry.catch(() => undefined);
      return nativeDecrypt(algorithm, key, data);
    });
    await expect(decryptor.decryptRecord(0, ciphertext)).resolves.toEqual(new Uint8Array([4, 2]));
    await expect(reentry).rejects.toThrow('R2_V2_RECORD_OPERATION_IN_PROGRESS');
    vi.mocked(subtle.decrypt).mockRestore();

    const controller = new AbortController();
    vi.spyOn(subtle, 'decrypt').mockImplementationOnce(async () => {
      controller.abort();
      throw new Error('native auth failure must lose to abort');
    });
    await expect(decryptor.decryptRecord(0, ciphertext, controller.signal)).rejects.toThrow(
      'R2_V2_ABORTED',
    );
    vi.mocked(subtle.decrypt).mockRestore();
    await expect(decryptor.decryptRecord(0, ciphertext)).resolves.toEqual(new Uint8Array([4, 2]));

    decryptor.dispose();
    decryptor.dispose();
    await expect(decryptor.decryptRecord(0, ciphertext)).rejects.toThrow(
      'R2_V2_DECRYPTOR_DISPOSED',
    );
    encryptor.dispose();
  });

  it('checks abort before and after key import without returning a half-created context', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(R2RecordCryptoV2.createEncryptor(OBJECT_A, 1, preAborted.signal)).rejects.toThrow(
      'R2_V2_ABORTED',
    );

    const subtle = globalThis.crypto.subtle;
    const nativeImport = subtle.importKey.bind(subtle);
    const afterEncryptImport = new AbortController();
    vi.spyOn(subtle, 'importKey').mockImplementation(
      async (format, keyData, algorithm, extractable, usages) => {
        const key = await nativeImport(format, keyData, algorithm, extractable, usages);
        afterEncryptImport.abort();
        return key;
      },
    );
    await expect(
      R2RecordCryptoV2.createEncryptor(OBJECT_A, 1, afterEncryptImport.signal),
    ).rejects.toThrow('R2_V2_ABORTED');
    vi.mocked(subtle.importKey).mockRestore();

    const prepared = await readyEncryptor(1);
    const afterImport = new AbortController();
    vi.spyOn(subtle, 'importKey').mockImplementation(
      async (format, keyData, algorithm, extractable, usages) => {
        const key = await nativeImport(format, keyData, algorithm, extractable, usages);
        afterImport.abort();
        return key;
      },
    );
    await expect(
      R2RecordCryptoV2.createDecryptor(prepared.secret, afterImport.signal),
    ).rejects.toThrow('R2_V2_ABORTED');
    vi.mocked(subtle.importKey).mockRestore();
    prepared.encryptor.dispose();
  });
});
