/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../../core/constants.ts';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { CloudflareDataConnection } from '../cloudflare-signaling.ts';

/**
 * Characterization of the machines that decide whether one Standard-room
 * CloudflareDataConnection is still alive, as they behave before Phase 4
 * moves them into one owner: the original route's 15 s disconnect grace, the
 * one-restart-per-interruption gate, the order of effects on each RTC
 * transition, and every background-resume probe outcome, including the side
 * (isolated control) PC. Only the public connection surface is used.
 */
const GRACE_MS = 15_000;
const RESUME_DISCONNECTED_PROBE_MS = 1_000;
const RESUME_LIVENESS_TIMEOUT_MS = 3_000;

class Channel extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  binaryType: BinaryType = 'arraybuffer';
  ordered = true;
  maxRetransmits: number | null = null;
  maxPacketLifeTime: number | null = null;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: Array<string | ArrayBuffer> = [];
  failSend = false;
  constructor(readonly label: string) {
    super();
  }
  send(data: string | ArrayBuffer): void {
    if (this.failSend || this.readyState !== 'open') throw new Error('native-send-failed');
    this.sent.push(data);
  }
  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class PeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = 'connected';
  localDescription: RTCSessionDescriptionInit | null = null;
  channel: Channel | null = null;
  closeCount = 0;
  close(): void {
    if (this.connectionState === 'closed') return;
    this.closeCount++;
    this.connectionState = 'closed';
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  state(value: RTCPeerConnectionState): void {
    this.connectionState = value;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: 'offer' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer' };
  }
  async setLocalDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = value;
  }
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  createDataChannel(label: string): RTCDataChannel {
    this.channel = new Channel(label);
    this.channel.readyState = 'connecting';
    return this.channel as unknown as RTCDataChannel;
  }
  remoteChannel(): void {
    this.channel = new Channel('musixquare-control-isolated');
    this.channel.readyState = 'connecting';
    this.dispatchEvent(Object.assign(new Event('datachannel'), { channel: this.channel }));
  }
}

const connections: CloudflareDataConnection[] = [];

async function flush(): Promise<void> {
  for (let index = 0; index < 24; index++) await Promise.resolve();
}

/** One open logical connection; `bound` models a restart-capable negotiation. */
async function connection(
  options: { bound?: boolean; onStateChange?: () => void; isolated?: boolean } = {},
) {
  const sidePc = new PeerConnection();
  const release = vi.fn();
  const conn = new CloudflareDataConnection(
    `peer-${connections.length}`,
    undefined,
    null,
    options.onStateChange,
    undefined,
    options.isolated ? () => ({ pc: sidePc as unknown as RTCPeerConnection, release }) : undefined,
  );
  connections.push(conn);
  if (options.bound) conn.iceRestartBinding = 'negotiation_char_000001';
  const pc = new PeerConnection();
  const bulk = new Channel('musixquare-data');
  const control = new Channel('musixquare-control');
  conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
  conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
  await flush();
  const closed = vi.fn();
  conn.on('close', closed);
  return { conn, pc, bulk, control, sidePc, release, closed };
}
type Endpoint = Awaited<ReturnType<typeof connection>>;

/** Two isolated endpoints whose side route reaches the active phase. */
async function activeSidePair() {
  const a = await connection({ isolated: true });
  const b = await connection({ isolated: true });
  for (const e of [a, b]) e.conn.startBulkFlowControl();
  let ac = 0;
  let bc = 0;
  let as = 0;
  let bs = 0;
  const pump = async () => {
    for (let round = 0; round < 12; round++) {
      while (ac < a.control.sent.length) b.control.receive(a.control.sent[ac++]);
      while (bc < b.control.sent.length) a.control.receive(b.control.sent[bc++]);
      while (as < (a.sidePc.channel?.sent.length ?? 0))
        b.sidePc.channel!.receive(a.sidePc.channel!.sent[as++]);
      while (bs < (b.sidePc.channel?.sent.length ?? 0))
        a.sidePc.channel!.receive(b.sidePc.channel!.sent[bs++]);
      await flush();
    }
  };
  await pump();
  expect(a.conn.bulkFlowControl.hasCapacity(1)).toBe(false);
  await pump();
  (a.sidePc.channel ? b : a).sidePc.remoteChannel();
  a.sidePc.channel!.open();
  b.sidePc.channel!.open();
  await pump();
  expect(a.conn.controlIsolation?.phase).toBe('active');
  expect(b.conn.controlIsolation?.phase).toBe('active');
  return { a, b, pump };
}

function probes(channel: Channel): Array<{ type: string; pingId: number }> {
  return channel.sent
    .filter((data): data is string => typeof data === 'string')
    .map((data) => JSON.parse(data) as { type: string; pingId: number })
    .filter((frame) => frame.type === MSG.SYNC_PING);
}

function pong(pingId: number): string {
  return JSON.stringify({
    type: MSG.SYNC_PONG,
    pingId,
    hostTime: Date.now(),
    position: 0,
    mode: null,
    activity: 'idle',
    queueItemId: null,
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const conn of connections.splice(0)) conn.close();
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('original-route disconnect grace', () => {
  it('closes a connection without a state callback (the host side) exactly 15 s after disconnected', async () => {
    const e = await connection();
    e.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.closed).toHaveBeenCalledOnce();
    expect(e.conn.open).toBe(false);
    expect(e.pc.connectionState).toBe('closed');
  });

  it('publishes the wall-clock deadline only for a restart-bound connection', async () => {
    const unbound = await connection();
    const bound = await connection({ bound: true });
    const start = Date.now();
    unbound.pc.state('disconnected');
    bound.pc.state('disconnected');
    expect(unbound.conn.iceRecoveryDeadline).toBe(0);
    expect(bound.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(unbound.closed).toHaveBeenCalledOnce();
    expect(bound.closed).toHaveBeenCalledOnce();
  });

  it('keeps one non-renewing deadline when disconnected turns failed on a bound connection', async () => {
    const e = await connection({ bound: true });
    const start = Date.now();
    e.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(10_000);
    e.pc.state('failed');
    e.pc.state('disconnected');
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.closed).toHaveBeenCalledOnce();
  });

  it('closes an unbound connection immediately on failed', async () => {
    const e = await connection();
    e.pc.state('failed');
    expect(e.closed).toHaveBeenCalledOnce();
    expect(e.conn.open).toBe(false);
  });

  it('measures the grace in elapsed time while publishing the deadline in wall-clock time', async () => {
    const e = await connection({ bound: true });
    const start = Date.now();
    e.pc.state('disconnected');
    // A wall-clock correction neither moves the published deadline nor the timer.
    vi.setSystemTime(start + 60_000);
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.closed).toHaveBeenCalledOnce();
  });

  it('clears the deadline on connected and grants the next interruption a fresh full grace', async () => {
    const e = await connection({ bound: true });
    const start = Date.now();
    e.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(5_000);
    e.pc.state('connected');
    expect(e.conn.iceRecoveryDeadline).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    e.pc.state('disconnected');
    expect(e.conn.iceRecoveryDeadline).toBe(start + 6_000 + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.closed).toHaveBeenCalledOnce();
  });
});

describe('original-route transition effect order', () => {
  async function traced(bound: boolean) {
    const trace: unknown[] = [];
    let conn!: CloudflareDataConnection;
    const e = await connection({
      bound,
      isolated: true,
      onStateChange: () => {
        trace.push(['state-callback', conn.iceRecoveryDeadline]);
      },
    });
    conn = e.conn;
    vi.spyOn(conn.controlIsolation!, 'mayRestart').mockImplementation(() => {
      trace.push('isolation-original-changed');
    });
    conn.on('ice-recovered', () => trace.push('ice-recovered'));
    conn.on('close', () => trace.push('close'));
    return { ...e, trace };
  }

  it('on disconnected: callback before the grace is armed, then the side route hears it', async () => {
    const e = await traced(true);
    const start = Date.now();
    e.pc.state('disconnected');
    expect(e.trace).toEqual([['state-callback', 0], 'isolation-original-changed']);
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
  });

  it('on connected: grace cleared before the callback, then side route, then ice-recovered', async () => {
    const e = await traced(true);
    e.pc.state('disconnected');
    e.trace.length = 0;
    e.pc.state('connected');
    expect(e.trace).toEqual([['state-callback', 0], 'isolation-original-changed', 'ice-recovered']);
    // A redundant connected event is not a recovery.
    e.trace.length = 0;
    e.pc.state('connected');
    expect(e.trace).toEqual([['state-callback', 0], 'isolation-original-changed']);
  });

  it('on a restartable failed: grace armed before the callback, connection kept', async () => {
    const e = await traced(true);
    const start = Date.now();
    e.pc.state('failed');
    expect(e.trace).toEqual([['state-callback', start + GRACE_MS], 'isolation-original-changed']);
    expect(e.conn.open).toBe(true);
  });

  it.each(['failed', 'closed'] as const)(
    'on a non-restartable %s: closes without the callback or the side-route notification',
    async (state) => {
      const e = await traced(false);
      e.pc.state(state);
      expect(e.trace).toEqual(['close']);
    },
  );

  it('clears a probe that saw disconnected before the callback runs on connected', async () => {
    const statuses: string[] = [];
    let conn!: CloudflareDataConnection;
    const e = await connection({
      onStateChange: () => {
        if (conn.open) statuses.push(conn.reconcileBackgroundResumeRecovery(false));
      },
    });
    conn = e.conn;
    expect(conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    e.pc.state('disconnected');
    e.pc.state('connected');
    expect(statuses).toEqual(['monitoring', 'not-applicable']);
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS);
    expect(conn.open).toBe(true);
  });
});

describe('bounded ICE restart gate', () => {
  it('admits one restart per interruption, only for an open restart-bound connection', async () => {
    const unbound = await connection();
    expect(unbound.conn.beginIceRestart()).toBe(false);

    const pending = new CloudflareDataConnection('not-open');
    connections.push(pending);
    pending.iceRestartBinding = 'negotiation_char_000002';
    expect(pending.beginIceRestart()).toBe(false);

    const e = await connection({ bound: true });
    e.pc.state('disconnected');
    expect(e.conn.beginIceRestart()).toBe(true);
    expect(e.conn.beginIceRestart()).toBe(false);
    e.conn.finishIceRestart();
    expect(e.conn.beginIceRestart()).toBe(true);
    e.conn.close();
    expect(e.conn.beginIceRestart()).toBe(false);
  });

  it('reopens the gate on connected', async () => {
    const e = await connection({ bound: true });
    e.pc.state('disconnected');
    expect(e.conn.beginIceRestart()).toBe(true);
    e.pc.state('connected');
    e.pc.state('disconnected');
    expect(e.conn.beginIceRestart()).toBe(true);
  });

  it('does not move the deadline when a restart begins after disconnected', async () => {
    const e = await connection({ bound: true });
    const start = Date.now();
    e.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(e.conn.beginIceRestart()).toBe(true);
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 4_000);
    expect(e.closed).toHaveBeenCalledOnce();
  });

  it('arms one grace for a restart on a still-connected route that cannot close it', async () => {
    // The host answers a guest's restart even while its own PC reads connected.
    const e = await connection({ bound: true });
    const start = Date.now();
    expect(e.conn.beginIceRestart()).toBe(true);
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(e.conn.open).toBe(true);
    // Only a transition clears the published value; the fired timer does not.
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(5_000);
    e.pc.state('disconnected');
    expect(e.conn.iceRecoveryDeadline).toBe(start + 20_000 + GRACE_MS);
  });
});

describe('background-resume probe outcomes without a side route', () => {
  it.each([
    { hiddenMs: GRACE_MS - 1, status: 'not-applicable' },
    { hiddenMs: Number.NaN, status: 'not-applicable' },
    { hiddenMs: Number.POSITIVE_INFINITY, status: 'not-applicable' },
    { hiddenMs: GRACE_MS, status: 'monitoring' },
  ])('returns $status for a connected route hidden $hiddenMs ms', async ({ hiddenMs, status }) => {
    const e = await connection();
    expect(e.conn.recoverAfterBackground(hiddenMs, false)).toBe(status);
    expect(probes(e.control)).toHaveLength(status === 'monitoring' ? 1 : 0);
  });

  it('is not applicable to a closed connection', async () => {
    const e = await connection();
    e.conn.close();
    expect(e.conn.recoverAfterBackground(60_000, true)).toBe('not-applicable');
  });

  it('sends one control-lane challenge and closes exactly 3 s later without its pong', async () => {
    const e = await connection();
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    expect(probes(e.control)).toEqual([
      expect.objectContaining({ type: MSG.SYNC_PING, pingId: expect.any(Number) }),
    ]);
    expect(e.bulk.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.closed).toHaveBeenCalledOnce();
  });

  it('accepts only the latest challenge after a second resume and restarts its 3 s window', async () => {
    const e = await connection();
    e.conn.recoverAfterBackground(60_000, false);
    await vi.advanceTimersByTimeAsync(2_000);
    e.conn.recoverAfterBackground(60_000, false);
    const [first, second] = probes(e.control);
    expect(second!.pingId).not.toBe(first!.pingId);
    e.control.receive(pong(first!.pingId));
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.closed).toHaveBeenCalledOnce();
  });

  it('keeps the connection once the exact pong arrives', async () => {
    const e = await connection();
    e.conn.recoverAfterBackground(60_000, false);
    e.control.receive(pong(probes(e.control)[0]!.pingId));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(e.conn.open).toBe(true);
  });

  it('gives a disconnected route one 1 s probe while signaling is up', async () => {
    const e = await connection();
    e.pc.connectionState = 'disconnected';
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    expect(probes(e.control)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.closed).toHaveBeenCalledOnce();
  });

  it('keeps waiting for the pong after the 1 s probe when the route silently reads connected', async () => {
    const e = await connection();
    e.pc.connectionState = 'disconnected';
    e.conn.recoverAfterBackground(60_000, false);
    e.pc.connectionState = 'connected';
    await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS - RESUME_DISCONNECTED_PROBE_MS);
    expect(e.closed).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'a disconnected route with signaling lost',
      arrange: (e: Endpoint) => (e.pc.connectionState = 'disconnected'),
      signalingDisconnected: true,
    },
    {
      name: 'a failed route',
      arrange: (e: Endpoint) => (e.pc.connectionState = 'failed'),
      signalingDisconnected: false,
    },
    {
      name: 'a closed route',
      arrange: (e: Endpoint) => (e.pc.connectionState = 'closed'),
      signalingDisconnected: false,
    },
    {
      name: 'a bulk channel that is not open',
      arrange: (e: Endpoint) => (e.bulk.readyState = 'closing'),
      signalingDisconnected: false,
    },
    {
      name: 'a control channel that is not open',
      arrange: (e: Endpoint) => (e.control.readyState = 'closing'),
      signalingDisconnected: false,
    },
    {
      name: 'a challenge that cannot be sent',
      arrange: (e: Endpoint) => (e.control.failSend = true),
      signalingDisconnected: false,
    },
  ])('closes immediately for $name', async ({ arrange, signalingDisconnected }) => {
    const e = await connection();
    arrange(e);
    expect(e.conn.recoverAfterBackground(60_000, signalingDisconnected)).toBe(
      'stale-connection-closed',
    );
    expect(e.closed).toHaveBeenCalledOnce();
    expect(e.conn.open).toBe(false);
  });
});

describe('background-resume probe outcomes with an active side route', () => {
  it('closes when the active side channel is no longer open', async () => {
    const { a } = await activeSidePair();
    a.sidePc.channel!.readyState = 'closing';
    expect(a.conn.recoverAfterBackground(60_000, false)).toBe('stale-connection-closed');
    expect(a.closed).toHaveBeenCalledOnce();
    expect(a.release).toHaveBeenCalledOnce();
  });

  it('keeps the probe through an original disconnected→connected and needs the exact pong', async () => {
    const { a } = await activeSidePair();
    expect(a.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    // The challenge travels on the active side route, not the original lane.
    const [challenge] = probes(a.sidePc.channel!);
    expect(challenge).toBeDefined();
    a.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(500);
    a.pc.state('connected');
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS - 500 - 1);
    expect(a.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.closed).toHaveBeenCalledOnce();
  });

  it('keeps the connection when the exact pong follows an original disconnected→connected', async () => {
    const { a } = await activeSidePair();
    a.conn.recoverAfterBackground(60_000, false);
    const [challenge] = probes(a.sidePc.channel!);
    a.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(500);
    a.pc.state('connected');
    a.sidePc.channel!.receive(pong(challenge!.pingId));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.conn.open).toBe(true);
  });

  it('lets a side route that recovers inside the 1 s probe wait for the pong', async () => {
    const { a } = await activeSidePair();
    a.sidePc.state('disconnected');
    expect(a.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    a.sidePc.state('connected');
    await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS);
    expect(a.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS - RESUME_DISCONNECTED_PROBE_MS);
    expect(a.closed).toHaveBeenCalledOnce();
  });

  it('closes a side route still disconnected when the 1 s probe ends', async () => {
    const { a } = await activeSidePair();
    a.sidePc.state('disconnected');
    expect(a.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS - 1);
    expect(a.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.closed).toHaveBeenCalledOnce();
  });

  it('closes immediately for a disconnected side route when signaling is lost', async () => {
    const { a } = await activeSidePair();
    a.sidePc.state('disconnected');
    expect(a.conn.recoverAfterBackground(60_000, true)).toBe('stale-connection-closed');
    expect(a.closed).toHaveBeenCalledOnce();
  });
});
