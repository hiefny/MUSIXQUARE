import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE } from '../../../core/constants.ts';
import { BulkFlowControl } from '../bulk-flow-control.ts';

type Frame = Record<string, unknown>;
const flows: BulkFlowControl[] = [];
let now = 0;
const tick = (ms: number) => {
  now += ms;
  vi.advanceTimersByTime(ms);
};
function endpoint(negotiate = true, isolated = true) {
  const frames: Frame[] = [];
  const flow = new BulkFlowControl(
    (frame) => frames.push(frame),
    undefined,
    () => now,
  );
  flows.push(flow);
  if (isolated) flow.setControlIsolationActive(true);
  flow.start();
  const nonce = frames[0]!.nonce;
  if (negotiate)
    flow.handleControl(
      { type: 'mxqr-bulk-flow', version: 1, kind: 'hello', nonce: 'a'.repeat(32) },
      true,
    );
  let received = 0;
  const ack = (bytes = CHUNK_SIZE) => {
    received += bytes;
    flow.handleControl(
      { type: 'mxqr-bulk-flow', version: 1, kind: 'receipt', nonce, receivedBytes: received },
      true,
    );
  };
  const sample = (age: number, bytes = CHUNK_SIZE) => {
    expect(flow.hasCapacity(bytes)).toBe(true);
    flow.noteSent(bytes);
    tick(age);
    ack(bytes);
  };
  const repeat = (count: number, age: number) => {
    for (let i = 0; i < count; i++) sample(age);
  };
  return { flow, frames, nonce, ack, sample, repeat };
}
function probe192(p: ReturnType<typeof endpoint>) {
  p.repeat(22, 200);
  expect(p.flow.diagnosticSnapshot).toMatchObject({
    windowBytes: 192 * 1024,
    phase: 'probe-warmup',
  });
}
function accept192(p: ReturnType<typeof endpoint>) {
  probe192(p);
  p.repeat(44, 100);
  expect(p.flow.diagnosticSnapshot).toMatchObject({ windowBytes: 192 * 1024, phase: 'accepted' });
}
beforeEach(() => {
  now = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  for (const f of flows.splice(0)) f.dispose();
  vi.useRealTimers();
});

describe('Fixed initial probe observation window', () => {
  it('does not accept a transient fast first half and rejects insufficient whole-window gain', () => {
    const p = endpoint();
    probe192(p);
    p.repeat(4, 150); // Three excluded warmup receipts, then the observation anchor.
    p.repeat(14, 150);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ phase: 'probe', sampleCount: 15 });
    p.repeat(8, 250);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      phase: 'cooldown',
      lastDecision: 'insufficient-goodput-gain',
    });
  });

  it('does not reject a transient slow first half and accepts sufficient whole-window gain', () => {
    const p = endpoint();
    probe192(p);
    p.repeat(4, 200);
    p.repeat(10, 200);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ phase: 'probe', sampleCount: 11 });
    p.repeat(20, 100);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 192 * 1024,
      phase: 'accepted',
      lastDecision: 'accepted-192',
    });
    // All 30 intervals count, including the boundary between slower and faster arrivals.
    expect(p.flow.diagnosticSnapshot.previousBlock?.goodputBytesPerSecond).toBe(491520);
  });

  it('requires sixteen eligible receipts even when fifteen span more than four seconds', () => {
    const p = endpoint();
    probe192(p);
    p.repeat(4, 290);
    p.repeat(14, 290);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ phase: 'probe', sampleCount: 15 });
    p.sample(290);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      phase: 'cooldown',
      lastDecision: 'insufficient-goodput-gain',
    });
  });

  it('still rejects a steady nineteen percent gain instead of lowering the acceptance threshold', () => {
    const p = endpoint();
    probe192(p);
    const gap = 200 / 1.19;
    p.repeat(4, gap);
    p.repeat(12, gap);
    expect(p.flow.diagnosticSnapshot.phase).toBe('probe');
    p.repeat(12, gap);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      phase: 'cooldown',
      lastDecision: 'insufficient-goodput-gain',
    });
  });

  it('keeps the eight-second watchdog anchored at probe entry, including warmup', () => {
    const p = endpoint();
    probe192(p);
    const enteredAt = now;
    p.repeat(24, 100);
    expect(p.flow.diagnosticSnapshot.phase).toBe('probe');
    tick(8000 - (now - enteredAt) - 1);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(192 * 1024);
    tick(1);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      lastDecision: 'phase-deadline',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('continues monitoring accepted capacity every two seconds rather than four', () => {
    const p = endpoint();
    probe192(p);
    p.repeat(44, 100);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ phase: 'accepted', sampleCount: 0 });
    p.repeat(10, 200);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ phase: 'accepted', sampleCount: 10 });
    p.sample(200);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      lastDecision: 'insufficient-goodput-gain',
    });
  });

  it('still retires immediately on an individual age violation during the extended observation', () => {
    const p = endpoint();
    probe192(p);
    p.repeat(24, 100);
    for (let i = 0; i < 3; i++) p.flow.noteSent(CHUNK_SIZE);
    tick(301);
    p.ack();
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      outstandingBytes: 2 * CHUNK_SIZE,
      lastDecision: 'ack-age-increase',
    });
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(false);
  });

  it('still retires on compressed receipts instead of extending an ambiguous observation', () => {
    const p = endpoint();
    probe192(p);
    p.repeat(24, 100);
    p.sample(1);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      outstandingBytes: 0,
      lastDecision: 'compressed-receipts',
    });
  });
});

describe('Control isolation activation boundary', () => {
  it('keeps a shared v1 connection at 128 KiB without collecting adaptive evidence', () => {
    const p = endpoint(true, false);
    p.repeat(100, 100);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      controlIsolationActive: false,
      adaptiveEnabled: false,
      windowBytes: 128 * 1024,
      sampleCount: 0,
      trackedBoundaries: 0,
      completedBlocks: 0,
      epoch: 0,
    });
    p.flow.noteSent(CHUNK_SIZE);
    p.flow.noteSent(CHUNK_SIZE);
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['start', 'hello', 'isolation'],
    ['start', 'isolation', 'hello'],
    ['hello', 'start', 'isolation'],
    ['hello', 'isolation', 'start'],
    ['isolation', 'start', 'hello'],
    ['isolation', 'hello', 'start'],
  ])('requires all three prerequisites in order %s / %s / %s', (...order) => {
    const flow = new BulkFlowControl(
      () => {},
      undefined,
      () => now,
    );
    flows.push(flow);
    for (const [index, step] of order.entries()) {
      if (step === 'start') flow.start();
      else if (step === 'isolation') flow.setControlIsolationActive(true);
      else
        flow.handleControl(
          { type: 'mxqr-bulk-flow', version: 1, kind: 'hello', nonce: 'b'.repeat(32) },
          true,
        );
      expect(flow.diagnosticSnapshot).toMatchObject({
        adaptiveEnabled: index === 2,
        epoch: index === 2 ? 1 : 0,
        trackedBoundaries: 0,
      });
    }
  });

  it('preserves pre-isolation debt and excludes its late receipts from learning', () => {
    const p = endpoint(true, false);
    p.flow.noteSent(CHUNK_SIZE);
    p.flow.noteSent(CHUNK_SIZE);
    const frames = [...p.frames];
    p.flow.setControlIsolationActive(true);
    expect(p.frames).toEqual(frames);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      sentBytes: 2 * CHUNK_SIZE,
      acknowledgedBytes: 0,
      outstandingBytes: 2 * CHUNK_SIZE,
      trackedBoundaries: 0,
      adaptiveEnabled: true,
    });
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    tick(100);
    p.ack();
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
    tick(100);
    p.ack();
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      outstandingBytes: 0,
      sampleCount: 0,
      previousBlock: null,
      completedBlocks: 0,
    });
    p.repeat(41, 100);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(128 * 1024);
    p.sample(100);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(192 * 1024);
  });

  it('preserves no-credit legacy fallback without enabling adaptive learning', () => {
    const p = endpoint(false);
    tick(1000);
    for (let i = 0; i < 10; i++) {
      expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
      p.flow.noteSent(CHUNK_SIZE);
    }
    p.flow.setControlIsolationActive(false);
    p.flow.setControlIsolationActive(true);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      phase: 'legacy',
      adaptiveEnabled: false,
      windowBytes: 128 * 1024,
      sentBytes: 10 * CHUNK_SIZE,
      outstandingBytes: 10 * CHUNK_SIZE,
      trackedBoundaries: 0,
      completedBlocks: 0,
    });
  });

  it('shrinks immediately on isolation loss without refunding debt or retaining a watchdog', () => {
    const p = endpoint();
    accept192(p);
    for (let i = 0; i < 3; i++) p.flow.noteSent(CHUNK_SIZE);
    const before = p.flow.diagnosticSnapshot;
    p.flow.setControlIsolationActive(false);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      adaptiveEnabled: false,
      windowBytes: 128 * 1024,
      sentBytes: before.sentBytes,
      acknowledgedBytes: before.acknowledgedBytes,
      outstandingBytes: 3 * CHUNK_SIZE,
      trackedBoundaries: 0,
      sampleCount: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    p.ack();
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    p.ack();
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
    p.ack();
    const after = p.flow.diagnosticSnapshot;
    tick(8000);
    expect(p.flow.diagnosticSnapshot).toEqual(after);
  });

  it('requires fresh learning after reactivation and cannot reuse former-epoch receipts', () => {
    const p = endpoint();
    accept192(p);
    p.flow.noteSent(CHUNK_SIZE);
    p.flow.noteSent(CHUNK_SIZE);
    const before = p.flow.diagnosticSnapshot;
    p.flow.setControlIsolationActive(false);
    p.flow.setControlIsolationActive(true);
    expect(p.flow.diagnosticSnapshot.epoch).toBeGreaterThan(before.epoch);
    tick(100);
    p.ack();
    tick(100);
    p.ack();
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      outstandingBytes: 0,
      trackedBoundaries: 0,
      sampleCount: 0,
      previousBlock: null,
      completedBlocks: before.completedBlocks,
    });
    p.repeat(41, 100);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(128 * 1024);
    p.sample(100);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(192 * 1024);
  });

  it('does not reset a probe or its timer on repeated activation notifications', () => {
    const p = endpoint();
    probe192(p);
    p.flow.noteSent(CHUNK_SIZE);
    const before = p.flow.diagnosticSnapshot;
    p.flow.setControlIsolationActive(true);
    p.flow.setControlIsolationActive(true);
    expect(p.flow.diagnosticSnapshot).toEqual(before);
    expect(vi.getTimerCount()).toBe(1);
    tick(8000);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      outstandingBytes: CHUNK_SIZE,
      lastDecision: 'phase-deadline',
    });
    p.flow.setControlIsolationActive(false);
    const inactive = p.flow.diagnosticSnapshot;
    p.flow.setControlIsolationActive(false);
    expect(p.flow.diagnosticSnapshot).toEqual(inactive);
  });

  it('cannot bypass an existing cooldown by toggling control isolation', () => {
    const p = endpoint();
    accept192(p);
    p.sample(350);
    const cooldownUntilMs = p.flow.diagnosticSnapshot.cooldownUntilMs;
    p.flow.setControlIsolationActive(false);
    p.flow.setControlIsolationActive(true);
    p.repeat(42, 100);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      phase: 'cooldown',
      cooldownUntilMs,
      sampleCount: 0,
    });
    tick(cooldownUntilMs - now);
    p.repeat(42, 100);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(192 * 1024);
  });

  it('isolates gate changes and debt from another peer', () => {
    const p = endpoint();
    const other = endpoint();
    accept192(p);
    p.flow.noteSent(CHUNK_SIZE);
    const otherBefore = other.flow.diagnosticSnapshot;
    p.flow.setControlIsolationActive(false);
    expect(other.flow.diagnosticSnapshot).toEqual(otherBefore);
    expect(other.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
    expect(p.flow.diagnosticSnapshot.outstandingBytes).toBe(CHUNK_SIZE);
  });

  it('ignores late activation and receipts after disposal and cannot revive its timer', () => {
    const p = endpoint();
    accept192(p);
    p.flow.noteSent(CHUNK_SIZE);
    p.flow.dispose();
    const before = p.flow.diagnosticSnapshot;
    p.flow.setControlIsolationActive(false);
    p.flow.setControlIsolationActive(true);
    p.ack();
    tick(40_000);
    expect(p.flow.diagnosticSnapshot).toEqual(before);
    expect(before.adaptiveEnabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(p.flow.hasCapacity(1)).toBe(false);
  });

  it('exposes passive copied diagnostics including receive and reported counters', () => {
    const p = endpoint();
    accept192(p);
    p.flow.noteReceived(123);
    const before = p.flow.diagnosticSnapshot;
    expect(before).toMatchObject({ receivedBytes: 123, reportedBytes: 0 });
    const inspected = p.flow.diagnosticSnapshot;
    Object.assign(inspected, { windowBytes: 0, outstandingBytes: -1 });
    Object.assign(inspected.reference!, { ackAgeMs: 0 });
    expect(p.flow.diagnosticSnapshot).toEqual(before);
    tick(20);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      receivedBytes: 123,
      reportedBytes: 123,
      sentBytes: before.sentBytes,
      acknowledgedBytes: before.acknowledgedBytes,
      windowBytes: before.windowBytes,
    });
  });
});

describe('Isolated control adaptive credit, unchanged cumulative receiver credit', () => {
  it('denies the first real 64 KiB probe at the 2 Mbps payload serialization rate', () => {
    const p = endpoint();
    p.repeat(50, 262.144);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      phase: 'baseline',
      lastDecision: 'baseline-rate-gate',
    });
    expect(p.flow.diagnosticSnapshot.conservativeRateBytesPerSecond).toBeCloseTo(250000, 3);
  });
  it('requires two separate 2-second eligible blocks, not just a short burst of eight receipts', () => {
    const p = endpoint();
    p.repeat(8, 100);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(128 * 1024);
    p.repeat(13, 100);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(128 * 1024);
    p.repeat(20, 100);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(128 * 1024);
    p.sample(100);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(192 * 1024);
  });
  it.each([249, 250, 251])(
    'uses total added bytes / rate at the first-step boundary: %i ms receipt gap',
    (gap) => {
      const p = endpoint();
      p.repeat(2 * (Math.ceil(2000 / gap) + 1), gap);
      expect(p.flow.diagnosticSnapshot.windowBytes).toBe(gap <= 250 ? 192 * 1024 : 128 * 1024);
    },
  );
  it('uses the worse consecutive block and does not turn a single faster block into capacity evidence', () => {
    const p = endpoint();
    p.repeat(9, 300);
    p.repeat(11, 200);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(128 * 1024);
    expect(p.flow.diagnosticSnapshot.conservativeRateBytesPerSecond).toBeCloseTo(65536 / 0.3, 3);
    p.repeat(11, 200);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(192 * 1024);
  });
  it('retains useful 192 with the unchanged conservative gain and rate criteria', () => {
    const p = endpoint();
    probe192(p);
    p.repeat(46, 150);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 192 * 1024,
      phase: 'accepted',
      lastDecision: 'accepted-192',
    });
    expect(p.flow.diagnosticSnapshot.conservativeRateBytesPerSecond).toBeCloseTo(65536 / 0.15, 3);
  });
  it('caps sustained high-rate growth at 192 and keeps the unchanged v1 wire schema', () => {
    const p = endpoint();
    accept192(p);
    p.repeat(60, 80);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(192 * 1024);
    expect(p.frames.filter((f) => f.kind === 'hello')).toHaveLength(1);
    expect(p.frames.every((f) => Object.keys(f).length === (f.kind === 'hello' ? 4 : 5))).toBe(
      true,
    );
  });
  it('excludes the first new flight and old-epoch debt from gain evidence', () => {
    const p = endpoint();
    probe192(p);
    p.repeat(3, 100);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ phase: 'probe-warmup', sampleCount: 0 });
    p.sample(100);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ phase: 'probe', sampleCount: 1 });
  });
  it('releases compressed receipt credit without learning it as capacity', () => {
    const p = endpoint();
    p.repeat(10, 200);
    p.sample(1);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      outstandingBytes: 0,
      lastDecision: 'compressed-receipts',
      sampleCount: 0,
      previousBlock: null,
    });
  });
  it.each([1, 501])(
    'checks excluded receipt gaps across completed-block boundaries: %ims',
    (gap) => {
      const p = endpoint();
      p.repeat(11, 200);
      expect(p.flow.diagnosticSnapshot).toMatchObject({ completedBlocks: 1, sampleCount: 0 });
      p.sample(gap);
      expect(p.flow.diagnosticSnapshot).toMatchObject({
        windowBytes: 128 * 1024,
        previousBlock: null,
        sampleCount: 0,
        lastDecision: gap < 10 ? 'compressed-receipts' : 'ambiguous-receipt-gap',
      });
    },
  );
  it('releases cumulative jump credit without a per-chunk timing claim', () => {
    const p = endpoint();
    probe192(p);
    p.flow.noteSent(CHUNK_SIZE);
    p.flow.noteSent(CHUNK_SIZE);
    tick(100);
    p.ack(2 * CHUNK_SIZE);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      outstandingBytes: 0,
      phase: 'cooldown',
      lastDecision: 'ambiguous-receipt',
    });
  });
  it('invalidates a long inter-receipt gap instead of learning a stalled/janky block', () => {
    const p = endpoint();
    p.sample(200);
    p.sample(501);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      lastDecision: 'ambiguous-receipt-gap',
      sampleCount: 0,
    });
  });
  it('rejects growth with less than 20 percent gain', () => {
    const p = endpoint();
    probe192(p);
    p.repeat(24, 200);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      phase: 'cooldown',
      lastDecision: 'insufficient-goodput-gain',
    });
  });
  it('retires 8→2 deterioration immediately, keeps cooldown, and requalifies fresh 8-rate evidence', () => {
    const p = endpoint();
    accept192(p);
    p.sample(350);
    const until = p.flow.diagnosticSnapshot.cooldownUntilMs;
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      phase: 'cooldown',
      lastDecision: 'ack-age-increase',
    });
    p.repeat(20, 262.144);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(128 * 1024);
    tick(until - now);
    p.repeat(42, 100);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(192 * 1024);
  });
  it('keeps lifetime debt across phase deadline shrink and cancellation/re-add', () => {
    const p = endpoint();
    probe192(p);
    for (let i = 0; i < 3; i++) p.flow.noteSent(CHUNK_SIZE);
    tick(8000);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      outstandingBytes: 3 * CHUNK_SIZE,
      lastDecision: 'phase-deadline',
    });
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    p.ack();
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    p.ack();
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
    p.flow.noteSent(CHUNK_SIZE);
    expect(p.flow.diagnosticSnapshot.outstandingBytes).toBe(2 * CHUNK_SIZE);
    p.ack();
    p.ack();
    expect(p.flow.diagnosticSnapshot.outstandingBytes).toBe(0);
  });
  it('does not teach a new connection from stale receipts or legacy sends', () => {
    const p = endpoint(false);
    tick(1000);
    for (let i = 0; i < 10; i++) p.flow.noteSent(CHUNK_SIZE);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ phase: 'legacy', trackedBoundaries: 0 });
    p.flow.handleControl(
      { type: 'mxqr-bulk-flow', version: 1, kind: 'hello', nonce: 'b'.repeat(32) },
      true,
    );
    p.ack(10 * CHUNK_SIZE);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      sampleCount: 0,
      outstandingBytes: 0,
    });
    const before = p.flow.diagnosticSnapshot;
    p.flow.handleControl(
      {
        type: 'mxqr-bulk-flow',
        version: 1,
        kind: 'receipt',
        nonce: 'c'.repeat(32),
        receivedBytes: 11 * CHUNK_SIZE,
      },
      true,
    );
    expect(p.flow.diagnosticSnapshot).toEqual(before);
  });
  it('admits exactly three full chunks at accepted192 and no fourth until a receipt', () => {
    const p = endpoint();
    accept192(p);
    for (let i = 0; i < 3; i++) {
      expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
      p.flow.noteSent(CHUNK_SIZE);
    }
    expect(p.flow.diagnosticSnapshot.outstandingBytes).toBe(192 * 1024);
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    tick(100);
    p.ack();
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
    p.flow.noteSent(CHUNK_SIZE);
    expect(p.flow.diagnosticSnapshot.outstandingBytes).toBe(192 * 1024);
  });
  it('retires an enlarged probe on compressed ACKs while still releasing lifetime debt', () => {
    const p = endpoint();
    probe192(p);
    p.repeat(4, 100);
    p.sample(1);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      phase: 'cooldown',
      lastDecision: 'compressed-receipts',
      outstandingBytes: 0,
      sampleCount: 0,
    });
  });
  it('does not erase cooldown on a cancelled tail or an idle re-added file', () => {
    const p = endpoint();
    accept192(p);
    p.sample(350);
    const cooldownUntilMs = p.flow.diagnosticSnapshot.cooldownUntilMs;
    const sentBefore = p.flow.diagnosticSnapshot.sentBytes;
    p.sample(100, 123);
    tick(1000);
    p.sample(100);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      phase: 'cooldown',
      cooldownUntilMs,
      sentBytes: sentBefore + 123 + CHUNK_SIZE,
      acknowledgedBytes: sentBefore + 123 + CHUNK_SIZE,
    });
  });
  it('replaces a disposed enlarged connection with fresh credit and rejects its old nonce', () => {
    const old = endpoint();
    accept192(old);
    old.flow.noteSent(CHUNK_SIZE);
    const wake = vi.fn();
    old.flow.subscribe(wake);
    old.flow.dispose();
    expect(wake).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const fresh = endpoint();
    fresh.flow.noteSent(CHUNK_SIZE);
    fresh.flow.handleControl(
      {
        type: 'mxqr-bulk-flow',
        version: 1,
        kind: 'receipt',
        nonce: old.nonce,
        receivedBytes: CHUNK_SIZE,
      },
      true,
    );
    expect(fresh.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      phase: 'baseline',
      sentBytes: CHUNK_SIZE,
      acknowledgedBytes: 0,
      trackedBoundaries: 1,
    });
    tick(100);
    fresh.ack();
    expect(fresh.flow.diagnosticSnapshot.outstandingBytes).toBe(0);
    old.ack();
    expect(old.flow.hasCapacity(1)).toBe(false);
  });
  it('retires accepted192 after eight seconds without usable evidence and clears the watchdog', () => {
    const p = endpoint();
    accept192(p);
    tick(8000);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * 1024,
      phase: 'cooldown',
      lastDecision: 'phase-deadline',
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds metadata, clears its sole watchdog on dispose and isolates peers', () => {
    const p = endpoint(),
      other = endpoint();
    probe192(p);
    for (let i = 0; i < 100; i++) p.flow.noteSent(CHUNK_SIZE);
    expect(p.flow.diagnosticSnapshot.trackedBoundaries).toBe(8);
    expect(vi.getTimerCount()).toBe(1);
    p.flow.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(p.flow.hasCapacity(1)).toBe(false);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ phase: 'disposed', trackedBoundaries: 0 });
    expect(other.flow.diagnosticSnapshot.windowBytes).toBe(128 * 1024);
  });
});
