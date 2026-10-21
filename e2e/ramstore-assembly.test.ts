import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const PREFIX = '/__ramstore-assembly-probe/';
// The probe is dynamically served JavaScript. Keep its browser-facing contract
// local so this E2E config does not import app-wide Window augmentations.
interface Probe {
  ramStart(
    row: string,
    name: string,
    preload: boolean,
    sid: number,
    chunkSize: number,
    resume: boolean,
  ): { ok: boolean };
  ramWrite(
    row: string,
    name: string,
    preload: boolean,
    sid: number,
    index: number,
    bytes: Uint8Array,
  ): { ok: boolean };
  ramEnd(
    row: string,
    name: string,
    preload: boolean,
    sid: number,
    size: number,
    count: number,
  ): { blob: Blob | null; reason?: string };
  ramContiguousCount(row: string, preload: boolean, sid: number): number;
  ramReadChunk(
    row: string,
    preload: boolean,
    sid: number,
    index: number,
  ): Promise<Uint8Array | null>;
  ramReadBlob(row: string, preload: boolean, sid: number): Blob | null;
  admitIncomingStoredFile(options: {
    queueItemId: string;
    filename: string;
    isPreload: boolean;
    sessionId: number;
    totalSize: number;
  }): void;
  readStoredFile(row: string, name: string, preload: boolean, sid: number): Promise<File | null>;
  retainStoredFileAdmission(
    row: string,
    name: string,
    preload: boolean,
    sid: number,
    file: Blob,
  ): boolean;
  promoteStoredFileAdmission(row: string, name: string, sid: number, file: Blob): boolean;
  storedFileAdmissionStatsForTests(): Array<{ owner: string; isPreload: boolean }>;
  resetAllStoredFiles(): void;
}
let bundle = '';

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents:
        "export * from './src/storage/ramstore.ts'; export { admitIncomingStoredFile, readStoredFile, retainStoredFileAdmission, promoteStoredFileAdmission, storedFileAdmissionStatsForTests, resetAllStoredFiles } from './src/storage/storage.ts';",
      resolveDir: resolve('.'),
      sourcefile: 'ramstore-probe.ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    // The storage adapter imports UI helpers; this module probe never renders them.
    loader: { '.css': 'empty' },
    define: { 'import.meta.env': '{"PROD":true}' },
  });
  bundle = result.outputFiles[0]!.text;
});

async function openProbe(page: Page): Promise<void> {
  await page.route(`**${PREFIX}**`, async (route) => {
    const script = route.request().url().endsWith('probe.js');
    await route.fulfill({
      contentType: script ? 'text/javascript' : 'text/html',
      body: script ? bundle : '<!doctype html><title>Native RAM assembly regression</title>',
    });
  });
  await page.goto(`${PREFIX}index.html`);
}

function expectedHash(size: number): string {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + Math.floor(i / 251)) & 255;
  return createHash('sha256').update(bytes).digest('hex');
}

test('native chunk snapshots survive reordering, replacement, resume and random reads', async ({
  page,
}) => {
  await openProbe(page);
  const size = 4 * 1024 * 1024 + 117;
  const result = await page.evaluate(
    async ({ prefix, size }) => {
      const store = (await import(`${prefix}probe.js`)) as Probe;
      const chunkSize = 65536;
      const count = Math.ceil(size / chunkSize);
      const makeChunk = (index: number): Uint8Array<ArrayBuffer> => {
        const offset = index * chunkSize;
        const bytes = new Uint8Array(Math.min(chunkSize, size - offset));
        for (let i = 0; i < bytes.length; i++)
          bytes[i] = ((offset + i) * 31 + Math.floor((offset + i) / 251)) & 255;
        return bytes;
      };
      const digest = async (blob: Blob): Promise<string> =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('');
      store.ramStart('row-a', 'native.wav', true, 101, chunkSize, false);
      const write = (index: number): boolean => {
        const bytes = makeChunk(index);
        const ok = store.ramWrite('row-a', 'native.wav', true, 101, index, bytes).ok;
        bytes.fill(0); // A caller can reuse its receive buffer immediately.
        return ok;
      };
      const accepted = [write(2), write(0)];
      const prefixBefore = store.ramContiguousCount('row-a', true, 101);
      const resume = store.ramStart('row-a', 'native.wav', true, 101, chunkSize, true).ok;
      accepted.push(write(1), write(2));
      const prefixAfter = store.ramContiguousCount('row-a', true, 101);
      const live = await store.ramReadChunk('row-a', true, 101, 2);
      const expectedLive = makeChunk(2);
      const liveMatches = live?.every((byte, i) => byte === expectedLive[i]);
      for (let index = count - 1; index >= 3; index--) accepted.push(write(index));

      // The proxy observes arguments but delegates every allocation to native Blob.
      const NativeBlob = Blob;
      const finalCalls: Array<{ blobs: number; buffers: number; views: number; bytes: number }> =
        [];
      globalThis.Blob = new Proxy(NativeBlob, {
        construct(target, args, newTarget) {
          const parts = (args[0] ?? []) as BlobPart[];
          finalCalls.push({
            blobs: parts.filter((part) => part instanceof NativeBlob).length,
            buffers: parts.filter((part) => part instanceof ArrayBuffer).length,
            views: parts.filter((part) => ArrayBuffer.isView(part)).length,
            bytes: parts.reduce(
              (sum, part) => sum + (part instanceof NativeBlob ? part.size : 0),
              0,
            ),
          });
          return Reflect.construct(target, args, newTarget) as Blob;
        },
      });
      const { blob } = store.ramEnd('row-a', 'native.wav', true, 101, size, count);
      globalThis.Blob = NativeBlob;
      if (!blob) throw new Error('Finalization failed');
      const ranges = [
        [65500, 65650],
        [size - 151, size],
        [1_990_123, 2_100_456],
      ];
      const randomReads = await Promise.all(
        ranges.map(async ([start, end]) => {
          const bytes = new Uint8Array(await blob.slice(start!, end!).arrayBuffer());
          return bytes.every((byte, i) => {
            const offset = start! + i;
            return byte === ((offset * 31 + Math.floor(offset / 251)) & 255);
          });
        }),
      );
      const finalizedTail = await store.ramReadChunk('row-a', true, 101, count - 1);
      return {
        accepted: accepted.every(Boolean),
        resume,
        prefixBefore,
        prefixAfter,
        liveMatches,
        hash: await digest(blob),
        finalCalls,
        randomReads,
        size: blob.size,
        native: blob instanceof NativeBlob,
        tailBytes: finalizedTail?.byteLength,
      };
    },
    { prefix: PREFIX, size },
  );
  expect(result).toMatchObject({
    accepted: true,
    resume: true,
    prefixBefore: 1,
    prefixAfter: 3,
    liveMatches: true,
    hash: expectedHash(size),
    size,
    native: true,
    tailBytes: 117,
    finalCalls: [{ blobs: 65, buffers: 0, views: 0, bytes: size }],
    randomReads: [true, true, true],
  });
});

test('incomplete native assembly stays resumable and aligned tails trim correctly', async ({
  page,
}) => {
  await openProbe(page);
  const result = await page.evaluate(async (prefix) => {
    const store = (await import(`${prefix}probe.js`)) as Probe;
    store.ramStart('row-b', 'tail.wav', false, 202, 8, false);
    store.ramWrite('row-b', 'tail.wav', false, 202, 0, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const missing = store.ramEnd('row-b', 'tail.wav', false, 202, 11, 2);
    const resume = store.ramStart('row-b', 'tail.wav', false, 202, 8, true);
    const stale = store.ramWrite('row-b', 'tail.wav', false, 201, 1, new Uint8Array(8));
    store.ramWrite(
      'row-b',
      'tail.wav',
      false,
      202,
      1,
      new Uint8Array([9, 10, 11, 99, 99, 99, 99, 99]),
    );
    const { blob } = store.ramEnd('row-b', 'tail.wav', false, 202, 11, 2);
    return {
      missing: missing.reason,
      resume: resume.ok,
      stale: stale.ok,
      bytes: blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : null,
      mime: blob?.type,
    };
  }, PREFIX);
  expect(result).toEqual({
    missing: 'Integrity Fail: 1/2 chunks',
    resume: true,
    stale: false,
    bytes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    mime: 'audio/wav',
  });
});

test('retained native File survives actual preload admission promotion and physical slot release', async ({
  page,
}) => {
  await openProbe(page);
  const result = await page.evaluate(async (prefix) => {
    const store = (await import(`${prefix}probe.js`)) as Probe;
    store.admitIncomingStoredFile({
      queueItemId: 'row-c',
      filename: 'promote.wav',
      isPreload: true,
      sessionId: 303,
      totalSize: 9,
    });
    store.ramStart('row-c', 'promote.wav', true, 303, 4, false);
    for (let index = 0; index < 3; index++) {
      const bytes = new Uint8Array(
        index === 2 ? [9] : [index * 4 + 1, index * 4 + 2, index * 4 + 3, index * 4 + 4],
      );
      store.ramWrite('row-c', 'promote.wav', true, 303, index, bytes);
    }
    store.ramEnd('row-c', 'promote.wav', true, 303, 9, 3);
    const file = await store.readStoredFile('row-c', 'promote.wav', true, 303);
    if (!file) throw new Error('Expected retained File');
    const retained = store.retainStoredFileAdmission('row-c', 'promote.wav', true, 303, file);
    const promoted = store.promoteStoredFileAdmission('row-c', 'promote.wav', 303, file);
    const result = {
      retained,
      promoted,
      native: file instanceof File,
      name: file.name,
      bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
      physicalSlot: store.ramReadBlob('row-c', true, 303),
      owners: store
        .storedFileAdmissionStatsForTests()
        .map(({ owner, isPreload }) => ({ owner, isPreload })),
    };
    store.resetAllStoredFiles();
    return result;
  }, PREFIX);
  expect(result).toEqual({
    retained: true,
    promoted: true,
    native: true,
    name: 'promote.wav',
    bytes: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    physicalSlot: null,
    owners: [{ owner: 'current', isPreload: false }],
  });
});

test('native finalization and reads tolerate the part count of a 700 MiB transfer', async ({
  page,
}) => {
  await openProbe(page);
  const result = await page.evaluate(async (prefix) => {
    const store = (await import(`${prefix}probe.js`)) as Probe;
    // Same 11,200 native Blob parts as 700 MiB / 64 KiB, only 10.9 MiB payload.
    const count = 11200;
    const size = 1024;
    store.ramStart('row-d', 'parts.wav', false, 404, size, false);
    for (let index = count - 1; index >= 0; index--)
      store.ramWrite(
        'row-d',
        'parts.wav',
        false,
        404,
        index,
        new Uint8Array(size).fill(index % 251),
      );
    const { blob } = store.ramEnd('row-d', 'parts.wav', false, 404, count * size, count);
    if (!blob) throw new Error('Many-part finalization failed');
    const matches = await Promise.all(
      [0, 4999, 11199].map(async (index) => {
        const bytes = await store.ramReadChunk('row-d', false, 404, index);
        return bytes?.length === size && bytes.every((value) => value === index % 251);
      }),
    );
    return { size: blob.size, matches, count: store.ramContiguousCount('row-d', false, 404) };
  }, PREFIX);
  expect(result).toEqual({ size: 11200 * 1024, matches: [true, true, true], count: 11200 });
});
