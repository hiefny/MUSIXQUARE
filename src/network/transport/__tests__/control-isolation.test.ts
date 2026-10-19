import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlIsolation, type IsolatedControlLease } from '../control-isolation.ts';
import { ControlIsolation as C9ControlIsolation } from './fixtures/control-isolation-c9.ts';

const TYPE = 'mxqr-control-isolation';
const LABEL = 'musixquare-control-isolated';
type Frame = Record<string, unknown>;
const owners: Array<{ dispose(): void }> = [];

class Channel extends EventTarget {
  label = LABEL;
  ordered = true;
  maxRetransmits: number | null = null;
  maxPacketLifeTime: number | null = null;
  readyState: RTCDataChannelState = 'connecting';
  binaryType = 'arraybuffer';
  sent: string[] = [];
  sendHook: ((data: string) => void) | null = null;
  send(data: string): void {
    if (this.readyState !== 'open') throw new Error('not open');
    this.sent.push(data);
    this.sendHook?.(data);
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
  candidates: RTCIceCandidateInit[] = [];
  offerGate: Promise<void> | null = null;
  remoteGate: Promise<void> | null = null;
  localGate: Promise<void> | null = null;
  rejectCandidates = false;
  offerOptions: Array<RTCOfferOptions | undefined> = [];
  remoteHistory: string[] = [];
  closeCount = 0;
  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offerOptions.push(options);
    await this.offerGate;
    return {
      type: 'offer',
      sdp: options?.iceRestart
        ? `restart-offer-${this.offerOptions.filter((value) => value?.iceRestart).length}`
        : 'offer-description',
    };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    const remote = this.remoteDescription?.sdp ?? '';
    return {
      type: 'answer',
      sdp: remote.startsWith('restart-offer-')
        ? remote.replace('restart-offer-', 'restart-answer-')
        : 'answer-description',
    };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.localGate;
    this.localDescription = description;
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.remoteGate;
    this.remoteDescription = description;
    this.remoteHistory.push(description.sdp ?? '');
  }
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.rejectCandidates) throw new DOMException('generation mismatch', 'OperationError');
    this.candidates.push(candidate);
  }
  createDataChannel(label: string, options: RTCDataChannelInit): RTCDataChannel {
    this.channel = new Channel();
    this.channel.label = label;
    this.channel.ordered = options.ordered ?? true;
    return this.channel as unknown as RTCDataChannel;
  }
  remoteChannel(channel = new Channel()): Channel {
    this.channel = channel;
    this.dispatchEvent(Object.assign(new Event('datachannel'), { channel }));
    return channel;
  }
  ice(candidate: RTCIceCandidateInit): void {
    this.dispatchEvent(
      Object.assign(new Event('icecandidate'), {
        candidate: { toJSON: () => candidate },
      }),
    );
  }
  state(value: RTCPeerConnectionState): void {
    this.connectionState = value;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
  close(): void {
    this.closeCount++;
    this.state('closed');
  }
}

function endpoint(build: 'current' | 'c9' = 'current') {
  const peer = new Peer();
  const original: string[] = [];
  const received: string[] = [];
  const release = vi.fn();
  const changed = vi.fn();
  const fail = vi.fn();
  // The owner's original-route readiness and credential hook (current build only).
  const route = { originalUp: true };
  const prepareRestart = vi.fn(async () => {});
  const create = vi.fn((): IsolatedControlLease | null => ({
    pc: peer as unknown as RTCPeerConnection,
    release,
    prepareRestart,
  }));
  const sendOriginal = vi.fn((data: string) => {
    original.push(data);
  });
  const receive = vi.fn((data: string) => {
    received.push(data);
  });
  const options = { createPeerConnection: create, sendOriginal, receive, changed, fail };
  const flow =
    build === 'c9'
      ? new C9ControlIsolation(options)
      : new ControlIsolation({ ...options, originalReady: () => route.originalUp });
  owners.push(flow);
  return {
    flow,
    peer,
    original,
    received,
    release,
    changed,
    fail,
    create,
    sendOriginal,
    receive,
    route,
    prepareRestart,
  };
}
type Endpoint = ReturnType<typeof endpoint>;

function hello(endpoint: Endpoint): Frame {
  return endpoint.original
    .map((data) => JSON.parse(data) as Frame)
    .find((frame) => frame.kind === 'hello')!;
}
function inbound(endpoint: Endpoint, kind: string, extra: Frame = {}): Frame {
  return {
    type: TYPE,
    version: 1,
    kind,
    nonce: 'f'.repeat(32),
    target: hello(endpoint).nonce,
    ...extra,
  };
}
async function microtasks(): Promise<void> {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}
/**
 * `restart: false` models the C9 protocol pin: a build without the restart
 * capability never sends that advertisement and ignores the other side's.
 * `link` holds frames in order, as SCTP does while a path is unavailable.
 */
function pair({
  restart = true,
  b: bBuild = 'current',
}: { restart?: boolean; b?: 'current' | 'c9' } = {}) {
  const a = endpoint();
  const b = endpoint(bBuild);
  a.flow.start();
  b.flow.start();
  a.flow.handleOriginal(hello(b), true);
  b.flow.handleOriginal(hello(a), true);
  const link = { original: true, side: true, aToB: true, bToA: true };
  let ai = 1;
  let bi = 1;
  let asi = 0;
  let bsi = 0;
  const deliver = (to: Endpoint, data: string) => {
    const frame = JSON.parse(data) as Frame;
    if (!restart && frame.type === TYPE && frame.kind === 'restart-capable') return;
    if (!to.flow.handleOriginal(frame, true) && to.flow.acceptOriginalApplication())
      to.receive(data);
  };
  // Each lane's cursor only advances past delivered frames, so a frame sent in
  // reaction to the other side's frames is delivered next, as on a real lane.
  const original = () => {
    if (!link.original) return;
    for (; ai < a.original.length; ai++) deliver(b, a.original[ai]);
    for (; bi < b.original.length; bi++) deliver(a, b.original[bi]);
  };
  const side = () => {
    if (!link.side) return;
    for (; link.aToB && asi < (a.peer.channel?.sent.length ?? 0); asi++)
      b.peer.channel!.message(a.peer.channel!.sent[asi]);
    for (; link.bToA && bsi < (b.peer.channel?.sent.length ?? 0); bsi++)
      a.peer.channel!.message(b.peer.channel!.sent[bsi]);
  };
  const pump = async () => {
    for (let index = 0; index < 12; index++) {
      original();
      side();
      await microtasks();
    }
  };
  const negotiate = async () => {
    a.flow.allowBulk();
    await pump();
    const answerer = a.peer.channel ? b : a;
    answerer.peer.remoteChannel();
  };
  const activate = async () => {
    await negotiate();
    a.peer.channel!.open();
    b.peer.channel!.open();
    await pump();
  };
  return { a, b, link, original, side, pump, negotiate, activate };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const flow of owners.splice(0)) flow.dispose();
  vi.useRealTimers();
});

describe('admitted connection control isolation', () => {
  it('allocates no PC before admission or without direct bulk demand', () => {
    const e = endpoint();
    expect(e.flow.allowBulk()).toBe(false);
    e.flow.start();
    e.flow.start();
    expect(e.original).toHaveLength(1);
    e.flow.handleOriginal(inbound(e, 'hello', { target: undefined }), false);
    vi.advanceTimersByTime(1000);
    expect(e.create).not.toHaveBeenCalled();
  });

  it('retains original routing and allows legacy bulk after bounded discovery', () => {
    const e = endpoint();
    e.flow.start();
    expect(e.flow.allowBulk()).toBe(false);
    e.flow.send('{"type":"before"}');
    vi.advanceTimersByTime(999);
    expect(e.flow.allowBulk()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(e.flow.allowBulk()).toBe(true);
    expect(e.create).not.toHaveBeenCalled();
    expect(e.fail).not.toHaveBeenCalled();
    expect(e.original.at(-1)).toBe('{"type":"before"}');
  });

  it('negotiates late support after legacy discovery without changing original ownership', async () => {
    const p = pair();
    vi.advanceTimersByTime(1000);
    await p.activate();
    for (const e of [p.a, p.b]) {
      expect(e.flow.phase).toBe('active');
      expect(e.create).toHaveBeenCalledOnce();
      expect(e.flow.peerConnection).toBe(e.peer);
      expect(e.flow.allowBulk()).toBe(true);
    }
  });

  it('waits for both fences and ready before exposing side app controls or capacity', async () => {
    const p = pair();
    await p.negotiate();
    p.a.peer.channel!.open();
    p.a.flow.send('{"type":"queued-1"}');
    p.a.flow.send('{"type":"queued-2"}');
    expect(p.a.flow.allowBulk()).toBe(false);
    expect(p.a.changed).not.toHaveBeenCalled();
    p.b.peer.channel!.open();
    await p.pump();
    expect(p.a.flow.phase).toBe('active');
    expect(p.b.flow.phase).toBe('active');
    expect(p.b.received).toEqual(['{"type":"queued-1"}', '{"type":"queued-2"}']);
    expect(p.a.changed).toHaveBeenCalledExactlyOnceWith(true);
    p.a.flow.send('{"type":"mxqr-bulk-flow","kind":"receipt"}');
    await p.pump();
    expect(p.b.received.at(-1)).toContain('receipt');
    expect(p.a.original.some((data) => data.includes('queued-'))).toBe(false);
  });

  it('retains original application delivery before its fence and rejects it afterward', async () => {
    const p = pair();
    expect(p.a.flow.acceptOriginalApplication()).toBe(true);
    await p.activate();
    expect(p.a.flow.acceptOriginalApplication()).toBe(false);
    expect(p.a.fail).toHaveBeenCalledOnce();
    expect(p.a.flow.phase).toBe('closed');
  });

  it('queues early side application data until both original fences are consumed', async () => {
    const p = pair();
    await p.negotiate();
    p.a.peer.channel!.open();
    p.a.peer.channel!.message('{"type":"early"}');
    expect(p.a.received).toEqual([]);
    expect(p.a.flow.snapshot.incomingMessages).toBe(1);
    p.b.peer.channel!.open();
    await p.pump();
    expect(p.a.received).toEqual(['{"type":"early"}']);
  });

  it('ignores malformed, wrong-target and bulk-lane private frames', () => {
    const e = endpoint();
    e.flow.start();
    const validHello = { type: TYPE, version: 1, kind: 'hello', nonce: 'f'.repeat(32) };
    for (const frame of [
      { ...validHello, version: 2 },
      { ...validHello, nonce: 'bad' },
      { ...validHello, extra: true },
    ]) {
      expect(e.flow.handleOriginal(frame, true)).toBe(true);
    }
    e.flow.handleOriginal(validHello, false);
    e.flow.handleOriginal(inbound(e, 'request'), true);
    expect(e.flow.phase).toBe('idle');
    e.flow.handleOriginal(validHello, true);
    e.flow.handleOriginal(inbound(e, 'request', { target: '0'.repeat(32) }), true);
    expect(e.flow.phase).toBe('idle');
    expect(e.create).not.toHaveBeenCalled();
    expect(e.flow.handleOriginal({ type: 'play' }, true)).toBe(false);
  });

  it('falls back on a peer resource decline before any fence', async () => {
    const p = pair();
    p.a.create.mockReturnValue(null!);
    p.b.create.mockReturnValue(null!);
    p.a.flow.allowBulk();
    await p.pump();
    for (const e of [p.a, p.b]) {
      expect(e.flow.phase).toBe('fallback');
      expect(e.flow.allowBulk()).toBe(true);
      expect(e.fail).not.toHaveBeenCalled();
      e.flow.send('{"type":"fallback"}');
      expect(e.original.at(-1)).toContain('fallback');
    }
  });

  it('does not silently fall back if a decline arrives after a fence', async () => {
    const p = pair();
    await p.negotiate();
    p.a.peer.channel!.open();
    p.a.flow.handleOriginal({ ...hello(p.b), kind: 'decline', target: hello(p.a).nonce }, true);
    expect(p.a.flow.phase).toBe('closed');
    expect(p.a.fail).toHaveBeenCalledOnce();
  });

  it('declines an unfenced negotiation at its fixed deadline without a reconnect loop', async () => {
    const p = pair();
    p.a.flow.allowBulk();
    await p.pump();
    vi.advanceTimersByTime(9999);
    expect(p.a.fail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await p.pump();
    for (const e of [p.a, p.b]) {
      expect(e.fail).not.toHaveBeenCalled();
      expect(e.flow.phase).toBe('fallback');
      expect(e.flow.allowBulk()).toBe(true);
      expect(e.release).toHaveBeenCalledOnce();
      const attempts = e.create.mock.calls.length;
      vi.advanceTimersByTime(60_000);
      e.flow.allowBulk();
      expect(e.create).toHaveBeenCalledTimes(attempts);
    }
  });

  it('closes instead of fallback when the same deadline expires after a local fence', async () => {
    const p = pair();
    await p.negotiate();
    p.a.peer.channel!.open();
    vi.advanceTimersByTime(10_000);
    expect(p.a.fail).toHaveBeenCalledOnce();
    expect(p.a.flow.phase).toBe('closed');
  });

  it('keeps a crossed decline and peer fence from producing an active mixed route', async () => {
    const p = pair();
    await p.negotiate();
    p.a.peer.state('failed');
    expect(p.a.flow.phase).toBe('fallback');
    p.b.peer.channel!.open();
    await p.pump();
    expect(p.b.fail).toHaveBeenCalledOnce();
    expect(p.b.flow.phase).toBe('closed');
    expect(p.a.changed).not.toHaveBeenCalledWith(true);
    expect(p.b.changed).not.toHaveBeenCalledWith(true);
  });

  it('buffers candidates until the exact remote description, with no replacement PC', async () => {
    const p = pair();
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    p.a.peer.remoteGate = gate;
    p.b.peer.remoteGate = gate;
    p.a.flow.allowBulk();
    await p.pump();
    const offerer = p.a.peer.channel ? p.a : p.b;
    const answerer = offerer === p.a ? p.b : p.a;
    offerer.peer.ice({ candidate: 'candidate-a', sdpMid: '0', sdpMLineIndex: 0 });
    await p.pump();
    expect(answerer.peer.candidates).toEqual([]);
    resolve();
    await p.pump();
    expect(answerer.peer.candidates).toEqual([
      { candidate: 'candidate-a', sdpMid: '0', sdpMLineIndex: 0 },
    ]);
    expect(p.a.create).toHaveBeenCalledOnce();
    expect(p.b.create).toHaveBeenCalledOnce();
  });

  it('bounds authenticated candidate floods and fails the exact owner', async () => {
    const p = pair();
    await p.negotiate();
    for (let i = 0; i < 129; i++)
      p.a.flow.handleOriginal(
        {
          ...hello(p.b),
          kind: 'candidate',
          target: hello(p.a).nonce,
          candidate: { candidate: `candidate-${i}` },
        },
        true,
      );
    expect(p.a.fail).toHaveBeenCalledOnce();
    expect(p.b.fail).not.toHaveBeenCalled();
  });

  it('applies late trickled candidates to the same side PC after activation', async () => {
    const p = pair();
    await p.activate();
    const pc = p.b.flow.peerConnection;
    p.a.peer.ice({ candidate: 'late-candidate', sdpMid: '0', sdpMLineIndex: 0 });
    await p.pump();
    expect(p.b.peer.candidates).toEqual([
      { candidate: 'late-candidate', sdpMid: '0', sdpMLineIndex: 0 },
    ]);
    expect(p.b.flow.peerConnection).toBe(pc);
    expect(p.b.flow.phase).toBe('active');
    expect(p.b.fail).not.toHaveBeenCalled();
  });

  it('does not signal a late offer after disposal during an awaited createOffer', async () => {
    const p = pair();
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    p.a.peer.offerGate = gate;
    p.b.peer.offerGate = gate;
    p.a.flow.allowBulk();
    await p.pump();
    const offering = p.a.peer.channel ? p.a : p.b;
    offering.flow.dispose();
    const count = offering.original.length;
    resolve();
    await microtasks();
    expect(offering.original).toHaveLength(count);
    expect(offering.release).toHaveBeenCalledOnce();
    expect(offering.flow.peerConnection).toBeUndefined();
  });

  it('releases a lease if its factory synchronously disposes the logical owner', async () => {
    const p = pair();
    for (const e of [p.a, p.b])
      e.create.mockImplementation(() => {
        e.flow.dispose();
        return { pc: e.peer as unknown as RTCPeerConnection, release: e.release };
      });
    p.a.flow.allowBulk();
    await p.pump();
    const created = p.a.create.mock.calls.length ? p.a : p.b;
    expect(created.flow.phase).toBe('closed');
    expect(created.release).toHaveBeenCalledOnce();
    expect(created.peer.closeCount).toBe(1);
    expect(created.flow.peerConnection).toBeUndefined();
  });

  it('does not send an answer after disposal during setRemoteDescription', async () => {
    const p = pair();
    let resolve!: () => void;
    const gate = new Promise<void>((done) => {
      resolve = done;
    });
    p.a.peer.remoteGate = gate;
    p.b.peer.remoteGate = gate;
    p.a.flow.allowBulk();
    await p.pump();
    const answering = p.a.peer.channel ? p.b : p.a;
    answering.flow.dispose();
    const count = answering.original.length;
    resolve();
    await microtasks();
    expect(answering.original).toHaveLength(count);
    expect(answering.release).toHaveBeenCalledOnce();
  });

  it.each(['close', 'error'] as const)(
    'closes the logical owner when an active side channel emits %s',
    async (kind) => {
      const p = pair();
      await p.activate();
      p.a.peer.channel!.dispatchEvent(new Event(kind));
      expect(p.a.fail).toHaveBeenCalledOnce();
      expect(p.a.release).toHaveBeenCalledOnce();
      p.a.flow.dispose();
      expect(p.a.release).toHaveBeenCalledOnce();
      expect(p.b.fail).not.toHaveBeenCalled();
    },
  );

  it('gives disconnected side ICE a nonrenewing grace and cancels it on recovery', async () => {
    const p = pair({ restart: false });
    await p.activate();
    p.a.peer.state('disconnected');
    vi.advanceTimersByTime(10_000);
    p.a.peer.state('disconnected');
    vi.advanceTimersByTime(4999);
    p.a.peer.state('connected');
    vi.advanceTimersByTime(20_000);
    expect(p.a.fail).not.toHaveBeenCalled();
    p.a.peer.state('disconnected');
    vi.advanceTimersByTime(15_000);
    expect(p.a.fail).toHaveBeenCalledOnce();
  });

  it.each(['failed', 'closed'] as const)(
    'fails exact logical owner on side PC %s',
    async (state) => {
      const p = pair({ restart: false });
      await p.activate();
      p.a.peer.state(state);
      expect(p.a.fail).toHaveBeenCalledOnce();
      expect(p.a.release).toHaveBeenCalledOnce();
    },
  );

  it('bounds outgoing fence message count without dropping an accepted prefix silently', async () => {
    const p = pair();
    await p.negotiate();
    p.a.peer.channel!.open();
    for (let i = 0; i < 128; i++) p.a.flow.send(`{"type":"queued","i":${i}}`);
    expect(p.a.flow.snapshot.outgoingMessages).toBe(128);
    expect(() => p.a.flow.send('{"type":"overflow"}')).toThrow();
    expect(p.a.fail).toHaveBeenCalledOnce();
    expect(p.a.flow.snapshot.outgoingMessages).toBe(0);
  });

  it('counts UTF-8 bytes rather than code units against the incoming handoff limit', async () => {
    const p = pair();
    await p.negotiate();
    p.a.peer.channel!.open();
    const data = JSON.stringify({ type: 'large', text: '가'.repeat(700_000) });
    p.a.peer.channel!.message(data);
    expect(p.a.fail).not.toHaveBeenCalled();
    expect(p.a.flow.snapshot.incomingBytes).toBe(new TextEncoder().encode(data).byteLength);
    p.a.peer.channel!.message(data);
    expect(p.a.fail).toHaveBeenCalledOnce();
    expect(p.a.received).toEqual([]);
  });

  it.each([
    new ArrayBuffer(1),
    '{invalid',
    JSON.stringify({ type: TYPE, version: 1, kind: 'hello', nonce: 'f'.repeat(32) }),
  ])('rejects invalid side-channel wire data', async (data) => {
    const p = pair();
    await p.activate();
    p.a.peer.channel!.message(data);
    expect(p.a.fail).toHaveBeenCalledOnce();
  });

  it('fails a side send exception without retaining a live poisoned connection', async () => {
    const p = pair();
    await p.activate();
    p.a.peer.channel!.sendHook = () => {
      throw new Error('native rejected');
    };
    expect(() => p.a.flow.send('{"type":"play"}')).toThrow('native rejected');
    expect(p.a.fail).toHaveBeenCalledOnce();
    expect(p.a.flow.phase).toBe('closed');
  });

  it('keeps a synchronous send-hook reentry behind the accepted fence queue', async () => {
    const p = pair();
    await p.negotiate();
    p.a.peer.channel!.open();
    p.a.flow.send('{"type":"first"}');
    p.a.flow.send('{"type":"second"}');
    p.a.peer.channel!.sendHook = (data) => {
      if (data === '{"type":"first"}') p.a.flow.send('{"type":"reentrant"}');
    };
    p.b.peer.channel!.open();
    await p.pump();
    expect(p.b.received).toEqual(['{"type":"first"}', '{"type":"second"}', '{"type":"reentrant"}']);
  });

  it('fails closed if queued application dispatch throws during activation', async () => {
    const p = pair();
    await p.negotiate();
    p.a.peer.channel!.open();
    p.a.peer.channel!.message('{"type":"early"}');
    p.a.peer.channel!.message(
      JSON.stringify({ ...hello(p.b), kind: 'ready', target: hello(p.a).nonce }),
    );
    p.a.receive.mockImplementation(() => {
      throw new Error('application callback');
    });
    expect(() =>
      p.a.flow.handleOriginal({ ...hello(p.b), kind: 'fence', target: hello(p.a).nonce }, true),
    ).not.toThrow();
    expect(p.a.fail).toHaveBeenCalledOnce();
    expect(p.a.flow.phase).toBe('closed');
  });

  it('fails initial private send once and leaves no discovery timer or lease', () => {
    const e = endpoint();
    e.sendOriginal.mockImplementation(() => {
      throw new Error('send');
    });
    e.flow.start();
    e.flow.start();
    vi.advanceTimersByTime(60_000);
    expect(e.fail).toHaveBeenCalledOnce();
    expect(e.create).not.toHaveBeenCalled();
    expect(e.flow.phase).toBe('closed');
  });

  it('never creates a second channel or adopts an unreliable/mislabeled one', async () => {
    const p = pair();
    await p.negotiate();
    const duplicate = new Channel();
    p.a.peer.remoteChannel(duplicate);
    expect(duplicate.readyState).toBe('closed');
    expect(p.a.fail).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'unexpected-label' },
    { ordered: false },
    { maxRetransmits: 0 },
    { maxPacketLifeTime: 100 },
  ])('rejects a first remote side channel with unsupported properties %j', async (properties) => {
    const p = pair();
    p.a.flow.allowBulk();
    await p.pump();
    const answerer = p.a.peer.channel ? p.b : p.a;
    const channel = new Channel();
    Object.assign(channel, properties);
    answerer.peer.remoteChannel(channel);
    expect(channel.readyState).toBe('closed');
    expect(answerer.fail).toHaveBeenCalledOnce();
  });

  it('keeps an exact unsubscribe from removing another capacity observer', () => {
    const e = endpoint();
    e.flow.start();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = e.flow.subscribe(first);
    e.flow.subscribe(second);
    unsubscribe();
    vi.advanceTimersByTime(1000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('disposes timers, queues and lease idempotently and wakes current waiters', async () => {
    const p = pair();
    await p.negotiate();
    p.a.peer.channel!.open();
    p.a.flow.send('{"type":"queued"}');
    const wake = vi.fn();
    p.a.flow.subscribe(wake);
    p.a.flow.dispose();
    p.a.flow.dispose();
    vi.advanceTimersByTime(60_000);
    expect(wake).toHaveBeenCalledOnce();
    expect(p.a.release).toHaveBeenCalledOnce();
    expect(p.a.fail).not.toHaveBeenCalled();
    expect(p.a.flow.snapshot.outgoingBytes).toBe(0);
  });
});

function frames(e: Endpoint, kind: string): Frame[] {
  return e.original
    .map((data) => JSON.parse(data) as Frame)
    .filter((frame) => frame.type === TYPE && frame.kind === kind);
}
function roles(p: ReturnType<typeof pair>) {
  // The smaller nonce offered the side PC and owns every restart offer.
  return String(hello(p.a).nonce) < String(hello(p.b).nonce)
    ? { offerer: p.a, answerer: p.b }
    : { offerer: p.b, answerer: p.a };
}
function restarting(e: Endpoint): ControlIsolation {
  if (!(e.flow instanceof ControlIsolation)) throw new Error('current build expected');
  return e.flow;
}
function fromPeer(from: Endpoint, to: Endpoint, kind: string, extra: Frame = {}): Frame {
  return {
    type: TYPE,
    version: 1,
    kind,
    nonce: hello(from).nonce,
    target: hello(to).nonce,
    ...extra,
  };
}
async function live(options?: Parameters<typeof pair>[0]) {
  const p = pair(options);
  await p.activate();
  p.a.peer.state('connected');
  p.b.peer.state('connected');
  return p;
}
function iceRestarts(e: Endpoint): number {
  return e.peer.offerOptions.filter((options) => options?.iceRestart).length;
}

describe('side ICE restart of an active isolated control route', () => {
  it('restarts a failed side PC in place, then delivers held controls in order', async () => {
    const p = await live();
    const { offerer, answerer } = roles(p);
    for (const e of [p.a, p.b]) expect(restarting(e).snapshot.restartCapable).toBe(true);
    // The failed path holds side-channel frames; its SCTP association keeps their order.
    p.link.side = false;
    p.a.flow.send('{"type":"held-1"}');
    p.b.flow.send('{"type":"held-b"}');
    p.a.peer.state('failed');
    p.b.peer.state('failed');
    p.a.flow.send('{"type":"held-2"}');
    await p.pump();
    expect(offerer.peer.offerOptions.at(-1)).toEqual({ iceRestart: true });
    expect(frames(offerer, 'restart-offer')).toEqual([
      expect.objectContaining({ epoch: 1, sdp: 'restart-offer-1' }),
    ]);
    expect(frames(answerer, 'restart-answer')).toEqual([
      expect.objectContaining({ epoch: 1, sdp: 'restart-answer-1' }),
    ]);
    expect(answerer.peer.remoteHistory.at(-1)).toBe('restart-offer-1');
    expect(offerer.peer.remoteHistory.at(-1)).toBe('restart-answer-1');
    offerer.peer.ice({ candidate: 'offerer-new', sdpMid: '0', sdpMLineIndex: 0 });
    answerer.peer.ice({ candidate: 'answerer-new', sdpMid: '0', sdpMLineIndex: 0 });
    await p.pump();
    expect(frames(offerer, 'restart-candidate')).toEqual([expect.objectContaining({ epoch: 1 })]);
    expect(answerer.peer.candidates.at(-1)).toEqual({
      candidate: 'offerer-new',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    expect(offerer.peer.candidates.at(-1)).toEqual({
      candidate: 'answerer-new',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    p.a.peer.state('connected');
    p.b.peer.state('connected');
    p.a.flow.send('{"type":"after"}');
    p.link.side = true;
    await p.pump();
    expect(p.b.received).toEqual(['{"type":"held-1"}', '{"type":"held-2"}', '{"type":"after"}']);
    expect(p.a.received).toEqual(['{"type":"held-b"}']);
    vi.advanceTimersByTime(60_000);
    for (const e of [p.a, p.b]) {
      expect(e.fail).not.toHaveBeenCalled();
      expect(e.flow.phase).toBe('active');
      // Same PC, same lease: a restart never touches the eight-PC owner cap.
      expect(e.create).toHaveBeenCalledOnce();
      expect(e.release).not.toHaveBeenCalled();
      // Both sides apply a due credential renewal before gathering.
      expect(e.prepareRestart).toHaveBeenCalledOnce();
      expect(e.flow.snapshot).toMatchObject({
        restartInterrupted: false,
        localRestartEpoch: 1,
        remoteRestartEpoch: 1,
      });
      expect(e.original.some((data) => /held-|"after"/u.test(data))).toBe(false);
    }
    expect(iceRestarts(offerer)).toBe(1);
    expect(iceRestarts(answerer)).toBe(0);
  });

  it('restarts on disconnected and lets a self-healed path finish the in-flight restart', async () => {
    const p = await live();
    const { offerer, answerer } = roles(p);
    offerer.peer.state('disconnected');
    await microtasks();
    offerer.peer.state('connected');
    expect(restarting(offerer).snapshot.restartInterrupted).toBe(false);
    await p.pump();
    expect(frames(offerer, 'restart-offer')).toHaveLength(1);
    expect(offerer.peer.remoteHistory.at(-1)).toBe('restart-answer-1');
    expect(restarting(answerer).snapshot.restartInterrupted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    for (const e of [p.a, p.b]) {
      expect(e.fail).not.toHaveBeenCalled();
      expect(e.flow.snapshot).toMatchObject({ localRestartEpoch: 1, remoteRestartEpoch: 1 });
    }
  });

  it('waits for the original route to recover before restarting, without spending its window', async () => {
    const p = await live();
    const { offerer, answerer } = roles(p);
    // The original PC is itself restarting: its route cannot carry restart signaling.
    p.link.original = false;
    for (const e of [p.a, p.b]) {
      e.route.originalUp = false;
      restarting(e).originalChanged();
    }
    const sent = [p.a.original.length, p.b.original.length];
    p.a.peer.state('failed');
    p.b.peer.state('failed');
    await p.pump();
    expect([p.a.original.length, p.b.original.length]).toEqual(sent);
    expect(iceRestarts(offerer)).toBe(0);
    await vi.advanceTimersByTimeAsync(14_000);
    for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
    // Recovery 14 s into the side interruption leaves the side 15 s (under its 30 s cap).
    p.link.original = true;
    for (const e of [p.a, p.b]) {
      e.route.originalUp = true;
      restarting(e).originalChanged();
    }
    await p.pump();
    expect(frames(offerer, 'restart-offer')).toHaveLength(1);
    expect(frames(answerer, 'restart-answer')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(14_999);
    for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
    p.a.peer.state('connected');
    p.b.peer.state('connected');
    await vi.advanceTimersByTimeAsync(60_000);
    for (const e of [p.a, p.b]) {
      expect(e.fail).not.toHaveBeenCalled();
      expect(e.flow.phase).toBe('active');
      expect(e.create).toHaveBeenCalledOnce();
    }
  });

  it('closes 15 s after the original route recovers if the restarted side still fails', async () => {
    const p = await live();
    for (const e of [p.a, p.b]) {
      e.route.originalUp = false;
      restarting(e).originalChanged();
    }
    p.a.peer.state('failed');
    p.b.peer.state('failed');
    await vi.advanceTimersByTimeAsync(5_000);
    for (const e of [p.a, p.b]) {
      e.route.originalUp = true;
      restarting(e).originalChanged();
    }
    await p.pump();
    expect(frames(roles(p).offerer, 'restart-offer')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(14_999);
    for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    for (const e of [p.a, p.b]) {
      expect(e.fail).toHaveBeenCalledOnce();
      expect(e.release).toHaveBeenCalledOnce();
    }
  });

  it('never lets one side interruption outlive its 30 s cap while the original stays down', async () => {
    const p = await live();
    for (const e of [p.a, p.b]) {
      e.route.originalUp = false;
      restarting(e).originalChanged();
    }
    p.a.peer.state('failed');
    p.b.peer.state('failed');
    await p.pump();
    await vi.advanceTimersByTimeAsync(29_999);
    for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    for (const e of [p.a, p.b]) {
      expect(e.fail).toHaveBeenCalledOnce();
      expect(e.flow.phase).toBe('closed');
      expect(iceRestarts(e)).toBe(0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('makes at most two restart offers per interruption, then uses the existing close at its deadline', async () => {
    const p = await live();
    const { offerer, answerer } = roles(p);
    p.a.peer.state('failed');
    p.b.peer.state('failed');
    await p.pump();
    // Every restarted generation fails as well.
    for (let i = 0; i < 3; i++) {
      for (const e of [p.a, p.b]) {
        e.peer.state('connecting');
        e.peer.state('failed');
      }
      await p.pump();
    }
    expect(frames(offerer, 'restart-offer').map((frame) => frame.epoch)).toEqual([1, 2]);
    expect(frames(answerer, 'restart-answer').map((frame) => frame.epoch)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(14_999);
    for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    for (const e of [p.a, p.b]) {
      expect(e.fail).toHaveBeenCalledOnce();
      expect(e.release).toHaveBeenCalledOnce();
      expect(e.flow.phase).toBe('closed');
    }
    const counts = [p.a.original.length, p.b.original.length];
    await vi.advanceTimersByTimeAsync(60_000);
    expect([p.a.original.length, p.b.original.length]).toEqual(counts);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets the answerer request one restart per generation, bounded per offerer window', async () => {
    const p = await live();
    const { offerer, answerer } = roles(p);
    answerer.peer.state('failed');
    await p.pump();
    expect(frames(answerer, 'restart-request')).toEqual([expect.objectContaining({ epoch: 0 })]);
    expect(frames(offerer, 'restart-offer')).toEqual([expect.objectContaining({ epoch: 1 })]);
    expect(frames(answerer, 'restart-answer')).toEqual([expect.objectContaining({ epoch: 1 })]);
    // A request for an already restarted generation is stale.
    offerer.flow.handleOriginal(fromPeer(answerer, offerer, 'restart-request', { epoch: 0 }), true);
    await p.pump();
    expect(frames(offerer, 'restart-offer')).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      answerer.peer.state('connecting');
      answerer.peer.state('failed');
      await p.pump();
    }
    expect(frames(answerer, 'restart-request').map((frame) => frame.epoch)).toEqual([0, 1, 2]);
    expect(frames(offerer, 'restart-offer').map((frame) => frame.epoch)).toEqual([1, 2]);
    // The offerer's own connected events do not reopen a peer-requested window.
    offerer.peer.state('connected');
    offerer.flow.handleOriginal(fromPeer(answerer, offerer, 'restart-request', { epoch: 2 }), true);
    await p.pump();
    expect(frames(offerer, 'restart-offer')).toHaveLength(2);
    answerer.peer.state('connected');
    await vi.advanceTimersByTimeAsync(15_000);
    // The offerer's own PC stayed connected: its request window ends without a close.
    for (const e of [p.a, p.b]) {
      expect(e.fail).not.toHaveBeenCalled();
      expect(restarting(e).snapshot.restartInterrupted).toBe(false);
    }
    offerer.flow.handleOriginal(fromPeer(answerer, offerer, 'restart-request', { epoch: 2 }), true);
    await p.pump();
    expect(frames(offerer, 'restart-offer').map((frame) => frame.epoch)).toEqual([1, 2, 3]);
    expect(offerer.flow.phase).toBe('active');
  });

  it.each(['failed', 'disconnected'] as const)(
    'keeps the C9 terminal side-%s behavior against a real peer without the capability',
    async (state) => {
      const p = await live({ b: 'c9' });
      for (const e of [p.a, p.b]) expect(e.flow.phase).toBe('active');
      // The C9 build ignored the advertisement and never sent its own.
      expect(restarting(p.a).snapshot.restartCapable).toBe(false);
      expect(p.b.fail).not.toHaveBeenCalled();
      p.a.flow.send('{"type":"mixed-control"}');
      await p.pump();
      expect(p.b.received).toEqual(['{"type":"mixed-control"}']);
      p.a.peer.state(state);
      p.b.peer.state(state);
      if (state === 'disconnected') {
        await vi.advanceTimersByTimeAsync(14_999);
        for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      await p.pump();
      for (const e of [p.a, p.b]) {
        expect(e.fail).toHaveBeenCalledOnce();
        expect(e.release).toHaveBeenCalledOnce();
        expect(iceRestarts(e)).toBe(0);
      }
      expect(frames(p.a, 'restart-offer')).toEqual([]);
      expect(frames(p.a, 'restart-request')).toEqual([]);
    },
  );

  it.each(['credential', 'offer'] as const)(
    'sends no restart offer after disposal during awaited %s work',
    async (gate) => {
      const p = await live();
      const { offerer, answerer } = roles(p);
      let resolve!: () => void;
      const pending = new Promise<void>((done) => {
        resolve = done;
      });
      if (gate === 'credential') offerer.prepareRestart.mockImplementationOnce(() => pending);
      else offerer.peer.offerGate = pending;
      offerer.peer.state('failed');
      await p.pump();
      expect(offerer.prepareRestart).toHaveBeenCalledOnce();
      const count = offerer.original.length;
      offerer.flow.dispose();
      resolve();
      await p.pump();
      expect(offerer.original).toHaveLength(count);
      expect(iceRestarts(offerer)).toBe(gate === 'offer' ? 1 : 0);
      expect(offerer.release).toHaveBeenCalledOnce();
      // Late PC events, owner notifications and frames after disposal change nothing.
      offerer.peer.state('connected');
      offerer.peer.state('failed');
      restarting(offerer).originalChanged();
      offerer.flow.handleOriginal(
        fromPeer(answerer, offerer, 'restart-answer', { epoch: 1, sdp: 'late' }),
        true,
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(offerer.original).toHaveLength(count);
      expect(offerer.fail).not.toHaveBeenCalled();
      expect(offerer.peer.remoteHistory).not.toContain('late');
    },
  );

  it('sends no restart answer after disposal during an awaited restart description', async () => {
    const p = await live();
    const { offerer, answerer } = roles(p);
    let resolve!: () => void;
    answerer.peer.remoteGate = new Promise<void>((done) => {
      resolve = done;
    });
    offerer.peer.state('failed');
    await p.pump();
    expect(frames(offerer, 'restart-offer')).toHaveLength(1);
    const count = answerer.original.length;
    answerer.flow.dispose();
    resolve();
    await p.pump();
    expect(answerer.original).toHaveLength(count);
    expect(frames(answerer, 'restart-answer')).toEqual([]);
    expect(answerer.release).toHaveBeenCalledOnce();
  });

  it('accepts restart signaling only from the exact peer, lane, role and generation', async () => {
    const p = pair();
    await p.negotiate();
    const { offerer, answerer } = roles(p);
    const offer = fromPeer(offerer, answerer, 'restart-offer', { epoch: 1, sdp: 'direct-offer' });
    // Before both endpoints are active, restart signaling has no authority.
    answerer.flow.handleOriginal(offer, true);
    p.a.peer.channel!.open();
    p.b.peer.channel!.open();
    await p.pump();
    for (const e of [p.a, p.b]) e.peer.state('connected');
    expect(answerer.peer.remoteHistory).not.toContain('direct-offer');
    const before = answerer.peer.remoteHistory.length;
    for (const [frame, lane] of [
      [{ ...offer, nonce: '0'.repeat(32) }, true],
      [{ ...offer, target: '0'.repeat(32) }, true],
      [offer, false],
      [{ ...offer, epoch: 0 }, true],
      [{ ...offer, epoch: 2 }, true],
      [{ ...offer, epoch: 1.5 }, true],
      [{ ...offer, epoch: '1' }, true],
      [{ ...offer, epoch: 2 ** 31 }, true],
      [{ ...offer, extra: true }, true],
      [{ ...offer, sdp: '' }, true],
      [{ ...offer, sdp: 'x'.repeat(32 * 1024 + 1) }, true],
      [fromPeer(offerer, answerer, 'restart-request', { epoch: -1 }), true],
      [fromPeer(offerer, answerer, 'restart-answer', { epoch: 1, sdp: 'role' }), true],
    ] as const) {
      expect(answerer.flow.handleOriginal(frame, lane)).toBe(true);
    }
    // The offerer never accepts an offer, nor an answer without its own attempt.
    offerer.flow.handleOriginal(
      fromPeer(answerer, offerer, 'restart-offer', { epoch: 1, sdp: 'x' }),
      true,
    );
    offerer.flow.handleOriginal(
      fromPeer(answerer, offerer, 'restart-answer', { epoch: 1, sdp: 'x' }),
      true,
    );
    await p.pump();
    expect(answerer.peer.remoteHistory).toHaveLength(before);
    expect(offerer.peer.remoteHistory.at(-1)).toBe('answer-description');
    expect(frames(answerer, 'restart-answer')).toEqual([]);
    for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
    answerer.flow.handleOriginal(offer, true);
    await p.pump();
    expect(answerer.peer.remoteHistory.at(-1)).toBe('direct-offer');
    expect(frames(answerer, 'restart-answer')).toEqual([expect.objectContaining({ epoch: 1 })]);
    // The side channel itself never carries private restart frames.
    answerer.peer.channel!.message(
      JSON.stringify(fromPeer(offerer, answerer, 'restart-request', { epoch: 0 })),
    );
    expect(answerer.fail).toHaveBeenCalledOnce();
  });

  it('sends new-generation candidates after their description and drops superseded ones', async () => {
    const p = await live();
    const { offerer, answerer } = roles(p);
    let resolve!: () => void;
    offerer.peer.localGate = new Promise<void>((done) => {
      resolve = done;
    });
    offerer.peer.state('failed');
    await p.pump();
    // Gathering may surface a candidate before setLocalDescription settles.
    offerer.peer.ice({ candidate: 'early-new', sdpMid: '0', sdpMLineIndex: 0 });
    expect(frames(offerer, 'restart-candidate')).toEqual([]);
    resolve();
    await p.pump();
    const kinds = offerer.original
      .map((data) => JSON.parse(data) as Frame)
      .filter((frame) => frame.type === TYPE)
      .map((frame) => frame.kind);
    expect(kinds.slice(kinds.indexOf('restart-offer'))).toEqual([
      'restart-offer',
      'restart-candidate',
    ]);
    expect(answerer.peer.candidates.at(-1)).toEqual({
      candidate: 'early-new',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    const applied = answerer.peer.candidates.length;
    // Initial-generation and wrong-generation trickle is not applied after a restart.
    answerer.flow.handleOriginal(
      fromPeer(offerer, answerer, 'candidate', { candidate: { candidate: 'old-generation' } }),
      true,
    );
    answerer.flow.handleOriginal(
      fromPeer(offerer, answerer, 'restart-candidate', {
        epoch: 2,
        candidate: { candidate: 'future-generation' },
      }),
      true,
    );
    await p.pump();
    expect(answerer.peer.candidates).toHaveLength(applied);
    // A browser rejection of a restart candidate is not route failure.
    answerer.peer.rejectCandidates = true;
    answerer.flow.handleOriginal(
      fromPeer(offerer, answerer, 'restart-candidate', {
        epoch: 1,
        candidate: { candidate: 'rejected' },
      }),
      true,
    );
    await p.pump();
    expect(answerer.fail).not.toHaveBeenCalled();
    expect(answerer.flow.phase).toBe('active');
    // The per-generation budget still bounds an authenticated flood.
    for (let i = 0; i < 128; i++)
      answerer.flow.handleOriginal(
        fromPeer(offerer, answerer, 'restart-candidate', {
          epoch: 1,
          candidate: { candidate: `flood-${i}` },
        }),
        true,
      );
    expect(answerer.fail).toHaveBeenCalledOnce();
  });

  it('takes over a side disconnect that began during the fenced handoff', async () => {
    const p = pair();
    await p.negotiate();
    p.a.peer.channel!.open();
    p.a.peer.state('disconnected');
    p.b.peer.channel!.open();
    await p.pump();
    expect(p.a.flow.phase).toBe('active');
    expect(restarting(p.a).snapshot.restartInterrupted).toBe(true);
    expect(frames(roles(p).offerer, 'restart-offer')).toHaveLength(1);
    p.a.peer.state('connected');
    p.b.peer.state('connected');
    await vi.advanceTimersByTimeAsync(60_000);
    for (const e of [p.a, p.b]) {
      expect(e.fail).not.toHaveBeenCalled();
      expect(e.flow.phase).toBe('active');
    }
  });

  it('still closes the logical owner when the side PC itself is closed', async () => {
    const p = await live();
    p.a.peer.state('closed');
    expect(p.a.fail).toHaveBeenCalledOnce();
    expect(p.a.release).toHaveBeenCalledOnce();
    expect(iceRestarts(p.a)).toBe(0);
  });

  it("gives the offerer's own later outage a full window after a peer-requested restart", async () => {
    const p = await live();
    const { offerer, answerer } = roles(p);
    answerer.peer.state('disconnected');
    await p.pump();
    expect(frames(offerer, 'restart-offer')).toHaveLength(1);
    answerer.peer.state('connected');
    await vi.advanceTimersByTimeAsync(13_000);
    offerer.peer.state('disconnected');
    await p.pump();
    expect(frames(offerer, 'restart-offer').map((frame) => frame.epoch)).toEqual([1, 2]);
    expect(restarting(offerer).snapshot.restartInterrupted).toBe(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(offerer.fail).not.toHaveBeenCalled();
    offerer.peer.state('connected');
    await vi.advanceTimersByTimeAsync(60_000);
    for (const e of [p.a, p.b]) {
      expect(e.fail).not.toHaveBeenCalled();
      expect(e.flow.phase).toBe('active');
    }
  });

  it('completes a restart offered while the answerer still awaits READY', async () => {
    const p = pair();
    await p.negotiate();
    const { offerer, answerer } = roles(p);
    // Only the offerer receives READY: it is active while the answerer still fences.
    const toAnswerer = offerer === p.a ? 'aToB' : 'bToA';
    p.link[toAnswerer] = false;
    p.a.peer.channel!.open();
    p.b.peer.channel!.open();
    await p.pump();
    expect(offerer.flow.phase).toBe('active');
    expect(answerer.flow.phase).toBe('fencing');
    for (const e of [p.a, p.b]) e.peer.state('connected');
    offerer.peer.state('failed');
    answerer.peer.state('failed');
    await p.pump();
    expect(frames(offerer, 'restart-offer')).toHaveLength(1);
    expect(frames(answerer, 'restart-answer')).toEqual([expect.objectContaining({ epoch: 1 })]);
    for (const e of [p.a, p.b]) e.peer.state('connected');
    p.link[toAnswerer] = true;
    await p.pump();
    expect(answerer.flow.phase).toBe('active');
    // The answered attempt leaves later outages restartable.
    offerer.peer.state('disconnected');
    await p.pump();
    expect(frames(offerer, 'restart-offer').map((frame) => frame.epoch)).toEqual([1, 2]);
    expect(frames(answerer, 'restart-answer').map((frame) => frame.epoch)).toEqual([1, 2]);
    for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
  });

  it('keeps the 10 s handoff deadline for a restart that begins before activation', async () => {
    const p = pair();
    await p.negotiate();
    const { offerer, answerer } = roles(p);
    p.link[offerer === p.a ? 'aToB' : 'bToA'] = false;
    p.a.peer.channel!.open();
    p.b.peer.channel!.open();
    await p.pump();
    for (const e of [p.a, p.b]) e.peer.state('connected');
    offerer.peer.state('failed');
    answerer.peer.state('failed');
    await p.pump();
    expect(frames(answerer, 'restart-answer')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(answerer.fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(answerer.fail).toHaveBeenCalledOnce();
    expect(offerer.fail).not.toHaveBeenCalled();
  });

  it("restarts again when the offerer's own outage began during a peer-requested attempt", async () => {
    const p = await live();
    const { offerer, answerer } = roles(p);
    let resolve!: () => void;
    offerer.peer.offerGate = new Promise<void>((done) => {
      resolve = done;
    });
    answerer.peer.state('failed');
    await p.pump();
    expect(iceRestarts(offerer)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    // The offer's candidates were gathered before this outage began.
    offerer.peer.state('disconnected');
    resolve();
    await p.pump();
    expect(frames(offerer, 'restart-offer').map((frame) => frame.epoch)).toEqual([1, 2]);
    for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
  });

  it("spends a local outage's attempts on peer requests during it, not the peer window", async () => {
    const p = await live();
    const { offerer, answerer } = roles(p);
    const request = (epoch: number) =>
      offerer.flow.handleOriginal(fromPeer(answerer, offerer, 'restart-request', { epoch }), true);
    offerer.peer.state('failed');
    await p.pump();
    request(1);
    await p.pump();
    offerer.peer.state('connecting');
    offerer.peer.state('failed');
    await p.pump();
    expect(frames(offerer, 'restart-offer').map((frame) => frame.epoch)).toEqual([1, 2]);
    offerer.peer.state('connected');
    request(2);
    await p.pump();
    expect(frames(offerer, 'restart-offer').map((frame) => frame.epoch)).toEqual([1, 2, 3]);
  });

  it('stops offering at the answer bound instead of tripping it', async () => {
    const p = await live();
    const { offerer, answerer } = roles(p);
    for (let i = 0; i < 17; i++) {
      offerer.peer.state('failed');
      await p.pump();
      offerer.peer.state('connected');
    }
    expect(frames(offerer, 'restart-offer')).toHaveLength(16);
    expect(answerer.fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    offerer.peer.state('failed');
    await p.pump();
    expect(frames(offerer, 'restart-offer')).toHaveLength(17);
    for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
  });

  it('closes an answerer offered more restarts than any legitimate offerer sends', async () => {
    const p = await live();
    const { offerer, answerer } = roles(p);
    const offer = (epoch: number) =>
      answerer.flow.handleOriginal(
        fromPeer(offerer, answerer, 'restart-offer', { epoch, sdp: `offer-${epoch}` }),
        true,
      );
    for (let epoch = 1; epoch <= 16; epoch++) offer(epoch);
    await p.pump();
    expect(answerer.fail).not.toHaveBeenCalled();
    // The bound is a rolling 30 s window.
    await vi.advanceTimersByTimeAsync(30_000);
    for (let epoch = 17; epoch <= 32; epoch++) offer(epoch);
    await p.pump();
    expect(answerer.fail).not.toHaveBeenCalled();
    offer(33);
    expect(answerer.fail).toHaveBeenCalledOnce();
    expect(answerer.flow.phase).toBe('closed');
  });

  it('keeps side deadlines on the monotonic clock across a wall-clock correction', async () => {
    const p = await live();
    for (const e of [p.a, p.b]) {
      e.route.originalUp = false;
      restarting(e).originalChanged();
    }
    p.a.peer.state('failed');
    p.b.peer.state('failed');
    await vi.advanceTimersByTimeAsync(5_000);
    // A network change can also correct the device clock by minutes.
    vi.setSystemTime(Date.now() + 120_000);
    for (const e of [p.a, p.b]) {
      e.route.originalUp = true;
      restarting(e).originalChanged();
    }
    await p.pump();
    expect(frames(roles(p).offerer, 'restart-offer')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(14_999);
    for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
    p.a.peer.state('connected');
    p.b.peer.state('connected');
    await vi.advanceTimersByTimeAsync(60_000);
    for (const e of [p.a, p.b]) expect(e.fail).not.toHaveBeenCalled();
  });
});
