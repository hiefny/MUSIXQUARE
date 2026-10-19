import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE } from '../../../core/constants.ts';
import { BulkFlowControl } from '../bulk-flow-control.ts';

/**
 * Deterministic path model, not browser or network evidence: one FIFO
 * bottleneck shared with control traffic, fixed one-way delays, immediate
 * full-chunk receipts on the isolated control path. SCTP congestion control,
 * delayed SACK and browser scheduling are not modeled. It checks the
 * controller's decisions against the arithmetic it relies on; native runs
 * decide release.
 */
interface Profile {
  rate(t: number): number; // bottleneck bytes per ms
  forwardMs: number;
  returnMs: number;
  returnJitter?(): number;
  /** A receiver that acknowledges two chunks per receipt while true. */
  coalesce?(t: number): boolean;
}

interface Result {
  completionMs: number;
  maxWindow: number;
  queueP95Ms: number;
  queueMaxMs: number;
  decisions: { t: number; decision: string; windowBytes: number }[];
  /** Largest evidence age and unsampled release seen while above 128 KiB. */
  evidenceGapMs: number;
  evidenceGapBytes: number;
}

const FILE_BYTES = 23_040_044;
const MBPS = 1000 / 8; // bytes per ms for 1 Mbit/s

function simulate(profile: Profile, adaptive: boolean, totalBytes = FILE_BYTES): Result {
  let now = 0;
  const frames: Record<string, unknown>[] = [];
  const flow = new BulkFlowControl(
    (frame) => frames.push(frame),
    undefined,
    () => now,
  );
  flow.handleControl(
    { type: 'mxqr-bulk-flow', version: 1, kind: 'hello', nonce: 'c'.repeat(32) },
    true,
  );
  flow.start();
  if (adaptive) flow.setControlIsolationActive(true);
  const nonce = frames[0]!.nonce;
  const queue: { remaining: number; bytes: number }[] = [];
  const pipe: { at: number; bytes: number }[] = [];
  const receipts: { at: number; receivedBytes: number }[] = [];
  const waits: number[] = [];
  const decisions: Result['decisions'] = [];
  let sent = 0;
  let received = 0;
  let reported = 0;
  let maxWindow = 0;
  let evidenceGapMs = 0;
  let evidenceGapBytes = 0;
  try {
    for (now = 0; now < 600_000; now++) {
      while (receipts[0] && receipts[0].at <= now) {
        flow.handleControl(
          {
            type: 'mxqr-bulk-flow',
            version: 1,
            kind: 'receipt',
            nonce,
            receivedBytes: receipts.shift()!.receivedBytes,
          },
          true,
        );
      }
      const snapshot = flow.diagnosticSnapshot;
      if (snapshot.lastDecision !== decisions.at(-1)?.decision) {
        decisions.push({
          t: now,
          decision: snapshot.lastDecision,
          windowBytes: snapshot.windowBytes,
        });
      }
      maxWindow = Math.max(maxWindow, snapshot.windowBytes);
      if (snapshot.windowBytes > 128 * 1024) {
        evidenceGapMs = Math.max(evidenceGapMs, now - snapshot.evidenceAtMs);
        evidenceGapBytes = Math.max(evidenceGapBytes, snapshot.releasedSinceEvidenceBytes);
      }
      if (snapshot.acknowledgedBytes >= totalBytes) {
        const ordered = [...waits].sort((a, b) => a - b);
        return {
          completionMs: now,
          maxWindow,
          queueP95Ms: ordered[Math.floor(ordered.length * 0.95)] ?? 0,
          queueMaxMs: ordered.at(-1) ?? 0,
          decisions,
          evidenceGapMs,
          evidenceGapBytes,
        };
      }
      for (;;) {
        const bytes = Math.min(CHUNK_SIZE, totalBytes - sent);
        if (bytes <= 0 || !flow.hasCapacity(bytes)) break;
        sent += bytes;
        queue.push({ remaining: bytes, bytes });
        flow.noteSent(bytes);
      }
      const rate = profile.rate(now);
      // A control packet sent now waits behind every queued bulk byte.
      if (now % 10 === 0) waits.push(queue.reduce((sum, entry) => sum + entry.remaining, 0) / rate);
      let budget = rate;
      while (budget > 0 && queue[0]) {
        const head = queue[0];
        const served = Math.min(budget, head.remaining);
        head.remaining -= served;
        budget -= served;
        if (head.remaining === 0) {
          queue.shift();
          pipe.push({ at: now + profile.forwardMs, bytes: head.bytes });
        }
      }
      while (pipe[0] && pipe[0].at <= now) {
        received += pipe.shift()!.bytes;
        if (
          profile.coalesce?.(now) &&
          received - reported < 2 * CHUNK_SIZE &&
          received < totalBytes
        ) {
          continue;
        }
        // Full chunks are receipted at once; a tail waits for the 20 ms batch.
        const batch = received - reported >= CHUNK_SIZE ? 0 : 20;
        const at = Math.max(
          receipts.at(-1)?.at ?? 0,
          now + batch + profile.returnMs + (profile.returnJitter?.() ?? 0),
        );
        receipts.push({ at, receivedBytes: received });
        reported = received;
      }
    }
  } finally {
    flow.dispose();
  }
  throw new Error('simulation did not complete');
}

const constant = (mbps: number, forwardMs = 100, returnMs = 114): Profile => ({
  rate: () => mbps * MBPS,
  forwardMs,
  returnMs,
});

/** Deterministic PRNG so every run sees the same jitter. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function compare(profile: Profile) {
  return { fixed: simulate(profile, false), delay: simulate(profile, true) };
}

const failedProbes = (result: Result) =>
  result.decisions.filter(({ decision }) =>
    ['queue-growth', 'loop-increase', 'loop-spike'].includes(decision),
  );

const unproven = (result: Result) =>
  result.decisions.filter(({ decision }) => decision.startsWith('evidence-'));

/** Window-limited flows stay within half of the 2 s / 16-chunk evidence bound. */
function expectFreshEvidence(result: Result): void {
  expect(unproven(result)).toEqual([]);
  expect(result.evidenceGapMs).toBeLessThan(1000);
  expect(result.evidenceGapBytes).toBeLessThanOrEqual(8 * CHUNK_SIZE);
}

describe('delay-based receipt window path model', () => {
  it('fills an 8 Mbps / 214 ms path without adding standing queue', () => {
    const { fixed, delay } = compare(constant(8));
    expect(fixed.maxWindow).toBe(128 * 1024);
    expect(delay.maxWindow).toBe(256 * 1024);
    expect(delay.decisions.find(({ decision }) => decision === 'accepted-256')!.t).toBeLessThan(
      3000,
    );
    expect(failedProbes(delay)).toEqual([]);
    expectFreshEvidence(delay);
    expect(delay.completionMs).toBeLessThan(fixed.completionMs * 0.55);
    // A 64 KiB chunk alone is 65.5 ms at 8 Mbps; the window adds at most ~one more
    // queued chunk-time at p95 and none at the maximum.
    expect(delay.queueP95Ms - fixed.queueP95Ms).toBeLessThan(10);
    expect(delay.queueMaxMs).toBe(fixed.queueMaxMs);
  });

  it('keeps the 2 Mbps / 214 ms path exactly at the 128 KiB baseline', () => {
    const { fixed, delay } = compare(constant(2));
    expect(delay.maxWindow).toBe(128 * 1024);
    expect(delay.completionMs).toBe(fixed.completionMs);
    expect(delay.queueMaxMs).toBe(fixed.queueMaxMs);
  });

  it('settles at the largest window that fits mid-rate paths and does not repeat failed probes', () => {
    for (const mbps of [2.5, 4]) {
      const { fixed, delay } = compare(constant(mbps));
      expect(delay.completionMs).toBeLessThanOrEqual(fixed.completionMs);
      expect(delay.queueP95Ms - fixed.queueP95Ms).toBeLessThan(100);
      expectFreshEvidence(delay);
      // One probe per minute at most once the same window has failed.
      for (const [index, failure] of failedProbes(delay).entries()) {
        expect(failure.t).toBeGreaterThanOrEqual(index * 60_000);
      }
    }
  });

  it('leaves a low-delay path whose 128 KiB window already fills it', () => {
    const { fixed, delay } = compare(constant(50, 5, 5));
    expect(delay.completionMs).toBe(fixed.completionMs);
    expect(delay.maxWindow).toBeLessThanOrEqual(192 * 1024);
    expectFreshEvidence(delay);
  });

  it('falls back on a bandwidth collapse and regrows after recovery', () => {
    const { fixed, delay } = compare({
      rate: (t) => (t >= 8000 && t < 16_000 ? 2 * MBPS : 8 * MBPS),
      forwardMs: 100,
      returnMs: 114,
    });
    const fallBack = delay.decisions.find(({ t }) => t >= 8000)!;
    expect(fallBack.decision).toMatch(/^loop-/u);
    expect(fallBack.t - 8000).toBeLessThan(1000);
    expect(
      delay.decisions.some(({ t, decision }) => t >= 16_000 && decision === 'accepted-256'),
    ).toBe(true);
    expect(delay.completionMs).toBeLessThan(fixed.completionMs * 0.7);
    expectFreshEvidence(delay);
    // A property of this FIFO model, not a pass: data already in flight for
    // 8 Mbps drains at 2 Mbps.
    expect(delay.queueMaxMs).toBeLessThan(1000);
  });

  it('tolerates receipt jitter without false fallbacks', () => {
    const random = seeded(7);
    const { fixed, delay } = compare({
      ...constant(8),
      returnJitter: () => (random() < 0.01 ? 120 : random() * 30),
    });
    expect(delay.maxWindow).toBe(256 * 1024);
    expect(delay.completionMs).toBeLessThan(fixed.completionMs * 0.6);
    expectFreshEvidence(delay);
  });

  it('returns to 128 KiB within the evidence bound when receipts stop yielding samples', () => {
    const { fixed, delay } = compare({
      ...constant(8),
      coalesce: (t) => t >= 8000 && t < 16_000,
    });
    const shed = delay.decisions.find(({ t }) => t >= 8000)!;
    expect(shed).toMatchObject({ decision: 'evidence-sparse', windowBytes: 128 * 1024 });
    expect(shed.t - 8000).toBeLessThan(2000);
    // One receipt per chunk again: the window is earned anew, not restored.
    const after = delay.decisions.filter(({ t }) => t >= 16_000).map(({ decision }) => decision);
    expect(after).toContain('probe-192');
    expect(delay.completionMs).toBeLessThan(fixed.completionMs);
  });
});
