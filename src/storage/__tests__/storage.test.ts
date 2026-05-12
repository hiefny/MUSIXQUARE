import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetState } from '../../core/state.ts';

// Mock session.ts to provide stable INSTANCE_ID
vi.mock('../../core/session.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/session.ts')>();
  return {
    ...actual,
    INSTANCE_ID: 'test-instance-id',
    validateSessionId: actual.validateSessionId,
  };
});

import { ensureNamedFile, postCommand } from '../storage.ts';

beforeEach(() => {
  resetState();
});

describe('ensureNamedFile', () => {
  it('returns null for null input', () => {
    expect(ensureNamedFile(null, 'fallback')).toBe(null);
  });

  it('returns File as-is if it already has a name', () => {
    const file = new File(['data'], 'existing.mp3', { type: 'audio/mpeg' });
    const result = ensureNamedFile(file, 'fallback');
    expect(result).toBe(file); // same reference
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
    // Should not throw
    postCommand(null as never);
    postCommand(undefined as never);
  });

  it('returns early for payload without command', () => {
    postCommand({} as never);
  });
});
