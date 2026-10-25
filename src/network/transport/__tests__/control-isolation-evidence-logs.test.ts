import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../../core/log.ts';
import { ControlIsolation, type IsolatedControlLease } from '../control-isolation.ts';
import { sideOutageOwner } from './fixtures/side-outage-owner.ts';

/**
 * Device evidence freeze. Release-record item #18 and the Phase 4 device
 * criteria read these three lines from /debug console (`?mxqrLog=info`), so
 * their exact text, argument count and log level must not change. They are
 * driven through the real side-restart paths, not matched in source text.
 */
const RECOVERED = '[Transport] Isolated control ICE recovered';
const RESTARTING_FIRST = '[Transport] Restarting isolated control ICE (1/2)';
const RESTARTING_SECOND = '[Transport] Restarting isolated control ICE (2/2)';
const DID_NOT_RECOVER =
  '[Transport] Isolated control ICE did not recover; closing its logical connection';

const LABEL = 'musixquare-control-isolated';
type Frame = Record<string, unknown>;
type Level = 'debug' | 'info' | 'warn' | 'error';
const owners: Array<{ dispose(): void }> = [];
let lines: Array<[Level, ...unknown[]]> = [];

class Channel extends EventTarget {
  label = LABEL;
  ordered = true;
  maxRetransmits: number | null = null;
  maxPacketLifeTime: number | null = null;
  readyState: RTCDataChannelState = 'connecting';
  binaryType = 'arraybuffer';
  sent: string[] = [];
  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('not open');
    this.sent.push(data);
  }
  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
  close(): void {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
  message(data: unknown): void {
    this.dispatchEvent(Object.assign(new Event('message'), { data }));
  }
}

class Peer extends EventTarget {
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  channel: Channel | null = null;
  iceRestarts = 0;
  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    if (options?.iceRestart) this.iceRestarts++;
    return { type: 'offer', sdp: options?.iceRestart ? 'restart-offer' : 'offer' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer' };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
  }
  async addIceCandidate(): Promise<void> {}
  createDataChannel(label: string, options: RTCDataChannelInit): RTCDataChannel {
    this.channel = new Channel();
    this.channel.label = label;
    this.channel.ordered = options.ordered ?? true;
    return this.channel as unknown as RTCDataChannel;
  }
  remoteChannel(): void {
    this.channel = new Channel();
    this.dispatchEvent(Object.assign(new Event('datachannel'), { channel: this.channel }));
  }
  state(value: RTCPeerConnectionState): void {
    this.connectionState = value;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  close(): void {
    this.state('closed');
  }
}

function endpoint() {
  const peer = new Peer();
  const original: string[] = [];
  const fail = vi.fn();
  const route = { originalUp: true };
  // A test LinkLiveness keeps the side PC's outage deadline (Phase 4 C5-9).
  const owner = sideOutageOwner(() => flow);
  const flow: ControlIsolation = new ControlIsolation({
    createPeerConnection: (): IsolatedControlLease => ({
      pc: peer as unknown as RTCPeerConnection,
      release: () => {},
      prepareRestart: async () => {},
    }),
    sendOriginal: (data) => {
      original.push(data);
    },
    receive: () => {},
    changed: () => {},
    fail,
    outages: owner.liveness,
  });
  owners.push(flow, { dispose: () => owner.liveness.stop() });
  /** Reports `route.originalUp` to the outage owner as an original PC transition. */
  const originalChanged = () => owner.original(route.originalUp);
  return { flow, peer, original, fail, route, originalChanged };
}
type Endpoint = ReturnType<typeof endpoint>;

function hello(e: Endpoint): Frame {
  return e.original.map((data) => JSON.parse(data) as Frame).find((f) => f.kind === 'hello')!;
}

async function microtasks(): Promise<void> {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}

/** Two endpoints over an ordered original lane, activated and connected. */
async function live() {
  const a = endpoint();
  const b = endpoint();
  a.flow.start();
  b.flow.start();
  a.flow.handleOriginal(hello(b), true);
  b.flow.handleOriginal(hello(a), true);
  let ai = 1;
  let bi = 1;
  let asi = 0;
  let bsi = 0;
  const pump = async () => {
    for (let round = 0; round < 12; round++) {
      for (; ai < a.original.length; ai++) b.flow.handleOriginal(JSON.parse(a.original[ai]), true);
      for (; bi < b.original.length; bi++) a.flow.handleOriginal(JSON.parse(b.original[bi]), true);
      for (; asi < (a.peer.channel?.sent.length ?? 0); asi++)
        b.peer.channel!.message(a.peer.channel!.sent[asi]);
      for (; bsi < (b.peer.channel?.sent.length ?? 0); bsi++)
        a.peer.channel!.message(b.peer.channel!.sent[bsi]);
      await microtasks();
    }
  };
  a.flow.allowBulk();
  await pump();
  (a.peer.channel ? b : a).peer.remoteChannel();
  a.peer.channel!.open();
  b.peer.channel!.open();
  await pump();
  a.peer.state('connected');
  b.peer.state('connected');
  expect(a.flow.phase).toBe('active');
  expect(b.flow.phase).toBe('active');
  // The smaller nonce offered the side PC and owns every restart offer.
  const aOffers = String(hello(a).nonce) < String(hello(b).nonce);
  return { a, b, pump, offerer: aOffers ? a : b, answerer: aOffers ? b : a };
}

/** Every logged line about the side route, at whatever level it was logged. */
function evidence(): Array<[Level, ...unknown[]]> {
  return lines.filter(([, first]) => typeof first === 'string' && /isolated control/iu.test(first));
}

beforeEach(() => {
  vi.useFakeTimers();
  lines = [];
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(log, level).mockImplementation((...args: unknown[]) => {
      lines.push([level, ...args]);
    });
  }
});

afterEach(() => {
  for (const flow of owners.splice(0)) flow.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isolated control ICE device evidence lines', () => {
  it('logs the restart from the offerer and recovery from each side that saw the outage, at info', async () => {
    const p = await live();
    for (const e of [p.a, p.b]) e.peer.state('failed');
    await p.pump();
    expect(p.offerer.peer.iceRestarts).toBe(1);
    expect(evidence()).toEqual([['info', RESTARTING_FIRST]]);

    for (const e of [p.a, p.b]) e.peer.state('connected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(evidence()).toEqual([
      ['info', RESTARTING_FIRST],
      ['info', RECOVERED],
      ['info', RECOVERED],
    ]);
    for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
  });

  it("logs the offerer's restart for an answerer-only outage and recovery only on the answerer", async () => {
    const p = await live();
    p.answerer.peer.state('failed');
    await p.pump();
    // The answerer asks; the offerer spends its peer-request window and logs.
    expect(p.offerer.peer.iceRestarts).toBe(1);
    expect(p.answerer.peer.iceRestarts).toBe(0);
    expect(evidence()).toEqual([['info', RESTARTING_FIRST]]);

    p.answerer.peer.state('connected');
    await p.pump();
    expect(evidence()).toEqual([
      ['info', RESTARTING_FIRST],
      ['info', RECOVERED],
    ]);
  });

  it('logs two numbered restarts, then the did-not-recover close at warn on both sides', async () => {
    const p = await live();
    for (const e of [p.a, p.b]) e.peer.state('failed');
    await p.pump();
    for (let round = 0; round < 3; round++) {
      for (const e of [p.a, p.b]) {
        e.peer.state('connecting');
        e.peer.state('failed');
      }
      await p.pump();
    }
    expect(evidence()).toEqual([
      ['info', RESTARTING_FIRST],
      ['info', RESTARTING_SECOND],
    ]);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(evidence()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(evidence()).toEqual([
      ['info', RESTARTING_FIRST],
      ['info', RESTARTING_SECOND],
      ['warn', DID_NOT_RECOVER],
      ['warn', DID_NOT_RECOVER],
    ]);
    for (const e of [p.a, p.b]) {
      expect(e.fail).toHaveBeenCalledOnce();
      expect(e.flow.phase).toBe('closed');
    }
  });

  it('logs recovery without any restart when the side heals while the original route is down', async () => {
    const p = await live();
    // Restart signaling travels on the original route, so the side waits.
    for (const e of [p.a, p.b]) {
      e.route.originalUp = false;
      e.originalChanged();
    }
    for (const e of [p.a, p.b]) e.peer.state('failed');
    await p.pump();
    expect(evidence()).toEqual([]);

    for (const e of [p.a, p.b]) e.peer.state('connected');
    await p.pump();
    expect(evidence()).toEqual([
      ['info', RECOVERED],
      ['info', RECOVERED],
    ]);
    for (const e of [p.a, p.b]) {
      e.route.originalUp = true;
      e.originalChanged();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(evidence()).toHaveLength(2);
    for (const e of [p.a, p.b]) expect(e.peer.iceRestarts).toBe(0);
  });
});
