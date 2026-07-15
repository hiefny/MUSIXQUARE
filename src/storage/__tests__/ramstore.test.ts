import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  ramStart as rawRamStart,
  ramWrite as rawRamWrite,
  ramEnd as rawRamEnd,
  ramReadChunk as rawRamReadChunk,
  ramReadBlob as rawRamReadBlob,
  ramCleanup as rawRamCleanup,
  ramResetSession,
  ramReset,
  ramStats,
  ramContiguousCount as rawRamContiguousCount,
  __resetRamStoreForTests,
} from '../ramstore.ts';

const u8 = (...bytes: number[]) => new Uint8Array(bytes);
const activeSids = new Map<string, number>();
const qid = (filename: string) => `queue:${filename}`;
const slotKey = (filename: string, isPreload: boolean) => `${isPreload}:${filename}`;

function ramStart(
  filename: string,
  isPreload: boolean,
  sessionId: number,
  chunkSize: number,
  keepExisting: boolean,
  mime?: string,
) {
  const result = rawRamStart(
    qid(filename),
    filename,
    isPreload,
    sessionId,
    chunkSize,
    keepExisting,
    mime,
  );
  if (result.ok) activeSids.set(slotKey(filename, isPreload), sessionId);
  return result;
}

const ramWrite = (
  filename: string,
  isPreload: boolean,
  sessionId: number,
  chunkIndex: number,
  chunk: Uint8Array,
) => rawRamWrite(qid(filename), filename, isPreload, sessionId, chunkIndex, chunk);

const ramEnd = (
  filename: string,
  isPreload: boolean,
  sessionId: number,
  totalSize?: number,
  expectedChunks?: number,
) => rawRamEnd(qid(filename), filename, isPreload, sessionId, totalSize, expectedChunks);

const ramReadChunk = (
  filename: string,
  isPreload: boolean,
  sessionId: number,
  chunkIndex: number,
) => rawRamReadChunk(qid(filename), isPreload, sessionId, chunkIndex);

const ramReadBlob = (filename: string, isPreload: boolean, sessionId?: number) =>
  rawRamReadBlob(
    qid(filename),
    isPreload,
    sessionId ?? activeSids.get(slotKey(filename, isPreload)) ?? 0,
  );

const ramContiguousCount = (filename: string, isPreload: boolean, sessionId?: number) =>
  rawRamContiguousCount(
    qid(filename),
    isPreload,
    sessionId ?? activeSids.get(slotKey(filename, isPreload)) ?? 0,
  );

const ramCleanup = (filename: string, isPreload: boolean, sessionId?: number) =>
  rawRamCleanup(qid(filename), isPreload, sessionId);

beforeEach(() => {
  __resetRamStoreForTests();
  activeSids.clear();
});

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

  it('starts fresh when keepExisting uses the same filename under a newer sid', () => {
    ramStart('a.mp3', false, 1, 16, false);
    ramWrite('a.mp3', false, 1, 0, u8(0xaa));
    ramWrite('a.mp3', false, 1, 1, u8(0xbb));

    const r = ramStart('a.mp3', false, 2, 16, true);
    expect(r.ok).toBe(true);

    // Slot now lives under sid 2, but metadata equality did not preserve bytes.
    expect(ramContiguousCount('a.mp3', false)).toBe(0);
    const stale = ramWrite('a.mp3', false, 1, 2, u8(0xff));
    expect(stale.ok).toBe(false);
    expect(stale.reason).toMatch(/session mismatch/i);
    expect(stale.expectedSid).toBe(2);

    expect(ramWrite('a.mp3', false, 2, 0, u8(0xcc)).ok).toBe(true);
    const end = ramEnd('a.mp3', false, 2, undefined, 1);
    expect(end.blob).not.toBeNull();
    expect(end.blob!.size).toBe(1);
  });

  it('also starts fresh when keepExisting carries an older sid', () => {
    ramStart('a.mp3', false, 5, 16, false);
    ramWrite('a.mp3', false, 5, 0, u8(0xaa));

    expect(ramStart('a.mp3', false, 3, 16, true).ok).toBe(true);

    // Fresh slot under sid 3 — old chunks gone, old sid rejected
    expect(ramContiguousCount('a.mp3', false)).toBe(0);
    const stale = ramWrite('a.mp3', false, 5, 1, u8(0xff));
    expect(stale.ok).toBe(false);
    expect(stale.expectedSid).toBe(3);
    expect(ramWrite('a.mp3', false, 3, 0, u8(0xcc)).ok).toBe(true);
  });

  it('creates preload slot keyed by sid AND filename', () => {
    ramStart('p.mp3', true, 7, 16, false);
    expect(ramWrite('p.mp3', true, 7, 0, u8(1)).ok).toBe(true);
    // Read by name (no sid) finds it
    expect(ramReadBlob('p.mp3', true)).toBeNull(); // not finalized yet
    ramEnd('p.mp3', true, 7);
    expect(ramReadBlob('p.mp3', true)).not.toBeNull();
  });

  it('keeps independent preload sessions for the same queue item until explicit cleanup', () => {
    ramStart('p.mp3', true, 1, 16, false);
    ramWrite('p.mp3', true, 1, 0, u8(0xaa));
    // New session for same filename
    ramStart('p.mp3', true, 2, 16, false);
    // Late completion for sid 1 remains isolated from sid 2.
    expect(ramWrite('p.mp3', true, 1, 0, u8(0xbb)).ok).toBe(true);
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

  it('rejects on queue-item mismatch silently (no expectedSid)', () => {
    ramStart('a.mp3', false, 1, 16, false);
    const r = ramWrite('b.mp3', false, 1, 0, u8(0));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/queue item/i);
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
  it.each([
    ['track.mp3', 'audio/mpeg'],
    ['track.wav', 'audio/wav'],
    ['track.flac', 'audio/flac'],
    ['track.m4a', 'audio/mp4'],
    ['track.aac', 'audio/aac'],
    ['track.ogg', 'audio/ogg'],
    ['track.aiff', 'audio/aiff'],
    ['track.aif', 'audio/aiff'],
    ['track.caf', 'audio/x-caf'],
  ])('infers a conservative MIME for %s when the sender type is empty', (filename, mime) => {
    ramStart(filename, false, 1, 4, false);
    ramWrite(filename, false, 1, 0, u8(1));

    expect(ramEnd(filename, false, 1).blob?.type).toBe(mime);
  });

  it.each([
    'application/octet-stream',
    'binary/octet-stream',
    ' Application/Octet-Stream; charset=binary ',
  ])('treats generic binary MIME %s as missing and falls back to the extension', (mime) => {
    ramStart('track.flac', false, 1, 4, false, mime);
    ramWrite('track.flac', false, 1, 0, u8(1));

    expect(ramEnd('track.flac', false, 1).blob?.type).toBe('audio/flac');
  });

  it('prefers a declared MIME and lets a non-empty exact resume refine it', () => {
    ramStart('track.mp3', false, 1, 4, false, 'audio/original');
    ramWrite('track.mp3', false, 1, 0, u8(1));

    ramStart('track.mp3', false, 1, 4, true, 'audio/authoritative');
    ramStart('track.mp3', false, 1, 4, true, 'application/octet-stream');
    ramStart('track.mp3', false, 1, 4, true, '   ');

    expect(ramEnd('track.mp3', false, 1).blob?.type).toBe('audio/authoritative');
  });

  it('applies the same non-empty resume MIME rule to preload slots', () => {
    ramStart('track.mp3', true, 9, 4, false);
    ramWrite('track.mp3', true, 9, 0, u8(1));

    ramStart('track.mp3', true, 9, 4, true, 'audio/preload-authoritative');
    ramStart('track.mp3', true, 9, 4, true, '');

    expect(ramEnd('track.mp3', true, 9).blob?.type).toBe('audio/preload-authoritative');
  });

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
    expect(r.blob!.type).toBe('audio/mpeg');
  });

  it('returns Integrity Fail when assembled size is less than totalSize', () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(1, 2, 3));
    const r = ramEnd('a.mp3', false, 1, 100);
    expect(r.blob).toBeNull();
    expect(r.reason).toMatch(/integrity fail/i);
  });

  it('returns Integrity Fail when chunk count is below expectedChunks', () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(1, 2, 3, 4));
    ramWrite('a.mp3', false, 1, 1, u8(5, 6, 7, 8));
    const r = ramEnd('a.mp3', false, 1, undefined, 5);
    expect(r.blob).toBeNull();
    expect(r.reason).toMatch(/2\/5 chunks/);
  });

  it('finalizes when expectedChunks matches even if totalSize is missing', async () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(1, 2));
    ramWrite('a.mp3', false, 1, 1, u8(3, 4));
    const r = ramEnd('a.mp3', false, 1, undefined, 2);
    expect(r.blob).not.toBeNull();
    const bytes = new Uint8Array(await r.blob!.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it('catches missing index gap via expectedChunks even when bytes happen to match', () => {
    // Slot has chunks {0, 2} (gap at 1). Total bytes happen to equal totalSize,
    // so the byte-size gate alone would let this through. expectedChunks=3
    // catches the structural defect that byte-size cannot.
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(1, 2));
    ramWrite('a.mp3', false, 1, 2, u8(5, 6));
    const r = ramEnd('a.mp3', false, 1, 4, 3);
    expect(r.blob).toBeNull();
    expect(r.reason).toMatch(/2\/3 chunks/);
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

// ─── ramContiguousCount ────────────────────────────────────────────

describe('ramContiguousCount', () => {
  it('returns 0 for missing slot or empty filename', () => {
    expect(ramContiguousCount('nope.mp3', false)).toBe(0);
    expect(ramContiguousCount('', false)).toBe(0);
  });

  it('returns 0 when the main slot holds a different filename', () => {
    ramStart('a.mp3', false, 1, 16, false);
    ramWrite('a.mp3', false, 1, 0, u8(1));
    expect(ramContiguousCount('b.mp3', false)).toBe(0);
  });

  it('counts the contiguous-from-0 prefix, ignoring chunks past a gap', () => {
    ramStart('a.mp3', false, 1, 16, false);
    ramWrite('a.mp3', false, 1, 0, u8(1));
    ramWrite('a.mp3', false, 1, 1, u8(2));
    ramWrite('a.mp3', false, 1, 3, u8(4)); // gap at 2
    expect(ramContiguousCount('a.mp3', false)).toBe(2);
  });

  it('does not count a same-name main slot from another session', () => {
    ramStart('a.mp3', false, 1, 16, false);
    ramWrite('a.mp3', false, 1, 0, u8(1));
    ramWrite('a.mp3', false, 1, 1, u8(2));

    expect(ramContiguousCount('a.mp3', false, 1)).toBe(2);
    expect(ramContiguousCount('a.mp3', false, 2)).toBe(0);
  });

  it('reports the full chunk count for a finalized slot', () => {
    ramStart('a.mp3', false, 1, 2, false);
    ramWrite('a.mp3', false, 1, 0, u8(1, 2));
    ramWrite('a.mp3', false, 1, 1, u8(3, 4));
    ramWrite('a.mp3', false, 1, 2, u8(5)); // tail chunk smaller than chunkSize
    ramEnd('a.mp3', false, 1, 5, 3);
    // chunks map is cleared at finalize — count derives from totalSize/chunkSize
    expect(ramContiguousCount('a.mp3', false)).toBe(3);
  });

  it('finds preload slots by name', () => {
    ramStart('p.mp3', true, 7, 16, false);
    ramWrite('p.mp3', true, 7, 0, u8(1));
    expect(ramContiguousCount('p.mp3', true)).toBe(1);
    expect(ramContiguousCount('p.mp3', false)).toBe(0); // main slot untouched
  });

  it('does not fall back to a preload name when a session hint misses', () => {
    ramStart('p.mp3', true, 7, 16, false);
    ramWrite('p.mp3', true, 7, 0, u8(1));

    expect(ramContiguousCount('p.mp3', true, 7)).toBe(1);
    expect(ramContiguousCount('p.mp3', true, 8)).toBe(0);
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

  it('does not read a same-name live main chunk through another session', async () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(7, 8, 9));

    expect(await ramReadChunk('a.mp3', false, 2, 0)).toBeNull();
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

  it('does not return a same-name finalized main blob for another session', () => {
    ramStart('a.mp3', false, 1, 4, false);
    ramWrite('a.mp3', false, 1, 0, u8(1, 2));
    ramEnd('a.mp3', false, 1);

    expect(ramReadBlob('a.mp3', false, 1)).not.toBeNull();
    expect(ramReadBlob('a.mp3', false, 2)).toBeNull();
  });

  it('finds preload by name even without sessionId hint', () => {
    ramStart('p.mp3', true, 42, 4, false);
    ramWrite('p.mp3', true, 42, 0, u8(9));
    ramEnd('p.mp3', true, 42);
    expect(ramReadBlob('p.mp3', true)).not.toBeNull();
  });

  it('does not fall back to a preload name when an exact session is requested', () => {
    ramStart('p.mp3', true, 42, 4, false);
    ramWrite('p.mp3', true, 42, 0, u8(9));
    ramEnd('p.mp3', true, 42);

    expect(ramReadBlob('p.mp3', true, 43)).toBeNull();
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
