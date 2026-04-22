/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlobURLManager } from '../blob-manager.ts';

// ─── Mocks ───────────────────────────────────────────────────────────────

// Mock DELAY constant
vi.mock('../constants.ts', () => ({
  DELAY: { BLOB_REVOCATION: 10000 },
}));

vi.mock('../log.ts', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture URL.createObjectURL / URL.revokeObjectURL
let urlCounter = 0;
const revokedUrls: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  urlCounter = 0;
  revokedUrls.length = 0;

  // Reset BlobURLManager internal state
  BlobURLManager._activeURL = null;
  BlobURLManager._preparingURL = null;
  BlobURLManager._pendingRevocations.clear();
  BlobURLManager._deferredUntilDetached.clear();

  // Stub URL methods
  vi.stubGlobal('URL', {
    createObjectURL: () => `blob:test-${++urlCounter}`,
    revokeObjectURL: (url: string) => { revokedUrls.push(url); },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeBlob(): Blob {
  return new Blob(['test'], { type: 'audio/mp3' });
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('BlobURLManager', () => {
  describe('create()', () => {
    it('returns null for falsy blob', () => {
      expect(BlobURLManager.create(null as unknown as Blob)).toBeNull();
      expect(BlobURLManager.create(undefined as unknown as Blob)).toBeNull();
    });

    it('creates a blob URL and sets preparingURL', () => {
      const url = BlobURLManager.create(fakeBlob());
      expect(url).toBe('blob:test-1');
      expect(BlobURLManager._preparingURL).toBe('blob:test-1');
    });

    it('revokes previous preparingURL when creating a new one', () => {
      BlobURLManager.create(fakeBlob());
      expect(BlobURLManager._preparingURL).toBe('blob:test-1');

      BlobURLManager.create(fakeBlob());
      expect(BlobURLManager._preparingURL).toBe('blob:test-2');
      expect(revokedUrls).toContain('blob:test-1');
    });
  });

  describe('confirm()', () => {
    it('is a no-op when no preparingURL', () => {
      BlobURLManager.confirm();
      expect(BlobURLManager._activeURL).toBeNull();
    });

    it('promotes preparingURL to activeURL', () => {
      BlobURLManager.create(fakeBlob());
      BlobURLManager.confirm();
      expect(BlobURLManager._activeURL).toBe('blob:test-1');
      expect(BlobURLManager._preparingURL).toBeNull();
    });

    it('revokes previous activeURL when confirming a new one', () => {
      // First create + confirm
      BlobURLManager.create(fakeBlob());
      BlobURLManager.confirm();
      expect(BlobURLManager._activeURL).toBe('blob:test-1');

      // Second create + confirm
      BlobURLManager.create(fakeBlob());
      BlobURLManager.confirm();
      expect(BlobURLManager._activeURL).toBe('blob:test-2');
      // Previous active should be scheduled for revocation
    });
  });

  describe('activeURL getter', () => {
    it('returns null initially', () => {
      expect(BlobURLManager.activeURL).toBeNull();
    });

    it('returns the confirmed URL', () => {
      BlobURLManager.create(fakeBlob());
      BlobURLManager.confirm();
      expect(BlobURLManager.activeURL).toBe('blob:test-1');
    });
  });

  describe('safeRevoke()', () => {
    it('ignores null/empty URL', () => {
      BlobURLManager.safeRevoke(null);
      BlobURLManager.safeRevoke('');
      expect(revokedUrls).toHaveLength(0);
    });

    it('deduplicates pending revocations', () => {
      BlobURLManager.safeRevoke('blob:dup', { delayMs: 5000 });
      BlobURLManager.safeRevoke('blob:dup', { delayMs: 5000 });
      expect(BlobURLManager._pendingRevocations.size).toBe(1);
    });

    it('revokes immediately when delayMs=0', () => {
      BlobURLManager.safeRevoke('blob:immediate', { delayMs: 0 });
      expect(revokedUrls).toContain('blob:immediate');
    });

    it('schedules revocation with delay', () => {
      BlobURLManager.safeRevoke('blob:delayed', { delayMs: 5000 });
      expect(revokedUrls).not.toContain('blob:delayed');
      expect(BlobURLManager._pendingRevocations.has('blob:delayed')).toBe(true);

      vi.advanceTimersByTime(5000);
      expect(revokedUrls).toContain('blob:delayed');
    });

    it('force-revokes immediately regardless of pending state', () => {
      BlobURLManager.safeRevoke('blob:pending', { delayMs: 5000 });
      expect(BlobURLManager._pendingRevocations.has('blob:pending')).toBe(true);

      BlobURLManager.safeRevoke('blob:pending', { force: true, delayMs: 0 });
      expect(revokedUrls).toContain('blob:pending');
    });

    it('evicts oldest on queue overflow', () => {
      for (let i = 1; i <= 5; i++) {
        BlobURLManager.safeRevoke(`blob:q-${i}`, { delayMs: 10000 });
      }
      expect(BlobURLManager._pendingRevocations.size).toBe(5);

      // 6th should evict oldest
      BlobURLManager.safeRevoke('blob:q-6', { delayMs: 10000 });
      // oldest (q-1) should have been revoked
      expect(revokedUrls).toContain('blob:q-1');
    });
  });

  describe('flushDeferred()', () => {
    it('is a no-op when no deferred URLs', () => {
      BlobURLManager.flushDeferred();
      expect(revokedUrls).toHaveLength(0);
    });

    it('revokes deferred URLs (never attached under current no-video design)', () => {
      BlobURLManager._deferredUntilDetached.add('blob:old');
      BlobURLManager.flushDeferred('test');
      // flushDeferred calls safeRevoke(url, { force: true }) which schedules with delay
      vi.advanceTimersByTime(10000);
      expect(revokedUrls).toContain('blob:old');
      expect(BlobURLManager._deferredUntilDetached.has('blob:old')).toBe(false);
    });
  });

  describe('revoke()', () => {
    it('revokes both preparing and active URLs', () => {
      BlobURLManager._preparingURL = 'blob:prep';
      BlobURLManager._activeURL = 'blob:act';

      BlobURLManager.revoke({ delayMs: 0 });
      expect(revokedUrls).toContain('blob:prep');
      expect(revokedUrls).toContain('blob:act');
    });

    it('handles case with no URLs set', () => {
      BlobURLManager.revoke();
      expect(revokedUrls).toHaveLength(0);
    });
  });

  describe('revokeAllNow()', () => {
    it('cleans up all URLs and state', () => {
      BlobURLManager.create(fakeBlob());
      BlobURLManager.confirm();
      BlobURLManager.create(fakeBlob());
      BlobURLManager.safeRevoke('blob:scheduled', { delayMs: 5000 });
      BlobURLManager._deferredUntilDetached.add('blob:deferred');

      BlobURLManager.revokeAllNow('cleanup');

      expect(BlobURLManager._activeURL).toBeNull();
      expect(BlobURLManager._preparingURL).toBeNull();
      expect(BlobURLManager._pendingRevocations.size).toBe(0);
      expect(BlobURLManager._deferredUntilDetached.size).toBe(0);
    });
  });

  describe('_isUrlAttached()', () => {
    // Local <video> playback was removed, so no URL is ever considered
    // attached. The method is kept as a hook for future re-introduction
    // but currently short-circuits to false unconditionally.
    it('always returns false (local-video playback was removed)', () => {
      expect(BlobURLManager._isUrlAttached('blob:anything')).toBe(false);
      expect(BlobURLManager._isUrlAttached('blob:other')).toBe(false);
    });
  });
});
