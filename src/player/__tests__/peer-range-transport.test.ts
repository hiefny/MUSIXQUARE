import { describe, expect, it, vi } from 'vitest';
import { clearAllManagedTimers } from '../../core/timers.ts';
import { getFilePlaybackUniversalLifecycleSnapshotForTests as getFilePlaybackUniversalLifecycleSnapshot } from '../diagnostics/file-playback-universal-lifecycle-diagnostics.ts';

import {
  EncodedSourceClosedError,
  type EncodedAudioSource,
} from '../sources/encoded-audio-source.ts';
import type { PeerRangeReadRequest } from '../sources/peer-range-encoded-audio-source.ts';
import {
  PEER_RANGE_MAX_CHUNK_BYTES,
  PEER_RANGE_MAX_READ_BYTES,
  PeerRangeLimitError,
  PeerRangeProtocolError,
  createPeerRangeCancelFrame,
  createPeerRangeChunkFrames,
  createPeerRangeCloseHandleFrame,
  createPeerRangeReadFrame,
  parsePeerRangeBulkFrame,
  type PeerRangeBulkFrame,
  type PeerRangeControlFrame,
  type PeerRangeReadDescriptor,
} from '../sources/peer-range-protocol.ts';
import {
  FramedPeerRangeClientTransport,
  PeerRangeConnectionFatalError,
  PeerRangeHostResponder,
  bindPeerRangeTrustedConnection,
  type PeerRangeHostSource,
} from '../sources/peer-range-transport.ts';

const CONNECTION_ID = 'rtc:trusted-connection';
const SOURCE_ID = 'sha256:source-alpha';
const CONNECTION_TOKEN = Object.freeze({ kind: 'test-data-connection' });
const CONNECTION = bindPeerRangeTrustedConnection(CONNECTION_TOKEN, CONNECTION_ID);
const ignoreFatalConnection = () => undefined;
const allowSend = () => true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function bytes(length: number, seed = 3): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length }, (_value, index) => (index * 31 + seed) & 0xff);
}

function request(
  overrides: Partial<Omit<PeerRangeReadRequest, 'signal'>> = {},
  signal = new AbortController().signal,
): PeerRangeReadRequest {
  return {
    sourceIdentity: SOURCE_ID,
    handleId: 'handle:one',
    requestId: 'request:one',
    offset: 0,
    length: 1,
    signal,
    ...overrides,
  };
}

function descriptor(overrides: Partial<PeerRangeReadDescriptor> = {}): PeerRangeReadDescriptor {
  return {
    connectionId: CONNECTION_ID,
    sourceIdentity: SOURCE_ID,
    handleId: 'handle:one',
    requestId: 'request:one',
    offset: 0,
    totalLength: 1,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('FramedPeerRangeClientTransport', () => {
  it('performs an exact 64 KiB read over four bounded bulk frames', async () => {
    const expected = bytes(PEER_RANGE_MAX_READ_BYTES);
    const sentControl: PeerRangeControlFrame[] = [];
    const sentBulk: PeerRangeBulkFrame[] = [];
    let client!: FramedPeerRangeClientTransport;
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => new Blob([expected]) },
      sendBulk: (frame) => {
        sentBulk.push(frame);
        client.acceptBulk(CONNECTION_TOKEN, frame);
      },
    });
    client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sendControl: (frame) => {
        sentControl.push(frame);
        host.acceptControl(CONNECTION_TOKEN, frame);
      },
    });

    const result = await client.read(
      request({ length: PEER_RANGE_MAX_READ_BYTES, requestId: 'request:64k' }),
    );

    expect(result).toEqual(expected);
    expect(sentControl).toHaveLength(1);
    expect(sentControl[0]).toMatchObject({
      lane: 'control',
      type: 'read',
      connectionId: CONNECTION_ID,
      totalLength: PEER_RANGE_MAX_READ_BYTES,
    });
    expect(sentBulk).toHaveLength(4);
    expect(
      sentBulk.map((frame) => (frame.type === 'chunk' ? frame.payload.byteLength : -1)),
    ).toEqual([
      PEER_RANGE_MAX_CHUNK_BYTES,
      PEER_RANGE_MAX_CHUNK_BYTES,
      PEER_RANGE_MAX_CHUNK_BYTES,
      PEER_RANGE_MAX_CHUNK_BYTES,
    ]);
    expect(client.activeRequestCount).toBe(0);
    expect(client.retainedByteLength).toBe(0);
    await vi.waitFor(() => expect(host.activeRequestCount).toBe(0));
  });

  it('sends the exact cancellation on abort and makes a late response inert', async () => {
    const sourceRead = deferred<Uint8Array>();
    let sourceSignal: AbortSignal | undefined;
    const controls: PeerRangeControlFrame[] = [];
    let client!: FramedPeerRangeClientTransport;
    const source: EncodedAudioSource = {
      kind: 'peer-range',
      size: 10,
      identity: SOURCE_ID,
      metadata: { name: 'x.flac', mime: 'audio/flac' },
      readAt: async (_offset, _length, signal) => {
        sourceSignal = signal;
        return sourceRead.promise;
      },
      close: async () => undefined,
    };
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => source },
      sendBulk: (frame) => {
        client.acceptBulk(CONNECTION_TOKEN, frame);
      },
    });
    client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sendControl: (frame) => {
        controls.push(frame);
        host.acceptControl(CONNECTION_TOKEN, frame);
      },
    });
    const controller = new AbortController();
    const result = client.read(request({ length: 4 }, controller.signal));
    await flush();

    controller.abort(new Error('seek superseded'));
    sourceRead.resolve(Uint8Array.of(1, 2, 3, 4));

    await expect(result).rejects.toThrow('seek superseded');
    expect(controls.map((frame) => frame.type)).toEqual(['read', 'cancel']);
    expect(controls[1]).toEqual(createPeerRangeCancelFrame(controls[0] as PeerRangeReadDescriptor));
    expect(sourceSignal?.aborted).toBe(true);
    expect(client.activeRequestCount).toBe(0);
    expect(host.activeRequestCount).toBe(0);
    expect(
      client.acceptBulk(
        CONNECTION_TOKEN,
        createPeerRangeChunkFrames(
          controls[0] as PeerRangeReadDescriptor,
          Uint8Array.of(9, 9, 9, 9),
        )[0],
      ),
    ).toBe('ignored');
  });

  it('closes only the exact handle and leaves an overlapping handle alive', async () => {
    const controls: PeerRangeControlFrame[] = [];
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sendControl: (frame) => {
        controls.push(frame);
      },
    });
    const first = client.read(request({ handleId: 'handle:first', requestId: 'request:first' }));
    const second = client.read(request({ handleId: 'handle:second', requestId: 'request:second' }));

    client.closeHandle('handle:first', SOURCE_ID);
    await expect(first).rejects.toMatchObject({ name: 'PeerRangeRequestCancelledError' });
    expect(client.activeRequestCount).toBe(1);
    expect(controls.filter((frame) => frame.type === 'cancel')).toHaveLength(1);
    expect(controls.find((frame) => frame.type === 'cancel')).toMatchObject({
      type: 'cancel',
      handleId: 'handle:first',
      requestId: 'request:first',
    });
    expect(controls.at(-1)).toMatchObject({
      type: 'close-handle',
      handleId: 'handle:first',
      sourceIdentity: SOURCE_ID,
    });

    const secondRead = controls.find(
      (frame): frame is Extract<PeerRangeControlFrame, { type: 'read' }> =>
        frame.type === 'read' && frame.handleId === 'handle:second',
    );
    expect(secondRead).toBeDefined();
    expect(
      client.acceptBulk(
        CONNECTION_TOKEN,
        createPeerRangeChunkFrames(secondRead!, Uint8Array.of(7))[0],
      ),
    ).toBe('completed');
    await expect(second).resolves.toEqual(Uint8Array.of(7));
  });

  it('bounds concurrency and retained chunks, then ignores all late frames', async () => {
    const controls: PeerRangeControlFrame[] = [];
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sendControl: (frame) => {
        controls.push(frame);
      },
      maxActiveRequests: 1,
      maxRetainedBytes: PEER_RANGE_MAX_CHUNK_BYTES,
    });
    const first = client.read(
      request({ requestId: 'request:first', length: PEER_RANGE_MAX_CHUNK_BYTES + 1 }),
    );
    const second = client.read(request({ requestId: 'request:second' }));

    await expect(second).rejects.toBeInstanceOf(PeerRangeLimitError);
    const readFrame = controls.find((frame) => frame.type === 'read');
    expect(readFrame).toBeDefined();
    const frames = createPeerRangeChunkFrames(readFrame!, bytes(PEER_RANGE_MAX_CHUNK_BYTES + 1));
    expect(client.acceptBulk(CONNECTION_TOKEN, frames[0])).toBe('accepted');
    expect(client.retainedByteLength).toBe(PEER_RANGE_MAX_CHUNK_BYTES);
    expect(client.acceptBulk(CONNECTION_TOKEN, frames[1])).toBe('failed');
    await expect(first).rejects.toBeInstanceOf(PeerRangeLimitError);
    expect(client.retainedByteLength).toBe(0);
    expect(client.acceptBulk(CONNECTION_TOKEN, frames[0])).toBe('ignored');
  });

  it('quarantines and settles the client on a terminal control-send failure', async () => {
    const controls: PeerRangeControlFrame[] = [];
    const fatalConnection = vi.fn();
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sendControl: (frame) => {
        controls.push(frame);
        if (frame.type === 'read' && frame.requestId === 'request:broken') {
          return Promise.reject(new Error('control lane failed'));
        }
      },
    });
    const broken = client.read(request({ requestId: 'request:broken' }));
    await expect(broken).rejects.toBeInstanceOf(PeerRangeConnectionFatalError);
    expect(fatalConnection).toHaveBeenCalledOnce();
    expect(fatalConnection).toHaveBeenCalledWith(
      CONNECTION,
      expect.objectContaining({ name: 'PeerRangeConnectionFatalError' }),
    );

    await expect(client.read(request({ requestId: 'request:after-fatal' }))).rejects.toBeInstanceOf(
      PeerRangeConnectionFatalError,
    );
    expect(client.activeRequestCount).toBe(0);
    expect(() => client.close()).not.toThrow();
  });

  it('rejects bulk frames claiming another authenticated connection', () => {
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sendControl: () => undefined,
    });
    const spoof = createPeerRangeChunkFrames(
      descriptor({ connectionId: 'rtc:spoof' }),
      Uint8Array.of(1),
    )[0];

    expect(() => client.acceptBulk(CONNECTION_TOKEN, spoof)).toThrow(PeerRangeProtocolError);
  });

  it('retains never-settling physical sends across abort and makes churn fatal at the bound', async () => {
    const never = new Promise<void>(() => undefined);
    const fatalConnection = vi.fn();
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sendControl: () => never,
      maxDeliveryTasks: 2,
      deliveryTimeoutMs: 60_000,
    });
    const controller = new AbortController();
    const first = client.read(request({ requestId: 'request:hung-send' }, controller.signal));
    expect(client.physicalDeliveryTaskCount).toBe(1);

    controller.abort(new Error('caller left'));
    await expect(first).rejects.toThrow('caller left');
    expect(client.activeRequestCount).toBe(0);
    expect(client.physicalDeliveryTaskCount).toBe(2);

    const churn = client.read(request({ requestId: 'request:churn' }));
    await expect(churn).rejects.toBeInstanceOf(PeerRangeConnectionFatalError);
    expect(fatalConnection).toHaveBeenCalledOnce();
    expect(client.physicalDeliveryTaskCount).toBe(2);
  });

  it('times out a terminally hung control callback and settles the waiting read', async () => {
    const fatalConnection = vi.fn();
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sendControl: () => new Promise<void>(() => undefined),
      deliveryTimeoutMs: 10,
    });

    const result = client.read(request({ requestId: 'request:timeout' }));
    const rejected = expect(result).rejects.toBeInstanceOf(PeerRangeConnectionFatalError);
    await vi.waitFor(() => expect(fatalConnection).toHaveBeenCalledOnce());
    await rejected;
    expect(client.activeRequestCount).toBe(0);
    // The raw callback is still physically pending and remains accounted for.
    expect(client.physicalDeliveryTaskCount).toBe(1);
  });

  it('keeps its owned delivery deadline when unrelated managed timers are cleared', async () => {
    const fatalConnection = vi.fn();
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sendControl: () => new Promise<void>(() => undefined),
      deliveryTimeoutMs: 10,
    });

    const result = client.read(request({ requestId: 'request:owned-timeout' }));
    clearAllManagedTimers();

    await expect(result).rejects.toBeInstanceOf(PeerRangeConnectionFatalError);
    expect(fatalConnection).toHaveBeenCalledOnce();
    expect(client.activeRequestCount).toBe(0);
  });

  it('quarantines without stranding work when delivery timer cancellation throws', async () => {
    const delivery = deferred<void>();
    const fatalConnection = vi.fn();
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sendControl: () => delivery.promise,
      deliveryTimeoutMs: 60_000,
    });
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    const result = client.read(request({ requestId: 'request:timer-clear-failure' }));
    const clearTimeout = vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => {
      throw new Error('synthetic peer timer cancellation failure');
    });
    try {
      delivery.resolve();
      await expect(result).rejects.toBeInstanceOf(PeerRangeConnectionFatalError);
    } finally {
      clearTimeout.mockRestore();
    }

    const retired = getFilePlaybackUniversalLifecycleSnapshot();
    expect(fatalConnection).toHaveBeenCalledOnce();
    expect(client.activeRequestCount).toBe(0);
    expect(client.physicalDeliveryTaskCount).toBe(0);
    expect(retired.kinds.pendingReads.live).toBe(baseline.kinds.pendingReads.live);
    expect(retired.kinds.timers.live).toBe(baseline.kinds.timers.live);
    expect(retired.kinds.timers.unconfirmed).toBe(baseline.kinds.timers.unconfirmed + 1);
    await client.close();
  });

  it('settles close but marks request ownership unconfirmed when listener detach throws', async () => {
    const controller = new AbortController();
    let removalCount = 0;
    const signal = {
      get aborted() {
        return controller.signal.aborted;
      },
      get reason() {
        return controller.signal.reason;
      },
      addEventListener: controller.signal.addEventListener.bind(controller.signal),
      removeEventListener: (...args: Parameters<AbortSignal['removeEventListener']>) => {
        removalCount += 1;
        if (removalCount === 1) throw new Error('synthetic peer abort detach failure');
        controller.signal.removeEventListener(...args);
      },
    } as unknown as AbortSignal;
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sendControl: () => undefined,
    });
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    const result = client.read(request({ requestId: 'request:detach-failure' }, signal));
    const reason = new Error('close after detach failure');

    await expect(client.close(reason)).resolves.toBeUndefined();
    await expect(result).rejects.toBe(reason);

    const retired = getFilePlaybackUniversalLifecycleSnapshot();
    expect(removalCount).toBeGreaterThanOrEqual(2);
    expect(client.activeRequestCount).toBe(0);
    expect(retired.kinds.pendingReads.live).toBe(baseline.kinds.pendingReads.live);
    expect(retired.kinds.pendingReads.unconfirmed).toBe(
      baseline.kinds.pendingReads.unconfirmed + 1,
    );
  });

  it('requires the exact locally bound connection token for inbound bulk routing', () => {
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sendControl: () => undefined,
    });
    const frame = createPeerRangeChunkFrames(descriptor(), Uint8Array.of(1))[0];

    expect(() => client.acceptBulk(Object.freeze({}), frame)).toThrow(/different connection/);
    expect(
      () =>
        new FramedPeerRangeClientTransport({
          connection: { token: CONNECTION_TOKEN, connectionId: CONNECTION_ID },
          onFatalConnection: ignoreFatalConnection,
          canSend: allowSend,
          sendControl: () => undefined,
        }),
    ).toThrow(/bound locally/);
  });

  it('waits through transient exact-channel backpressure without quarantining the connection', async () => {
    let writable = false;
    let client!: FramedPeerRangeClientTransport;
    const sendControl = vi.fn((frame: PeerRangeControlFrame) => {
      if (frame.type !== 'read') return;
      const response = createPeerRangeChunkFrames(frame, Uint8Array.of(17));
      for (const chunk of response) client.acceptBulk(CONNECTION_TOKEN, chunk);
    });
    const canSend = vi.fn(() => writable);
    const fatalConnection = vi.fn();
    client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend,
      sendControl,
    });

    const result = client.read(request({ requestId: 'request:backpressured' }));
    expect(sendControl).not.toHaveBeenCalled();
    writable = true;

    await expect(result).resolves.toEqual(Uint8Array.of(17));
    expect(canSend).toHaveBeenCalledWith(
      CONNECTION,
      expect.objectContaining({ type: 'read', requestId: 'request:backpressured' }),
    );
    expect(canSend.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sendControl).toHaveBeenCalledOnce();
    expect(fatalConnection).not.toHaveBeenCalled();
  });

  it('quarantines only after exact-channel backpressure remains stalled to the deadline', async () => {
    const sendControl = vi.fn((_frame: PeerRangeControlFrame) => undefined);
    const fatalConnection = vi.fn();
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: () => false,
      sendControl,
      deliveryTimeoutMs: 10,
    });

    const result = client.read(request({ requestId: 'request:backpressure-timeout' }));
    await expect(result).rejects.toBeInstanceOf(PeerRangeConnectionFatalError);
    expect(sendControl).not.toHaveBeenCalled();
    expect(fatalConnection).toHaveBeenCalledOnce();
  });

  it('uses a 30 second delivery deadline by default while preserving explicit overrides', async () => {
    const sendControl = vi.fn(() => undefined);
    const fatalConnection = vi.fn();
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: () => false,
      sendControl,
    });

    vi.useFakeTimers();
    try {
      const result = client.read(request({ requestId: 'request:default-backpressure-timeout' }));
      const rejected = expect(result).rejects.toBeInstanceOf(PeerRangeConnectionFatalError);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fatalConnection).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(24_999);
      expect(fatalConnection).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(sendControl).not.toHaveBeenCalled();
      expect(fatalConnection).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });

  it('recovers a hidden-like long backpressure stall before the default deadline', async () => {
    let writable = false;
    let client!: FramedPeerRangeClientTransport;
    const sendControl = vi.fn((frame: PeerRangeControlFrame) => {
      if (frame.type !== 'read') return;
      for (const chunk of createPeerRangeChunkFrames(frame, Uint8Array.of(29))) {
        client.acceptBulk(CONNECTION_TOKEN, chunk);
      }
    });
    const fatalConnection = vi.fn();
    client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: () => writable,
      sendControl,
    });

    vi.useFakeTimers();
    try {
      const result = client.read(request({ requestId: 'request:hidden-like-backpressure' }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sendControl).not.toHaveBeenCalled();
      expect(fatalConnection).not.toHaveBeenCalled();

      writable = true;
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toEqual(Uint8Array.of(29));
      expect(sendControl).toHaveBeenCalledOnce();
      expect(fatalConnection).not.toHaveBeenCalled();
    } finally {
      await client.close();
      clearAllManagedTimers();
      vi.useRealTimers();
    }
  });

  it('bounds synchronous close-handle churn even when the sender returns void', () => {
    const sendControl = vi.fn((_frame: PeerRangeControlFrame) => undefined);
    const fatalConnection = vi.fn();
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sendControl,
      terminalEgressCredits: 2,
      terminalEgressRefillMs: 60_000,
    });

    for (let index = 0; index < 1_000; index += 1) {
      client.closeHandle(`handle:void-churn-${index}`, SOURCE_ID);
    }

    expect(sendControl).toHaveBeenCalledTimes(2);
    expect(fatalConnection).toHaveBeenCalledOnce();
    expect(sendControl.mock.calls.every(([frame]) => frame.type === 'close-handle')).toBe(true);
  });

  it('does not send when canSend synchronously closes the exact client then returns true', async () => {
    const sendControl = vi.fn(() => undefined);
    let client!: FramedPeerRangeClientTransport;
    client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: () => {
        client.close(new Error('closed during backpressure check'));
        return true;
      },
      sendControl,
    });

    const result = client.read(request({ requestId: 'request:reentrant-close' }));
    await expect(result).rejects.toThrow('closed during backpressure check');
    expect(sendControl).not.toHaveBeenCalled();
    expect(client.activeRequestCount).toBe(0);
    expect(client.physicalDeliveryTaskCount).toBe(0);
  });

  it('retires a send reserved before synchronous client-close re-entry only after it settles', async () => {
    const delivery = deferred<void>();
    const reason = new Error('closed inside control sender');
    let closing: Promise<void> | null = null;
    let client!: FramedPeerRangeClientTransport;
    client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sendControl: () => {
        closing = client.close(reason);
        return delivery.promise;
      },
      deliveryTimeoutMs: 60_000,
    });

    const result = client.read(request({ requestId: 'request:sender-close' }));
    await expect(result).rejects.toBe(reason);
    expect(closing).not.toBeNull();
    expect(client.physicalDeliveryTaskCount).toBe(1);

    let retired = false;
    void closing!.then(() => {
      retired = true;
    });
    await flush();
    expect(retired).toBe(false);

    delivery.resolve();
    await expect(closing!).resolves.toBeUndefined();
    expect(retired).toBe(true);
    expect(client.physicalDeliveryTaskCount).toBe(0);
    expect(client.close()).toBe(closing);
  });

  it('reserves before a nested synchronous delivery and retains only the outer hung send', async () => {
    const never = new Promise<void>(() => undefined);
    const fatalConnection = vi.fn();
    let client!: FramedPeerRangeClientTransport;
    const sendControl = vi.fn((frame: PeerRangeControlFrame) => {
      if (frame.type === 'read') {
        client.closeHandle(frame.handleId, frame.sourceIdentity);
      }
      return never;
    });
    client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sendControl,
      maxDeliveryTasks: 1,
      deliveryTimeoutMs: 60_000,
    });

    const result = client.read(request({ requestId: 'request:nested-send' }));
    await expect(result).rejects.toBeDefined();
    expect(sendControl).toHaveBeenCalledOnce();
    expect(sendControl.mock.calls[0]?.[0]).toMatchObject({ type: 'read' });
    expect(client.physicalDeliveryTaskCount).toBe(1);
    expect(client.activeRequestCount).toBe(0);
    expect(fatalConnection).toHaveBeenCalledOnce();
  });

  it('reconciles a timer handle published after synchronous close re-entry', async () => {
    const reason = new Error('closed while peer timer was arming');
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    let closing: Promise<void> | null = null;
    let client!: FramedPeerRangeClientTransport;
    client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sendControl: () => Promise.resolve(),
      deliveryTimeoutMs: 60_000,
    });
    const nativeSetTimeout = globalThis.setTimeout;
    const reentrantSetTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      closing = client.close(reason);
      return nativeSetTimeout(callback, delay, ...args);
    }) as unknown as typeof globalThis.setTimeout;
    const setTimeout = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementationOnce(reentrantSetTimeout);
    let result!: Promise<Uint8Array>;
    try {
      result = client.read(request({ requestId: 'request:timer-arm-reentry' }));
    } finally {
      setTimeout.mockRestore();
    }

    await expect(result).rejects.toBe(reason);
    expect(closing).not.toBeNull();
    await expect(closing!).resolves.toBeUndefined();
    const retired = getFilePlaybackUniversalLifecycleSnapshot();
    expect(retired.kinds.timers.live).toBe(baseline.kinds.timers.live);
    expect(retired.kinds.timers.retiring).toBe(baseline.kinds.timers.retiring);
    expect(client.physicalDeliveryTaskCount).toBe(0);
  });

  it('retires a timer whose callback fires synchronously before handle publication', async () => {
    const fatalConnection = vi.fn();
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();
    const client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sendControl: () => Promise.resolve(),
      deliveryTimeoutMs: 60_000,
    });
    const syntheticTimer = 41 as unknown as ReturnType<typeof globalThis.setTimeout>;
    const synchronousSetTimeout = ((callback: TimerHandler) => {
      if (typeof callback === 'function') callback();
      return syntheticTimer;
    }) as unknown as typeof globalThis.setTimeout;
    const setTimeout = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementationOnce(synchronousSetTimeout);
    let result!: Promise<Uint8Array>;
    try {
      result = client.read(request({ requestId: 'request:sync-timer-callback' }));
    } finally {
      setTimeout.mockRestore();
    }

    await expect(result).rejects.toBeInstanceOf(PeerRangeConnectionFatalError);
    expect(fatalConnection).toHaveBeenCalledOnce();
    await expect(client.close()).resolves.toBeUndefined();
    const retired = getFilePlaybackUniversalLifecycleSnapshot();
    expect(retired.kinds.timers.live).toBe(baseline.kinds.timers.live);
    expect(retired.kinds.timers.retiring).toBe(baseline.kinds.timers.retiring);
  });

  it('removes an abort listener committed after addEventListener reenters close', async () => {
    const reason = new Error('closed during abort listener installation');
    const listeners = new Set<EventListenerOrEventListenerObject>();
    let addCount = 0;
    let closing: Promise<void> | null = null;
    let client!: FramedPeerRangeClientTransport;
    const signal = {
      aborted: false,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        addCount += 1;
        if (addCount === 2) closing = client.close(reason);
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.delete(listener);
      },
    } as unknown as AbortSignal;
    client = new FramedPeerRangeClientTransport({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sendControl: () => undefined,
    });
    const baseline = getFilePlaybackUniversalLifecycleSnapshot();

    const result = client.read(request({ requestId: 'request:listener-reentry' }, signal));

    await expect(result).rejects.toBe(reason);
    expect(addCount).toBe(2);
    expect(listeners.size).toBe(0);
    expect(closing).not.toBeNull();
    await expect(closing!).resolves.toBeUndefined();
    const retired = getFilePlaybackUniversalLifecycleSnapshot();
    expect(retired.kinds.pendingReads.live).toBe(baseline.kinds.pendingReads.live);
    expect(retired.kinds.pendingReads.retiring).toBe(baseline.kinds.pendingReads.retiring);
  });
});

describe('PeerRangeHostResponder', () => {
  it('forwards the exact claimed handle to an optional handle-aware source resolver', async () => {
    const resolve = vi.fn(() => new Blob([Uint8Array.of(9)]));
    const resolveHandle = vi.fn(() => new Blob([Uint8Array.of(4)]));
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve, resolveHandle },
      sendBulk: vi.fn(),
    });
    const read = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:exact-route', requestId: 'request:exact-route' }),
    );

    expect(host.acceptControl(CONNECTION_TOKEN, read)).toBe('accepted');
    await vi.waitFor(() => expect(host.activeRequestCount).toBe(0));

    expect(resolveHandle).toHaveBeenCalledOnce();
    expect(resolveHandle).toHaveBeenCalledWith(
      'handle:exact-route',
      SOURCE_ID,
      expect.any(AbortSignal),
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it('serves an exact Blob slice without retaining or reading the whole body', async () => {
    const whole = bytes(200_000);
    const frames: PeerRangeBulkFrame[] = [];
    const blob = new Blob([whole]);
    const slice = vi.spyOn(blob, 'slice');
    const provider = vi.fn((): PeerRangeHostSource => blob);
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: provider },
      sendBulk: (frame) => {
        frames.push(frame);
      },
    });
    const read = createPeerRangeReadFrame(
      descriptor({ offset: 70_000, totalLength: PEER_RANGE_MAX_READ_BYTES }),
    );

    expect(host.acceptControl(CONNECTION_TOKEN, read)).toBe('accepted');
    await vi.waitFor(() => expect(host.activeRequestCount).toBe(0));

    expect(provider).toHaveBeenCalledWith(SOURCE_ID, expect.any(AbortSignal));
    expect(slice).toHaveBeenCalledOnce();
    expect(slice).toHaveBeenCalledWith(70_000, 70_000 + PEER_RANGE_MAX_READ_BYTES);
    expect(frames).toHaveLength(4);
    const assembled = new Uint8Array(PEER_RANGE_MAX_READ_BYTES);
    for (const value of frames) {
      const frame = parsePeerRangeBulkFrame(value);
      expect(frame.type).toBe('chunk');
      if (frame.type === 'chunk') {
        expect(frame.payload.byteLength).toBeLessThanOrEqual(PEER_RANGE_MAX_CHUNK_BYTES);
        assembled.set(new Uint8Array(frame.payload), frame.chunkIndex * PEER_RANGE_MAX_CHUNK_BYTES);
      }
    }
    expect(assembled).toEqual(whole.slice(70_000, 70_000 + PEER_RANGE_MAX_READ_BYTES));
  });

  it('pauses bulk delivery at backpressure and resumes the same request without disconnecting', async () => {
    let writable = false;
    const frames: PeerRangeBulkFrame[] = [];
    const fatalConnection = vi.fn();
    const canSend = vi.fn(() => writable);
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend,
      sources: { resolve: () => new Blob([bytes(PEER_RANGE_MAX_READ_BYTES)]) },
      sendBulk: (frame) => {
        frames.push(frame);
      },
    });
    const read = createPeerRangeReadFrame(
      descriptor({
        requestId: 'request:transient-bulk-backpressure',
        totalLength: PEER_RANGE_MAX_READ_BYTES,
      }),
    );

    expect(host.acceptControl(CONNECTION_TOKEN, read)).toBe('accepted');
    await vi.waitFor(() => expect(canSend).toHaveBeenCalled());
    expect(frames).toHaveLength(0);
    expect(host.activeRequestCount).toBe(1);

    writable = true;
    await vi.waitFor(() => expect(host.activeRequestCount).toBe(0));

    expect(frames).toHaveLength(4);
    expect(
      frames.every(
        (frame) =>
          frame.type === 'chunk' && frame.requestId === 'request:transient-bulk-backpressure',
      ),
    ).toBe(true);
    expect(canSend.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fatalConnection).not.toHaveBeenCalled();
  });

  it('reports bounded PII-free physical read counters and returns pending to zero', async () => {
    const before = PeerRangeHostResponder.physicalReadDiagnostics();
    const fourBytes = deferred<Uint8Array>();
    const sevenBytes = deferred<Uint8Array>();
    const source: EncodedAudioSource = {
      kind: 'peer-range',
      size: 32,
      identity: SOURCE_ID,
      metadata: { name: 'private-name.flac', mime: 'audio/flac' },
      readAt: async (_offset, length) => (length === 4 ? fourBytes.promise : sevenBytes.promise),
      close: async () => undefined,
    };
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => source },
      sendBulk: vi.fn(),
    });

    expect(
      host.acceptControl(
        CONNECTION_TOKEN,
        createPeerRangeReadFrame(
          descriptor({ requestId: 'request:diagnostic-four', totalLength: 4 }),
        ),
      ),
    ).toBe('accepted');
    expect(
      host.acceptControl(
        CONNECTION_TOKEN,
        createPeerRangeReadFrame(
          descriptor({ requestId: 'request:diagnostic-seven', offset: 8, totalLength: 7 }),
        ),
      ),
    ).toBe('accepted');

    await vi.waitFor(() =>
      expect(PeerRangeHostResponder.physicalReadDiagnostics().pendingReadCount).toBe(
        before.pendingReadCount + 2,
      ),
    );
    const active = PeerRangeHostResponder.physicalReadDiagnostics();
    expect(Object.isFrozen(active)).toBe(true);
    expect(Object.keys(active).sort()).toEqual(
      [
        'maxConcurrentReadCount',
        'maxRequestByteLength',
        'pendingReadCount',
        'readByteLimit',
        'readCount',
        'requestedByteCount',
        'schemaVersion',
        'settledReadCount',
      ].sort(),
    );
    expect(Object.values(active).every((value) => typeof value === 'number')).toBe(true);
    expect(active).toMatchObject({
      schemaVersion: 1,
      readByteLimit: PEER_RANGE_MAX_READ_BYTES,
      readCount: before.readCount + 2,
      requestedByteCount: before.requestedByteCount + 11,
      pendingReadCount: before.pendingReadCount + 2,
      maxRequestByteLength: Math.max(before.maxRequestByteLength, 7),
      maxConcurrentReadCount: Math.max(before.maxConcurrentReadCount, before.pendingReadCount + 2),
    });

    fourBytes.resolve(bytes(4));
    sevenBytes.resolve(bytes(7));
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    const settled = PeerRangeHostResponder.physicalReadDiagnostics();
    expect(settled).toMatchObject({
      readCount: before.readCount + 2,
      settledReadCount: before.settledReadCount + 2,
      requestedByteCount: before.requestedByteCount + 11,
      pendingReadCount: before.pendingReadCount,
    });
  });

  it('returns bounded errors for missing, stale-identity, short, and out-of-range sources', async () => {
    const shortSource: EncodedAudioSource = {
      kind: 'peer-range',
      size: 10,
      identity: SOURCE_ID,
      metadata: { name: 'x', mime: 'audio/flac' },
      readAt: async () => Uint8Array.of(1),
      close: async () => undefined,
    };
    const staleSource: EncodedAudioSource = {
      ...shortSource,
      identity: 'sha256:stale-source',
    };

    const cases: Array<{
      id: string;
      source: PeerRangeHostSource | null;
      length: number;
      code: string;
    }> = [
      { id: 'missing', source: null, length: 1, code: 'not-found' },
      { id: 'stale', source: staleSource, length: 1, code: 'integrity' },
      { id: 'short', source: shortSource, length: 2, code: 'integrity' },
      { id: 'range', source: new Blob([Uint8Array.of(1)]), length: 2, code: 'range' },
    ];

    for (const testCase of cases) {
      const output: PeerRangeBulkFrame[] = [];
      const responder = new PeerRangeHostResponder({
        connection: CONNECTION,
        onFatalConnection: ignoreFatalConnection,
        canSend: allowSend,
        sources: { resolve: () => testCase.source },
        sendBulk: (frame) => {
          output.push(frame);
        },
      });
      expect(
        responder.acceptControl(
          CONNECTION_TOKEN,
          createPeerRangeReadFrame(
            descriptor({ requestId: `request:${testCase.id}`, totalLength: testCase.length }),
          ),
        ),
      ).toBe('accepted');
      await vi.waitFor(() => expect(responder.activeRequestCount).toBe(0));
      expect(output).toHaveLength(1);
      expect(output[0]).toMatchObject({ type: 'error', code: testCase.code });
    }
  });

  it('deduplicates active reads and tombstones replay and changed-range ABA attempts', async () => {
    const pendingSource = deferred<PeerRangeHostSource>();
    const frames: PeerRangeBulkFrame[] = [];
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => pendingSource.promise },
      sendBulk: (frame) => {
        frames.push(frame);
      },
    });
    const first = createPeerRangeReadFrame(descriptor());
    const changed = createPeerRangeReadFrame(descriptor({ offset: 1 }));

    expect(host.acceptControl(CONNECTION_TOKEN, first)).toBe('accepted');
    expect(host.acceptControl(CONNECTION_TOKEN, first)).toBe('duplicate');
    expect(host.acceptControl(CONNECTION_TOKEN, changed)).toBe('rejected');
    expect(host.activeRequestCount).toBe(1);
    pendingSource.resolve(new Blob([Uint8Array.of(4, 5)]));
    await vi.waitFor(() => expect(host.activeRequestCount).toBe(0));

    expect(host.acceptControl(CONNECTION_TOKEN, first)).toBe('replayed');
    expect(host.acceptControl(CONNECTION_TOKEN, changed)).toBe('rejected');
    expect(frames.filter((frame) => frame.type === 'chunk')).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === 'error')).toHaveLength(3);
    expect(frames.at(-2)).toMatchObject({
      type: 'error',
      code: 'unavailable',
      message: 'Request was already settled',
    });
  });

  it('requires an exact cancel so a stale range cannot abort the active request', async () => {
    const sourceRead = deferred<Uint8Array>();
    let sourceSignal: AbortSignal | undefined;
    const frames: PeerRangeBulkFrame[] = [];
    const source: EncodedAudioSource = {
      kind: 'peer-range',
      size: 10,
      identity: SOURCE_ID,
      metadata: { name: 'x', mime: 'audio/flac' },
      readAt: async (_offset, _length, signal) => {
        sourceSignal = signal;
        return sourceRead.promise;
      },
      close: async () => undefined,
    };
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => source },
      sendBulk: (frame) => {
        frames.push(frame);
      },
    });
    const read = createPeerRangeReadFrame(descriptor({ totalLength: 2 }));

    expect(host.acceptControl(CONNECTION_TOKEN, read)).toBe('accepted');
    await flush();
    expect(
      host.acceptControl(CONNECTION_TOKEN, createPeerRangeCancelFrame({ ...read, offset: 1 })),
    ).toBe('ignored');
    expect(sourceSignal?.aborted).toBe(false);
    expect(host.acceptControl(CONNECTION_TOKEN, createPeerRangeCancelFrame(read))).toBe(
      'cancelled',
    );
    expect(sourceSignal?.aborted).toBe(true);
    sourceRead.resolve(Uint8Array.of(1, 2));
    await flush();
    expect(frames).toHaveLength(0);
  });

  it('keeps an evicted request ID ABA-safe on the handle-pinned source lease', async () => {
    const frames: PeerRangeBulkFrame[] = [];
    let resolutionCount = 0;
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: {
        resolve: () => {
          resolutionCount += 1;
          return new Blob([Uint8Array.of(3, 7)]);
        },
      },
      sendBulk: (frame) => {
        frames.push(frame);
      },
      maxSettledRequests: 1,
    });
    const old = createPeerRangeReadFrame(descriptor({ requestId: 'request:reused' }));
    const evictor = createPeerRangeReadFrame(descriptor({ requestId: 'request:evictor' }));

    expect(host.acceptControl(CONNECTION_TOKEN, old)).toBe('accepted');
    await vi.waitFor(() => expect(host.activeRequestCount).toBe(0));
    expect(host.acceptControl(CONNECTION_TOKEN, evictor)).toBe('accepted');
    await vi.waitFor(() => expect(host.activeRequestCount).toBe(0));

    const successor = createPeerRangeReadFrame({ ...old, offset: 1 });
    expect(host.acceptControl(CONNECTION_TOKEN, successor)).toBe('accepted');
    await flush();
    expect(host.acceptControl(CONNECTION_TOKEN, createPeerRangeCancelFrame(old))).toBe('ignored');
    expect(host.activeRequestCount).toBe(1);

    await vi.waitFor(() => expect(host.activeRequestCount).toBe(0));
    const successorFrame = frames.find(
      (frame) => frame.requestId === 'request:reused' && frame.offset === 1,
    );
    expect(successorFrame).toMatchObject({ type: 'chunk' });
    if (successorFrame?.type !== 'chunk') throw new Error('expected successor bytes');
    expect(new Uint8Array(successorFrame.payload)).toEqual(Uint8Array.of(7));
    expect(resolutionCount).toBe(1);
  });

  it('keeps unrelated requests moving when one bulk sender is backpressured forever', async () => {
    const never = new Promise<void>(() => undefined);
    const frames: PeerRangeBulkFrame[] = [];
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => new Blob([bytes(10)]) },
      sendBulk: (frame) => {
        if (frame.requestId === 'request:blocked') return never;
        frames.push(frame);
      },
      maxActiveRequests: 2,
    });
    const blocked = createPeerRangeReadFrame(descriptor({ requestId: 'request:blocked' }));
    const healthy = createPeerRangeReadFrame(
      descriptor({ requestId: 'request:healthy', offset: 1 }),
    );

    expect(host.acceptControl(CONNECTION_TOKEN, blocked)).toBe('accepted');
    expect(host.acceptControl(CONNECTION_TOKEN, healthy)).toBe('accepted');
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.requestId === 'request:healthy')).toBe(true),
    );
    expect(host.activeRequestCount).toBe(1);
    expect(frames).toHaveLength(1);

    expect(() => host.close()).not.toThrow();
    expect(host.activeRequestCount).toBe(0);
  });

  it('bounds active work and isolates a throwing bulk callback from later requests', async () => {
    const firstSource = deferred<PeerRangeHostSource>();
    const frames: PeerRangeBulkFrame[] = [];
    let firstSignal: AbortSignal | undefined;
    const fatalConnection = vi.fn();
    const responder = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sources: {
        resolve: (_identity, signal) => {
          if (!firstSignal) {
            firstSignal = signal;
            return firstSource.promise;
          }
          return new Blob([Uint8Array.of(8)]);
        },
      },
      sendBulk: (frame) => {
        if (frame.requestId === 'request:throws') throw new Error('bulk lane closed');
        frames.push(frame);
      },
      maxActiveRequests: 1,
    });
    const held = createPeerRangeReadFrame(descriptor({ requestId: 'request:held' }));
    const overLimit = createPeerRangeReadFrame(descriptor({ requestId: 'request:limit' }));

    expect(responder.acceptControl(CONNECTION_TOKEN, held)).toBe('accepted');
    await flush();
    expect(responder.acceptControl(CONNECTION_TOKEN, overLimit)).toBe('rejected');
    expect(frames.at(-1)).toMatchObject({ type: 'error', code: 'unavailable' });
    expect(firstSignal?.aborted).toBe(false);
    responder.acceptControl(CONNECTION_TOKEN, createPeerRangeCancelFrame(held));
    expect(responder.activeRequestCount).toBe(0);
    expect(responder.physicalReadTaskCount).toBe(1);
    firstSource.resolve(new Blob([Uint8Array.of(1)]));
    await vi.waitFor(() => expect(responder.physicalReadTaskCount).toBe(0));

    const throws = createPeerRangeReadFrame(descriptor({ requestId: 'request:throws' }));
    expect(responder.acceptControl(CONNECTION_TOKEN, throws)).toBe('accepted');
    await vi.waitFor(() => expect(fatalConnection).toHaveBeenCalledOnce());
    const healthy = createPeerRangeReadFrame(descriptor({ requestId: 'request:after-throw' }));
    expect(responder.acceptControl(CONNECTION_TOKEN, healthy)).toBe('ignored');
    expect(frames.some((frame) => frame.requestId === 'request:after-throw')).toBe(false);
  });

  it('binds every frame to the trusted connection and closes without awaiting a provider', async () => {
    const source = deferred<PeerRangeHostSource>();
    const frames: PeerRangeBulkFrame[] = [];
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => source.promise },
      sendBulk: (frame) => {
        frames.push(frame);
      },
    });
    const spoof = createPeerRangeReadFrame(descriptor({ connectionId: 'rtc:spoof' }));
    expect(() => host.acceptControl(CONNECTION_TOKEN, spoof)).toThrow(PeerRangeProtocolError);

    const read = createPeerRangeReadFrame(descriptor());
    expect(host.acceptControl(CONNECTION_TOKEN, read)).toBe('accepted');
    expect(() => host.close(new EncodedSourceClosedError())).not.toThrow();
    expect(host.activeRequestCount).toBe(0);
    source.resolve(new Blob([Uint8Array.of(1)]));
    await flush();
    expect(frames).toHaveLength(0);
    expect(host.acceptControl(CONNECTION_TOKEN, read)).toBe('ignored');
  });

  it('retains a cancelled resolver task physically and bounds overload error egress', async () => {
    const fatalConnection = vi.fn();
    const errorSend = new Promise<void>(() => undefined);
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sources: { resolve: () => new Promise<PeerRangeHostSource>(() => undefined) },
      sendBulk: () => errorSend,
      maxActiveRequests: 1,
      deliveryTimeoutMs: 10,
    });
    const first = createPeerRangeReadFrame(descriptor({ requestId: 'request:physical-hang' }));
    expect(host.acceptControl(CONNECTION_TOKEN, first)).toBe('accepted');
    await flush();
    expect(host.acceptControl(CONNECTION_TOKEN, createPeerRangeCancelFrame(first))).toBe(
      'cancelled',
    );
    expect(host.activeRequestCount).toBe(0);
    expect(host.physicalReadTaskCount).toBe(1);

    const overload = createPeerRangeReadFrame(descriptor({ requestId: 'request:overload' }));
    expect(host.acceptControl(CONNECTION_TOKEN, overload)).toBe('rejected');
    expect(host.physicalDeliveryTaskCount).toBe(1);
    await vi.waitFor(() => expect(fatalConnection).toHaveBeenCalledOnce());
    expect(fatalConnection).toHaveBeenCalledWith(
      CONNECTION,
      expect.objectContaining({ name: 'PeerRangeDeliveryTimeoutError' }),
    );
    expect(host.physicalReadTaskCount).toBe(1);
    expect(host.physicalDeliveryTaskCount).toBe(1);
  });

  it('retires a send reserved before synchronous host-close re-entry only after it settles', async () => {
    const delivery = deferred<void>();
    const reason = new Error('closed inside bulk sender');
    let closing: Promise<void> | null = null;
    let host!: PeerRangeHostResponder;
    host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => new Blob([Uint8Array.of(4)]) },
      sendBulk: () => {
        closing = host.close(reason);
        return delivery.promise;
      },
      deliveryTimeoutMs: 60_000,
    });
    const read = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:sender-close', requestId: 'request:sender-close' }),
    );

    expect(host.acceptControl(CONNECTION_TOKEN, read)).toBe('accepted');
    await vi.waitFor(() => expect(closing).not.toBeNull());
    expect(host.physicalDeliveryTaskCount).toBe(1);

    let retired = false;
    void closing!.then(() => {
      retired = true;
    });
    await flush();
    expect(retired).toBe(false);

    delivery.resolve();
    await expect(closing!).resolves.toBeUndefined();
    expect(retired).toBe(true);
    expect(host.physicalDeliveryTaskCount).toBe(0);
    expect(host.physicalReadTaskCount).toBe(0);
    expect(host.close()).toBe(closing);
  });

  it('fails the connection before hostile error egress can detach beyond its task budget', async () => {
    const never = new Promise<void>(() => undefined);
    const fatalConnection = vi.fn();
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sources: { resolve: () => new Promise<PeerRangeHostSource>(() => undefined) },
      sendBulk: () => never,
      maxDeliveryTasks: 1,
      deliveryTimeoutMs: 60_000,
    });
    const active = createPeerRangeReadFrame(descriptor({ requestId: 'request:egress-base' }));
    expect(host.acceptControl(CONNECTION_TOKEN, active)).toBe('accepted');
    const changed = createPeerRangeReadFrame({ ...active, offset: 1 });

    expect(host.acceptControl(CONNECTION_TOKEN, changed)).toBe('rejected');
    expect(host.physicalDeliveryTaskCount).toBe(1);
    expect(
      host.acceptControl(CONNECTION_TOKEN, createPeerRangeReadFrame({ ...active, offset: 2 })),
    ).toBe('rejected');
    expect(fatalConnection).toHaveBeenCalledOnce();
    expect(host.physicalDeliveryTaskCount).toBe(1);
    expect(host.acceptControl(CONNECTION_TOKEN, active)).toBe('ignored');
  });

  it('pins one exact source object and size to a handle until explicit revocation', async () => {
    const firstBlob = new Blob([Uint8Array.of(4, 5)]);
    const replacementBlob = new Blob([Uint8Array.of(8, 9)]);
    const provider = vi
      .fn<() => PeerRangeHostSource>()
      .mockReturnValueOnce(firstBlob)
      .mockReturnValue(replacementBlob);
    const frames: PeerRangeBulkFrame[] = [];
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: provider },
      sendBulk: (frame) => {
        frames.push(frame);
      },
    });
    const first = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:pinned', requestId: 'request:pinned-1' }),
    );
    const second = createPeerRangeReadFrame(
      descriptor({
        handleId: 'handle:pinned',
        requestId: 'request:pinned-2',
        offset: 1,
      }),
    );

    expect(host.acceptControl(CONNECTION_TOKEN, first)).toBe('accepted');
    await vi.waitFor(() => expect(host.activeRequestCount).toBe(0));
    expect(host.acceptControl(CONNECTION_TOKEN, second)).toBe('accepted');
    await vi.waitFor(() => expect(host.activeRequestCount).toBe(0));

    expect(provider).toHaveBeenCalledOnce();
    expect(host.sourceLeaseCount).toBe(1);
    const chunks = frames.filter((frame) => frame.type === 'chunk');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.type === 'chunk' && new Uint8Array(chunks[0].payload)[0]).toBe(4);
    expect(chunks[1]?.type === 'chunk' && new Uint8Array(chunks[1].payload)[0]).toBe(5);

    const wrongSource = createPeerRangeReadFrame({
      ...second,
      sourceIdentity: 'sha256:different',
      requestId: 'request:wrong-source',
    });
    expect(host.acceptControl(CONNECTION_TOKEN, wrongSource)).toBe('rejected');
    expect(provider).toHaveBeenCalledOnce();
    expect(
      host.acceptControl(
        CONNECTION_TOKEN,
        createPeerRangeCloseHandleFrame({
          connectionId: CONNECTION_ID,
          sourceIdentity: SOURCE_ID,
          handleId: 'handle:pinned',
        }),
      ),
    ).toBe('revoked');
    expect(host.sourceLeaseCount).toBe(0);
    expect(host.revokeHandle(CONNECTION_TOKEN, 'handle:pinned', SOURCE_ID)).toBe(true);
    const replay = createPeerRangeReadFrame({ ...second, requestId: 'request:after-revoke' });
    expect(host.acceptControl(CONNECTION_TOKEN, replay)).toBe('rejected');
    expect(provider).toHaveBeenCalledOnce();
  });

  it('bounds immutable handle leases and requires the exact token for control and revoke', async () => {
    const output: PeerRangeBulkFrame[] = [];
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => new Blob([Uint8Array.of(1)]) },
      sendBulk: (frame) => {
        output.push(frame);
      },
      maxSourceLeases: 1,
    });
    const first = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:lease-one', requestId: 'request:lease-one' }),
    );
    expect(host.acceptControl(CONNECTION_TOKEN, first)).toBe('accepted');
    await vi.waitFor(() => expect(host.activeRequestCount).toBe(0));

    const second = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:lease-two', requestId: 'request:lease-two' }),
    );
    expect(host.acceptControl(CONNECTION_TOKEN, second)).toBe('rejected');
    expect(output.at(-1)).toMatchObject({ type: 'error', code: 'unavailable' });
    expect(() => host.acceptControl(Object.freeze({}), first)).toThrow(/different connection/);
    expect(() => host.revokeHandle(Object.freeze({}), 'handle:lease-one', SOURCE_ID)).toThrow(
      /different connection/,
    );
  });

  it('bounds 1000 hostile void-sender error responses with local terminal credits', () => {
    const sendBulk = vi.fn((_frame: PeerRangeBulkFrame) => undefined);
    const fatalConnection = vi.fn();
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sources: { resolve: () => new Promise<PeerRangeHostSource>(() => undefined) },
      sendBulk,
      terminalEgressCredits: 3,
      terminalEgressRefillMs: 60_000,
    });
    const active = createPeerRangeReadFrame(descriptor({ requestId: 'request:void-base' }));
    expect(host.acceptControl(CONNECTION_TOKEN, active)).toBe('accepted');

    for (let index = 0; index < 1_000; index += 1) {
      host.acceptControl(
        CONNECTION_TOKEN,
        createPeerRangeReadFrame({ ...active, offset: index + 1 }),
      );
    }

    expect(sendBulk).toHaveBeenCalledTimes(3);
    expect(sendBulk.mock.calls.every(([frame]) => frame.type === 'error')).toBe(true);
    expect(fatalConnection).toHaveBeenCalledOnce();
    expect(host.activeRequestCount).toBe(0);
    expect(host.physicalReadTaskCount).toBe(1);
  });

  it('refills successful range terminal credit from local monotonic time', async () => {
    const fatalConnection = vi.fn();
    const output: PeerRangeBulkFrame[] = [];
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sources: { resolve: () => new Blob([Uint8Array.of(4, 5)]) },
      sendBulk: (frame) => {
        output.push(frame);
      },
      terminalEgressCredits: 1,
      terminalEgressRefillMs: 10,
    });
    const first = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:refill', requestId: 'request:refill-1' }),
    );
    const second = createPeerRangeReadFrame(
      descriptor({
        handleId: 'handle:refill',
        requestId: 'request:refill-2',
        offset: 1,
      }),
    );

    expect(host.acceptControl(CONNECTION_TOKEN, first)).toBe('accepted');
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(host.acceptControl(CONNECTION_TOKEN, second)).toBe('accepted');
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));

    expect(fatalConnection).not.toHaveBeenCalled();
    expect(output.filter((frame) => frame.type === 'chunk')).toHaveLength(2);
  });

  it('fails closed instead of evicting revoked handle tombstones into reusability', async () => {
    const provider = vi.fn((): PeerRangeHostSource => new Blob([Uint8Array.of(1)]));
    const fatalConnection = vi.fn();
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sources: { resolve: provider },
      sendBulk: () => undefined,
      maxRevokedHandleClaims: 1,
      maxSourceLeases: 1,
    });
    const h1 = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:tombstone-h1', requestId: 'request:tombstone-h1' }),
    );
    expect(host.acceptControl(CONNECTION_TOKEN, h1)).toBe('accepted');
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(host.acceptControl(CONNECTION_TOKEN, createPeerRangeCloseHandleFrame(h1))).toBe(
      'revoked',
    );

    const h2 = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:tombstone-h2', requestId: 'request:tombstone-h2' }),
    );
    expect(host.acceptControl(CONNECTION_TOKEN, h2)).toBe('accepted');
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(host.acceptControl(CONNECTION_TOKEN, createPeerRangeCloseHandleFrame(h2))).toBe(
      'rejected',
    );
    expect(fatalConnection).toHaveBeenCalledOnce();

    const h1Replay = createPeerRangeReadFrame({
      ...h1,
      requestId: 'request:tombstone-h1-replay',
    });
    expect(host.acceptControl(CONNECTION_TOKEN, h1Replay)).toBe('ignored');
    expect(provider).toHaveBeenCalledTimes(2);
    expect(host.sourceLeaseCount).toBe(0);
  });

  it('tombstones a local pre-lease revoke before a delayed first read can resolve', async () => {
    const provider = vi.fn((): PeerRangeHostSource => new Blob([Uint8Array.of(7)]));
    const output: PeerRangeBulkFrame[] = [];
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: provider },
      sendBulk: (frame) => {
        output.push(frame);
      },
      maxRevokedHandleClaims: 2,
    });
    const handleId = 'handle:locally-revoked-before-read';

    expect(host.matchesRevokedHandle(CONNECTION_TOKEN, handleId, SOURCE_ID)).toBe(false);
    expect(host.revokeHandle(CONNECTION_TOKEN, handleId, SOURCE_ID)).toBe(true);
    expect(host.matchesRevokedHandle(CONNECTION_TOKEN, handleId, SOURCE_ID)).toBe(true);
    expect(host.matchesRevokedHandle(CONNECTION_TOKEN, handleId, 'sha256:different')).toBe(false);
    expect(host.matchesRevokedHandle(CONNECTION_TOKEN, 'handle:unknown', SOURCE_ID)).toBe(false);
    expect(() => host.matchesRevokedHandle(Object.freeze({}), handleId, SOURCE_ID)).toThrow(
      /different connection/u,
    );
    await Promise.resolve();
    const delayed = createPeerRangeReadFrame(
      descriptor({ handleId, requestId: 'request:delayed-after-local-revoke' }),
    );
    expect(host.acceptControl(CONNECTION_TOKEN, delayed)).toBe('rejected');

    expect(provider).not.toHaveBeenCalled();
    expect(host.sourceLeaseCount).toBe(0);
    expect(host.physicalReadTaskCount).toBe(0);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ type: 'error', code: 'integrity' });
    expect(host.revokeHandle(CONNECTION_TOKEN, handleId, SOURCE_ID)).toBe(true);
  });

  it('owns one pinned EncodedAudioSource until an idle handle is revoked exactly once', async () => {
    const close = vi.fn(async () => undefined);
    const provider = vi.fn(
      (): EncodedAudioSource => ({
        kind: 'peer-range',
        size: 2,
        identity: SOURCE_ID,
        metadata: { name: 'owned.flac', mime: 'audio/flac' },
        readAt: async (offset, length) => Uint8Array.of(4, 5).slice(offset, offset + length),
        close,
      }),
    );
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: provider },
      sendBulk: () => undefined,
    });
    const first = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:owned-idle', requestId: 'request:owned-idle-1' }),
    );
    const second = createPeerRangeReadFrame({
      ...first,
      requestId: 'request:owned-idle-2',
      offset: 1,
    });

    expect(host.acceptControl(CONNECTION_TOKEN, first)).toBe('accepted');
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(host.acceptControl(CONNECTION_TOKEN, second)).toBe('accepted');
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(provider).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();

    const closeFrame = createPeerRangeCloseHandleFrame(second);
    expect(host.acceptControl(CONNECTION_TOKEN, closeFrame)).toBe('revoked');
    expect(close).toHaveBeenCalledOnce();
    expect(host.acceptControl(CONNECTION_TOKEN, closeFrame)).toBe('revoked');
    expect(host.revokeHandle(CONNECTION_TOKEN, second.handleId, SOURCE_ID)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledOnce();
  });

  it('aborts an active handle read before closing its owned source after task settlement', async () => {
    const pendingRead = deferred<Uint8Array>();
    const close = vi.fn(async () => undefined);
    let readSignal: AbortSignal | undefined;
    const source: EncodedAudioSource = {
      kind: 'peer-range',
      size: 2,
      identity: SOURCE_ID,
      metadata: { name: 'active.flac', mime: 'audio/flac' },
      readAt: async (_offset, _length, signal) => {
        readSignal = signal;
        return pendingRead.promise;
      },
      close,
    };
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => source },
      sendBulk: () => undefined,
    });
    const read = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:owned-active', requestId: 'request:owned-active' }),
    );

    expect(host.acceptControl(CONNECTION_TOKEN, read)).toBe('accepted');
    await vi.waitFor(() => expect(readSignal).toBeDefined());
    expect(host.matchesRevokedHandle(CONNECTION_TOKEN, read.handleId, SOURCE_ID)).toBe(false);
    expect(host.revokeHandle(CONNECTION_TOKEN, read.handleId, SOURCE_ID)).toBe(true);
    expect(host.matchesRevokedHandle(CONNECTION_TOKEN, read.handleId, SOURCE_ID)).toBe(true);
    expect(host.matchesRevokedHandle(CONNECTION_TOKEN, read.handleId, 'sha256:different')).toBe(
      false,
    );
    expect(readSignal?.aborted).toBe(true);
    expect(close).not.toHaveBeenCalled();

    pendingRead.resolve(Uint8Array.of(4));
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(close).toHaveBeenCalledOnce();
    expect(host.sourceLeaseCount).toBe(0);
  });

  it('aborts an active read and waits for it before closing on responder close', async () => {
    const pendingRead = deferred<Uint8Array>();
    const close = vi.fn(async () => undefined);
    let readSignal: AbortSignal | undefined;
    const source: EncodedAudioSource = {
      kind: 'peer-range',
      size: 1,
      identity: SOURCE_ID,
      metadata: { name: 'connection-close.flac', mime: 'audio/flac' },
      readAt: async (_offset, _length, signal) => {
        readSignal = signal;
        return pendingRead.promise;
      },
      close,
    };
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => source },
      sendBulk: () => undefined,
    });

    expect(host.acceptControl(CONNECTION_TOKEN, createPeerRangeReadFrame(descriptor()))).toBe(
      'accepted',
    );
    await vi.waitFor(() => expect(readSignal).toBeDefined());
    host.close(new EncodedSourceClosedError());
    expect(readSignal?.aborted).toBe(true);
    expect(host.sourceLeaseCount).toBe(0);
    expect(close).not.toHaveBeenCalled();

    pendingRead.resolve(Uint8Array.of(7));
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(close).toHaveBeenCalledOnce();
    host.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['revoke', 'close'] as const)(
    'closes a late resolver source after %s without publishing or reading it',
    async (terminal) => {
      const pendingSource = deferred<PeerRangeHostSource>();
      const close = vi.fn(async () => undefined);
      const readAt = vi.fn(async () => Uint8Array.of(1));
      const source: EncodedAudioSource = {
        kind: 'peer-range',
        size: 1,
        identity: SOURCE_ID,
        metadata: { name: 'late.flac', mime: 'audio/flac' },
        readAt,
        close,
      };
      const output: PeerRangeBulkFrame[] = [];
      const host = new PeerRangeHostResponder({
        connection: CONNECTION,
        onFatalConnection: ignoreFatalConnection,
        canSend: allowSend,
        sources: { resolve: () => pendingSource.promise },
        sendBulk: (frame) => {
          output.push(frame);
        },
      });
      const read = createPeerRangeReadFrame(
        descriptor({ handleId: `handle:late-${terminal}`, requestId: `request:late-${terminal}` }),
      );

      expect(host.acceptControl(CONNECTION_TOKEN, read)).toBe('accepted');
      await flush();
      if (terminal === 'revoke') {
        expect(host.revokeHandle(CONNECTION_TOKEN, read.handleId, SOURCE_ID)).toBe(true);
      } else {
        host.close();
      }
      pendingSource.resolve(source);

      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
      expect(readAt).not.toHaveBeenCalled();
      expect(output).toHaveLength(0);
      expect(host.sourceLeaseCount).toBe(0);
    },
  );

  it('pins a resolver rejection without inventing ownership or reacquiring on replay', async () => {
    const provider = vi.fn(async (): Promise<PeerRangeHostSource> => {
      throw new Error('registry unavailable');
    });
    const output: PeerRangeBulkFrame[] = [];
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: provider },
      sendBulk: (frame) => {
        output.push(frame);
      },
    });
    const first = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:resolver-reject', requestId: 'request:resolver-reject-1' }),
    );
    const second = createPeerRangeReadFrame({ ...first, requestId: 'request:resolver-reject-2' });

    expect(host.acceptControl(CONNECTION_TOKEN, first)).toBe('accepted');
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(host.acceptControl(CONNECTION_TOKEN, second)).toBe('accepted');
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));

    expect(provider).toHaveBeenCalledOnce();
    expect(output).toHaveLength(2);
    expect(output.every((frame) => frame.type === 'error' && frame.code === 'internal')).toBe(true);
    expect(host.revokeHandle(CONNECTION_TOKEN, first.handleId, SOURCE_ID)).toBe(true);
    expect(host.sourceLeaseCount).toBe(0);
  });

  it.each([
    { label: 'wrong identity', identity: 'sha256:wrong-owner', size: 1 },
    { label: 'invalid size', identity: SOURCE_ID, size: -1 },
  ])('closes a returned EncodedAudioSource with $label before failing safely', async (testCase) => {
    const close = vi.fn(async () => undefined);
    const source = {
      kind: 'peer-range',
      size: testCase.size,
      identity: testCase.identity,
      metadata: { name: 'invalid.flac', mime: 'audio/flac' },
      readAt: vi.fn(async () => Uint8Array.of(1)),
      close,
    } as EncodedAudioSource;
    const output: PeerRangeBulkFrame[] = [];
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => source },
      sendBulk: (frame) => {
        output.push(frame);
      },
    });

    expect(host.acceptControl(CONNECTION_TOKEN, createPeerRangeReadFrame(descriptor()))).toBe(
      'accepted',
    );
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(close).toHaveBeenCalledOnce();
    expect(source.readAt).not.toHaveBeenCalled();
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ type: 'error', code: 'integrity' });
    host.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects a runtime source that cannot satisfy owned close semantics', async () => {
    const readAt = vi.fn(async () => Uint8Array.of(1));
    const uncloseable = {
      kind: 'peer-range',
      size: 1,
      identity: SOURCE_ID,
      metadata: { name: 'uncloseable.flac', mime: 'audio/flac' },
      readAt,
    } as unknown as EncodedAudioSource;
    const output: PeerRangeBulkFrame[] = [];
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => uncloseable },
      sendBulk: (frame) => {
        output.push(frame);
      },
    });

    expect(host.acceptControl(CONNECTION_TOKEN, createPeerRangeReadFrame(descriptor()))).toBe(
      'accepted',
    );
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(readAt).not.toHaveBeenCalled();
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ type: 'error', code: 'integrity' });
    expect(() => host.close()).not.toThrow();
  });

  it('keeps Blob sources borrowed even when a Blob has a close-shaped property', async () => {
    const close = vi.fn(async () => undefined);
    const blob = new Blob([Uint8Array.of(8)]);
    Object.defineProperty(blob, 'close', { value: close });
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: { resolve: () => blob },
      sendBulk: () => undefined,
    });
    const read = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:borrowed-blob', requestId: 'request:borrowed-blob' }),
    );

    expect(host.acceptControl(CONNECTION_TOKEN, read)).toBe('accepted');
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(host.revokeHandle(CONNECTION_TOKEN, read.handleId, SOURCE_ID)).toBe(true);
    host.close();
    expect(close).not.toHaveBeenCalled();
  });

  it('observes close rejection without masking revocation or poisoning later handles', async () => {
    const close = vi.fn(() => Promise.reject(new Error('close failed')));
    const fatalConnection = vi.fn();
    const output: PeerRangeBulkFrame[] = [];
    const source: EncodedAudioSource = {
      kind: 'peer-range',
      size: 1,
      identity: SOURCE_ID,
      metadata: { name: 'reject-close.flac', mime: 'audio/flac' },
      readAt: async () => Uint8Array.of(3),
      close,
    };
    const provider = vi
      .fn<(identity: string) => PeerRangeHostSource>()
      .mockReturnValueOnce(source)
      .mockReturnValue(new Blob([Uint8Array.of(9)]));
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sources: { resolve: provider },
      sendBulk: (frame) => {
        output.push(frame);
      },
    });
    const first = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:reject-close-1', requestId: 'request:reject-close-1' }),
    );
    const second = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:reject-close-2', requestId: 'request:reject-close-2' }),
    );

    expect(host.acceptControl(CONNECTION_TOKEN, first)).toBe('accepted');
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(host.revokeHandle(CONNECTION_TOKEN, first.handleId, SOURCE_ID)).toBe(true);
    await flush();
    expect(close).toHaveBeenCalledOnce();
    expect(fatalConnection).not.toHaveBeenCalled();

    expect(host.acceptControl(CONNECTION_TOKEN, second)).toBe('accepted');
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(output.filter((frame) => frame.type === 'chunk')).toHaveLength(2);
    expect(fatalConnection).not.toHaveBeenCalled();
  });

  it('waits for every owned source close before rejecting physical retirement', async () => {
    const failure = new Error('first owned source close failed');
    const secondCloseGate = deferred<void>();
    const firstClose = vi.fn(() => Promise.reject(failure));
    const secondClose = vi.fn(() => secondCloseGate.promise);
    const ownedSource = (name: string, close: () => Promise<void>): EncodedAudioSource => ({
      kind: 'peer-range',
      size: 1,
      identity: SOURCE_ID,
      metadata: { name, mime: 'audio/flac' },
      readAt: async () => Uint8Array.of(7),
      close,
    });
    const sources = new Map([
      ['handle:close-all-1', ownedSource('first.flac', firstClose)],
      ['handle:close-all-2', ownedSource('second.flac', secondClose)],
    ]);
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: ignoreFatalConnection,
      canSend: allowSend,
      sources: {
        resolve: () => {
          throw new Error('handle-aware resolver required');
        },
        resolveHandle: (handleId) => sources.get(handleId)!,
      },
      sendBulk: () => undefined,
    });
    const first = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:close-all-1', requestId: 'request:close-all-1' }),
    );
    const second = createPeerRangeReadFrame(
      descriptor({ handleId: 'handle:close-all-2', requestId: 'request:close-all-2' }),
    );
    expect(host.acceptControl(CONNECTION_TOKEN, first)).toBe('accepted');
    expect(host.acceptControl(CONNECTION_TOKEN, second)).toBe('accepted');
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));

    const closing = host.close();
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(secondClose).toHaveBeenCalledOnce());
    await flush();
    expect(settled).toBe(false);

    secondCloseGate.resolve();
    await expect(closing).rejects.toBe(failure);
    expect(settled).toBe(true);
  });

  it('closes the owned source exactly once after a fatal sender failure settles', async () => {
    const close = vi.fn(async () => undefined);
    const fatalConnection = vi.fn();
    const source: EncodedAudioSource = {
      kind: 'peer-range',
      size: 1,
      identity: SOURCE_ID,
      metadata: { name: 'fatal.flac', mime: 'audio/flac' },
      readAt: async () => Uint8Array.of(6),
      close,
    };
    const host = new PeerRangeHostResponder({
      connection: CONNECTION,
      onFatalConnection: fatalConnection,
      canSend: allowSend,
      sources: { resolve: () => source },
      sendBulk: () => {
        throw new Error('connection failed');
      },
    });

    expect(host.acceptControl(CONNECTION_TOKEN, createPeerRangeReadFrame(descriptor()))).toBe(
      'accepted',
    );
    await vi.waitFor(() => expect(fatalConnection).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(host.physicalReadTaskCount).toBe(0));
    expect(close).toHaveBeenCalledOnce();
    host.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
