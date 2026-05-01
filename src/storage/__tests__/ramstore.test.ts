import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ramStart,
  ramWrite,
  ramEnd,
  ramReadChunk,
  ramReadBlob,
  ramCleanup,
  ramResetSession,
  ramReset,
  ramStats,
  __resetRamStoreForTests,
} from '../ramstore.ts';

beforeEach(() => {
  __resetRamStoreForTests();
});

const u8 = (...bytes: number[]) => new Uint8Array(bytes);

// ─── ramStart ──────────────────────────────────────────────────────

describe('ramStart', () => {
  it('rejects empty filename', () => {
    const r = ramStart('', false, 1, 16, false);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/filename/i);
  });

  it('rejects non-integer sessionId', () => {
    expect(ramStart('a.mp3', false, 1.5, 16, false).ok).toBe(false);
    expect(ramStart('a.mp3', false, 0, 16, false).ok).toBe(false);
    expect(ramStart('a.mp3', false, -1, 16, false).ok).toBe(false);
  });

  it('creates a main slot', () => {
    expect(ramStart('a.mp3', false, 1, 16, false).ok).toBe(true);
    // Write should succeed → slot exists
    expect(ramWrite('a.mp3', false, 1, 0, u8(0x42)).ok).toBe(true);
  });

  it('reuses main slot when keepExisting + same filename + same sid (resume)', () => {
    ramStart('a.mp3', false, 1, 16, false);
    ramWrite('a.mp3', false, 1, 0, u8(0xaa));
    // Resume start should NOT clear chunks
    ramStart('a.mp3', false, 1, 16, true);
    const end = ramEnd('a.mp3', false, 1);
    expect(end.blob).not.toBeNull();
    expect(end.blob!.size).toBe(1);
  });

  it('replaces main slot when filename differs', () => {
    ramStart('a.mp3', false, 1, 16, false);
    ramWrite('a.mp3', false, 1, 0, u8(0xaa));
    // Different filename — fresh slot, prior chunk gone
    ramStart('b.mp3', false, 2, 16, false);
    expect(ramWrite('a.mp3', false, 1, 0, u8(0xbb)).ok).toBe(false); // old slot gone
    expect(ramWrite('b.mp3', false, 2, 0, u8(0xcc)).ok).toBe(true);
  });

  it('creates preload slot keyed by sid AND filename', () => {
    ramStart('p.mp3', true, 7, 16, false);
    expect(ramWrite('p.mp3', true, 7, 0, u8(1)).ok).toBe(true);
    // Read by name (no sid) finds it
    expect(ramReadBlob('p.mp3', true)).toBeNull(); // not finalized yet
    ramEnd('p.mp3', true, 7);
    expect(ramReadBlob('p.mp3', true)).not.toBeNull();
  });

  it('drops stale preload entry when same filename arrives under new sid', () => {
    ramStart('p.mp3', true, 1, 16, false);
    ramWrite('p.mp3', true, 1, 0, u8(0xaa));
    // New session for same filename
    ramStart('p.mp3', true, 2, 16, false);
    // Old sid 1 should be gone
    expect(ramWrite('p.mp3', true, 1, 0, u8(0xbb)).ok).toBe(false);
    expect(ramWrite('p.mp3', true, 2, 0, u8(0xcc)).ok).toBe(true);
  });
});

// ─── ramWrite ──────────────────────────────────────────────────────

describe('ramWrite', () => {
  it('rejects when no slot exists', () => {
    const r = ramWrite('nope.mp3', false, 1, 0, u8(0));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });

  it('rejects on session mismatch and reports expectedSid', () => {
    ramStart('a.mp3', false, 1, 16, false);
    const r = ramWrite('a.mp3', false, 999, 0, u8(0));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/session mismatch/i);
    expect(r.expectedSid).toBe(1);
  });

  it('rejects on filename mismatch silently (no expectedSid)', () => {
    ramStart('a.mp3', false, 1, 16, false);
    const r = ramWrite('b.mp3', false, 1, 0, u8(0));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/filename/i);
  });

  it('rejects writes after finalize', () => {
    ramStart('a.mp3', false, 1, 16, false);
    ramWrite('a.mp3', false, 1, 0, u8(1, 2, 3));
    ramEnd('a.mp3', false, 1);
    const r = ramWrite('a.mp3', false, 1, 1, u8(4));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/finalized/i);
  });

  it('accepts out-of-order chunks', () => {
    ramStart('a.mp3', false, 1, 4, false);
    expect(ramWrite('a.mp3', false, 1, 2, u8(0xcc)).ok).toBe(true);
    expect(ramWrite('a.mp3', false, 1, 0, u8(0xaa)).ok).toBe(true);
    expect(ramWrite('a.mp3', false, 1, 1, u8(0xbb)).ok).toBe(true);
  });
});

// ─── ramEnd ────────────────────────────────────────────────────────

describe('ramEnd', () => {
  it('concatenates chunks in index order regardless of write order', async () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 2, u8(0xcc));
    ramWrite('a.mp3', false, 1, 0, u8(0xaa));
    ramWrite('a.mp3', false, 1, 1, u8(0xbb));
    const r = ramEnd('a.mp3', false, 1);
    expect(r.blob).not.toBeNull();
    const bytes = new Uint8Array(await r.blob!.arrayBuffer());
    expect(Array.from(bytes)).toEqual([0xaa, 0xbb, 0xcc]);
  });

  it('tail-trims when assembled size exceeds totalSize', async () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(1, 2, 3, 4));
    ramWrite('a.mp3', false, 1, 1, u8(5, 6, 7, 8));
    const r = ramEnd('a.mp3', false, 1, 5);
    expect(r.blob).not.toBeNull();
    expect(r.blob!.size).toBe(5);
  });

  it('returns Integrity Fail when assembled size is less than totalSize', () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(1, 2, 3));
    const r = ramEnd('a.mp3', false, 1, 100);
    expect(r.blob).toBeNull();
    expect(r.reason).toMatch(/integrity fail/i);
  });

  it('rejects on session mismatch with expectedSid', () => {
    ramStart('a.mp3', false, 1, 16, false);
    const r = ramEnd('a.mp3', false, 999);
    expect(r.blob).toBeNull();
    expect(r.expectedSid).toBe(1);
  });

  it('drops the chunk map after finalize so reads come from blob', async () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(0xaa, 0xbb));
    ramEnd('a.mp3', false, 1);
    // After finalize, ramReadChunk reads via blob slice — same bytes back
    const c0 = await ramReadChunk('a.mp3', false, 1, 0);
    expect(c0).not.toBeNull();
    expect(Array.from(c0!)).toEqual([0xaa, 0xbb]);
  });
});

// ─── ramReadChunk / ramReadBlob ────────────────────────────────────

describe('ramReadChunk', () => {
  it('returns null when slot is missing', async () => {
    expect(await ramReadChunk('nope.mp3', false, 1, 0)).toBeNull();
  });

  it('reads from live chunks before finalize', async () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 5, u8(7, 8, 9));
    const r = await ramReadChunk('a.mp3', false, 1, 5);
    expect(r).not.toBeNull();
    expect(Array.from(r!)).toEqual([7, 8, 9]);
  });

  it('reads sliced bytes from finalized blob using chunkSize offset', async () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(1, 2, 3, 4));
    ramWrite('a.mp3', false, 1, 1, u8(5, 6, 7, 8));
    ramEnd('a.mp3', false, 1);
    const c1 = await ramReadChunk('a.mp3', false, 1, 1);
    expect(c1).not.toBeNull();
    expect(Array.from(c1!)).toEqual([5, 6, 7, 8]);
  });
});

describe('ramReadBlob', () => {
  it('returns null while in-flight', () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(1));
    expect(ramReadBlob('a.mp3', false)).toBeNull();
  });

  it('returns the finalized blob', () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(1, 2));
    ramEnd('a.mp3', false, 1);
    const blob = ramReadBlob('a.mp3', false);
    expect(blob).not.toBeNull();
    expect(blob!.size).toBe(2);
  });

  it('finds preload by name even without sessionId hint', () => {
    ramStart('p.mp3', true, 42, 4, false);
    ramWrite('p.mp3', true, 42, 0, u8(9));
    ramEnd('p.mp3', true, 42);
    expect(ramReadBlob('p.mp3', true)).not.toBeNull();
  });
});

// ─── ramCleanup / ramResetSession / ramReset ──────────────────────

describe('ramCleanup', () => {
  it('removes the main slot when filename matches', () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramCleanup('a.mp3', false);
    expect(ramReadBlob('a.mp3', false)).toBeNull();
    // Subsequent write fails because slot is gone
    expect(ramWrite('a.mp3', false, 1, 0, u8(0)).ok).toBe(false);
  });

  it('is a no-op when filename does not match', () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramCleanup('different.mp3', false);
    // Original slot still works
    expect(ramWrite('a.mp3', false, 1, 0, u8(1)).ok).toBe(true);
  });

  it('removes preload slot from both sid and name maps', () => {
    ramStart('p.mp3', true, 7, 4, false);
    ramWrite('p.mp3', true, 7, 0, u8(1));
    ramCleanup('p.mp3', true);
    expect(ramReadBlob('p.mp3', true)).toBeNull();
    expect(ramWrite('p.mp3', true, 7, 1, u8(2)).ok).toBe(false);
  });
});

describe('ramResetSession', () => {
  it('clears the main slot only when sessionId matches', () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramResetSession(999, false);
    // Wrong sid → slot survives
    expect(ramWrite('a.mp3', false, 1, 0, u8(1)).ok).toBe(true);
    ramResetSession(1, false);
    expect(ramWrite('a.mp3', false, 1, 1, u8(2)).ok).toBe(false);
  });

  it('clears a preload slot by sessionId', () => {
    ramStart('p.mp3', true, 5, 4, false);
    ramResetSession(5, true);
    expect(ramWrite('p.mp3', true, 5, 0, u8(1)).ok).toBe(false);
  });

  it('leaves other preload sids alone', () => {
    ramStart('a.mp3', true, 1, 4, false);
    ramStart('b.mp3', true, 2, 4, false);
    ramResetSession(1, true);
    expect(ramWrite('a.mp3', true, 1, 0, u8(1)).ok).toBe(false);
    expect(ramWrite('b.mp3', true, 2, 0, u8(1)).ok).toBe(true);
  });
});

describe('ramReset', () => {
  it('clears every preload slot when isPreload=true', () => {
    ramStart('a.mp3', true, 1, 4, false);
    ramStart('b.mp3', true, 2, 4, false);
    ramReset(true);
    expect(ramWrite('a.mp3', true, 1, 0, u8(1)).ok).toBe(false);
    expect(ramWrite('b.mp3', true, 2, 0, u8(1)).ok).toBe(false);
  });

  it('clears the main slot when isPreload=false and leaves preloads alone', () => {
    ramStart('main.mp3', false, 1, 4, false);
    ramStart('p.mp3', true, 7, 4, false);
    ramReset(false);
    expect(ramWrite('main.mp3', false, 1, 0, u8(1)).ok).toBe(false);
    expect(ramWrite('p.mp3', true, 7, 0, u8(1)).ok).toBe(true);
  });
});

// ─── ramStats ──────────────────────────────────────────────────────

describe('ramStats', () => {
  it('reports zero state on empty store', () => {
    expect(ramStats()).toEqual({
      mainBytes: 0,
      preloadCount: 0,
      preloadBytes: 0,
      finalizedCount: 0,
      inFlightCount: 0,
    });
  });

  it('counts in-flight bytes from chunk maps', () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(1, 2, 3));
    ramStart('p.mp3', true, 5, 4, false);
    ramWrite('p.mp3', true, 5, 0, u8(9, 9));
    const s = ramStats();
    expect(s.mainBytes).toBe(3);
    expect(s.preloadBytes).toBe(2);
    expect(s.preloadCount).toBe(1);
    expect(s.inFlightCount).toBe(1);
    expect(s.finalizedCount).toBe(0);
  });

  it('counts finalized bytes from blob and bumps finalizedCount', () => {
    ramStart('p.mp3', true, 5, 4, false);
    ramWrite('p.mp3', true, 5, 0, u8(1, 2, 3, 4));
    ramEnd('p.mp3', true, 5);
    const s = ramStats();
    expect(s.preloadBytes).toBe(4);
    expect(s.finalizedCount).toBe(1);
    expect(s.inFlightCount).toBe(0);
  });
});
