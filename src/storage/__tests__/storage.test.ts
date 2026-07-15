import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState } from '../../core/state.ts';

// storage.ts captures INSTANCE_ID at import time, so keep it deterministic.
vi.mock('../../core/session.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/session.ts')>();
  return {
    ...actual,
    INSTANCE_ID: 'test-instance-id',
    validateSessionId: actual.validateSessionId,
  };
});

import { ensureNamedFile, postCommand, readStoredFile, resetAllStoredFiles } from '../storage.ts';

beforeEach(() => {
  resetState();
  resetAllStoredFiles();
});

describe('ensureNamedFile', () => {
  it('returns null for null input', () => {
    expect(ensureNamedFile(null, 'fallback')).toBe(null);
  });

  it('returns File as-is if it already has a name', () => {
    const file = new File(['data'], 'existing.mp3', { type: 'audio/mpeg' });
    const result = ensureNamedFile(file, 'fallback');
    expect(result).toBe(file);
  });

  it('wraps Blob in File with fallback name', () => {
    const blob = new Blob(['data'], { type: 'audio/mpeg' });
    const result = ensureNamedFile(blob, 'my-track.mp3');
    expect(result).toBeInstanceOf(File);
    expect((result as File).name).toBe('my-track.mp3');
  });

  it('uses "Track" as default name when fallback is empty', () => {
    const blob = new Blob(['data']);
    const result = ensureNamedFile(blob, '');
    expect(result).toBeInstanceOf(File);
    expect((result as File).name).toBe('Track');
  });

  it('trims whitespace from fallback name', () => {
    const blob = new Blob(['data']);
    const result = ensureNamedFile(blob, '  song.mp3  ');
    expect((result as File).name).toBe('song.mp3');
  });

  it('preserves blob type in wrapped File', () => {
    const blob = new Blob(['data'], { type: 'audio/flac' });
    const result = ensureNamedFile(blob, 'track.flac');
    expect((result as File).type).toBe('audio/flac');
  });
});

describe('postCommand', () => {
  it('returns early for null/undefined payload', () => {
    postCommand(null as never);
    postCommand(undefined as never);
  });

  it('returns early for payload without command', () => {
    postCommand({} as never);
  });

  it('preserves STORAGE_START MIME in the finalized File returned by readStoredFile', async () => {
    const queueItemId = 'queue:stored-mime';
    const sessionId = 7;
    postCommand({
      command: 'STORAGE_START',
      queueItemId,
      filename: 'track.bin',
      sessionId,
      isPreload: false,
      size: 4,
      mime: 'audio/flac',
    });
    postCommand({
      command: 'STORAGE_WRITE',
      queueItemId,
      filename: 'track.bin',
      sessionId,
      isPreload: false,
      chunkIndex: 0,
      chunk: new Uint8Array([1, 2, 3]).buffer,
    });
    postCommand({
      command: 'STORAGE_END',
      queueItemId,
      filename: 'track.bin',
      sessionId,
      isPreload: false,
      total: 1,
      totalSize: 3,
    });

    await vi.waitFor(async () => {
      const file = await readStoredFile(queueItemId, 'track.bin', false, sessionId);
      expect(file?.type).toBe('audio/flac');
    });
  });
});
