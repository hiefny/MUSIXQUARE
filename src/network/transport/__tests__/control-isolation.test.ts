import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlIsolation } from '../control-isolation.ts';

const TYPE = 'mxqr-control-isolation';
const LABEL = 'musixquare-control-isolated';
type Frame = Record<string, unknown>;
const owners: ControlIsolation[] = [];

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
  closeCount = 0;
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    await this.offerGate;
    return { type: 'offer', sdp: 'offer-description' };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: 'answer-description' };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    await this.remoteGate;
    this.remoteDescription = description;
  }
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
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

function endpoint() {
  const peer = new Peer();
  const original: string[] = [];
  const received: string[] = [];
  const release = vi.fn();
  const changed = vi.fn();
  const fail = vi.fn();
  const create = vi.fn(() => ({ pc: peer as unknown as RTCPeerConnection, release }));
  const sendOriginal = vi.fn((data: string) => {
    original.push(data);
  });
  const receive = vi.fn((data: string) => {
    received.push(data);
  });
  const flow = new ControlIsolation({
    createPeerConnection: create,
    sendOriginal,
    receive,
    changed,
    fail,
  });
  owners.push(flow);
  return { flow, peer, original, received, release, changed, fail, create, sendOriginal, receive };
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
function pair() {
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
  const original = () => {
    for (const [from, to, start] of [
      [a, b, ai],
      [b, a, bi],
    ] as const) {
      for (let index = start; index < from.original.length; index++) {
        const data = from.original[index];
        if (!to.flow.handleOriginal(JSON.parse(data), true) && to.flow.acceptOriginalApplication())
          to.receive(data);
      }
    }
    ai = a.original.length;
    bi = b.original.length;
  };
  const side = () => {
    for (; asi < (a.peer.channel?.sent.length ?? 0); asi++)
      b.peer.channel!.message(a.peer.channel!.sent[asi]);
    for (; bsi < (b.peer.channel?.sent.length ?? 0); bsi++)
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
  return { a, b, original, side, pump, negotiate, activate };
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
    const p = pair();
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
      const p = pair();
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
