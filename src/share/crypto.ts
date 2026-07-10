/**
 * MUSIXQUARE remote share crypto helpers.
 *
 * Encrypts local files before they leave the host browser. The AES key is
 * delivered over WebRTC, not through object storage.
 */

interface RemoteEncryptionResult {
  encryptedBlob: Blob;
  keyB64: string;
  ivB64: string;
}

const AES_ALGO = 'AES-GCM';
const AES_BITS = 256;
const IV_BYTES = 12;
const B64_CHUNK = 0x8000;

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    const chunk = bytes.subarray(i, i + B64_CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function encryptFile(file: Blob): Promise<RemoteEncryptionResult> {
  const key = await crypto.subtle.generateKey({ name: AES_ALGO, length: AES_BITS }, true, [
    'encrypt',
    'decrypt',
  ]);
  const iv = new Uint8Array(new ArrayBuffer(IV_BYTES));
  crypto.getRandomValues(iv);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const plain = await file.arrayBuffer();
  const encrypted = await crypto.subtle.encrypt({ name: AES_ALGO, iv }, key, plain);

  return {
    encryptedBlob: new Blob([encrypted], { type: 'application/octet-stream' }),
    keyB64: bytesToBase64(rawKey),
    ivB64: bytesToBase64(iv),
  };
}

export async function decryptToFile(
  encrypted: ArrayBuffer,
  keyB64: string,
  ivB64: string,
  name: string,
  mime: string,
  lastModified = Date.now(),
): Promise<File> {
  const keyBytes = base64ToBytes(keyB64);
  const iv = base64ToBytes(ivB64);
  const key = await crypto.subtle.importKey(
    'raw',
    copyToArrayBuffer(keyBytes),
    { name: AES_ALGO },
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt(
    { name: AES_ALGO, iv: copyToArrayBuffer(iv) },
    key,
    encrypted,
  );
  return new File([plain], name, { type: mime || 'application/octet-stream', lastModified });
}
