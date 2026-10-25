/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { log } from '../../../core/log.ts';
import { clearAllManagedTimers } from '../../../core/timers.ts';
import { CloudflareDataConnection } from '../cloudflare-signaling.ts';
import { ControlIsolation as C9ControlIsolation } from './fixtures/control-isolation-c9.ts';

/**
 * The side (isolated control) route's outage deadline together with the
 * original route's outage owner, through a real CloudflareDataConnection, its
 * real LinkLiveness and its real ControlIsolation on each end (Phase 4 train
 * 4D, increment D0: tests only, written against the 9.0.10 code). The
 * standalone ControlIsolation suites stub the original route's readiness;
 * these cases drive the original PC's real transitions instead, so they must
 * hold unchanged when C5-9 moves the side deadline into LinkLiveness:
 * - 15 s per side outage, deferred while the original route is down, re-armed
 *   to 15 s after the original recovers and capped at 30 s from its start;
 * - the grace before READY with its decline and fallback, and its hand-over
 *   to the restart deadline at READY;
 * - the restart attempt budget, the restart offer bound and the monotonic
 *   clock;
 * - the three device evidence lines, their level and the end that logs them;
 * - the close causes (side-failed:<reason>, original-grace-expired);
 * - a peer on the frozen C9 build, which cannot restart its side PC.
 * Two connections exchange their control lanes in order. A lane that is down
 * holds its frames until it is up again, as SCTP does while a path is
 * unavailable. One end's close is not carried to the other end here, so each
 * end's own deadline stays visible.
 */
const GRACE_MS = 15_000;
const SIDE_CAP_MS = 30_000;
const NEGOTIATION_MS = 10_000;
const TYPE = 'mxqr-control-isolation';
const SIDE_LABEL = 'musixquare-control-isolated';
const RECOVERED = '[Transport] Isolated control ICE recovered';
const DID_NOT_RECOVER =
  '[Transport] Isolated control ICE did not recover; closing its logical connection';

function restarting(count: number): string {
  return `[Transport] Restarting isolated control ICE (${count}/2)`;
}

type Level = 'debug' | 'info' | 'warn' | 'error';
type Line = [Level, string];

class Channel extends EventTarget {
  binaryType: BinaryType = 'arraybuffer';
  ordered = true;
  maxRetransmits: number | null = null;
  maxPacketLifeTime: number | null = null;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: Array<string | ArrayBuffer> = [];
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
  remoteDescription: RTCSessionDescriptionInit | null = null;
  /** A side PC's isolated control channel, once created or received. */
  channel: Channel | null = null;
  /** While set, createOffer waits for it: an ICE-restart offer held in flight. */
  offerGate: Promise<void> | null = null;
  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    await this.offerGate;
    return { type: 'offer', sdp: options?.iceRestart ? 'restart-offer' : 'offer' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer' };
  }
  async setLocalDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = value;
  }
  async setRemoteDescription(value: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = value;
  }
  async addIceCandidate(): Promise<void> {}
  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
    this.channel = new Channel(label, 'connecting');
    this.channel.ordered = options?.ordered ?? true;
    return this.channel as unknown as RTCDataChannel;
  }
  remoteChannel(): void {
    this.channel = new Channel(SIDE_LABEL, 'connecting');
    this.dispatchEvent(Object.assign(new Event('datachannel'), { channel: this.channel }));
  }
  state(value: RTCPeerConnectionState): void {
    this.connectionState = value;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  close(): void {
    if (this.connectionState !== 'closed') this.state('closed');
  }
}

interface Endpoint {
  readonly peer: string;
  readonly conn: CloudflareDataConnection;
  /** The original PC, which carries the bulk and control channels. */
  readonly pc: PeerConnection;
  readonly control: Channel;
  /** The side PC this connection's control isolation leases. */
  readonly side: PeerConnection;
  readonly release: Mock<() => void>;
}

const connections: CloudflareDataConnection[] = [];
const legacyPeers: C9ControlIsolation[] = [];
let lines: Line[] = [];

async function flush(): Promise<void> {
  for (let index = 0; index < 48; index++) await Promise.resolve();
}

/** One open, restart-bound logical connection with control isolation (a host link). */
async function endpoint(): Promise<Endpoint> {
  const peer = `peer-${connections.length}`;
  const side = new PeerConnection();
  const release = vi.fn<() => void>();
  const conn = new CloudflareDataConnection(peer, undefined, null, undefined, undefined, () => ({
    pc: side as unknown as RTCPeerConnection,
    release,
    prepareRestart: async () => {},
  }));
  connections.push(conn);
  conn.iceRestartBinding = 'negotiation_side_route_01';
  const pc = new PeerConnection();
  const control = new Channel('musixquare-control');
  conn.attach(
    pc as unknown as RTCPeerConnection,
    new Channel('musixquare-data') as unknown as RTCDataChannel,
  );
  conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
  await flush();
  expect(conn.open).toBe(true);
  return { peer, conn, pc, control, side, release };
}

/** Moves what `from` sent since the last move to `to`, in order. */
function lane() {
  const read = new Map<Channel, number>();
  return (from: Channel | null | undefined, to: Channel | null | undefined): void => {
    if (!from || !to) return;
    let index = read.get(from) ?? 0;
    for (; index < from.sent.length; index++) to.receive(from.sent[index]);
    read.set(from, index);
  };
}

/**
 * Two current-build ends. Bulk demand starts the side negotiation; the end
 * with the smaller nonce offers the side PC and every ICE-restart offer.
 * `activate: false` stops after the descriptions, before either side channel
 * opens (before the fences and READY).
 */
async function pair({ activate = true } = {}) {
  const a = await endpoint();
  const b = await endpoint();
  const lanes = { original: true, side: true };
  const move = lane();
  const other = (e: Endpoint) => (e === a ? b : a);
  /** Delivers only what `from` sent on the original lane. */
  const deliverFrom = (from: Endpoint): void => {
    if (lanes.original) move(from.control, other(from).control);
  };
  const pump = async (): Promise<void> => {
    for (let round = 0; round < 12; round++) {
      if (lanes.original) {
        move(a.control, b.control);
        move(b.control, a.control);
      }
      if (lanes.side) {
        move(a.side.channel, b.side.channel);
        move(b.side.channel, a.side.channel);
      }
      await flush();
    }
  };
  /** Both original PCs change state together; a down route holds its lane. */
  const original = (state: 'disconnected' | 'connected'): void => {
    lanes.original = state === 'connected';
    a.pc.state(state);
    b.pc.state(state);
  };
  for (const e of [a, b]) e.conn.startBulkFlowControl();
  await pump();
  expect(a.conn.bulkFlowControl.hasCapacity(1)).toBe(false);
  await pump();
  const offerer = a.side.channel ? a : b;
  const answerer = other(offerer);
  answerer.side.remoteChannel();
  if (activate) {
    a.side.channel!.open();
    b.side.channel!.open();
    await pump();
    expect(a.conn.controlIsolation?.phase).toBe('active');
    expect(b.conn.controlIsolation?.phase).toBe('active');
  }
  return { a, b, offerer, answerer, lanes, pump, deliverFrom, original };
}

/**
 * A current-build end and a peer on the frozen C9 build, whose side route has
 * no restart capability: it never advertises one and ignores restart frames.
 */
async function legacyPair() {
  const a = await endpoint();
  const side = new PeerConnection();
  const sent: string[] = [];
  const fail = vi.fn<() => void>();
  const release = vi.fn<() => void>();
  const flow = new C9ControlIsolation({
    createPeerConnection: () => ({ pc: side as unknown as RTCPeerConnection, release }),
    sendOriginal: (data) => {
      sent.push(data);
    },
    receive: () => {},
    changed: () => {},
    fail,
  });
  legacyPeers.push(flow);
  const lanes = { original: true };
  const move = lane();
  let toLegacy = 0;
  let fromLegacy = 0;
  const pump = async (): Promise<void> => {
    for (let round = 0; round < 12; round++) {
      if (lanes.original) {
        for (; toLegacy < a.control.sent.length; toLegacy++) {
          const data = a.control.sent[toLegacy];
          const frame: unknown = typeof data === 'string' ? JSON.parse(data) : null;
          // As its connection does: side-route frames first, then the fence check.
          if (!flow.handleOriginal(frame, true)) flow.acceptOriginalApplication();
        }
        for (; fromLegacy < sent.length; fromLegacy++) a.control.receive(sent[fromLegacy]);
      }
      move(a.side.channel, side.channel);
      move(side.channel, a.side.channel);
      await flush();
    }
  };
  a.conn.startBulkFlowControl();
  flow.start();
  await pump();
  expect(a.conn.bulkFlowControl.hasCapacity(1)).toBe(false);
  await pump();
  (a.side.channel ? side : a.side).remoteChannel();
  a.side.channel!.open();
  side.channel!.open();
  await pump();
  expect(a.conn.controlIsolation?.phase).toBe('active');
  expect(flow.phase).toBe('active');
  return { a, legacy: { flow, side, fail, release }, lanes, pump };
}

/** Advances fake time to `ms` after the moment this timeline was made. */
function timeline(): (ms: number) => Promise<void> {
  const start = performance.now();
  return async (ms) => {
    const wait = start + ms - performance.now();
    if (wait < 0) throw new Error(`the timeline is already past ${ms} ms`);
    await vi.advanceTimersByTimeAsync(wait);
  };
}

/** The side-route evidence lines and the logical-connection close lines, in order. */
function transcript(from = 0): Line[] {
  return lines
    .slice(from)
    .filter(
      ([, text]) =>
        /isolated control/iu.test(text) || text.startsWith('[Transport] Logical connection closed'),
    );
}

/** What `action` logged synchronously, which only the end it acts on can log. */
function logged(action: () => void): Line[] {
  const mark = lines.length;
  action();
  return transcript(mark);
}

function closed(cause: string, e: Endpoint): Line {
  return ['info', `[Transport] Logical connection closed (${cause}) for ${e.peer}`];
}

/** The side-route frames of one kind that an end sent on its original lane. */
function frames(e: Endpoint, kind: string): Array<Record<string, unknown>> {
  return e.control.sent
    .filter((data): data is string => typeof data === 'string')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
    .filter((frame) => frame.type === TYPE && frame.kind === kind);
}

function expectClosed(e: Endpoint): void {
  expect(e.conn.open).toBe(false);
  expect(e.side.connectionState).toBe('closed');
  expect(e.release).toHaveBeenCalledOnce();
}

beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
      lines.push([level, String(args[0])]);
    });
  }
});

afterEach(() => {
  for (const conn of connections.splice(0)) conn.close();
  for (const flow of legacyPeers.splice(0)) flow.dispose();
  clearAllManagedTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a side-route outage while the original route is up', () => {
  it('closes each end 15 s after its side PC failed, with side-failed:expired after the warning, and leaves the original route view alone', async () => {
    const p = await pair();
    const at = timeline();
    p.offerer.side.state('failed');
    p.answerer.side.state('failed');
    await p.pump();
    for (const e of [p.a, p.b]) {
      expect(e.conn.controlIsolation?.phase).toBe('active');
      expect(e.conn.linkLiveness.phase).toBe('live');
      expect(e.conn.iceRecoveryDeadline).toBe(0);
      expect(e.conn.bulkFlowControl.hasCapacity(1)).toBe(true);
    }
    await at(GRACE_MS - 1);
    expect(p.a.conn.open && p.b.conn.open).toBe(true);
    expect(transcript()).toEqual([['info', restarting(1)]]);
    await at(GRACE_MS);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.offerer),
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.answerer),
    ]);
    for (const e of [p.a, p.b]) expectClosed(e);
    expect(frames(p.offerer, 'restart-offer')).toHaveLength(1);
  });

  it("closes only the end whose side PC failed; the offerer restarts on the answerer's request and keeps its link", async () => {
    const p = await pair();
    const at = timeline();
    p.answerer.side.state('failed');
    await p.pump();
    expect(frames(p.answerer, 'restart-request')).toHaveLength(1);
    expect(frames(p.offerer, 'restart-offer')).toHaveLength(1);
    await at(GRACE_MS - 1);
    expect(p.answerer.conn.open).toBe(true);
    await at(GRACE_MS);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.answerer),
    ]);
    expectClosed(p.answerer);
    await at(60_000);
    expect(p.offerer.conn.open).toBe(true);
    expect(p.offerer.conn.controlIsolation?.phase).toBe('active');
  });

  it('keeps both links when the side PCs reconnect within 15 s', async () => {
    const p = await pair();
    const at = timeline();
    p.offerer.side.state('failed');
    p.answerer.side.state('failed');
    await p.pump();
    await at(GRACE_MS - 1);
    p.offerer.side.state('connected');
    p.answerer.side.state('connected');
    await p.pump();
    await at(60_000);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['info', RECOVERED],
      ['info', RECOVERED],
    ]);
    for (const e of [p.a, p.b]) {
      expect(e.conn.open).toBe(true);
      expect(e.conn.controlIsolation?.phase).toBe('active');
    }
  });
});

describe("a side-route outage and the original route's own outage", () => {
  it('original down, then side down: the side waits without a restart and the original grace closes both links at 15 s', async () => {
    const p = await pair();
    const at = timeline();
    p.original('disconnected');
    await at(2_000);
    p.offerer.side.state('failed');
    p.answerer.side.state('failed');
    await p.pump();
    for (const e of [p.a, p.b]) expect(e.conn.linkLiveness.phase).toBe('recovering');
    await at(GRACE_MS - 1);
    expect(transcript()).toEqual([]);
    expect(p.a.conn.open && p.b.conn.open).toBe(true);
    await at(GRACE_MS);
    expect(transcript()).toEqual([
      closed('original-grace-expired', p.a),
      closed('original-grace-expired', p.b),
    ]);
    for (const e of [p.a, p.b]) expectClosed(e);
    for (const e of [p.a, p.b]) expect(frames(e, 'restart-offer')).toEqual([]);
    await at(60_000);
    expect(transcript()).toHaveLength(2);
  });

  it("side down, then original down: the side's 15 s defers to the original grace, which closes both links", async () => {
    const p = await pair();
    const at = timeline();
    p.offerer.side.state('failed');
    p.answerer.side.state('failed');
    await p.pump();
    await at(5_000);
    p.original('disconnected');
    await at(GRACE_MS);
    expect(p.a.conn.open && p.b.conn.open).toBe(true);
    await at(5_000 + GRACE_MS - 1);
    expect(transcript()).toEqual([['info', restarting(1)]]);
    await at(5_000 + GRACE_MS);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      closed('original-grace-expired', p.a),
      closed('original-grace-expired', p.b),
    ]);
    for (const e of [p.a, p.b]) expectClosed(e);
  });

  it('original recovers at +14 s: the side restarts then, re-arms 15 s from then, and a side still failed closes at +29 s', async () => {
    const p = await pair();
    const at = timeline();
    p.original('disconnected');
    p.offerer.side.state('failed');
    p.answerer.side.state('failed');
    await p.pump();
    await at(14_000);
    expect(transcript()).toEqual([]);
    p.original('connected');
    // The offerer's restart starts inside its original route's recovery.
    expect(transcript()).toEqual([['info', restarting(1)]]);
    await p.pump();
    expect(frames(p.offerer, 'restart-offer')).toHaveLength(1);
    await at(29_000 - 1);
    expect(p.a.conn.open && p.b.conn.open).toBe(true);
    await at(29_000);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.a),
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.b),
    ]);
    for (const e of [p.a, p.b]) expectClosed(e);
  });

  it('caps the re-armed deadline at 30 s from the side outage start', async () => {
    const p = await pair();
    const at = timeline();
    p.offerer.side.state('failed');
    p.answerer.side.state('failed');
    await p.pump();
    await at(5_000);
    p.original('disconnected');
    await at(18_000);
    p.original('connected');
    await p.pump();
    await at(SIDE_CAP_MS - 1);
    expect(p.a.conn.open && p.b.conn.open).toBe(true);
    await at(SIDE_CAP_MS);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.a),
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.b),
    ]);
    for (const e of [p.a, p.b]) expectClosed(e);
  });

  it('a brief original outage moves the side deadline to 15 s after the original recovers', async () => {
    const p = await pair();
    const at = timeline();
    p.offerer.side.state('failed');
    p.answerer.side.state('failed');
    await p.pump();
    await at(3_000);
    p.original('disconnected');
    await at(5_000);
    p.original('connected');
    await p.pump();
    await at(20_000 - 1);
    expect(p.a.conn.open && p.b.conn.open).toBe(true);
    await at(20_000);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.a),
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.b),
    ]);
  });
});

describe('a side restart in flight across an original-route recovery', () => {
  it('keeps the restart begun at the recovery the only one through a second original outage, and the side recovers', async () => {
    const p = await pair();
    const at = timeline();
    let releaseOffer!: () => void;
    p.offerer.side.offerGate = new Promise((resolve) => {
      releaseOffer = resolve;
    });
    p.original('disconnected');
    await at(1_000);
    p.offerer.side.state('failed');
    p.answerer.side.state('failed');
    await p.pump();
    await at(4_000);
    p.original('connected');
    await p.pump();
    expect(transcript()).toEqual([['info', restarting(1)]]);
    await at(5_000);
    p.original('disconnected');
    await at(6_000);
    p.original('connected');
    await p.pump();
    expect(transcript()).toEqual([['info', restarting(1)]]);
    expect(frames(p.offerer, 'restart-offer')).toEqual([]);
    releaseOffer();
    p.offerer.side.offerGate = null;
    await p.pump();
    expect(frames(p.offerer, 'restart-offer')).toHaveLength(1);
    expect(logged(() => p.offerer.side.state('connected'))).toEqual([['info', RECOVERED]]);
    expect(logged(() => p.answerer.side.state('connected'))).toEqual([['info', RECOVERED]]);
    await p.pump();
    await at(60_000);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['info', RECOVERED],
      ['info', RECOVERED],
    ]);
    for (const e of [p.a, p.b]) expect(e.conn.open).toBe(true);
    expect(frames(p.offerer, 'restart-offer')).toHaveLength(1);
  });

  it('does not repeat an offer in flight when the original recovers, and the re-armed deadline still closes a failed side', async () => {
    const p = await pair();
    const at = timeline();
    let releaseOffer!: () => void;
    p.offerer.side.offerGate = new Promise((resolve) => {
      releaseOffer = resolve;
    });
    p.offerer.side.state('failed');
    p.answerer.side.state('failed');
    await p.pump();
    await at(2_000);
    p.original('disconnected');
    await at(12_000);
    p.original('connected');
    await p.pump();
    await at(13_000);
    releaseOffer();
    p.offerer.side.offerGate = null;
    await p.pump();
    expect(frames(p.offerer, 'restart-offer')).toHaveLength(1);
    await at(27_000 - 1);
    expect(p.a.conn.open && p.b.conn.open).toBe(true);
    await at(27_000);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.a),
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.b),
    ]);
  });
});

describe('side-route outages before READY', () => {
  it('a side PC that fails during negotiation declines and falls back on both ends; the links stay open and controls keep the original route', async () => {
    const p = await pair({ activate: false });
    const at = timeline();
    p.offerer.side.state('failed');
    await p.pump();
    expect(frames(p.offerer, 'decline')).toHaveLength(1);
    for (const e of [p.a, p.b]) {
      expect(e.conn.controlIsolation?.phase).toBe('fallback');
      expect(e.conn.open).toBe(true);
      expect(e.release).toHaveBeenCalledOnce();
      expect(e.conn.bulkFlowControl.hasCapacity(1)).toBe(true);
    }
    const received = vi.fn();
    p.answerer.conn.on('data', received);
    p.offerer.conn.send({ type: 'side-route-probe' });
    await p.pump();
    expect(received).toHaveBeenCalledWith({ type: 'side-route-probe' });
    await at(60_000);
    expect(transcript()).toEqual([]);
    for (const e of [p.a, p.b]) expect(e.conn.open).toBe(true);
  });

  it('a side PC that disconnects during negotiation falls back at the 10 s negotiation bound, before its 15 s grace, and nothing closes', async () => {
    const p = await pair({ activate: false });
    const at = timeline();
    await at(2_000);
    p.offerer.side.state('disconnected');
    await p.pump();
    await at(NEGOTIATION_MS - 1);
    for (const e of [p.a, p.b]) expect(e.conn.controlIsolation?.phase).toBe('negotiating');
    await at(NEGOTIATION_MS);
    await p.pump();
    for (const e of [p.a, p.b]) expect(e.conn.controlIsolation?.phase).toBe('fallback');
    await at(2_000 + GRACE_MS);
    await at(60_000);
    expect(transcript()).toEqual([]);
    for (const e of [p.a, p.b]) {
      expect(e.conn.open).toBe(true);
      expect(e.conn.controlIsolation?.phase).toBe('fallback');
    }
  });

  it('a restart-capable route takes over a disconnect from before READY at READY: its 15 s count starts there', async () => {
    const p = await pair({ activate: false });
    const at = timeline();
    await at(2_000);
    p.offerer.side.state('disconnected');
    await p.pump();
    await at(5_000);
    p.a.side.channel!.open();
    p.b.side.channel!.open();
    await p.pump();
    for (const e of [p.a, p.b]) expect(e.conn.controlIsolation?.phase).toBe('active');
    expect(transcript()).toEqual([['info', restarting(1)]]);
    await at(2_000 + GRACE_MS);
    expect(p.offerer.conn.open).toBe(true);
    await at(5_000 + GRACE_MS - 1);
    expect(p.offerer.conn.open).toBe(true);
    await at(5_000 + GRACE_MS);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.offerer),
    ]);
    expect(p.answerer.conn.open).toBe(true);
  });

  it('after its fence, a side PC that fails before READY closes the link with side-failed:route', async () => {
    const p = await pair({ activate: false });
    p.offerer.side.channel!.open();
    expect(p.offerer.conn.controlIsolation?.phase).toBe('fencing');
    expect(logged(() => p.offerer.side.state('failed'))).toEqual([
      closed('side-failed:route', p.offerer),
    ]);
    expectClosed(p.offerer);
  });
});

describe('repeated side-route outages and the restart budget', () => {
  it("spends at most two restarts on one outage of the offerer's side PC and gives the next outage a fresh budget and a fresh 15 s", async () => {
    const p = await pair();
    const at = timeline();
    const o = p.offerer;
    expect(logged(() => o.side.state('failed'))).toEqual([['info', restarting(1)]]);
    await p.pump();
    await at(1_000);
    o.side.state('connecting');
    expect(logged(() => o.side.state('failed'))).toEqual([['info', restarting(2)]]);
    await p.pump();
    await at(2_000);
    o.side.state('connecting');
    expect(logged(() => o.side.state('failed'))).toEqual([]);
    await p.pump();
    await at(10_000);
    expect(logged(() => o.side.state('connected'))).toEqual([['info', RECOVERED]]);
    await at(20_000);
    expect(logged(() => o.side.state('failed'))).toEqual([['info', restarting(1)]]);
    await p.pump();
    await at(20_000 + GRACE_MS - 1);
    expect(o.conn.open).toBe(true);
    await at(20_000 + GRACE_MS);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['info', restarting(2)],
      ['info', RECOVERED],
      ['info', restarting(1)],
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', o),
    ]);
    expect(frames(o, 'restart-offer')).toHaveLength(3);
    expect(p.answerer.conn.open).toBe(true);
  });

  it("restarts at most twice per 15 s window of the answerer's requests, then in a fresh window", async () => {
    const p = await pair();
    const at = timeline();
    const { offerer: o, answerer: n } = p;
    n.side.state('failed');
    await p.pump();
    await at(1_000);
    n.side.state('connected');
    await at(2_000);
    n.side.state('failed');
    await p.pump();
    await at(3_000);
    n.side.state('connected');
    await at(4_000);
    n.side.state('failed');
    await p.pump();
    expect(frames(n, 'restart-request')).toHaveLength(3);
    expect(frames(o, 'restart-offer')).toHaveLength(2);
    await at(10_000);
    n.side.state('connected');
    await at(16_000);
    n.side.state('failed');
    await p.pump();
    await at(17_000);
    n.side.state('connected');
    await p.pump();
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['info', RECOVERED],
      ['info', restarting(2)],
      ['info', RECOVERED],
      ['info', RECOVERED],
      ['info', restarting(1)],
      ['info', RECOVERED],
    ]);
    expect(frames(n, 'restart-request')).toHaveLength(4);
    expect(frames(o, 'restart-offer')).toHaveLength(3);
    for (const e of [o, n]) expect(e.conn.open).toBe(true);
  });

  it('stops restart offers at 16 in 30 s, below the bound an answerer closes at, and a further outage closes at its own 15 s without an offer', async () => {
    const p = await pair();
    const at = timeline();
    const o = p.offerer;
    for (let outage = 0; outage < 8; outage++) {
      await at(outage * 1_000);
      o.side.state('failed');
      await p.pump();
      o.side.state('connecting');
      o.side.state('failed');
      await p.pump();
      o.side.state('connected');
    }
    expect(frames(o, 'restart-offer')).toHaveLength(16);
    await at(8_000);
    expect(logged(() => o.side.state('failed'))).toEqual([]);
    await p.pump();
    expect(frames(o, 'restart-offer')).toHaveLength(16);
    await at(8_000 + GRACE_MS - 1);
    expect(o.conn.open).toBe(true);
    await at(8_000 + GRACE_MS);
    expect(transcript().slice(-2)).toEqual([
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', o),
    ]);
    expect(transcript().filter(([, text]) => text === RECOVERED)).toHaveLength(8);
    expect(p.answerer.conn.open).toBe(true);
    expect(p.answerer.conn.controlIsolation?.phase).toBe('active');
  });
});

describe('side-route device evidence lines', () => {
  it('the offerer logs the restart and the recovery of its own side outage at info; the answerer logs nothing', async () => {
    const p = await pair();
    expect(logged(() => p.offerer.side.state('failed'))).toEqual([['info', restarting(1)]]);
    await p.pump();
    expect(transcript()).toEqual([['info', restarting(1)]]);
    expect(logged(() => p.offerer.side.state('connected'))).toEqual([['info', RECOVERED]]);
    await p.pump();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['info', RECOVERED],
    ]);
  });

  it("logs the restart on the offerer when the answerer's side PC fails, and the recovery on the answerer", async () => {
    const p = await pair();
    expect(logged(() => p.answerer.side.state('failed'))).toEqual([]);
    await flush();
    expect(transcript()).toEqual([]);
    // Only the answerer's frames reach the offerer: the line is the offerer's.
    p.deliverFrom(p.answerer);
    await flush();
    expect(transcript()).toEqual([['info', restarting(1)]]);
    await p.pump();
    expect(logged(() => p.answerer.side.state('connected'))).toEqual([['info', RECOVERED]]);
    await p.pump();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['info', RECOVERED],
    ]);
  });

  it("logs the did-not-recover warning on each end whose side deadline expired, right before that end's close", async () => {
    const p = await pair();
    const at = timeline();
    p.offerer.side.state('failed');
    await p.pump();
    await at(1_000);
    p.answerer.side.state('failed');
    await p.pump();
    await at(GRACE_MS - 1);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['info', restarting(2)],
    ]);
    await at(GRACE_MS);
    expect(transcript().slice(2)).toEqual([
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.offerer),
    ]);
    expect(p.answerer.conn.open).toBe(true);
    await at(1_000 + GRACE_MS);
    expect(transcript().slice(2)).toEqual([
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.offerer),
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.answerer),
    ]);
  });
});

describe('a peer on the frozen C9 build (mixed version)', () => {
  it('closes an active route 15 s after its side PC disconnected, with side-failed:route, no restart and none of the evidence lines', async () => {
    const m = await legacyPair();
    const at = timeline();
    m.a.side.state('disconnected');
    m.legacy.side.state('disconnected');
    await m.pump();
    await at(GRACE_MS - 1);
    expect(m.a.conn.open).toBe(true);
    expect(m.legacy.fail).not.toHaveBeenCalled();
    await at(GRACE_MS);
    expect(transcript()).toEqual([closed('side-failed:route', m.a)]);
    expectClosed(m.a);
    expect(m.legacy.fail).toHaveBeenCalledOnce();
    for (const kind of ['restart-request', 'restart-offer', 'restart-answer', 'restart-candidate'])
      expect(frames(m.a, kind)).toEqual([]);
  });

  it('does not defer that grace while the original route is down', async () => {
    const m = await legacyPair();
    const at = timeline();
    m.a.side.state('disconnected');
    await at(1_000);
    m.lanes.original = false;
    m.a.pc.state('disconnected');
    expect(m.a.conn.linkLiveness.phase).toBe('recovering');
    await at(GRACE_MS - 1);
    expect(m.a.conn.open).toBe(true);
    await at(GRACE_MS);
    expect(transcript()).toEqual([closed('side-failed:route', m.a)]);
  });

  it('closes at once when the side PC fails', async () => {
    const m = await legacyPair();
    expect(logged(() => m.a.side.state('failed'))).toEqual([closed('side-failed:route', m.a)]);
    expectClosed(m.a);
  });

  it('keeps the link when the side PC reconnects within 15 s, logging nothing, and gives the next disconnect a fresh 15 s', async () => {
    const m = await legacyPair();
    const at = timeline();
    m.a.side.state('disconnected');
    await at(10_000);
    m.a.side.state('connected');
    await at(GRACE_MS);
    expect(m.a.conn.open).toBe(true);
    await at(20_000);
    m.a.side.state('disconnected');
    await at(20_000 + GRACE_MS - 1);
    expect(m.a.conn.open).toBe(true);
    expect(transcript()).toEqual([]);
    await at(20_000 + GRACE_MS);
    expect(transcript()).toEqual([closed('side-failed:route', m.a)]);
  });
});

describe('the side deadline clock', () => {
  it('measures the deadline, its re-arm and its cap in elapsed time: wall-clock jumps move none of them', async () => {
    const p = await pair();
    const at = timeline();
    p.offerer.side.state('failed');
    p.answerer.side.state('failed');
    await p.pump();
    await at(5_000);
    p.original('disconnected');
    vi.setSystemTime(Date.now() + 3_600_000);
    await at(GRACE_MS);
    expect(p.a.conn.open && p.b.conn.open).toBe(true);
    vi.setSystemTime(Date.now() - 7_200_000);
    await at(18_000);
    p.original('connected');
    await p.pump();
    await at(SIDE_CAP_MS - 1);
    expect(p.a.conn.open && p.b.conn.open).toBe(true);
    await at(SIDE_CAP_MS);
    expect(transcript()).toEqual([
      ['info', restarting(1)],
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.a),
      ['warn', DID_NOT_RECOVER],
      closed('side-failed:expired', p.b),
    ]);
  });
});
