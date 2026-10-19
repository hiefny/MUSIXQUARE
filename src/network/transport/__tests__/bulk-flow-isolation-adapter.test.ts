/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../../core/constants.ts';
import { waitForTransferCapacity } from '../../../storage/transfer-backpressure.ts';
import type { DataConnection } from '../../../types/index.ts';
import { CloudflareDataConnection } from '../cloudflare-signaling.ts';

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
  close(): void {
    if (this.connectionState === 'closed') return;
    this.connectionState = 'closed';
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

async function flush(): Promise<void> {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}
const connections: CloudflareDataConnection[] = [];
async function endpoint(isolated = true) {
  const sidePc = new PeerConnection();
  const release = vi.fn();
  const create = vi.fn(() => ({ pc: sidePc as unknown as RTCPeerConnection, release }));
  const conn = new CloudflareDataConnection(
    `peer-${connections.length}`,
    undefined,
    null,
    undefined,
    undefined,
    isolated ? create : undefined,
  );
  connections.push(conn);
  const pc = new PeerConnection();
  const bulk = new Channel('musixquare-data');
  const control = new Channel('musixquare-control');
  conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
  conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
  await flush();
  conn.startBulkFlowControl();
  return { conn, pc, bulk, control, sidePc, release, create };
}

async function pair() {
  const a = await endpoint();
  const b = await endpoint();
  let ac = 0,
    bc = 0,
    as = 0,
    bs = 0;
  const pump = async () => {
    for (let i = 0; i < 12; i++) {
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
  const negotiate = async () => {
    expect(a.conn.bulkFlowControl.hasCapacity(CHUNK_SIZE)).toBe(false);
    await pump();
    const answerer = a.sidePc.channel ? b : a;
    answerer.sidePc.remoteChannel();
  };
  const activate = async () => {
    await negotiate();
    a.sidePc.channel!.open();
    b.sidePc.channel!.open();
    await pump();
    expect(a.conn.controlIsolation?.phase).toBe('active');
    expect(b.conn.controlIsolation?.phase).toBe('active');
  };
  return { a, b, pump, negotiate, activate };
}

function chunk(type: string = MSG.FILE_CHUNK, index = 0) {
  return {
    type,
    chunk: new Uint8Array(CHUNK_SIZE),
    chunkIndex: index,
    queueItemId: '00000000-0000-4000-8000-000000000001',
    sessionId: 1,
  };
}
function delayedBlob(bytes: ArrayBuffer) {
  let resolve!: (value: ArrayBuffer) => void;
  let reject!: (reason: Error) => void;
  const pending = new Promise<ArrayBuffer>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const blob = new Blob([bytes]);
  Object.defineProperty(blob, 'arrayBuffer', { value: () => pending });
  return { blob, resolve: () => resolve(bytes), reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  vi.useRealTimers();
});

describe('Cloudflare file boundary routing', () => {
  it.each([
    [MSG.FILE_START, MSG.FILE_CHUNK, MSG.FILE_END],
    [MSG.FILE_RESUME, MSG.FILE_CHUNK, MSG.FILE_END],
    [MSG.PRELOAD_START, MSG.PRELOAD_CHUNK, MSG.PRELOAD_END],
    [
      MSG.OPERATOR_FILE_UPLOAD_START,
      MSG.OPERATOR_FILE_UPLOAD_CHUNK,
      MSG.OPERATOR_FILE_UPLOAD_FINISH,
    ],
  ])('keeps %s / %s / %s on the original ordered bulk lane', async (start, payload, end) => {
    const p = await pair();
    await p.activate();
    const received: Record<string, unknown>[] = [];
    p.b.conn.on('data', (value) => received.push(value as Record<string, unknown>));
    const sideBefore = p.a.sidePc.channel!.sent.length;
    const originalBefore = p.a.control.sent.length;
    p.a.conn.send({ type: start, sessionId: 1 });
    p.a.conn.send(chunk(payload));
    p.a.conn.send({ type: end, sessionId: 1 });
    expect(p.a.bulk.sent).toHaveLength(3);
    expect(JSON.parse(p.a.bulk.sent[0] as string).type).toBe(start);
    expect(p.a.bulk.sent[1]).toBeInstanceOf(ArrayBuffer);
    expect(JSON.parse(p.a.bulk.sent[2] as string).type).toBe(end);
    expect(p.a.control.sent).toHaveLength(originalBefore);
    expect(p.a.sidePc.channel!.sent).toHaveLength(sideBefore);
    for (const frame of p.a.bulk.sent) p.b.bulk.receive(frame);
    await flush();
    expect(received.map((value) => value.type)).toEqual([start, payload, end]);
    expect((received[1]!.chunk as Uint8Array).byteLength).toBe(CHUNK_SIZE);
    const credited = payload === MSG.OPERATOR_FILE_UPLOAD_CHUNK ? 0 : CHUNK_SIZE;
    expect(p.a.conn.bulkFlowControl.diagnosticSnapshot.sentBytes).toBe(credited);
    expect(p.b.conn.bulkFlowControl.diagnosticSnapshot.receivedBytes).toBe(credited);
  });

  it.each([MSG.FILE_START, MSG.FILE_RESUME, MSG.PRELOAD_START, MSG.OPERATOR_FILE_UPLOAD_START])(
    'accepts %s on either original lane without requiring a new isolated receiver',
    async (type) => {
      const receiver = await endpoint(false);
      const onData = vi.fn();
      receiver.conn.on('data', onData);
      for (const [index, lane] of [receiver.bulk, receiver.control].entries()) {
        const frame = { type, sessionId: index + 1 };
        lane.receive(JSON.stringify(frame));
        await flush();
        expect(onData).toHaveBeenLastCalledWith(frame);
      }
      expect(onData).toHaveBeenCalledTimes(2);
      expect(receiver.conn.bulkFlowControl.diagnosticSnapshot.adaptiveEnabled).toBe(false);
    },
  );
});

describe('Cloudflare isolated control integration', () => {
  it('defers adaptive learning until ready handoff and routes both control and receipts through side', async () => {
    const p = await pair();
    expect(p.a.conn.bulkFlowControl.diagnosticSnapshot.adaptiveEnabled).toBe(false);
    expect(p.a.create).not.toHaveBeenCalled();
    await p.negotiate();
    p.a.sidePc.channel!.open();
    await p.pump();
    expect(p.a.conn.bulkFlowControl.hasCapacity(CHUNK_SIZE)).toBe(false);
    expect(p.a.conn.bulkFlowControl.diagnosticSnapshot.adaptiveEnabled).toBe(false);
    p.b.sidePc.channel!.open();
    await p.pump();
    expect(p.a.conn.bulkFlowControl.diagnosticSnapshot.adaptiveEnabled).toBe(true);
    const originalBefore = p.a.control.sent.length;
    const received = vi.fn();
    p.b.conn.on('data', received);
    p.a.conn.send({ type: MSG.PAUSE });
    await p.pump();
    expect(received).toHaveBeenCalledExactlyOnceWith({ type: MSG.PAUSE });
    let sent = 0;
    let delivered = 0;
    // Keep the window full and deliver at window/loop, so every chunk's receipt
    // returns `loop` ms after its send: a path whose BDP exceeds the window.
    const run = async (count: number, loop: number) => {
      for (let index = 0; index < count; index++) {
        while (p.a.conn.bulkFlowControl.hasCapacity(CHUNK_SIZE)) {
          p.a.conn.send(chunk(MSG.PRELOAD_CHUNK, sent++));
        }
        const { windowBytes } = p.a.conn.bulkFlowControl.diagnosticSnapshot;
        await vi.advanceTimersByTimeAsync((loop * CHUNK_SIZE) / windowBytes);
        p.b.bulk.receive(p.a.bulk.sent[delivered++]);
        await p.pump();
      }
    };
    await run(7, 300);
    expect(p.a.conn.bulkFlowControl.diagnosticSnapshot).toMatchObject({
      windowBytes: 192 * 1024,
      phase: 'probe',
      baseAgeMs: 300,
      lastDecision: 'probe-192',
    });
    await run(30, 300);
    expect(p.a.conn.bulkFlowControl.diagnosticSnapshot).toMatchObject({
      windowBytes: 256 * 1024,
      phase: 'measure',
      lastDecision: 'accepted-256',
      sentBytes: sent * CHUNK_SIZE,
      acknowledgedBytes: delivered * CHUNK_SIZE,
      outstandingBytes: (sent - delivered) * CHUNK_SIZE,
    });
    expect(p.a.control.sent).toHaveLength(originalBefore);
    expect(
      p.b.sidePc.channel!.sent.some((value) => JSON.parse(value as string).kind === 'receipt'),
    ).toBe(true);
  });

  it('dispatches delayed original decoding before its fence and subsequent isolated application control', async () => {
    const p = await pair();
    await p.negotiate();
    // Use the actual codec to represent an asynchronously decoded old-lane frame.
    p.a.conn.send({ type: MSG.PAUSE, chunk: new Uint8Array([7]) });
    const delayed = delayedBlob(p.a.bulk.sent[0] as ArrayBuffer);
    const seen: string[] = [];
    p.b.conn.on('data', (value) => seen.push((value as { type: string }).type));
    p.b.control.receive(delayed.blob);
    p.a.sidePc.channel!.open();
    p.b.sidePc.channel!.open();
    await p.pump();
    expect(seen).toEqual([]);
    expect(p.b.conn.controlIsolation?.snapshot.remoteFence).toBe(false);
    expect(p.b.conn.bulkFlowControl.diagnosticSnapshot.adaptiveEnabled).toBe(false);
    p.a.conn.send({ type: MSG.PLAY });
    delayed.resolve();
    await p.pump();
    expect(seen).toEqual([MSG.PAUSE, MSG.PLAY]);
    expect(p.a.conn.open).toBe(true);
    expect(p.b.conn.controlIsolation?.phase).toBe('active');
  });

  it.each(['replace', 'close'])('ignores an old original decode after %s', async (action) => {
    const e = await endpoint(false);
    e.conn.send({ type: MSG.PAUSE, chunk: new Uint8Array([7]) });
    const delayed = delayedBlob(e.bulk.sent[0] as ArrayBuffer);
    const received = vi.fn();
    e.conn.on('data', received);
    e.control.receive(delayed.blob);
    await flush();
    if (action === 'replace')
      e.conn.controlChannel = new Channel('musixquare-control') as unknown as RTCDataChannel;
    else e.conn.close();
    delayed.resolve();
    await flush();
    expect(received).not.toHaveBeenCalled();
  });

  it('ignores a rejected old-channel decoder after the original channel was replaced', async () => {
    const e = await endpoint(false);
    e.conn.send({ type: MSG.PAUSE, chunk: new Uint8Array([7]) });
    const delayed = delayedBlob(e.bulk.sent[0] as ArrayBuffer);
    const errors = vi.fn();
    e.conn.on('error', errors);
    e.control.receive(delayed.blob);
    await flush();
    e.conn.controlChannel = new Channel('musixquare-control') as unknown as RTCDataChannel;
    delayed.reject(new Error('old-channel-decode-failed'));
    await flush();
    expect(errors).not.toHaveBeenCalled();
    expect(e.conn.open).toBe(true);
  });

  it('retains the foreground side-disconnect deadline after a redundant main-connected event', async () => {
    const p = await pair();
    await p.activate();
    p.a.sidePc.connectionState = 'disconnected';
    p.a.sidePc.dispatchEvent(new Event('connectionstatechange'));
    expect(p.a.conn.recoverAfterBackground(60_000, false)).toBe('monitoring');
    p.a.pc.dispatchEvent(new Event('connectionstatechange'));
    await vi.advanceTimersByTimeAsync(999);
    expect(p.a.conn.open).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.a.conn.open).toBe(false);
    expect(p.a.release).toHaveBeenCalledOnce();
  });

  it('settles a real capacity waiter on side failure and retains outstanding lifetime debt', async () => {
    const p = await pair();
    await p.activate();
    p.a.conn.send(chunk());
    p.a.conn.send(chunk());
    const wait = waitForTransferCapacity(
      p.a.conn as unknown as DataConnection,
      CHUNK_SIZE,
      10_000,
      () => true,
    );
    const close = vi.fn();
    p.a.conn.on('close', close);
    p.a.sidePc.channel!.close();
    await expect(wait).resolves.toBe('stopped');
    expect(close).toHaveBeenCalledOnce();
    expect(p.a.conn.bulkFlowControl.diagnosticSnapshot).toMatchObject({
      phase: 'disposed',
      adaptiveEnabled: false,
      sentBytes: 2 * CHUNK_SIZE,
      acknowledgedBytes: 0,
      outstandingBytes: 2 * CHUNK_SIZE,
    });
    expect(p.a.bulk.readyState).toBe('closed');
    expect(p.a.release).toHaveBeenCalledOnce();
    p.b.conn.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates a failed native isolated send rather than reporting a successful application send', async () => {
    const p = await pair();
    await p.activate();
    p.a.sidePc.channel!.failSend = true;
    expect(() => p.a.conn.send({ type: MSG.PAUSE })).toThrow('native-send-failed');
    expect(p.a.conn.open).toBe(false);
    expect(p.a.release).toHaveBeenCalledOnce();
    expect(p.a.conn.bulkFlowControl.hasCapacity(1)).toBe(false);
  });
});
