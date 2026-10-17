/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_SIZE, MSG } from '../../../core/constants.ts';
import { CloudflareDataConnection } from '../cloudflare-signaling.ts';

class Channel extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  binaryType: BinaryType = 'arraybuffer';
  sent: Array<string | ArrayBuffer> = [];
  failSend = false;
  constructor(readonly label: string) {
    super();
  }
  send(data: string | ArrayBuffer): void {
    if (this.failSend) throw new Error('native-send-failed');
    this.sent.push(data);
  }
  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class PeerConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = 'connected';
  close(): void {
    this.connectionState = 'closed';
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

const connections: CloudflareDataConnection[] = [];
async function endpoint() {
  const conn = new CloudflareDataConnection(`peer-${connections.length}`);
  connections.push(conn);
  const pc = new PeerConnection();
  const bulk = new Channel('musixquare-data');
  const control = new Channel('musixquare-control');
  conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
  conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
  await Promise.resolve();
  return { conn, bulk, control };
}

async function pair() {
  const sender = await endpoint();
  const receiver = await endpoint();
  sender.control.receive(receiver.control.sent[0]);
  receiver.control.receive(sender.control.sent[0]);
  await Promise.resolve();
  return { sender, receiver };
}

function chunk(
  type: typeof MSG.FILE_CHUNK | typeof MSG.PRELOAD_CHUNK = MSG.FILE_CHUNK,
  size = CHUNK_SIZE,
) {
  return {
    type,
    chunk: new Uint8Array(size),
    chunkIndex: 0,
    queueItemId: '00000000-0000-4000-8000-000000000001',
    sessionId: 1,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const conn of connections.splice(0)) conn.close();
  vi.useRealTimers();
});

describe('Cloudflare transport receiver credit', () => {
  it('offers capability on control before application open, never through the file stream', async () => {
    const conn = new CloudflareDataConnection('opening');
    connections.push(conn);
    const pc = new PeerConnection();
    const bulk = new Channel('musixquare-data');
    const control = new Channel('musixquare-control');
    const observedAtOpen: unknown[] = [];
    conn.on('open', () => observedAtOpen.push(...control.sent));
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await Promise.resolve();
    expect(observedAtOpen).toHaveLength(1);
    expect(JSON.parse(observedAtOpen[0] as string)).toMatchObject({
      type: 'mxqr-bulk-flow',
      version: 1,
      kind: 'hello',
    });
    expect(bulk.sent).toHaveLength(0);
  });

  it('shares a payload window across FILE/PRELOAD without charging codec headers or blocking control/END', async () => {
    const { sender, receiver } = await pair();
    sender.conn.send(chunk());
    sender.conn.send(chunk(MSG.PRELOAD_CHUNK));
    expect(sender.bulk.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect((sender.bulk.sent[0] as ArrayBuffer).byteLength).toBeGreaterThan(CHUNK_SIZE);
    expect(sender.conn.bulkFlowControl.hasCapacity(1)).toBe(false);
    expect(() => sender.conn.send(chunk())).toThrow('BULK_FLOW_CAPACITY_EXCEEDED');
    expect(() => sender.conn.send({ type: MSG.PAUSE })).not.toThrow();
    expect(() => sender.conn.send({ type: MSG.FILE_END })).not.toThrow();
    expect(JSON.parse(sender.bulk.sent.at(-1) as string)).toEqual({ type: MSG.FILE_END });
    receiver.bulk.receive(sender.bulk.sent[0]);
    await Promise.resolve();
    sender.control.receive(receiver.control.sent.at(-1));
    await Promise.resolve();
    expect(sender.conn.bulkFlowControl.hasCapacity(CHUNK_SIZE)).toBe(true);
  });

  it('releases transport credit even when the application ignores every decoded payload', async () => {
    const { sender, receiver } = await pair();
    const ignored = vi.fn();
    receiver.conn.on('data', ignored);
    sender.conn.send(chunk());
    sender.conn.send(chunk());
    receiver.bulk.receive(sender.bulk.sent[0]);
    receiver.bulk.receive(sender.bulk.sent[1]);
    await Promise.resolve();
    expect(ignored).toHaveBeenCalledTimes(2);
    sender.control.receive(receiver.control.sent.at(-1));
    await Promise.resolve();
    expect(sender.conn.bulkFlowControl.hasCapacity(CHUNK_SIZE)).toBe(true);
    expect(
      receiver.control.sent.some((frame) => JSON.parse(frame as string).type === MSG.PRELOAD_ACK),
    ).toBe(false);
  });

  it('does not expose private negotiation frames or trust them on the bulk channel', async () => {
    const sender = await endpoint();
    const receiver = await endpoint();
    const onData = vi.fn();
    sender.conn.on('data', onData);
    sender.bulk.receive(receiver.control.sent[0]);
    await Promise.resolve();
    sender.conn.send(chunk());
    sender.conn.send(chunk());
    await vi.advanceTimersByTimeAsync(1000);
    expect(sender.conn.bulkFlowControl.hasCapacity(CHUNK_SIZE)).toBe(true);
    expect(onData).not.toHaveBeenCalled();
    sender.control.receive(receiver.control.sent[0]);
    await Promise.resolve();
    expect(sender.conn.bulkFlowControl.hasCapacity(CHUNK_SIZE)).toBe(false);
    expect(onData).not.toHaveBeenCalled();
  });

  it('does not spend receipt credit on a failed native send or an operator upload', async () => {
    const sender = await endpoint();
    sender.bulk.failSend = true;
    expect(() => sender.conn.send(chunk())).toThrow('native-send-failed');
    sender.bulk.failSend = false;
    sender.conn.send({ type: MSG.OPERATOR_FILE_UPLOAD_CHUNK, chunk: new Uint8Array(CHUNK_SIZE) });
    sender.conn.send(chunk());
    sender.conn.send(chunk());
    expect(sender.conn.bulkFlowControl.hasCapacity(1)).toBe(false);
  });

  it('rejects malformed and replayed control receipts without bypassing the native send bound', async () => {
    const { sender, receiver } = await pair();
    sender.conn.send(chunk());
    sender.conn.send(chunk());
    receiver.bulk.receive(sender.bulk.sent[0]);
    await Promise.resolve();
    const valid = JSON.parse(receiver.control.sent.at(-1) as string) as Record<string, unknown>;
    const wake = vi.fn();
    sender.conn.bulkFlowControl.subscribe(wake);
    for (const changes of [
      { nonce: '0'.repeat(32) },
      { receivedBytes: 2 * CHUNK_SIZE + 1 },
      { receivedBytes: -1 },
      { version: 2 },
    ]) {
      sender.control.receive(JSON.stringify({ ...valid, ...changes }));
      await Promise.resolve();
      expect(sender.conn.bulkFlowControl.hasCapacity(1)).toBe(false);
    }
    expect(wake).not.toHaveBeenCalled();
    sender.control.receive(JSON.stringify(valid));
    await Promise.resolve();
    expect(wake).toHaveBeenCalledOnce();
    sender.control.receive(JSON.stringify(valid));
    await Promise.resolve();
    expect(wake).toHaveBeenCalledOnce();
    sender.conn.send(chunk());
    expect(() => sender.conn.send(chunk())).toThrow('BULK_FLOW_CAPACITY_EXCEEDED');
  });

  it('drops an old channel decode completion when the exact channel reference was replaced', async () => {
    const { sender, receiver } = await pair();
    sender.conn.send(chunk());
    const onData = vi.fn();
    receiver.conn.on('data', onData);
    const controlsBefore = receiver.control.sent.length;
    receiver.bulk.receive(sender.bulk.sent[0]);
    receiver.conn.dataChannel = new Channel('musixquare-data') as unknown as RTCDataChannel;
    await Promise.resolve();
    expect(receiver.control.sent).toHaveLength(controlsBefore);
    expect(onData).not.toHaveBeenCalled();
  });

  it('does not emit or acknowledge delayed decode completions after closure', async () => {
    const { sender, receiver } = await pair();
    const onData = vi.fn();
    receiver.conn.on('data', onData);
    sender.conn.send(chunk());
    receiver.bulk.receive(sender.bulk.sent[0]);
    const controlsBefore = receiver.control.sent.length;
    receiver.conn.close();
    await Promise.resolve();
    expect(receiver.conn.bulkFlowControl.hasCapacity(CHUNK_SIZE)).toBe(false);
    expect(receiver.control.sent).toHaveLength(controlsBefore);
    expect(onData).not.toHaveBeenCalled();
  });

  it('closes a failed initial hello without publishing a false application open', async () => {
    const conn = new CloudflareDataConnection('failed-hello');
    connections.push(conn);
    const pc = new PeerConnection();
    const bulk = new Channel('musixquare-data');
    const control = new Channel('musixquare-control');
    control.failSend = true;
    const onOpen = vi.fn();
    const onClose = vi.fn();
    conn.on('open', onOpen);
    conn.on('close', onClose);
    conn.attach(pc as unknown as RTCPeerConnection, bulk as unknown as RTCDataChannel);
    conn.attach(pc as unknown as RTCPeerConnection, control as unknown as RTCDataChannel);
    await Promise.resolve();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(conn.open).toBe(false);
    expect(conn.bulkFlowControl.hasCapacity(CHUNK_SIZE)).toBe(false);
    expect(pc.connectionState).toBe('closed');
  });

  it('closes after a failed receipt so recovery replaces the poisoned lifetime counters', async () => {
    const { sender, receiver } = await pair();
    const onClose = vi.fn();
    const onData = vi.fn();
    receiver.conn.on('close', onClose);
    receiver.conn.on('data', onData);
    sender.conn.send(chunk());
    sender.conn.send(chunk());
    receiver.control.failSend = true;
    receiver.bulk.receive(sender.bulk.sent[0]);
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onData).not.toHaveBeenCalled();
    expect(receiver.conn.open).toBe(false);
    expect(receiver.conn.bulkFlowControl.hasCapacity(CHUNK_SIZE)).toBe(false);
    const replacement = await endpoint();
    expect(replacement.conn.open).toBe(true);
    expect(replacement.conn.bulkFlowControl.hasCapacity(CHUNK_SIZE)).toBe(true);
  });
});
