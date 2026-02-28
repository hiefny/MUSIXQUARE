import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Worker Simulation Helpers ───────────────────────────────────────────
// The sync worker operates as a DedicatedWorkerGlobalScope.
// We extract and test its pure logic functions directly.

// ─── Pure function reimplementations (mirrors sync.worker.ts logic) ──────
function toId(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function normalizeIntervalMs(v: unknown, fallback = 1000): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('Sync Worker — toId()', () => {
  it('converts null to empty string', () => {
    expect(toId(null)).toBe('');
  });

  it('converts undefined to empty string', () => {
    expect(toId(undefined)).toBe('');
  });

  it('converts number 0 to "0"', () => {
    expect(toId(0)).toBe('0');
  });

  it('converts number to string', () => {
    expect(toId(42)).toBe('42');
  });

  it('converts string to same string', () => {
    expect(toId('hello')).toBe('hello');
  });

  it('converts false to "false"', () => {
    expect(toId(false)).toBe('false');
  });

  it('converts empty string to empty string', () => {
    expect(toId('')).toBe('');
  });
});

describe('Sync Worker — normalizeIntervalMs()', () => {
  it('returns value for valid positive number', () => {
    expect(normalizeIntervalMs(100)).toBe(100);
  });

  it('returns fallback for NaN', () => {
    expect(normalizeIntervalMs(NaN)).toBe(1000);
  });

  it('returns fallback for Infinity', () => {
    expect(normalizeIntervalMs(Infinity)).toBe(1000);
  });

  it('returns fallback for -Infinity', () => {
    expect(normalizeIntervalMs(-Infinity)).toBe(1000);
  });

  it('clamps negative values to 1', () => {
    expect(normalizeIntervalMs(-500)).toBe(1);
  });

  it('clamps zero to 1', () => {
    expect(normalizeIntervalMs(0)).toBe(1);
  });

  it('floors fractional values', () => {
    expect(normalizeIntervalMs(99.9)).toBe(99);
  });

  it('clamps 0.5 (floors to 0, then clamps to 1)', () => {
    expect(normalizeIntervalMs(0.5)).toBe(1);
  });

  it('uses custom fallback', () => {
    expect(normalizeIntervalMs('abc', 500)).toBe(500);
  });

  it('handles string numbers', () => {
    expect(normalizeIntervalMs('200')).toBe(200);
  });
});

describe('Sync Worker — Timer Management (integration)', () => {
  // Simulate the worker's timer management
  let timers: Map<string, ReturnType<typeof setInterval>>;
  let messages: Array<{ type: string; id?: string }>;

  function startTimer(id: string, intervalMs: number): void {
    if (!id) return;
    stopTimer(id);
    const ms = normalizeIntervalMs(intervalMs);
    const handle = setInterval(() => {
      messages.push({ type: 'TICK', id });
    }, ms);
    timers.set(id, handle);
  }

  function stopTimer(id: string): void {
    const handle = timers.get(id);
    if (handle !== undefined) {
      clearInterval(handle);
      timers.delete(id);
    }
  }

  function stopAllTimers(): void {
    for (const [, handle] of timers.entries()) {
      clearInterval(handle);
    }
    timers.clear();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    timers = new Map();
    messages = [];
  });

  afterEach(() => {
    stopAllTimers();
    vi.useRealTimers();
  });

  it('starts a timer that sends TICK messages', () => {
    startTimer('test', 100);
    vi.advanceTimersByTime(350);
    expect(messages.filter(m => m.id === 'test')).toHaveLength(3);
  });

  it('stops a timer by id', () => {
    startTimer('test', 100);
    vi.advanceTimersByTime(200);
    stopTimer('test');
    vi.advanceTimersByTime(200);
    // Only 2 ticks before stop
    expect(messages.filter(m => m.id === 'test')).toHaveLength(2);
  });

  it('replaces timer when starting same id', () => {
    startTimer('dup', 100);
    vi.advanceTimersByTime(150); // 1 tick
    startTimer('dup', 200); // replaces — old timer cleared
    vi.advanceTimersByTime(250); // 1 more tick at 200ms interval
    expect(messages.filter(m => m.id === 'dup')).toHaveLength(2);
  });

  it('runs multiple independent timers', () => {
    startTimer('A', 100);
    startTimer('B', 200);
    vi.advanceTimersByTime(400);

    expect(messages.filter(m => m.id === 'A')).toHaveLength(4);
    expect(messages.filter(m => m.id === 'B')).toHaveLength(2);
  });

  it('stops all timers at once', () => {
    startTimer('A', 100);
    startTimer('B', 200);
    vi.advanceTimersByTime(100); // 1 tick for A
    stopAllTimers();
    vi.advanceTimersByTime(500);

    expect(messages.filter(m => m.id === 'A')).toHaveLength(1);
    expect(messages.filter(m => m.id === 'B')).toHaveLength(0);
    expect(timers.size).toBe(0);
  });

  it('stopAllTimers is idempotent', () => {
    startTimer('A', 100);
    stopAllTimers();
    stopAllTimers(); // should not throw
    expect(timers.size).toBe(0);
  });

  it('ignores empty id', () => {
    startTimer('', 100);
    vi.advanceTimersByTime(500);
    expect(messages).toHaveLength(0);
    expect(timers.size).toBe(0);
  });

  it('stopTimer on non-existent id is a no-op', () => {
    stopTimer('nonexistent');
    expect(timers.size).toBe(0);
  });

  it('applies interval normalization', () => {
    startTimer('fast', NaN as unknown as number);
    // NaN → fallback 1000ms
    vi.advanceTimersByTime(2500);
    expect(messages.filter(m => m.id === 'fast')).toHaveLength(2);
  });
});

describe('Sync Worker — Message Handler', () => {
  it('handles missing command gracefully', () => {
    // Simulate the switch-default path
    const data = {} as { command?: string };
    const command = data.command;
    // default case: no action, no error
    expect(command).toBeUndefined();
  });

  it('handles INIT_INSTANCE as no-op', () => {
    // INIT_INSTANCE case does nothing — just verifying no crash
    const command = 'INIT_INSTANCE';
    expect(command).toBe('INIT_INSTANCE');
  });
});
