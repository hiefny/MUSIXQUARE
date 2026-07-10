/**
 * Minimal MD5 for R2 UploadPart Content-MD5 binding.
 *
 * MD5 is used only as the S3 transport checksum supported by R2. File
 * confidentiality and authenticity remain AES-256-GCM. Processing references
 * the existing ciphertext ArrayBuffer and allocates only one 64-byte block.
 */

const SHIFTS = new Uint8Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const CONSTANTS = new Int32Array(
  Array.from({ length: 64 }, (_, index) =>
    Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000),
  ),
);
const YIELD_AFTER_BYTES = 4 * 1024 * 1024;

function rotateLeft(value: number, count: number): number {
  return (value << count) | (value >>> (32 - count));
}

function writeLength(block: Uint8Array, offset: number, byteLength: number): void {
  const bitLengthLow = (byteLength << 3) >>> 0;
  const bitLengthHigh = Math.floor(byteLength / 0x2000_0000) >>> 0;
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  view.setUint32(offset, bitLengthLow, true);
  view.setUint32(offset + 4, bitLengthHigh, true);
}

function processBlock(words: Uint32Array, state: Int32Array): void {
  let a = state[0] as number;
  let b = state[1] as number;
  let c = state[2] as number;
  let d = state[3] as number;

  for (let index = 0; index < 64; index += 1) {
    let f: number;
    let wordIndex: number;
    if (index < 16) {
      f = (b & c) | (~b & d);
      wordIndex = index;
    } else if (index < 32) {
      f = (d & b) | (~d & c);
      wordIndex = (5 * index + 1) & 15;
    } else if (index < 48) {
      f = b ^ c ^ d;
      wordIndex = (3 * index + 5) & 15;
    } else {
      f = c ^ (b | ~d);
      wordIndex = (7 * index) & 15;
    }
    const previousD = d;
    d = c;
    c = b;
    const sum = (a + f + (CONSTANTS[index] as number) + (words[wordIndex] as number)) | 0;
    b = (b + rotateLeft(sum, SHIFTS[index] as number)) | 0;
    a = previousD;
  }

  state[0] = ((state[0] as number) + a) | 0;
  state[1] = ((state[1] as number) + b) | 0;
  state[2] = ((state[2] as number) + c) | 0;
  state[3] = ((state[3] as number) + d) | 0;
}

function wordsFromBlock(bytes: Uint8Array, offset: number, scratch: Uint32Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 64);
  for (let index = 0; index < 16; index += 1) {
    scratch[index] = view.getUint32(index * 4, true);
  }
}

function yieldToBrowser(): Promise<void> {
  const scheduler = (
    globalThis as typeof globalThis & {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function digestBase64(state: Int32Array): string {
  const digest = new Uint8Array(16);
  const view = new DataView(digest.buffer);
  for (let index = 0; index < state.length; index += 1) {
    view.setUint32(index * 4, state[index] as number, true);
  }
  return btoa(String.fromCharCode(...digest));
}

/** Return the canonical base64 Content-MD5 value for one encrypted part. */
export async function contentMd5Base64(
  input: ArrayBuffer | Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const state = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const words = new Uint32Array(16);
  const completeBytes = bytes.byteLength - (bytes.byteLength % 64);
  let nextYield = YIELD_AFTER_BYTES;

  for (let offset = 0; offset < completeBytes; offset += 64) {
    wordsFromBlock(bytes, offset, words);
    processBlock(words, state);
    if (offset + 64 >= nextYield && offset + 64 < completeBytes) {
      if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');
      await yieldToBrowser();
      nextYield += YIELD_AFTER_BYTES;
    }
  }
  if (signal?.aborted) throw new Error('REMOTE_SHARE_ABORTED');

  const remainder = bytes.byteLength - completeBytes;
  const finalBytes = remainder < 56 ? 64 : 128;
  const finalBlock = new Uint8Array(finalBytes);
  finalBlock.set(bytes.subarray(completeBytes), 0);
  finalBlock[remainder] = 0x80;
  writeLength(finalBlock, finalBytes - 8, bytes.byteLength);
  for (let offset = 0; offset < finalBytes; offset += 64) {
    wordsFromBlock(finalBlock, offset, words);
    processBlock(words, state);
  }
  return digestBase64(state);
}
