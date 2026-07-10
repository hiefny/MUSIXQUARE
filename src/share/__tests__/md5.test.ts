import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentMd5Base64 } from '../md5.ts';

function expected(value: Uint8Array): string {
  return createHash('md5').update(value).digest('base64');
}

describe('R2 Content-MD5', () => {
  it.each(['', 'a', 'abc', 'message digest'])('matches the RFC vector for %j', async (value) => {
    const bytes = new TextEncoder().encode(value);
    await expect(contentMd5Base64(bytes)).resolves.toBe(expected(bytes));
  });

  it('matches Node across padding boundaries and one full crypto part', async () => {
    for (const length of [55, 56, 63, 64, 65, 8 * 1024 * 1024 + 16]) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 4093) bytes[index] = index % 251;
      await expect(contentMd5Base64(bytes)).resolves.toBe(expected(bytes));
    }
  }, 30_000);

  it('honors cancellation before hashing', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(contentMd5Base64(new Uint8Array(64), abort.signal)).rejects.toThrow(
      'REMOTE_SHARE_ABORTED',
    );
  });
});
