import { beforeEach, describe, expect, it } from 'vitest';
import { resetState, setState } from '../../core/state.ts';
import { __resetRamStoreForTests, ramReadBlob } from '../ramstore.ts';
import {
  admitIncomingStoredFile,
  postCommand,
  promoteStoredFileAdmission,
  readStoredFile,
  resetStoredFileAdmissionsForTests,
  retainStoredFileAdmission,
  storedFileAdmissionStatsForTests,
} from '../storage.ts';

async function finalizeOneBytePreload(sessionId: number, filename = 'next.mp3'): Promise<File> {
  admitIncomingStoredFile({
    filename,
    isPreload: true,
    sessionId,
    totalSize: 1,
  });
  postCommand({
    command: 'STORAGE_START',
    filename,
    isPreload: true,
    sessionId,
    size: 64 * 1024,
  });
  postCommand({
    command: 'STORAGE_WRITE',
    filename,
    isPreload: true,
    sessionId,
    index: 0,
    chunk: new Uint8Array([0xaa]).buffer,
  });
  postCommand({
    command: 'STORAGE_END',
    filename,
    isPreload: true,
    sessionId,
    total: 1,
    totalSize: 1,
  });
  await Promise.resolve();
  const file = await readStoredFile(filename, true, sessionId);
  if (!file) throw new Error('test preload did not finalize');
  expect(retainStoredFileAdmission(filename, true, sessionId, file)).toBe(true);
  setState('preload.meta', { name: filename, index: 1, sessionId, size: 1, total: 1 });
  setState('preload.nextFileBlob', file);
  return file;
}

describe('stored-file admission ownership', () => {
  beforeEach(() => {
    resetState();
    __resetRamStoreForTests();
    resetStoredFileAdmissionsForTests();
  });

  it('keeps a resident preload lease across physical session cleanup', async () => {
    const file = await finalizeOneBytePreload(1);

    postCommand({ command: 'STORAGE_RESET_SESSION', isPreload: true, sessionId: 1 });
    await Promise.resolve();

    expect(ramReadBlob('next.mp3', true, 1)).toBeNull();
    expect(storedFileAdmissionStatsForTests()).toEqual([
      expect.objectContaining({ sessionId: 1, owner: 'preload-cache', phase: 'resident' }),
    ]);

    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    await Promise.resolve();
    expect(storedFileAdmissionStatsForTests()).toEqual([]);
    expect(file.size).toBe(1);
  });

  it('moves exact preload ownership to current and releases stale main entries', async () => {
    const file = await finalizeOneBytePreload(2, 'same.mp3');
    admitIncomingStoredFile({
      filename: 'old.mp3',
      isPreload: false,
      sessionId: 9,
      totalSize: 1,
    });

    expect(promoteStoredFileAdmission('same.mp3', 2, file)).toBe(true);
    setState('files.currentFileBlob', file);
    setState('transfer.meta', { name: 'same.mp3', index: 1, sessionId: 2, size: 1, total: 1 });
    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    await Promise.resolve();

    expect(storedFileAdmissionStatsForTests()).toEqual([
      expect.objectContaining({
        filename: 'same.mp3',
        isPreload: false,
        sessionId: 2,
        owner: 'current',
        phase: 'resident',
      }),
    ]);

    postCommand({ command: 'STORAGE_RESET', isPreload: false });
    await Promise.resolve();
    expect(storedFileAdmissionStatsForTests()).toHaveLength(1);

    setState('files.currentFileBlob', null);
    setState('transfer.meta', null);
    await Promise.resolve();
    expect(storedFileAdmissionStatsForTests()).toEqual([]);
  });

  it('reopens an exact finalized session with an assembling lease', async () => {
    await finalizeOneBytePreload(3, 'retry.mp3');

    setState('preload.nextFileBlob', null);
    setState('preload.meta', null);
    admitIncomingStoredFile({
      filename: 'retry.mp3',
      isPreload: true,
      sessionId: 3,
      totalSize: 1,
    });

    expect(storedFileAdmissionStatsForTests()).toEqual([
      expect.objectContaining({ sessionId: 3, owner: 'storage', phase: 'assembling' }),
    ]);
  });
});
