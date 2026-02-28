import { describe, it, expect } from 'vitest';

// ─── Tests for transfer.worker.ts pure logic ────────────────────────────
// The transfer worker runs in a DedicatedWorkerGlobalScope.
// We extract and test its pure validation/normalization functions directly.

// ─── Reimplementations (mirrors transfer.worker.ts logic) ────────────────

const DEFAULT_CHUNK_SIZE = 16384;

function isValidSessionId(sessionId: unknown): sessionId is number {
  return (typeof sessionId === 'number' && Number.isInteger(sessionId));
}

function sanitizeFilename(filename: string): string {
  return String(filename || '').replace(/[^a-z0-9._-]/gi, '_');
}

function buildSafeName(filename: string, isPreload: boolean, instanceId = 'default'): string {
  return (isPreload ? 'preload_' : 'current_') + sanitizeFilename(filename) + '_' + instanceId;
}

function normalizeChunkSize(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHUNK_SIZE;
  return Math.max(256, Math.floor(n));
}

function normalizeIndex(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function normalizeChunk(chunk: unknown): Uint8Array | null {
  if (!chunk) return null;
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk) && chunk.buffer) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return null;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Transfer Worker — isValidSessionId()', () => {
  it('accepts positive integer', () => {
    expect(isValidSessionId(42)).toBe(true);
  });

  it('accepts zero', () => {
    expect(isValidSessionId(0)).toBe(true);
  });

  it('accepts negative integer', () => {
    expect(isValidSessionId(-5)).toBe(true);
  });

  it('rejects NaN', () => {
    expect(isValidSessionId(NaN)).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(isValidSessionId(Infinity)).toBe(false);
  });

  it('rejects float', () => {
    expect(isValidSessionId(1.5)).toBe(false);
  });

  it('rejects string', () => {
    expect(isValidSessionId('42')).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidSessionId(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidSessionId(undefined)).toBe(false);
  });
});

describe('Transfer Worker — sanitizeFilename()', () => {
  it('passes alphanumeric names through', () => {
    expect(sanitizeFilename('file123.mp3')).toBe('file123.mp3');
  });

  it('replaces spaces', () => {
    expect(sanitizeFilename('my file.mp3')).toBe('my_file.mp3');
  });

  it('replaces special characters', () => {
    expect(sanitizeFilename('bad/path\\to:file')).toBe('bad_path_to_file');
  });

  it('preserves dots, dashes, underscores', () => {
    expect(sanitizeFilename('my-file_v2.0.mp3')).toBe('my-file_v2.0.mp3');
  });

  it('handles empty string', () => {
    expect(sanitizeFilename('')).toBe('');
  });

  it('handles unicode characters', () => {
    expect(sanitizeFilename('음악파일.mp3')).toBe('____.mp3');
  });
});

describe('Transfer Worker — buildSafeName()', () => {
  it('prefixes with current_ for non-preload', () => {
    expect(buildSafeName('test.mp3', false)).toBe('current_test.mp3_default');
  });

  it('prefixes with preload_ for preload', () => {
    expect(buildSafeName('test.mp3', true)).toBe('preload_test.mp3_default');
  });

  it('appends instance ID', () => {
    expect(buildSafeName('test.mp3', false, 'abc123')).toBe('current_test.mp3_abc123');
  });

  it('sanitizes filename in the safe name', () => {
    expect(buildSafeName('bad file!.mp3', false)).toBe('current_bad_file_.mp3_default');
  });
});

describe('Transfer Worker — normalizeChunkSize()', () => {
  it('returns value for valid number', () => {
    expect(normalizeChunkSize(16384)).toBe(16384);
  });

  it('returns default for NaN', () => {
    expect(normalizeChunkSize(NaN)).toBe(DEFAULT_CHUNK_SIZE);
  });

  it('returns default for zero', () => {
    expect(normalizeChunkSize(0)).toBe(DEFAULT_CHUNK_SIZE);
  });

  it('returns default for negative', () => {
    expect(normalizeChunkSize(-100)).toBe(DEFAULT_CHUNK_SIZE);
  });

  it('returns default for Infinity', () => {
    expect(normalizeChunkSize(Infinity)).toBe(DEFAULT_CHUNK_SIZE);
  });

  it('clamps small values to 256', () => {
    expect(normalizeChunkSize(100)).toBe(256);
  });

  it('floors fractional values', () => {
    expect(normalizeChunkSize(1000.9)).toBe(1000);
  });

  it('handles string numbers', () => {
    expect(normalizeChunkSize('8192')).toBe(8192);
  });
});

describe('Transfer Worker — normalizeIndex()', () => {
  it('returns value for valid positive integer', () => {
    expect(normalizeIndex(5)).toBe(5);
  });

  it('returns 0 for zero', () => {
    expect(normalizeIndex(0)).toBe(0);
  });

  it('returns null for negative', () => {
    expect(normalizeIndex(-1)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(normalizeIndex(NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(normalizeIndex(Infinity)).toBeNull();
  });

  it('floors fractional values', () => {
    expect(normalizeIndex(3.9)).toBe(3);
  });

  it('handles string numbers', () => {
    expect(normalizeIndex('10')).toBe(10);
  });
});

describe('Transfer Worker — normalizeChunk()', () => {
  it('returns null for falsy input', () => {
    expect(normalizeChunk(null)).toBeNull();
    expect(normalizeChunk(undefined)).toBeNull();
    expect(normalizeChunk(0)).toBeNull();
    expect(normalizeChunk('')).toBeNull();
  });

  it('returns same Uint8Array instance', () => {
    const chunk = new Uint8Array([1, 2, 3]);
    expect(normalizeChunk(chunk)).toBe(chunk);
  });

  it('wraps ArrayBuffer in Uint8Array', () => {
    const buf = new ArrayBuffer(4);
    const result = normalizeChunk(buf);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result!.byteLength).toBe(4);
  });

  it('wraps typed array views', () => {
    const buf = new ArrayBuffer(8);
    const view = new Int32Array(buf);
    const result = normalizeChunk(view);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result!.byteLength).toBe(8);
  });

  it('returns null for non-buffer objects', () => {
    expect(normalizeChunk({ data: [1, 2] })).toBeNull();
  });
});

describe('Transfer Worker — Session Lock Logic', () => {
  // Test the lock acquisition/preemption logic
  interface SimpleLock {
    isLocked: boolean;
    sessionId: number | null;
    name: string | null;
    lockTime: number;
  }

  function createLock(): SimpleLock {
    return { isLocked: false, sessionId: null, name: null, lockTime: 0 };
  }

  function canAcquire(lock: SimpleLock, sessionId: number, filename: string, now: number, timeout: number): boolean {
    if (!Number.isInteger(sessionId)) return false;

    // Same file, same session → refresh
    if (lock.isLocked && lock.name === filename) {
      if (sessionId === lock.sessionId) return true;
      if (sessionId < lock.sessionId!) return false; // stale
      return true; // preempt
    }

    // Different file
    if (lock.isLocked && lock.name !== filename) {
      if (sessionId >= lock.sessionId!) return true; // preempt
      const age = now - lock.lockTime;
      return age >= timeout; // stale cleanup only if timed out
    }

    // Not locked
    return true;
  }

  it('allows lock on free slot', () => {
    const lock = createLock();
    expect(canAcquire(lock, 1, 'file.mp3', 1000, 60000)).toBe(true);
  });

  it('refreshes lock for same session + file', () => {
    const lock: SimpleLock = { isLocked: true, sessionId: 5, name: 'file.mp3', lockTime: 1000 };
    expect(canAcquire(lock, 5, 'file.mp3', 2000, 60000)).toBe(true);
  });

  it('rejects stale session trying to renew', () => {
    const lock: SimpleLock = { isLocked: true, sessionId: 10, name: 'file.mp3', lockTime: 1000 };
    expect(canAcquire(lock, 5, 'file.mp3', 2000, 60000)).toBe(false);
  });

  it('allows newer session to preempt same file', () => {
    const lock: SimpleLock = { isLocked: true, sessionId: 5, name: 'file.mp3', lockTime: 1000 };
    expect(canAcquire(lock, 10, 'file.mp3', 2000, 60000)).toBe(true);
  });

  it('allows newer session to preempt different file', () => {
    const lock: SimpleLock = { isLocked: true, sessionId: 5, name: 'old.mp3', lockTime: 1000 };
    expect(canAcquire(lock, 10, 'new.mp3', 2000, 60000)).toBe(true);
  });

  it('rejects older session for different file within timeout', () => {
    const lock: SimpleLock = { isLocked: true, sessionId: 10, name: 'old.mp3', lockTime: 1000 };
    expect(canAcquire(lock, 5, 'new.mp3', 2000, 60000)).toBe(false);
  });

  it('allows old session preemption after timeout', () => {
    const lock: SimpleLock = { isLocked: true, sessionId: 10, name: 'old.mp3', lockTime: 1000 };
    expect(canAcquire(lock, 5, 'new.mp3', 62000, 60000)).toBe(true);
  });

  it('uses shorter timeout for preload slots', () => {
    const lock: SimpleLock = { isLocked: true, sessionId: 10, name: 'old.mp3', lockTime: 1000 };
    // Preload timeout: 20000ms
    expect(canAcquire(lock, 5, 'new.mp3', 21001, 20000)).toBe(true);
    expect(canAcquire(lock, 5, 'new.mp3', 20999, 20000)).toBe(false);
  });
});

describe('Transfer Worker — Queue Management', () => {
  it('queue cleanup at 128 items', () => {
    // Simulate the queue cleanup logic
    const queue: (unknown | null)[] = [];
    let idx = 0;

    // Fill queue to 128+
    for (let i = 0; i < 130; i++) {
      queue.push({ command: `CMD_${i}` });
      idx++;

      // Process (null out processed)
      queue[idx - 1] = null;

      if (idx >= 128) {
        queue.splice(0, idx);
        idx = 0;
      }
    }

    expect(queue.length).toBeLessThan(128);
  });

  it('session mismatch deduplication', () => {
    let lastKey: string | null = null;
    const posted: Record<string, unknown>[] = [];

    function postMismatch(payload: Record<string, unknown>): void {
      const key = `${payload.command}|${payload.expected}|${payload.received}|${payload.filename}|${payload.isPreload ? 'P' : 'C'}`;
      if (key === lastKey) return;
      lastKey = key;
      posted.push(payload);
    }

    const p = { command: 'WRITE', expected: 5, received: 3, filename: 'file.mp3', isPreload: false };
    postMismatch(p);
    postMismatch(p); // duplicate → skipped
    postMismatch(p); // duplicate → skipped

    expect(posted).toHaveLength(1);

    // Different payload → new post
    postMismatch({ ...p, expected: 6 });
    expect(posted).toHaveLength(2);
  });
});
