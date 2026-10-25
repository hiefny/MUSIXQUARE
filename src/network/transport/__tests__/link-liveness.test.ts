/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MSG } from '../../../core/constants.ts';
import { log } from '../../../core/log.ts';
import { clearAllManagedTimers, clearManagedTimer, getManagedTimer } from '../../../core/timers.ts';
import { CloudflareDataConnection } from '../cloudflare-signaling.ts';
import { LinkLiveness } from '../link-liveness.ts';
import {
  isBulkWritable,
  isRecoverablyInterrupted,
  readTransportHealth,
} from '../../transport-health.ts';

/**
 * The original route's outage owner (registry RO-15, Phase 4 C5-6): the 15 s
 * grace, the published wall-clock recovery deadline and the one-restart gate
 * of one Standard-room logical data connection. These cases pin, through the
 * public connection surface, what the move must keep: the order of every
 * transition's effects (also when the state callback re-enters the gate or
 * closes the connection), the pre-open grace, the non-renewing deadline
 * across restarts, and the host-side connection that has no state callback.
 */
const GRACE_MS = 15_000;
const RESUME_LIVENESS_TIMEOUT_MS = 3_000;
const RESUME_DISCONNECTED_PROBE_MS = 1_000;

class Channel extends EventTarget {
  binaryType: BinaryType = 'arraybuffer';
  // A reliable ordered channel, which the isolated control side route requires.
  ordered = true;
  maxRetransmits: number | null = null;
  maxPacketLifeTime: number | null = null;
  sent: Array<string | ArrayBuffer> = [];
  constructor(
    readonly label: string,
    public readyState: RTCDataChannelState = 'open',
  ) {
    super();
  }
  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('native-send-failed');
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
  /** A side PC's isolated control channel, once created or received. */
  channel: Channel | null = null;
  close(): void {
    if (this.connectionState === 'closed') return;
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
    this.channel = new Channel(label, 'connecting');
    return this.channel as unknown as RTCDataChannel;
  }
  remoteChannel(): void {
    this.channel = new Channel('musixquare-control-isolated', 'connecting');
    this.dispatchEvent(Object.assign(new Event('datachannel'), { channel: this.channel }));
  }
}

const connections: CloudflareDataConnection[] = [];

async function flush(): Promise<void> {
  for (let index = 0; index < 24; index++) await Promise.resolve();
}

type Trace = unknown[];

/**
 * One logical connection. `bound` models a restart-capable negotiation,
 * `opened: false` keeps both channels connecting, and `onStateChange` is the
 * state callback a guest connection gets (a host connection gets none).
 */
async function connection(
  options: {
    bound?: boolean;
    opened?: boolean;
    onStateChange?: (conn: CloudflareDataConnection, trace: Trace) => void;
  } = {},
) {
  const trace: Trace = [];
  let conn!: CloudflareDataConnection;
  const callback = options.onStateChange;
  conn = new CloudflareDataConnection(
    `peer-${connections.length}`,
    undefined,
    null,
    callback ? () => callback(conn, trace) : undefined,
    undefined,
    // A control-isolated connection, so the side route's notification can be
    // observed; its side PC is never created before bulk flow control starts.
    () => null,
  );
  connections.push(conn);
  if (options.bound) conn.iceRestartBinding = 'negotiation_liveness_01';
  const channelState: RTCDataChannelState = options.opened === false ? 'connecting' : 'open';
  const pc = new PeerConnection();
  const bulk = new Channel('musixquare-data', channelState);
  const control = new Channel('musixquare-control', channelState);
  conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
  conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
  await flush();
  vi.spyOn(conn.controlIsolation!, 'originalChanged').mockImplementation(() => {
    trace.push('side');
  });
  conn.on('ice-recovered', () => trace.push('ice-recovered'));
  conn.on('close', () => trace.push('close'));
  return { conn, pc, bulk, control, trace };
}

let closeLines: () => string[];

/** Silences info logging and reads back only the close-cause lines. */
function spyCloseCauseLines(): () => string[] {
  const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
  return () =>
    info.mock.calls
      .map(([line]) => line)
      .filter(
        (line): line is string =>
          typeof line === 'string' && line.startsWith('[Transport] Logical connection closed'),
      );
}

/**
 * The armed managed timers of every connection made so far, by their key: the
 * grace (`cloudflare-data-disconnected-grace-N`) and its two probe suffixes.
 */
function armedLinkTimerKeys(): string[] {
  const keys: string[] = [];
  for (let sequence = 1; sequence <= 10_000; sequence++) {
    const grace = `cloudflare-data-disconnected-grace-${sequence}`;
    for (const key of [
      grace,
      `${grace}-background-resume-liveness`,
      `${grace}-background-resume-disconnected`,
    ]) {
      if (getManagedTimer(key) !== null) keys.push(key);
    }
  }
  return keys;
}

beforeEach(() => {
  vi.useFakeTimers();
  closeLines = spyCloseCauseLines();
});
afterEach(() => {
  for (const conn of connections.splice(0)) conn.close();
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('original-route transitions with a re-entrant state callback', () => {
  it('on connected: grace cleared, gate reopened and probe settled before the callback, then side route, then ice-recovered', async () => {
    let recording = false;
    const e = await connection({
      bound: true,
      onStateChange: (conn, trace) => {
        if (!recording) return;
        // Read the deadline first: beginIceRestart arms a fresh grace.
        trace.push([
          'callback',
          conn.iceRecoveryDeadline,
          conn.reconcileBackgroundResumeRecovery(false),
          conn.beginIceRestart(),
        ]);
      },
    });
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    e.pc.state('disconnected');
    expect(e.conn.beginIceRestart()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    e.trace.length = 0;
    recording = true;
    const recoveredAt = Date.now();
    e.pc.state('connected');
    expect(e.trace).toEqual([['callback', 0, 'not-applicable', true], 'side', 'ice-recovered']);
    // The restart begun inside the callback armed one grace on the still-connected route.
    expect(e.conn.iceRecoveryDeadline).toBe(recoveredAt + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(e.conn.open).toBe(true);
  });

  it('on connected: a callback that closes the connection still notifies the side route but emits no recovery', async () => {
    let recording = false;
    const e = await connection({
      bound: true,
      onStateChange: (conn, trace) => {
        if (!recording) return;
        trace.push('callback');
        conn.close();
      },
    });
    e.pc.state('disconnected');
    e.trace.length = 0;
    recording = true;
    e.pc.state('connected');
    expect(e.trace).toEqual(['callback', 'close', 'side']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (intentional) for peer-0',
    ]);
  });

  it('on disconnected: a restart begun in the callback publishes the deadline before the side route hears it', async () => {
    const e = await connection({
      bound: true,
      onStateChange: (conn, trace) => {
        trace.push([
          'callback',
          conn.iceRecoveryDeadline,
          conn.beginIceRestart(),
          conn.iceRecoveryDeadline,
        ]);
      },
    });
    const start = Date.now();
    e.pc.state('disconnected');
    expect(e.trace).toEqual([['callback', 0, true, start + GRACE_MS], 'side']);
    // The listener's own grace does not re-arm or extend the restart's.
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.trace.at(-1)).toBe('close');
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (original-grace-expired) for peer-0',
    ]);
  });

  it('on disconnected: the grace is armed and published before the side route hears it', async () => {
    const e = await connection({
      bound: true,
      onStateChange: (conn, trace) => trace.push(['callback', conn.iceRecoveryDeadline]),
    });
    vi.spyOn(e.conn.controlIsolation!, 'originalChanged').mockImplementation(() => {
      e.trace.push(['side', e.conn.iceRecoveryDeadline, armedLinkTimerKeys().length]);
    });
    const start = Date.now();
    e.pc.state('disconnected');
    expect(e.trace).toEqual([
      ['callback', 0],
      ['side', start + GRACE_MS, 1],
    ]);
  });

  it('on disconnected: a callback that closes the connection arms no grace and skips the side route', async () => {
    const e = await connection({
      bound: true,
      onStateChange: (conn, trace) => {
        trace.push('callback');
        conn.close();
      },
    });
    e.pc.state('disconnected');
    expect(e.trace).toEqual(['callback', 'close']);
    expect(e.conn.iceRecoveryDeadline).toBe(0);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(e.trace).toEqual(['callback', 'close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (intentional) for peer-0',
    ]);
  });

  it('on a restartable failed: the grace is armed before the callback, whose restart keeps that deadline', async () => {
    const e = await connection({
      bound: true,
      onStateChange: (conn, trace) => {
        trace.push(['callback', conn.iceRecoveryDeadline, conn.beginIceRestart()]);
      },
    });
    const start = Date.now();
    e.pc.state('failed');
    expect(e.trace).toEqual([['callback', start + GRACE_MS, true], 'side']);
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    expect(e.conn.open).toBe(true);
  });

  it.each(['failed', 'closed'] as const)(
    'on a non-restartable %s: closes as original-terminal without the callback or the side route',
    async (state) => {
      const e = await connection({ onStateChange: (_conn, trace) => trace.push('callback') });
      e.pc.state(state);
      expect(e.trace).toEqual(['close']);
      expect(closeLines()).toEqual([
        '[Transport] Logical connection closed (original-terminal) for peer-0',
      ]);
    },
  );

  it('ignores the transitional states', async () => {
    const e = await connection({
      bound: true,
      onStateChange: (_conn, trace) => trace.push('callback'),
    });
    e.pc.state('new');
    e.pc.state('connecting');
    expect(e.trace).toEqual([]);
    expect(e.conn.iceRecoveryDeadline).toBe(0);
  });
});

describe("the connection's managed timer keys", () => {
  it('names the grace cloudflare-data-disconnected-grace-N, numbered per connection, and the two probe timers after it', async () => {
    const first = await connection({ bound: true });
    first.pc.state('disconnected');
    const [graceKey] = armedLinkTimerKeys();
    const sequence = Number(/^cloudflare-data-disconnected-grace-(\d+)$/u.exec(graceKey!)?.[1]);
    expect(Number.isSafeInteger(sequence)).toBe(true);
    expect(armedLinkTimerKeys()).toEqual([graceKey]);

    const second = await connection();
    second.pc.connectionState = 'disconnected';
    expect(second.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    second.pc.state('disconnected');
    const next = `cloudflare-data-disconnected-grace-${sequence + 1}`;
    expect(armedLinkTimerKeys()).toEqual([
      graceKey,
      next,
      `${next}-background-resume-liveness`,
      `${next}-background-resume-disconnected`,
    ]);
  });
});

describe('original-route grace before the link opens', () => {
  it('arms the grace on disconnected and closes exactly 15 s later', async () => {
    const e = await connection({ bound: true, opened: false });
    const start = Date.now();
    e.pc.state('disconnected');
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    expect(e.trace).toEqual(['side']);
    // The restart gate needs an open link.
    expect(e.conn.beginIceRestart()).toBe(false);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(e.trace).toEqual(['side']);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.trace).toEqual(['side', 'close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (original-grace-expired) for peer-0',
    ]);
  });

  it('cancels the pre-open grace on connected and lets the link open afterwards', async () => {
    const e = await connection({ bound: true, opened: false });
    e.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(5_000);
    e.pc.state('connected');
    expect(e.conn.iceRecoveryDeadline).toBe(0);
    // Not open yet: the interruption is not reported as a recovery.
    expect(e.trace).toEqual(['side', 'side']);
    e.bulk.open();
    e.control.open();
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(e.conn.open).toBe(true);
    expect(e.trace).toEqual(['side', 'side']);
  });

  it('closes a bound link that fails before it opens', async () => {
    const e = await connection({ bound: true, opened: false });
    e.pc.state('failed');
    expect(e.trace).toEqual(['close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (original-terminal) for peer-0',
    ]);
  });
});

describe('non-renewing deadline across restarts', () => {
  it('keeps the first deadline through restart, failed, finish and a second restart', async () => {
    const e = await connection({ bound: true });
    const start = Date.now();
    e.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(e.conn.beginIceRestart()).toBe(true);
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(3_000);
    e.pc.state('failed');
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    e.conn.finishIceRestart();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(e.conn.beginIceRestart()).toBe(true);
    expect(e.conn.beginIceRestart()).toBe(false);
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 9_000 - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.trace.filter((entry) => entry === 'close')).toHaveLength(1);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (original-grace-expired) for peer-0',
    ]);
  });

  it('gives an interruption that starts inside a connected restart only its remaining grace', async () => {
    // A host answers a guest restart while its own PC still reads connected.
    const e = await connection({ bound: true });
    const start = Date.now();
    expect(e.conn.beginIceRestart()).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    e.pc.state('disconnected');
    // The restart's grace is still armed: the interruption keeps its deadline.
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 3_000);
    expect(e.trace.at(-1)).toBe('close');
  });

  it('withholds the deadline from an unbound link while its grace still runs', async () => {
    const e = await connection();
    e.pc.state('disconnected');
    expect(e.conn.iceRecoveryDeadline).toBe(0);
    e.conn.iceRestartBinding = 'negotiation_liveness_02';
    expect(e.conn.iceRecoveryDeadline).toBeGreaterThan(0);
  });
});

describe('host-side connection without a state callback', () => {
  it('closes exactly 15 s after disconnected, through an in-place restart answer', async () => {
    const e = await connection({ bound: true });
    const start = Date.now();
    e.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(2_000);
    // The host answers the guest's restart offer: the gate admits it once.
    expect(e.conn.beginIceRestart()).toBe(true);
    e.conn.finishIceRestart();
    expect(e.conn.iceRecoveryDeadline).toBe(start + GRACE_MS);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 2_000 - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.trace).toEqual(['side', 'close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (original-grace-expired) for peer-0',
    ]);
  });

  it('keeps the link when the route recovers inside the grace and reports one recovery', async () => {
    const e = await connection({ bound: true });
    e.pc.state('disconnected');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    e.pc.state('connected');
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(e.conn.open).toBe(true);
    expect(e.trace).toEqual(['side', 'side', 'ice-recovered']);
  });

  it('settles a resume probe on a genuine disconnected to connected transition', async () => {
    const e = await connection();
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    e.pc.state('disconnected');
    e.pc.state('connected');
    // A genuine disconnected -> connected transition settled the probe.
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS);
    expect(e.conn.open).toBe(true);
  });
});

/** The SYNC_PING challenges a channel carried, by ping id. */
function pings(channel: Channel): number[] {
  return channel.sent
    .filter((data): data is string => typeof data === 'string')
    .map((data) => JSON.parse(data) as { type: string; pingId: number })
    .filter((frame) => frame.type === MSG.SYNC_PING)
    .map((frame) => frame.pingId);
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

/** A connection with an isolated control side PC that the test drives. */
async function isolated(onStateChange?: (conn: CloudflareDataConnection, trace: Trace) => void) {
  const trace: Trace = [];
  const sidePc = new PeerConnection();
  const release = vi.fn();
  let conn!: CloudflareDataConnection;
  conn = new CloudflareDataConnection(
    `peer-${connections.length}`,
    undefined,
    null,
    onStateChange ? () => onStateChange(conn, trace) : undefined,
    undefined,
    () => ({ pc: sidePc as unknown as RTCPeerConnection, release }),
  );
  connections.push(conn);
  const pc = new PeerConnection();
  const bulk = new Channel('musixquare-data');
  const control = new Channel('musixquare-control');
  conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
  conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
  await flush();
  conn.on('close', () => trace.push('close'));
  return { conn, pc, bulk, control, sidePc, release, trace };
}

/** Two isolated endpoints whose side route reaches the active phase; `a` is peer-0. */
async function activeSidePair(
  onStateChange?: (conn: CloudflareDataConnection, trace: Trace) => void,
) {
  const a = await isolated(onStateChange);
  const b = await isolated();
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
  // The side PC is demand-driven: a bulk send that must wait creates it.
  expect(a.conn.bulkFlowControl.hasCapacity(1)).toBe(false);
  await pump();
  (a.sidePc.channel ? b : a).sidePc.remoteChannel();
  a.sidePc.channel!.open();
  b.sidePc.channel!.open();
  await pump();
  expect(a.conn.controlIsolation?.phase).toBe('active');
  expect(b.conn.controlIsolation?.phase).toBe('active');
  return { a, b };
}

/**
 * The guest background-resume probe (Phase 4 C5-7 moves it into the
 * link-liveness owner) reads both PCs and their channels, including the
 * isolated control side PC. WebKit can report a state that changed while the
 * page was suspended before it delivers the event, so most cases mutate the
 * state silently and let the probe read it.
 */
describe('background-resume probe across both routes', () => {
  it.each(['failed', 'closed'] as const)(
    'closes as resume-stale before any challenge when the side PC reads %s at resume',
    async (state) => {
      const { a } = await activeSidePair();
      a.sidePc.connectionState = state;
      expect(a.conn.recoverAfterBackground(60_000, false)).toBe('stale-connection-closed');
      expect(pings(a.sidePc.channel!)).toEqual([]);
      expect(pings(a.control)).toEqual([]);
      expect(a.trace).toEqual(['close']);
      expect(a.release).toHaveBeenCalledOnce();
      expect(closeLines()).toEqual([
        '[Transport] Logical connection closed (resume-stale) for peer-0',
      ]);
    },
  );

  it('closes as resume-stale when the active side channel does not read open', async () => {
    const { a } = await activeSidePair();
    a.sidePc.channel!.readyState = 'closing';
    expect(a.conn.recoverAfterBackground(60_000, false)).toBe('stale-connection-closed');
    expect(a.trace).toEqual(['close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (resume-stale) for peer-0',
    ]);
  });

  it('closes at once as resume-stale for a disconnected side PC when signaling is lost', async () => {
    const { a } = await activeSidePair();
    a.sidePc.connectionState = 'disconnected';
    expect(a.conn.recoverAfterBackground(60_000, true)).toBe('stale-connection-closed');
    expect(pings(a.sidePc.channel!)).toEqual([]);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (resume-stale) for peer-0',
    ]);
  });

  it('closes a side PC still disconnected after the 1 s probe as resume-disconnected', async () => {
    const { a } = await activeSidePair();
    a.sidePc.connectionState = 'disconnected';
    expect(a.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    // The challenge still goes out on the side route.
    expect(pings(a.sidePc.channel!)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS - 1);
    expect(a.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.trace).toEqual(['close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (resume-disconnected) for peer-0',
    ]);
  });

  it('closes the 1 s probe as resume-disconnected when the side recovers but the original reads disconnected', async () => {
    const { a } = await activeSidePair();
    a.sidePc.connectionState = 'disconnected';
    expect(a.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    a.sidePc.connectionState = 'connected';
    a.pc.connectionState = 'disconnected';
    await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS);
    expect(a.trace).toEqual(['close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (resume-disconnected) for peer-0',
    ]);
  });

  it('closes the 1 s probe as resume-disconnected when the side recovers but an original channel no longer reads open', async () => {
    const { a } = await activeSidePair();
    a.sidePc.connectionState = 'disconnected';
    expect(a.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    a.sidePc.connectionState = 'connected';
    a.bulk.readyState = 'closing';
    await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS);
    expect(a.trace).toEqual(['close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (resume-disconnected) for peer-0',
    ]);
  });

  it('keeps waiting after the 1 s probe once both routes read connected and open, and the exact side pong keeps the link', async () => {
    const { a } = await activeSidePair();
    a.sidePc.connectionState = 'disconnected';
    expect(a.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    a.sidePc.connectionState = 'connected';
    await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS);
    expect(a.conn.open).toBe(true);
    const [pingId] = pings(a.sidePc.channel!);
    a.sidePc.channel!.receive(pong(pingId!));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.conn.open).toBe(true);
    expect(closeLines()).toEqual([]);
  });

  it('keeps the probe through an original disconnected→connected and closes as resume-probe-unanswered without the exact pong', async () => {
    const { a } = await activeSidePair();
    expect(a.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    // The challenge travels on the active side route, not the original lane.
    const [pingId] = pings(a.sidePc.channel!);
    expect(pings(a.control)).toEqual([]);
    a.pc.state('disconnected');
    a.pc.state('connected');
    // A pong for another challenge proves nothing.
    a.sidePc.channel!.receive(pong(pingId! + 1));
    await flush();
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS - 1);
    expect(a.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(a.trace).toEqual(['close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (resume-probe-unanswered) for peer-0',
    ]);
  });

  it('closes as resume-stale inside an original disconnected when the side PC reads failed: before the state callback, arming no grace', async () => {
    let recording = false;
    const { a } = await activeSidePair((conn, trace) => {
      if (recording) trace.push(['callback', conn.open, conn.iceRecoveryDeadline]);
    });
    a.conn.iceRestartBinding = 'negotiation_liveness_05';
    expect(a.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    recording = true;
    a.sidePc.connectionState = 'failed';
    a.pc.state('disconnected');
    expect(a.trace).toEqual(['close', ['callback', false, 0]]);
    expect(a.conn.iceRecoveryDeadline).toBe(0);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(a.trace).toEqual(['close', ['callback', false, 0]]);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (resume-stale) for peer-0',
    ]);
  });
});

describe('background-resume probe on the original route', () => {
  it('settles the probe with the exact pong on the bulk lane as well', async () => {
    const e = await connection();
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    const [pingId] = pings(e.control);
    e.bulk.receive(pong(pingId!));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(e.conn.open).toBe(true);
    expect(closeLines()).toEqual([]);
  });

  it('restarts the 1 s probe when a second resume finds the route still disconnected', async () => {
    const e = await connection();
    e.pc.connectionState = 'disconnected';
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    await vi.advanceTimersByTimeAsync(500);
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.trace).toEqual(['close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (resume-disconnected) for peer-0',
    ]);
  });

  it('keeps a running 1 s look on its first deadline when a second resume reads the route connected', async () => {
    const e = await connection();
    e.pc.connectionState = 'disconnected';
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    await vi.advanceTimersByTimeAsync(400);
    e.pc.connectionState = 'connected';
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    // WebKit reports disconnected again without an event.
    e.pc.connectionState = 'disconnected';
    await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS - 400 - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.trace).toEqual(['close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (resume-disconnected) for peer-0',
    ]);
  });

  it('does not let a connected event settle the probe of a second resume that read connected', async () => {
    const settled = await connection();
    settled.pc.connectionState = 'disconnected';
    expect(settled.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    settled.pc.state('connected');
    // One resume that saw disconnected: the connected event settles its probe.
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS);
    expect(settled.conn.open).toBe(true);

    const e = await connection();
    e.pc.connectionState = 'disconnected';
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    e.pc.connectionState = 'connected';
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    e.pc.state('connected');
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.trace).toEqual(['side', 'close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (resume-probe-unanswered) for peer-1',
    ]);
  });

  it('keeps a link whose grace fired against a stale connected read until the probe window ends', async () => {
    const e = await connection({ bound: true });
    e.pc.state('disconnected');
    // WebKit kept reporting connected through the suspension; the grace that
    // fires on return reads that value and closes nothing.
    e.pc.connectionState = 'connected';
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(e.conn.open).toBe(true);
    expect(e.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS - 1);
    expect(e.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(e.trace).toEqual(['side', 'close']);
    expect(closeLines()).toEqual([
      '[Transport] Logical connection closed (resume-probe-unanswered) for peer-0',
    ]);
  });
});

/**
 * Phase 4 C5-8: transport health reads the owner's view of the original route
 * on a Standard-room connection (the bulk lanes, the preload pause and the
 * heartbeat lease). The side route keeps its own outage (RO-35), so it never
 * blocks bulk or pauses preload.
 */
describe('the original route as transport health reads it', () => {
  it('keeps bulk writable and counts no interruption through a side-only outage', async () => {
    const { a } = await activeSidePair();
    a.sidePc.state('disconnected');
    const health = readTransportHealth(a.conn);
    expect(a.conn.linkLiveness.phase).toBe('live');
    expect(isBulkWritable(health)).toBe(true);
    expect(isRecoverablyInterrupted(health)).toBe(false);
    expect(a.conn.open).toBe(true);
  });

  it('reads opening, live, recovering through a restart that reads connecting, live, then closed', async () => {
    const e = await connection({ bound: true, opened: false });
    expect(e.conn.linkLiveness.phase).toBe('opening');
    e.bulk.open();
    e.control.open();
    expect(e.conn.open).toBe(true);
    expect(e.conn.linkLiveness.phase).toBe('live');
    expect(isBulkWritable(readTransportHealth(e.conn))).toBe(true);

    e.pc.state('disconnected');
    expect(e.conn.linkLiveness.phase).toBe('recovering');
    expect(readTransportHealth(e.conn).recoveryDeadline).toBe(Date.now() + GRACE_MS);
    expect(e.conn.linkLiveness.recoveryDeadline).toBe(e.conn.iceRecoveryDeadline);
    expect(e.conn.beginIceRestart()).toBe(true);
    e.pc.state('connecting');
    const restarting = readTransportHealth(e.conn);
    expect(restarting.link).toBe('recovering');
    expect(isBulkWritable(restarting)).toBe(false);
    expect(isRecoverablyInterrupted(restarting)).toBe(true);

    e.pc.state('connected');
    expect(e.conn.linkLiveness.phase).toBe('live');
    expect(isBulkWritable(readTransportHealth(e.conn))).toBe(true);
    expect(e.trace).toEqual(['side', 'side', 'ice-recovered']);

    e.conn.close();
    expect(e.conn.linkLiveness.phase).toBe('closed');
    expect(isBulkWritable(readTransportHealth(e.conn))).toBe(false);
  });

  it('reads live once an interrupted route reads connected without its event', async () => {
    const e = await connection({ bound: true });
    e.pc.state('disconnected');
    // The owner's own grace closes nothing on that read either.
    e.pc.connectionState = 'connected';
    expect(e.conn.linkLiveness.phase).toBe('live');
    expect(isBulkWritable(readTransportHealth(e.conn))).toBe(true);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(e.conn.open).toBe(true);
  });

  it('stays live through a restart begun on a connected route, whose lease it still publishes', async () => {
    const e = await connection({ bound: true });
    expect(e.conn.beginIceRestart()).toBe(true);
    const health = readTransportHealth(e.conn);
    expect(health.link).toBe('live');
    expect(health.recoveryDeadline).toBe(Date.now() + GRACE_MS);
    expect(isBulkWritable(health)).toBe(true);
  });
});

/**
 * One close per logical connection, whoever reports it (Phase 4 C5-10 keeps
 * this while every close moves behind the owner): the first cause is the only
 * line, the owner reads closed from that close on, and a close re-entered
 * while the connection disposes its channels still emits `close` at the same
 * point, before the later channel and the PC are closed.
 */
describe('one close per link, whoever reports it', () => {
  it('emits close once while disposing, when the first disposed channel re-enters, and logs only the first cause', async () => {
    const e = await connection({ bound: true });
    const atClose: unknown[] = [];
    e.conn.on('close', () =>
      atClose.push([
        e.bulk.readyState,
        e.control.readyState,
        e.pc.connectionState,
        e.conn.linkLiveness.phase,
      ]),
    );
    e.conn.close('leave');
    expect(atClose).toEqual([['closed', 'open', 'connected', 'closed']]);
    expect(e.trace).toEqual(['close']);
    expect([e.bulk.readyState, e.control.readyState, e.pc.connectionState]).toEqual([
      'closed',
      'closed',
      'closed',
    ]);
    expect(closeLines()).toEqual(['[Transport] Logical connection closed (leave) for peer-0']);
  });

  type Link = Awaited<ReturnType<typeof connection>>;
  const reporters: ReadonlyArray<{ name: string; cause: string; close: (e: Link) => unknown }> = [
    { name: 'a channel', cause: 'channel-closed', close: (e) => e.control.close() },
    { name: 'the provider', cause: 'peer-left', close: (e) => e.conn.close('peer-left') },
    { name: 'the original route', cause: 'original-terminal', close: (e) => e.pc.state('closed') },
    {
      name: 'the grace',
      cause: 'original-grace-expired',
      close: () => vi.advanceTimersByTimeAsync(GRACE_MS),
    },
  ];

  it.each(reporters)(
    'closes once as $cause when $name reports first, and later reporters add nothing',
    async ({ cause, close }) => {
      const e = await connection({ bound: true });
      e.pc.state('disconnected');
      expect(e.conn.linkLiveness.recoveryDeadline).toBe(Date.now() + GRACE_MS);
      e.trace.length = 0;
      await close(e);
      expect(e.conn.open).toBe(false);
      expect(e.conn.linkLiveness.phase).toBe('closed');
      expect(e.conn.linkLiveness.recoveryDeadline).toBe(0);
      expect(e.conn.beginIceRestart()).toBe(false);
      expect(e.conn.recoverAfterBackground(60_000, false)).toBe('not-applicable');
      e.conn.close('leave');
      e.bulk.close();
      e.control.close();
      e.pc.state('failed');
      await vi.advanceTimersByTimeAsync(2 * GRACE_MS);
      expect(e.trace).toEqual(['close']);
      expect(closeLines()).toEqual([`[Transport] Logical connection closed (${cause}) for peer-0`]);
    },
  );
});

/**
 * The owner on its own: every port call in order, so a transition that
 * reorders, drops or adds an effect fails here before any connection test.
 */
describe('LinkLiveness ports', () => {
  const KEY = 'cloudflare-data-disconnected-grace-test';

  function owner(options: { open?: boolean; bound?: boolean } = {}) {
    const trace: unknown[] = [];
    let open = options.open ?? true;
    let route: PeerConnection | undefined = new PeerConnection();
    let reenter: ((liveness: LinkLiveness) => void) | null = null;
    let sideHook: (() => void) | null = null;
    // What the resume probe reads (C5-7): the side PC and the channels.
    const link = {
      side: undefined as PeerConnection | undefined,
      channelsOpen: true,
      sideChannelDown: false,
      pingFails: false,
    };
    const liveness: LinkLiveness = new LinkLiveness(KEY, {
      route: () => route as unknown as RTCPeerConnection | undefined,
      open: () => open,
      snapshot: () => {
        trace.push(['snapshot', liveness.recoveryDeadline]);
        return {
          original: route as unknown as RTCPeerConnection | undefined,
          side: link.side as unknown as RTCPeerConnection | undefined,
          channelsOpen: link.channelsOpen,
          sideChannelDown: link.sideChannelDown,
        };
      },
      ping: (pingId) => {
        trace.push(['ping', pingId]);
        if (link.pingFails) throw new Error('native-send-failed');
      },
      close: (cause) => {
        trace.push(['close', cause]);
        liveness.stop();
        open = false;
      },
      changed: () => {
        trace.push(['changed', liveness.recoveryDeadline]);
        reenter?.(liveness);
      },
      sideMayRestart: () => {
        trace.push('side');
        sideHook?.();
      },
      recovered: () => trace.push('recovered'),
    });
    if (options.bound ?? true) liveness.binding = 'negotiation_liveness_03';
    return {
      liveness,
      trace,
      link,
      route: () => route,
      transition: (state: RTCPeerConnectionState) => {
        route!.connectionState = state;
        liveness.routeChanged(route as unknown as RTCPeerConnection);
      },
      setOpen: (value: boolean) => (open = value),
      replaceRoute: (value: PeerConnection | undefined) => (route = value),
      onChanged: (fn: ((liveness: LinkLiveness) => void) | null) => (reenter = fn),
      onSide: (fn: (() => void) | null) => (sideHook = fn),
    };
  }
  type Owner = ReturnType<typeof owner>;

  function side(state: RTCPeerConnectionState): PeerConnection {
    const pc = new PeerConnection();
    pc.connectionState = state;
    return pc;
  }

  it('runs connected as: cancel grace, reopen gate, probe, callback, side route, recovered', () => {
    const o = owner();
    // A resume probe that sees the interruption reads the link on connected.
    expect(o.liveness.backgroundResume(60_000, false)).toBe('monitoring');
    o.transition('disconnected');
    expect(o.liveness.beginRestart()).toBe(true);
    o.trace.length = 0;
    o.onChanged((liveness) => o.trace.push(['gate', liveness.beginRestart()]));
    o.transition('connected');
    expect(o.trace).toEqual([['snapshot', 0], ['changed', 0], ['gate', true], 'side', 'recovered']);
  });

  it('reports no recovery for a connected route that was not interrupted or is not open', () => {
    const o = owner();
    o.transition('connected');
    expect(o.trace).toEqual([['changed', 0], 'side']);
    o.transition('disconnected');
    o.setOpen(false);
    o.trace.length = 0;
    o.transition('connected');
    expect(o.trace).toEqual([['changed', 0], 'side']);
  });

  it('runs disconnected as: probe, callback, then the grace, then the side route', () => {
    const o = owner();
    expect(o.liveness.backgroundResume(60_000, false)).toBe('monitoring');
    o.trace.length = 0;
    const start = Date.now();
    o.transition('disconnected');
    expect(o.trace).toEqual([['snapshot', 0], ['changed', 0], 'side']);
    expect(o.liveness.recoveryDeadline).toBe(start + GRACE_MS);
    expect(getManagedTimer(KEY)).not.toBeNull();
  });

  it('arms and publishes the grace before the side route hears a disconnected', () => {
    const o = owner();
    const seen: unknown[] = [];
    o.onSide(() => seen.push([getManagedTimer(KEY) !== null, o.liveness.recoveryDeadline]));
    const start = Date.now();
    o.transition('disconnected');
    expect(seen).toEqual([[true, start + GRACE_MS]]);
  });

  it('arms no grace and skips the side route when the callback closes on disconnected', () => {
    const o = owner();
    o.onChanged((liveness) => liveness.stop());
    o.transition('disconnected');
    expect(o.trace).toEqual([['changed', 0]]);
    expect(o.liveness.recoveryDeadline).toBe(0);
    expect(getManagedTimer(KEY)).toBeNull();
  });

  it('runs a restartable failed as: grace, callback, side route', () => {
    const o = owner();
    const start = Date.now();
    o.transition('failed');
    expect(o.trace).toEqual([['changed', start + GRACE_MS], 'side']);
  });

  it.each([
    { name: 'an unbound failed', state: 'failed' as const, bound: false, open: true },
    { name: 'a failed before open', state: 'failed' as const, bound: true, open: false },
    { name: 'a closed', state: 'closed' as const, bound: true, open: true },
  ])('closes $name as original-terminal with no other effect', ({ state, bound, open }) => {
    const o = owner({ bound, open });
    o.transition(state);
    expect(o.trace).toEqual([['close', 'original-terminal']]);
  });

  it.each(['new', 'connecting'] as const)('does nothing on %s', (state) => {
    const o = owner();
    o.transition(state);
    expect(o.trace).toEqual([]);
  });

  it('closes on grace expiry only while the same route is still not connected', async () => {
    const expired = owner();
    expired.transition('disconnected');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(expired.trace.at(-1)).toBe('side');
    await vi.advanceTimersByTimeAsync(1);
    expect(expired.trace.at(-1)).toEqual(['close', 'original-grace-expired']);
  });

  it('closes nothing when the grace outlives a replaced route', async () => {
    const replaced = owner();
    replaced.transition('disconnected');
    replaced.replaceRoute(new PeerConnection());
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(replaced.trace.at(-1)).toBe('side');
  });

  it('closes nothing when the route silently reads connected when the grace ends', async () => {
    const silent = owner();
    silent.transition('disconnected');
    silent.route()!.connectionState = 'connected';
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(silent.trace.at(-1)).toBe('side');
    // The fired grace stays published until the next transition.
    expect(silent.liveness.recoveryDeadline).toBeGreaterThan(0);
  });

  it('keeps a fired grace published until the next transition and re-arms a cleared timer', async () => {
    const o = owner();
    const start = Date.now();
    expect(o.liveness.beginRestart()).toBe(true);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    // The route read connected when the grace fired.
    expect(o.trace).toEqual([]);
    expect(o.liveness.recoveryDeadline).toBe(start + GRACE_MS);
    o.transition('disconnected');
    expect(o.liveness.recoveryDeadline).toBe(start + 2 * GRACE_MS);
    // A page-wide timer clear counts as no grace: the next arm is fresh.
    clearManagedTimer(KEY);
    await vi.advanceTimersByTimeAsync(1_000);
    o.transition('failed');
    expect(o.liveness.recoveryDeadline).toBe(start + 2 * GRACE_MS + 1_000);
  });

  it('withholds the deadline until the owner is bound', () => {
    const o = owner({ bound: false });
    const start = Date.now();
    o.transition('disconnected');
    expect(o.liveness.recoveryDeadline).toBe(0);
    o.liveness.binding = 'negotiation_liveness_04';
    expect(o.liveness.recoveryDeadline).toBe(start + GRACE_MS);
  });

  it('admits one restart per interruption on an open, bound, running owner', () => {
    expect(owner({ bound: false }).liveness.beginRestart()).toBe(false);
    expect(owner({ open: false }).liveness.beginRestart()).toBe(false);
    const stopped = owner();
    stopped.liveness.stop();
    expect(stopped.liveness.beginRestart()).toBe(false);

    const o = owner();
    o.replaceRoute(undefined);
    // Without a route there is nothing to grace, but the gate still closes.
    expect(o.liveness.beginRestart()).toBe(true);
    expect(o.liveness.recoveryDeadline).toBe(0);
    expect(o.liveness.beginRestart()).toBe(false);
    o.liveness.finishRestart();
    expect(o.liveness.beginRestart()).toBe(true);
  });

  it('cancels the grace and arms nothing once stopped', async () => {
    const o = owner();
    o.transition('disconnected');
    o.liveness.stop();
    expect(o.liveness.recoveryDeadline).toBe(0);
    expect(getManagedTimer(KEY)).toBeNull();
    o.transition('failed');
    expect(getManagedTimer(KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(o.trace).not.toContainEqual(['close', 'original-grace-expired']);
  });

  /** The guest background-resume probe the owner holds since C5-7. */
  describe('resume probe', () => {
    const PROBE_KEY = `${KEY}-background-resume-liveness`;
    const PROBE_DISCONNECTED_KEY = `${KEY}-background-resume-disconnected`;

    function armedTimers(): [boolean, boolean] {
      return [
        getManagedTimer(PROBE_KEY) !== null,
        getManagedTimer(PROBE_DISCONNECTED_KEY) !== null,
      ];
    }

    function pingId(trace: unknown[]): number {
      const entry = trace.find(
        (item): item is ['ping', number] => Array.isArray(item) && item[0] === 'ping',
      );
      return entry![1];
    }

    function closes(trace: unknown[]): unknown[] {
      return trace.filter((item) => Array.isArray(item) && item[0] === 'close');
    }

    it.each([
      { name: 'under the grace', hiddenMs: GRACE_MS - 1 },
      { name: 'not a number', hiddenMs: Number.NaN },
      { name: 'infinite', hiddenMs: Number.POSITIVE_INFINITY },
    ])('is not applicable when the hidden period is $name', ({ hiddenMs }) => {
      const o = owner();
      expect(o.liveness.backgroundResume(hiddenMs, false)).toBe('not-applicable');
      expect(o.trace).toEqual([]);
      expect(armedTimers()).toEqual([false, false]);
    });

    it('is not applicable to a link that is not open or is stopped', () => {
      const closed = owner({ open: false });
      expect(closed.liveness.backgroundResume(60_000, false)).toBe('not-applicable');
      const stopped = owner();
      stopped.liveness.stop();
      expect(stopped.liveness.backgroundResume(60_000, false)).toBe('not-applicable');
      expect([...closed.trace, ...stopped.trace]).toEqual([]);
      expect(armedTimers()).toEqual([false, false]);
    });

    it('arms the 3 s window, reads the link, then sends one challenge with a high safe-integer id', () => {
      const o = owner();
      expect(o.liveness.backgroundResume(GRACE_MS, false)).toBe('monitoring');
      expect(o.trace).toEqual([
        ['snapshot', 0],
        ['ping', expect.any(Number)],
      ]);
      const id = pingId(o.trace);
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(2 ** 52);
      expect(armedTimers()).toEqual([true, false]);
    });

    it('closes as resume-probe-unanswered exactly 3 s later without the exact pong', async () => {
      const o = owner();
      o.liveness.backgroundResume(60_000, false);
      const id = pingId(o.trace);
      for (const payload of [
        null,
        'sync-pong',
        { type: MSG.SYNC_PONG, pingId: id + 1 },
        { type: MSG.SYNC_PING, pingId: id },
      ]) {
        o.liveness.inbound(payload);
      }
      await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS - 1);
      expect(closes(o.trace)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(closes(o.trace)).toEqual([['close', 'resume-probe-unanswered']]);
      expect(armedTimers()).toEqual([false, false]);
    });

    it('settles on the exact pong, clearing both timers, and ignores frames after it', async () => {
      const o = owner();
      o.route()!.connectionState = 'disconnected';
      o.liveness.backgroundResume(60_000, false);
      expect(armedTimers()).toEqual([true, true]);
      const id = pingId(o.trace);
      o.liveness.inbound({ type: MSG.SYNC_PONG, pingId: id });
      expect(armedTimers()).toEqual([false, false]);
      o.liveness.inbound({ type: MSG.SYNC_PONG, pingId: id });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(closes(o.trace)).toEqual([]);
      expect(o.liveness.reconcileResume(true)).toBe('not-applicable');
    });

    it('accepts only the latest challenge after a second resume', async () => {
      const o = owner();
      o.liveness.backgroundResume(60_000, false);
      const first = pingId(o.trace);
      o.trace.length = 0;
      await vi.advanceTimersByTimeAsync(2_000);
      o.liveness.backgroundResume(60_000, false);
      const second = pingId(o.trace);
      expect(second).not.toBe(first);
      o.liveness.inbound({ type: MSG.SYNC_PONG, pingId: first });
      await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS - 1);
      expect(closes(o.trace)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(closes(o.trace)).toEqual([['close', 'resume-probe-unanswered']]);
    });

    it('closes as resume-probe-unanswered when the challenge cannot be sent', () => {
      const o = owner();
      o.link.pingFails = true;
      expect(o.liveness.backgroundResume(60_000, false)).toBe('stale-connection-closed');
      expect(o.trace).toEqual([
        ['snapshot', 0],
        ['ping', expect.any(Number)],
        ['close', 'resume-probe-unanswered'],
      ]);
      expect(armedTimers()).toEqual([false, false]);
    });

    it.each([
      { name: 'no original PC', arrange: (o: Owner) => o.replaceRoute(undefined) },
      { name: 'a failed original', arrange: (o: Owner) => (o.route()!.connectionState = 'failed') },
      { name: 'a closed original', arrange: (o: Owner) => (o.route()!.connectionState = 'closed') },
      { name: 'a failed side PC', arrange: (o: Owner) => (o.link.side = side('failed')) },
      { name: 'a closed side PC', arrange: (o: Owner) => (o.link.side = side('closed')) },
      {
        name: 'an original channel that is not open',
        arrange: (o: Owner) => (o.link.channelsOpen = false),
      },
      {
        name: 'an active side channel that is not open',
        arrange: (o: Owner) => (o.link.sideChannelDown = true),
      },
    ])('closes at once as resume-stale for $name, before any challenge', ({ arrange }) => {
      const o = owner();
      arrange(o);
      expect(o.liveness.backgroundResume(60_000, false)).toBe('stale-connection-closed');
      expect(o.trace).toEqual([
        ['snapshot', 0],
        ['close', 'resume-stale'],
      ]);
      expect(armedTimers()).toEqual([false, false]);
    });

    it('monitors a connected original beside a connected side PC without a short look', () => {
      const o = owner();
      o.link.side = side('connected');
      expect(o.liveness.backgroundResume(60_000, false)).toBe('monitoring');
      expect(armedTimers()).toEqual([true, false]);
    });

    it('monitors a transitional original with neither a close nor a short look', () => {
      const o = owner();
      o.route()!.connectionState = 'connecting';
      expect(o.liveness.backgroundResume(60_000, false)).toBe('monitoring');
      expect(armedTimers()).toEqual([true, false]);
    });

    it.each([
      {
        name: 'the original',
        arrange: (o: Owner) => (o.route()!.connectionState = 'disconnected'),
      },
      { name: 'the side PC', arrange: (o: Owner) => (o.link.side = side('disconnected')) },
    ])(
      'closes at once as resume-stale when $name reads disconnected and signaling is lost',
      ({ arrange }) => {
        const o = owner();
        arrange(o);
        expect(o.liveness.backgroundResume(60_000, true)).toBe('stale-connection-closed');
        expect(o.trace).toEqual([
          ['snapshot', 0],
          ['close', 'resume-stale'],
        ]);
      },
    );

    it.each([
      {
        name: 'the original still disconnected',
        original: 'disconnected',
        channelsOpen: true,
        sideState: undefined,
        closes: true,
      },
      {
        name: 'an original channel that is not open',
        original: 'connected',
        channelsOpen: false,
        sideState: undefined,
        closes: true,
      },
      {
        name: 'the side PC still disconnected',
        original: 'connected',
        channelsOpen: true,
        sideState: 'disconnected',
        closes: true,
      },
      {
        name: 'both routes connected and open',
        original: 'connected',
        channelsOpen: true,
        sideState: 'connected',
        closes: false,
      },
      {
        name: 'an open connected original and no side PC',
        original: 'connected',
        channelsOpen: true,
        sideState: undefined,
        closes: false,
      },
    ] as const)(
      'ends the 1 s look at a disconnected route with $name (closes: $closes)',
      async ({ original, channelsOpen, sideState, closes: closing }) => {
        const o = owner();
        o.route()!.connectionState = 'disconnected';
        expect(o.liveness.backgroundResume(60_000, false)).toBe('monitoring');
        expect(armedTimers()).toEqual([true, true]);
        o.route()!.connectionState = original;
        o.link.channelsOpen = channelsOpen;
        o.link.side = sideState ? side(sideState) : undefined;
        o.trace.length = 0;
        await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS - 1);
        expect(o.trace).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        if (closing) {
          expect(o.trace).toEqual([
            ['snapshot', 0],
            ['close', 'resume-disconnected'],
          ]);
          expect(armedTimers()).toEqual([false, false]);
          return;
        }
        // Keeps waiting for the pong.
        expect(o.trace).toEqual([['snapshot', 0]]);
        await vi.advanceTimersByTimeAsync(
          RESUME_LIVENESS_TIMEOUT_MS - RESUME_DISCONNECTED_PROBE_MS,
        );
        expect(closes(o.trace)).toEqual([['close', 'resume-probe-unanswered']]);
      },
    );

    it('restarts the 1 s look when the link is read disconnected again', async () => {
      const o = owner();
      o.route()!.connectionState = 'disconnected';
      o.liveness.backgroundResume(60_000, false);
      await vi.advanceTimersByTimeAsync(500);
      expect(o.liveness.reconcileResume(false)).toBe('monitoring');
      await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS - 1);
      expect(closes(o.trace)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(closes(o.trace)).toEqual([['close', 'resume-disconnected']]);
    });

    it('a second resume starts a probe that saw no disconnected and leaves a running 1 s look on its deadline', async () => {
      const o = owner();
      o.route()!.connectionState = 'disconnected';
      expect(o.liveness.backgroundResume(60_000, false)).toBe('monitoring');
      await vi.advanceTimersByTimeAsync(400);
      // WebKit now reports connected without an event; the second resume reads it.
      o.route()!.connectionState = 'connected';
      expect(o.liveness.backgroundResume(60_000, false)).toBe('monitoring');
      // The 1 s look the first resume armed is not cleared.
      expect(armedTimers()).toEqual([true, true]);
      // The new probe saw no disconnected, so a connected event does not settle it.
      o.transition('connected');
      expect(armedTimers()).toEqual([true, true]);
      o.trace.length = 0;
      await vi.advanceTimersByTimeAsync(RESUME_DISCONNECTED_PROBE_MS - 400 - 1);
      expect(o.trace).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      // The look ends on the first resume's deadline, reads connected and keeps waiting.
      expect(o.trace).toEqual([['snapshot', 0]]);
      expect(armedTimers()).toEqual([true, false]);
      await vi.advanceTimersByTimeAsync(RESUME_LIVENESS_TIMEOUT_MS - 600 - 1);
      expect(closes(o.trace)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(closes(o.trace)).toEqual([['close', 'resume-probe-unanswered']]);
    });

    it('is not applicable without an armed probe', () => {
      const o = owner();
      expect(o.liveness.reconcileResume(true)).toBe('not-applicable');
      expect(o.trace).toEqual([]);
    });

    it('on connected: keeps a probe that saw no disconnected, without reading the link', () => {
      const o = owner();
      o.liveness.backgroundResume(60_000, false);
      o.trace.length = 0;
      o.transition('connected');
      expect(o.trace).toEqual([['changed', 0], 'side']);
      expect(armedTimers()).toEqual([true, false]);
    });

    it('on connected: settles a probe that saw disconnected only without a side PC', () => {
      const alone = owner();
      alone.liveness.backgroundResume(60_000, false);
      alone.transition('disconnected');
      expect(armedTimers()).toEqual([true, true]);
      alone.transition('connected');
      expect(armedTimers()).toEqual([false, false]);
      alone.liveness.stop();

      const withSide = owner();
      withSide.link.side = side('connected');
      withSide.liveness.backgroundResume(60_000, false);
      withSide.transition('disconnected');
      withSide.transition('connected');
      // Only the exact pong proves both routes.
      expect(armedTimers()).toEqual([true, true]);
      expect(withSide.liveness.reconcileResume(false)).toBe('monitoring');
    });

    it('on disconnected: a probe that finds a terminal side PC closes before the callback and arms no grace', () => {
      const o = owner();
      o.link.side = side('connected');
      o.liveness.backgroundResume(60_000, false);
      o.link.side = side('failed');
      o.trace.length = 0;
      o.transition('disconnected');
      expect(o.trace).toEqual([
        ['snapshot', 0],
        ['close', 'resume-stale'],
        ['changed', 0],
      ]);
      expect(getManagedTimer(KEY)).toBeNull();
      expect(armedTimers()).toEqual([false, false]);
    });

    it('stop clears the probe and both timers, and nothing re-arms it', async () => {
      const o = owner();
      o.route()!.connectionState = 'disconnected';
      o.liveness.backgroundResume(60_000, false);
      o.liveness.stop();
      expect(armedTimers()).toEqual([false, false]);
      expect(o.liveness.reconcileResume(false)).toBe('not-applicable');
      expect(o.liveness.backgroundResume(60_000, false)).toBe('not-applicable');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(closes(o.trace)).toEqual([]);
    });
  });

  it('reads its phase from the original route alone, without a port call beyond open and route (C5-8)', () => {
    const o = owner({ open: false });
    expect(o.liveness.phase).toBe('opening');
    o.setOpen(true);
    expect(o.liveness.phase).toBe('live');
    // A side PC never makes the phase recovering (RO-35).
    o.link.side = side('disconnected');
    expect(o.liveness.phase).toBe('live');
    o.transition('disconnected');
    expect(o.liveness.phase).toBe('recovering');
    o.route()!.connectionState = 'connecting';
    expect(o.liveness.phase).toBe('recovering');
    // The condition under which its grace would close: not reading connected.
    o.route()!.connectionState = 'connected';
    expect(o.liveness.phase).toBe('live');
    o.replaceRoute(undefined);
    expect(o.liveness.phase).toBe('recovering');
    o.liveness.stop();
    expect(o.liveness.phase).toBe('closed');
    expect(o.trace).toEqual([['changed', 0], 'side']);
  });
});

/**
 * Every close of the link enters the owner (Phase 4 C5-10): its close input
 * keeps the first cause and is the only way into the connection's close port
 * (terminate), which `npm run guard:transport-health` locks statically.
 */
describe('the one close input (C5-10)', () => {
  function closer() {
    const calls: Array<[string, boolean]> = [];
    let open = true;
    const pc = new PeerConnection();
    const liveness: LinkLiveness = new LinkLiveness('cloudflare-data-disconnected-grace-close', {
      route: () => pc as unknown as RTCPeerConnection,
      open: () => open,
      snapshot: () => ({
        original: pc as unknown as RTCPeerConnection,
        side: undefined,
        channelsOpen: true,
        sideChannelDown: false,
      }),
      ping: () => undefined,
      close: (cause, first) => {
        calls.push([cause, first]);
        liveness.stop();
        open = false;
      },
      changed: () => undefined,
      sideMayRestart: () => undefined,
      recovered: () => undefined,
    });
    liveness.binding = 'negotiation_liveness_05';
    return { liveness, calls, pc };
  }

  it("marks the first cause as the link's and still passes every later close to the port", () => {
    const o = closer();
    o.liveness.close('peer-left');
    expect(o.liveness.phase).toBe('closed');
    o.liveness.close('channel-closed');
    o.liveness.close('peer-left');
    expect(o.calls).toEqual([
      ['peer-left', true],
      ['channel-closed', false],
      ['peer-left', false],
    ]);
  });

  it('sends the causes it decides itself through the same input', async () => {
    const o = closer();
    o.pc.connectionState = 'disconnected';
    o.liveness.routeChanged(o.pc as unknown as RTCPeerConnection);
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    o.liveness.close('channel-closed');
    expect(o.calls).toEqual([
      ['original-grace-expired', true],
      ['channel-closed', false],
    ]);
  });

  it('receives every close of a connection, the ones re-entered while it disposes included', async () => {
    const close = vi.spyOn(LinkLiveness.prototype, 'close');
    const e = await connection({ bound: true });
    e.conn.close('leave');
    // The first channel's close event, the second's, then the PC's closed state.
    expect(close.mock.calls).toEqual([
      ['leave'],
      ['channel-closed'],
      ['channel-closed'],
      ['original-terminal'],
    ]);
    expect(e.trace).toEqual(['close']);
    expect(closeLines()).toEqual(['[Transport] Logical connection closed (leave) for peer-0']);
  });
});
