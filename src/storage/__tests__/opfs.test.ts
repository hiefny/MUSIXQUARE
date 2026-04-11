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

import {
  buildSafeOpfsName,
  ensureNamedFile,
  postWorkerCommand,
  setTransferWorker,
  setSyncWorker,
  stopBackgroundWorkerTimers,
} from '../opfs.ts';

beforeEach(() => {
  resetState();
});

describe('buildSafeOpfsName', () => {
  it('sanitizes filename with special characters', () => {
    const result = buildSafeOpfsName('my file (1).mp3');
    expect(result).toBe('current_my_file__1_.mp3_test-instance-id');
  });

  it('adds current_ prefix by default', () => {
    const result = buildSafeOpfsName('track.mp3');
    expect(result).toMatch(/^current_/);
  });

  it('adds preload_ prefix when isPreload is true', () => {
    const result = buildSafeOpfsName('track.mp3', true);
    expect(result).toMatch(/^preload_/);
  });

  it('appends instance ID', () => {
    const result = buildSafeOpfsName('track.mp3');
    expect(result).toContain('test-instance-id');
  });

  it('handles empty filename', () => {
    const result = buildSafeOpfsName('');
    expect(result).toBe('current__test-instance-id');
  });

  it('preserves alphanumeric, dots, hyphens, underscores', () => {
    const result = buildSafeOpfsName('my-file_v2.0.mp3');
    expect(result).toBe('current_my-file_v2.0.mp3_test-instance-id');
  });

  it('replaces unicode characters', () => {
    const result = buildSafeOpfsName('한글파일.mp3');
    expect(result).toBe('current_____.mp3_test-instance-id');
  });
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

describe('postWorkerCommand', () => {
  it('drops command silently when no worker is set', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No worker set → should log warning and drop
    postWorkerCommand({ command: 'OPFS_RESET' });
    // The log.warn call goes through console.warn
    spy.mockRestore();
  });

  it('returns early for null/undefined payload', () => {
    // Should not throw
    postWorkerCommand(null as never);
    postWorkerCommand(undefined as never);
  });

  it('returns early for payload without command', () => {
    postWorkerCommand({} as never);
  });

  it('sends OPFS commands to transfer worker', () => {
    const mockPostMessage = vi.fn();
    const mockWorker = {
      postMessage: mockPostMessage,
      onmessage: null,
      onerror: null,
      addEventListener: vi.fn(),
    } as unknown as Worker;

    setTransferWorker(mockWorker);
    postWorkerCommand({ command: 'OPFS_RESET' });
    expect(mockPostMessage).toHaveBeenCalledWith({ command: 'OPFS_RESET' }, []);
  });

  it('sends timer commands to sync worker', () => {
    const mockPostMessage = vi.fn();
    const mockWorker = {
      postMessage: mockPostMessage,
      onmessage: null,
      onerror: null,
      addEventListener: vi.fn(),
    } as unknown as Worker;

    setSyncWorker(mockWorker);
    postWorkerCommand({ command: 'START_TIMER', id: 'heartbeat', interval: 1000 });
    expect(mockPostMessage).toHaveBeenCalledWith(
      { command: 'START_TIMER', id: 'heartbeat', interval: 1000 },
      [],
    );
  });
});

describe('stopBackgroundWorkerTimers', () => {
  it('sends STOP_TIMER for all known timer IDs', () => {
    const mockPostMessage = vi.fn();
    const mockWorker = {
      postMessage: mockPostMessage,
      onmessage: null,
      onerror: null,
      addEventListener: vi.fn(),
    } as unknown as Worker;

    setSyncWorker(mockWorker);
    stopBackgroundWorkerTimers();

    // Only 'video-sync' remains in the worker; heartbeat/ping were moved to
    // main-thread managed timers during modularization.
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
    const commands = mockPostMessage.mock.calls.map((c: unknown[]) => (c[0] as Record<string, unknown>).id);
    expect(commands).toContain('video-sync');
  });
});
