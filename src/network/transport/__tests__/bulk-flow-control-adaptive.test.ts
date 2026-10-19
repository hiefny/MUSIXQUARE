import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE } from '../../../core/constants.ts';
import { BulkFlowControl } from '../bulk-flow-control.ts';

type Frame = Record<string, unknown>;
type Loop = number | ((windowBytes: number) => number);
const KIB = 1024;
const flows: BulkFlowControl[] = [];
let now = 0;
const tick = (ms: number) => {
  now += ms;
  vi.advanceTimersByTime(ms);
};

/** Loop time of a path whose queue holds every byte beyond its BDP. */
const path =
  (baseMs: number, chunkQueueMs: number, bdpBytes = 128 * KIB) =>
  (windowBytes: number) =>
    baseMs + (Math.max(0, windowBytes - bdpBytes) / CHUNK_SIZE) * chunkQueueMs;

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
  const inflight: { at: number; bytes: number }[] = [];
  const history: string[] = [];
  let received = 0;
  const note = () => {
    const decision = flow.diagnosticSnapshot.lastDecision;
    if (history.at(-1) !== decision) history.push(decision);
  };
  note();
  const ack = (bytes = CHUNK_SIZE) => {
    received += bytes;
    flow.handleControl(
      { type: 'mxqr-bulk-flow', version: 1, kind: 'receipt', nonce, receivedBytes: received },
      true,
    );
    note();
  };
  const send = (bytes = CHUNK_SIZE) => {
    expect(flow.hasCapacity(bytes)).toBe(true);
    flow.noteSent(bytes);
    inflight.push({ at: now, bytes });
    note();
  };
  const fill = () => {
    while (flow.hasCapacity(CHUNK_SIZE)) send();
  };
  /** Keep the window full; each chunk's receipt arrives `loop` ms after its send. */
  const run = (count: number, loop: Loop) => {
    for (let i = 0; i < count; i++) {
      fill();
      const chunk = inflight.shift()!;
      const age = typeof loop === 'number' ? loop : loop(flow.diagnosticSnapshot.windowBytes);
      if (chunk.at + age > now) tick(chunk.at + age - now);
      ack(chunk.bytes);
    }
  };
  /** Acknowledge everything in flight without sending more. */
  const drain = (loop = 0) => {
    while (inflight.length > 0) {
      const chunk = inflight.shift()!;
      if (chunk.at + loop > now) tick(chunk.at + loop - now);
      ack(chunk.bytes);
    }
  };
  /** One sequential chunk: never window-limited, so never decision evidence. */
  const single = (age: number, bytes = CHUNK_SIZE) => {
    send(bytes);
    tick(age);
    inflight.shift();
    ack(bytes);
  };
  return { flow, frames, nonce, ack, send, fill, run, drain, single, inflight, history };
}

function grow256(p: ReturnType<typeof endpoint>, loop: Loop = 300) {
  p.run(40, loop);
  expect(p.flow.diagnosticSnapshot).toMatchObject({
    windowBytes: 256 * KIB,
    phase: 'measure',
    lastDecision: 'accepted-256',
  });
}

beforeEach(() => {
  now = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  for (const f of flows.splice(0)) f.dispose();
  vi.useRealTimers();
});

describe('Delay-based growth', () => {
  it('grows one chunk at a time to 256 KiB while the loop does not lengthen', () => {
    const p = endpoint();
    p.run(6, 300);
    // Two first-flight receipts are skipped; five window-limited samples decide.
    expect(p.flow.diagnosticSnapshot).toMatchObject({ windowBytes: 128 * KIB, sampleCount: 4 });
    p.run(1, 300);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 192 * KIB,
      phase: 'probe',
      baseAgeMs: 300,
      referenceAgeMs: 300,
      lastDecision: 'probe-192',
    });
    grow256(p);
    expect(p.history).toEqual(['negotiated', 'probe-192', 'probe-256', 'accepted-256']);
    expect(p.flow.diagnosticSnapshot.failedProbe).toBeNull();
  });

  it.each([
    [500, 192 * KIB],
    [501, 128 * KIB],
  ])(
    'grows only while one more chunk could add at most 250 ms (loop %i ms)',
    (loop, windowBytes) => {
      const p = endpoint();
      p.run(7, loop);
      expect(p.flow.diagnosticSnapshot.windowBytes).toBe(windowBytes);
    },
  );

  it('keeps a 2 Mbps-like 548 ms loop at the 128 KiB baseline indefinitely', () => {
    const p = endpoint();
    p.run(200, 548);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * KIB,
      phase: 'measure',
      baseAgeMs: 548,
    });
    expect(p.flow.diagnosticSnapshot.completedBlocks).toBeGreaterThan(30);
    expect(p.history).toEqual(['negotiated']);
  });

  it('rejects a step whose added chunk mostly queues and holds the previous window', () => {
    const p = endpoint();
    // One more chunk at 128 KiB could add 150 ms; this path queues 90 ms of it.
    p.run(20, path(300, 90));
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * KIB,
      phase: 'measure',
      referenceAgeMs: 300,
      lastDecision: 'queue-growth',
      failedProbe: { windowBytes: 128 * KIB, ageMs: 300 },
    });
    const { heldUntilMs } = p.flow.diagnosticSnapshot;
    expect(heldUntilMs).toBe(p.flow.diagnosticSnapshot.failedProbe!.at + 10_000);
  });

  it('does not repeat a failed probe until the loop improves or the memory expires', () => {
    const p = endpoint();
    p.run(20, path(300, 90));
    const failedAt = p.flow.diagnosticSnapshot.failedProbe!.at;
    // Unchanged loop: no probe after the 10-second hold.
    p.run(120, path(300, 90));
    expect(now - failedAt).toBeGreaterThan(15_000);
    expect(p.history.filter((decision) => decision === 'probe-192')).toHaveLength(1);
    // An improvement of at least a quarter chunk-delay (37.5 ms) re-opens probing.
    p.run(10, path(262, 90));
    expect(p.history.filter((decision) => decision === 'probe-192')).toHaveLength(2);
  });

  it('re-probes an unchanged path once the failed-probe memory expires', () => {
    const p = endpoint();
    p.run(20, path(300, 90));
    const failedAt = p.flow.diagnosticSnapshot.failedProbe!.at;
    while (now - failedAt < 60_000) p.run(1, path(300, 90));
    p.run(6, path(300, 90));
    expect(p.history.filter((decision) => decision === 'probe-192')).toHaveLength(2);
  });

  it('keeps the standing queue within 60 ms of the 128 KiB baseline across steps', () => {
    const p = endpoint();
    // Each chunk above 128 KiB adds 50 ms: 192 KiB is accepted, 256 KiB is not.
    p.run(40, path(300, 50));
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 192 * KIB,
      referenceAgeMs: 350,
      baseAgeMs: 300,
      lastDecision: 'queue-growth',
      failedProbe: { windowBytes: 192 * KIB, ageMs: 350 },
    });
  });

  it('ignores app-limited loops for decisions', () => {
    const p = endpoint();
    for (let i = 0; i < 40; i++) p.single(300);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * KIB,
      sampleCount: 0,
      completedBlocks: 0,
    });
  });

  it('releases tail and coalesced receipt credit without learning from it', () => {
    const p = endpoint();
    p.send(123);
    tick(300);
    p.inflight.shift();
    p.ack(123);
    p.send();
    p.send();
    tick(300);
    p.inflight.splice(0);
    p.ack(2 * CHUNK_SIZE);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      outstandingBytes: 0,
      sampleCount: 0,
      trackedBoundaries: 0,
    });
  });
});

describe('Delay-based shrink', () => {
  it('falls back to 128 KiB at once on a loop spike and keeps lifetime debt', () => {
    const p = endpoint();
    grow256(p);
    p.fill();
    expect(p.flow.diagnosticSnapshot.outstandingBytes).toBe(256 * KIB);
    const oldest = p.inflight.shift()!;
    tick(oldest.at + 501 - now);
    p.ack();
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * KIB,
      referenceAgeMs: null,
      lastDecision: 'loop-spike',
      outstandingBytes: 192 * KIB,
      heldUntilMs: now + 10_000,
    });
    // Credit reopens only once the old debt drains below the new window.
    for (const expected of [false, true]) {
      p.inflight.shift();
      p.ack();
      expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(expected);
    }
  });

  it('tolerates one excess receipt and sheds one chunk after two in a row', () => {
    const p = endpoint();
    grow256(p);
    p.drain(300);
    // Four chunks 75 ms apart, as a bottleneck would space them.
    const sentAt: number[] = [];
    for (let i = 0; i < 4; i++) {
      if (i > 0) tick(75);
      p.send();
      sentAt.push(now);
    }
    const ackAt = (age: number) => {
      const at = sentAt.shift()! + age;
      if (at > now) tick(at - now);
      p.inflight.shift();
      p.ack();
    };
    // A late receipt (+150 ms) followed by one held only by ordering (+75 ms).
    ackAt(450);
    ackAt(300);
    ackAt(450);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 256 * KIB,
      lastDecision: 'accepted-256',
    });
    ackAt(450);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 192 * KIB,
      lastDecision: 'loop-increase',
      // The previous level's loop stays the provisional reference.
      referenceAgeMs: 300,
    });
  });

  it('sheds a chunk when a grown level drifts beyond the standing-queue budget', () => {
    const p = endpoint();
    grow256(p);
    p.run(10, 360);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 256 * KIB,
      referenceAgeMs: 360,
    });
    // Each block stays within 100 ms of the last, but not of the 128 KiB baseline.
    p.run(10, 420);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 192 * KIB,
      lastDecision: 'standing-queue',
    });
  });

  it('judges the first flight after growth by its probe median, not by per-receipt safety', () => {
    const p = endpoint();
    p.run(7, 300);
    expect(p.flow.diagnosticSnapshot.lastDecision).toBe('probe-192');
    p.run(3, 450);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ windowBytes: 192 * KIB, phase: 'probe' });
    p.run(10, 300);
    expect(p.history).toContain('probe-256');
    expect(p.history).not.toContain('loop-increase');
  });

  it('relearns from 128 KiB after an idle gap without extending a hold', () => {
    const p = endpoint();
    grow256(p);
    p.drain(300);
    const before = p.flow.diagnosticSnapshot;
    tick(999);
    p.send();
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(256 * KIB);
    p.drain(300);
    tick(1001);
    p.send();
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * KIB,
      lastDecision: 'producer-idle',
      epoch: before.epoch + 1,
      heldUntilMs: before.heldUntilMs,
      baseAgeMs: null,
    });
    p.run(12, 300);
    expect(p.history.at(-1)).toBe('probe-192');
  });

  it('never schedules a timer of its own', () => {
    const p = endpoint();
    grow256(p);
    p.run(2, 450);
    p.drain(300);
    tick(2000);
    p.send();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Control isolation activation boundary', () => {
  it('keeps a shared v1 connection at 128 KiB without collecting adaptive evidence', () => {
    const p = endpoint(true, false);
    p.run(100, 300);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      controlIsolationActive: false,
      adaptiveEnabled: false,
      windowBytes: 128 * KIB,
      sampleCount: 0,
      trackedBoundaries: 0,
      completedBlocks: 0,
      epoch: 0,
    });
    p.fill();
    expect(p.flow.diagnosticSnapshot.outstandingBytes).toBe(128 * KIB);
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
    p.send();
    p.send();
    const frames = [...p.frames];
    p.flow.setControlIsolationActive(true);
    expect(p.frames).toEqual(frames);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      sentBytes: 2 * CHUNK_SIZE,
      acknowledgedBytes: 0,
      outstandingBytes: 2 * CHUNK_SIZE,
      trackedBoundaries: 0,
      adaptiveEnabled: true,
      warmupThroughBytes: 4 * CHUNK_SIZE,
    });
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    p.run(2, 300);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ sampleCount: 0, completedBlocks: 0 });
    // The first post-activation flight is skipped as well; five samples decide.
    p.run(6, 300);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(128 * KIB);
    p.run(1, 300);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(192 * KIB);
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
      windowBytes: 128 * KIB,
      sentBytes: 10 * CHUNK_SIZE,
      outstandingBytes: 10 * CHUNK_SIZE,
      trackedBoundaries: 0,
      completedBlocks: 0,
    });
  });

  it('shrinks immediately on isolation loss without refunding debt', () => {
    const p = endpoint();
    grow256(p);
    p.fill();
    const before = p.flow.diagnosticSnapshot;
    p.flow.setControlIsolationActive(false);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      adaptiveEnabled: false,
      windowBytes: 128 * KIB,
      sentBytes: before.sentBytes,
      acknowledgedBytes: before.acknowledgedBytes,
      outstandingBytes: 256 * KIB,
      trackedBoundaries: 0,
      sampleCount: 0,
    });
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    p.drain(300);
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
    const after = p.flow.diagnosticSnapshot;
    tick(8000);
    expect(p.flow.diagnosticSnapshot).toEqual(after);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requires fresh learning after reactivation and cannot reuse former-epoch receipts', () => {
    const p = endpoint();
    grow256(p);
    p.fill();
    const before = p.flow.diagnosticSnapshot;
    p.flow.setControlIsolationActive(false);
    p.flow.setControlIsolationActive(true);
    expect(p.flow.diagnosticSnapshot.epoch).toBeGreaterThan(before.epoch);
    p.drain(300);
    expect(p.flow.diagnosticSnapshot).toMatchObject({
      windowBytes: 128 * KIB,
      outstandingBytes: 0,
      trackedBoundaries: 0,
      sampleCount: 0,
      completedBlocks: before.completedBlocks,
    });
  });

  it('does not reset learning on repeated activation notifications', () => {
    const p = endpoint();
    p.run(7, 300);
    p.fill();
    const before = p.flow.diagnosticSnapshot;
    p.flow.setControlIsolationActive(true);
    p.flow.setControlIsolationActive(true);
    expect(p.flow.diagnosticSnapshot).toEqual(before);
    p.flow.setControlIsolationActive(false);
    const inactive = p.flow.diagnosticSnapshot;
    p.flow.setControlIsolationActive(false);
    expect(p.flow.diagnosticSnapshot).toEqual(inactive);
  });

  it('cannot bypass a hold by toggling control isolation', () => {
    const p = endpoint();
    grow256(p);
    p.run(1, 801);
    const { heldUntilMs } = p.flow.diagnosticSnapshot;
    expect(heldUntilMs).toBeGreaterThan(now);
    p.flow.setControlIsolationActive(false);
    p.flow.setControlIsolationActive(true);
    p.drain(300);
    p.run(20, 300);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ windowBytes: 128 * KIB, heldUntilMs });
    tick(heldUntilMs - now);
    p.run(6, 300);
    expect(p.flow.diagnosticSnapshot.windowBytes).toBe(192 * KIB);
  });

  it('isolates gate changes and debt from another peer', () => {
    const p = endpoint();
    const other = endpoint();
    grow256(p);
    p.drain(300);
    p.send();
    const otherBefore = other.flow.diagnosticSnapshot;
    p.flow.setControlIsolationActive(false);
    expect(other.flow.diagnosticSnapshot).toEqual(otherBefore);
    expect(other.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
    expect(p.flow.diagnosticSnapshot.outstandingBytes).toBe(CHUNK_SIZE);
  });

  it('ignores late activation and receipts after disposal', () => {
    const p = endpoint();
    grow256(p);
    p.send();
    p.flow.dispose();
    const before = p.flow.diagnosticSnapshot;
    p.flow.setControlIsolationActive(false);
    p.flow.setControlIsolationActive(true);
    p.ack();
    tick(40_000);
    expect(p.flow.diagnosticSnapshot).toEqual(before);
    expect(before).toMatchObject({ adaptiveEnabled: false, phase: 'disposed' });
    expect(vi.getTimerCount()).toBe(0);
    expect(p.flow.hasCapacity(1)).toBe(false);
  });

  it('exposes passive copied diagnostics including receive and reported counters', () => {
    const p = endpoint();
    p.run(20, path(300, 90));
    p.flow.noteReceived(123);
    const before = p.flow.diagnosticSnapshot;
    expect(before).toMatchObject({ receivedBytes: 123, reportedBytes: 0 });
    const inspected = p.flow.diagnosticSnapshot;
    Object.assign(inspected, { windowBytes: 0, outstandingBytes: -1 });
    Object.assign(inspected.failedProbe!, { ageMs: 0 });
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
      windowBytes: 128 * KIB,
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

  it('admits exactly four full chunks at 256 KiB and no fifth until a receipt', () => {
    const p = endpoint();
    grow256(p);
    p.drain(300);
    for (let i = 0; i < 4; i++) p.send();
    expect(p.flow.diagnosticSnapshot.outstandingBytes).toBe(256 * KIB);
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(false);
    tick(300);
    p.inflight.shift();
    p.ack();
    expect(p.flow.hasCapacity(CHUNK_SIZE)).toBe(true);
    p.send();
    expect(p.flow.diagnosticSnapshot.outstandingBytes).toBe(256 * KIB);
  });

  it('replaces a disposed enlarged connection with fresh credit and rejects its old nonce', () => {
    const old = endpoint();
    grow256(old);
    old.send();
    const wake = vi.fn();
    old.flow.subscribe(wake);
    old.flow.dispose();
    expect(wake).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const fresh = endpoint();
    fresh.send();
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
      windowBytes: 128 * KIB,
      phase: 'measure',
      sentBytes: CHUNK_SIZE,
      acknowledgedBytes: 0,
      trackedBoundaries: 1,
    });
    fresh.drain(300);
    expect(fresh.flow.diagnosticSnapshot.outstandingBytes).toBe(0);
    old.ack();
    expect(old.flow.hasCapacity(1)).toBe(false);
  });

  it('bounds metadata and isolates peers', () => {
    const p = endpoint(),
      other = endpoint();
    grow256(p);
    for (let i = 0; i < 100; i++) p.flow.noteSent(CHUNK_SIZE);
    expect(p.flow.diagnosticSnapshot.trackedBoundaries).toBe(8);
    p.flow.dispose();
    expect(p.flow.hasCapacity(1)).toBe(false);
    expect(p.flow.diagnosticSnapshot).toMatchObject({ phase: 'disposed', trackedBoundaries: 0 });
    expect(other.flow.diagnosticSnapshot.windowBytes).toBe(128 * KIB);
  });
});
